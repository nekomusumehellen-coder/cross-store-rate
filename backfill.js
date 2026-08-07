// 历史回填脚本：一次性算出 2025-06-01 到（history.json 现有最早日期的前一天）之间，
// 每一天的"回兴店跨店率"，插进 history.json 里现有数据的前面。不会覆盖 collect.js 正式跑出来的记录。
// 算法跟 collect.js 共用 lib.js 里的同一套逻辑，保证跟每日结算的数字口径一致。

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardIntervals, denominatorOnDate, computeNumeratorForDate, fetchAllPages, STORE, EARLIEST_DATE } = require("./lib.js");

const HISTORY_JSON_PATH = path.join(__dirname, "history.json");
const HISTORY_JS_PATH = path.join(__dirname, "history.js");

function loadHistory() {
  if (!fs.existsSync(HISTORY_JSON_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_JSON_PATH, "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_JSON_PATH, JSON.stringify(data, null, 2));
  fs.writeFileSync(HISTORY_JS_PATH, `window.HISTORY_DATA = ${JSON.stringify(data)};\n`);
}

function dateRange(start, end) {
  const dates = [];
  let cur = new Date(start + "T00:00:00Z");
  const endD = new Date(end + "T00:00:00Z");
  while (cur <= endD) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  if (!process.env.FUNC_SHARED_SECRET) {
    console.error("缺少环境变量 FUNC_SHARED_SECRET");
    process.exit(1);
  }

  const existing = loadHistory();
  const existingDates = new Set(existing.map((h) => h.date));
  const backfillEnd = beijingDateStr(-1); // 只回填到"昨天"，跟正式每日结算口径一致
  const todayStr = beijingDateStr();

  console.log(`回填范围：${EARLIEST_DATE} ~ ${backfillEnd}`);

  console.log("拉取全部购买+验券记录，重建每张卡的有效区间...");
  const cardsByUser = await buildCardIntervals(todayStr);

  console.log("拉取跨店结算(流出方向)历史记录...");
  const settlements = await fetchAllPages({
    mode: "cross-store-settlement",
    store: STORE,
    direction: "out",
    startTime: `${EARLIEST_DATE} 00:00:00`,
    endTime: `${todayStr} 23:59:59`,
  });
  const usersByDate = {};
  for (const r of settlements) {
    if (!r.startTime || !r.userPhone) continue;
    const d = r.startTime.slice(0, 10);
    (usersByDate[d] ||= new Set()).add(r.userPhone);
  }
  console.log(`分子数据源：跨店结算 ${settlements.length} 条，覆盖 ${Object.keys(usersByDate).length} 个有跨店记录的日期`);

  const allDates = dateRange(EARLIEST_DATE, backfillEnd);
  const newRecords = [];
  for (const d of allDates) {
    if (existingDates.has(d)) continue; // 不覆盖已有的正式数据
    const denominator = denominatorOnDate(cardsByUser, d);
    const numerator = usersByDate[d] ? usersByDate[d].size : 0;
    const rate = denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
    newRecords.push({ date: d, numerator, denominator, rate, backfilled: true });
  }

  const merged = [...newRecords, ...existing].sort((a, b) => (a.date < b.date ? -1 : 1));
  saveHistory(merged);
  console.log(`回填完成：新增 ${newRecords.length} 天的数据，history.json 现在共 ${merged.length} 条`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
