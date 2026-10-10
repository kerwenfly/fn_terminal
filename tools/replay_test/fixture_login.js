/* 登录模式（ECHO 打开）录制的字节流夹具 —— 由 tools/gen_login_fixture.js 生成，勿手改。
   前 13 项是 login 阶段（login: / Password: / motd，纯文本输出），
   其后是真实 bash（!keep 保留回显）录下来的字节。
   第 0 项的 response（base64）就是 create 的初始数据。 */
window.TESTCFG = {
  mode: "login",
  createData: "DQpGbk5hcyBsb2dpbjog"
};
window.FIXTURE = [["r","cg=="],["o","bw=="],["o","bw=="],["t","dA=="],["\r","DQpQYXNzd29yZDog"],["s",""],["3",""],["c",""],["r",""],["e",""],["t",""],["\r","DQpMYXN0IGxvZ2luOiBXZWQgT2N0ICA3IDIxOjEyOjAzIDIwMjYgZnJvbSAxOTIuMTY4LjEuNQ0KDQpXZWxjb21lIHRvIGZuT1MgKERlYmlhbiBHTlUvTGludXggMTIpDQoNChtbPzIwMDRocm9vdEBuYXM6fiMg"],["",""],["stty -echo 2>/dev/null; history -d $((HISTCMD-1)) 2>/dev/null","c3R0eSAtZWNobyAyPi9kZXYvbnVsbDsgaGlzdG9yeSAtZCAkKChISVNUQ01ELTEpKSAyPi9kZXYvbnVsbA=="],["\r","DQobWz8yMDA0bA0bWz8yMDA0aHJvb3RAbmFzOn4jIA=="],["stty -echo 2>/dev/null; history -d $((HISTCMD-1)) 2>/dev/null",""],["\r","G1s/MjAwNGwNDQobWz8yMDA0aHJvb3RAbmFzOn4jIA=="],["bind -x '\"\\C-x\\C-r\": printf \"\\033]777;%s;%s\\007\" \"$READLINE_LINE\" \"$READLINE_POINT\"';history -d $((HISTCMD-1)) 2>/dev/null",""],["\r","G1s/MjAwNGwNDQobWz8yMDA0aHJvb3RAbmFzOn4jIA=="],["\u0018\u0012","DRtbSw0bXTc3Nzs7MAc="],["echo hi",""],["\r","G1s/MjAwNGwNDQpoaQ0KG1s/MjAwNGhyb290QG5hczp+IyA="],["cd /tm",""],["\t",""],["\u0018\u0012","DRtbSw0bXTc3NztjZCAvdG1wLzs4Bw=="],["\r","G1s/MjAwNGwNDQobWz8yMDA0aHJvb3RAbmFzOn4jIA=="],["echo zz",""],["",""],["\r","G1s/MjAwNGwNDQp6DQobWz8yMDA0aHJvb3RAbmFzOn4jIA=="],["echo ok",""],["\u001b[D",""],["\u001b[D",""],["\u001b[C",""],["\u0003","XkMbWz8yMDA0bA0NChtbPzIwMDRoG1s/MjAwNGwNDQoNChtbPzIwMDRocm9vdEBuYXM6fiMg"]];
