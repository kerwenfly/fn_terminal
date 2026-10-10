/* ==========================================================================
   终端应用前端
   --------------------------------------------------------------------------
   后端是「无状态 CGI + 持久 PTY」模型：
     - create  建会话，返回 offset
     - exec    送按键/命令（它的 data 一律丢弃）
     - read    仅拉取 offset 之后的新增输出，支持长轮询（wait）
   因此前端只需维护 3 件事：sid、offset、Terminal 实例。

   三条贯穿始终的约定（改动时务必保持）：
     1) 输出只有一条通道 —— 只有 read 的结果会写进 xterm；
     2) 输入严格串行 —— 同一时刻只有一个 exec 在途，按键按到达顺序合并发送；
     3) 输入行的显示归前端独占 —— 后端把 tty 回显关掉（readline 因此整条绘制
        路径静默），前端用本地行编辑器自己画；Tab 补全 / 历史这类只能由 shell
        决定的键，靠 bash 的 bind -x 把行内容以 OSC 777 报回来后再本地重画。
   输出是原始 PTY 字节流（含 ANSI），base64 解码后必须把 **Uint8Array**
   原样交给 xterm 让它自己按 UTF-8 解码（转成字符串会中文乱码）。
   ========================================================================== */
(function () {
  'use strict';

  var API = '/cgi/ThirdParty/terminal/terminal.cgi';

  /* 读取（长轮询）
       一次 read 请求让后端最多挂住 READ_WAIT_MS 毫秒，一有新输出立刻返回；
       返回后前端马上再发下一轮。好处：
         · 回显在产生的瞬间就被带走，不用等下一个定时器 —— 输入跟手；
         · 请求数反而比密集轮询更少（空闲时约 1.5 秒才一个请求）。

       取值权衡：挂得越久请求越少，但 CGI 进程被占用的时间也越长
       （fnOS 的 CGI 是每次请求一个进程）。1.5 秒是个折中 ——
       空闲时每页约 0.7 req/s，而原来固定 400ms 轮询是 2.5 req/s。 */
  var READ_WAIT_MS = 1500;

  /* 长轮询看门狗：正常情况下 read 自己首尾相接，不需要定时器。
     这里只是兜底把断掉的链重新接上（例如页面刚从 bfcache 恢复）。 */
  var POLL_GUARD_MS = 1500;

  /* 回车让步窗口。
     手机上输入法常把整个词停在「组合区」，而 xterm 处理回车时会先清空
     隐藏 textarea 再发 \r —— 组合收尾（setTimeout(0) 里读 textarea）
     于是读到空串，最后一个字永远发不出去。详见 onEnterKey()。 */
  var ENTER_HOLD_MS = 90;
  var IME_GRACE_MS = 250;     // compositionend 之后这段时间内的回车也算「刚组合完」

  var KEEPALIVE_MS = 5000;    // 页面心跳间隔（后端容错 30 秒）

  /* --------------------------------------------------------------------------
     本地行编辑器（前端独占「输入行」的显示）

       目标：按键那一刻就出现在屏幕上，网络往返完全不参与显示，
             且**任何情况下都不会出现「本地画一遍 + 服务端回显一遍」的重复**。

     一、为什么必须让服务端彻底闭嘴（v1.2.6 的教训）

       readline 的回显**不是**逐字节等于按键流，而是「相对它自己屏幕状态的增量
       重绘」。实测真实 bash 5.2 / readline 8.2（见 terminal/tools/record_echo）：

         输入 abc → 退格        ⇒ \x08\e[K            （不是 \x08 \x08）
         行中插入 X             ⇒ "X" + 尾部 + \x08×尾部宽
         左方向键               ⇒ \x08
         Ctrl-U                 ⇒ \x08×光标列 + \e[K
         Tab 补全               ⇒ 只吐补全出来的后缀（cd /tm → "p/"）
         ↑ 历史                 ⇒ 历史行原文
         回车                   ⇒ \e[?2004l\r\r\n + 输出 + \e[?2004h + 提示符
         Ctrl-L                 ⇒ \e[H\e[2J（回显关掉时连提示符都不重画）

       要逐字节猜准这些增量是不可能的；猜错一次就永久错位 —— 于是本地画的
       字符和服务端回显的字符同时留在屏幕上，也就是用户报的「显示重复」。
       所以唯一可靠的办法是：**不要让服务端回显**。

     二、关掉 ECHO 后的实测事实（决定整个架构）

       后端进程在会话建立时清掉 PTY 从端的 ECHO 位；readline 在
       rl_prep_terminal 里把当时的 ECHO 记进 _rl_echoing_p，为 0 时它的**整条
       绘制路径都不输出**。实测（echo 已关）：

         · 打字 / 退格 / Delete / 方向键 / Home / End / Ctrl-U → **0 字节**
         · Tab 补全      → 0 字节，但 readline 的缓冲区**确实被补全了**
         · ↑↓ 历史       → 0 字节，但历史行**确实进了缓冲区**
         · 回车          → "\e[?2004l\r\r\n" + 命令输出 + "\e[?2004h" + 提示符
         · Ctrl-L        → 只有 "\e[H\e[2J"，提示符都不重画
         · Ctrl-C        → "^C" + 三个换行（正常回显时只有一个）
         · Ctrl-R 反向搜索 → 0 字节（isearch 的提示符也是 readline 画的，看不见）

       结论：输入行的显示可以 100% 归前端；但 **Tab / 历史和 readline 的缓冲区
       状态，前端光看输出流是拿不到的**。必须另开一条「问」的通道。

     三、交棒通道：用 bind -x 让 bash 自己把行内容报回来

       会话建立后，前端悄悄往 shell 里装一个绑定（实测有效、且不留痕迹）：

         bind -x '"\C-x\C-r": printf "\033]777;%s;%s\007" \
                  "$READLINE_LINE" "$READLINE_POINT"'

       `\C-x\C-r` 默认没有绑定，按下时 bash 会执行这条命令，把
       READLINE_LINE / READLINE_POINT 以 OSC 777 的形式吐到输出流里。
       前端把该 OSC 从流里摘掉（不让它到 xterm），就拿到了**权威的行内容与光标**。

       于是 Tab / ↑ / ↓ / Ctrl-R 的处理是：
          发 "按键 + \C-x\C-r" → 收到 OSC → 用报告内容整行重画
       一次往返就把「服务端状态」变成「本地可画的状态」，而且补全、历史、
       多匹配候选列表全部保留（实测 `cd /r` + Tab Tab 仍会列出 rc root/ run/）。

     四、停止本地回显的四种情形（否则会画错或泄露）

         · 密码类提示之后（noEcho）—— 程序自己关了回显，本地画等于把密码显示
           出来，而且服务器根本不回送；
         · 全屏程序期间（备用屏幕 altScreen）—— 普通模式下按键本就不该回显；
         · 处于 login 用户名阶段 —— 那时回显由 login 自己打开，本地画会画两遍；
         · 静默协商还没走完（silencePending）—— 见五。

     五、登录模式：为什么必须往会话里塞一条 stty -echo

         直连 shell 模式是干净的：包装进程在 bash 启动**之前**就把 PTY 从端的
         ECHO 位清掉了，readline 在第一次 rl_prep_terminal 时读到 0 并锁存，
         整条绘制路径静默。登录模式不行 —— /bin/login（以及它拉起的登录 shell
         的启动文件）会按自己的默认值把 termios 重置，bash 第一次 prep 时读到
         的是 1，于是 readline 自己开始回显：那就是「字符画两遍」的来源。

         而且这个状态**改不回来**：readline 在每行结束时 deprep，会把它 prep
         时保存的 termios 写回 tty，所以「趁 readline 活动时发 echo 0」会被
         立刻覆盖（这正是 v1.2.6 那版 ctl echo 0 一直没效果的原因）。

         唯一有效的时刻是「命令正在执行、readline 已 deprep」——那时执行
         stty -echo，下一个 prep 就会读到 0 并把 0 锁存下来（实测后一直保持）。
         于是约定：登录 shell 的提示符一出现，就往它嘴里送一条静默命令。

         怎么知道有没有生效？拿命令文本自己当探针：
           · 服务端把它回显出来了（流里出现 SILENCE_CMD 原文）⇒ readline 还在画；
           · 一个字都没回 ⇒ 回显确实关着。
         第一次注入时「被回显」是正常的（说明之前是开着的）；第二次注入还
         被回显，就说明注入根本没生效 —— 此时退回「服务端回显」模式：本地不再
         画、也不再装报告绑定，界面表现和普通网页终端一致（有 RTT，但正确），
         绝不会出现画两遍或莫名多出一行 bind 命令。

         注入命令自己的屏幕痕迹由 sameLine 规范化抹掉：它只把**第一个换行**
         改写成「回车 + 清行」，回显出来的命令文本会在同一批 term_write 里
         被原地覆盖掉，用户看不到。
     -------------------------------------------------------------------------- */
  var NL_DROP_MS = 900;        // 发过回车 / Ctrl-C 后，这段时间内规范化服务端开头的换行
  var ECHO_ASSERT_MS = 4000;   // 定期重新压住 tty 回显（login / su 会把它打开）
  var ECHO_GRACE_MS = 700;     // 同一批提示符只压一次的最小间隔

  var NOECHO_MAX_MS = 30000;   // 关掉本地回显后的兜底解禁时间

  // sameLine 规范化（安装命令用）：回车 + 清行，把已画的那行原地覆盖掉
  var SAME_LINE_HEAD = new Uint8Array([0x0d, 0x1b, 0x5b, 0x4b]);

  /* 交棒通道 -------------------------------------------------------------- */

  // 报告用的按键：Ctrl-X Ctrl-R（readline 默认未绑定，实测安全）
  var REPORTER_KEY = '\x18\x12';

  // 安装命令。history -d 顺手把这一行从 shell 历史里删掉；
  // 屏幕痕迹由 sameLine 规范化抵消（见 leBootstrap）—— 命令本身前端不画，
  // 服务端回的 "\e[?2004l\r\r\n\e[?2004h<提示符>" 被折成「原地抹掉重画提示符」，
  // 与安装前逐像素一致，用户看不出来。
  var REPORTER_CMD =
    "bind -x '\"\\C-x\\C-r\": printf \"\\033]777;%s;%s\\007\" " +
    "\"$READLINE_LINE\" \"$READLINE_POINT\"';history -d $((HISTCMD-1)) 2>/dev/null";

  // 登录模式专用的「把 tty 回显真正关掉」的命令。见文件头「五、登录模式」。

  // 为什么必须是**在会话里执行一条命令**，而不是走 ctl 通道的 `echo 0`：
  //   readline 每结束一行都会调 rl_deprep_terminal，把自己 prep 时保存的
  //   termios 原样写回去 —— 所以在它活动期间改 ECHO 位会被立刻覆盖。
  //   只有在「命令正在执行、readline 已 deprep」的那一刻执行 stty -echo，
  //   下一个 rl_prep_terminal 才会读到 0 并把它锁存下来（此后一直是 0）。
  //   实测（bash 5.2 / x86_64）：注入前 ab ⇒ 回显 "ab"；注入后 cd ⇒ 0 字节。
  var SILENCE_CMD = 'stty -echo 2>/dev/null; history -d $((HISTCMD-1)) 2>/dev/null';
  var SILENCE_MAX_MS = 4000;      // 注入之后等下一个提示符的上限，超了算注入失败
  var SILENCE_TRIES = 2;          // 最多注入几次（第二次的结果就是判定依据）
  var SAME_LINE_SCAN = 240;       // sameLine 找第一个换行时最多看多少字节
  var SAME_LINE_MAX = 480;        // sameLine 扣住的字节上限，超了立即放弃
  var SAME_LINE_HOLD_MS = 300;    // sameLine 扣住的兜底时长，超时原样放出来

  var OSC_PREFIX = '\x1b]777;';   // 报告序列前缀
  var OSC_TERM = '\x07';          // 报告序列终止（BEL）

  var REPORTER_WAIT_MS = 1200;    // 交棒后等报告的上限；超时认定绑定失效
  var REPORTER_INSTALL_MS = 2500; // 首次安装前的等待；重试按 2 的幂放大
  var REPORTER_MAX_TRIES = 4;     // 一个会话最多安装几次（装不上就认了）

  var ENC = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;

  var LS_KEY = 'terminal.sessions.v2';

  /* --------------------------------------------------------------------------
     页面标识（owner）

       产品要求：**只有终端网页打开时才跑 shell，网页一关就收掉进程**。

       做法是给每个标签页一个 owner：
         - 存在 sessionStorage 里 —— 同一标签页内所有会话共享，
           并且**关闭标签页后自动消失**（新建标签页会拿到新的 owner）；
         - 建会话时带给后端，后端记在会话目录，用于按页面批量回收；
         - 页面每 5 秒发一次 keepalive 续租，页面关闭时发 shutdown 立即回收；
         - 万一 shutdown 发不出去（崩溃 / 断网），后端会在 30 秒心跳超时后
           自动把孤儿会话连进程一起清掉（见 session.inc 的 sess_gc）。

       这样二进制的生命周期就严格被「网页是否打开」绑定了。
     -------------------------------------------------------------------------- */
  var OWNER = (function () {
    try {
      var k = 'terminal.owner';
      var v = sessionStorage.getItem(k);
      if (!v) {
        v = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(k, v);
      }
      // 后端只接受 [A-Za-z0-9_-]
      return String(v).replace(/[^A-Za-z0-9_-]/g, '');
    } catch (e) {
      return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  })();

  /* ---------------- 工具 ---------------- */

  function b64decodeToBytes(b64) {
    var bin = atob(b64 || '');
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function b64encode(str) {
    // UTF-8 安全编码（命令里可能有中文路径）。
    // 统一走 utf8Bytes()：它自带无 TextEncoder 环境的手工编码兜底，
    // 不要在这里直接 new TextEncoder（极老浏览器会直接崩）。
    var bytes = utf8Bytes(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* 字符串 -> UTF-8 字节。
     本地回显必须走这条路：xterm 拿到 Uint8Array 才会自己按 UTF-8 解码，
     直接 write 字符串会让中文变成 ä¸­（见 append 里的说明）。 */
  function utf8Bytes(str) {
    if (ENC) return ENC.encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  /* ---------------- 本地行编辑器用的小工具 ---------------- */

  function repeat(s, n) {
    if (n <= 0) return '';
    var out = '';
    while (n-- > 0) out += s;
    return out;
  }

  /* 光标左移 n 格（用终端字面量 \b，不是 Unicode 退格字符） */
  function repeatBS(n) {
    return repeat('\b', n);
  }

  /* 一个码点的显示宽度（我们只需要区分「占两格的 CJK」和「一格的其它」） */
  function cpWidth(cp) {
    if (cp === 0) return 0;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;          // 控制 / C1
    if (cp >= 0x0300 && cp <= 0x036f) return 0;                  // 组合记号
    if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
    if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
    if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;                  // 变体选择符
    if ((cp >= 0x1100 && cp <= 0x115f) ||                        // Hangul Jamo
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||       // CJK 部首 / 汉字
        (cp >= 0xac00 && cp <= 0xd7a3) ||                        // Hangul 音节
        (cp >= 0xf900 && cp <= 0xfaff) ||                        // CJK 兼容
        (cp >= 0xfe30 && cp <= 0xfe6f) ||                        // CJK 兼容形式
        (cp >= 0xff00 && cp <= 0xff60) ||                        // 全角
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f9ff) ||                      // Emoji
        (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
    return 1;
  }

  /* 字符串的显示宽度（正确处理代理对） */
  function dispWidth(str) {
    if (!str) return 0;
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          w += cpWidth(((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000);
          i++;
          continue;
        }
      }
      w += cpWidth(c);
    }
    return w;
  }

  /* 字节数组 <-> latin1 字符串（逐字节对应，不做 UTF-8 解释）。
     只用于「转义序列 / 提示符」这类 ASCII 识别，或按字节裁剪后还原。 */
  function latin1FromBytes(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function bytesFromLatin1(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  var EMPTY_BYTES = new Uint8Array(0);

  /* bash 的 READLINE_POINT 是「字符」下标（多字节算一个），
     换算成 JS 字符串下标（代理对算两个）。 */
  function cpToJsIndex(str, cp) {
    var i = 0, k = 0;
    while (i < str.length && k < cp) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { i += 2; k++; continue; }
      }
      i += 1; k += 1;
    }
    return i;
  }

  /* 方向键 / Home / End / Delete 的转义序列 -> 动作名（顺手把原始序列带回） */
  var ESC_KEYS = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
    '\x1b[H': 'home', '\x1b[F': 'end',
    '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
    '\x1b[2~': 'insert', '\x1b[3~': 'delete', '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
    '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
    '\x1bOH': 'home', '\x1bOF': 'end'
  };

  /* 单个控制字符 -> 动作名 */
  var CTRL_ACTIONS = {
    '\x01': 'home', '\x05': 'end',
    '\x02': 'left', '\x06': 'right',
    '\x15': 'killstart', '\x0b': 'killend', '\x17': 'killword',
    '\x0c': 'ctrll'
  };

  /* 在 data[i] 处匹配一个转义序列，返回 {action, raw}；认不出来返回 null */
  function matchEscape(data, i) {
    for (var len = 6; len >= 2; len--) {
      if (i + len > data.length) continue;
      var seq = data.substr(i, len);
      if (ESC_KEYS[seq]) return { action: ESC_KEYS[seq], raw: seq };
    }
    return null;
  }

  /* 跳过 bytes[i] 处的一个转义序列，返回其后的下标；识别不出/不完整则返回 i */
  function skipEscape(b, i, limit) {    var j = i + 1;
    if (j >= limit) return i;
    if (b[j] === 0x5b) {                    // CSI: ESC [ 参数 中间 终结
      j++;
      while (j < limit && b[j] >= 0x20 && b[j] <= 0x3f) j++;
      while (j < limit && b[j] >= 0x20 && b[j] <= 0x2f) j++;
      if (j < limit && b[j] >= 0x40 && b[j] <= 0x7e) return j + 1;
      return i;                             // 不完整，等下一批
    }
    if (b[j] === 0x5d) {                    // OSC: ESC ] … BEL | ST
      j++;
      while (j < limit) {
        if (b[j] === 0x07) return j + 1;
        if (b[j] === 0x1b && j + 1 < limit && b[j + 1] === 0x5c) return j + 2;
        j++;
      }
      return i;
    }
    return (i + 2 <= limit) ? i + 2 : i;
  }

  function api(action, payload) {
    var opt = { method: 'GET', headers: {} };
    if (payload) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(payload);
    }
    return fetch(API + '/' + action, opt).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* 页面卸载期间专用的发送方式。

     为什么不能用 fetch()：页面正在关闭时，浏览器会中止在途的 fetch，
     请求根本到不了后端 —— 那样「关页面回收进程」就失效了。
     navigator.sendBeacon 的语义就是「把请求交给浏览器，页面死了也照发」，
     正是这个场景的标准解法。返回 false 表示浏览器拒绝排队（此时交给后端
     的心跳超时兜底，不会漏杀）。 */
  function apiBeacon(action, payload) {
    try {
      var url = API + '/' + action;
      var body = JSON.stringify(payload || {});
      if (navigator.sendBeacon) {
        return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      }
    } catch (e) {}
    return false;
  }

  /* ---------------- 会话对象 ---------------- */

  function Session(name, mode) {
    this.name = name || 'shell';
    this.mode = mode || 'login';
    this.sid = null;
    this.offset = 0;
    this.alive = false;
    this.term = null;
    this.fit = null;
    this.cwd = '';
    this.rc = '0';
    this.user = '';
    this.login = '';
    this.pendingUser = '';      // login: 阶段已输入的用户名
    this.awaitingPassword = false; // 已出现 Password: 提示
    this.scanBuf = '';          // 输出流滚动缓冲（用于识别提示符）
    this.reading = false;       // 是否有 read 在途（长轮询门闩）
    this.pending = '';          // 待发送的按键（串行化队列）
    this.sending = false;       // 是否有 exec 在途
    this.execRetry = null;      // exec 失败后的重试定时器
    this.readRetry = null;      // read 失败后的重试定时器
    this.enterTimer = null;     // 回车让步定时器
    this.composing = false;     // 输入法是否正在组合
    this.composedAt = 0;        // 最近一次组合结束时刻

    // ---------- 本地行编辑器状态 ----------
    this.line = '';             // 当前输入行（唯一的行模型，显示归它管）
    this.cur = 0;               // 光标在 line 中的下标（按 JS 字符计，BMP 外算两个）
    this.anchor = null;         // 输入行行首的屏幕坐标 {row,col}（重画要用）
    this.nlMode = '';           // 开头换行规范化：'' | 'dropNL' | 'oneNL' | 'sameLine'
    this.nlUntil = 0;           // 规范化窗口的截止时间
    this.sameLineHold = null;   // sameLine 暂时扣住、还没见到换行的字节
    this.sameLineTimer = null;  // 扣住字节的兜底放行定时器
    this.lastLine = '';         // 最近一次提交的行（排障 / 状态栏用）
    this.promptText = '';       // 最近一次见到的提示符原文（Ctrl-L / 交棒重画要用）
    this.localEcho = true;      // 本地回显总开关；fallBackToServerEcho 置 false 后整会话只走服务端回显
    this.loginPhase = false;    // 处于 login 的用户名阶段（那时回显归 login 管）
    this.echoSentAt = 0;        // 上次往服务端压 echo=0 的时间
    this.promptAt = 0;          // 最近一次识别到提示符的时间
    this.noEcho = false;        // 服务端当前不回显（密码提示 / login 阶段）
    this.noEchoAt = 0;

    // ---------- 登录模式的「静默协商」状态（见文件头 五）----------
    this.serverEcho = false;    // 兜底：服务端硬要回显 -> 本地不再画，整串交给它
    this.echoSilenced = false;  // 回显已确认按住（登录模式下本地回显可以启用）
    this.silenceAt = 0;         // 上次注入静默命令的时间；0 = 还没注入过
    this.silenceTries = 0;      // 已注入几次
    this.silenceHeard = false;  // 上一轮注入的命令文本被回显出来了（= 回显还开着）
    this.probeBuf = '';         // 判定「命令文本被回显」用的滚动缓冲
    this.sawPassword = false;   // 登录模式：见过密码提示（静默协商的前置条件）
    this.altScreen = false;     // 前台正处于全屏程序（vim / top …）的备用屏幕
    this.altBuf = '';           // 用于识别备用屏幕开关的滚动缓冲

    // ---------- 交棒通道（bind -x 报告）状态 ----------
    this.reporterReady = false; // 绑定已确认可用（收到过报告）
    this.installAt = 0;         // 上次安装绑定的时间
    this.installTries = 0;      // 本会话已尝试安装几次
    this.reportAt = 0;          // 本次交棒发出的时间（等报告用）
    this.reportTimer = null;    // 等报告的超时定时器
    this.oscCarry = '';         // OSC 过滤的跨批缓冲（没收全的序列存这里）
    this.reportLine = null;     // 最近一次报告的行内容（null = 还没收到）
    this.reportPoint = 0;       // 最近一次报告的光标位置

    this.els = {};
  }

  Session.prototype.mount = function () {
    var self = this;

    // 每个会话一套 DOM：标签 + xterm 容器
    var screen = document.getElementById('screen');
    var host = document.createElement('div');
    host.className = 'xterm-host';
    host.style.display = 'none';
    host.style.position = 'absolute';
    host.style.inset = '0';
    screen.appendChild(host);
    this.els.host = host;

    this.term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"JetBrains Mono","Cascadia Mono","SFMono-Regular","Menlo","Consolas","DejaVu Sans Mono",monospace',
      fontSize: 13.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#c9d1d9',
        cursorAccent: '#0d1117',
        selectionBackground: '#2f81f766',
        black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
      }
    });
    this.term.open(host);

    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);

    // 键盘输入 -> 本地先画 -> 再送后端（顺序不能反，见 typeInput）
    this.term.onData(function (data) {
      self.typeInput(data);
    });

    // ------------------------------------------------------------------
    // 跟踪输入法组合状态（手机回车丢字的修复依据，见 onEnterKey）
    //
    //   xterm 把真实按键收在一个隐藏 textarea 里，桌面键盘走 keydown/keypress，
    //   那个 textarea 始终是空的；手机输入法（尤其带联想/纠错的）整个词都停在
    //   组合区，只有监听它才能知道「此刻还有字没提交」。
    // ------------------------------------------------------------------
    var ta = null;
    try { ta = this.term.textarea; } catch (e) {}
    if (!ta) ta = host.querySelector('textarea');
    if (ta) {
      ta.addEventListener('compositionstart', function () { self.composing = true; });
      ta.addEventListener('compositionend', function () {
        self.composing = false;
        self.composedAt = Date.now();
      });
    }

    // 自定义按键拦截。注意：这个回调在 xterm 内部**最先**执行，
    // 早于它的输入法收尾与回车处理，所以这里是唯一能救下最后一个字的位置。
    this.term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;

      // 回车 + 输入法还有未提交的字 -> 抢在 xterm 之前接管
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && self.imePending()) {
        self.onEnterKey();
        return false;   // 让 xterm 完全跳过这次回车（关键，别改成 true）
      }
      return true;
    });

    // 尺寸变化 -> 通知 PTY（独立 resize 动作，不混进按键流）
    // 与 send 同理：resize 的响应里可能带 data，但一律不写 xterm，
    // 输出全部交给 read 单通道，避免重复。
    //
    // 这里不需要为「服务端重绘当前行」做什么：回显是关掉的，实测改尺寸
    // 并不会让 readline 重画（SIGWINCH 也推不动它）。输入行始终归前端管，
    // 尺寸变了之后 xterm 自己会重排，锚点由下一次提示符刷新。
    this.term.onResize(function (size) {
      if (self.sid && self.alive) {
        api('resize', { sid: self.sid, offset: self.offset, cols: size.cols, rows: size.rows })
          .then(function () { self.kickPoll(); })
          .catch(function () {});
      }
    });
  };

  Session.prototype.fitNow = function () {
    try { this.fit.fit(); } catch (e) {}
  };

  Session.prototype.show = function (on) {
    this.els.host.style.display = on ? '' : 'none';
    if (on) {
      var self = this;
      requestAnimationFrame(function () { self.fitNow(); self.term.focus(); });
    }
  };

  Session.prototype.append = function (bytes) {
    if (!bytes || !bytes.length) return;
    var self = this;

    // 0) 登录模式：静默命令的文本被回显出来了 ⇒ readline 还在画（见文件头 五）。
    //    必须在规范化之前判：规范化只改换行，文本本身还在，但拆批时两截
    //    可能落在不同批次里，所以要留一段滚动缓冲。
    var s = latin1FromBytes(bytes);
    if (this.silenceAt && !this.echoSilenced) {
      this.probeBuf = (this.probeBuf + s).slice(-(SILENCE_CMD.length * 3 + 32));
      if (this.probeBuf.indexOf(SILENCE_CMD) >= 0) this.silenceHeard = true;
    }

    // 1) 摘掉交棒报告（OSC 777）。它绝不能进 xterm ——
    //    xterm 会把 OSC 777 当成终端通知处理。
    var f = this.filterReports(s);
    if (f.text !== s) bytes = bytesFromLatin1(f.text);
    // 摘掉报告后可能一个可见字节都不剩（整批就是一条 OSC）—— 报告不能跟着丢
    if (!bytes.length) return this.runReports(f);

    // 2) 服务端开头的换行规范化（刚发过回车 / Ctrl-C 时）
    if (this.nlMode && Date.now() < this.nlUntil) {
      bytes = this.normalizeLead(bytes);
      if (!bytes.length) return this.runReports(f);
    } else if (this.nlMode) {
      // 窗口过期：sameLine 扣住的字节（若有）原样补出来，别丢内容
      var held = this.sameLineHold;
      this.dropSameLine();
      if (held && held.length) bytes = concatBytes(held, bytes);
    }

    // ------------------------------------------------------------------
    // 中文（以及所有非 ASCII）能正常显示的关键：
    //   必须把**原始 UTF-8 字节**交给 xterm，让它自己解码。
    //
    //   xterm.js 的 InputHandler.parse 有两条分支：
    //     - 传 string      → 走 _stringDecoder.decode()，即「再按 UTF-8 解一遍」
    //     - 传 Uint8Array  → 直接按字节处理（内部即 UTF-8 语义）
    //
    //   如果这里先把字节转成 latin1 字符串再 write()，等于提前解了一次码；
    //   xterm 拿到字符串后又会用 UTF-8 解码器二次解码 → '中' 变成 'ä¸­' 乱码。
    //   所以：**原样传 Uint8Array，绝不要在这里拼字符串**。
    // ------------------------------------------------------------------
    s = latin1FromBytes(bytes);
    this.term.write(bytes, function () {
      // 识别器要等 xterm 解析完再跑：光标位置、备用屏幕开关都在那之后才准
      self.scanAltScreen(s);
      self.scanPrompt(s);
      // 报告要**最后**应用：服务端在报告前面还吐了 "\r\e[K\r"，
      // 那是它把自己那一行擦掉；本地重画必须排在它后面，否则会被擦没。
      for (var k = 0; k < f.reports.length; k++) self.applyReport(f.reports[k]);
    });
  };

  /* 只剩报告、没有可见字节时，光把报告应用掉 */
  Session.prototype.runReports = function (f) {
    if (!f || !f.reports.length) return;
    var self = this;
    this.term.write(EMPTY_BYTES, function () {
      for (var k = 0; k < f.reports.length; k++) self.applyReport(f.reports[k]);
    });
  };

  /* 把 CSI K（\e[K / \e[0K / \e[2K，「抹到行尾 / 抹整行」）按终端语义处理：
     它之前、同一行内的内容都不存在了，序列本身也不该留在文本里。
     识别提示符的滚动缓冲必须做这一步 —— 否则被抹掉的内容会被当成还在。 */
  function stripEraseToEOL(text) {
    if (!text || text.indexOf('\x1b') < 0) return text;
    var out = '', i = 0, n = text.length;
    while (i < n) {
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '[') {
        var j = i + 2;
        while (j < n && '0123456789;?'.indexOf(text[j]) >= 0) j++;
        if (j >= n) { out += text.slice(i); break; }   // 序列没收全，等下一批
        if (text[j] === 'K') {                          // 抹到行尾 / 抹整行
          var nl = out.lastIndexOf('\n');
          out = nl >= 0 ? out.slice(0, nl + 1) : '';
        } else {
          out += text.slice(i, j + 1);                  // 整条序列原样保留
        }
        i = j + 1;
        continue;
      }
      out += text[i];
      i++;
    }
    return out;
  }

  /* ---------
     从输出流里尽力识别当前身份（login 模式没有 bashrc 回写 user 文件）

       login 成功后的提示符常见两种：
         host:~$          （busybox / Alpine 风格）
         user@host:~$     （Debian/Ubuntu 风格，能直接拿到用户名）
       另外把 `host login: xxx` 里正在输入的用户名也识别出来，
       这样在输密码阶段状态栏就能显示「待登录为 xxx」。

     识别失败时保持原值，不覆盖已知身份，避免闪烁。
     --------- */
  Session.prototype.scanPrompt = function (chunk) {
    if (!chunk) return;
    // 累积一段滚动文本（只保留尾部，避免无限增长）
    this.scanBuf = ((this.scanBuf || '') + chunk).slice(-2048);
    // CSI K（抹到行尾）必须按终端语义处理掉，否则**被抹掉的那一截还留在
    // 缓冲里**，后面取「最近一次提示符原文」时会把旧提示符一起吞进去。
    // 登录模式连续注入静默命令时实测出过这个：三次原地覆盖之后
    // promptText 变成 "root@nas:~# \e[K\e[?2004l\e[?2004hroot@nas:~# "，
    // 交棒重画时就把三个提示符一起画回屏幕上了。
    this.scanBuf = stripEraseToEOL(this.scanBuf);
    var buf = this.scanBuf.replace(/\r/g, '');

    // ------------------------------------------------------------------
    // 0) 密码提示 -> 立刻关掉本地回显（安全前提）
    //
    //    这类提示之所以不打回显，是程序自己把 ECHO 关掉了，服务器**不会**
    //    把我们敲的字符送回来。本地若照常画，就等于把密码明明白白显示在
    //    屏幕上，而且本地行模型会和服务端永久错位。
    //    因此一见提示就停手，等重新看到 shell 提示符再放开。
    // ------------------------------------------------------------------
    if (/(?:password|passphrase|口令|密码)[^\n]{0,24}[:：][ \t]*$/i.test(buf)) {
      this.sawPassword = true;      // 登录模式的静默协商要等过了这一步才动手
      if (!this.noEcho) {
        this.noEcho = true;
        this.resetLine();
      }
      this.noEchoAt = Date.now();
    } else if (this.noEcho) {
      // 又出现了「行尾像提示符」的输出 -> 已经回到普通输入状态。
      // 时间兜底：万一某个程序既提示密码又再也不出提示符。
      if (/\n[^\n]*[$#>][ \t]*$/.test(buf) ||
          Date.now() - this.noEchoAt > NOECHO_MAX_MS) {
        this.noEcho = false;
      }
    }

    // ------------------------------------------------------------------
    // 0b) login: 用户名阶段 —— 那一段回显是 login 自己开的
    //     所以前端既不本地画（会画两遍），也不去压 echo=0（会让用户名看不见）。
    // ------------------------------------------------------------------
    if (/(?:^|\n)[^\n]{0,64}login:\s*$/i.test(buf)) this.loginPhase = true;

    // ------------------------------------------------------------------
    // 1) 新的提示符 -> 输入行从头开始，本地行模型跟着复位
    //
    //    「行尾像提示符」这个条件本身就意味着：光标此刻正停在提示符后面，
    //    也就是这一行的行首 —— 重画要用的锚点在这里记下来最准。
    // ------------------------------------------------------------------
    if (this.isFreshPrompt(buf)) {
      // 提示符原文（去掉紧邻的 bracketed-paste 开关，保留颜色转义）——
      // Ctrl-L 本地清屏、交棒后整行重画都要靠它把提示符画回来。
      this.promptText = buf.slice(buf.lastIndexOf('\n') + 1)
                           .replace(/^(?:\x1b\[\?2004[hl])*/, '');
      this.promptAt = Date.now();
      this.loginPhase = false;
      if (this.rowIsFreshLine()) this.resetLine();
      else this.captureAnchor();

      if (this.needSilence()) {
        // 登录模式：/bin/login（以及登录 shell 的启动文件）已经把 tty 回显
        // 打开了。这里先把它**真正**按住，再谈本地回显与报告绑定。见文件头 五。
        this.silenceStep();
      } else {
        // login / su 之后 termios 会被它们重置（ECHO 打开）—— 这里再压一次；
        // 顺手确保「报告绑定」也在（换过 shell 就要重装）
        this.assertEchoOff();
        this.maybeInstallReporter();
      }
    }

    // 2) user@host:  —— 最可靠的来源
    var m = /([A-Za-z0-9_.-]{1,32})@[^\s:]{1,64}:[^\n]*[$#]\s*$/.exec(buf);
    if (m) { this.user = m[1]; return; }

    // 3) "xxx login: 输入中" —— 让状态栏提前显示目标账号
    var m2 = /login:\s*([A-Za-z0-9_.-]{1,32})\s*$/.exec(buf);
    if (m2) { this.pendingUser = m2[1]; return; }

    // 4) 成功登录后的 host:~$ 形式：无法从提示符区分用户，
    //    但能判断「已经从 login: 阶段走出来了」。
    if (/\bPassword:\s*$/m.test(buf)) { this.awaitingPassword = true; }
    if (/[^\s]+\s*:\s*[^\n]*[$#]\s*$/.test(buf) && this.awaitingPassword
        && this.pendingUser) {
      this.user = this.pendingUser;
      this.awaitingPassword = false;
    }
  };

  /* 一批输出是否以「全新提示符」结尾？
     要求：提示符出现在行尾、且这一行不太长。
     长度限制是为了避免把命令输出里恰好以 `>` `#` 结尾的长行当成提示符。 */
  Session.prototype.isFreshPrompt = function (buf) {
    if (this.altScreen) return false;
    return /(?:^|\n)[^\n]{0,120}?[$#%>] ?$/.test(buf);
  };

  /* 光标此刻是不是停在一个「空行首」（刚画完提示符）？
     用来决定是复位行模型还是只更新锚点：如果用户已经敲了字（行非空），
     那就说明这只是一段恰好长得像提示符的输出，不能把模型清掉。 */
  Session.prototype.rowIsFreshLine = function () {
    return this.line === '' && this.cur === 0;
  };

  /* --------- 核心：create --------- */
  Session.prototype.create = function () {
    var self = this;
    var payload = { mode: this.mode, owner: OWNER };
    if (this.mode === 'shell' && this.login) payload.login = this.login;
    // 带上当前终端尺寸，让 PTY 一开始就是对的
    if (this.term) {
      try {
        var d = this.fit.proposeDimensions();
        if (d && d.cols) { payload.cols = d.cols; payload.rows = d.rows; }
      } catch (e) {}
    }
    return api('create', payload).then(function (d) {
      if (!d.ok) throw new Error(d.error || '创建失败');
      self.sid = d.sid;
      self.offset = d.offset || 0;
      self.alive = d.alive !== false;
      self.mode = d.mode || self.mode;
      self.login = d.login || self.login || '';
      // login 模式下，在见到第一个 shell 提示符之前都算「用户名阶段」：
      // 那一段的回显归 login 自己管，前端不画、也不去压 echo=0。
      self.loginPhase = (self.mode === 'login');
      // 新会话：报告绑定要重新确认（旧 shell 的绑定带不过来）
      self.reporterReady = false;
      self.installAt = 0;
      self.installTries = 0;
      self.promptAt = 0;
      self.nlMode = '';
      self.nlUntil = 0;
      self.oscCarry = '';
      // 新会话 -> 静默协商从头来过（登录模式要重新把回显按住）
      self.serverEcho = false;
      self.echoSilenced = false;
      self.silenceAt = 0;
      self.silenceTries = 0;
      self.silenceHeard = false;
      self.probeBuf = '';
      self.sawPassword = false;
      self.append(b64decodeToBytes(d.data));
      self.syncHint(d);
      self.fitNow();
      return self;
    });
  };

  /* ==========================================================================
     本地行编辑器 —— 入口

       顺序：**先本地画 → 再发网络**。本地画完用户就看到了，
       网络那一趟纯粹在后台上传。
     ========================================================================== */

  /* 本地回显能不能用？不能用的场合整串交回服务端：
       · serverEcho —— 兜底：服务端硬要回显，两边都画就是画两遍，本地让位
       · noEcho     —— 密码提示：本地画等于把密码显示出来，而且服务端根本不回送
       · altScreen  —— vim/top 这类全屏程序：普通模式下按键本就不该回显
       · loginPhase —— login 的用户名阶段：那一段回显由 login 自己打开
       · needSilence —— 登录模式下回显还没确认按住（见文件头 五） */
  Session.prototype.canEdit = function () {
    if (!this.localEcho) return false;
    if (this.noEcho || this.altScreen || this.loginPhase) return false;
    if (this.needSilence()) return false;
    return true;
  };

  /* 登录模式还欠一次「把回显真正按住」：这期间既不能本地画，也不能装报告绑定。
     要求「见过密码提示」才认 —— 万一 login 的某行输出被误判成提示符，
     也不会把 stty -echo 塞进 login 的用户名读取里（那会让登录直接失败）。 */
  Session.prototype.needSilence = function () {
    if (this.mode !== 'login') return false;
    if (this.echoSilenced || this.serverEcho) return false;
    return this.sawPassword === true;
  };

  /* 交给 xterm 的写入口（必须是 Uint8Array，否则中文会二次解码成乱码） */
  Session.prototype.emit = function (str, cb) {
    if (!str) { if (cb) cb(); return; }
    this.term.write(utf8Bytes(str), cb);
  };

  Session.prototype.w = function (str) { return dispWidth(str || ''); };

  /* --------------------------------------------------------------------------
     交棒报告（OSC 777）—— 摘除与解析

       bash 的报告形如 "\e]777;<行内容>;<光标位置>\a"。它绝不能进 xterm
       （xterm 会把 OSC 777 当通知处理，甚至可能弹东西），所以要在这里摘掉。
     -------------------------------------------------------------------------- */

  /* 把 s 里所有报告序列摘出来；没收全的一截先存进 oscCarry，等下一批接上。 */
  Session.prototype.filterReports = function (s) {
    if (this.oscCarry) { s = this.oscCarry + s; this.oscCarry = ''; }
    var out = '', i = 0, reports = [];
    for (;;) {
      var p = s.indexOf(OSC_PREFIX, i);
      if (p < 0) { out += s.slice(i); break; }
      out += s.slice(i, p);
      var e = s.indexOf(OSC_TERM, p + OSC_PREFIX.length);
      if (e < 0) { this.oscCarry = s.slice(p); break; }   // 还没见到 BEL
      reports.push(s.slice(p + OSC_PREFIX.length, e));
      i = e + 1;
    }
    return { text: out, reports: reports };
  };

  /* 报告体是 "<行内容>;<光标位置>"。行内容里可能有分号，所以按**最后一个**切。 */
  Session.prototype.applyReport = function (body) {
    var cut = body.lastIndexOf(';');
    if (cut < 0) return;
    var line = body.slice(0, cut);
    var pt = parseInt(body.slice(cut + 1), 10);
    if (isNaN(pt) || pt < 0) pt = 0;

    this.reporterReady = true;
    if (this.reportTimer) { clearTimeout(this.reportTimer); this.reportTimer = null; }

    // 服务端那边刚把这一行擦掉了（\r\e[K\r），屏幕上的行由我们重画
    this.line = line;
    this.cur = cpToJsIndex(line, pt);
    this.leRedrawAll();
  };

  /* --------------------------------------------------------------------------
     交棒：把必须由 shell 决定的按键送出去，再问一次「现在这一行是什么」

       一次往返搞定：`按键 + \C-x\C-r`。readline 按顺序处理输入，报告必然
       发生在补全 / 取历史之后，所以拿到的就是最终结果。
     -------------------------------------------------------------------------- */

  Session.prototype.leHandoff = function (keys) {
    this.send(keys + REPORTER_KEY);
    this.expectReport();
  };

  /* 等报告；超时说明绑定失效（换了 shell / 被 reset 掉了），标记待重装 */
  Session.prototype.expectReport = function () {
    var self = this;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(function () {
      self.reportTimer = null;
      if (self.reporterReady === false) return;
      self.reporterReady = false;
      self.maybeInstallReporter();
    }, REPORTER_WAIT_MS);
  };

  /* 静默安装报告绑定。
     这条命令要完全不留痕迹：命令文本前端不画、shell 历史立刻删掉，
     屏幕上服务端那段 "\e[?2004l\r\r\n\e[?2004h<提示符>" 也不能露出一条
     空的提示符行。做法是 sameLine 规范化 —— 把那半截换行抹掉，改写成
     「回车 + 清行 + 原样重画提示符」，屏幕与安装前逐像素相同。 */
  Session.prototype.leBootstrap = function () {
    this.installAt = Date.now();
    this.installTries = (this.installTries || 0) + 1;
    this.nlMode = 'sameLine';
    this.nlUntil = Date.now() + NL_DROP_MS;
    // 命令后面紧跟一个报告键：readline 会把它留到下一个提示符再读，绑定装上了
    // 就立刻回一条报告 —— 一次往返既确认绑定可用（不必反复重装），
    // 又顺手把本地行模型对齐到服务端的真实状态。
    this.send(REPORTER_CMD + '\r' + REPORTER_KEY);
    this.expectReport();
  };

  /* 什么时候才允许安装。条件卡得比较紧，原因是安装用了 sameLine ——
     它会「清掉当前行再重画提示符」。要是那一刻用户已经打了半行字，
     屏幕上那半行就被抹掉了（行模型还在，但视觉上凭空消失）。
     所以必须同时满足：
       · 刚出现提示符不久（不是随看门狗空隙随手插一脚）；
       · 本地输入行是空的（用户还没开始打字）。

     另外 `reporterReady` 为假只代表「不知道装没装上」——键位被 reset
     / 换过 shell 都会让它变假，所以允许重试，但要限次数、拉开间隔，
     不能每次看门狗都往会话里塞一条命令。 */
  Session.prototype.maybeInstallReporter = function () {
    if (this.reporterReady) return;
    if (!this.sid || !this.alive) return;
    if (this.altScreen || this.loginPhase || this.noEcho) return;
    if (this.serverEcho) return;                          // 已退回服务端回显：根本不需要报告
    if (this.needSilence()) return;                       // 回显还没按住，装了也是白装（还会被回显出来）
    if (!this.promptAt) return;
    if (this.line !== '') return;                         // 用户正在打字，别动屏幕
    if (Date.now() - this.promptAt > 800) return;         // 只在刚出提示符时安装
    if ((this.installTries || 0) >= REPORTER_MAX_TRIES) return;
    // 间隔随重试次数放大：2.5s / 5s / 10s，装不上就不再打扰
    var gap = REPORTER_INSTALL_MS * Math.pow(2, this.installTries || 0);
    if (Date.now() - this.installAt < gap) return;
    this.leBootstrap();
  };

  /* --------------------------------------------------------------------------
     登录模式的静默协商（见文件头 五）

       每出现一个新提示符就被调用一次，直到结论出来：
         第一次              -> 注入 SILENCE_CMD
         第二次（上一次被回显）-> 再注入一次 —— 这一次的结果才是判定依据
         第二次还被回显       -> 认定注入不生效，退回服务端回显
         没被回显            -> 静默成功，启用本地回显 + 装报告绑定
     -------------------------------------------------------------------------- */
  Session.prototype.silenceStep = function () {
    if (this.silenceAt) {
      var heard = this.silenceHeard;
      this.silenceHeard = false;
      this.probeBuf = '';
      if (!heard) { this.onSilenced(); return; }
      if (this.silenceTries >= SILENCE_TRIES) { this.fallBackToServerEcho(); return; }
    }
    this.silenceAt = Date.now();
    this.silenceTries++;
    this.nlMode = 'sameLine';
    this.nlUntil = Date.now() + NL_DROP_MS;
    this.send(SILENCE_CMD + '\r');
  };

  Session.prototype.onSilenced = function () {
    this.silenceAt = 0;
    this.probeBuf = '';
    this.silenceHeard = false;
    this.echoSilenced = true;
    this.resetLine();            // 协商期间用户可能敲过字，本地行模型作废
    this.assertEchoOff();
    this.maybeInstallReporter();
  };

  /* 兜底：注入两次都还在回显（比如那个 shell 不吃我们塞的命令），让位给服务端。
     本地不再画、也不再装报告绑定 —— 「字符画两遍」和「莫名多出一行 bind 命令」
     都不会再出现，代价只是输入要等一个往返（和普通网页终端一样）。 */
  Session.prototype.fallBackToServerEcho = function () {
    this.silenceAt = 0;
    this.probeBuf = '';
    this.silenceHeard = false;
    this.echoSilenced = true;
    this.serverEcho = true;
    this.localEcho = false;
    this.resetLine();
    if (this.isActive()) updateStatus(this);
  };

  /* --------------------------------------------------------------------------
     把 onData 送来的串拆成一个个「键」再处理。
     一条 data 里可能有多个键（输入法整词上屏、粘贴、还有 \r 跟着一串文本）。
     -------------------------------------------------------------------------- */
  Session.prototype.typeInput = function (data) {
    if (!data) return;
    if (!this.sid || !this.alive) return;

    // 本地回显不可用：原样交给服务端（login 用户名 / 密码 / 全屏程序）
    if (!this.canEdit()) { this.send(data); return; }

    var i = 0;
    while (i < data.length) {
      var ch = data[i];

      // ---- 转义序列（方向键 / Delete / Home / End / PgUp …）----
      if (ch === '\x1b') {
        var hit = matchEscape(data, i);
        if (hit) {
          if (hit.action === 'pageup' || hit.action === 'pagedown') {
            // 翻页只滚本地视口，不往 shell 里送（终端里的 PgUp/PgDn 就是这个意思）
            try { this.term.scrollPages(hit.action === 'pageup' ? -1 : 1); } catch (e) {}
            i += hit.raw.length;
            continue;
          }
          this.handleKey(hit.action, hit.raw);
          i += hit.raw.length;
          continue;
        }
        // 认不出来的转义序列：整段交棒（带上报告，交完照样能把行同步回来）
        this.leHandoff(data.slice(i));
        return;
      }

      // ---- 回车 ----
      if (ch === '\r' || ch === '\n') { this.leEnter(ch); i++; continue; }

      // ---- 退格 / Delete ----
      if (ch === '\x7f' || ch === '\b') { this.handleKey('backspace', ch); i++; continue; }

      // ---- Tab：补全只能靠 shell ----
      if (ch === '\t') { this.leHandoff('\t'); i++; continue; }

      // ---- Ctrl-C：shell 自己会打印 ^C 并给新提示符，本地只管把行丢掉 ----
      if (ch === '\x03') { this.leCtrlC(); i++; continue; }

      // ---- 其它控制字符 ----
      if (ch < ' ') {
        var act = CTRL_ACTIONS[ch];
        if (act) { this.handleKey(act, ch); i++; continue; }
        // 不认识的（Ctrl-Z / Ctrl-D / Ctrl-R …）：原样交回服务端。
        // 这里**不加**报告键：它们要么换走 shell 状态（Ctrl-R 的 isearch 提示符
        // 也是 readline 画的，回显关掉后本来就看不见），要么直接结束会话。
        this.send(ch);
        i++;
        continue;
      }

      // ---- 可打印串：一次插入（输入法整词上屏走的就是这里）----
      var j = i;
      while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f' && data[j] !== '\x1b') j++;
      var text = data.slice(i, j);
      this.leInsert(text);
      this.send(text);
      i = j;
    }
  };

  /* 处理一个「本地编辑器认识的键」：先本地画，再把原始字节发给服务端 */
  Session.prototype.handleKey = function (action, raw) {
    // Ctrl-L：纯本地清屏 + 重画「提示符 + 当前行」，**不发给服务端**。
    //   发给 readline 的话它只回一个 \e[H\e[2J（回显关掉时连提示符都不重画），
    //   我们反而要自己把提示符补回来；本地做反而干净，且相对关系不变。
    if (action === 'ctrll') { this.leClearScreen(); return; }

    if (action === 'backspace') { this.leBackspace(); this.send(raw); return; }
    if (action === 'delete') { this.leDelete(); this.send(raw); return; }
    if (action === 'left') { this.leLeft(); this.send(raw); return; }
    if (action === 'right') { this.leRight(); this.send(raw); return; }
    if (action === 'home') { this.leHome(); this.send(raw); return; }
    if (action === 'end') { this.leEnd(); this.send(raw); return; }
    if (action === 'killstart') { this.leKill('start'); this.send(raw); return; }
    if (action === 'killend') { this.leKill('end'); this.send(raw); return; }
    if (action === 'killword') { this.leKill('word'); this.send(raw); return; }

    // 剩下能到这里的只有 up / down（历史），只能由 shell 给 -> 交棒
    this.leHandoff(raw);
  };

  /* --------- 本地画：各种编辑动作 --------- */

  /* 插入文本。光标在行尾时只写这一串；在行中间时按 readline 的做法
     把尾部重画一遍再把光标退回来 —— 这样屏幕状态和「行内容」始终对得上。 */
  Session.prototype.leInsert = function (text) {
    if (!text) return;
    var atEnd = (this.cur === this.line.length);
    this.line = this.line.slice(0, this.cur) + text + this.line.slice(this.cur);
    this.cur += text.length;
    if (atEnd) { this.emit(text); return; }
    var tail = this.line.slice(this.cur);
    this.emit(text + tail + repeatBS(this.w(tail)));
  };

  /* 退格：删光标左边那个字符，并把尾部左移一格 */
  Session.prototype.leBackspace = function () {
    if (this.cur <= 0) return false;
    var del = this.line[this.cur - 1];
    var bw = Math.max(1, this.w(del));
    this.line = this.line.slice(0, this.cur - 1) + this.line.slice(this.cur);
    this.cur -= 1;
    var tail = this.line.slice(this.cur);
    // 回退 bw 格 -> 重画尾部 -> 空格擦掉多出来的 bw 格 -> 退回来
    this.emit(repeatBS(bw) + tail + repeat(' ', bw) + repeatBS(this.w(tail) + bw));
    return true;
  };

  /* Delete：删光标右边那个字符 */
  Session.prototype.leDelete = function () {
    if (this.cur >= this.line.length) return false;
    var bw = Math.max(1, this.w(this.line[this.cur]));
    this.line = this.line.slice(0, this.cur) + this.line.slice(this.cur + 1);
    var tail = this.line.slice(this.cur);
    this.emit(tail + repeat(' ', bw) + repeatBS(this.w(tail) + bw));
    return true;
  };

  Session.prototype.leLeft = function () {
    if (this.cur <= 0) return false;
    this.cur -= 1;
    this.emit(repeatBS(Math.max(1, this.w(this.line[this.cur]))));
    return true;
  };

  Session.prototype.leRight = function () {
    if (this.cur >= this.line.length) return false;
    var ch = this.line[this.cur];
    this.cur += 1;
    this.emit(ch);      // 重新画出光标下那个字，等于把光标右移一格
    return true;
  };

  Session.prototype.leHome = function () {
    if (this.cur <= 0) return false;
    this.emit(repeatBS(this.w(this.line.slice(0, this.cur))));
    this.cur = 0;
    return true;
  };

  Session.prototype.leEnd = function () {
    if (this.cur >= this.line.length) return false;
    this.emit(this.line.slice(this.cur));
    this.cur = this.line.length;
    return true;
  };

  /* Ctrl-U（删到行首）/ Ctrl-K（删到行尾）/ Ctrl-W（删前一个词）
     这三类改动幅度大，用「整行重画」最不容易出错。 */
  Session.prototype.leKill = function (kind) {
    var oldLine = this.line, oldCur = this.cur;
    if (kind === 'start') {
      if (this.cur <= 0) return false;
      this.line = this.line.slice(this.cur);
      this.cur = 0;
    } else if (kind === 'end') {
      if (this.cur >= this.line.length) return false;
      this.line = this.line.slice(0, this.cur);
    } else {
      var i = this.cur;
      while (i > 0 && /\s/.test(this.line[i - 1])) i--;
      while (i > 0 && !/\s/.test(this.line[i - 1])) i--;
      if (i === this.cur) return false;
      this.line = this.line.slice(0, i) + this.line.slice(this.cur);
      this.cur = i;
    }
    this.leRedraw(oldLine, oldCur);
    return true;
  };

  /* 把当前行整行重画一遍（光标当前在 oldCur 处）。
     画完之后光标必须正好落在「行首 + cur 宽度」上，否则下一次插入就错位了。 */
  Session.prototype.leRedraw = function (oldLine, oldCur) {
    var out = repeatBS(this.w(oldLine.slice(0, oldCur))) + this.line;
    var pad = this.w(oldLine) - this.w(this.line);
    if (pad > 0) out += repeat(' ', pad);
    // 此刻光标在第 max(w(oldLine), w(line)) 格，退回到 cur 所在那一格
    var endCol = Math.max(this.w(oldLine), this.w(this.line));
    var wantCol = this.w(this.line.slice(0, this.cur));
    if (endCol > wantCol) out += repeatBS(endCol - wantCol);
    this.emit(out);
  };

  /* 整行重画：回到行首、清到屏幕底，再把「提示符 + 当前行」画一遍。

     用在两处：交棒拿到报告之后、Ctrl-L 本地清屏之后。
     正常提示符都在行首、行也不长，就是「\r\e[J + 提示符 + 行」；
     行被软换行撑成多行时，先往上退回提示符那一行。

     【注意】画完之后光标在**整行末尾**，要退到 cur 所在那一格，
     退的格数是 w(line) - w(line[0..cur])，不是 w(line[0..cur])。
     这里曾经写错过：补全报告回来时 cur 在行尾，多退了一整行的宽度，
     光标落在行首，下一个字符就把行首字母覆盖掉了
     （cd /tmp/ 敲 e 变成 ed /tmp/）。 */
  Session.prototype.leRedrawAll = function () {
    var cols = this.term.cols || 80;
    var startCol = this.anchor ? this.anchor.col : 0;
    // 光标可能已经被软换行带到下面几行，先算出它在第几行（相对提示符行）
    var curOff = startCol + this.w(this.promptText) + this.w(this.line.slice(0, this.cur));
    var up = Math.floor(curOff / cols);
    var out = up > 0 ? ('\x1b[' + up + 'A') : '';
    out += '\r\x1b[J' + (this.promptText || '') + this.line;
    var back = this.w(this.line) - this.w(this.line.slice(0, this.cur));
    if (back > 0) out += repeatBS(back);
    this.emit(out);
  };

  /* Ctrl-L：清屏并把「最近一次见到的提示符 + 当前行」画回顶部 */
  Session.prototype.leClearScreen = function () {
    var self = this;
    var out = '\x1b[H\x1b[2J' + (this.promptText || '') + this.line;
    var back = this.w(this.line) - this.w(this.line.slice(0, this.cur));
    if (back > 0) out += repeatBS(back);
    this.emit(out, function () {
      var buf = self.term.buffer && self.term.buffer.active;
      if (!buf) { self.anchor = null; return; }
      var cols = self.term.cols || 80;
      var curOff = self.w(self.promptText) + self.w(self.line.slice(0, self.cur));
      self.anchor = {
        row: buf.baseY + buf.cursorY - Math.floor(curOff / cols),
        col: 0
      };
    });
  };

  /* 回车。本地先把换行画出来（不等网络），服务端随后回送的那个换行会被丢掉。

     为什么不能完全交给服务端：tty 回显被关掉了，那些靠**内核回显**换行的程序
     （heredoc、read -p、脚本里的 read）就一个字都不会输出，整段输入会挤在
     同一行里 —— 本地画这一个换行是必要的兜底。 */
  Session.prototype.leEnter = function (raw) {
    var self = this;
    this.lastLine = this.line;
    this.line = '';
    this.cur = 0;
    this.nlMode = 'dropNL';
    this.nlUntil = Date.now() + NL_DROP_MS;
    this.emit('\r\n', function () {
      var buf = self.term.buffer && self.term.buffer.active;
      if (buf) self.anchor = { row: buf.baseY + buf.cursorY, col: buf.cursorX };
    });
    this.send(raw);
  };

  /* Ctrl-C：本地把行丢掉，换行由服务端给（它一回吐三个，normalizeLead 折成一个） */
  Session.prototype.leCtrlC = function () {
    this.line = '';
    this.cur = 0;
    this.nlMode = 'oneNL';
    this.nlUntil = Date.now() + NL_DROP_MS;
    this.send('\x03');
  };

  /* 记下输入行的行首坐标（提示符所在行、提示符起始列）。
     必须在 term.write 的回调里调用 —— xterm 的解析是异步的，写完之后
     buffer 里的光标位置才是新值。 */
  Session.prototype.captureAnchor = function () {
    var buf = this.term && this.term.buffer && this.term.buffer.active;
    if (!buf) { this.anchor = null; return; }
    var col = buf.cursorX - this.w(this.promptText);
    if (col < 0) col = 0;
    this.anchor = { row: buf.baseY + buf.cursorY, col: col };
  };

  /* 输入行复位（新提示符出现 / 进入密码提示时调用） */
  Session.prototype.resetLine = function () {
    this.line = '';
    this.cur = 0;
    this.captureAnchor();
  };

  /* 识别「备用屏幕」开关，用来判断前台是不是全屏程序。
     vim / top / less / htop / man 进入时会发 `\x1b[?1049h`，退出时发 `\x1b[?1049l`
     （老一点的程序用 1047 或 47）。这是它们**必然**发出的标准序列，
     比去猜程序行为可靠得多。

     为什么全屏程序要关掉本地回显：这类程序自己接管整个屏幕并自绘输入，
     前端再画一遍就会重复。退出全屏后自动恢复。 */
  Session.prototype.scanAltScreen = function (chunk) {
    if (!chunk) return;
    this.altBuf = ((this.altBuf || '') + chunk).slice(-24);
    var re = /\x1b\[\?(?:1049|1047|47)([hl])/g, m, last = null;
    while ((m = re.exec(this.altBuf)) !== null) last = m[1];
    if (last) this.altScreen = (last === 'h');
  };

  /* --------- 服务端开头的换行规范化 ---------

     实测（echo 已关）：
       回车   ⇒ "\e[?2004l\r\r\n" + 命令输出 + "\e[?2004h" + 提示符
       安装   ⇒ "\e[?2004l\r\r\n\e[?2004h" + 提示符（命令文本一个字都不回）
       Ctrl-C ⇒ "^C" + "\e[?2004l\r\r\n\e[?2004h\e[?2004l\r\r\n" + "\r\n" + "\e[?2004h" + 提示符
       Ctrl-D ⇒ "\e[?2004l\r\r\nexit\r\n"

     三种处理，取决于「前端自己画了什么」：
       dropNL   回车。前端已本地画了一个换行 ⇒ 服务端那截换行必须整个丢掉。
       oneNL    Ctrl-C。前端没画换行，服务端却一口气吐三个 ⇒ 折成正好一个。
       sameLine 安装命令。前端什么都没画，而屏幕上已经有一个提示符了；
                直接放行会多出一行空提示符（肉眼可见的痕迹），
                所以改写成「回车 + 清行 + 原样重画提示符」—— 原地覆盖，
                屏幕与安装前逐像素相同。

     只对「由 ^C / 转义序列 / CR / LF 构成的开头」动手：一碰到别的内容立刻
     收手 —— 那些自己输出的程序（cat / read -p 直接吐 "Name: " 或命令输出）
     不能被误伤。窗口很小（NL_DROP_MS），过期自动失效。

     批次可能被 PTY 从中间切断（前半截只有转义序列、换行还在下一批），
     所以「整批都是开头构成」时**保留**模式等下一批；只有确实撞上正文
     才把模式撤掉。 */
  Session.prototype.normalizeLead = function (bytes) {
    // sameLine 是「原地抹掉重画」语义（安装报告绑定 / 登录模式的静默命令）：
    // 它不是「丢掉一个换行」，而是「把服务端刚吐的那一行原地覆盖掉」。所以
    // 不能像 dropNL 那样一碰到正文就收手 —— 命令的回显文本就排在开头，
    // 只把**第一个换行**改写成「回车 + 清行」，那段回显会在同一次 term.write
    // 回调里被擦掉，用户看不到（换行还没到就先放行并保留模式）。
    if (this.nlMode === 'sameLine') return this.normalizeSameLine(bytes);

    var n = bytes.length, i = 0, sawCaretC = false, lfAt = -1;
    var keep = [];                                 // 开头要保留的字节（转义序列 / ^C）

    while (i < n) {
      var b = bytes[i];
      if (b === 0x1b) {
        var e = skipEscape(bytes, i, n);
        if (e <= i) return bytes;                  // 序列没收全，这一批原样放行
        for (var s = i; s < e; s++) keep.push(bytes[s]);
        i = e;
        continue;
      }
      if (b === 0x0d) { i++; continue; }
      if (b === 0x0a) { if (lfAt < 0) lfAt = i; i++; continue; }
      if (b === 0x5e && bytes[i + 1] === 0x43 && i === 0) {
        sawCaretC = true; keep.push(0x5e, 0x43); i += 2; continue;
      }
      break;                                       // 已经是正文了，收手
    }

    if (lfAt < 0) {
      // 一个换行都没见到。整批都是「开头构成」→ 换行可能还在下一批，保留模式；
      // 已经撞上正文 → 这次规范化没机会了，撤掉。
      if (i < n) { this.nlMode = ''; this.nlUntil = 0; }
      return bytes;
    }

    var mode = this.nlMode;
    this.nlMode = '';
    this.nlUntil = 0;

    var head = Uint8Array.from(keep);

    if (mode === 'oneNL') {
      var lead = sawCaretC ? new Uint8Array([0x5e, 0x43, 0x0d, 0x0a])
                           : new Uint8Array([0x0d, 0x0a]);
      return concatBytes(lead, bytes.subarray(i));
    }

    // dropNL：丢掉「第一个 LF 连同它前面的 CR」，其余（转义 / 正文）保留
    return concatBytes(head, bytes.subarray(lfAt + 1));
  };

  /* sameLine：把「服务端刚吐的那一行」原地抹掉。

     与 dropNL 的关键差别：这里**先扣住**开头的字节不发。原因是命令的回显
     文本（stty -echo / bind -x …）往往与后面的换行落在不同批次里 —— 直接
     放行就会让它闪一下再被擦掉。扣住之后：
       · 见到第一个换行 -> 用「回车 + 清行」替掉那一段，后面原样接上；
       · 迟迟见不到换行 -> 定时放出来（宁可闪一下，也不能把真实输出吞了）。 */
  Session.prototype.normalizeSameLine = function (bytes) {
    var buf = this.sameLineHold ? concatBytes(this.sameLineHold, bytes) : bytes;
    var n = buf.length, lfAt = -1;
    var lim = Math.min(n, SAME_LINE_SCAN);
    for (var i = 0; i < lim; i++) {
      if (buf[i] === 0x0a) { lfAt = i; break; }
    }
    if (lfAt < 0) {
      if (n > SAME_LINE_MAX) {                      // 太多了：原样放出去，立即放弃
        this.dropSameLine();
        return buf;
      }
      this.holdSameLine(buf);
      return EMPTY_BYTES;
    }
    this.dropSameLine();
    var from = lfAt;
    while (from > 0 && buf[from - 1] === 0x0d) from--;
    return concatBytes(SAME_LINE_HEAD, buf.subarray(lfAt + 1));
  };

  Session.prototype.dropSameLine = function () {
    this.nlMode = ''; this.nlUntil = 0;
    this.sameLineHold = null;
    if (this.sameLineTimer) { clearTimeout(this.sameLineTimer); this.sameLineTimer = null; }
  };

  /* 扣住字节，并起一个兜底定时器：超时就把它们原样补画出来 */
  Session.prototype.holdSameLine = function (bytes) {
    var self = this;
    this.sameLineHold = bytes;
    if (this.sameLineTimer) clearTimeout(this.sameLineTimer);
    this.sameLineTimer = setTimeout(function () {
      self.sameLineTimer = null;
      var held = self.sameLineHold;
      if (!held || !held.length) return;
      self.sameLineHold = null;
      self.nlMode = ''; self.nlUntil = 0;
      self.append(held);
    }, SAME_LINE_HOLD_MS);
  };

  /* 要求服务端把 tty 回显按住。
     login / su 这类登录程序会按自己的默认值重置 termios（把 ECHO 打开），
     一旦它开着，shell 就会把我们本地已经画过的字再回送一遍 —— 重复显示。
     走控制通道由包装进程 tcsetattr，不在会话里执行 stty，屏幕与历史都干净。 */
  Session.prototype.assertEchoOff = function () {
    if (!this.sid || !this.alive) return;
    if (this.altScreen || this.loginPhase || this.noEcho) return;
    var now = Date.now();
    if (now - this.echoSentAt < ECHO_GRACE_MS) return;
    this.echoSentAt = now;
    api('echo', { sid: this.sid, on: 0 }).catch(function () {});
  };

  /* 提示符 / 密码提示 / login 阶段的识别 —— 见 scanPrompt */

  /* --------- 核心：发送（命令或按键） ---------

     【铁律一】输入与输出**完全解耦**
       - exec 只负责「把按键送进 PTY」，它返回的 data **一律丢弃**；
       - 所有输出只由 read() 这一条串行通道读取并写入 xterm。

     为什么必须这样：
       exec 与轮询是并发的两个请求，若两者都携带 data delta，
       同一段字节会被 append 两次（ls → lsls），而且 offset 会被错误推进，
       导致字符被吞（只收到第一个字符）。串行化到单通道后此问题彻底消失。

     【铁律二】按键本身也必须串行
       每个按键单发一个 fetch 时，快速输入会同时飞出十几个请求。
       HTTP 不保证不同请求的到达顺序 —— 回车完全可能比最后一个字符先落地，
       shell 就先执行了「少一个字母」的命令。
       所以按键先进 pending 缓冲，**同一时刻只允许一个 exec 在途**，
       在途期间新到的按键自动并入下一次请求。顺序由此严格保证，
       顺带把输入法一次上屏的整词合并成一个请求。
     --------- */
  Session.prototype.send = function (data) {
    if (!data) return;
    if (!this.sid || !this.alive) return;
    this.pending += data;
    this.flushInput();
  };

  /* 把 pending 里的按键发出去；在途期间到达的输入会自动等下一轮 */
  Session.prototype.flushInput = function () {
    var self = this;
    if (this.sending) return;
    if (!this.pending) return;
    if (!this.sid || !this.alive) { this.pending = ''; return; }

    var chunk = this.pending;
    this.pending = '';
    this.sending = true;

    api('exec', { sid: this.sid, offset: this.offset, data: b64encode(chunk) })
      .then(function (d) {
        self.sending = false;
        // 只取会话存活状态，**不写 data**（避免与轮询重复）
        if (d && d.alive === false) {
          self.alive = false;
          self.pending = '';
          self.resetLine();
          self.renderTabs();
          self.setConn(false);
        }
        self.flushInput();   // 继续送在途期间攒下的按键
        self.kickPoll();     // 顺手唤醒读取（长轮询在途时是空操作）
      })
      .catch(function () {
        self.sending = false;
        // 发送失败：把这段放回队首稍后重试，绝不静默丢按键
        self.pending = chunk + self.pending;
        self.setConn(false);
        clearTimeout(self.execRetry);
        self.execRetry = setTimeout(function () { self.flushInput(); }, 500);
      });
  };

  /* --------- 输入法组合态判定 ---------
     composing            = 输入法正在组合（还没提交）
     composedAt 在 GRACE 内 = 刚刚提交完，xterm 的收尾还挂在 setTimeout(0) 上
     两种都按「组合未完成」处理，理由见 onEnterKey。 */
  Session.prototype.imePending = function () {
    if (this.composing) return true;
    return (Date.now() - this.composedAt) < IME_GRACE_MS;
  };

  /* --------- 回车遇到输入法组合 ---------

     为什么必须在这里拦（vendor/xterm.js 的 _keyDown + _finalizeComposition）：

       1) 回车（C0.CR）时 xterm 会先执行 `this.textarea.value = ""` 再发 \r；
       2) 而 compositionend 的收尾是放在 `setTimeout(0)` 里**稍后**才去读
          `textarea.value` 把组合文本发出去的。

       两者一赛跑，最后一个字就永远发不出去 —— 手机上「输入 whoami 按回车、
       实际执行的是 whoam」就是这么来的。更糟的一路是：若此时正处在
       _isSendingComposition，xterm 还会调用 _finalizeComposition(false)
       直接把待发文本**取消**掉。

     拦截方式：返回 false 让 xterm 完整跳过这次回车（不清 textarea、不取消待发文本）。
     IME 仍会正常提交组合，xterm 把那几个字发出来；我们在 ENTER_HOLD_MS 之后
     补一个 \r。顺序由 pending 队列保证 —— 不丢字，也不会重复。 */
  Session.prototype.onEnterKey = function () {
    var self = this;
    clearTimeout(this.enterTimer);
    this.enterTimer = setTimeout(function () {
      self.enterTimer = null;
      // 走正常的回车路径（本地画换行 + 开换行规范化窗口）；
      // 本地回显不可用时才退化成直接发送。
      if (self.canEdit() && self.sid && self.alive) self.leEnter('\r');
      else self.send('\r');
    }, ENTER_HOLD_MS);
  };

  /* --------- 核心：读取增量（唯一输出通道） ---------

     串行保证：同一时刻只允许一个 read 在途（this.reading 门闩），
     这样 offset 只会被单调推进，绝不会出现重叠区间。

     长轮询：请求带 wait，后端挂住直到有新输出或超时（见 sess_read_wait）。
     每次返回后立刻接上下一轮 —— 于是「总有一次 read 在途」，
     回显一产生就被带走，不用等定时器。这是输入跟手的关键。
     --------- */
  Session.prototype.read = function () {
    if (!this.sid || this.reading || !this.alive) return Promise.resolve();
    this.reading = true;
    var self = this;
    return api('read', { sid: this.sid, offset: this.offset, wait: READ_WAIT_MS })
      .then(function (d) {
        self.reading = false;
        self.handleDelta(d);
        self.chainRead();
      })
      .catch(function () {
        self.reading = false;
        self.setConn(false);
        // 出错退避，避免断网时把请求打爆；稍后由链或看门狗接回
        clearTimeout(self.readRetry);
        self.readRetry = setTimeout(function () { self.chainRead(); }, 1000);
      });
  };

  /* 长轮询链：只有「当前激活的、还活着的」会话才允许续接。
     后台标签页的会话靠 keepalive 续租，切回来时由 activate() 重新起链。 */
  Session.prototype.chainRead = function () {
    if (!this.alive || !this.sid) return;
    if (App.active !== this) return;
    this.read();
  };

  /* 立刻唤醒一次读取（不等长轮询链）
     注意：只触发一次 read，**不要**去调定时器链——那会让请求叠加。
     read 内部有 reading 门闩，与看门狗那条路径天然互斥。 */
  Session.prototype.kickPoll = function () {
    if (!this.reading) this.read();
  };

  Session.prototype.handleDelta = function (d) {
    if (!d) return;
    if (d.ok === false) {
      this.alive = false;
      this.resetLine();
      this.renderTabs();
      this.setConn(false);
      return;
    }
    // 后端刚做过「日志尾部保留」（out.log 超 5MB 被截断），offset 体系
    // 整体重置了 —— 这里的新 offset 必然小于本地已推进的值，乱序防护
    // （下面的 >= 检查）会把它当成回拨拒绝掉。所以见到 truncated 标志时
    // 先无条件采纳新 offset，再走正常的 append 路径。
    // 否则表现为：会话里 cat 一个大文件之后，终端再也不出任何输出。
    if (d.truncated) {
      this.offset = (typeof d.offset === 'number') ? d.offset : 0;
    }
    // 只有更新的 offset 才接受，防止乱序响应把 offset 往回拨造成重复读取
    if (typeof d.offset === 'number' && d.offset >= this.offset) {
      this.append(b64decodeToBytes(d.data));
      this.offset = d.offset;
    }
    this.alive = d.alive !== false;
    this.syncHint(d);
    this.setConn(this.alive);
    this.renderTabs();
    if (this.isActive()) updateStatus(this);
  };

  Session.prototype.syncHint = function (d) {
    if (d.cwd) this.cwd = d.cwd;
    if (typeof d.rc === 'string' && d.rc !== '') this.rc = d.rc;
    if (d.user) this.user = d.user;   // 后端回写优先（shell 模式）
    if (this.isActive()) updateStatus(this);
  };

  Session.prototype.isActive = function () { return App.active === this; };

  Session.prototype.setConn = function (on) {
    if (this.isActive()) {
      var dot = document.getElementById('stDot');
      dot.className = 'st-dot ' + (on ? 'on' : 'off');
      document.getElementById('stConn').textContent = on ? '已连接' : '已断开';
    }
  };

  Session.prototype.close = function () {
    if (!this.sid) return Promise.resolve();
    var sid = this.sid;
    this.sid = null;
    this.alive = false;
    if (this.reportTimer) { clearTimeout(this.reportTimer); this.reportTimer = null; }
    if (this.sameLineTimer) { clearTimeout(this.sameLineTimer); this.sameLineTimer = null; }
    this.sameLineHold = null;
    this.reporterReady = false;
    this.silenceAt = 0;
    this.probeBuf = '';
    this.resetLine();
    return api('close', { sid: sid }).catch(function () {});
  };

  Session.prototype.dispose = function () {
    try { this.term.dispose(); } catch (e) {}
    if (this.els.host && this.els.host.parentNode) {
      this.els.host.parentNode.removeChild(this.els.host);
    }
  };

  Session.prototype.renderTabs = function () { App.renderTabs(); };

  /* ---------------- 应用控制器 ---------------- */

  var App = {
    sessions: [],
    active: null,

    init: function () {
      var self = this;

      document.getElementById('titleHost').textContent = location.hostname || 'localhost';

      // 全局事件
      document.getElementById('btnNew').addEventListener('click', function () { self.newSession(); });
      document.getElementById('btnClear').addEventListener('click', function () {
        if (!self.active) return;
        // 走和 Ctrl-L 同一条路径：清屏之后必须把「提示符 + 当前行」画回来，
        // 否则 readline 的光标追踪（相对提示符）就和屏幕对不上了。
        if (self.active.canEdit()) self.active.leClearScreen();
        else self.active.term.clear();
      });
      document.getElementById('btnClose').addEventListener('click', function () {
        if (self.active) self.closeSession(self.active);
      });
      // 切换登录方式 → 直接开一个新会话（已建立的会话无法中途切换）
      document.getElementById('authMode').addEventListener('change', function () {
        var v = this.value;
        var label = (v === 'login') ? '账号登录' : '直接进入 Shell';
        if (!window.confirm('将新建一个「' + label + '」的终端会话，继续？')) {
          this.value = self.active ? self.active.mode : 'login';
          return;
        }
        self.newSession(null, v);
      });
      document.getElementById('sessionName').addEventListener('change', function () {
        if (self.active) {
          var v = this.value.trim() || 'shell';
          self.active.name = v;
          this.value = v;
          self.renderTabs();
          self.persist();
        }
      });

      // 点击终端区聚焦
      document.getElementById('screen').addEventListener('mousedown', function (e) {
        if (e.target.closest('.xterm')) return; // xterm 自己会处理选区
        if (self.active) self.active.term.focus();
      });

      window.addEventListener('resize', function () {
        if (self.active) self.active.fitNow();
      });

      // 恢复上次的会话（若后端会话已随机器重启失效，会自动新建）
      this.restore() || this.newSession();

      this.startPolling();
      this.startKeepalive();
      this.bindUnload();
    },

    /* ---------- 会话生命周期 ---------- */

    newSession: function (name, mode) {
      var self = this;
      if (mode === undefined) {
        mode = document.getElementById('authMode').value || 'login';
      }
      var s = new Session(name || ('shell' + (this.sessions.length + 1)), mode);
      s.mount();
      this.sessions.push(s);
      this.activate(s);
      this.showBoot(true, mode === 'login' ? '正在启动登录会话…' : '正在建立会话…');

      return s.create().then(function () {
        self.showBoot(false);
        s.show(true);
        s.fitNow();
        s.term.focus();
        self.persist();
      }).catch(function (err) {
        // 后端 fail() 的 error 文本已经描述清楚原因，这里不要再加「会话创建失败：」
        // 前缀，否则会出现「会话创建失败：会话创建失败：…」这样的重复。
        self.showBoot(true, (err.message || err) + '（点击重试）');
        var boot = document.getElementById('boot');
        boot.style.cursor = 'pointer';
        boot.onclick = function () {
          boot.onclick = null;
          boot.style.cursor = '';
          self.showBoot(false);
          self.activate(s);
          s.create().then(function () { self.showBoot(false); s.show(true); s.fitNow(); });
        };
      });
    },

    closeSession: function (s) {
      var idx = this.sessions.indexOf(s);
      if (idx < 0) return;
      var self = this;

      s.close().then(function () {
        s.dispose();
        self.sessions.splice(idx, 1);

        if (self.sessions.length === 0) {
          self.active = null;
          self.newSession();
          return;
        }
        // 切到相邻会话
        var next = self.sessions[Math.min(idx, self.sessions.length - 1)];
        self.activate(next);
        self.persist();
      });
    },

    activate: function (s) {
      if (this.active === s) return;
      if (this.active) this.active.show(false);
      this.active = s;
      this.sessions.forEach(function (x) { x.show(x === s); });
      document.getElementById('sessionName').value = s.name;
      var am = document.getElementById('authMode');
      if (am) am.value = s.mode || 'login';
      this.renderTabs();
      updateStatus(s);
      s.setConn(s.alive);
      s.fitNow();
      s.term.focus();
      // 切到这个会话后立刻接上长轮询链（原来那条链在 App.active 变化时会自行退出）
      s.kickPoll();
    },

    renderTabs: function () {
      var self = this;
      var box = document.getElementById('tabs');
      box.innerHTML = '';
      this.sessions.forEach(function (s) {
        var tab = document.createElement('div');
        tab.className = 'tab' +
          (s === self.active ? ' active' : '') +
          (s.alive ? '' : ' dead');

        var nm = document.createElement('span');
        nm.className = 'tab-name';
        nm.textContent = s.name;
        tab.appendChild(nm);

        var x = document.createElement('span');
        x.className = 'tab-x';
        x.textContent = '×';
        x.title = '关闭';
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          self.closeSession(s);
        });
        tab.appendChild(x);

        tab.addEventListener('click', function () { self.activate(s); });
        tab.addEventListener('dblclick', function () { self.rename(s); });
        box.appendChild(tab);
      });
    },

    rename: function (s) {
      var v = prompt('会话名', s.name);
      if (v === null) return;
      v = (v || '').trim() || 'shell';
      s.name = v;
      if (s === this.active) document.getElementById('sessionName').value = v;
      this.renderTabs();
      this.persist();
    },

    showBoot: function (on, text) {
      var boot = document.getElementById('boot');
      if (text) document.getElementById('bootText').textContent = text;
      boot.classList.toggle('hidden', !on);
    },

    /* ---------- 心跳续租 ----------
       每 5 秒告诉后端「这个页面还开着」。
       后端把心跳写进会话目录的 mtime；一旦页面消失（不论正常关闭还是崩溃），
       30 秒内后端就会把这个 owner 名下的 shell 连同 terminal-pty 进程一起收掉。

       注意这里**按 owner 续租**而不是按 sid：
       同一标签页可能开了多个会话，只有 active 那个会被轮询刷新心跳，
       后台标签页的会话就靠这个统一续租，否则开着两个会话时会误杀其中一个。
       ---------- */
    startKeepalive: function () {
      var self = this;
      function beat() {
        api('keepalive', { owner: OWNER }).catch(function () {});
        self.keepTimer = setTimeout(beat, KEEPALIVE_MS);
      }
      // 先做一次「页面回来」的补偿：从 bfcache 恢复时定时器可能被冻结过
      api('keepalive', { owner: OWNER }).catch(function () {});
      this.keepTimer = setTimeout(beat, KEEPALIVE_MS);
    },

    /* ---------- 页面关闭 -> 立刻回收会话 ----------
       两条路径，双保险：
         pagehide       现代浏览器（含 bfcache 场景）的标准事件
         beforeunload   老浏览器 / pagehide 不触发时的兜底
       用 sendBeacon 保证「页面已经开始卸载」时请求仍能发出去。

       三个必须区分清楚的状态：

         pagehide { persisted:true }  → 页面进了 bfcache（前进/后退导航）。
                                        页面只是「冻结」，用户随时可能按返回键
                                        回来，**绝不能销毁会话**，否则一按返回
                                        就变成死终端。只发心跳续租。
         pagehide { persisted:false } → 真正的卸载（关标签页 / 刷新 / 跳转）。
                                        发 shutdown 立即回收进程。
         visibilitychange -> hidden   → 切标签页、切后台、锁屏。
                                        同样不销毁，只续租，交给超时兜底。
       ---------- */
    bindUnload: function () {
      var closed = false;
      function bye() {
        if (closed) return;
        closed = true;
        apiBeacon('shutdown', { owner: OWNER });
      }

      // ------------------------------------------------------------------
      // pagehide 是**唯一**的「销毁」入口。
      //
      //   它是卸载流程中最后触发、且信息最完整的事件：
      //   只有它提供 persisted 标志，能区分「进 bfcache」和「真卸载」。
      //   其它事件都不够权威，一律只续租、不销毁 —— 宁可多留 30 秒让
      //   后端的孤儿回收来收，也不要在用户只是切走/导航时误杀 shell。
      // ------------------------------------------------------------------
      window.addEventListener('pagehide', function (e) {
        if (e && e.persisted) {
          // 进 bfcache：页面只是被冻结，用户随时可能按返回键回来。
          // 这里销毁会导致「返回后是个死终端」，所以只续租。
          apiBeacon('keepalive', { owner: OWNER });
          return;
        }
        bye();
      });

      // beforeunload **不销毁**，只续租：
      //   它在部分导航（如能进 bfcache 的跳转）里会先于 pagehide 触发，
      //   此时若直接 shutdown，就会出现「导航走又立刻返回 -> 会话已死」。
      //   它的价值在于：把「最后在场时间」刷新到最新，这样即使随后
      //   pagehide 因为浏览器限制没发出去，超时回收也是从此刻起算。
      window.addEventListener('beforeunload', function () {
        apiBeacon('keepalive', { owner: OWNER });
      });

      // 页面从 bfcache 回来：定时器可能已被冻结很久，先补一次心跳，
      // 避免回来的一瞬间正巧撞上后端的孤儿回收窗口。
      window.addEventListener('pageshow', function (e) {
        closed = false;
        api('keepalive', { owner: OWNER }).catch(function () {});
      });

      // 切到后台 / 其它标签页：只续租，不销毁。
      // 移动端切后台、锁屏都会触发 hidden，此时用户并没有关闭页面，
      // 直接杀会话会把 shell 状态（cd / 未提交的命令）丢掉。
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
          apiBeacon('keepalive', { owner: OWNER });
        }
      });
    },

    /* ---------- 轮询看门狗 ----------
       正常情况下 read() 自己首尾相接形成长轮询链，不需要任何定时器。
       这里只做兜底：
         · 链因为异常断掉（网络抖动、页面刚从 bfcache 回来）时重新接上；
         · 启动第一轮、以及切换会话后让新会话开始轮询。
       它不会造成请求叠加 —— read() 内部有 reading 门闩，
       而且这里只在「当前没有请求在途」时才发起。

       顺带定期重申「tty 回显要关着」：login / su 会把这一位重置，
       靠识别提示符时的即时压制之外再加一道定时兜底。
       ---------- */
    startPolling: function () {
      var self = this;
      setInterval(function () {
        var a = self.active;
        if (!a) return;
        if (a.sid && a.alive && !a.reading) a.read();
        if (a.sid && a.alive && (Date.now() - a.echoSentAt) > ECHO_ASSERT_MS) {
          a.assertEchoOff();
        }
        // 登录模式的静默命令迟迟等不到下一个提示符 -> 认定注入失败，退回服务端回显
        if (a.needSilence() && a.silenceAt &&
            (Date.now() - a.silenceAt) > SILENCE_MAX_MS) {
          a.fallBackToServerEcho();
        }
        // 报告绑定也会丢（换过 shell / 用户 reset 过终端）——顺手补装
        a.maybeInstallReporter();
      }, POLL_GUARD_MS);
    },

    /* ---------- 持久化 ---------- */
    persist: function () {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.sessions.map(function (s) {
          return { name: s.name, mode: s.mode };
        })));
      } catch (e) {}
    },

    restore: function () {
      var raw = null;
      try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
      if (!raw) return false;
      var list;
      try { list = JSON.parse(raw); } catch (e) { return false; }
      if (!list || !list.length) return false;
      // 只恢复「会话名 + 登录方式」，不恢复 sid —— CGI 端会话在重启/超时后已销毁，
      // 由 newSession 重新建立，避免出现指向野会话的死标签。
      // 多个历史会话**刻意不自动重建**（避免一次开一堆 shell），
      // 所以无论存了几个，这里只取第一个。
      var first = list[0];
      this.newSession(first.name, first.mode || 'login');
      return true;
    }
  };

  /* ---------------- 状态栏 ---------------- */
  function shortenCwd(p) {
    if (!p) return '~';
    // 常见家目录都折叠成 ~
    var homes = ['/root', '/home/' + (window.__loginUser || '')];
    for (var i = 0; i < homes.length; i++) {
      var h = homes[i];
      if (h && h !== '/home/' && p === h) return '~';
      if (h && h !== '/home/' && p.indexOf(h + '/') === 0) return '~' + p.slice(h.length);
    }
    var parts = p.split('/');
    if (parts.length > 4) return '…/' + parts.slice(-3).join('/');
    return p;
  }

  function updateStatus(s) {
    document.getElementById('stCwd').textContent = shortenCwd(s.cwd);

    // 身份：登录前显示「未登录」/「登录中: xxx」，登录成功后显示真实用户名
    var userEl = document.getElementById('stUser');
    var u = s.user || '';
    if (!u) {
      if (s.pendingUser && s.awaitingPassword) {
        userEl.textContent = s.pendingUser + '（验证中）';
        userEl.style.color = 'var(--yellow)';
      } else if (s.mode === 'login' && s.alive) {
        userEl.textContent = '未登录';
        userEl.style.color = 'var(--fg-dim)';
      } else {
        userEl.textContent = '-';
        userEl.style.color = 'var(--fg-dim)';
      }
    } else {
      userEl.textContent = u;
      userEl.style.color = (u === 'root') ? 'var(--red)' : 'var(--fg)';
    }

    var rc = document.getElementById('stRc');
    rc.textContent = s.rc === '' ? '-' : s.rc;
    rc.style.color = (s.rc && s.rc !== '0') ? 'var(--red)' : 'var(--fg)';
    document.getElementById('stSid').textContent = s.sid ? s.sid.slice(-8) : '-';

    var md = document.getElementById('stMode');
    if (md) {
      var label = (s.mode === 'login') ? '账号登录' : 'xterm';
      // 登录模式下「回显没能按住」时如实标出来，免得用户以为界面坏了
      if (s.serverEcho) label += '·服务端回显';
      md.textContent = label;
    }
  }

  /* ---------------- 启动 ---------------- */

  window.addEventListener('DOMContentLoaded', function () {
    if (!window.Terminal || !window.FitAddon) {
      startFallback();
      return;
    }
    App.init();
  });

  /* ==========================================================================
     降级终端：xterm.js 缺失时用原生 input 实现基本可用终端
     （仅处理纯文本，不带 ANSI 着色，但不影响执行命令）
     ========================================================================== */
  function startFallback() {
    document.getElementById('stMode').textContent = '简易';
    document.getElementById('xterm').style.display = 'none';
    document.getElementById('boot').classList.add('hidden');
    var fb = document.getElementById('fallback');
    fb.style.display = 'flex';

    var out = document.getElementById('fbOut');
    var input = document.getElementById('fbInput');
    var sid = null, offset = 0;

    function print(t) { out.textContent += t; out.scrollTop = out.scrollHeight; }

    /* base64 -> 原始字节 -> UTF-8 字符串
       atob() 只给出 latin1 字符串，中文会变乱码；
       必须经 Uint8Array 再用 TextDecoder 按 UTF-8 还原。 */
    function b64ToText(b64) {
      var bytes = b64decodeToBytes(b64);
      try {
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) {
        // 极老浏览器兜底
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
      }
    }

    // 去掉常见 ANSI 序列 + 处理回车覆盖行
    function clean(str) {
      return str
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // OSC
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')            // CSI
        .replace(/\x1b[()][A-Z0-9]/g, '')                  // charset
        .replace(/\x1b[=>]/g, '')                          // 其它
        .replace(/\x08+/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    }

    function post(action, payload) {
      return api(action, payload || {});
    }

    function pump(d) {
      if (d.data) print(clean(b64ToText(d.data)));
      if (typeof d.offset === 'number') offset = d.offset;
      if (d.cwd) document.getElementById('stCwd').textContent = shortenCwd(d.cwd);
      if (typeof d.rc === 'string' && d.rc !== '') {
        var rc = document.getElementById('stRc');
        rc.textContent = d.rc;
        rc.style.color = d.rc !== '0' ? 'var(--red)' : 'var(--fg)';
      }
      var alive = d.alive !== false;
      var dot = document.getElementById('stDot');
      dot.className = 'st-dot ' + (alive ? 'on' : 'off');
      document.getElementById('stConn').textContent = alive ? '已连接' : '已断开';
    }

    post('create', { mode: 'login', owner: OWNER }).then(function (d) {
      sid = d.sid; offset = d.offset || 0;
      pump(d);
      input.focus();

      // ------------------------------------------------------------------
      // 长轮询 + 单输出通道（与主路径同样的两条约定）
      //   · read 带 wait：后端挂住直到有新输出，回显不再等固定间隔；
      //   · 输出只由这一条 read 通道打印 —— exec 的响应不再打印，
      //     否则会和轮询撞车，同一段输出显示两遍。
      // ------------------------------------------------------------------
      var fbClosed = false, fbReading = false;

      function fbPoll() {
        if (!sid || fbClosed || fbReading) return;
        fbReading = true;
        post('read', { sid: sid, offset: offset, owner: OWNER, wait: 1500 })
          .then(function (x) { fbReading = false; pump(x); fbPoll(); })
          .catch(function () {
            fbReading = false;
            setTimeout(fbPoll, 1000);      // 出错退避后接回
          });
      }
      fbPoll();

      function fbBye() {
        if (fbClosed) return;
        fbClosed = true;
        apiBeacon('shutdown', { owner: OWNER });
      }
      // 与主路径同一套约定：只有 pagehide{persisted:false} 才销毁
      window.addEventListener('pagehide', function (e) {
        if (e && e.persisted) {
          apiBeacon('keepalive', { owner: OWNER });   // bfcache：页面还在
          return;
        }
        fbBye();
      });
      window.addEventListener('pageshow', function () {
        fbClosed = false;
        apiBeacon('keepalive', { owner: OWNER });
        fbPoll();
      });
      window.addEventListener('beforeunload', function () {
        apiBeacon('keepalive', { owner: OWNER });     // 只续租，不销毁
      });
    }).catch(function (e) {
      print('会话创建失败：' + e.message + '\n');
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var cmd = input.value;
        input.value = '';
        // 刻意**不**在这里本地打印这一行：输入框本身就是本地回显
        // （打字时直接可见），而 PTY 随后还会把这条命令原样回送过来 ——
        // 两边都打印就会出现「同一条命令显示两遍」。
        if (!sid) return;
        post('exec', { sid: sid, offset: offset, data: b64encode(cmd + '\n') })
          .then(function () { fbPoll(); })     // 输出交给 read 通道，避免重复打印
          .catch(function () {});
      }
    });
  }

  // 暴露给控制台排障
  window.__term = App;

})();
