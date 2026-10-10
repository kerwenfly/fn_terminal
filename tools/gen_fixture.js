/* 把 record_echo 录出来的 fix.json + 规格文件 fixture.txt 合成前端夹具 fixture.js。
   规格里每一条带引号的步骤 = 前端实际会发出去的一段字节；
   JSON 里第 1 条起与之逐条对应（第 0 条是启动时的初始提示符，供 create 用）。
   用法: node gen_fixture.js <spec.txt> <rec.json> <out_fixture.js> */
const fs = require('fs');

const specPath = process.argv[2];
const jsonPath = process.argv[3];
const outPath = process.argv[4];

/* 与 rec.go 的 parseSpec 保持同一套规则：
   跳过控制行（!on/!off/!win/!dir/!keep），剥掉「空格+#」的行尾注释，
   按未转义的收尾引号定位字符串。 */
function parseSpec(text) {
  const out = [];
  for (let raw of text.split(/\r?\n/)) {
    let ln = raw.trim();
    if (!ln) continue;
    if (ln[0] === '!') continue;              // 控制行
    if (ln[0] !== '"') continue;
    // 剥行尾注释：先找收尾引号
    let i = 1, end = -1;
    while (i < ln.length) {
      if (ln[i] === '\\') { i += 2; continue; }
      if (ln[i] === '"') { end = i; break; }
      i++;
    }
    if (end < 0) continue;
    let lit = ln.slice(0, end + 1);
    // 用 JSON 解析（JSON 转义是 Go 转义的子集；\x 不认，自己先转）
    out.push(unquoteGo(lit));
  }
  return out;
}

function unquoteGo(lit) {
  // lit 形如 "...."，含 Go 转义。转成字节串（latin1 语义）。
  const body = lit.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      // 普通字符：按 UTF-8 编码成字节
      const enc = Buffer.from(c, 'utf8');
      for (const b of enc) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n === 'x') {
      bytes.push(parseInt(body.substr(i + 1, 2), 16)); i += 2;
    } else if (n === 'n') bytes.push(0x0a);
    else if (n === 'r') bytes.push(0x0d);
    else if (n === 't') bytes.push(0x09);
    else if (n === 'a') bytes.push(0x07);
    else if (n === 'e') bytes.push(0x1b);
    else if (n === '\\') bytes.push(0x5c);
    else if (n === '"') bytes.push(0x22);
    else if (n === '0') bytes.push(0x00);
    else bytes.push(n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');   // 还原成 JS 字符串
}

const spec = parseSpec(fs.readFileSync(specPath, 'utf8'));
const rec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const steps = rec.slice(1);                     // 跳过第 0 条 (start)

if (steps.length !== spec.length) {
  console.error('步数不一致: 规格 ' + spec.length + ' 条，录制 ' + steps.length + ' 条');
  process.exit(2);
}

const items = spec.map((send, i) => [send, steps[i].out_b64 || '']);
const head = '/* 真实 bash（ECHO 已关）录制的字节流夹具 —— 由 tools/record_echo 生成，勿手改。\n' +
             '   每项是 [前端实际发出去的字节, 服务端回的字节(base64)]，顺序即真实顺序。 */\n';
fs.writeFileSync(outPath, head + 'window.FIXTURE = ' + JSON.stringify(items) + ';\n', 'utf8');

// 顺带打印关键项，便于人工核对
function dec(b64) {
  return Buffer.from(b64, 'base64').toString('latin1')
    .replace(/\x1b/g, '<ESC>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');
}
console.log('共 ' + items.length + ' 项 -> ' + outPath);
[0, 1, 2, items.length - 1].forEach((i) => {
  if (items[i]) console.log('  [' + i + '] ' + JSON.stringify(items[i][0]) + '  =>  ' + JSON.stringify(dec(items[i][1])));
});
