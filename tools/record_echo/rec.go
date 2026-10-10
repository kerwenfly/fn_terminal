// rec —— 真实 bash 字节流录制器（只在开发期用来生成前端测试夹具）
//
// 用法: rec <spec.txt>
//
// spec.txt 每行: "<要发送的字符串>" <等待毫秒>
//   字符串按 Go 转义解析，因此 "\r" 是回车、"\x7f" 是退格、"\x1b[A" 是上箭头。
//
// 输出: 一个 JSON 数组，每项 { send, out }（out 是这一步之后收到的原始输出，
//       base64 编码，另附 out_text 便于人眼查看）。
//
// 关键点：从端 PTY 的 ECHO 位被关掉 —— 与 terminal-pty 的做法完全一致，
//        这样才能录到「回显关闭后 readline 到底还吐什么」。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	tiocsctty  = 0x540E
	tiocswinsz = 0x5414
	tiocsptlck = 0x40045431
	tiocgptn   = 0x80045430
	tcgets     = 0x5401
	tcsets     = 0x5402
)

const termiosEcho = 0x00000008

type termios struct {
	Iflag uint32
	Oflag uint32
	Cflag uint32
	Lflag uint32
	Line  uint8
	Cc    [19]uint8
}

type winsize struct {
	Row, Col, Xpixel, Ypixel uint16
}

func ioctl(fd uintptr, req uintptr, arg unsafe.Pointer) syscall.Errno {
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, uintptr(arg))
	return e
}

func getTermios(fd int, t *termios) error {
	if e := ioctl(uintptr(fd), tcgets, unsafe.Pointer(t)); e != 0 {
		return e
	}
	return nil
}

func setTermios(fd int, t *termios) error {
	if e := ioctl(uintptr(fd), tcsets, unsafe.Pointer(t)); e != 0 {
		return e
	}
	return nil
}

func setEcho(fd int, on bool) error {
	var t termios
	if err := getTermios(fd, &t); err != nil {
		return err
	}
	if (t.Lflag&termiosEcho != 0) == on {
		return nil
	}
	if on {
		t.Lflag |= termiosEcho
	} else {
		t.Lflag &^= termiosEcho
	}
	return setTermios(fd, &t)
}

// echoOn 读取当前 tty 的 ECHO 位（子进程已退出时可能 EIO，按「已关闭」处理）
func echoOn(fd int) bool {
	var t termios
	if err := getTermios(fd, &t); err != nil {
		return false
	}
	return t.Lflag&termiosEcho != 0
}

type stepSpec struct {
	kind string // "send" | "on" | "off" | "win"
	arg  string
	wait time.Duration
}

func unescape(s string) (string, error) {
	return strconv.Unquote(`"` + s + `"`)
}

func parseSpec(path string) ([]stepSpec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []stepSpec
	for _, ln := range strings.Split(string(raw), "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		// 行尾注释：只认「 空格 + #」，避免误伤引号里的 ~#
		if i := strings.Index(ln, " #"); i >= 0 {
			ln = strings.TrimSpace(ln[:i])
		}
		if ln == "" {
			continue
		}
		// 控制指令: !on / !off / !win <cols> <rows>，后面可跟等待毫秒
		if strings.HasPrefix(ln, "!") {
			f := strings.Fields(ln)
			st := stepSpec{kind: strings.TrimPrefix(f[0], "!")}
			rest := f[1:]
			if len(rest) > 0 {
				if ms, err := strconv.Atoi(rest[len(rest)-1]); err == nil {
					st.wait = time.Duration(ms) * time.Millisecond
					rest = rest[:len(rest)-1]
				}
			}
			st.arg = strings.Join(rest, " ")
			out = append(out, st)
			continue
		}
		// 普通行: "<字符串>" <毫秒>
		// 找真正的收尾引号（跳过被转义的 \"）
		if !strings.HasPrefix(ln, "\"") {
			continue
		}
		q := -1
		for k := 1; k < len(ln); k++ {
			if ln[k] != '"' {
				continue
			}
			bs := 0
			for j := k - 1; j >= 0 && ln[j] == '\\'; j-- {
				bs++
			}
			if bs%2 == 0 {
				q = k
				break
			}
		}
		if q < 0 {
			continue
		}
		lit := ln[:q+1]
		f := strings.Fields(strings.TrimSpace(ln[q+1:]))
		if len(f) == 0 {
			return nil, fmt.Errorf("缺等待毫秒: %q", ln)
		}
		ms, err := strconv.Atoi(f[0])
		if err != nil {
			return nil, fmt.Errorf("等待毫秒非法: %q", ln)
		}
		txt, err := unescape(lit[1 : len(lit)-1])
		if err != nil {
			return nil, fmt.Errorf("坏字符串 %q: %v", lit, err)
		}
		out = append(out, stepSpec{kind: "send", arg: txt, wait: time.Duration(ms) * time.Millisecond})
	}
	return out, nil
}

type sink struct {
	mu  sync.Mutex
	buf []byte
}

func (s *sink) add(p []byte) {
	s.mu.Lock()
	s.buf = append(s.buf, p...)
	s.mu.Unlock()
}

func (s *sink) since(n int) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > len(s.buf) {
		return nil
	}
	out := make([]byte, len(s.buf)-n)
	copy(out, s.buf[n:])
	return out
}

func (s *sink) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.buf)
}

type record struct {
	Send    string `json:"send"`
	OutB64  string `json:"out_b64"`
	OutText string `json:"out_text"`
	OutHex  string `json:"out_hex"`
	EchoOn  bool   `json:"echo_on"` // 本步结束时 tty 的 ECHO 位
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "用法: rec <spec.txt>")
		os.Exit(2)
	}
	steps, err := parseSpec(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open ptmx:", err)
		os.Exit(1)
	}
	defer master.Close()

	var zero int32
	if e := ioctl(master.Fd(), tiocsptlck, unsafe.Pointer(&zero)); e != 0 {
		fmt.Fprintln(os.Stderr, "unlockpt:", e)
		os.Exit(1)
	}
	var ptn int32
	if e := ioctl(master.Fd(), tiocgptn, unsafe.Pointer(&ptn)); e != 0 {
		fmt.Fprintln(os.Stderr, "ptsname:", e)
		os.Exit(1)
	}
	slaveName := fmt.Sprintf("/dev/pts/%d", ptn)

	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open slave:", err)
		os.Exit(1)
	}
	defer slave.Close()

	ws := winsize{Row: 24, Col: 80}
	_ = ioctl(master.Fd(), tiocswinsz, unsafe.Pointer(&ws))

	// 第一条是 !keep 时保留内核/readline 的原生回显（对照组）。
	keepEcho := len(steps) > 0 && steps[0].kind == "keep"
	if !keepEcho {
		// 与 terminal-pty 完全一致：会话一建立就按住 ECHO
		if err := setEcho(int(slave.Fd()), false); err != nil {
			fmt.Fprintln(os.Stderr, "setecho:", err)
			os.Exit(1)
		}
	}

	// !cmd <prog> [args...] 替换被启动的程序（默认 bash --norc --noprofile -i）。
	// 用来探测 login / su 这类登录程序会不会把 tty 的 ECHO 位弄回开。
	prog, progArgs := "/bin/bash", []string{"--norc", "--noprofile", "-i"}
	for _, st := range steps {
		if st.kind == "cmd" && st.arg != "" {
			f := strings.Fields(st.arg)
			prog, progArgs = f[0], f[1:]
			break
		}
	}
	cmd := exec.Command(prog, progArgs...)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.Env = []string{
		"TERM=xterm-256color",
		"LC_ALL=C.UTF-8",
		"LANG=C.UTF-8",
		"PS1=root@nas:~# ",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if len(steps) > 0 && steps[0].kind == "dir" {
		cmd.Dir = steps[0].arg
	} else {
		cmd.Dir = "/"
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "start bash:", err)
		os.Exit(1)
	}

	s := &sink{}
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := master.Read(buf)
			if n > 0 {
				s.add(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	// 等初始提示符
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.len() > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)

	var out []record
	// 记录初始输出作为第 0 步
	init := s.since(0)
	out = append(out, record{
		Send:    "(start)",
		OutB64:  base64.StdEncoding.EncodeToString(init),
		OutText: sanitize(init),
		OutHex:  hexify(init),
		EchoOn:  echoOn(int(slave.Fd())),
	})

	for _, st := range steps {
		if st.kind == "keep" || st.kind == "dir" || st.kind == "cmd" {
			continue
		}
		mark := s.len()
		switch st.kind {
		case "on":
			_ = setEcho(int(slave.Fd()), true)
		case "off":
			_ = setEcho(int(slave.Fd()), false)
		case "win":
			var c, r int
			fmt.Sscanf(st.arg, "%d %d", &c, &r)
			if c > 0 && r > 0 {
				w := winsize{Row: uint16(r), Col: uint16(c)}
				_ = ioctl(master.Fd(), tiocswinsz, unsafe.Pointer(&w))
			}
		default:
			if st.arg != "" {
				if _, err := master.WriteString(st.arg); err != nil {
					fmt.Fprintln(os.Stderr, "write:", err)
					break
				}
			}
		}
		if st.wait > 0 {
			time.Sleep(st.wait)
		}
		got := s.since(mark)
		out = append(out, record{
			Send:    "!" + st.kind + " " + st.arg,
			OutB64:  base64.StdEncoding.EncodeToString(got),
			OutText: sanitize(got),
			OutHex:  hexify(got),
			EchoOn:  echoOn(int(slave.Fd())),
		})
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	_ = enc.Encode(out)

	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	time.Sleep(100 * time.Millisecond)
}

// sanitize 把控制字符写成可读的转义形式，方便直接用肉眼看
func sanitize(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		switch {
		case c == 0x1b:
			sb.WriteString("\\e")
		case c == 0x0d:
			sb.WriteString("\\r")
		case c == 0x0a:
			sb.WriteString("\\n")
		case c == 0x09:
			sb.WriteString("\\t")
		case c == 0x07:
			sb.WriteString("\\a")
		case c < 0x20 || c == 0x7f:
			fmt.Fprintf(&sb, "\\x%02x", c)
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

func hexify(b []byte) string {
	var sb strings.Builder
	for i, c := range b {
		if i > 0 {
			sb.WriteByte(' ')
		}
		fmt.Fprintf(&sb, "%02x", c)
	}
	return sb.String()
}
