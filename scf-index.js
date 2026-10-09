/**
 * 腾讯云函数（SCF）入口 — 场B今日抢购监控
 *
 * 为什么需要它：GitHub Actions 是海外 IP，被京东风控只能拿到降级页；
 * 云函数是国内机房 IP，风控通过率高，能拿到全量数据。
 *
 * 流程（每次触发）：
 *   1. 从 GitHub 仓库拉取上次快照 → /tmp/snapshot.json
 *   2. spawn 子进程跑 monitor.js（MODE=today，零改动复用）
 *   3. 把 /tmp/snapshot.json 回写 GitHub 仓库（持久化）
 *
 * 需要的环境变量（SCF 控制台配置）：
 *   JD_COOKIE       京东登录 cookie（整串）
 *   QMSG_KEY        Qmsg 推送 KEY（可空）
 *   PUSHPLUS_TOKEN  PushPlus 微信 token（可空）
 *   GITHUB_TOKEN    GitHub Personal Access Token（需 repo 的 Contents 读写权限）
 *   GITHUB_REPO     仓库，格式：用户名/仓库名（如 evringSaki/monitor）
 *   GITHUB_PATH     快照在仓库里的路径（默认 data/b-today-snapshot.json）
 *   MIN_TODAY_PRODUCTS 降级页最小商品数阈值（默认 12）
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_PATH = process.env.GITHUB_PATH || 'data/b-today-snapshot.json';
const TMP_STATE = '/tmp/snapshot.json';

function ts() {
  return new Date(Date.now() + 8 * 3600e3).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' });
}

function ghRequest(method, urlPath, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'User-Agent': 'scf-monitor',
        'Accept': 'application/vnd.github+json',
        ...(GITHUB_TOKEN ? { 'Authorization': 'Bearer ' + GITHUB_TOKEN } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// 从仓库读现有快照（含 sha，回写时要用）→ 落到 /tmp
async function downloadSnapshot() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return { sha: null, ok: false, reason: '未配置 GITHUB_TOKEN/GITHUB_REPO' };
  const r = await ghRequest('GET', `/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`);
  if (r.status === 200 && r.json && r.json.content) {
    const content = Buffer.from(r.json.content, 'base64').toString('utf8');
    fs.writeFileSync(TMP_STATE, content);
    return { sha: r.json.sha, ok: true };
  }
  if (r.status === 404) return { sha: null, ok: true, reason: '仓库暂无快照（首跑）' };
  return { sha: null, ok: false, reason: `GitHub 读取失败 HTTP ${r.status}` };
}

// 把 /tmp 快照回写仓库
async function uploadSnapshot(sha) {
  if (!fs.existsSync(TMP_STATE)) return '跳过（本次未生成快照）';
  if (!GITHUB_TOKEN || !GITHUB_REPO) return '跳过（未配置 GITHUB_TOKEN/GITHUB_REPO）';
  const content = fs.readFileSync(TMP_STATE, 'base64');
  const r = await ghRequest('PUT', `/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
    message: `chore: 云函数快照 ${ts()}`,
    content,
    ...(sha ? { sha } : {}),
  });
  if (r.status === 200 || r.status === 201) return '✅ 快照已回写 GitHub';
  return `❌ 回写失败 HTTP ${r.status} ${String(r.raw).slice(0, 120)}`;
}

exports.main_handler = async (event, context) => {
  const log = [];
  log.push(`[${ts()}] 云函数触发`);

  // 1) 校验配置
  if (!process.env.JD_COOKIE) return { summary: '未配置 JD_COOKIE 环境变量', log };
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return { summary: '未配置 GITHUB_TOKEN / GITHUB_REPO（快照需要持久化到仓库）', log };
  }

  // 2) 拉快照
  const dl = await downloadSnapshot();
  log.push(`拉取快照: ${dl.ok ? (dl.sha ? '已有基线' : dl.reason) : '❌ ' + dl.reason}`);
  if (!dl.ok) return { summary: '快照拉取失败，跳过本次', log };

  // 3) 跑监控（子进程复用 monitor.js）
  const env = { ...process.env, MODE: 'today', STATE_PATH: TMP_STATE, LOG_PATH: '/tmp/history.log' };
  const r = cp.spawnSync('node', [path.join(__dirname, 'monitor.js')], { env, encoding: 'utf8', timeout: 240000 });
  const out = (r.stdout || '') + (r.stderr || '');
  log.push(...out.trim().split('\n').slice(-14)); // 只带最后 14 行，避免日志超长
  const exitCode = r.status == null ? -1 : r.status;

  // 3.5) 页面样本回传：无论 monitor 结果如何，都把本次抓到的页面传到 GitHub（远程诊断用）
  const sampleLocal = path.join(__dirname, 'data', 'last-page.html');
  if (fs.existsSync(sampleLocal) && fs.statSync(sampleLocal).size > 1000) {
    const startedAt = context && context.time ? new Date(context.time).getTime() : 0;
    const isFresh = !startedAt || (fs.statSync(sampleLocal).mtime.getTime() > startedAt - 60000);
    if (isFresh) {
      const shaResp = await ghRequest('GET', `/repos/${GITHUB_REPO}/contents/data/last-page.html`);
      const up2 = await ghRequest('PUT', `/repos/${GITHUB_REPO}/contents/data/last-page.html`, {
        message: `debug: 云函数页面样本 ${ts()}`,
        content: fs.readFileSync(sampleLocal, 'base64'),
        ...(shaResp.json && shaResp.json.sha ? { sha: shaResp.json.sha } : {}),
      });
      log.push(`页面样本回传: ${up2.status === 200 || up2.status === 201 ? '✅ data/last-page.html' : '❌ HTTP ' + up2.status}`);
    }
  }

  // 4) 回写快照
  const up = await uploadSnapshot(dl.sha);
  log.push(`回写快照: ${up}`);

  const summary = out.match(/(新上|开抢|售罄|价格变动|无变化|基准快照|跳过|失败)/g);
  return {
    summary: summary ? summary.join(' / ') : `exit=${exitCode}`,
    exitCode,
    log,
  };
};
