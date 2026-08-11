// 跨店率每日结算脚本：每天凌晨跑一次，算出"昨天"回兴店的跨店率+锁座用户数，追加一条记录到 history.json/history.js。
//
// ⚠️ 算的是"昨天"，不是"今天"：跨店结算数据要过凌晨才会把前一天的记录结算完成，
// 当天白天去查当天的跨店结算数据是不完整/查不到的，2026-08-06 用户提醒过这个业务规则。
// 所以定时任务放在凌晨跑（这时候"昨天"已经结算完了），脚本里算的日期也是 beijingDateStr(-1)。
//
// 分母/分子/锁座算法跟 backfill.js 共用同一份逻辑（见 lib.js），保证每天新增的数据点
// 和历史回填的数据点是同一套算法算出来的，不会因为算法不一致而出现数字断层。
//
// ⚠️ 2026-08-12 加了"锁座用户"这个指标后，这个脚本要多拉一次回兴店全量订座历史（1.6万+条，
// 服务端分页上限100条/页，要拉160+页）才能算出锁座区间，整体跑起来比之前慢了不少（大概2~3分钟），
// 属于正常现象——GitHub Actions 默认单个 job 超时是6小时，这点耗时完全没问题。
//
// GitHub Actions 每天定时跑，跑完把 history.json 提交回仓库，index.html 直接加载展示。

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardIntervals, denominatorOnDate, computeNumeratorForDate, buildLockedSeatIntervals, lockedSeatUsersOnDate } = require("./lib.js");

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
  // 同时写一份 .js 版本：本地用浏览器直接双击打开 index.html 时，fetch() 读同目录 json
  // 会被浏览器的本地文件 CORS 限制挡住，改用 <script src> 加载就没有这个限制。
  fs.writeFileSync(HISTORY_JS_PATH, `window.HISTORY_DATA = ${JSON.stringify(data)};\n`);
}

async function main() {
  if (!process.env.FUNC_SHARED_SECRET) {
    console.error("缺少环境变量 FUNC_SHARED_SECRET");
    process.exit(1);
  }

  const dateStr = beijingDateStr(-1); // 昨天

  const cardsByUser = await buildCardIntervals(dateStr);
  const denominator = denominatorOnDate(cardsByUser, dateStr);
  const numerator = await computeNumeratorForDate(dateStr);
  const rate = denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;

  const lockedByUser = await buildLockedSeatIntervals(dateStr);
  const lockedSeatUsers = lockedSeatUsersOnDate(lockedByUser, dateStr);

  console.log(`${dateStr} 跨店率：${numerator}/${denominator} = ${rate}%，锁座用户：${lockedSeatUsers}`);

  const history = loadHistory();
  const idx = history.findIndex((h) => h.date === dateStr);
  const record = { date: dateStr, numerator, denominator, rate, lockedSeatUsers };
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
