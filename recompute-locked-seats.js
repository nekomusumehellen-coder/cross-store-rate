// 维护脚本：2026-08-12 新加了"锁座用户"这个指标，history.json 里已有的历史记录（436天）
// 当时都还没有这个字段。这个脚本把已有的每一天都重新算一遍 lockedSeatUsers 补上去，
// 其他字段（numerator/denominator/rate）不受影响，原样保留。
// 跟 recompute-denominator.js 是同一个套路，只是这次补的是新指标而不是重算旧指标。
//
// 用法：FUNC_SHARED_SECRET=xxx node recompute-locked-seats.js

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildLockedSeatIntervals, lockedSeatUsersOnDate } = require("./lib.js");

const HISTORY_JSON_PATH = path.join(__dirname, "history.json");
const HISTORY_JS_PATH = path.join(__dirname, "history.js");

function saveHistory(data) {
  fs.writeFileSync(HISTORY_JSON_PATH, JSON.stringify(data, null, 2));
  fs.writeFileSync(HISTORY_JS_PATH, `window.HISTORY_DATA = ${JSON.stringify(data)};\n`);
}

async function main() {
  if (!process.env.FUNC_SHARED_SECRET) {
    console.error("缺少环境变量 FUNC_SHARED_SECRET");
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(HISTORY_JSON_PATH, "utf8"));
  const todayStr = beijingDateStr();

  console.log(`拉取回兴店全量订座历史，重建每个用户的锁座订单区间...`);
  const lockedByUser = await buildLockedSeatIntervals(todayStr);

  const updated = existing.map((rec) => ({
    ...rec,
    lockedSeatUsers: lockedSeatUsersOnDate(lockedByUser, rec.date),
  }));

  saveHistory(updated);
  console.log(`补算完成：共 ${updated.length} 天都已经有 lockedSeatUsers 字段了`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
