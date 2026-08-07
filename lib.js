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

const FUNC_SECRET = process.env.FUNC_SHARED_SECRET;
const STORE = "回兴";
const BASE = "https://booking-fn.vercel.app/api";
const EARLIEST_DATE = "2025-06-01"; // 拉数据的下限，早于门店实际开业时间就行，宁可多拉不要漏

function beijingDateStr(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  return now.toISOString().slice(0, 10);
}

async function fetchAllPages(paramsBase, onProgress) {
  let page = 1;
  const all = [];
  while (true) {
    const params = new URLSearchParams({ ...paramsBase, pageSize: "100", pageNo: String(page) });
    const resp = await fetch(`${BASE}/purchases?${params}`, {
      headers: { "x-func-secret": FUNC_SECRET },
    });
    const json = await resp.json();
    if (!json.data) {
      console.error("接口返回异常：", JSON.stringify(json));
      break;
    }
    const rows = json.data.rows || [];
    all.push(...rows);
    if (onProgress) onProgress(all.length, json.data.total);
    if (rows.length < 100 || all.length >= json.data.total) break;
    page++;
  }
  return all;
}

// 拉全部购买+验券记录（截止到 untilDateStr），按手机号整理出每个用户名下所有卡的 [生效,失效] 区间
async function buildCardIntervals(untilDateStr) {
  const rangeParams = { startTime: `${EARLIEST_DATE} 00:00:00`, endTime: `${untilDateStr} 23:59:59` };
  const [purchases, exchanges] = await Promise.all([
    fetchAllPages({ store: STORE, ...rangeParams }),
    fetchAllPages({ store: STORE, mode: "exchange-records", channel: "", ...rangeParams }),
  ]);
  const cardsByUser = {};
  for (const r of [...purchases, ...exchanges]) {
    if (!r.userPhone || !r.orderCreateTime || !r.userCardExpiredTime) continue;
    const start = r.orderCreateTime.slice(0, 10);
    const end = r.userCardExpiredTime.slice(0, 10);
    if (start > end) continue;
    (cardsByUser[r.userPhone] ||= []).push([start, end]);
  }
  console.log(`分母数据源：购买记录 ${purchases.length} 条 + 验券记录 ${exchanges.length} 条，涉及 ${Object.keys(cardsByUser).length} 个不同用户`);
  return cardsByUser;
}

function denominatorOnDate(cardsByUser, dateStr) {
  let count = 0;
  for (const phone of Object.keys(cardsByUser)) {
    if (cardsByUser[phone].some(([s, e]) => s <= dateStr && dateStr <= e)) count++;
  }
  return count;
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

module.exports = { STORE, EARLIEST_DATE, beijingDateStr, fetchAllPages, buildCardIntervals, denominatorOnDate, computeNumeratorForDate };
