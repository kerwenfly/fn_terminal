// 终端会话 PTY 包装器（Go 静态二进制，零运行时依赖）
//
// 职责：把一个 shell / login 进程挂在一个真正的伪终端（PTY）上，
//       并在 PTY 与两个普通文件之间双向搬运数据：
//
//	PTY 输出   ──►  out.log（追加写，前端只读增量）
//	in.pipe    ──►  PTY 输入（FIFO，CGI 每次请求往里写按键流）
//
// 这样既拿到了真实 TTY（颜色、行编辑、Tab 补全、Ctrl-C 都正常），
// 又完全避开 WebSocket —— fnOS 的 CGI 是一次性进程，后端用「轮询读日志」
// 即可实现交互式终端。
//
// 会话内进程退出后本进程自然结束。
//
// 用法:
//
//	terminal-pty <sess_dir> <mode> [args...]
//
// mode:
//
//	shell <login> [shell] [args...]   直接起 shell；login 非空则先 su -l 切身份
//	login <login_prog> [args...]      起 /bin/login，由用户自己输入账号密码
//
// 环境变量（可选）:
//
//	PTY_COLS / PTY_ROWS   初始窗口尺寸，默认 80x24
//	PTY_LOG_MAX           日志硬上限字节数，默认 8MB（超出做尾部保留）
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// ---------------------------------------------------------------------------
// ioctl 常量与封装（不引第三方库，直接走 syscall）
// ---------------------------------------------------------------------------

const (
	// TIOCSCTTY：把当前 fd 设为控制终端
	tiocsctty = 0x540E
	// TIOCSWINSZ：设置窗口尺寸
	tiocswinsz = 0x5414
	// TIOCGWINSZ：读取窗口尺寸
	tiocgwinsz = 0x5413
)

// winsize 对应内核 struct winsize
type winsize struct {
	Row    uint16
	Col    uint16
	Xpixel uint16
	Ypixel uint16
}

func ioctlSetWinsize(fd int, ws *winsize) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd),
		uintptr(tiocswinsz), uintptr(unsafe.Pointer(ws)))
	if errno != 0 {
		return errno
	}
	return nil
}

func ioctlSetCtty(fd int) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd),
		uintptr(tiocsctty), 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// ---------------------------------------------------------------------------
// 打开 PTY 主/从对
//
// 优先 /dev/ptmx（Linux 标准），失败则回退到传统的 /dev/ptyp<N> 方案。
// 打开 master 后必须先 grantpt/unlockpt，否则 slave 端无法打开（EIO）。
// ---------------------------------------------------------------------------

const (
	// TIOCGPTN：取从端编号
	tiocgptn = 0x80045430
	// TIOCSPTLCK：解锁从端
	tiocsptlck = 0x40045431
)

var errNoPty = errors.New("no pty available")

func openPty() (master, slave *os.File, err error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return openPtyLegacy()
	}

	// unlockpt
	var unlock int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(),
		uintptr(tiocsptlck), uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		m.Close()
		return nil, nil, errno
	}

	// 取从端编号 → /dev/pts/N
	var n uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, m.Fd(),
		uintptr(tiocgptn), uintptr(unsafe.Pointer(&n))); errno != 0 {
		m.Close()
		return nil, nil, errno
	}

	s, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		m.Close()
		return nil, nil, err
	}
	return m, s, nil
}

// openPtyLegacy 是老式 BSD 风格 pty（现代 Linux 基本用不到，仅兜底）
func openPtyLegacy() (*os.File, *os.File, error) {
	for i := 0; i < 256; i++ {
		sn := fmt.Sprintf("/dev/ptyp%d", i)
		mn := fmt.Sprintf("/dev/ttyp%d", i)
		s, err := os.OpenFile(sn, os.O_RDWR|syscall.O_NOCTTY, 0)
		if err != nil {
			continue
		}
		m, err := os.OpenFile(mn, os.O_RDWR|syscall.O_NOCTTY, 0)
		if err != nil {
			s.Close()
			continue
		}
		return m, s, nil
	}
	return nil, nil, errNoPty
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: terminal-pty <sess_dir> <shell|login> [args...]")
		os.Exit(2)
	}

	sessDir := os.Args[1]
	mode := os.Args[2]
	rest := os.Args[3:]

	cols, rows := 80, 24
	if v, err := strconv.Atoi(os.Getenv("PTY_COLS")); err == nil && v >= 2 {
		cols = v
	}
	if v, err := strconv.Atoi(os.Getenv("PTY_ROWS")); err == nil && v >= 2 {
		rows = v
	}

	cmdPath, cmdArgs := buildCommand(mode, rest)
	if cmdPath == "" {
		fmt.Fprintln(os.Stderr, "terminal-pty: 无法解析要启动的程序")
		os.Exit(2)
	}

	// 目标程序不存在时，清楚报错（写进 hold.log，排障可见）
	if _, err := os.Stat(cmdPath); err != nil {
		// login 模式缺少 /bin/login 时，退回 shell 以免整个会话不可用
		if mode == "login" {
			fmt.Fprintf(os.Stderr, "terminal-pty: %s 不可用（%v），退回 shell\n", cmdPath, err)
			cmdPath, cmdArgs = buildCommand("shell", []string{"", "/bin/sh"})
		} else {
			fmt.Fprintf(os.Stderr, "terminal-pty: 找不到 %s: %v\n", cmdPath, err)
			os.Exit(1)
		}
	}

	// 日志与输入管道在 fork 之前打开，避免子进程重复持有描述符
	outFile, err := os.OpenFile(filepath.Join(sessDir, "out.log"),
		os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "terminal-pty: 打开 out.log 失败: %v\n", err)
		os.Exit(1)
	}
	defer outFile.Close()

	pipePath := filepath.Join(sessDir, "in.pipe")
	// FIFO 以只读方式打开会阻塞，直到有写端出现；这里用非阻塞 + 重试，
	// 保证会话创建请求能立刻返回（前端稍后才开始写按键）。
	pipeFile, err := openFifoNonblock(pipePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "terminal-pty: 打开 in.pipe 失败: %v\n", err)
		os.Exit(1)
	}
	defer pipeFile.Close()

	master, slave, err := openPty()
	if err != nil {
		fmt.Fprintf(os.Stderr, "terminal-pty: 创建 PTY 失败: %v\n", err)
		os.Exit(1)
	}
	_ = ioctlSetWinsize(int(slave.Fd()), &winsize{Row: uint16(rows), Col: uint16(cols)})

	// -----------------------------------------------------------------
	// 启动子进程：setsid → 从端设为控制终端 → dup 到 0/1/2 → exec
	// -----------------------------------------------------------------
	cmd := exec.Command(cmdPath, cmdArgs...)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.Dir = sessDir
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,             // 新会话，脱离 CGI 进程组
		Setctty: true,             // 需要 Setsid 同时为 true
		Ctty:    0,                // 以 Stdin 为控制终端
		Pdeathsig: syscall.SIGKILL, // 父进程意外死亡时带走子进程
	}
	cmd.Env = sessionEnv(sessDir)

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "terminal-pty: 启动 %s 失败: %v\n", cmdPath, err)
		slave.Close()
		master.Close()
		os.Exit(1)
	}
	// 父进程写完 pid 后即可关闭从端（子进程自己持有）
	pidPath := filepath.Join(sessDir, "pid")
	_ = os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600)
	slave.Close()

	// CGI 进程退出时不要把会话带走（否则刷新页面就等于杀终端）
	signal.Ignore(syscall.SIGHUP)
	// Ctrl-C 只应该送到终端里的前台进程，不能打死包装器
	signal.Ignore(syscall.SIGINT)
	signal.Ignore(syscall.SIGQUIT)
	signal.Ignore(syscall.SIGTERM)

	// -----------------------------------------------------------------
	// 双向搬运
	// -----------------------------------------------------------------
	var wg sync.WaitGroup
	var done int32

	// PTY → out.log（带日志上限保护）
	wg.Add(1)
	go func() {
		defer wg.Done()
		pumpPtyToLog(master, outFile, sessDir)
	}()

	// in.pipe → PTY
	wg.Add(1)
	go func() {
		defer wg.Done()
		pumpPipeToPty(pipeFile, master, &done)
	}()

	// 等子进程结束
	waitErr := cmd.Wait()
	_ = waitErr

	// 子进程没了：置位 done 并关闭描述符，让两个 goroutine 退出
	atomic.StoreInt32(&done, 1)
	_ = master.Close()
	_ = pipeFile.Close()
	wg.Wait()

	_ = outFile.Close()
	_ = os.Remove(pidPath)
}

// buildCommand 解析 mode → 实际要执行的程序与参数
func buildCommand(mode string, rest []string) (string, []string) {
	switch mode {
	case "shell":
		login := ""
		if len(rest) > 0 {
			login = rest[0]
			rest = rest[1:]
		}
		shell := "/bin/bash"
		if len(rest) > 0 {
			shell = rest[0]
			rest = rest[1:]
		}
		if login != "" {
			// su -l <user> -s <shell> -c 'exec <shell> <args...>'
			inner := "exec " + shell
			for _, a := range rest {
				inner += " " + shellQuote(a)
			}
			return "/bin/su", []string{"-l", login, "-s", shell, "-c", inner}
		}
		return shell, rest

	case "login":
		// 起真正的登录程序：屏幕上会出现 `hostname login:` 与 `Password:`
		prog := firstExisting([]string{
			"/bin/login", "/usr/bin/login", "/sbin/login", "/usr/sbin/login",
		})
		if len(rest) > 0 && rest[0] != "" {
			prog = rest[0]
			rest = rest[1:]
		}
		return prog, rest

	default:
		// 兼容旧调用：mode 位置直接写了个可执行路径
		if mode != "" {
			return mode, rest
		}
		return "", nil
	}
}

// firstExisting 返回候选列表中第一个存在的路径；都不存在时返回首个候选，
// 让后续的 Stat 检查给出明确报错。
func firstExisting(cands []string) string {
	for _, c := range cands {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	if len(cands) > 0 {
		return cands[0]
	}
	return ""
}

// shellQuote 单引号安全引用（供 su -c 的命令串使用）
func shellQuote(s string) string {
	out := "'"
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out += `'\''`
		} else {
			out += string(s[i])
		}
	}
	return out + "'"
}

// sessionEnv 构造会话环境变量
func sessionEnv(sessDir string) []string {
	env := []string{
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"__SESS_DIR=" + sessDir,
		"HISTFILE=" + filepath.Join(sessDir, "history"),
	}
	// 继承语言 / 路径等基础变量
	for _, k := range []string{"PATH", "LANG", "LC_ALL", "LC_CTYPE", "HOME", "USER", "LOGNAME", "TZ"} {
		if v, ok := os.LookupEnv(k); ok && v != "" {
			env = append(env, k+"="+v)
		}
	}
	if _, ok := os.LookupEnv("PATH"); !ok {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	return env
}

// openFifoNonblock 以非阻塞方式打开 FIFO 读端
//
// 直接 open(O_RDONLY|O_NONBLOCK) 对 FIFO 是合法的：即使没有写端也会立即返回，
// 后续 read 得到 EAGAIN。这样会话创建不会被阻塞。
func openFifoNonblock(path string) (*os.File, error) {
	// 若 FIFO 不存在则创建
	if _, err := os.Stat(path); err != nil {
		_ = syscall.Mkfifo(path, 0o600)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// ---------------------------------------------------------------------------
// 数据搬运
// ---------------------------------------------------------------------------

// pumpPtyToLog 把 PTY 输出追加写入 out.log
//
// 只在内存里保留一小段，超过上限时做一次「尾部保留」，防止日志无限膨胀
// 拖垮前端增量读取（前端按字节 offset 拉取）。
func pumpPtyToLog(master *os.File, out *os.File, sessDir string) {
	buf := make([]byte, 32*1024)
	for {
		n, err := master.Read(buf)
		if n > 0 {
			_, _ = out.Write(buf[:n])
			_ = out.Sync()
		}
		if err != nil {
			// EIO：PTY 从端全部关闭，属于正常结束
			return
		}
	}
}

// pumpPipeToPty 把 FIFO 里的按键流转交给 PTY
//
// FIFO 是无界的，读空后 read 返回 EAGAIN，此时短暂休眠避免忙等。
// 为了不让 CPU 空转，用 20ms 的节奏轮询；按键延迟感知不到。
// done 由主流程在子进程退出 / master 关闭后置位，用于让本循环及时收尾。
func pumpPipeToPty(pipe *os.File, master *os.File, done *int32) {
	buf := make([]byte, 32*1024)
	for {
		if atomic.LoadInt32(done) != 0 {
			return
		}
		n, err := pipe.Read(buf)
		if n > 0 {
			if _, werr := master.Write(buf[:n]); werr != nil {
				return
			}
			continue
		}
		if err != nil {
			if err == syscall.EAGAIN || err == io.EOF {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}
