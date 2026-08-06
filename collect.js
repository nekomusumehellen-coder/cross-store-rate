// 跨店率每日结算脚本：每天凌晨跑一次，算出"昨天"回兴店的跨店率，追加一条记录到 history.json。
//
// ⚠️ 算的是"昨天"，不是"今天"：跨店结算数据要过凌晨才会把前一天的记录结算完成，
// 当天白天去查当天的跨店结算数据是不完整/查不到的，2026-08-06 用户提醒过这个业务规则。
// 所以定时任务放在凌晨跑（这时候"昨天"已经结算完了），脚本里算的日期也是 beijingDateStr(-1)。
//
// 跨店率 = 分子 / 分母
//   分母：回兴店当前持有有效套餐(userCardStatus=VALID)的会员数——不用会员列表接口（那个经常
//         500报错），改用"购买记录"(purchase-orders) + "验券记录"(exchange-records) 反推，
//         这两个接口都自带 userCardStatus/remainValue/userCardExpiredTime，按手机号去重就是分母。
//   分子：昨天(北京时间)回兴店卖出的卡、在别的门店消费的用户数（跨店结算"流出"方向，按手机号去重）。
//
// GitHub Actions 每天定时跑，跑完把 history.json 提交回仓库，index.html 直接 fetch 这个文件展示。

const FUNC_SECRET = process.env.FUNC_SHARED_SECRET;
const STORE = "回兴";
const BASE = "https://booking-fn.vercel.app/api";

const fs = require("fs");
const path = require("path");
const HISTORY_PATH = path.join(__dirname, "history.json");

// 北京时间的"今天"（不管 GitHub Actions 跑在哪个时区，都按北京时间算）
function beijingDateStr(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400000);
  return now.toISOString().slice(0, 10);
}

async function fetchAllPages(paramsBase) {
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
    if (rows.length < 100 || all.length >= json.data.total) break;
    page++;
  }
  return all;
}

// 分母：回兴店当前持有有效套餐的会员数（购买记录 + 验券记录，按手机号去重）
async function computeDenominator() {
  const [purchases, exchanges] = await Promise.all([
    fetchAllPages({ store: STORE }),
    fetchAllPages({ store: STORE, mode: "exchange-records", startTime: "2020-01-01 00:00:00", endTime: `${beijingDateStr()} 23:59:59` }),
  ]);
  const validUsers = new Set();
  for (const r of [...purchases, ...exchanges]) {
    if (r.userCardStatus === "VALID" && r.userPhone) validUsers.add(r.userPhone);
  }
  console.log(`分母来源：购买记录 ${purchases.length} 条 + 验券记录 ${exchanges.length} 条，有效会员去重后 ${validUsers.size} 人`);
  return validUsers.size;
}

// 分子：当天跨店结算(流出方向)涉及的用户数，按手机号去重
async function computeNumerator(dateStr) {
  const rows = await fetchAllPages({
    mode: "cross-store-settlement",
    store: STORE,
    direction: "out",
    startTime: `${dateStr} 00:00:00`,
    endTime: `${dateStr} 23:59:59`,
  });
  const users = new Set(rows.map((r) => r.userPhone).filter(Boolean));
  console.log(`分子来源：${dateStr} 跨店结算(流出) ${rows.length} 条，去重后 ${users.size} 人`);
  return users.size;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2));
}

async function main() {
  if (!FUNC_SECRET) {
    console.error("缺少环境变量 FUNC_SHARED_SECRET");
    process.exit(1);
  }

  const dateStr = beijingDateStr(-1); // 昨天
  const [denominator, numerator] = await Promise.all([computeDenominator(), computeNumerator(dateStr)]);
  const rate = denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;

  console.log(`${dateStr} 跨店率：${numerator}/${denominator} = ${rate}%`);

  const history = loadHistory();
  const idx = history.findIndex((h) => h.date === dateStr);
  const record = { date: dateStr, numerator, denominator, rate };
  if (idx >= 0) {
    history[idx] = record; // 同一天重复跑，覆盖而不是追加
  } else {
    history.push(record);
  }
  history.sort((a, b) => (a.date < b.date ? -1 : 1));
  saveHistory(history);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
