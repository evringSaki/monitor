#!/usr/bin/env node
/**
 * 场B今日抢购 — 实时版（无头浏览器）
 * 原理：本机 Edge 无头加载活动页，京东自己的 JS 会带着 h5st 签名调 qryH5BabelFloors
 *      （App 同款实时数据），我们拦截响应提取商品 → diff → 推 QQ+微信
 * 数据实时性 = App 内所见（已抢%、新上商品全部实时）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { qmsgPushList, pushPlusSend, cleanName } = require('./monitor.js');
// puppeteer-core 25.x 是纯 ESM，用动态 import 加载（兼容老 Node 的 require 环境）
let puppeteer;

// ================= 配置 =================
const PAGE_URL = process.env.PAGE_URL ||
  'https://pro.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html?babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1';
const JD_COOKIE = process.env.JD_COOKIE || '';
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'data', 'b-today-live-snapshot.json');
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, 'data', 'history-live.log');
const PAGE_LABEL = (process.env.PAGE_LABEL || '场B实时').trim();
const PAGE_TAG = '【' + PAGE_LABEL + '】';
const INTERVAL_SEC = Number(process.env.LIVE_INTERVAL || 45);
const MIN_PRODUCTS = Number(process.env.MIN_TODAY_PRODUCTS || 10);
const QMSG_KEY = process.env.QMSG_KEY || '';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

function ts() {
  return new Date(Date.now() + 8 * 3600e3).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' });
}
function log(msg) {
  const line = `[${ts()}]${PAGE_TAG} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================= 解析（与 SSR 版同源，输入改为接口响应文本） =================
function unescapeJson(s) {
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
function extractProducts(anyText) {
  const s = unescapeJson(anyText);
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
    out.push({
      sku,
      name: name || pickField(raw, 'shopName'),
      price: pickField(raw, 'pPrice'),
      process: pickField(raw, 'productProcess'),
      canSell: pickField(raw, 'canSell'),
      shop: pickField(raw, 'shopName'),
      stageStatus: pickField(raw, 'stageStatus'),
      stageStartTime: pickField(raw, 'stageStartTime'),
      firstSeen: new Date().toISOString(),
    });
  }
  return out;
}

// ================= Cookie 注入 =================
function parseCookies(cookieStr) {
  return String(cookieStr).split(';').map(p => p.trim()).filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return null;
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.jd.com', path: '/' };
  }).filter(Boolean);
}

// ================= 单轮抓取 =================
async function captureOnce(page) {
  const captured = [];
  const handler = async (res) => {
    try {
      const url = res.url() || '';
      if (res.status() === 200 && (/BabelFloors|babel/i.test(url)) && !/\.(js|css|png|jpg|gif|woff)/.test(url)) {
        const ct = (res.headers()['content-type'] || '');
        if (/json|text/.test(ct) || true) {
          const t = await res.text();
          if (t && t.includes('itemIdentityId')) captured.push(t);
        }
      }
    } catch (e) {}
  };
  page.on('response', handler);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    log('页面加载超时/失败：' + e.message.slice(0, 80));
  }
  await sleep(12000); // 等 hydration + 楼层接口返回
  page.off('response', handler);
  return captured;
}

// ================= 推送 =================
async function notify(title, lines, htmlBody) {
  log(title + '\n' + lines.map(l => '  ' + l).join('\n'));
  if (QMSG_KEY) {
    await qmsgPushList('【今日抢购】' + title, lines.slice(0, 8).map((l, i) => `${i + 1}. ${cleanName(l).slice(0, 30)}`), '（详情请打开官方 App 查看）\n时间: ' + ts());
  }
  if (PUSHPLUS_TOKEN) {
    await pushPlusSend('【今日抢购】' + title, htmlBody);
  }
}

// ================= 主循环 =================
(async () => {
  if (!JD_COOKIE) { log('错误：未设置 JD_COOKIE'); process.exit(2); }
  const exe = findBrowser();
  if (!exe) { log('错误：本机找不到 Chrome/Edge'); process.exit(2); }
  log('使用浏览器: ' + exe);
  puppeteer = (await import('puppeteer-core')).default;

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  const cookies = parseCookies(JD_COOKIE);
  try { await page.setCookie(...cookies); } catch (e) { log('cookie 注入异常: ' + e.message); }

  let baseline = null;
  if (fs.existsSync(STATE_PATH)) {
    try { baseline = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
  }

  let round = 0;
  while (true) {
    round++;
    try {
      const captured = await captureOnce(page);
      const merged = new Map();
      for (const txt of captured) for (const p of extractProducts(txt)) if (!merged.has(p.sku)) merged.set(p.sku, p);
      const products = [...merged.values()];

      if (!products.length) {
        log(`第 ${round} 轮：未拦截到商品数据（页面加载异常或被风控），下一轮重试`);
        await sleep(INTERVAL_SEC * 1000);
        continue;
      }
      log(`第 ${round} 轮：实时数据 ${products.length} 个商品`);

      // 降级防护
      if (products.length < MIN_PRODUCTS) {
        log(`仅 ${products.length} 个（< ${MIN_PRODUCTS}），疑似降级，跳过本轮`);
        await sleep(INTERVAL_SEC * 1000);
        continue;
      }

      // 首跑建基线
      if (!baseline || !baseline.products || !baseline.products.length) {
        baseline = { time: new Date().toISOString(), total: products.length, products };
        fs.writeFileSync(STATE_PATH, JSON.stringify(baseline, null, 2));
        log(`基准快照已建立（${products.length} 个商品）`);
        products.forEach(p => log('  · ' + (p.name || p.sku) + ' ￥' + p.price + ' 已抢' + p.process + ' ' + (p.canSell === 'Y' ? '[可抢]' : '')));
        await sleep(INTERVAL_SEC * 1000);
        continue;
      }

      // diff
      const prevBySku = new Map(baseline.products.map(p => [p.sku, p]));
      const ev = { added: [], sellable: [], soldOut: [], priceChanged: [] };
      for (const p of products) {
        const old = prevBySku.get(p.sku);
        if (!old) { ev.added.push(p); continue; }
        p.streak = (old.streak || 1) + 1;
        if (String(old.canSell) !== 'Y' && String(p.canSell) === 'Y') ev.sellable.push(p);
        if (String(old.canSell) === 'Y' && String(p.canSell) !== 'Y') ev.soldOut.push(p);
        if (old.price && p.price && old.price !== p.price) ev.priceChanged.push({ ...p, from: old.price, to: p.price });
      }
      const next = { time: new Date().toISOString(), total: products.length, products };
      fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));

      if (ev.added.length) {
        const lines = ev.added.map(p => `${p.name || '新品'} ￥${p.price} 已抢${String(p.process).replace(/%$/, '')}%`);
        const html = ev.added.slice(0, 20).map((p, i) =>
          `${i + 1}. <a href="https://item.m.jd.com/product/${p.sku}.html">${p.name || '新品'}</a><br>&nbsp;&nbsp;￥${p.price} ｜ 已抢 ${p.process} ｜ ${p.shop || ''}`).join('<br>');
        await notify(`🆕 新上 ${ev.added.length} 个商品！`, lines, html + '<br>——<br>时间: ' + ts());
      } else if (ev.sellable.length) {
        const lines = ev.sellable.map(p => `${p.name} 可以抢了！`);
        const html = ev.sellable.slice(0, 20).map(p =>
          `<a href="https://item.m.jd.com/product/${p.sku}.html"><b>${p.name}</b></a> 开抢！￥${p.price}｜已抢 ${p.process}`).join('<br>');
        await notify(`⚡ ${ev.sellable.length} 个商品开抢！`, lines, html + '<br>——<br>时间: ' + ts());
      } else if (ev.soldOut.length) {
        await notify(`${ev.soldOut.length} 个商品已售罄`, ev.soldOut.map(p => `${p.name} 已抢完`),
          ev.soldOut.slice(0, 10).map(p => `${p.name} 已售罄（已抢 ${p.process}）`).join('<br>'));
      } else if (ev.priceChanged.length) {
        await notify(`${ev.priceChanged.length} 个商品价格变动`,
          ev.priceChanged.map(c => `${c.name} ￥${c.from}→￥${c.to}`),
          ev.priceChanged.slice(0, 10).map(c => `· ${c.name}：￥${c.from} → <b>￥${c.to}</b>`).join('<br>'));
      } else {
        log('无变化');
      }

      baseline = next;
    } catch (e) {
      log('第 ' + round + ' 轮异常：' + e.message.slice(0, 120));
    }
    await sleep(INTERVAL_SEC * 1000);
  }
})().catch(e => { log('致命错误：' + e.message); process.exit(2); });
