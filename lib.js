// 共享逻辑：collect.js（每日结算）和 backfill.js（历史回填）都用这一份，
// 保证两边算分母用的是同一套算法，不会出现"昨天101、今天36"这种因为算法不一致产生的断层。
//
// 分母算法：拉全"购买记录"+"验券记录"（不加 userCardStatus 过滤，要全部状态的历史记录，
// 这样才能重建每张卡的完整有效区间），每条记录当一张卡的有效区间 =
// [orderCreateTime(生效开始), userCardExpiredTime(近似失效日期)]。
// 某天 D 是否算"这个用户当天有效"：D 落在这张卡的 [start, end] 闭区间内。
// ⚠️ 这是近似值：如果一张卡提前被用完了，userCardExpiredTime 不会跟着更新提前，
// 这张卡会被算成"比实际有效期更长"，分母会偏高——2026-08-06 已跟用户确认接受这个精度。
// ⚠️ 查这两个接口时必须传 startTime/endTime 日期范围，不能留空——王知之的 exchange-records
// 接口不传日期范围时会默默截断成一小段最近记录，不是真的"不限时间"，之前踩过这个坑。
// ⚠️ 2026-08-11：冻结(userCardStatus="FREEZE")和锁座固定座位(cardTypeCode="LONG_TERM"/
// cardTypeName="锁座卡")的记录不算"有效"，两者都会被整条剔除，不参与区间计算——见 isExcludedFromValid()。

const FUNC_SECRET = process.env.FUNC_SHARED_SECRET;
const STORE = "回兴";
const BASE = "https://booking-fn.vercel.app/api";
const EARLIEST_DATE = "2025-06-01"; // 拉数据的下限，早于门店实际开业时间就行，宁可多拉不要漏

function beijingDateStr(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  return now.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 王知之后台偶尔会抽风返回 {"error":"fetch failed"}（这个项目从头到尾都踩过好几次，不是我们这边的问题）。
// ⚠️ 2026-08-10 吃过一次亏：之前遇到这种报错只是打印日志、拿着已经拉到的不完整数据继续算，
// 算出了"跨店率130%"这种明显错误的结果还提交上去了。现在改成：单页失败重试3次，
// 3次都失败就直接抛异常，让整个脚本失败退出——宁可这次不更新，也不能把错误数据提交进 history.json。
async function fetchOnePage(paramsBase, page) {
  const params = new URLSearchParams({ ...paramsBase, pageSize: "100", pageNo: String(page) });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${BASE}/purchases?${params}`, {
        headers: { "x-func-secret": FUNC_SECRET },
      });
      const json = await resp.json();
      if (!json.data) {
        lastErr = new Error(`接口返回异常：${JSON.stringify(json)}`);
      } else {
        return json.data;
      }
    } catch (e) {
      lastErr = e;
    }
    console.error(`第${page}页第${attempt}次请求失败：${lastErr.message}，${attempt < 3 ? "重试中..." : "放弃"}`);
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw lastErr;
}

async function fetchAllPages(paramsBase, onProgress) {
  let page = 1;
  const all = [];
  while (true) {
    const data = await fetchOnePage(paramsBase, page); // 失败会抛异常，不会拿不完整数据继续
    const rows = data.rows || [];
    all.push(...rows);
    if (onProgress) onProgress(all.length, data.total);
    if (rows.length < 100 || all.length >= data.total) break;
    page++;
  }
  return all;
}

// 2026-08-11 用户明确要求：冻结的卡不算有效，锁座固定座位的卡也不算有效——这两种都不该
// 进"有效套餐用户明细"，也不该算进跨店率的分母。判断依据（实测过回兴店全量2557条记录确认的字段）：
// - `userCardStatus === "FREEZE"` = 冻结（王知之后台把这个状态跟 VALID/INVALID 并列，不是 INVALID 的子集）
// - `cardTypeCode === "LONG_TERM"`（`cardTypeName` 显示"锁座卡"）= 锁座/固定座位类型的卡
// 两个条件符合任意一个就整条记录剔除，不参与"这张卡在哪几天算有效"的区间计算。
function isExcludedFromValid(r) {
  return r.userCardStatus === "FREEZE" || r.cardTypeCode === "LONG_TERM";
}

// 拉全部购买+验券记录（截止到 untilDateStr），按手机号整理出每个用户名下所有卡的 [生效,失效] 区间
async function buildCardIntervals(untilDateStr) {
  const rangeParams = { startTime: `${EARLIEST_DATE} 00:00:00`, endTime: `${untilDateStr} 23:59:59` };
  const [purchases, exchanges] = await Promise.all([
    fetchAllPages({ store: STORE, ...rangeParams }),
    fetchAllPages({ store: STORE, mode: "exchange-records", channel: "", ...rangeParams }),
  ]);
  const cardsByUser = {};
  let excluded = 0;
  for (const r of [...purchases, ...exchanges]) {
    if (!r.userPhone || !r.orderCreateTime || !r.userCardExpiredTime) continue;
    if (isExcludedFromValid(r)) { excluded++; continue; }
    const start = r.orderCreateTime.slice(0, 10);
    const end = r.userCardExpiredTime.slice(0, 10);
    if (start > end) continue;
    (cardsByUser[r.userPhone] ||= []).push([start, end]);
  }
  console.log(`分母数据源：购买记录 ${purchases.length} 条 + 验券记录 ${exchanges.length} 条，其中 ${excluded} 条是冻结/锁座卡已剔除，涉及 ${Object.keys(cardsByUser).length} 个不同用户`);
  return cardsByUser;
}

function denominatorOnDate(cardsByUser, dateStr) {
  let count = 0;
  for (const phone of Object.keys(cardsByUser)) {
    if (cardsByUser[phone].some(([s, e]) => s <= dateStr && dateStr <= e)) count++;
  }
  return count;
}

// 跟 buildCardIntervals 拉的是同一份数据，但不做"按用户合并成区间数组"的精简，
// 保留每条记录的昵称/卡名/来源，供本地"有效套餐明细"工具用（含手机号，不能进公开仓库/看板）。
async function buildCardRecords(untilDateStr) {
  const rangeParams = { startTime: `${EARLIEST_DATE} 00:00:00`, endTime: `${untilDateStr} 23:59:59` };
  const [purchases, exchanges] = await Promise.all([
    fetchAllPages({ store: STORE, ...rangeParams }),
    fetchAllPages({ store: STORE, mode: "exchange-records", channel: "", ...rangeParams }),
  ]);
  const records = [];
  const tag = (rows, source) => {
    for (const r of rows) {
      if (!r.userPhone || !r.orderCreateTime || !r.userCardExpiredTime) continue;
      if (isExcludedFromValid(r)) continue; // 冻结/锁座卡不算有效，本地明细页也不该显示
      const start = r.orderCreateTime.slice(0, 10);
      const end = r.userCardExpiredTime.slice(0, 10);
      if (start > end) continue;
      records.push({
        phone: r.userPhone,
        nickName: r.nickName || "",
        cardName: r.cardName || "",
        start,
        end,
        source, // "purchase"(小程序内购买) | "exchange"(第三方渠道验券)
      });
    }
  };
  tag(purchases, "purchase");
  tag(exchanges, "exchange");
  return records;
}

// 分子：某一天跨店结算(流出方向)涉及的用户数，按手机号去重
async function computeNumeratorForDate(dateStr) {
  const rows = await fetchAllPages({
    mode: "cross-store-settlement",
    store: STORE,
    direction: "out",
    startTime: `${dateStr} 00:00:00`,
    endTime: `${dateStr} 23:59:59`,
  });
  const users = new Set(rows.map((r) => r.userPhone).filter(Boolean));
  return users.size;
}

// `orders.js` 是完全不同的接口路径（`/api/orders`，不是 `/api/purchases`），响应结构也不一样
// （顶层直接是 `{orders, total}`，不是 `{data:{rows,total}}`）——所以单独写一个分页+重试函数，
// 不能直接复用 fetchAllPages。
// ⚠️ 2026-08-11 踩过一个坑：分页参数名是 `pageNo`，不是 `currentPage`——一开始传了 `currentPage`，
// `orders.js` 内部读的是 `pageNo`（见 booking-fn/api/orders.js 第27行），没读到就一直默认第1页，
// 导致16100条订单全是同一页数据重复16100/100=161次拼出来的，distinct id 只有100个，
// 算出来的"当日状态"活动人数少得离谱（16100条订单只查出46个不同手机号，明显不对）。
async function fetchOneOrdersPage(paramsBase, page) {
  const params = new URLSearchParams({ ...paramsBase, pageSize: "100", pageNo: String(page) });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${BASE}/orders?${params}`, {
        headers: { "x-func-secret": FUNC_SECRET },
      });
      const json = await resp.json();
      if (!Array.isArray(json.orders)) {
        lastErr = new Error(`接口返回异常：${JSON.stringify(json)}`);
      } else {
        return json;
      }
    } catch (e) {
      lastErr = e;
    }
    console.error(`订单第${page}页第${attempt}次请求失败：${lastErr.message}，${attempt < 3 ? "重试中..." : "放弃"}`);
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw lastErr;
}

async function fetchAllOrders(paramsBase, onProgress) {
  let page = 1;
  const all = [];
  while (true) {
    const json = await fetchOneOrdersPage(paramsBase, page);
    all.push(...json.orders);
    if (onProgress) onProgress(all.length, json.total);
    if (json.orders.length < 100 || all.length >= json.total) break;
    page++;
  }
  return all;
}

// 2026-08-11 用户要求：明细表格要加一列"当日状态"，需要拿两份额外数据按手机号整理成
// "这个人哪几天有活动"的日期集合——供 gen-local-detail.js 生成本地数据文件时调用。
// - settlement：跨店结算(流出方向)记录，`startTime` 是这个人当天在别的门店消费的日期
// - booking：回兴店本店的订座记录，`startTime` 是订的那天，**排除已取消的**（orderStatus
//   "4"=已取消、"9"=未到店取消——这两种不代表真的有到店/有效预约，不该算"有活动"）
async function buildActivityDates(untilDateStr) {
  const rangeParams = { startTime: `${EARLIEST_DATE} 00:00:00`, endTime: `${untilDateStr} 23:59:59` };
  const settlementRows = await fetchAllPages({
    mode: "cross-store-settlement",
    store: STORE,
    direction: "out",
    ...rangeParams,
  });
  const bookingRows = await fetchAllOrders({
    store: STORE,
    studyBeginTime: EARLIEST_DATE,
    studyEndTime: untilDateStr,
  });

  const settlement = {};
  for (const r of settlementRows) {
    if (!r.userPhone || !r.startTime) continue;
    (settlement[r.userPhone] ||= new Set()).add(r.startTime.slice(0, 10));
  }
  const booking = {};
  const CANCELLED = new Set(["4", "9"]);
  for (const r of bookingRows) {
    if (!r.userPhone || !r.startTime) continue;
    if (CANCELLED.has(String(r.orderStatus))) continue;
    (booking[r.userPhone] ||= new Set()).add(r.startTime.slice(0, 10));
  }
  const toSortedArray = (obj) => {
    const out = {};
    for (const phone of Object.keys(obj)) out[phone] = [...obj[phone]].sort();
    return out;
  };
  console.log(`当日状态数据源：跨店结算 ${settlementRows.length} 条(${Object.keys(settlement).length}人) + 本店订座 ${bookingRows.length} 条(排除已取消后 ${Object.keys(booking).length}人)`);
  return { settlement: toSortedArray(settlement), booking: toSortedArray(booking) };
}

module.exports = { STORE, EARLIEST_DATE, beijingDateStr, fetchAllPages, fetchAllOrders, buildCardIntervals, buildCardRecords, buildActivityDates, denominatorOnDate, computeNumeratorForDate };
