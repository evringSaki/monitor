#!/usr/bin/env node
/**
 * 加倍补「今日抢购」浏览器通道
 *
 * 为什么需要它：该活动的商品清单不在 SSR 的 __react_data__ 里，而是页面加载后
 * 由 JS 调用 api.m.jd.com/client.action?functionId=queryBabelFeeds 拉取，
 * 且请求带 h5st 签名（时效 + 设备绑定，无法离线复刻）。
 *
 * 做法：无头 Chrome 打开页面 → 自动滚动触发分页 → 截获接口响应 → 合并商品 → 写 JSON。
 * 后续对比/推送复用 monitor.js（MODE=today, FEED_FILE=本文件输出）。
 *
 * 用法：node feed-browser.js [输出路径]
 * 环境变量：
 *   ACTIVITY_ID   活动 ID（默认加倍补）
 *   FEED_FILE     输出路径（默认 ./data/feed-latest.json）
 *   MAX_SCROLL    最大滚动次数（默认 12）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ACTIVITY = process.env.ACTIVITY_ID || 'USFY4Q1KPsHd54cN8AVUPHZdHpT';
const PAGE_URL = `https://pro.m.jd.com/mall/active/${ACTIVITY}/index.html`;
const OUT = process.env.FEED_FILE || path.join(__dirname, 'data', 'feed-latest.json');
const MAX_SCROLL = Number(process.env.MAX_SCROLL || 30);
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 jdapp;JDAndroid;14.0.0;';

function ts() {
  return new Date(Date.now() + 8 * 3600e3).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' });
}
function log(msg) { console.log(`[${ts()}] [browser] ${msg}`); }

const products = new Map();
let currentTab = 'today';

function ingest(p) {
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
    tab: currentTab,
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
  // 多次出现时用更完整的数据覆盖（价格/库存可能后到）
  products.set(sku, Object.assign({}, old, {
    price: item.price || old.price,
    orig: item.orig || old.orig,
    process: item.process || old.process,
    remainNum: item.remainNum || old.remainNum,
    canSell: item.canSell || old.canSell,
  }));
  return false;
}

(async () => {
  const started = Date.now();
  log(`启动浏览器，目标 ${PAGE_URL}`);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
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
  page.on('request', r => { if (r.url().includes('queryBabelFeeds')) inflight++; });
  page.on('requestfailed', r => { if (r.url().includes('queryBabelFeeds')) inflight = Math.max(0, inflight - 1); });
  page.on('response', async res => {
    const u = res.url();
    if (!u.includes('queryBabelFeeds')) return;
    try {
      const j = await res.json();
      const floors = j.floorList || [];
      lastPageNum = Number(j.pageNum || lastPageNum);
      let added = 0;
      floors.forEach(f => (f.providerData || []).forEach(p => { if (ingest(p)) added++; }));
      log(`截获 queryBabelFeeds pageNum=${j.pageNum} 楼层=${floors.length} 新增=${added} 累计=${products.size}`);
    } catch (e) {
      log('响应解析失败：' + e.message);
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  });

  // 滚到底部并等待接口：只有"没有请求在飞 + 连续多次无新增 + 高度不再增长"才停
  async function scrollLoad(tag, maxRounds) {
    let idle = 0, lastH = 0, sameH = 0;
    for (let i = 0; i < maxRounds; i++) {
      const before = products.size;
      const st = await page.evaluate(() => {
        window.scrollBy(0, 500);
        return {
          y: window.scrollY,
          h: document.body.scrollHeight,
          bottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 40,
        };
      });
      await page.waitForTimeout(2000);
      if (st.h === lastH) sameH++; else { sameH = 0; lastH = st.h; }
      if (products.size > before) idle = 0;
      else if (inflight === 0) idle++;
      if (i % 5 === 0) log(`${tag} 进度：scrollY=${st.y} 高度=${st.h} 累计=${products.size} 待响应=${inflight} 页码=${lastPageNum}`);
      if (idle >= 8 && sameH >= 3) {
        log(`${tag}：结束（底部=${st.bottom} scrollY=${st.y} 高度=${st.h} 累计=${products.size} 页码=${lastPageNum}）`);
        break;
      }
    }
  }

  try {
    // 最多两次尝试：页面偶发白屏/未触发接口时重载一次
    for (let attempt = 1; attempt <= 2 && products.size === 0; attempt++) {
      const url = attempt === 1 ? PAGE_URL : PAGE_URL + '?_r=' + Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 25 && products.size === 0; i++) await page.waitForTimeout(1000);
      log(`第 ${attempt} 次加载完成：已抓 ${products.size} 个商品`);
    }
    await scrollLoad('今日抢购', MAX_SCROLL);
    log(`今日抢购：累计 ${products.size} 个`);

    // 「明日预告」tab：默认关闭（抓不到/无必要）
    if (process.env.INCLUDE_TOMORROW === '1') {
      // 先回到顶部，否则 tab 在视口外点击会被拦截
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1200);
      const tab = page.getByText('明日预告', { exact: false }).first();
      if (await tab.count()) {
        await tab.scrollIntoViewIfNeeded().catch(() => {});
        await tab.click({ timeout: 5000, force: true }).catch(async (e) => {
          log('常规点击失败，改用 JS 点击：' + e.message.slice(0, 60));
          await page.evaluate(() => {
            const els = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && (el.textContent || '').trim() === '明日预告');
            if (els[0]) els[0].click();
          }).catch(() => {});
        });
        currentTab = 'tomorrow';
        log('已切换到「明日预告」tab');
        await page.waitForTimeout(5000);
        const beforeT = products.size;
        await scrollLoad('明日预告', MAX_SCROLL);
        log(`明日预告：新增 ${products.size - beforeT} 个`);
      } else {
        log('未找到「明日预告」tab，跳过');
      }
    }
  } catch (e) {
    log('页面操作异常：' + e.message);
  }

  await browser.close();
  const list = [...products.values()];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), total: list.length, products: list }, null, 2));
  const todayN = list.filter(p => p.tab !== 'tomorrow').length;
  log(`完成：今日 ${todayN} + 明日预告 ${list.length - todayN} = ${list.length} 个商品，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s → ${OUT}`);
  if (!list.length) {
    log('警告：未截获任何商品（页面可能被验证/接口未触发）');
    process.exit(1);
  }
})();
