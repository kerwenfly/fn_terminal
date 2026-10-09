/* ==========================================================================
   终端应用前端
   --------------------------------------------------------------------------
   后端是「无状态 CGI + 持久 PTY」模型：
     - create  建会话，返回 offset
     - exec    送按键/命令，返回 offset 之后的新增输出
     - read    仅拉取 offset 之后的新增输出（轮询）
   因此前端只需维护 3 件事：sid、offset、Terminal 实例。
   输出是原始 PTY 字节流（含 ANSI），本地 base64 解码成 latin1 喂给 xterm。
   ========================================================================== */
(function () {
  'use strict';

  var API = '/cgi/ThirdParty/terminal/terminal.cgi';
  var POLL_MS = 400;          // 空闲轮询间隔
  var POLL_BUSY_MS = 120;     // 刚发过命令时更密集地追输出
  var TAIL_MS = 1800;         // 发命令后的紧跟窗口
  var KEEPALIVE_MS = 5000;    // 页面心跳间隔（后端容错 30 秒）

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
    // UTF-8 安全编码（命令里可能有中文路径）
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
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
    this.busyUntil = 0;
    this.reading = false;
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

    // 键盘输入 -> 后端
    this.term.onData(function (data) {
      self.send(data);
    });

    // Ctrl+L 由前端处理更跟手（清的是本地缓冲 + shell 重绘）
    this.term.attachCustomKeyEventHandler(function (e) {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'l') {
        self.term.clear();
        return true; // 仍然透传给 shell，让它重画提示符
      }
      return true;
    });

    // 尺寸变化 -> 通知 PTY（独立 resize 动作，不混进按键流）
    // 与 send 同理：resize 的响应里可能带 data，但一律不写 xterm，
    // 输出全部交给 read 单通道，避免重复。
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
    this.term.write(bytes);
    // 提示符识别只关心 ASCII（login: / Password: / user@host），
    // 用 latin1 视图足够，且不会影响上面写入的字节流。
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    this.scanPrompt(s);
  };

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
    var buf = this.scanBuf.replace(/\r/g, '');

    // 1) user@host:  —— 最可靠的来源
    var m = /([A-Za-z0-9_.-]{1,32})@[^\s:]{1,64}:[^\n]*[$#]\s*$/.exec(buf);
    if (m) { this.user = m[1]; return; }

    // 2) "xxx login: 输入中" —— 让状态栏提前显示目标账号
    var m2 = /login:\s*([A-Za-z0-9_.-]{1,32})\s*$/.exec(buf);
    if (m2) { this.pendingUser = m2[1]; return; }

    // 3) 成功登录后的 host:~$ 形式：无法从提示符区分用户，
    //    但能判断「已经从 login: 阶段走出来了」。
    if (/\bPassword:\s*$/m.test(buf)) { this.awaitingPassword = true; }
    if (/[^\s]+\s*:\s*[^\n]*[$#]\s*$/.test(buf) && this.awaitingPassword
        && this.pendingUser) {
      this.user = this.pendingUser;
      this.awaitingPassword = false;
    }
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
      self.append(b64decodeToBytes(d.data));
      self.syncHint(d);
      self.fitNow();
      return self;
    });
  };

  /* --------- 核心：发送（命令或按键） ---------

     关键设计（曾经出过 bug，务必保持）：
       输入与输出**完全解耦**。
         - exec 只负责「把按键送进 PTY」，它返回的 data **一律丢弃**；
         - 所有输出只由 pollOnce() 这一条串行通道读取并写入 xterm。

     为什么必须这样：
       exec 与 400ms 轮询是并发的两个请求，若两者都携带 data delta，
       同一段字节会被 append 两次（ls → lsls），而且 offset 会被错误推进，
       导致字符被吞（只收到第一个字符）。串行化到单通道后此问题彻底消失。
     --------- */
  Session.prototype.send = function (data) {
    if (!this.sid || !this.alive) return;
    var self = this;
    this.busyUntil = Date.now() + TAIL_MS;
    var payload = { sid: this.sid, offset: this.offset, data: b64encode(data) };
    api('exec', payload).then(function (d) {
      // 只取会话存活状态，**不写 data**（避免与轮询重复）
      if (d && d.alive === false) {
        self.alive = false;
        self.renderTabs();
        self.setConn(false);
      }
      // 立刻补拉一次，让回显尽快出现（走同一条串行通道）
      self.kickPoll();
    }).catch(function () {
      self.setConn(false);
    });
  };

  /* --------- 核心：读取增量（唯一输出通道） ---------
     串行保证：同一时刻只允许一个 read 在途（this.reading 门闩），
     这样 offset 只会被单调推进，绝不会出现重叠区间。
     --------- */
  Session.prototype.read = function () {
    if (!this.sid || this.reading) return Promise.resolve();
    this.reading = true;
    var self = this;
    return api('read', { sid: this.sid, offset: this.offset }).then(function (d) {
      self.reading = false;
      self.handleDelta(d);
    }).catch(function () {
      self.reading = false;
      self.setConn(false);
    });
  };

  /* 立刻唤醒一次读取（不等轮询定时器）
     注意：只触发一次 read，**不要**去调 tick()——那会重复布置定时器，
     多个 setTimeout 链并行后请求量翻倍。read 内部有 reading 门闩，
     与定时器那条路径天然互斥。 */
  Session.prototype.kickPoll = function () {
    this.read();
  };

  Session.prototype.handleDelta = function (d) {
    if (!d) return;
    if (d.ok === false) {
      this.alive = false;
      this.renderTabs();
      this.setConn(false);
      return;
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
    pollTimer: null,

    init: function () {
      var self = this;

      document.getElementById('titleHost').textContent = location.hostname || 'localhost';

      // 全局事件
      document.getElementById('btnNew').addEventListener('click', function () { self.newSession(); });
      document.getElementById('btnClear').addEventListener('click', function () {
        if (self.active) self.active.term.clear();
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

    /* ---------- 轮询 ----------
       每个会话各自一条循环，独立读自己的 offset。
       之前只轮询 active 会话，切标签后后台会话输出会积压；
       更重要的是「kickPoll + 定时器」两条路径会并发调用 read，
       现在 read 内部有 reading 门闩兜底，两者不会互相踩。
       ---------- */
    startPolling: function () {
      var self = this;
      function tick() {
        var a = self.active;
        if (a && a.sid) {
          a.read();
          var busy = Date.now() < a.busyUntil;
          self.pollTimer = setTimeout(tick, busy ? POLL_BUSY_MS : POLL_MS);
        } else {
          self.pollTimer = setTimeout(tick, POLL_MS);
        }
      }
      tick();
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
      var self = this;
      list.forEach(function (item, i) {
        if (i === 0) {
          self.newSession(item.name, item.mode || 'login');
        }
        // 多个历史会话不自动重建，避免一次开一堆 shell
      });
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
    if (md) md.textContent = (s.mode === 'login') ? '账号登录' : 'xterm';
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

      // 降级模式下同样遵守「关页面即收进程」的约定
      var fbAlive = setInterval(function () {
        if (!sid) return;
        post('read', { sid: sid, offset: offset, owner: OWNER }).then(pump).catch(function () {});
      }, 700);

      var fbClosed = false;
      function fbBye() {
        if (fbClosed) return;
        fbClosed = true;
        clearInterval(fbAlive);
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
        print(cmd + '\n');
        if (!sid) return;
        post('exec', { sid: sid, offset: offset, data: b64encode(cmd + '\n') })
          .then(function (d) { pump(d); print(clean(atob(d.data || ''))); })
          .catch(function () {});
      }
    });
  }

  // 暴露给控制台排障
  window.__term = App;

})();
