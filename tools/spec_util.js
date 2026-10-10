/* record_echo 规格文件的解析工具（与 rec.go 的 parseSpec 保持同一套规则）。
   单独抽出来，给 gen_fixture.js / gen_login_fixture.js 共用。 */
'use strict';

/* 规格里每一条带引号的步骤 = 前端实际会发出去的一段字节。
   跳过控制行（!on/!off/!win/!dir/!keep/!cmd），剥掉「空格+#」的行尾注释，
   按未转义的收尾引号定位字符串。 */
function parseSpec(text) {
  const out = [];
  for (let raw of text.split(/\r?\n/)) {
    let ln = raw.trim();
    if (!ln) continue;
    if (ln[0] === '!') continue;              // 控制行
    if (ln[0] !== '"') continue;
    let i = 1, end = -1;
    while (i < ln.length) {
      if (ln[i] === '\\') { i += 2; continue; }
      if (ln[i] === '"') { end = i; break; }
      i++;
    }
    if (end < 0) continue;
    out.push(unquoteGo(ln.slice(0, end + 1)));
  }
  return out;
}

/* 把 Go 字符串字面量还原成 JS 字符串（字节按 UTF-8 还原） */
function unquoteGo(lit) {
  const body = lit.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      const enc = Buffer.from(c, 'utf8');
      for (const b of enc) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n === 'x') { bytes.push(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
    else if (n === 'n') bytes.push(0x0a);
    else if (n === 'r') bytes.push(0x0d);
    else if (n === 't') bytes.push(0x09);
    else if (n === 'a') bytes.push(0x07);
    else if (n === 'e') bytes.push(0x1b);
    else if (n === '\\') bytes.push(0x5c);
    else if (n === '"') bytes.push(0x22);
    else if (n === '0') bytes.push(0x00);
    else bytes.push(n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/* 反过来：把 JS 字符串写成 rec.go 能 unquote 出来的字面量 */
function goQuote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x07) out += '\\a';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + ('0' + c.toString(16)).slice(-2);
    else out += s[i];
  }
  return out + '"';
}

module.exports = { parseSpec, unquoteGo, goQuote };
