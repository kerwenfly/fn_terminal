# 终端 · fnOS 网页终端应用

在飞牛 fnOS 的网页里直接使用一个真正的终端 —— 支持账号密码登录，可以 `cd`、用 `tab` 补全、看彩色输出，跟本地终端体验一致。

产出一个 `.fpk` 安装包，装完即可在应用中心打开，无需 SSH 客户端。

---

## 功能特性

| 特性 | 说明 |
|---|---|
| **真实 TTY** | 基于 PTY（伪终端），`vim` / `top` / `htop` 等全屏程序、`tab` 补全、命令历史、彩色输出全部正常 |
| **账号密码登录** | 走系统 `/bin/login`，用飞牛本机的用户凭据登录（PAM 真实校验） |
| **免登录 Shell** | 也可选择「直接进入 Shell」，跳过认证直接进 bash |
| **多会话标签** | 一个页面可开多个终端，像浏览器标签一样切换 |
| **中文正常显示** | UTF-8 端到端处理，中文路径、中文输出都不乱码 |
| **输入行由前端本地编辑** | 打字、退格、Delete、方向键、Home/End、Ctrl-A/E/U/K/W **全部在本地完成**，零延迟且不重复显示：后端在会话建立时就把 tty 回显按住，readline 整条绘制路径彻底静默，两端不可能再画同一行 |
| **Tab 补全 / 历史仍然可用** | 这两类必须由 shell 决定。用 `bind -x` 让 bash 主动把「当前行 + 光标位置」报回来（OSC 777），一次往返拿到权威结果后本地重画 —— 候选列表、多匹配提示也原样保留 |
| **低延时输入** | 长轮询 + 按键串行合并；单次按键后端开销 143ms → 55ms，回显不再受 RTT 制约 |
| **手机输入法可用** | 修掉了 xterm 在「输入法组合中按回车」时丢掉最后一个字符的问题（详见下文） |
| **进程随页面开关** | 网页打开才启动终端进程，**关闭网页立即回收**，不留野进程 |
| **离线可用** | 前端 xterm.js 全部内置，不依赖任何 CDN；后端是纯静态 Go 二进制，零运行时依赖 |
| **宽屏自适应** | 尺寸变化经控制通道 `ioctl(TIOCSWINSZ)` 同步到 PTY，`vim` 等程序布局正确，且**不会在屏幕上留下任何命令痕迹** |

---

## 快速开始

### 安装

1. 从 `dist/` 或构建输出目录取对应架构的 `.fpk`：
   - **x86_64 设备** → `terminal_1.2.8_x86.fpk`
   - **ARM 设备**（OES / RK3588 等） → `terminal_1.2.8_arm64.fpk`
2. 打开飞牛 **应用中心 → 手动安装**，选择 fpk 文件。
3. 安装完成后，桌面会出现「终端」图标（也可能在应用中心的已安装列表里）。

> ⚠️ **务必选对架构**。x86 设备装 arm 包（或反之）会因为二进制架构不匹配而无法启动会话。
> 判断方法：SSH 登录 NAS 执行 `uname -m`，`x86_64` 用 x86 包，`aarch64` 用 arm64 包。

### 使用

打开应用后：

- **右上角下拉框**选择登录方式：
  - `账号登录` —— 输入本机用户名与密码（走 `/bin/login`）
  - `直接进入 Shell` —— 以应用身份直接进入 bash，无需密码
- 顶栏可以 **重命名会话**、**新建**、**清屏**（快捷键 `Ctrl+L`）、**关闭**。
- 标签栏可开多个并行会话，点标签切换、双击标签重命名。

---

## 工作原理

### 为什么需要一个 Go 二进制

飞牛的 CGI 模型是「**一次请求 = 一个进程**」：每次 HTTP 请求都新起一个进程，进程内的变量无法跨请求保存。

而终端要求「**一次会话 = 多次请求**」共享同一个 shell（这样才能保留 `cd`、环境变量、命令历史、补全状态）。

因此本应用用一个随包携带的 Go 静态二进制 `terminal-pty` 来「持有」这个会话：

```
浏览器  ──HTTP──>  terminal.cgi  ──写FIFO──>  terminal-pty  ──PTY──>  bash / login
                        │             in.pipe      │
                        │                          │
                        ├────── 读 out.log <───────┘
                        │
                        └──写 ctl.pipe──> ioctl(TIOCSWINSZ)   （只传窗口尺寸）
```

- `terminal-pty` 把 bash（或 login）挂在一个 PTY 上，PTY 的**全部输出追加写入 `out.log`**；
- 用户按键通过 FIFO（`in.pipe`）喂给同一个进程；
- 窗口尺寸走**另一条 FIFO**（`ctl.pipe`），由包装进程 `ioctl` 生效（见「技术要点 9」）；
- 前端维护一个字节 `offset`：**只拉取 `offset` 之后的新增输出**。

输出侧用**长轮询**：`read` 请求带上 `wait`（默认 1500ms），后端挂住直到 `out.log` 有新字节
或超时才返回；前端一拿到响应就立刻发下一轮。于是「**总有一次 read 在途**」，
回显产生的那一刻就被带走 —— 不需要密集轮询，也不会出现「刚查完就来数据、白等一个周期」的情况。

这样既拿到了真实 TTY，又不需要 WebSocket，用纯 CGI 就能实现。

### 输入路径的三个设计（直接决定手感）

```
按键 ──┬─> 本地立刻画在屏幕上（零延迟）
       │
       └─> pending 缓冲 ──> 同一时刻只有一个 exec 在途 ──> FIFO
                 ↑                                          │
                 └───── 在途期间新到的按键并入下一次 ─────────┘
```

**1. 按键串行化 + 合并。** 如果每个按键各发一个 HTTP 请求，快速输入会同时飞出十几个请求，
而 HTTP **不保证不同请求的到达顺序** —— 回车完全可能比最后一个字符先落地，
shell 就先执行了「少一个字母」的命令。改成队列后：顺序严格保证，
而且一次输入法上屏的整词会合并成一个请求（实测 7 次按键 → 2 个请求）。

**2. exec 只写不读。** `exec` 是每次按键都要走的路径，因此后端刻意保持极轻：
只往 FIFO 写、不回读输出、不跑 GC、不拼状态字段。实测单次 exec 的后端开销
**从 143ms 降到 55ms**（WSL / x86_64 实测，见下表）。

| exec 内部阶段 | 优化前 | 优化后 |
|---|---|---|
| 加载 `session.inc` | 11 ms | 11 ms |
| `sess_gc`（GC） | 19 ms | 0（exec 跳过） |
| `sess_alive` | 9 ms | 9 ms |
| 写 FIFO | 60 ms（3 个进程） | ~25 ms（O_RDWR 打开，1 个进程） |
| `sess_read` 回读 | 37 ms | 0（前端本来就丢弃） |
| **合计** | **143 ms** | **55 ms** |

> 去掉 `sess_read` 不会丢功能：`cwd` / `rc` / `user` 这些状态栏字段，
> 随后的长轮询 `read` 一样会带回来。

**3. 本地行编辑器 + 交棒。** 前面两条把延迟压到了「一个网络往返」，但只要有 RTT，
哪怕是 100ms，敲键和看到字之间仍然隔着一层。1.2.6 试过「本地先画、服务器回显到了再逐字节剥掉」，
但那条路**走不通**——它假设服务器的回显是「一串可以对齐的字节」，而实际上：

```
readline 的回显是「相对自己屏幕状态的差量重绘」，不是回显你敲的字符：
  退格            ⇒ "\x08\e[K"                       （不是 "\b \b"）
  行中间插 X      ⇒ "X" + 尾部 + "\x08"×尾部宽度      （不是只发一个 X）
  Ctrl-U          ⇒ "\x08"×列数 + "\e[K"             （不是 "^U"）
  Tab 补全        ⇒ 只发补全出来的那截 "p/"           （前面已画的部分一个字节都不发）
  ↑ 取历史        ⇒ 只发历史行的文本
```

「只发变化的部分」这件事让「本地画了再去对账」永远对不齐。所以 1.2.7 换了思路：
**让服务端彻底闭嘴，输入行的显示权完全归前端。**

具体做法分三步：

**① 后端在会话建立时把 PTY 从端的 `ECHO` 位按住**（`terminal-pty` 对 slave fd 做 `tcsetattr`，不经 shell）。

这一点很关键，因为 readline 在 `rl_prep_terminal` 里会把**当时的** `ECHO` 位锁存进 `_rl_echoing_p`：
只要在 `bash` 启动之前把这一位清掉，readline 整条绘制路径就都不输出。实测（真实 bash 5.2）：

| 关掉 ECHO 之后 | 服务端输出字节 |
|---|---|
| 打字 / 退格 / Delete / 方向键 / Home / End / Ctrl-U | **0** |
| Tab 补全 | **0**（但 readline 内部的行**确实被补全了**） |
| ↑ / ↓ 历史 | **0**（但历史**确实被取到了**） |
| 回车 | `\e[?2004l\r\r\n` + 命令输出 + `\e[?2004h` + 提示符 |
| Ctrl-C | `^C` + 三个换行 + 提示符 |

**② Tab / ↑↓ 这两类"只有 shell 知道答案"的按键，用 `bind -x` 把答案要回来。**

关掉回显之后 Tab 和 ↑ 自己一个字节都不吐，但它们的**效果**已经发生在 readline 的行缓冲里。
于是前端在会话建立后静默装一条绑定（命令文本不画、`history -d` 顺手从 shell 历史里删掉）：

```bash
bind -x '"\C-x\C-r": printf "\033]777;%s;%s\007" "$READLINE_LINE" "$READLINE_POINT"'
```

`Ctrl-X Ctrl-R` 是 readline 默认未绑定的键，实测安全。按下它，bash 就会吐出
`\e]777;<行内容>;<光标位置>\a`。于是「Tab 补全」和「↑ 历史」都变成**一次往返**：

```
前端发送:  "\t" + \C-x\C-r        （同一批，顺序由 HTTP 串行保证）
服务端返回: \r\e[K\r  +  \e]777;cd /tmp/;8\a
            └ 擦行（被前端摘掉）    └ 权威结果：当前行="cd /tmp/"，光标在第 8 个字符
前端: 把 OSC 摘掉 → 用报告的内容整行重画 → 继续本地编辑
```

多匹配时的候选列表、`history` 的内容都照常由 bash 正常输出，不受影响。

**③ 交棒只用在必要处，其余全是本地动作。**

| 按键 | 处理方式 |
|---|---|
| 可打印字符（含中文） | 本地插入 + 发给 shell |
| 退格 / Delete / ← → / Home / End | 本地改行 + 发给 shell（服务端零输出） |
| Ctrl-U / Ctrl-K / Ctrl-W | 本地整行重画 + 发给 shell |
| **Tab**、**↑/↓** | **交棒**：按键 + 报告键一起发，拿报告回来重画 |
| 回车 | 本地画 `\r\n`（服务端那个换行被丢掉，见下） |
| Ctrl-C | 本地丢弃本行；服务端吐三个换行，折成一个 |
| Ctrl-L | 纯本地清屏，**根本不发** |
| PgUp / PgDn | 本地滚动 |
| Ctrl-Z / Ctrl-D / Ctrl-R 等 | 直接发，不带报告键（交出去就不管） |

**④ 换行规范化：三种模式，取决于"前端自己画了什么"。**

```
dropNL    回车。前端已经本地画了一个换行 ⇒ 服务端那截换行必须整个丢掉。
oneNL     Ctrl-C。前端没画换行，服务端却一口气吐三个 ⇒ 折成正好一个。
sameLine  安装 bind -x 那条命令。前端什么都没画，而屏幕上已经有一个提示符了；
          直接放行会多出一行空提示符（肉眼可见的痕迹），所以改写成
          「回车 + 清行 + 原样重画提示符」—— 原地覆盖，与安装前逐像素相同。
```

判定只针对「由 `^C` / 转义序列 / `CR` / `LF` 构成的**开头**」：一碰到别的内容立刻收手，
所以 `cat`、`read -p 'Name: '` 这类自己输出的程序不会被误伤。窗口只有 900ms，过期自动失效。

**⑤ 停止本地回显的两种情况**（否则会画错、甚至泄露）：

- **密码 / passphrase 提示之后**：程序自己关掉了内核 ECHO，服务器不会回送任何字，
  继续本地画就等于**把密码显示在屏幕上**。识别到提示即关闭，回到 shell 提示符后解禁（另有 30 秒兜底）。
- **全屏程序期间**（`\x1b[?1049h` 进入备用屏幕）：普通模式下按键本就不该回显，
  本地画会把 `d`、`j`、`k` 直接印上去。用备用屏幕开关判定，比猜程序行为可靠。

**⑥ 登录模式：必须先把 tty 回显"真正"按住。**（1.2.8）

上面的 ① 只在**直接进 shell** 时成立——`terminal-pty` 在 `bash` 启动前就把 `ECHO` 清了。
但**账号登录**走的是 `/bin/login`，它会按自己的默认值重置 termios，把 `ECHO` 重新打开；
登录 shell 自己的启动文件也可能再重置一次。结果就是：readline 第一次
`rl_prep_terminal` 锁存到的 `_rl_echoing_p` 是 **1**，于是它开始自己画——
敲一个字看到两个，装 `bind -x` 的命令文本也被整条回显出来。

这时候**用控制通道补一次 `echo 0` 是没用的**，实测照旧重复。原因就在 readline 的
`rl_deprep_terminal`：它每处理完一行，就把自己**当时保存的** termios 写回去。
在 readline 活跃期间改 `ECHO`，下一行就被覆盖掉。

| 时机 | 实测结果 |
|---|---|
| readline 活跃时发 `ctl echo 0` | ❌ 打 `cd` 依旧回显 `cd` |
| `PROMPT_COMMAND='stty -echo'`（命令运行期间，readline 已 deprep） | ✅ 之后打字 **0 字节** |
| 手动执行一次 `stty -echo ...` | ✅ 之后打字 **0 字节**，回车序列也从 readline 风格 `\r\n\e[?2004l\r…` 变成静默风格 `\e[?2004l\r\r\n\e[?2004h` |

所以 1.2.8 的做法是：**登录成功、看到第一个 shell 提示符之后，往会话里注入一条命令**：

```bash
stty -echo 2>/dev/null; history -d $((HISTCMD-1)) 2>/dev/null
```

前半个把 `ECHO` 按住（此时 readline 正在跑命令、处于 deprep 状态，改动能留下），
后半个顺手把它自己从 shell 历史里删掉。

**这条命令自己的回显就是探针**——不需要额外的探测手段：

```
第 1 次注入 → 被回显出来（回显当时还开着，正常）→ 再注入一次
第 2 次没被回显 → 静默成功：启用本地回显 + 装 bind -x 报告绑定
第 2 次仍被回显 → 判定无效，退回「服务端回显」：本地一个字都不画，不再装绑定
```

两条命令的屏幕痕迹由 `sameLine` 规范化原地抹掉（命令文本被 `\r\e[K` 覆盖掉），
所以整个过程用户什么都看不到。万一环境特殊（shell 不是 bash、没有 `stty`、
或者注入被别的程序吃掉），顶多退化成老式的服务端回显，状态栏会显示
「账号登录·服务端回显」——**不会重复显示，也不会把命令文本糊在屏幕上**。

> **交棒方案有一个已接受的缺口**：`Ctrl-R`（反向增量搜索）在关回显下屏幕上看不到任何提示。
> 它由 readline 自己绘制，而 readline 现在整体静默。想搜索时请用 `↑` 或 `history | grep`。
>
> 另一个反直觉但正确的行为：**关掉回显之后，`ctl.pipe` 的 `echo 1` 也救不回 readline 的回显**
> ——readline 自己管着 termios，会立刻把它改回去。这条命令真正的用武之地是
> **非 readline 读取**（`read -p`、heredoc、脚本里的 `read`）：那类输入的回显完全由内核
> `ECHO` 位决定，`echo 1` 能恢复、`echo 0` 能让它闭嘴。前端日常只用 `echo 0`。

### 会话目录结构

```
$TRIM_PKGVAR/sessions/<sid>/
├── pid        包装进程 PID（terminal-pty），用于存活判定
├── in.pipe    FIFO，向 shell 写入按键
├── ctl.pipe   FIFO，控制通道（窗口尺寸 "cols rows\n" / 回显开关 "echo 0|1\n"）
├── out.log    PTY 累积输出（只增不改）
├── bashrc     会话专用 shell 启动文件
├── cwd        shell 每轮结束回写的当前目录（状态栏显示用）
├── rc         shell 每轮结束回写的上一条命令退出码
├── user       当前登录身份
├── hold.log   包装进程自身的 stderr（排障用）
├── owner      所属页面（标签页）标识
├── beat       心跳时间戳（mtime）
└── created    创建时间
```

### 会话生命周期：跟随网页

需求是「**只有网页打开时才跑终端，网页关闭就收掉进程**」。实现用 **owner + 心跳租约**：

| 时机 | 前端动作 | 后端动作 |
|---|---|---|
| 建会话 | `create` 带上 `owner` | 记录 `owner` / `beat` / `created` |
| 页面开着 | 每 **5 秒** 发 `keepalive` | 刷新心跳时间戳 |
| **正常关闭** | `pagehide` → `sendBeacon('shutdown')` | 按 `owner` 批量杀掉会话 |
| **异常关闭**（崩溃/断网） | 无 | 除 `exec` 外的任何请求都会跑 `sess_gc`，**心跳超 30 秒**即判孤儿并回收 |
| 应用启动/停用 | — | `start` 清残留、`stop` 全杀 |

`owner` 存在 `sessionStorage`，**关闭标签页自动失效**，天然做到「页面级」隔离：关掉 A 标签页不会影响 B 标签页的终端。

三个浏览器事件的语义差异（实现时必须区分，否则必然出 bug）：

```
pagehide { persisted: true }   → 进 bfcache。页面只是冻结，用户随时可能按返回键回来。
                                 **绝不能销毁**，只续租，否则「返回后是死终端」。
pagehide { persisted: false }  → 真卸载（关标签页 / 刷新 / 跳转）→ shutdown。
visibilitychange → hidden      → 切标签页 / 切后台 / 锁屏 → 只续租，交给超时兜底。
```

> 细节说明：`beforeunload` **只做续租，不做销毁**。它在能进 bfcache 的导航里会先于 `pagehide` 触发，
> 若在那里杀会话，就会出现「导航走再返回 → 会话已死」。
> 另外，页面卸载时发送请求必须用 `navigator.sendBeacon` —— 此时浏览器会中止在途的 `fetch`。

---

## 项目结构

```
terminal/
├── manifest                应用清单（appname / version / platform 等）
├── build.py                一键构建脚本（支持按架构打包）
├── make_icons.py           从 terminal.png 生成图标
├── normalize_eol.py        统一文本文件行尾为 LF
│
├── config/
│   ├── privilege           运行身份配置（run-as: root，见下文说明）
│   └── resource            数据共享目录声明
│
├── cmd/                    生命周期钩子（install / uninstall / upgrade / start / stop）
│   ├── main                start / stop / status（stop 会杀掉全部会话）
│   ├── install_callback    安装后：补执行位 + 挑选目标架构二进制 + 准备目录 + 启动
│   ├── install_init        安装前
│   ├── uninstall_callback  卸载后清理
│   ├── uninstall_init      卸载前
│   ├── upgrade_callback    升级后：同 install_callback
│   ├── upgrade_init        升级前
│   ├── config_init         配置初始化
│   └── config_callback     配置变更回调
│
├── src/                    Go 源码：PTY 双向搬运组件
│   ├── main.go             /dev/ptmx 建主从 PTY + 双向 pump + 控制 FIFO（窗口尺寸 ioctl、回显开关 tcsetattr）
│   └── go.mod
│
├── tools/                  测试与录制工具（不参与打包）
│   ├── record_echo/
│   │   ├── rec.go          字节流录制器：真 PTY 上关 ECHO 跑 bash，按规格回放按键并录下原始输出
│   │   ├── fixture.txt     录制规格 = 前端真实会发出去的按键序列
│   │   └── fix.json        fixture.txt 的录制结果（夹具的唯一事实来源）
│   ├── gen_fixture.js      fix.json + fixture.txt → www/fixture.js
│   ├── replay_test/
│   │   └── __test.html     回放式前端回归页（56 项断言，见「测试」一节）
│   ├── backend_regression.sh   后端回归（在真实 Linux 上跑）
│   ├── run_backend_test.sh     Windows 侧调起 WSL 跑后端回归
│   └── run_replay_test.sh      Windows 侧一键跑前端回放回归
│
└── app/                    打包进 app.tgz 的内容
    ├── bin/
    │   ├── terminal-pty-linux-amd64    x86_64 静态二进制
    │   ├── terminal-pty-linux-arm64    ARM64 静态二进制
    │   └── terminal-pty-linux-arm      ARMv7 静态二进制
    ├── ui/
    │   ├── index.cgi       静态文件服务（把请求映射到 www/）
    │   ├── terminal.cgi    终端 API：create / exec / read / resize / echo / keepalive / shutdown / close / info / env
    │   ├── session.inc     会话管理库（被 terminal.cgi 引入，含长轮询与生命周期逻辑）
    │   ├── config          桌面入口定义
    │   └── images/         应用中心图标
    └── www/                前端
        ├── index.html
        ├── app.js          本地行编辑器、bind -x 交棒、OSC 报告解析、换行规范化、长轮询、输入法回车处理、心跳与生命周期
        ├── terminal.css
        └── vendor/         内置的 xterm.js（离线，不依赖 CDN）
```

---

## 构建

### 环境要求

| 依赖 | 说明 |
|---|---|
| **Go** ≥ 1.21 | 交叉编译 PTY 组件（`CGO_ENABLED=0`，纯静态） |
| **Python** 3.8+ | 跑构建脚本 |
| **fnpack** | 飞牛官方打包器，放在项目**上一级**目录，命名 `fnpack.exe`（Windows）或 `fnpack` |
| **Pillow**（可选） | 仅在需要重新生成图标时用到 |

### 构建命令

```bash
cd terminal

# 构建 linux x64 包（本文档的主要目标）
python3 build.py --arch amd64

# 构建 ARM64 包
python3 build.py --arch arm64

# 一次构建两个架构
python3 build.py --arch arm64,amd64

# 跳过图标生成（图标没改动时更快）
python3 build.py --arch amd64 --no-icon
```

> 不传 `--arch` 时默认构建 `arm64`，保持与历史行为一致。

构建产出（位于项目**上一级**目录）：

```
terminal_1.2.8_x86.fpk       x86_64 包（platform = x86）
terminal_1.2.8_arm64.fpk     ARM64 包（platform = arm）
```

### 构建脚本做了什么

1. **交叉编译**目标架构的 Go 二进制到 `app/bin/terminal-pty-linux-<arch>`；
2. （可选）从 `terminal.png` 重新生成各尺寸图标；
3. **规范化行尾为 LF** —— 避免 `\r` 混进 CGI 脚本导致 Linux 上报 `$'\r': command not found`；
4. 把 **manifest 的 `platform` 临时切到目标架构**，并把非目标架构的二进制临时移出包外（避免包体积翻倍），
   打包完成后**自动还原** manifest 与 `app/bin/`，不污染源码树。

### 关于 `platform` 字段

`platform` 是**单值**字段，一个 fpk 只能声明一种架构：

| 值 | 含义 |
|---|---|
| `x86` | 仅 x86 / x86_64 设备 |
| `arm` | 仅 ARM 设备 |
| `all` | x86 + ARM 通用，**仅当包内不含特定架构二进制时使用** |

本应用**含原生二进制**（Go PTY 组件），因此**不能用 `all`** —— 必须按架构分别打包。
写成 `all` 会让 arm 包被装到 x86 机器上，运行时必然报 `wrong ELF class` 或直接无法建立会话。

---

## 技术要点（踩坑记录）

改这个项目前建议先读一遍，能省很多时间。

### 1. fnpack 会把文件模式统一改成 0666

打包会把 `app/` 下**所有文件**的模式写成 `0666`，**执行位全部丢失** —— 包括 `ui/*.cgi` 和 `bin/terminal-pty*`。

因此应用必须在运行时**自愈执行位**：`session.inc` 的 `ensure_exec_bits()` 在**每次请求**加载时做一次 `chmod +x`（幂等，代价极小）。
只靠 `install_callback` 里 chmod 一次是不够的 —— 升级覆盖、应用目录重建等场景都会让它失效。

### 2. `/bin/login` 需要 setuid-root

应用必须配 `config/privilege`：

```json
{ "defaults": { "run-as": "root" } }
```

否则以低权限用户运行时，`/bin/login` 会直接报 `must be suid to work properly` 并退出。
（注意：`privilege` 里**不要**写 `username` / `groupname` 字段 —— 飞牛会按它们去创建系统用户，填 `root` 会报「本地用户已存在」。`run-as` 与这两个字段无关。）

### 3. terminal-pty 会忽略 SIGTERM

`src/main.go` 里显式 `signal.Ignore(SIGHUP / SIGINT / SIGQUIT / SIGTERM)`，
所以**只发 `SIGTERM` 是杀不掉的**（进程会一直挂在 `S` 状态）。

正确顺序是三段式：

```bash
kill -TERM -<pgid>   # 给个主动收尾的机会
sleep 0.5
kill -KILL -<pgid>   # 对忽略 TERM 的包装进程兜底（关键）
# 复查仍在则再补一发 KILL
```

负号是**进程组**，保证 bash 里 fork 出来的子进程一起走。

### 4. base64 在整条链路上只解码一次

前端传按键时用 base64（避免 JSON 转义问题）。约定是：**`data` 从浏览器到 FIFO 始终是 base64，只在最后写 FIFO 时解码一次**。

中途任何一次多余解码都会造成「双重解码 → 输入变乱码」（曾出现输入 `ls` 实际收到 `l` 的现象）。

### 5. xterm.js 有两条解码路径，必须传 Uint8Array

```js
this._stringDecoder = new StringToUtf32;   // 传 string   → 按码点处理
this._utf8Decoder   = new Utf8ToUtf32;     // 传 Uint8Array → 真正的 UTF-8 解码
```

把字节先转成 latin1 字符串再 `write()`，等于提前解了一次码，xterm 拿到字符串后又会用 UTF-8 解码器**二次解码** → `中` 变成 `ä¸`。

✅ 正确做法：`term.write(bytes)` —— **直接把 `Uint8Array` 交给 xterm**。

### 6. 输入与输出必须单通道

`exec`（送按键）与 `read`（拉输出）是两个并发请求。如果两者都携带增量输出，
同一段字节会被 append 两次（`ls` → `lsls`），offset 也会被错误推进导致字符被吞。

✅ 约定：`exec` 只负责送按键，它返回的 `data` **一律丢弃**；所有输出只由 `read` 这一条串行通道读取。
（`exec` 现在干脆不返回 `data` 了 —— 从源头上杜绝。）

### 7. 回显慢：两个元凶

**(a) `exec` 里的 `sleep 0.3`。** 早期实现想「一次请求就把回显带回去」，于是写完 FIFO 先睡 300ms 再读。
键盘每敲一下都要先付这 300ms，而 shell 的回显其实几毫秒就落到 `out.log` 了 —— 纯粹白等。

**(b) 固定间隔轮询。** 每 400ms 才问一次，最坏要白等一整个周期，
而且「刚轮询完就来数据」这个情况会反复出现。

✅ 修正：`exec` 改成「写完即返回」（省 300ms），输出改由**长轮询** `read` 取
（后端挂住等，一有新字节立刻返回，前端拿到就发下一轮）。
于是回显延时只剩 `1×RTT` 量级，而不是 `2×RTT + 300ms + 半个轮询周期`。

### 8. 手机上「按回车吃掉最后一个字符」

这是 xterm.js 的一个真实竞态，`app/www/vendor/xterm.js` 里两段代码互相打架：

```js
// ① CompositionHelper._finalizeComposition(true) —— compositionend 的收尾
setTimeout(() => {                                   // ← 异步！挂在 Macrotask 上
  t = this._textarea.value.substring(pos.start);     // 稍后**才**去读 textarea
  t.length > 0 && this._coreService.triggerDataEvent(t, true);
}, 0);

// ② Terminal._keyDown 里对回车（C0.CR）的处理
(i.key !== C0.ETX && i.key !== C0.CR || (this.textarea.value = "")),   // ← 先清空 textarea
 ...
this._coreService.triggerDataEvent(i.key, true);    // 再发 \r
```

手机输入法（尤其带联想/纠错的）会把**整个词停在组合区**，此时：

1. 用户按回车 → xterm 的 `_keyDown` 先把 `textarea.value` 清空，再发 `\r`；
2. 组合收尾的 `setTimeout(0)` 这时才去读 `textarea.value` → **已经是空串** → 那个字永远发不出去。

更糟的一路：若此时正处在 `_isSendingComposition` 状态，`_keyDown` 还会调用
`_finalizeComposition(false)`，**直接把待发文本取消掉**。

桌面键盘走 keydown/keypress 输入，`textarea` 始终为空，所以**只有手机复现**。

✅ 修正：在 `attachCustomKeyEventHandler` 里**抢在 xterm 之前**接管这次回车
（该回调在 `_keyDown` 里是最先执行的）：

```js
if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && self.imePending()) {
  self.onEnterKey();     // 延后 ENTER_HOLD_MS 再补发 \r
  return false;          // 关键：让 xterm 完整跳过这次回车
}
```

返回 `false` 后 xterm 既不清 `textarea`、也不会取消待发文本，输入法正常提交组合、
xterm 把那几个字发出来；我们随后补的 `\r` 由 pending 队列保证排在后面 —— **不丢字，也不重复**。

组合态用 `compositionstart` / `compositionend` 自己跟踪（另加 250ms「刚结束」宽限窗口，
覆盖 `compositionend` 与回车几乎同时到达的情况）。**没有输入法时回车完全不受影响**
（实测延后 0ms 路径仍在 10ms 内发出）。

### 9. 调整窗口尺寸**不能**往输入流里塞 `stty` 命令

PTY 的窗口尺寸只能由**持有 master 的一方**用 `ioctl(TIOCSWINSZ)` 设置，而 master 在 `terminal-pty` 手里，
CGI 摸不到它。早期实现因此退而求其次：把 `stty cols X rows Y` 当**命令**写进 `in.pipe` 交给 shell 执行。

后果很不好看 —— 用户会看到一串自己从没敲过的命令：

```
root@FnNas:~# stty cols 47 rows 24 2>/dev/null
stty cols 47 rows 23 2>/dev/null
root@FnNas:~# stty cols 47 rows 23 2>/dev/null
```

四个问题：

1. 命令会被**原样回显**到屏幕上（用户以为自己被入侵了）；
2. 拖拽窗口时会**反复触发**，屏幕上刷出一堆重复行（列数还不一样）；
3. 命令会进入 **shell 历史**，按 ↑ 就能翻出来；
4. 若此刻前台跑着别的程序（`vim` / `top` / 交互式脚本），这些字符会被**直接喂给那个程序**。

✅ 修正：新增一条**只传尺寸**的控制 FIFO（`ctl.pipe`），CGI 写 `"cols rows\n"`，
包装进程收到后对 master 执行 `ioctl(TIOCSWINSZ)`。这样：

- 屏幕上**干干净净**，历史也不再被污染；
- 内核在尺寸真正变化时会给 PTY 前台进程组发 **SIGWINCH**，shell 自动重绘提示符、
  全屏程序照常自适应 —— 这正是当初想用 `stty` 达到的效果，但没有任何副作用；
- 还能覆盖 `login` 模式「**还没登录时**就调整尺寸」的情况（旧方案此时 `stty` 必然失败）。

> 实现细节：`ctl.pipe` 与 `in.pipe` 用同一套技巧 —— CGI 端 `exec 9<>fifo`
> （O_RDWR 打开 FIFO 永不阻塞），Go 端 `O_RDONLY|O_NONBLOCK` + 20ms 节奏读取。

### 10. 本地行编辑器的边界：这些地方不要「抢着画」

输入行的显示权归前端，但有几种情况必须让路给服务端 / 交给交棒，否则会把屏幕弄脏
（详见「输入路径」一节）：

- **密码 / passphrase 提示之后**：这类程序自己关掉了内核 ECHO，服务器不会回送任何字。
  若继续本地画，等于把密码明明白白显示在屏幕上 —— 既是安全问题，也会让行模型永远对不上。
  见 `app.js` 的 `scanPrompt()`：识别到提示就置 `noEcho`，回到 shell 提示符后自动解禁。
- **全屏程序（备用屏幕）期间**：`vim` / `top` / `less` 在**普通模式**下按键本就不回显，
  本地画会把 `d`、`j`、`k` 这类按键直接印到屏幕上。用它们必然发出的
  `\x1b[?1049h` / `\x1b[?1049l` 判定进出，见 `scanAltScreen()`。
  （对 `xterm-256color` 而言 `smcup` / `rmcup` 就是这两个序列；老程序可能用 `1047` / `47`。）
- **Tab / ↑ / ↓**：结果只有 shell 知道 —— 走交棒，不要在本地猜。
- **`Ctrl-Z` / `Ctrl-D` / `Ctrl-R`**：直接发出去，不带报告键，也不本地画。

### 11. 两个把光标算错、还看不出来的地方

- **整行重画时的光标回退量**。重画之后光标停在**整行末尾**，要退到 `cur` 那一格，
  退的格数应该是 `w(line) - w(line[0..cur])`。曾经写成 `w(line[0..cur])` ——
  补全报告回来时 `cur` 正好在行尾，于是多退了整整一行的宽度，光标落到行首，
  下一个字符就把行首字母覆盖掉（`cd /tmp/` 敲 `e` 变成 `ed /tmp/`）。
  这类 bug 不会报错、不会崩，只是"字被吃了一个"，靠肉眼看很难定位。
- **`\r\e[K` 的擦除范围是从光标到行尾**。交棒报告返回的 `\r\e[K\r` 一定会先把
  当前行（含提示符）全擦掉，所以报告必须在**擦除之后**、用本地行模型整行重画，
  不能在同一个批次里先画后擦。

### 12. 二进制一定要重新编译，别让 WSL 测了个旧包

`src/main.go` 加「建会话清 ECHO」之后，`app/bin/` 里的二进制没有重新生成，
于是 WSL 回归里跑的是**没有这段逻辑的旧二进制** —— 表现为「启动时 tty 是 `-echo`
但打字仍然被回显」，看着像 readline 的原理不成立，白查半天。
症状其实很明确：回显风格是 readline 的 `\b\e[K`，而不是内核的 `^?`。
**改完 `src/` 必须重编二进制再测**，并核对 `ls -la src/main.go app/bin/*` 的时间戳。

> 顺带记一笔：判定 `stty -a` 里的 echo 字段千万别写 `grep -- "-echo"`。
> `-echonl`、`-echoprt` 都含这个子串，无论开关都会命中 —— 我据此误判过一次
> 「回显已关闭」。要按单词精确匹配。

---

## API 参考

所有接口都是 `POST /cgi/ThirdParty/terminal/terminal.cgi/<action>`，请求体为 JSON，响应为 JSON。终端输出以 **base64** 承载。

| Action | 参数 | 说明 |
|---|---|---|
| `create` | `mode`, `login`, `cols`, `rows`, `owner` | 新建会话，返回 `sid` / `offset` / 首批输出 |
| `exec` | `sid`, `offset`, `data`(base64) | 送按键 / 命令。只回执 `{ok,alive}`，不返回输出 |
| `read` | `sid`, `offset`, `wait`(ms) | 拉取 `offset` 之后的新增输出。带 `wait` 时长轮询（上限 5000ms）；`wait=0` 即立即返回（老行为） |
| `resize` | `sid`, `cols`, `rows` | 调整窗口尺寸 |
| `echo` | `sid`, `on`(0/1) | 开关 PTY 从端的 `ECHO` 位。`0` 让 readline 彻底静默（本地行编辑器的前提）；`1` 恢复内核回显，只对 `read -p` 这类非 readline 读取有效 |
| `keepalive` | `owner` 或 `sid` | 页面心跳（续租） |
| `shutdown` | `owner` 或 `sid` | 页面关闭 → 销毁名下全部会话 |
| `close` | `sid` | 关闭单个会话 |
| `info` | `sid` | 会话状态（cwd / 退出码 / 存活 / 身份） |
| `env` | — | 环境自检（排障用，返回架构、二进制路径、存活会话数等） |

---

## 排障

### 会话建立失败

打开浏览器开发者工具，调用一次自检接口：

```
POST /cgi/ThirdParty/terminal/terminal.cgi/env
```

看返回：

- `pty` 应为 `"go"`，`pty_exec` 应为 `true` —— 否则是二进制缺失或没有执行位；
- `arch` 应与设备架构一致 —— 不一致说明装错了架构的包。

### 报 `must be suid to work properly`

`config/privilege` 的 `run-as` 不是 `root`。卸载后重新安装（改配置需要重装才生效）。

### 中文乱码

检查前端是否把**原始字节**（`Uint8Array`）直接交给 xterm，而不是先转成字符串。

### 关页面后进程没退出

正常情况下 `pagehide` 会立即回收；若浏览器异常关闭，后端会在 **30 秒心跳超时**后自动清理。
可访问一次任意接口触发 GC，或执行 `cmd/main stop` 全部清掉。

### 输入有延迟 / 回显不跟手

打字、退格、方向键这些**都应当在按下的那一刻就出现**（纯本地动作，与网络无关）。若仍感觉慢：

1. 确认加载的是新版 `app.js`（旧版没有本地行编辑器）——清一下浏览器缓存。
2. 看开发者工具里 `read` 请求是否带 `wait: 1500`，且**响应时间接近 1500ms**
   （空闲时被挂住，说明长轮询生效）；若 `read` 秒回且密集，说明前端是旧文件。
3. 若「回车之后命令执行得慢」，那才是真实 RTT 造成的（本地编辑只能掩盖**输入**的延迟，
   不能提前执行命令）。可以调大 `app/www/app.js` 里的 `READ_WAIT_MS` 减少请求数，
   但注意它同时决定 CGI 进程被占用的时长。

### 账号登录模式下字符重复 / 每敲一行都冒出 `bind -x ...`

那是 **1.2.7 及更早版本**在登录模式下的症状，1.2.8 已修。

根因是 `/bin/login` 会按自己的默认值重置 termios，把 `ECHO` 重新打开，
而 1.2.7 只会在会话建立时清一次（那时 `bash` 还没起来，等于白清）。
1.2.8 会在登录成功、看到第一个 shell 提示符之后额外注入一次 `stty -echo`。

> 别指望用 `ctl.pipe` 的 `echo 0` 补这一下——readline 会在 `rl_deprep_terminal`
> 里把自己保存的 termios 写回去，实测照旧重复。详见「输入路径 ⑥」。

判断当前走到了哪一步，看状态栏：

- 显示 `账号登录·服务端回显` → 注入两次都被回显，已安全降级（不会重复显示，
  但输入行改由服务端回显，Tab/↑↓ 交棒停用）。常见于登录 shell 不是 bash（如 `sh`/dash）
  或环境里没有 `stty`。
- 没有这个后缀 → 静默协商成功，行为与直接进 shell 完全一致。

若注入后 `stty -echo` 这条命令文本本身出现在屏幕上，说明 `sameLine` 规范化没生效
（通常是窗口超时或输出被拆到了两个批次），升级到 1.2.8 后不应出现。

### 屏幕上出现自己没输入过的 `stty cols ... rows ...`

那是 1.2.5 及更早版本调整窗口尺寸的方式（往输入流里塞命令）。
1.2.6 起改为控制 FIFO + `ioctl`，不会再出现 —— 升级即可。
升级后若仍看到，多半是浏览器缓存了旧的 `app.js`（它调用 `resize` 的频率异常高会放大这个问题），
清缓存重试。

### 字符被画了两遍 / 输入行的字被覆盖或错位

1.2.7 起输入行完全由前端负责，正常情况下服务端**一个字节都不回送**。若出现异常：

```js
var s = window.__term.active;
s.line          // 本地行模型（权威）
s.cur           // 光标位置
s.nlMode        // 换行规范化模式：'' / dropNL / oneNL / sameLine
s.reporterReady // bind -x 报告是否确认可用
s.anchor        // 输入行行首坐标 {row, col}
s.installTries  // 已经尝试安装了几次报告绑定（上限 4）
```

- **字符显示两遍**：说明 tty 回显没被按住。检查 `s.noEcho`、以及后端是否为新版
  （旧版 `terminal-pty` 不会在会话建立时清 `ECHO`）。可用诊断接口确认：
  `POST /cgi/ThirdParty/terminal/terminal.cgi/echo`（`{"sid":...,"on":0}`）。
- **敲字母把行首的字母覆盖掉**：光标回退量算错（`leRedrawAll` 里退的格数应当是
  `w(line) - w(line[0..cur])`）。这个 bug 在 1.2.7 的测试里被 `5g` 用例钉住了。
- **屏幕上多出一行空提示符**：安装报告绑定那条命令的换行没被折掉。属于 `sameLine` 规范化失效，
  通常是 `nlMode` 窗口被别的动作覆盖（安装只在提示符刚出现、且输入行为空时才允许触发）。

### Tab 补全没反应 / 补全后行内容不对

Tab 走的是交棒通道（`按键 + Ctrl-X Ctrl-R` → `bind -x` 报告）。若失效：

1. 看控制台 `s.reporterReady`。为 `false` 说明报告没回来 ——
   可能 shell 被 `reset` 过、或换成了不认这个绑定的 shell。
2. 前端会自动重试安装（最多 4 次，间隔 2.5s / 5s / 10s），**且只在输入行为空时**安装
   —— 因为安装用的是「清行重画」，正在打字时安装会把那半行字擦掉。
3. 多匹配时的候选列表由 bash 正常输出，不受影响；若候选列表出来了但行内容没更新，
   则是报告解析（OSC 777）出了问题。

### `Ctrl-R` 反向搜索看不到任何提示

已知缺口（见「输入路径」一节的说明）：`Ctrl-R` 的搜索提示由 readline 自己绘制，
而 readline 现在整体静默。改用 `↑` 取历史，或 `history | grep 关键词`。

### 手机上按回车少一个字符

已在 1.2.5 修复（见「技术要点 8」）。若仍复现，请确认浏览器加载的是新版 `app.js`
（旧版没有 `imePending` 这段逻辑）。

### 查看运行日志

```bash
cat $TRIM_PKGVAR/info.log              # 应用启停日志
cat $TRIM_PKGVAR/sessions/<sid>/hold.log   # 某个会话的组件报错
```

---

## 测试

改这个应用最危险的是「凭对 shell 的想象写断言」。早期用手写的假 bash 做前端测试，
17 项失败里有 16 项其实是我把 bash 想错了（凭空让它吐出 `atmp/`、`ls -la` 之类）。
所以现在的规矩是：**先录真实字节，再回放**。

### 前端：真实字节回放

```bash
bash tools/run_replay_test.sh
```

流程是：`tools/record_echo/fix.json`（真实 bash 录下来的字节流）+ `fixture.txt`（规格）
→ `gen_fixture.js` 生成夹具 → 组装临时目录 → 无头 Edge/Chrome 跑 `__test.html` → 抓取断言结果。

`__test.html` 里的服务端替身**不做任何模拟**，只按顺序回放录制的字节，
所以测出来的行为就是真机上会发生的行为。共 56 项断言，覆盖：

```
0  会话建立 / 只有一个会话实例          8  中文宽度与退格
1  安装 bind 无痕（不留空行、不进历史）  9  Ctrl-L 纯本地不发请求
2  打字本地即时、不重复、护栏生效        10 read -p 内核回显兜底
3  回车换行只出现一次                   11 屏幕上无 OSC 残留
4  退格/方向/Delete/Home/End/Ctrl-U 全本地  12 echo=0 兜底请求已发出
5  Tab 交棒 + OSC 同步 + 补全后继续输入  13 夹具无未命中（无错位）
6  ↑↓ 历史同步                          14 无未捕获 JS 错误
7  Ctrl-C 三个换行折成一个
```

### 前端：登录模式（`账号登录`）

```bash
bash tools/run_login_test.sh
```

与上面那套的区别只有一个：**录制时保留了 tty 原生回显**（`!keep`），因为 `/bin/login`
之后 `ECHO` 就是开着的——这正是登录模式的现场。shell 模式那份夹具是关掉回显录的，
拿它测不出登录模式的问题。

夹具由 `tools/gen_login_fixture.js` 生成：登录阶段（`login:` / `Password:` / motd）
是合成文本，后面接真实 bash 录下来的字节。共 43 项断言，覆盖：

```
1  login 阶段原样透传（本地不画）   5  Tab 交棒
2  密码阶段不回显                   6  退格全本地
3  自动注入静默命令且不留痕迹       7  方向键 / Ctrl-C
4  静默后打字完全本地、不重复       8  降级路径（两次都回显 → 退回服务端回显）
                                    9  无 JS 错误 / 夹具无未命中 / 屏幕无命令痕迹
```

### 解包验证：测真正要交付的那份

```bash
bash tools/verify_package.sh                       # 默认取工作区根的 x86 包
bash tools/verify_package.sh ../terminal_1.2.8_arm64.fpk
```

拆开 fpk 里的 `app.tgz`，用**包内那份 `app.js`** 再跑一遍两套前端回归。
这一步不能省：fnpack 会统一改文件模式、构建脚本会规范化行尾，
只用源码树测等于没测交付物。顺带核对包内 `app.js` 是否与源码树一致、CGI 是否还是 LF。

### 后端：真 Linux 上跑

```bash
bash tools/run_backend_test.sh        # Windows 侧自动调起 WSL
```

三套一起跑：

```bash
bash tools/run_all_tests.sh
```

先把二进制与脚本复制到 ASCII 路径（`C:\temp_bt`）再进 WSL，避开中文路径在参数传递上的坑。
共 10 项断言：

| 组 | 断言 |
|---|---|
| 1 | 建会话即关回显：打字 0 字节；退格没有 readline 风格的 `\b\e[K` 重绘 |
| 2 | `ctl echo 1` **救不回** readline 行的回显；但对 `read -p` 能让内核回显恢复、`echo 0` 能让它闭嘴 |
| 3 | 关回显下 Tab 补全 / `↑` 历史仍能通过 `bind -x` 报回来（报出 `]777;cd /tmp/;8`） |
| 4 | `ctl` 的 `120 40` 真的生效（`stty -a` 读出 `rows 40; columns 120`） |
| 5 | 进程回收：只发 `TERM` 杀不掉（预期如此），补 `KILL` 后进程组清空 |

### 重新录制夹具

改了前端会发出去的按键序列（`fixture.txt`）之后，需要在 Linux 上重录：

```bash
# 一步到位：本机交叉编译录制器 -> 丢到真 Linux 上录 -> 取回 JSON
bash tools/record.sh tools/record_echo/fixture.txt tools/record_echo/fix.json
bash tools/record.sh tools/record_echo/login.txt  tools/record_echo/login.json

# 然后生成夹具并跑测试
bash tools/run_replay_test.sh
bash tools/run_login_test.sh          # 登录模式那份夹具还要先 build 一次
```

手工做的话（要记住：**暂存目录必须是纯 ASCII 路径**，中文路径会让 WSL 挂载与 `go` 都出问题）：

```bash
# 1) 编译录制器
cd tools/record_echo && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o rec_linux rec.go

# 2) 在 Linux（或 WSL 的 docker-desktop 发行版）里录
MSYS_NO_PATHCONV=1 wsl.exe -d docker-desktop -u root -e sh -c \
  'cd /mnt/host/c/temp_echo && ./rec_linux fixture.txt > fix.json'

# 3) 生成夹具并跑测试
cp fix.json <项目>/tools/record_echo/ && bash <项目>/tools/run_replay_test.sh
```

录制器做的事和 `terminal-pty` 一模一样：开 `/dev/ptmx`、**先把从端 `ECHO` 清掉**、
再起 `bash -i`，然后按规格逐条写入并录下每个间隔里产生的原始字节。
如果录制时忘了清 `ECHO`，录出来的夹具就会带着 readline 的回显，测试会全绿但真机是错的
—— 所以 `fix.json` 里第 0 条（初始提示符）可以直接用来核对这一点。

---

## 版本

当前版本 **1.2.8**

| 版本 | 变更 |
|---|---|
| 1.2.8 | **修好账号登录模式的重复显示**：认清「`ctl echo 0` 救不了 login 模式」——readline 会在 `rl_deprep_terminal` 里把自己保存的 termios 写回去，活跃期间改 `ECHO` 一律无效；改为登录成功后**注入一次 `stty -echo`（此时 readline 正在跑命令、处于 deprep 状态，改动能留下）**，并且**用这条命令自己的回显当探针**（被回显=还没按住，再试一次；两次都被回显=判定无效，退回服务端回显，状态栏显示「账号登录·服务端回显」）。同时修掉 `\e[K` 未按终端语义处理导致 `promptText` 被污染、把提示符叠在同一行的 bug；新增登录模式专属的真实字节回放回归（43 项）与 `tools/record.sh` 一键录制 |
| 1.2.7 | **输入行改由前端本地编辑**：后端在会话建立时按住 PTY 的 `ECHO`，readline 整条绘制路径静默，因此打字/退格/Delete/方向键/Home/End/Ctrl-A·E·U·K·W **全部本地处理且绝不重复显示**；**Tab 补全与 ↑↓ 历史改用 `bind -x` + OSC 777 交棒**（一次往返取回权威的行内容与光标位置，候选列表照常显示）；换行规范化分 `dropNL`/`oneNL`/`sameLine` 三种；新增 `ctl.pipe` 的 `echo 0\|1` 命令（只对 `read -p` 这类非 readline 读取有效）；**新增一套「真实字节录制 + 回放」回归**（前端 56 项 / 后端 10 项） |
| 1.2.6 | **本地即时回显**：敲键零延迟显示，服务器回显自动去重（含密码提示自动禁用、全屏程序自动让位、中文与退格处理）；**窗口尺寸改走控制 FIFO + `ioctl(TIOCSWINSZ)`**，屏幕上不再出现自己没敲过的 `stty cols ...` 命令，也不再污染 shell 历史；降级终端不再重复打印命令 |
| 1.2.5 | **输入延时优化**：去掉 `exec` 里的 `sleep 0.3`、输出改长轮询、按键串行合并（单次 exec 后端开销 143→55ms）；**修复手机输入法组合中按回车丢字** |
| 1.2.4 | 会话生命周期绑定网页：关页面即回收进程（owner + 心跳租约）；支持按架构打包（新增 x86_64） |
| 1.2.3 | 修复中文显示（xterm 传 Uint8Array）；移除标题栏装饰圆点 |
| 1.2.2 | `run-as: root` 使账号登录可用；错误提示带上组件真实报错 |
| 1.2.1 | 自愈执行位；按 `uname -m` 精确挑选架构二进制 |
| 1.2.0 | 改用 Go 静态二进制替代 Python 实现 |
