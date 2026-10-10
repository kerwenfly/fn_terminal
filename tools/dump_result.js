#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * dump_result.js —— 跑无头浏览器测试页并抽出 <pre id="RESULT"> 的内容
 *
 * 背景：Edge 处于更新中间态时（Application 目录下同时出现两个版本号目录），
 * `msedge.exe --headless --dump-dom` 会静默退出、什么都不输出，导致
 * run_replay_test.sh / run_login_test.sh 报「没有拿到测试结果」。
 *
 * 所以这里的策略是双通道：
 *   1) 先按原方式试 Edge/Chrome 的 --dump-dom（快，无额外依赖）；
 *   2) 输出为空时回退到 playwright-core 的 Chromium
 *      （安装在托管工作区 ~/.workbuddy/binaries/node/workspace/node_modules，
 *       浏览器本体在 %LOCALAPPDATA%\ms-playwright；两者都没有才真的失败）。
 *
 * 用法： node tools/dump_result.js <C:/.../　__test.html>
 * 输出： RESULT 内容打到 stdout；拿不到时退出码 5。
 * ------------------------------------------------------------------------- */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('usage: node dump_result.js <page.html>');
  process.exit(2);
}
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

function entities(s) {
  return s
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* 通道 1：Edge / Chrome 的 --dump-dom（与 runner 原逻辑一致） */
function tryDumpDom() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    try {
      const out = execFileSync(c, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--window-size=900,600', '--virtual-time-budget=30000',
        '--dump-dom', fileUrl,
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
           stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/<pre id="RESULT"[^>]*>([\s\S]*?)<\/pre>/);
      if (m) {
        const text = entities(m[1]);
        if (text.trim()) return text;
      }
    } catch (e) { /* 下一个候选 */ }
  }
  return '';
}

/* 通道 2：playwright-core 的 Chromium */
async function tryPlaywright() {
  const roots = [];
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE,
      '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'));
  }
  roots.push(path.join(os.homedir(),
    '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules'));

  let pw = null;
  for (const r of roots) {
    try { pw = require(path.join(r, 'playwright-core')); break; } catch (e) {}
  }
  if (!pw) return '';

  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 900, height: 600 },
    });
    await page.goto(fileUrl, { timeout: 60000 });

    // 等测试页把结果写出来（结束时整页只留一块 <pre id="RESULT">）
    try {
      await page.waitForFunction(function () {
        var el = document.getElementById('RESULT');
        return !!(el && /通过\s*\/\s*\d+\s*失败/.test(el.textContent || ''));
      }, undefined, { timeout: 90000 });
    } catch (e) { /* 超时就拿当前内容，交给上层判定 */ }

    let text = '';
    const el = await page.$('#RESULT');
    if (el) text = await el.textContent();
    await browser.close();
    return text || '';
  } catch (e) {
    try { if (browser) await browser.close(); } catch (e2) {}
    return '';
  }
}

(async function main() {
  let result = tryDumpDom();
  if (!result) result = await tryPlaywright();
  if (!result || !result.trim()) {
    console.error('dump_result: 没有拿到测试结果（Edge 与 Playwright 都失败）');
    process.exit(5);
  }
  process.stdout.write(entities(result).trim() + '\n');
})();
