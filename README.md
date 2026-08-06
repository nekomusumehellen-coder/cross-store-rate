# cross-store-rate

回兴店跨店率每日结算 + 可视化看板。每天北京时间 23:50 通过 GitHub Actions 自动结算一次，
结果通过 GitHub Pages 展示成一个带日期区间选择的动态曲线图。

跟 `booking-fn` 是分开的独立小项目，不占用它在 Vercel 上宝贵的12个函数名额，纯粹调用
`booking-fn` 已有的接口，没有自己的后端。

## 跨店率怎么算的

跨店率 = 分子 ÷ 分母：

- **分母**：回兴店当前持有有效套餐(`userCardStatus == 'VALID'`)的会员数。**不用会员列表接口**
  （`GET /api/users`，实测经常 500 报错，不稳定），改用"购买记录"(`purchases.js` 默认模式) +
  "验券记录"(`purchases.js?mode=exchange-records`) 反推——这两个接口都自带
  `userCardStatus`/`remainValue`/`userCardExpiredTime`，把两边结果合并、按手机号去重，
  就是当前持有有效套餐的人数。
- **分子**：当天(北京时间)跨店结算**流出方向**(`purchases.js?mode=cross-store-settlement&direction=out`)
  涉及的用户数，按手机号去重——也就是"回兴店卖出的卡，今天在别的门店消费"的人数。

## 文件结构

- `collect.js`：每日结算脚本，算完一条记录追加/覆盖进 `history.json`
- `history.json`：累积的每日数据 `[{date, numerator, denominator, rate}, ...]`
- `index.html`：看板页面，fetch `history.json` 渲染动态曲线图，带日期区间选择器和明细表格
- `.github/workflows/collect.yml`：每天定时跑 `collect.js`，提交 `history.json`，再部署到 GitHub Pages

## 配置

GitHub 仓库 Settings → Secrets and variables → Actions 加一个 secret：

| Secret 名 | 值 |
|---|---|
| `FUNC_SHARED_SECRET` | `booking-fn` 的 `x-func-secret`，在 `../booking-fn/README.md` 里 |

Settings → Pages，Source 选 "GitHub Actions"（workflow 里已经配好了部署步骤，选完就行）。

监控哪个门店，改 `collect.js` 顶部的 `STORE` 常量（默认 `"回兴"`），门店关键词规则跟 `booking-fn` 一样。

## 数据口径的几个说明

- **不做历史回填**：从第一次跑 `collect.js` 那天开始累积，之前的日期没有数据，`index.html` 会正常显示"这个区间还没有数据"
- **同一天重复跑会覆盖**，不会重复累加——如果一天内手动触发了好几次 workflow，`history.json` 里这天永远只有最新一次跑出来的结果
- **验券记录默认只查美团渠道**（`exchangeTypes: ['MEI_TUAN']`，目前已知唯一的第三方渠道），如果以后接了别的验券渠道，`collect.js` 里 `fetchAllPages` 调用 exchange-records 那行要加 `channel: ''`（查全部渠道）

## 手动触发测试

去 GitHub 仓库 Actions 页面，选这个 workflow，点 "Run workflow" 立刻跑一次（会重新结算"今天"这一条）。

## 本地测试

```bash
FUNC_SHARED_SECRET=xxx node collect.js
```

⚠️ 本地跑会直接改本地的 `history.json`，测完注意别把测试数据误提交上去。
