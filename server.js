#!/usr/bin/env node
/**
 * 场A上新监控 — 本地可视化面板服务
 * 双击 run-panel.bat 启动 → 浏览器自动打开 http://localhost:3210
 *
 * 接口：
 *   GET  /            面板页面
 *   GET  /api/snapshot 当前快照（data/snapshot.json）
 *   GET  /api/log      最近运行日志（data/history.log 尾部）
 *   POST /api/refresh  立即抓取并对比（调 monitor.js，返回输出+新快照）
 *   GET  /api/config   读取面板配置
 *   POST /api/config   保存面板配置（推送key等，存 config.json）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PORT = 3210;
const ROOT = __dirname;
const SNAP = path.join(ROOT, 'data', 'snapshot.json');
const LOGF = path.join(ROOT, 'data', 'history.log');
const CFGF = path.join(ROOT, 'data', 'panel-config.json');

let refreshing = false;
let lastRefreshOut = '';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function tailFile(p, n) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    return lines.slice(-n).join('\n');
  } catch (e) { return '(暂无日志)'; }
}

// 立即抓取：spawn monitor.js（场A），同步等待
function doRefresh() {
  if (refreshing) return { busy: true, out: lastRefreshOut };
  refreshing = true;
  const env = { ...process.env };
  const cfg = readJson(CFGF, {});
  // 推送配置（可选，面板里填）
  if (cfg.qmsgKey) env.QMSG_KEY = cfg.qmsgKey;
  if (cfg.pushplusToken) env.PUSHPLUS_TOKEN = cfg.pushplusToken;
  env.PAGE_URL = env.PAGE_URL || 'https://pro.m.jd.com/mall/active/6WUG9FgpNWoAAx9qRSPsmSiVcyt/index.html';
  env.STATE_PATH = path.join(ROOT, 'data', 'snapshot.json');
  env.LOG_PATH = LOGF;
  env.PAGE_LABEL = '场A';
  delete env.QMSG_TEST;
  delete env.MODE;
  const t0 = Date.now();
  try {
    const r = cp.spawnSync('node', [path.join(ROOT, 'monitor.js')], { env, encoding: 'utf8', timeout: 120000 });
    lastRefreshOut = `=== ${new Date().toLocaleString('zh-CN', { hour12: false })} 抓取完成（${((Date.now() - t0) / 1000).toFixed(1)}s，退出码 ${r.status}）===\n` + (r.stdout || '') + (r.stderr || '');
  } catch (e) {
    lastRefreshOut = '抓取异常: ' + e.message;
  }
  refreshing = false;
  return { busy: false, out: lastRefreshOut };
}

// 自动抓取：每 5 分钟一次（面板服务开着就自动监控，不依赖 GitHub schedule）
const AUTO_MS = Number(process.env.AUTO_MS || 5 * 60 * 1000);
setInterval(() => {
  if (refreshing) return;
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] 自动抓取开始`);
  doRefresh();
}, AUTO_MS);

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/refresh') {
    const r = doRefresh();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ...r, snapshot: readJson(SNAP, { total: 0, products: {} }) }));
  }

  if (req.method === 'POST' && url === '/api/config') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        fs.mkdirSync(path.dirname(CFGF), { recursive: true });
        fs.writeFileSync(CFGF, JSON.stringify(cfg, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end('{"ok":false}'); }
    });
    return;
  }

  if (url === '/api/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ snapshot: readJson(SNAP, { total: 0, products: {} }), log: tailFile(LOGF, 40), refreshing }));
  }
  if (url === '/api/log') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ log: tailFile(LOGF, 60), refreshing, lastRefreshOut }));
  }
  if (url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(readJson(CFGF, {})));
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'panel.html')));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`✅ 场A监控面板已启动: ${addr}  (Ctrl+C 停止)`);
  try { cp.exec(`start "" "${addr}"`); } catch (e) {}
});
