#!/usr/bin/env node
/**
 * 加倍补「今日抢购」浏览器通道
 *
 * 为什么需要它：该活动的商品清单不在 SSR 的 __react_data__ 里，而是页面加载后
 * 由 JS 调用 api.m.jd.com/client.action?functionId=queryBabelFeeds 拉取，
 * 且请求带 h5st 签名（时效 + 设备绑定，无法离线复刻）。
 *
 * 做法：无头 Chrome 打开页面 → 滚动到底触发分页 → 截获接口响应 → 合并商品 → 写 JSON。
 * 列表按会话个性化返回（每次会话给的子集不同），所以多开几个会话取并集。
 *
 * 用法：node feed-browser.js
 * 环境变量：
 *   ACTIVITY_ID   活动 ID（默认超级加倍补）
 *   FEED_FILE     输出路径（默认 ./data/feed-latest.json）
 *   SESSIONS      会话数（默认 2，越多覆盖越全但越慢）
 *   MAX_SCROLL    每个会话最大滚动轮数（默认 30）
 *   INCLUDE_TOMORROW  设为 1 才抓「明日预告」
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ACTIVITY = process.env.ACTIVITY_ID || 'USFY4Q1KPsHd54cN8AVUPHZdHpT';
// 带上 App 分享链接里的参数：不加这些参数拿到的可能是另一套 feed 流（少十几个商品）
const PAGE_URL = `https://pro.m.jd.com/mall/active/${ACTIVITY}/index.html`
  + '?babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1';
const OUT = process.env.FEED_FILE || path.join(__dirname, 'data', 'feed-latest.json');
const SESSIONS = Number(process.env.SESSIONS || 3);
const MAX_SCROLL = Number(process.env.MAX_SCROLL || 30);
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 jdapp;JDAndroid;14.0.0;';

function ts() {
  return new Date(Date.now() + 8 * 3600e3).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' });
}
function log(msg) { console.log(`[${ts()}] [browser] ${msg}`); }

const products = new Map();

function ingest(p, tab) {
  const pr = p.productResult || {};
  const pe = pr.productExtInfo || {};
  const sp = pe.skuPriceInfo || {};
  const st = pe.skuStockInfo || p.skuStockInfo || {};
  const sku = String(p.itemIdentityId || pr.skuId || '');
  if (!/^\d{5,}$/.test(sku)) return false;
  const price = sp.price != null && String(sp.price) !== '' ? String(sp.price)
    : (pr.pPrice != null ? String(pr.pPrice) : '');
  const jd = sp.jdPrice != null ? String(sp.jdPrice) : (pr.jdPrice != null ? String(pr.jdPrice) : '');
  const rate = st.soldRate != null ? String(st.soldRate) : (pr.productProcess != null ? String(pr.productProcess) : '');
  const item = {
    sku,
    tab,
    name: pr.name || pr.shortTitle || '',
    price,
    orig: jd && jd !== price ? jd : '',
    process: rate && !/%$/.test(rate) ? rate + '%' : rate,
    shop: pr.shopName || '',
    canSell: pr.canSell || '',
    soldOut: st.soldOut === true ? 'Y' : '',
    remainNum: st.remainNum != null ? String(st.remainNum) : '',
    stageStartTime: pr.stageStartTime != null ? String(pr.stageStartTime) : '',
    firstSeen: new Date().toISOString(),
  };
  const old = products.get(sku);
  if (!old) { products.set(sku, item); return true; }
  products.set(sku, Object.assign({}, old, {
    price: item.price || old.price,
    orig: item.orig || old.orig,
    process: item.process || old.process,
    remainNum: item.remainNum || old.remainNum,
    canSell: item.canSell || old.canSell,
  }));
  return false;
}

async function runSession(browser, idx) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  let inflight = 0;
  let lastPageNum = 0;
  let tab = 'today';

  page.on('request', r => { if (r.url().includes('queryBabelFeeds')) inflight++; });
  page.on('requestfailed', r => { if (r.url().includes('queryBabelFeeds')) inflight = Math.max(0, inflight - 1); });
  // 诊断：记录页面调用的所有 api.m.jd.com 接口及其返回规模（DEBUG_API=1 时启用）
  const apiStats = {};
  if (process.env.DEBUG_API === '1') {
    page.on('response', async res => {
      const u = res.url();
      if (!u.includes('api.m.jd.com')) return;
      const fid = (u.match(/functionId=([A-Za-z0-9_]+)/) || [])[1] || 'unknown';
      try {
        const t = await res.text();
        let n = 0, extra = '';
        try {
          const j = JSON.parse(t);
          n = (j.floorList ? j.floorList.length : 0) + (j.goodsList ? j.goodsList.length : 0) + (j.wareInfoList ? Object.keys(j.wareInfoList).length : 0);
          if (j.floorList && j.floorList[0] && j.floorList[0].template) extra = 'template=' + j.floorList[0].template;
        } catch (e) { extra = '非JSON ' + t.slice(0, 30).replace(/\s+/g, ' '); }
        apiStats[fid] = apiStats[fid] || { calls: 0, items: 0 };
        apiStats[fid].calls++; apiStats[fid].items += n;
        if (n) log(`[API] ${fid} 返回 ${n} 项 ${extra}`);
      } catch (e) {}
    });
  }
  page.on('response', async res => {
    if (!res.url().includes('queryBabelFeeds')) return;
    let text = null;
    for (let attempt = 1; attempt <= 3 && text === null; attempt++) {
      try { text = await res.text(); } catch (e) {
        if (attempt === 3) log(`[会话${idx}] 响应体读取失败：${e.message.slice(0, 60)}`);
        else await page.waitForTimeout(400);
      }
    }
    try {
      if (!text) return;
      const j = JSON.parse(text);
      const floors = j.floorList || [];
      lastPageNum = Number(j.pageNum || lastPageNum);
      let added = 0;
      floors.forEach(f => (f.providerData || []).forEach(p => { if (ingest(p, tab)) added++; }));
      log(`[会话${idx}] pageNum=${j.pageNum} 楼层=${floors.length} 新增=${added} 累计=${products.size}`);
    } catch (e) {
      log(`[会话${idx}] 响应解析失败：${e.message.slice(0, 60)}`);
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  });

  // 等请求落地再滚，避免请求重叠导致服务端少返回
  async function settle(maxMs) {
    const until = Date.now() + maxMs;
    while (inflight > 0 && Date.now() < until) await page.waitForTimeout(500);
  }

  async function scrollLoad(tag) {
    let idle = 0, lastH = 0, sameH = 0;
    for (let i = 0; i < MAX_SCROLL; i++) {
      await settle(6000);
      const before = products.size;
      const st = await page.evaluate(() => {
        window.scrollBy(0, 450);
        return {
          y: window.scrollY,
          h: document.body.scrollHeight,
          bottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 40,
        };
      });
      await page.waitForTimeout(1800);
      await settle(8000);
      if (st.h === lastH) sameH++; else { sameH = 0; lastH = st.h; }
      if (products.size > before) idle = 0; else if (inflight === 0) idle++;
      if (i % 6 === 0) log(`[会话${idx}] ${tag} 进度：scrollY=${st.y} 高度=${st.h} 累计=${products.size} 页码=${lastPageNum}`);
      if (idle >= 8 && sameH >= 3) {
        log(`[会话${idx}] ${tag} 结束（底部=${st.bottom} scrollY=${st.y} 高度=${st.h} 页码=${lastPageNum}）`);
        break;
      }
    }
  }

  try {
    // 只加载一次，绝不中途重载（重载会打断正在读取的响应体，导致首屏 14 个丢失）
    const url = idx === 1 ? PAGE_URL : PAGE_URL + (PAGE_URL.includes('?') ? '&' : '?') + '_r=' + Date.now() + '_' + idx;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const baseCount = products.size;
    const waitUntil = Date.now() + 45000;
    while (products.size === baseCount && Date.now() < waitUntil) await page.waitForTimeout(1000);
    log(`[会话${idx}] 首屏完成：新增 ${products.size - baseCount} 个，累计 ${products.size} 个`);
    if (products.size === baseCount) {
      log(`[会话${idx}] 首屏无数据，跳过该会话`);
      await ctx.close().catch(() => {});
      return;
    }
    await scrollLoad('今日抢购');
    log(`[会话${idx}] 今日抢购完成，累计 ${products.size} 个`);

    if (process.env.INCLUDE_TOMORROW === '1') {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1200);
      const t = page.getByText('明日预告', { exact: false }).first();
      if (await t.count()) {
        await t.scrollIntoViewIfNeeded().catch(() => {});
        await t.click({ timeout: 5000, force: true }).catch(async (e) => {
          log(`[会话${idx}] 常规点击失败，改用 JS：` + e.message.slice(0, 50));
          await page.evaluate(() => {
            const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && (el.textContent || '').trim() === '明日预告');
            if (els[0]) els[0].click();
          }).catch(() => {});
        });
        tab = 'tomorrow';
        await page.waitForTimeout(4000);
        await scrollLoad('明日预告');
        log(`[会话${idx}] 明日预告完成，累计 ${products.size} 个`);
      }
    }
  } catch (e) {
    log(`[会话${idx}] 异常：${e.message}`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

(async () => {
  const started = Date.now();
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  for (let i = 1; i <= SESSIONS; i++) {
    if (i > 1) await new Promise(r => setTimeout(r, 2000));
    await runSession(browser, i);
  }
  await browser.close();

  const list = [...products.values()];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), total: list.length, products: list }, null, 2));
  log(`完成：${list.length} 个商品（${SESSIONS} 个会话并集），耗时 ${((Date.now() - started) / 1000).toFixed(1)}s → ${OUT}`);
  if (!list.length) {
    log('警告：未截获任何商品（页面可能被验证/接口未触发）');
    process.exit(1);
  }
})();
