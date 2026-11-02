#!/usr/bin/env node
/**
 * 巡检循环器：在同一个 Actions 任务里连续跑多次 monitor.js，降低检测延迟。
 *
 * 背景：GitHub 定时任务最短 5 分钟触发一次，单次抓取约 20~40 秒，
 * 因此新品被发现的平均延迟约 2.5 分钟。改成一次任务内每 60 秒巡检一轮，
 * 延迟可压到 1 分钟左右，且无需额外的外部定时器。
 *
 * 每轮 monitor.js 会自己读写快照（STATE_PATH），轮次之间的差异对比因此成立；
 * 推送在变化发生时立即发出，快照由工作流最后统一回写。
 *
 * 环境变量：
 *   LOOP_TIMES     轮询次数（默认 1，工作流里设为 5）
 *   LOOP_INTERVAL  轮询间隔毫秒（默认 60000）
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const TIMES = Math.max(1, Number(process.env.LOOP_TIMES || 1));
const INTERVAL = Math.max(0, Number(process.env.LOOP_INTERVAL || 60000));

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  for (let i = 1; i <= TIMES; i++) {
    console.log(`\n===== 第 ${i}/${TIMES} 轮巡检 ${new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)} =====`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'monitor.js')], {
      stdio: 'inherit',
      env: process.env,
    });
    console.log(`第 ${i} 轮结束，退出码 ${r.status}`);
    if (i < TIMES) await sleep(INTERVAL);
  }
})();
