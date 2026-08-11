# cross-store-rate

回兴店跨店率每日结算 + 可视化看板。每天北京时间 10:00 通过 GitHub Actions 自动结算"前一天"的数据，
结果通过 GitHub Pages 展示成一个带日期区间选择的动态曲线图，也支持本地双击 `index.html` 直接看。

跟 `booking-fn` 是分开的独立小项目，不占用它在 Vercel 上宝贵的12个函数名额，纯粹调用
`booking-fn` 已有的接口，没有自己的后端。

## 跨店率怎么算的

跨店率 = 分子 ÷ 分母，算法在 `lib.js` 里，`collect.js`（每日结算）和 `backfill.js`（历史回填）共用同一份，
保证两边数字口径一致，不会因为算法不一样出现断层。

- **分母**：回兴店当天持有有效套餐的会员数（按手机号去重）。**不用会员列表接口**
  （`GET /api/users`，实测经常 500 报错，不稳定），改用"购买记录"(`purchases.js` 默认模式) +
  "验券记录"(`purchases.js?mode=exchange-records`) 反推出每张卡的有效区间：
  `[生效日期, 失效日期]` = `[orderCreateTime, userCardExpiredTime]`。
  某天落在区间内就算这个用户当天有效，一天的分母 = 当天有至少一张卡覆盖的用户数。
  ⚠️ **这是近似值**：如果一张卡在到期日之前就被用完了，`userCardExpiredTime` 不会跟着更新提前，
  这张卡会被算成"比实际有效期更长"，分母会略微偏高——2026-08-06 已跟用户确认接受这个精度
  （精确算法要挨个查每张失效卡的使用记录定位真实失效时间，量级在千张以上、跑起来太慢）。
  ⚠️ **查这两个接口必须传 `startTime`/`endTime` 日期范围，不能留空**——王知之的
  `exchange-records` 接口不传日期范围时会默默截断成一小段最近记录，不是真的"不限时间"，
  2026-08-06 踩过这个坑（一度被截断到只有32/78/99条这种不稳定的小数字，传了正确日期范围后才稳定在
  2300+条）。
- **分子**：当天(北京时间)跨店结算**流出方向**(`purchases.js?mode=cross-store-settlement&direction=out`)
  涉及的用户数，按手机号去重——也就是"回兴店卖出的卡，当天在别的门店消费"的人数，这个是精确值不是近似值。

## 文件结构

- `lib.js`：共享逻辑（拉数据、算分母分子），`collect.js`/`backfill.js` 都靠它
- `collect.js`：每日结算脚本，算出"前一天"一条记录，追加/覆盖进 `history.json`
- `backfill.js`：一次性历史回填脚本，见下面单独一节
- `history.json`：累积的每日数据 `[{date, numerator, denominator, rate, backfilled?}, ...]`，
  `backfilled: true` 表示这条是回填出来的近似值，不是真实每日结算跑出来的
- `history.js`：内容跟 `history.json` 完全一样，只是包了一层 `window.HISTORY_DATA = [...]`——
  `index.html` 用 `<script src="./history.js">` 加载数据而不是 `fetch('./history.json')`，
  因为本地双击打开网页时 `fetch` 读同目录文件会被浏览器的本地文件 CORS 限制挡住、显示不出数据，
  `<script src>` 没有这个限制，两种打开方式都能用（2026-08-06 发现这个问题后改的）
- `index.html`：看板页面，跨店率+有效套餐数量两条动态曲线图 + 日期区间选择器 + 明细表格 +
  "有效套餐用户明细"（本地专用，见下一节）。**聚合部分（曲线图/KPI/明细表格）只有数字，不含任何手机号/昵称**，
  可以放心公开
- `.github/workflows/collect.yml`：每天定时跑 `collect.js`，提交 `history.json`/`history.js`，再部署到 GitHub Pages

### 同一份 `index.html` 里的本地专用板块：有效套餐用户明细（含手机号，不进公开仓库）

`index.html` 最下面"有效套餐用户明细"卡片可以查某天具体是哪些用户持有有效套餐（手机号、昵称、卡名、
生效/失效日期），**这部分没有单独做一个 HTML 文件**，而是巧妙合并进同一份 `index.html` 里：

- `gen-local-detail.js`：本地跑一次，拉全部购买+验券记录，生成 `local-detail-data.js`
- `local-detail-data.js`：含真实客户手机号，已加入 `.gitignore`，**不会被提交，线上仓库里也没有这个文件**
- `index.html` 用 `<script src="./local-detail-data.js">` 去加载这份数据——**线上 GitHub Pages 上这个文件根本不存在**，
  这个 `<script>` 请求会静默 404（不报错、不崩页面），"有效套餐用户明细"卡片自动显示"本地未生成数据"的提示；
  **只有在本地跑过生成脚本之后，这个文件才会真实存在于你电脑上**，双击打开 `index.html` 才能看到完整明细表格
  （支持选日期、手机号/昵称模糊搜索、默认手机号打码显示，点按钮切明文）。2026-08-11 验证过这个降级逻辑：
  临时删掉本地数据文件重新打开页面，明细卡片正常显示提示文案，没有报错也没有露出任何数据

用法：

```bash
FUNC_SHARED_SECRET=xxx node gen-local-detail.js
```

跑完刷新（或重新打开）本地的 `index.html` 即可看到明细。想看最新数据，重新跑一遍生成脚本再刷新页面就行——
这个工具没有自动定时更新，需要手动跑。

## 配置

GitHub 仓库 Settings → Secrets and variables → Actions 加一个 secret：

| Secret 名 | 值 |
|---|---|
| `FUNC_SHARED_SECRET` | `booking-fn` 的 `x-func-secret`，在 `../booking-fn/README.md` 里 |

Settings → Pages，Source 选 "GitHub Actions"（workflow 里已经配好了部署步骤，选完就行）。

监控哪个门店，改 `lib.js` 顶部的 `STORE` 常量（默认 `"回兴"`），门店关键词规则跟 `booking-fn` 一样。

## 历史回填

`collect.js` 只会从它第一次跑的那天开始往后累积。如果想把更早的历史数据也补上：

```bash
FUNC_SHARED_SECRET=xxx node backfill.js
```

- 回填的时间范围写死在 `lib.js` 的 `EARLIEST_DATE` 常量里（现在是 `2025-06-01`，回兴店用户要求的起点）
- 只回填 `history.json` 里**还没有**的日期，不会覆盖 `collect.js` 正式跑出来的真实记录
- 只回填到"昨天"，跟每日结算的口径一致（今天的数据还没"结算完"）
- 这是一次性重活（要拉全量购买+验券+跨店结算历史数据，两千多条，跑下来大概1分钟），补完一次以后不用再跑，
  除非想扩大 `EARLIEST_DATE` 往更早补

## 数据口径的几个说明

- **同一天重复跑会覆盖**，不会重复累加——如果一天内手动触发了好几次 workflow，`history.json` 里这天永远只有最新一次跑出来的结果
- **验券记录查全部渠道**（`channel: ''`），不是只查美团——2026-08-06 发现不传渠道限制不影响准确性，干脆查全部更完整
- ⚠️ **接口报错时会直接中止整个脚本，不会提交半成品数据**：王知之后台偶尔会抽风返回
  `{"error":"fetch failed"}`（这个大项目从头到尾都踩过好几次），`lib.js` 的 `fetchAllPages`
  遇到这种报错会自动重试3次，3次都失败就直接抛异常让整个脚本失败退出——2026-08-10 吃过一次亏，
  当时遇到报错只是打印日志、拿着不完整数据（购买记录被拦腰截断、验券记录变成0条）硬算，
  结果算出"跨店率130%"这种明显错误的数字还提交上去了，用户第二天发现才补救。现在遇到这种情况，
  workflow 会直接跑失败（GitHub 上能看到红叉），`history.json` 保持不变，等下一次定时/手动触发再试。
- ⚠️ **跨店结算数据当天可能还没同步完整**：2026-08-08 那天 workflow 曾在北京时间 00:58 跑过，
  接口没报错、正常返回但只有 0 条，好几天后再查才是真实的 14 条——不是接口报错（那种情况会重试+中止），
  是数据本身当时就还没结算同步完，无法靠代码检测。已把定时从 00:30 挪到 10:00 留缓冲，但具体要多久才能
  稳定同步完还不确定，以后如果再发现某天的数字偏低，可以手动用 `mode=cross-store-settlement` 接口重新
  查一遍核对，不一致就手动改 `history.json` 对应那天的记录再提交。
- ⚠️ **本地打开的 `index.html` 不会自己联网同步**：这是个纯静态文件，双击打开显示的是"你电脑上这份文件
  当时的内容"，不会因为 GitHub 上的数据更新了就跟着变。**想看最新数据，去线上 Pages 地址**
  （见仓库 About 里的链接），或者本地 `git pull` 一下再重新打开本地文件。

## 手动触发测试

去 GitHub 仓库 Actions 页面，选这个 workflow，点 "Run workflow" 立刻跑一次（会重新结算"前一天"这一条）。

## 本地测试

```bash
FUNC_SHARED_SECRET=xxx node collect.js
```

⚠️ 本地跑会直接改本地的 `history.json`/`history.js`，测完注意别把测试数据误提交上去
（`git checkout -- history.json history.js` 可以丢弃本地改动）。
