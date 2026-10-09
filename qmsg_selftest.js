'use strict';
/**
 * Qmsg 推送链路自检
 *
 * 背景：Qmsg 对消息内容做合规检测，URL / IPv4 / 连续数字串 / 敏感词 属"绝对禁止内容"，
 *      命中后消息被【静默丢弃】—— 接口仍返回 success:true 并给出 msgId，但 QQ 收不到。
 *      本脚本用真实 KEY 推两条仿真消息，并查询投递状态，把"接口成功"和"人收到了"区分开。
 *
 * 用法：
 *   node qmsg_selftest.js              （自动读 ../config.json 的 qmsgKey）
 *   QMSG_KEY=xxx node qmsg_selftest.js
 *   node qmsg_selftest.js xxx
 *   node qmsg_selftest.js --dry        （只预览清洗效果，不发消息）
 *
 * 判定：两条都应是 "✅ 已送达 QQ"（状态 1）。若出现 "❌ 消息违规"，说明清洗规则需补充。
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry'); // --dry：只预览清洗效果，不真的发消息
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
let key = process.env.QMSG_KEY || args[0] || '';
if (!key) {
  const cfg = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(cfg)) {
    try { key = JSON.parse(fs.readFileSync(cfg, 'utf8')).qmsgKey || ''; } catch (e) {}
  }
}
if (!key) {
  console.error('缺少 QMSG_KEY（可用环境变量、命令行参数或 ../config.json）');
  process.exit(2);
}
process.env.QMSG_KEY = key;
process.env.LOG_PATH = path.join(__dirname, 'data', 'selftest.log'); // 不污染 history.log
process.env.STATE_PATH = path.join(__dirname, 'data', 'selftest.json');

const M = require('./monitor.js');
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });

const SAMPLES = [
  ['① 脏数据版「上新」（含链接 + 12 位 SKU + 价格）：验证清洗能力',
    '【上新监控】检测到上新 2 个商品！\n' +
    '1. 良良儿童枕头流动塑型A类抗菌宝宝枕四季定型枕3-6岁小兔款 ￥346 [库存 5 限购 1]\n' +
    '链接: https://example.com/product/100322095303.html\n' +
    '2. 贝肽斯睡袋婴儿春秋冬新生儿宝宝恒温分腿睡袋儿童防踢被 ￥259.8\n' +
    '链接: https://example.com/product/10235034357775.html\n' +
    '时间: ' + stamp],
  ['② 线上真实「上新」文案：验证能否送达',
    '【上新监控】检测到上新 2 个商品！\n' +
    '1. 良良儿童枕头流动塑型A类抗菌宝宝枕\n' +
    '2. 贝肽斯睡袋婴儿春秋冬新生儿恒温分腿\n' +
    '（详情请打开官方 App 查看）\n' +
    '时间: ' + stamp],
  ['③ 线上真实「开抢倒计时」文案：验证能否送达',
    '【上新监控】距 20:00 场 开抢还有约 30 分钟，请提前打开官方 App 准备\n' +
    '今日场次: 10:00 → 20:00 → 10:00\n' +
    '开抢后会自动推送商品名\n' +
    '时间: ' + stamp],
];

(async () => {
  console.log('=== 一、清洗效果预览 ===');
  SAMPLES.forEach(([title, text]) => {
    console.log('\n--- ' + title + ' ---');
    console.log('[原文]\n' + text);
    console.log('[清洗后]\n' + M.sanitizeForQmsg(text));
  });

  if (DRY) { console.log('\n（--dry 模式：仅预览清洗效果，未发送）'); process.exit(0); }

  console.log('\n=== 二、真实推送 + 投递状态查询（同一 KEY 每 5 秒限流，自动排队）===');
  let allOk = true;
  for (const [title, text] of SAMPLES) {
    const safe = M.sanitizeForQmsg(text);
    const r = await M.qmsgSend(safe);
    if (!r.ok) { console.log(`${title}\n  提交失败 HTTP ${r.http} ${r.raw.slice(0, 120)}`); allOk = false; continue; }
    const st = await M.qmsgStatus(r.msgId);
    console.log(`${title}\n  msgId=${r.msgId}  →  ${M.QMSG_STATUS_TEXT[st] || ('状态 ' + st)}`);
    if (st !== 1) allOk = false;
  }
  console.log('\n=== 结论：' + (allOk ? '✅ 链路通畅，QQ 应该能收到上面 ' + SAMPLES.length + ' 条' : '❌ 仍有消息未送达，需继续排查') + ' ===');
  process.exit(allOk ? 0 : 1);
})();
