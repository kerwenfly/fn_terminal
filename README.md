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
| **进程随页面开关** | 网页打开才启动终端进程，**关闭网页立即回收**，不留野进程 |
| **离线可用** | 前端 xterm.js 全部内置，不依赖任何 CDN；后端是纯静态 Go 二进制，零运行时依赖 |
| **宽屏自适应** | 窗口尺寸变化自动同步到 PTY（`stty`），`vim` 等程序布局正确 |

---

## 快速开始

### 安装

1. 从 `dist/` 或构建输出目录取对应架构的 `.fpk`：
   - **x86_64 设备** → `terminal_1.2.4_x86.fpk`
   - **ARM 设备**（OES / RK3588 等） → `terminal_1.2.4_arm64.fpk`
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
                        │                          │
                        └────── 读 out.log <────────┘
```

- `terminal-pty` 把 bash（或 login）挂在一个 PTY 上，PTY 的**全部输出追加写入 `out.log`**；
- 用户按键通过 FIFO（`in.pipe`）喂给同一个进程；
- 前端每次请求只做一件事：**记下 `out.log` 的字节偏移 → 写入按键 → 读回新增输出**。

这样既拿到了真实 TTY，又不需要 WebSocket，用纯 CGI + 轮询就能实现。

### 会话目录结构

```
$TRIM_PKGVAR/sessions/<sid>/
├── pid        包装进程 PID（terminal-pty），用于存活判定
├── in.pipe    FIFO，向 shell 写入按键
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
| **异常关闭**（崩溃/断网） | 无 | 任何请求都会跑 `sess_gc`，**心跳超 30 秒**即判孤儿并回收 |
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
│   ├── main.go             /dev/ptmx 建主从 PTY + 双向 pump
│   └── go.mod
│
└── app/                    打包进 app.tgz 的内容
    ├── bin/
    │   ├── terminal-pty-linux-amd64    x86_64 静态二进制
    │   ├── terminal-pty-linux-arm64    ARM64 静态二进制
    │   └── terminal-pty-linux-arm      ARMv7 静态二进制
    ├── ui/
    │   ├── index.cgi       静态文件服务（把请求映射到 www/）
    │   ├── terminal.cgi    终端 API：create / exec / read / resize / keepalive / shutdown / close / info / env
    │   ├── session.inc     会话管理库（被 terminal.cgi 引入）
    │   ├── config          桌面入口定义
    │   └── images/         应用中心图标
    └── www/                前端
        ├── index.html
        ├── app.js          会话管理、轮询、心跳、生命周期
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
terminal_1.2.4_x86.fpk       x86_64 包（platform = x86）
terminal_1.2.4_arm64.fpk     ARM64 包（platform = arm）
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

`exec`（送按键）与 `read`（轮询）是两个并发请求。如果两者都携带增量输出，
同一段字节会被 append 两次（`ls` → `lsls`），offset 也会被错误推进导致字符被吞。

✅ 约定：`exec` 只负责送按键，它返回的 `data` **一律丢弃**；所有输出只由 `read` 这一条串行通道读取。

---

## API 参考

所有接口都是 `POST /cgi/ThirdParty/terminal/terminal.cgi/<action>`，请求体为 JSON，响应为 JSON。终端输出以 **base64** 承载。

| Action | 参数 | 说明 |
|---|---|---|
| `create` | `mode`, `login`, `cols`, `rows`, `owner` | 新建会话，返回 `sid` / `offset` / 首批输出 |
| `exec` | `sid`, `offset`, `data`(base64) | 送按键 / 命令 |
| `read` | `sid`, `offset` | 只拉取 `offset` 之后的新增输出（轮询） |
| `resize` | `sid`, `cols`, `rows` | 调整窗口尺寸 |
| `keepalive` | `owner` 或 `sid` | 页面心跳（续租） |
| `shutdown` | `owner` 或 `sid` | 页面关闭 → 销毁名下全部会话 |
| `shutdown_all` | — | 销毁所有会话 |
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

### 查看运行日志

```bash
cat $TRIM_PKGVAR/info.log              # 应用启停日志
cat $TRIM_PKGVAR/sessions/<sid>/hold.log   # 某个会话的组件报错
```

---

## 版本

当前版本 **1.2.4**

| 版本 | 变更 |
|---|---|
| 1.2.4 | 会话生命周期绑定网页：关页面即回收进程（owner + 心跳租约）；支持按架构打包（新增 x86_64） |
| 1.2.3 | 修复中文显示（xterm 传 Uint8Array）；移除标题栏装饰圆点 |
| 1.2.2 | `run-as: root` 使账号登录可用；错误提示带上组件真实报错 |
| 1.2.1 | 自愈执行位；按 `uname -m` 精确挑选架构二进制 |
| 1.2.0 | 改用 Go 静态二进制替代 Python 实现 |
