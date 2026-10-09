# 上新监控（云端部署版）

通过 GitHub Actions 在云端每 5 分钟检查指定活动页，检测到新品时把消息推送到你的 QQ（Qmsg）与微信（PushPlus）。

## 工作原理

- GitHub Actions 的 Ubuntu runner 出口 IP 通常是干净的，不易被反爬
- 脚本周期性抓取活动页 HTML，解析内嵌的 `__react_data__` 提取商品 SKU
- 快照存在仓库的 `data/snapshot.json` 中，每次运行自动 commit 回写
- 检测到新增 SKU 时，把消息推送给你

## 部署步骤（约 5 分钟）

### 1. 准备 GitHub 仓库

1. 注册/登录 https://github.com
2. 创建一个新仓库，比如叫 `monitor`
3. 把本目录的**所有文件**（包括 `.github/`）上传到仓库根目录

> 你可以用 GitHub 网页 "Add file → Upload files" 直接拖拽上传

### 2. 配置密钥

进入仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加：

| Name | Value |
|------|-------|
| `QMSG_KEY` | Qmsg 后台的 KEY（qmsg.zendee.cn → KEY 页复制） |
| `PUSHPLUS_TOKEN` | PushPlus 的 token（pushplus.plus 后台复制），不填则只走 QQ |

### 3. 手动运行一次（建基线）

1. 仓库页面 → **Actions** 标签
2. 左侧选 "上新监控"
3. 右侧点 **Run workflow** → 绿色按钮 **Run workflow**
4. 等待 1-2 分钟，绿色 ✅ 表示成功
5. 进入这次运行 → 展开步骤查看日志，应该看到 `基准快照已建立`

### 4. 自动定时

Workflow 已配置 `cron: '2-57/5 * * * *'`，每 5 分钟自动运行，无需额外操作。

## 测试推送链路

Actions 页面 → 左侧 "上新监控" → **Run workflow** → 勾选 **`test_push`** → Run。

只发一条测试消息，**不抓商品、不改快照**，日志会直接打印 `测试消息已送达 QQ ✅` 或 `❌`，用来确认推送是否真的能送达。

也可以用命令行自检（会真发消息并查询投递状态）：

```bash
node qmsg_selftest.js          # 真发 3 条并查回执
node qmsg_selftest.js --dry    # 只预览清洗效果，不发消息
```

## 修改配置

| 想改 | 改哪里 |
|------|--------|
| 监控的活动页 | 设置 `PAGE_URL` 环境变量（在 workflow 的 env 中加） |
| 轮询频率 | `.github/workflows/monitor.yml` 的 `cron`（GitHub 最快 5 分钟） |
| 改推送通道 | 替换 `qmsgPush()` / `pushPlusSend()` 实现 |
| 降低推送频率 | 修改 `HOTZONE_CONFIRM_N`（默认 2 次连续出现才告警） |

## 触发条件说明

- **新楼层商品**（含名称/价格）：检测到立即告警 + 推送
- **热区图片位商品**（仅 SKU）：需连续 2 次轮询都出现才告警（避免 CDN 缓存版本轮换的误报）
- **价格变动**：检测到立即推送一条简短通知
- **下架/移除**：仅楼层商品下架才记录
- **场次切换**（如 10:00 场 → 20:00 场）：切换后立即推送新场次的完整商品列表
- **开抢倒计时**：距下一场开抢 30 / 10 / 1 分钟时各提醒一次（标记存在快照 `reminders` 里，不会重复推）

## 推送通道的坑（实测）

- QQ（Qmsg）通道对内容做合规检测，**链接 / 价格 / 连续长数字串 / 部分商品名** 会被判违规并**静默丢弃**
  （接口仍返回成功并给出 msgId，但人收不到）。因此 QQ 通道只推商品名，价格/库存见快照或 App。
- 整条消息因个别商品名被拦时，脚本会**逐个商品重发**，只丢真正违禁的那条，并补一条提示。
- 同一 KEY 每 5 秒最多提交一次，脚本已内置排队与撞限流自动重试。
- 微信（PushPlus）通道无此限制，可以发链接、价格、库存等完整信息。

## 文件结构

```
.
├── monitor.js               主脚本
├── qmsg_selftest.js         推送链路自检
├── package.json             Node 配置
├── .github/workflows/       GitHub Actions 配置
│   └── monitor.yml
├── data/                    运行后自动创建
│   ├── snapshot.json        商品快照
│   └── history.log          历史日志
└── README.md
```

## 常见问题

**Q: Actions 显示失败（红色 ❌）？**
A: 展开失败步骤看日志。常见原因：①密钥没配；②活动页结构变了（解析报错）。

**Q: 收不到 QQ 消息？**
A: 检查：①QQ 是否在"陌生人消息"里；②Actions 日志里 Qmsg 的投递结果；③密钥是否正确。

**Q: 仓库会不会泄漏密钥？**
A: 不会，密钥存在 GitHub Secrets 中，加密存储，仓库代码里读不到，日志里也会被打码。
