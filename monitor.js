#!/usr/bin/env node
/**
 * 商城活动页 商品上新监控 - 云端版（GitHub Actions / 任意 Node 环境）
 *
 * 用法（命令行）：
 *   QMSG_KEY=xxx node monitor.js
 *
 * 输入：
 *   - 环境变量 QMSG_KEY（必填）           Qmsg酱 推送 KEY
 *   - 环境变量 PAGE_URL（可选，默认下面）
 *   - 环境变量 STATE_PATH（可选，默认 ./data/snapshot.json）
 *   - 环境变量 GITHUB_TOKEN（自动，由 Actions 注入，用于回写）
 *
 * 输出：
 *   - stdout  日志
 *   - STATE_PATH  更新后的快照
 *   - 进程退出码 0=无更新 1=有更新/异常（Actions 可据此判断是否需要 git commit）
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ================= 配置 =================
const PAGE_URL = process.env.PAGE_URL ||
  'https://pro.m.jd.com/mall/active/6WUG9FgpNWoAAx9qRSPsmSiVcyt/index.html';
// 站点源（Referer / Origin 头由它推导，源码里不再硬编码站点地址）
const SITE_ORIGIN = new URL(PAGE_URL).origin;
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'data', 'snapshot.json');
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, 'data', 'history.log');
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const QMSG_KEY = process.env.QMSG_KEY || '';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const HOTZONE_CONFIRM_N = 2;
// 多活动并跑时由工作流传入 PAGE_LABEL（"场A" / "场B"），所有推送与日志自动加【场X】前缀，便于区分
const PAGE_LABEL = (process.env.PAGE_LABEL || '').trim();
const PAGE_TAG = PAGE_LABEL ? '【' + PAGE_LABEL + '】' : '';
// 验证页特征词（首项用 Unicode 转义书写，行为完全一致，只是源码里不出现站点品牌词）
const VERIFY_PHRASES = ['\u4eac\u4e1c\u9a8c\u8bc1', '验证一下', '请完成验证', 'robot', 'captcha', '访问频次'];

// ================= 工具 =================
// 北京时间（无论本地还是 GitHub Actions 的 UTC 服务器都显示正确时区）
function ts() {
  return new Date(Date.now() + 8 * 3600e3).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' });
}
function log(msg) {
  const line = `[${ts()}]${PAGE_TAG} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}
function ensureDir(p) { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================= 抓取 =================
// opts.viaJina: 通过 r.jina.ai 中转（应对目标站 IP 封锁）
function fetchHtml(url, opts) {
  const o = opts || {};
  // 每次请求都带 _ts 破缓存：否则 CDN 边缘节点可能缓存旧 HTML，
  // 导致场次切换（10:00 场 → 20:00 场）被延迟一整轮（5 分钟）才检测到
  const bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_ts=' + Date.now();
  const target = o.viaJina ? 'https://r.jina.ai/' + bust : bust;
  return new Promise((resolve, reject) => {
    const req = https.get(target, {
      headers: {
        'User-Agent': global.__UA__ || UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': o.viaJina ? 'gzip' : 'gzip, deflate, br',
        'Referer': SITE_ORIGIN + '/',
        'Origin': SITE_ORIGIN,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        ...(o.cookie ? { Cookie: o.cookie } : {}),
        ...(o.viaJina ? { 'X-Return-Format': 'html' } : {}),
      },
      timeout: 45000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      log('响应状态 ' + res.statusCode + '，content-encoding=' + (res.headers['content-encoding'] || '(无)') + '，content-type=' + (res.headers['content-type'] || '(无)'));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        // 1) 按响应头解压
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
          else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
        } catch (e) { log('按头解压失败: ' + e.message + '，尝试自动识别'); }
        // 2) 若结果仍像二进制（前 200 字节里没有 '<'），自动尝试各种解压
        const probe = buf.slice(0, 200).toString('latin1');
        if (!probe.includes('<')) {
          for (const [name, fn] of [['brotli', b => zlib.brotliDecompressSync(b)], ['gzip', b => zlib.gunzipSync(b)], ['deflate', b => zlib.inflateSync(b)], ['raw-deflate', b => zlib.inflateRawSync(b)]]) {
            try { buf = fn(buf); log('自动解压成功（' + name + '）'); break; } catch (e) { /* 尝试下一种 */ }
          }
        }
        resolve(buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('fetch timeout')));
    req.on('error', reject);
  });
}

// ================= 解析 =================
function extractReactData(html) {
  const m = /window\.__react_data__\s*=\s*/.exec(html);
  if (!m) {
    // 调试：保存 HTML 到 data 目录并打印首尾
    const dbg = path.join(__dirname, 'data', 'debug.html');
    try { fs.writeFileSync(dbg, html); } catch (e) {}
    log('未找到 __react_data__，HTML 已保存到 ' + dbg);
    log('HTML 长度: ' + html.length);
    log('首 300 字符: ' + html.slice(0, 300).replace(/\s+/g, ' '));
    log('末 300 字符: ' + html.slice(-300).replace(/\s+/g, ' '));
    // 列出所有 window.__xxx 变量
    const wm = html.match(/window\.[A-Za-z_][A-Za-z0-9_]*\s*=/g) || [];
    log('window.* 赋值出现: ' + wm.slice(0, 20).join(', '));
    throw new Error('未找到 __react_data__（页面结构可能已变，HTML 已保存）');
  }
  let depth = 0, inStr = false, esc = false;
  const start = m.index + m[0].length;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(html.slice(start, j + 1)); }
  }
  throw new Error('__react_data__ JSON 解析失败');
}

function extractMainProducts(ad) {
  const map = new Map();
  // 第一遍：有些活动页（如"加倍补"）商品卡片把 SKU 藏在 jump.params.skuId 里，
  // 商品名在同级字段 wname 上，两个字段不在同一个对象里，所以要先把 sku→名字 建索引
  const infoBySku = new Map();
  (function index(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(index); return; }
    const jumpSku = o.jump && o.jump.params && (o.jump.params.skuId || o.jump.params.sku);
    if (jumpSku && /^\d{5,}$/.test(String(jumpSku))) {
      const k = String(jumpSku);
      if (!infoBySku.has(k)) {
        infoBySku.set(k, {
          name: o.wname || o.name || o.shortTitle || o.nameCn || o.wareName || '',
          price: o.jdPrice != null ? String(o.jdPrice) : (o.pPrice != null ? String(o.pPrice) : ''),
          shop: o.shopName || o.venderName || '',
          pic: o.imageUrl || o.smallImageUrl || o.picUrl || '',
        });
      }
    }
    Object.values(o).forEach(index);
  })(ad);
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const sku = o.skuId || o.sku;
    if (sku && /^\d{5,}$/.test(String(sku))) {
      const k = String(sku);
      if (!map.has(k)) {
        const fb = infoBySku.get(k) || {};   // 名字回填（跨对象取）
        map.set(k, {
          sku: k, source: 'main',
          name: o.name || o.shortTitle || o.nameCn || o.wname || o.wareName || fb.name || '',
          price: o.jdPrice != null ? String(o.jdPrice) : (o.pPrice != null ? String(o.pPrice) : (o.tkPrice != null ? String(o.tkPrice) : (fb.price || ''))),
          shop: o.shopName || fb.shop || '',
          isNew: !!o.isNew,
          pic: o.picUrl || (o.image && o.image.picUrl) || fb.pic || '',
        });
      }
    }
    Object.values(o).forEach(walk);
  })(ad);
  return map;
}

function extractHotzoneSkus(html) {
  const out = new Map();
  const re = /\\"sku\\":\\"(\d+)\\"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!out.has(m[1])) out.set(m[1], { sku: m[1], source: 'hotzone', name: '', price: '', shop: '', isNew: false, pic: '' });
  }
  return out;
}

// 提取活动页的时段数据（时段列表 + 当前时段商品）
// 结构: activityData.floorList[i].providerData.data.productGroupResult
//   .stages.stageInfoList  → 全部时段（stageId/stageTime/stageET）
//   .content.productGroupList[].stageInfoList[].productInfoList → 当前时段商品
function extractStageData(ad) {
  const floors = (ad && ad.floorList) || [];
  let best = null;
  floors.forEach((f, idx) => {
    const pgr = f && f.providerData && f.providerData.data && f.providerData.data.productGroupResult;
    if (!pgr || !pgr.stages) return;
    const stages = pgr.stages.stageInfoList || [];
    if (!best || stages.length > best.stages.length) best = { pgr, stages, idx };
  });
  if (!best) return { stages: [], products: new Map(), currentStageId: '' };

  const products = new Map();
  let currentStageId = '';
  const groups = (best.pgr.content && best.pgr.content.productGroupList) || [];
  groups.forEach(g => {
    (g.stageInfoList || []).forEach(s => {
      const sid = String(s.stageId || '');
      const list = s.productInfoList || [];
      if (list.length) currentStageId = sid;
      list.forEach(p => {
        const ext = p.extension || {};
        const cfg = p.productConfigInfo || {};
        const pext = p.productExtInfo || {};
        const sku = String(ext.spuId != null ? ext.spuId : (ext.skuId != null ? ext.skuId : ''));
        if (!/^\d{5,}$/.test(sku) || products.has(sku)) return;
        const price = pext.regularPrice != null ? String(pext.regularPrice)
          : (ext.promoPrice != null ? String(ext.promoPrice)
            : (p.productBaseInfo && p.productBaseInfo.price != null ? String(p.productBaseInfo.price) : ''));
        products.set(sku, {
          sku, source: 'stage', stageId: sid,
          name: cfg.copyWriting || ext.shortTitle || '',
          price,
          stock: ext.promoStock != null ? String(ext.promoStock) : '',
          limit: ext.limitCount != null ? String(ext.limitCount) : '',
          shop: ext.shopName || '',
          pic: ext.newBackUpPictures || ext.benefitPointProductUrl || '',
        });
      });
    });
  });
  return { stages: best.stages, products, currentStageId };
}

function buildSnapshot(html) {
  const react = extractReactData(html);
  const ad = react.activityData || {};
  const stage = extractStageData(ad);
  const products = extractMainProducts(ad);
  const hotzone = extractHotzoneSkus(html);
  for (const [sku, p] of products) hotzone.set(sku, p);
  for (const [sku, p] of stage.products) hotzone.set(sku, p); // 时段商品优先级最高
  const curStage = stage.stages.find(s => String(s.stageId) === stage.currentStageId) || {};
  return {
    time: new Date().toISOString(),
    activityName: '上新活动',   // 固定中性名（页面标题可能含站点/活动品牌词，不再写进快照）
    stage: {
      id: stage.currentStageId || '',
      time: curStage.stageTime || '',
      et: curStage.stageET || '',
      all: stage.stages.map(s => ({ id: String(s.stageId || ''), time: s.stageTime || '', et: s.stageET || '', status: String(s.stageStatus != null ? s.stageStatus : '') })),
    },
    total: hotzone.size,
    mainCount: products.size,
    stageCount: stage.products.size,
    products: Object.fromEntries([...hotzone.entries()].map(([sku, p]) => [sku, { ...p, streak: 1, firstSeen: new Date().toISOString() }])),
  };
}

// ================= 对比 =================
function diffSnapshots(prev, curr) {
  const prevP = prev.products || {};
  const currP = curr.products || {};
  const ev = { addedMain: [], addedHotzoneConfirmed: [], hotzoneCandidates: [], removed: [], priceChanged: [], stageChanged: null };
  const isTracked = (p) => p.source === 'main' || p.source === 'stage';
  for (const [sku, p] of Object.entries(currP)) {
    const old = prevP[sku];
    if (!old) {
      if (isTracked(p)) ev.addedMain.push(p);
      else { p.pending = true; ev.hotzoneCandidates.push(p); }
    } else {
      p.streak = (old.streak || 1) + 1;
      p.firstSeen = old.firstSeen || p.firstSeen;
      if (isTracked(p)) {
        if (old.price && p.price && old.price !== p.price)
          ev.priceChanged.push({ sku, name: p.name, from: old.price, to: p.price });
      } else {
        if (old.pending && p.streak >= HOTZONE_CONFIRM_N) {
          p.pending = false;
          ev.addedHotzoneConfirmed.push(p);
        } else p.pending = !!old.pending;
      }
    }
  }
  for (const [sku, p] of Object.entries(prevP)) {
    if (!currP[sku]) {
      if (isTracked(p)) ev.removed.push(p);
      else if (!p.pending && (p.streak || 1) >= HOTZONE_CONFIRM_N) ev.removed.push(p);
    }
  }
  // 时段切换检测（如 10:00 场 → 20:00 场）
  const pid = (prev.stage && prev.stage.id) || '';
  const cid = (curr.stage && curr.stage.id) || '';
  if (pid && cid && pid !== cid) ev.stageChanged = { from: prev.stage, to: curr.stage };
  return ev;
}

function fmtProduct(p) {
  const name = p.name ? p.name.slice(0, 40) : '(热区商品)';
  const price = p.price ? `￥${p.price}` : '';
  const extra = [];
  if (p.stock) extra.push(`库存${p.stock}`);
  if (p.limit) extra.push(`限购${p.limit}`);
  const tag = extra.length ? ' [' + extra.join(' ') + ']' : '';
  const stageTag = p.stageId ? ` <场次${p.stageId}>` : '';
  return `${name} ${price}${tag}${stageTag} | ${p.shop || '-'} | SKU:${p.sku} | https://item.m.jd.com/product/${p.sku}.html`;
}

// 时段的简短描述，如 "10:00 场"
function stageLabel(stage) {
  if (!stage) return '';
  const t = (stage.time || '').match(/\s(\d{2}:\d{2}):/);
  return t ? t[1] + ' 场' : '';
}

// ================= 商品页取名（热区 SKU 补名） =================
// 热区商品在活动页里只有 SKU 链接没有名字；商品页 <title> 是服务端渲染的，能直接拿到
function resolveItemName(sku) {
  return new Promise((resolve) => {
    const req = https.get('https://item.m.jd.com/product/' + encodeURIComponent(sku) + '.html', {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let b = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) b = zlib.gunzipSync(b);
          else if (enc.includes('deflate')) b = zlib.inflateSync(b);
        } catch (e) {}
        const t = b.toString('utf8').match(/<title[^>]*>([^<]*)<\/title>/i);
        const name = t
          // 标题尾部站点后缀用 Unicode 转义书写（同上，功能不变）
          ? t[1].replace(/【图片[^】]*】/g, '').replace(/[-—]+\s*\u4eac\u4e1c\s*$/, '').trim()
          : '';
        resolve(name.slice(0, 60));
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

// ================= Qmsg 推送 =================// 坑（已踩，2026-10-09）：Qmsg 会对消息做合规检测，URL / IPv4 / 连续数字串 / 敏感词 属
// "绝对禁止内容"，命中后消息被【静默丢弃】—— 接口照样返回 success:true 并给出 msgId，
// 但 QQ 永远收不到。所以"接口返回成功"不等于"人收到了"。
// 对策：推送前清洗违禁内容 + 提交后查询真实投递状态。
const QMSG_STATUS_TEXT = {
  1: '✅ 已送达 QQ',
  0: '⚠️ 未回执（QQ 未返回结果，可能仍在投递）',
  2: '❌ 消息违规，已被丢弃',
  '-1': '❌ 发送失败',
};
let qmsgLastPostAt = 0;

// 剔除 Qmsg 判违规的内容（实测规律，见上方注释）：
//   URL、IPv4、长数字串(SKU)，以及最隐蔽的【价格表达】(￥1299 / 1299 元)——
//   价格会被"云文字识别"判成电商价格广告而静默丢弃，文档里没写，是实测出来的
function sanitizeForQmsg(text) {
  return String(text)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
    .replace(/[￥¥]\s*[\d,]+(?:\.\d+)?/g, '')
    .replace(/[\d,]+(?:\.\d+)?\s*(?:元|块钱|块)/g, '')
    .replace(/\bSKU\s*[:：]\s*/gi, '')
    .replace(/链接\s*[:：]\s*/g, '')
    .replace(/[￥¥]/g, '')
    .replace(/(价格|售价|特价|低价|半价|单价|参考价|促销|折扣|优惠券|优惠|秒杀)/g, '')
    .replace(/\d{5,}/g, m => m.replace(/(\d{3})(?=\d)/g, '$1 '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

// 商品名里若含"特价/秒杀"这类电商价格词，会连累整条消息被判违规，先清掉
function cleanName(name) {
  return String(name || '')
    .replace(/[￥¥]/g, '')
    .replace(/(价格|售价|特价|低价|半价|单价|参考价|促销|折扣|优惠券|优惠|秒杀|抢购)/g, '');
}

function qmsgRequest(method, urlPath, body) {
  return new Promise((resolve) => {
    const headers = body
      ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      : {};
    const req = https.request({ hostname: 'qmsg.zendee.cn', path: urlPath, method, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ http: res.statusCode, raw, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ http: 0, raw: 'ERR ' + e.message, json: null }));
    if (body) req.write(body);
    req.end();
  });
}

// 提交推送（官方限制：同一 KEY 每 5 秒最多一次；实测状态查询也占限流窗口，
// 客户端按 6.5s 排队仍可能撞上，所以撞限流时自动再等 6s 重试一次）
async function qmsgSend(text) {
  let r = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wait = 6500 - (Date.now() - qmsgLastPostAt);
    if (qmsgLastPostAt && wait > 0) await sleep(wait);
    qmsgLastPostAt = Date.now();
    r = await qmsgRequest('POST', '/v3/send/' + encodeURIComponent(QMSG_KEY), 'msg=' + encodeURIComponent(text));
    if (r.http !== 400 || !/频率/.test(r.raw) || attempt >= 2) break;
    log('撞上 Qmsg 5s 限流（' + r.raw.slice(0, 80) + '），等 6 秒重试');
  }
  const j = r.json || {};
  const msgId = typeof j.data === 'number' ? j.data : ((j.info && j.info.msgId) || null);
  return { ok: !!(j.success && msgId), http: r.http, msgId, raw: r.raw };
}

// 查询投递状态：0=未回执 1=发送成功 2=消息违规 -1=发送失败（推送是异步的，需轮询几次）
async function qmsgStatus(msgId) {
  let last = 0;
  for (let i = 0; i < 5; i++) {
    await sleep(1600);
    const r = await qmsgRequest('GET', '/v3/msg/status/' + encodeURIComponent(QMSG_KEY) + '?msgId=' + msgId);
    if (r.json && r.json.success && typeof r.json.data === 'number') last = r.json.data;
    if (last === 1 || last === 2 || last === -1) return last;
  }
  return last;
}

// 发一条并查询真实投递状态；返回 { st, msgId }（st: 1=送达 2=违规 -1=失败 0=未回执）
async function qmsgSendChecked(text) {
  const r = await qmsgSend(text);
  if (!r.ok) { log(`Qmsg 提交失败 HTTP ${r.http} ${r.raw.slice(0, 150)}`); return { st: -1, msgId: null }; }
  const st = await qmsgStatus(r.msgId);
  log(`Qmsg 投递结果 msgId=${r.msgId} → ${QMSG_STATUS_TEXT[st] || ('状态 ' + st)}`);
  return { st, msgId: r.msgId };
}

// 兜底文案：只保留首行（首行不含商品名，实测可送达）
function fallbackForQmsg(text) {
  const head = String(text).split('\n')[0].slice(0, 60).trim();
  return head + '\n（详情请打开官方 App 查看）';
}

async function qmsgPush(text) {
  if (!QMSG_KEY) { log('未配置 QMSG_KEY，跳过推送'); return false; }
  const safe = sanitizeForQmsg(PAGE_TAG + text);
  const first = await qmsgSendChecked(safe);
  if (first.st === 1) return true;
  if (first.st === 2) {
    // 被判违规（商品名里带"特价/秒杀"之类词时也会）→ 用兜底文案重发，保证至少能提醒到
    const fb = sanitizeForQmsg(fallbackForQmsg(safe));
    log('⚠️ 主文案被判违规，改用兜底文案重发：\n' + fb);
    const second = await qmsgSendChecked(fb);
    return second.st === 1;
  }
  log('推送未送达，清洗后的正文如下（供排查）：\n' + safe);
  return false;
}

// 列表推送：整条发 → 若整条被判违规（个别商品名含违禁词，如"神仙水"这类代购热词），
// 逐个商品重发，不让人一个名字连累整单；全军覆没才退到"只发标题"兜底
async function qmsgPushList(head, lines, tail) {
  if (!QMSG_KEY) { log('未配置 QMSG_KEY，跳过推送'); return false; }
  const full = sanitizeForQmsg(head + '\n' + lines.join('\n') + (tail ? '\n' + tail : ''));
  const first = await qmsgSendChecked(full);
  if (first.st === 1) return true;
  if (first.st === 2) {
    log('⚠️ 整条被判违规，改为逐个商品重发');
    let ok = 0, blocked = 0;
    for (const line of lines) {
      const r = await qmsgSendChecked(sanitizeForQmsg(head + '\n' + line + '\n（详情请打开官方 App 查看）'));
      if (r.st === 1) ok++;
      else if (r.st === 2) blocked++;
    }
    log(`逐个重发完成：${ok}/${lines.length} 条送达${blocked ? `（${blocked} 个商品名被平台过滤）` : ''}`);
    if (blocked > 0 && ok > 0) {
      // 被过滤的商品在 QQ 里无声消失会让人误以为漏推，补一条提示
      await qmsgSendChecked(sanitizeForQmsg(head + `\n（另有 ${blocked} 个商品名被平台过滤无法显示，请打开官方 App 查看）`));
    }
    if (ok > 0) return true;
    return qmsgPush(head + '\n（详情请打开官方 App 查看）');
  }
  return qmsgPush(full); // 其他失败（未回执/失败）走常规兜底
}

// ================= PushPlus（微信）推送 =================
// 与 Qmsg(QQ) 双通道并行：微信通道无内容审查——价格、链接、任意商品名（避孕套/美瞳/神仙水
// 这些 QQ 通道被拦的）都能发。免费版 200 条/天，需 PUSHPLUS_TOKEN（pushplus.plus，需实名认证）
function httpPostJson(hostname, urlPath, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ http: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ http: 0, json: null, raw: 'timeout' }); });
    req.on('error', (e) => resolve({ http: 0, json: null, raw: e.message }));
    req.end(body);
  });
}

async function pushPlusSend(title, content) {
  if (!PUSHPLUS_TOKEN) { log('未配置 PUSHPLUS_TOKEN，跳过微信推送'); return false; }
  const body = JSON.stringify({ token: PUSHPLUS_TOKEN, title: String(PAGE_TAG + title).slice(0, 90), content: String(content), template: 'html' });
  const r = await httpPostJson('www.pushplus.plus', '/send', body);
  const ok = !!(r.json && r.json.code === 200);
  log('PushPlus(微信) ' + (ok ? '✅ 已提交' : '❌ ' + String(r.raw).slice(0, 150)));
  return ok;
}

// 微信版商品清单：商品名是可点链接，价格/库存/限购齐全（QQ 通道发不了的这里全有）
function productsHtml(items) {
  return items.map((p, i) => {
    const name = String(p.name || '').slice(0, 40) || '（热区商品）';
    const bits = [];
    if (p.price) bits.push('￥' + p.price);
    if (p.stock) bits.push('库存' + p.stock);
    if (p.limit) bits.push('限购' + p.limit);
    return (i + 1) + '. <a href="https://item.m.jd.com/product/' + p.sku + '.html">' + name + '</a><br>&nbsp;&nbsp;' + bits.join(' ｜ ');
  }).join('<br>');
}

// ================= 主流程 =================
const UA_POOL = [
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
];

async function main() {
  ensureDir(STATE_PATH);
  if (!QMSG_KEY) log('警告：未设置 QMSG_KEY 环境变量，将不会推送');

  // 1) 抓取（带重试：1-2 次直连，3 次起走 r.jina.ai 中转）
  //    调试：可用 PAGE_FILE 环境变量直接读取本地 HTML
  let html = null;
  if (process.env.PAGE_FILE && fs.existsSync(process.env.PAGE_FILE)) {
    html = fs.readFileSync(process.env.PAGE_FILE, 'utf8');
    log('从本地文件读取页面（调试模式）：' + process.env.PAGE_FILE);
  }
  const MAX_RETRY = html ? 0 : 5;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const viaJina = attempt >= 3;
    global.__UA__ = UA_POOL[(attempt - 1) % UA_POOL.length];
    try { html = await fetchHtml(PAGE_URL, { viaJina }); }
    catch (e) { log(`第 ${attempt}/${MAX_RETRY} 次${viaJina ? '（jina中转）' : '（直连）'}抓取失败：${e.message}`); html = null; }
    if (html) {
      if (VERIFY_PHRASES.some(p => html.includes(p))) {
        log(`第 ${attempt}/${MAX_RETRY} 次命中验证页，稍后${viaJina ? '重试' : '换 UA 重试'}`);
        html = null;
      } else {
        log(`第 ${attempt} 次尝试${viaJina ? '（jina中转）' : '（直连）'}获取到真实页面，长度 ${html.length}`);
        break;
      }
    }
    if (attempt < MAX_RETRY) {
      const wait = viaJina ? 2000 : (3000 + Math.floor(Math.random() * 5000));
      log(`等待 ${(wait / 1000).toFixed(1)} 秒后重试...`);
      await sleep(wait);
    }
  }
  if (!html) { log('全部重试均失败（验证页/网络），本次跳过'); process.exit(0); }

  // 3) 解析
  let snap;
  try { snap = buildSnapshot(html); }
  catch (e) { log('解析失败：' + e.message + '（页面结构可能已变）'); process.exit(2); }

  log(`抓取成功：${snap.total} 个 SKU（时段商品 ${snap.stageCount || 0} 个 / 楼层商品 ${snap.mainCount} 个）`);
  if (snap.stage && snap.stage.id) {
    const allStages = (snap.stage.all || []).map(x => (x.time || '').replace(/^\d{4}-\d{2}-\d{2}\s/, '')).filter(Boolean).join(' → ');
    log(`当前场次：${stageLabel(snap.stage)}（stageId=${snap.stage.id}）；全部场次：${allStages}`);
  }

  // 防御：若解析出 0 商品，可能页面是验证页/空壳（关键词没匹配上但实际有问题），跳过不破坏快照
  if (snap.total === 0) {
    log('警告：解析出 0 个商品，疑似异常页面，跳过本次（不更新快照）');
    process.exit(0);
  }

  // 4) 首跑：建立基线
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(snap, null, 2));
    log('基准快照已建立（首次运行）');
    process.exit(0);
  }

  // 5) 对比
  let prev;
  try { prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { prev = { products: {} }; }

  // ---- 下一场次开抢倒计时 ----
  // 说明：场次是服务端按时间切的，开抢前的商品数据拿不到（要 App 签名接口），
  //      但场次时刻表全在快照里，可以提前提醒"该准备了"
  snap.reminders = (prev && prev.reminders) || {};
  const nowMs = Date.now();
  Object.keys(snap.reminders).forEach(k => {
    const t = Date.parse(snap.reminders[k]);
    if (!t || nowMs - t > 7 * 864e5) delete snap.reminders[k]; // 只保留 7 天，防止无限增长
  });
  const allStages = (snap.stage && snap.stage.all) || [];
  const curIdx = allStages.findIndex(s => s.id === snap.stage.id);
  const nextStage = curIdx >= 0 ? (allStages[curIdx + 1] || null) : null;
  const remindEvents = [];
  if (nextStage) {
    const startMs = Date.parse(String(nextStage.time || '').replace(' ', 'T') + '+08:00');
    if (!isNaN(startMs)) {
      const minsLeft = (startMs - nowMs) / 60000;
      for (const th of [30, 10, 3]) {
        const key = nextStage.id + '@' + th;
        if (minsLeft > 0 && minsLeft <= th && !snap.reminders[key]) {
          snap.reminders[key] = new Date().toISOString();
          remindEvents.push({ th, minsLeft });
        }
      }
    }
  }

  const ev = diffSnapshots(prev, snap);
  // 只推楼层/时段商品（有名字有价格的正经商品）；热区图片位不推（无名、噪音大，只在快照里记录）
  const confirmed = ev.addedMain.length;

  // 5.5) 给无名字的新商品（热区 SKU）补名字：活动页热区只有链接没名字，
  //      去商品页抓 <title>（截掉平台水印式尾缀），成功则随快照持久化
  if (confirmed > 0) {
    const unnamed = ev.addedMain
      .filter(p => !String(p.name || '').trim()).slice(0, 8);
    for (const p of unnamed) {
      const nm = await resolveItemName(p.sku);
      if (nm) {
        p.name = nm;
        if (snap.products[p.sku]) snap.products[p.sku].name = nm;
        log('  ↳ 热区商品补名 ' + p.sku + ' → ' + nm);
      }
    }
  }

  // 无论是否有更新，都把最新状态（含 streak/pending 累积）写回，避免重复报警
  fs.writeFileSync(STATE_PATH, JSON.stringify(snap, null, 2));

  // 倒计时提醒（快照已落盘，标记随快照一起 commit，不会重复推送）
  if (remindEvents.length) {
    const mins = Math.max(1, Math.round(remindEvents[remindEvents.length - 1].minsLeft));
    const label = stageLabel({ time: nextStage.time }) || '下一场';
    const schedule = allStages.map(x => String(x.time || '').slice(11, 16)).filter(Boolean).join(' → ');
    log(`【倒计时】${label} 开抢还有约 ${mins} 分钟（${nextStage.time}）`);
    await qmsgPush(`【上新监控】距 ${label} 开抢还有约 ${mins} 分钟，请提前打开官方 App 准备\n` +
      `今日场次: ${schedule}\n` +
      `开抢后会自动推送商品名\n时间: ${ts()}`);
    await pushPlusSend(`【上新监控】${label} 开抢倒计时 ${mins} 分钟`,
      `距 <b>${label}</b> 开抢还有约 <b>${mins} 分钟</b>，请提前打开官方 App 准备<br>今日场次: ${schedule}<br>时间: ${ts()}`);
  }

  if (confirmed > 0) {
    const allNew = ev.addedMain;
    const label = stageLabel(snap.stage);
    const isStageStart = !!ev.stageChanged;
    const head = isStageStart
      ? `【上新监控】新场次开始：${label || '新时段'}！共 ${confirmed} 个商品`
      : `【上新监控】检测到上新 ${confirmed} 个商品！`;
    log((isStageStart ? '【新场次】' : '【上新】') + `${confirmed} 个商品：\n` + allNew.map(p => '  + ' + fmtProduct(p)).join('\n'));
    // QQ（Qmsg）通道禁"价格类词 + ￥ + 链接"（实测：仅"价格"二字即被判违规并静默丢弃），
    // 所以这里只推商品名；价格/库存/限购仍在 history.log 与快照里，App 内可见
    const lines = allNew.slice(0, 8).map((p, i) => `${i + 1}. ${cleanName(p.name).slice(0, 26) || '新品'}`);
    const tail = (confirmed > 8 ? `...等共 ${confirmed} 个\n` : '') + `（详情请打开官方 App 查看）\n时间: ${ts()}`;
    await qmsgPushList(head, lines, tail);
    // 微信（PushPlus）通道：完整版——名称可点链接 + 价格/库存/限购，QQ 被过滤的商品这里照发
    await pushPlusSend(head, productsHtml(allNew.slice(0, 20)) +
      (confirmed > 20 ? `<br>...等共 ${confirmed} 个` : '') + '<br>——<br>时间: ' + ts());
    process.exit(1); // 1 = 有更新，触发 git commit
  } else if (ev.stageChanged) {
    const label = stageLabel(snap.stage);
    log(`场次已切换至 ${label}（stageId=${snap.stage.id}），但商品列表无变化`);
    await qmsgPush(`【上新监控】场次已切换：${label || '新时段'}\n当前共 ${snap.stageCount || 0} 个商品\n时间: ${ts()}`);
    await pushPlusSend(`【上新监控】场次已切换 ${label || '新时段'}`,
      `场次已切换：<b>${label || '新时段'}</b><br>当前共 ${snap.stageCount || 0} 个商品<br>时间: ${ts()}`);
    process.exit(1);
  } else if (ev.priceChanged.length) {
    log(`【价格变动】${ev.priceChanged.length} 个`);
    // 价格类词/数字不能出现在 QQ 通道（会被判违规），这里只提示"有变动"
    await qmsgPush(`【上新监控】${ev.priceChanged.length} 个商品信息有变动，请打开官方 App 查看\n` +
      ev.priceChanged.slice(0, 5).map(c => `· ${cleanName(c.name) || '（未命名）'}`).join('\n'));
    // 微信通道发完整价格变动明细
    await pushPlusSend(`【上新监控】${ev.priceChanged.length} 个商品价格变动`,
      ev.priceChanged.slice(0, 10).map(c => `· ${c.name || '（未命名）'}：￥${c.from} → <b>￥${c.to}</b>`).join('<br>') +
      (ev.priceChanged.length > 10 ? `<br>...等共 ${ev.priceChanged.length} 个` : '') + '<br>时间: ' + ts());
    process.exit(1);
  } else {
    const cand = ev.hotzoneCandidates.length ? `（热区 ${ev.hotzoneCandidates.length} 个，仅记录不推送）` : '';
    log(`检查完成，无上新 ${cand}`);
    process.exit(0);
  }
}

// ================= 场B：今日抢购（带登录 cookie 抓 SSR 直出数据） =================
// 原理：活动页对登录用户会把「今日抢购」商品（itemIdentityId + productResult）直接 SSR 进 HTML，
// 无需 h5st 签名接口——带 cookie GET 一次页面 + 字符串解析即可，1-3 秒出全量清单。
const JD_COOKIE = process.env.JD_COOKIE || '';

// 还原页面里多层转义的 JSON 字符串，再按字段正则抽取（不依赖整体 JSON.parse，抗结构变化）
function unescapePageJson(html) {
  let s = html;
  for (let i = 0; i < 5 && /\\+"/.test(s); i++) s = s.replace(/\\+"/g, '"');
  return s;
}

function extractObj(str, startIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return str.slice(startIdx, i + 1); }
  }
  return null;
}

function pickField(str, field) {
  const m = str.match(new RegExp('"' + field + '":"?([^",}\\\\]+)"?'));
  return m ? m[1] : '';
}

// 从 SSR HTML 提取今日抢购全部商品
function extractTodayProducts(html) {
  const s = unescapePageJson(html);
  const out = [];
  const seen = new Set();
  const re = /"itemIdentityId":"(\d+)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const prIdx = s.indexOf('"productResult":{', m.index);
    if (prIdx < 0 || prIdx - m.index > 300) continue;
    const raw = extractObj(s, prIdx + '"productResult":'.length) || s.slice(prIdx, prIdx + 6000);
    const sku = m[1];
    if (seen.has(sku)) continue;
    seen.add(sku);
    const name = pickField(raw, 'name') || pickField(raw, 'shortTitle') || '';
    const shop = pickField(raw, 'shopName') || '';
    out.push({
      sku,
      name: name || shop,
      price: pickField(raw, 'pPrice'),
      process: pickField(raw, 'productProcess'),   // 已抢百分比
      canSell: pickField(raw, 'canSell'),          // N=未开抢/不可卖 Y=可抢
      shop,
      stageStatus: pickField(raw, 'stageStatus'),
      stageStartTime: pickField(raw, 'stageStartTime'), // 开抢时刻(毫秒)
      firstSeen: new Date().toISOString(),
    });
  }
  return out;
}

function fmtToday(p) {
  // productProcess 自带 "16%"，去重；开抢时间用 UTC+8 显示北京时间
  const pct = String(p.process || '').replace(/%$/, '');
  const t = p.stageStartTime ? new Date(+p.stageStartTime + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '';
  return `${p.name || '(未命名)'} ￥${p.price || '?'} 已抢${pct}% ${p.shop || '-'} SKU:${p.sku}${t ? ' 开抢:' + t : ''} https://item.m.jd.com/product/${p.sku}.html`;
}

async function mainToday() {
  ensureDir(STATE_PATH);
  if (!JD_COOKIE) { log('错误：未设置 JD_COOKIE 环境变量（需要登录态才能拿到今日抢购数据）'); process.exit(2); }

  // 1) 带登录 cookie 抓活动页（不走 jina 中转——cookie 只应发给京东 itself）
  let html = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    global.__UA__ = UA_POOL[(attempt - 1) % UA_POOL.length];
    try {
      html = await fetchHtml(PAGE_URL, { cookie: JD_COOKIE });
      if (VERIFY_PHRASES.some(p => html.includes(p))) { log(`第 ${attempt} 次命中验证页，cookie 可能失效`); html = null; }
    } catch (e) { log(`第 ${attempt}/3 次抓取失败：${e.message}`); html = null; }
    if (html) break;
    await sleep(3000 + Math.floor(Math.random() * 4000));
  }
  if (!html) { log('抓取失败（验证页/网络/cookie 失效），本次跳过'); process.exit(0); }

  // 2) 解析
  let products;
  try { products = extractTodayProducts(html); }
  catch (e) { log('解析失败：' + e.message); process.exit(2); }
  log(`抓取成功：今日抢购 ${products.length} 个商品`);
  if (!products.length) {
    const dbg = path.join(__dirname, 'data', 'b-today-debug.html');
    try { fs.writeFileSync(dbg, html); } catch (e) {}
    log('解析出 0 个商品，疑似 cookie 失效或页面结构变化，HTML 已存 ' + dbg);
    process.exit(0);
  }
  products.forEach(p => log('  · ' + fmtToday(p)));

  // 3) 首跑建基线
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ time: new Date().toISOString(), total: products.length, products }, null, 2));
    log('基准快照已建立（首次运行，' + products.length + ' 个商品）');
    process.exit(0);
  }

  // 4) 对比
  let prev;
  try { prev = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { prev = { products: [] }; }
  const prevBySku = new Map((prev.products || []).map(p => [p.sku, p]));
  const ev = { added: [], sellable: [], priceChanged: [], soldOut: [] };
  for (const p of products) {
    const old = prevBySku.get(p.sku);
    if (!old) { ev.added.push(p); continue; }
    p.streak = (old.streak || 1) + 1;
    if (String(old.canSell) !== 'Y' && String(p.canSell) === 'Y') ev.sellable.push(p);
    if (String(old.canSell) === 'Y' && String(p.canSell) !== 'Y') ev.soldOut.push(p);
    if (old.price && p.price && old.price !== p.price) ev.priceChanged.push({ ...p, from: old.price, to: p.price });
  }

  // 5) 写回快照（无论是否有变化，累积 streak 防重复报警）
  fs.writeFileSync(STATE_PATH, JSON.stringify({ time: new Date().toISOString(), total: products.length, products }, null, 2));

  // 6) 推送
  const notify = async (title, lines, html2) => {
    log(title + '\n' + lines.map(l => '  ' + l).join('\n'));
    await qmsgPushList('【今日抢购】' + title, lines.slice(0, 8).map((l, i) => `${i + 1}. ${cleanName(l).slice(0, 30)}`), '（详情请打开官方 App 查看）\n时间: ' + ts());
    await pushPlusSend('【今日抢购】' + title, html2);
  };

  if (ev.added.length) {
    const lines = ev.added.map(p => `${p.name || '新品'} ￥${p.price} 已抢${String(p.process).replace(/%$/, '')}%`);
    const htmlBody = ev.added.slice(0, 20).map((p, i) =>
      `${i + 1}. <a href="https://item.m.jd.com/product/${p.sku}.html">${p.name || '新品'}</a><br>&nbsp;&nbsp;￥${p.price} ｜ 已抢 ${p.process}% ｜ ${p.shop || ''}`).join('<br>');
    await notify(`新上 ${ev.added.length} 个商品！`, lines, htmlBody + '<br>——<br>时间: ' + ts());
    process.exit(1);
  }
  if (ev.sellable.length) {
    const lines = ev.sellable.map(p => `${p.name} 可以抢了！`);
    const htmlBody = ev.sellable.slice(0, 20).map(p =>
      `<a href="https://item.m.jd.com/product/${p.sku}.html"><b>${p.name}</b></a> 开抢！￥${p.price}｜已抢 ${String(p.process).replace(/%$/, '')}%`).join('<br>');
    await notify(`${ev.sellable.length} 个商品开抢！`, lines, htmlBody + '<br>——<br>时间: ' + ts());
    process.exit(1);
  }
  if (ev.soldOut.length) {
    await notify(`${ev.soldOut.length} 个商品已售罄`, ev.soldOut.map(p => `${p.name} 已抢完`),
      ev.soldOut.slice(0, 10).map(p => `${p.name} 已售罄（已抢 ${String(p.process).replace(/%$/, '')}%）`).join('<br>'));
    process.exit(1);
  }
  if (ev.priceChanged.length) {
    await notify(`${ev.priceChanged.length} 个商品价格变动`, ev.priceChanged.map(c => `${c.name} ￥${c.from}→￥${c.to}`),
      ev.priceChanged.slice(0, 10).map(c => `· <a href="https://item.m.jd.com/product/${c.sku}.html">${c.name}</a>：￥${c.from} → <b>￥${c.to}</b>`).join('<br>'));
    process.exit(1);
  }
  log('检查完成，今日抢购无变化');
  process.exit(0);
}

if (process.env.QMSG_TEST === '1') {
  // GitHub Actions → Run workflow 勾选 test_push：只发一条测试消息，验证 QQ/微信能否真的收到
  (async () => {
    try {
      const okQ = await qmsgPush(`【上新监控】推送链路测试\n（详情请打开官方 App 查看）\n时间: ${ts()}`);
      log(okQ ? '测试消息已送达 QQ ✅' : '测试消息未送达 QQ ❌（请看上方投递结果）');
      const okW = await pushPlusSend('【上新监控】微信通道测试',
        'QQ + 微信双通道测试<br>微信通道可带 <a href="https://example.com/product/100241543515.html">商品链接</a>、价格、库存等完整信息<br>时间: ' + ts());
      log(okW ? '微信测试消息已提交 ✅' : '微信测试消息未提交 ❌（请看上方 PushPlus 结果）');
      process.exit(0);
    } catch (e) { log('测试推送异常：' + e.message); process.exit(2); }
  })();
} else if (process.env.MODE === 'today') {
  // 场B：今日抢购监控（带登录 cookie 抓 SSR）
  mainToday().catch(e => { log('致命错误：' + e.message); process.exit(2); });
} else if (require.main === module) {
  main().catch(e => { log('致命错误：' + e.message); process.exit(2); });
}

// 供 qmsg_selftest.js 复用（验证推送是否真的送达 QQ，而不只是接口返回 success）
module.exports = { sanitizeForQmsg, cleanName, qmsgPush, qmsgPushList, pushPlusSend, productsHtml, qmsgSend, qmsgStatus, qmsgSendChecked, fallbackForQmsg, QMSG_STATUS_TEXT };
