// 维护脚本：分母算法变了（比如 2026-08-11 加的"冻结/锁座卡不算有效"这条规则）之后，
// 用这个脚本把 history.json 里已有的每一天都用新算法重新算一遍分母+跨店率，
// 分子（跨店结算用户数）不受影响，原样保留。跟 backfill.js 不一样——backfill.js 只补
// "还没有"的日期，不会碰已有记录；这个脚本专门用来"用新口径覆盖所有旧记录"。
//
// 用法：FUNC_SHARED_SECRET=xxx node recompute-denominator.js

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardIntervals, denominatorOnDate } = require("./lib.js");

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

  console.log(`重新拉取全部购买+验券记录，用新算法重建每张卡的有效区间...`);
  const cardsByUser = await buildCardIntervals(todayStr);

  let changed = 0;
  const updated = existing.map((rec) => {
    const newDenominator = denominatorOnDate(cardsByUser, rec.date);
    const newRate = newDenominator > 0 ? Number(((rec.numerator / newDenominator) * 100).toFixed(2)) : 0;
    if (newDenominator !== rec.denominator) changed++;
    return { ...rec, denominator: newDenominator, rate: newRate };
  });

  saveHistory(updated);
  console.log(`重算完成：共 ${updated.length} 天，其中 ${changed} 天的分母发生了变化`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
