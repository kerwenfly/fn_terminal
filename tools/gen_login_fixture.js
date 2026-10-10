/* 生成「登录模式」的录制规格 + 前端夹具。
 *
 *   node gen_login_fixture.js spec    -> 写 tools/record_echo/login.txt
 *   node gen_login_fixture.js build   -> 由 login.json 合成 fixture_login.js
 *
 * 为什么要有这一套：登录模式的核心事实是「/bin/login 会把 tty 回显重新打开，
 * readline 在第一次 prep 时把 1 锁存下来」，直连 shell 模式碰不到这个分支。
 * 录制规格里用 !keep 保留原生回显，正好复现登录模式下的 tty 状态；
 * 后面每一步的发送内容都与前端真正会发出去的字节逐字一致。
 *
 * login 前缀（login: / Password: / motd）是**纯文本输出**，与 shell 行为无关，
 * 这里按真实 login 的样子直接写进夹具（它只被两条正则用到），不参与任何模拟。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseSpec, goQuote } = require('./spec_util.js');

const ROOT = path.join(__dirname, '..');
const SPEC_PATH = path.join(__dirname, 'record_echo', 'login.txt');
const JSON_PATH = path.join(__dirname, 'record_echo', 'login.json');
const OUT_PATH = path.join(__dirname, 'replay_test', 'fixture_login.js');

// 与 app/www/app.js 保持一致（下面会做一次校验，防止两边改岔）
const SILENCE_CMD = 'stty -echo 2>/dev/null; history -d $((HISTCMD-1)) 2>/dev/null';
const REPORTER_CMD =
  "bind -x '\"\\C-x\\C-r\": printf \"\\033]777;%s;%s\\007\" " +
  "\"$READLINE_LINE\" \"$READLINE_POINT\"';history -d $((HISTCMD-1)) 2>/dev/null";

const REPORTER_KEY = '\x18\x12';

/* 前端真正会发出去的字节序列（顺序即真实顺序） */
const STEPS = [
  ['', 1500],                        // 等 bash 起来
  [SILENCE_CMD, 400],                // ① 前端第一次注入静默命令
  ['\r', 700],
  [SILENCE_CMD, 400],                // ② 判定用的第二次注入
  ['\r', 700],
  [REPORTER_CMD, 400],               // ③ 安装报告绑定（此时回显已关，应当完全看不见）
  ['\r', 250],
  [REPORTER_KEY, 800],               // ④ 紧跟的报告键：确认绑定可用
  ['echo hi', 300],                  // ⑤ 打字：服务端应当一个字都不回
  ['\r', 700],
  ['cd /tm', 300],                   // ⑥ Tab 补全 + 交棒
  ['\t', 500],
  [REPORTER_KEY, 700],
  ['\r', 700],
  ['echo zz', 300],                  // ⑦ 退格：本地画，服务端静默
  ['\x7f', 300],
  ['\r', 700],
  ['echo ok', 300],                  // ⑧ 方向键只动光标，最后用 Ctrl-C 丢弃这一行
  ['\x1b[D', 200],
  ['\x1b[D', 200],
  ['\x1b[C', 200],
  ['\x03', 700],
];

/* login 阶段（合成，见文件头说明）：[前端发送, 服务端回的字节] */
const PRELUDE = [
  ['(start)', '\r\nFnNas login: '],
  ['r', 'r'], ['o', 'o'], ['o', 'o'], ['t', 't'],   // 用户名：内核逐字回显
  ['\r', '\r\nPassword: '],
  ['s', ''], ['3', ''], ['c', ''], ['r', ''], ['e', ''], ['t', ''],
  ['\r', '\r\nLast login: Wed Oct  7 21:12:03 2026 from 192.168.1.5\r\n' +
         '\r\nWelcome to fnOS (Debian GNU/Linux 12)\r\n\r\n'],
];

function buildSpec() {
  const lines = [
    '# 登录模式录制规格（由 tools/gen_login_fixture.js 生成，勿手改）',
    '# !keep = 保留 tty 原生回显 —— 复现 /bin/login 之后的 tty 状态',
    '!keep',
    '!dir /root',
    '!win 80 24 0',
  ];
  for (const [s, ms] of STEPS) lines.push(goQuote(s) + ' ' + ms);
  return lines.join('\n') + '\n';
}

/* 从 app.js 里把常量**求值**出来核对（字符串字面量带转义，纯文本比对会对不上）。
   找语句结尾时不能直接用 indexOf(';') —— 命令串里本来就有分号。 */
function extractConst(src, name) {
  const key = 'var ' + name + ' =';
  const at = src.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length, quote = '', end = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === ';') { end = i; break; }
  }
  if (end < 0) return null;
  const expr = src.slice(at + key.length, end);
  try { return eval(expr); } catch (e) { return null; }   // eslint-disable-line no-eval
}

function checkAgainstApp() {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'www', 'app.js'), 'utf8');
  const problems = [];
  if (extractConst(src, 'SILENCE_CMD') !== SILENCE_CMD) problems.push('SILENCE_CMD 与 app.js 不一致');
  if (extractConst(src, 'REPORTER_CMD') !== REPORTER_CMD) problems.push('REPORTER_CMD 与 app.js 不一致');
  if (extractConst(src, 'REPORTER_KEY') !== REPORTER_KEY) problems.push('REPORTER_KEY 与 app.js 不一致');
  return problems;
}

function main() {
  const mode = process.argv[2] || 'spec';
  const problems = checkAgainstApp();
  if (problems.length) {
    console.error('✗ ' + problems.join('；'));
    process.exit(3);
  }

  if (mode === 'spec') {
    fs.writeFileSync(SPEC_PATH, buildSpec(), 'utf8');
    console.log('规格已写入 ' + SPEC_PATH + '（' + STEPS.length + ' 步）');
    return;
  }

  const spec = parseSpec(fs.readFileSync(SPEC_PATH, 'utf8'));
  const rec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  // 第 0 条是 bash 的初始输出；其余只取「真正写进去的字节」那几条，
  // 把 !win / !keep 这类控制行对应记录剔掉，才能与规格逐条对齐。
  const steps = rec.slice(1).filter((r) => String(r.send).indexOf('!send') === 0);
  if (steps.length !== spec.length) {
    console.error('步数不一致: 规格 ' + spec.length + ' 条，录制 ' + steps.length + ' 条');
    process.exit(2);
  }

  // login 前缀 + 录制的 bash 初始输出（提示符）拼在 motd 之后。
  // 注意：夹具里 response 一律是 **base64**（与录制结果同一格式），
  // 所以这里全程按字节拼，最后再编码。
  const prelude = PRELUDE.map((x) => [x[0], Buffer.from(x[1], 'latin1')]);
  const startBytes = Buffer.from(rec[0].out_b64 || '', 'base64');
  const last = prelude[prelude.length - 1];
  last[1] = Buffer.concat([last[1], startBytes]);

  const items = prelude.map((x) => [x[0], x[1].toString('base64')])
    .concat(spec.map((send, i) => [send, steps[i].out_b64 || '']));
  const head =
    '/* 登录模式（ECHO 打开）录制的字节流夹具 —— 由 tools/gen_login_fixture.js 生成，勿手改。\n' +
    '   前 ' + prelude.length + ' 项是 login 阶段（login: / Password: / motd，纯文本输出），\n' +
    '   其后是真实 bash（!keep 保留回显）录下来的字节。\n' +
    '   第 0 项的 response（base64）就是 create 的初始数据。 */\n' +
    'window.TESTCFG = {\n' +
    '  mode: "login",\n' +
    '  createData: ' + JSON.stringify(items[0][1]) + '\n' +
    '};\n' +
    'window.FIXTURE = ' + JSON.stringify(items.slice(1)) + ';\n';
  fs.writeFileSync(OUT_PATH, head, 'utf8');

  function dec(b64) {
    return Buffer.from(b64, 'base64').toString('latin1')
      .replace(/\x1b/g, '<ESC>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');
  }
  console.log('共 ' + (items.length - 1) + ' 项 -> ' + OUT_PATH);
  [1, 5, 12, 15, 16, 17, 19, 22, 24, 26, 30, 33].forEach((i) => {
    if (items[i]) {
      console.log('  [' + i + '] ' + JSON.stringify(items[i][0]) + '  =>  ' +
                  JSON.stringify(dec(items[i][1])).slice(0, 150));
    }
  });
}

main();
