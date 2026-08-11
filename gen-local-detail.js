// 本地专用：生成"有效套餐明细"数据文件，供 index.html 里的"有效套餐用户明细"卡片查看。
// ⚠️ 输出文件 local-detail-data.js 含真实客户手机号/昵称，写进了 .gitignore，不会被提交/公开。
//
// 用法：
//   FUNC_SHARED_SECRET=xxx node gen-local-detail.js
// 跑完刷新本地的 index.html 即可（用 <script src> 加载数据，本地双击直接打开也能用）。
//
// ⚠️ 2026-08-11 加了"当日状态"这块数据（跨店结算+本店订座历史），本店订座记录全量有1.6万+条，
// 分页拉完大概要几分钟，比之前只拉卡记录慢不少——正常现象，耐心等就行。

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardRecords, buildActivityDates } = require("./lib.js");

async function main() {
  const today = beijingDateStr(0);

  console.log(`正在拉取截止到 ${today} 的全部购买+验券记录...`);
  const records = await buildCardRecords(today);
  console.log(`拉到 ${records.length} 条有效卡记录`);

  console.log(`正在拉取跨店结算+本店订座历史，用于算"当日状态"（本店订座记录量大，会慢一些）...`);
  const activity = await buildActivityDates(today);

  const outPath = path.join(__dirname, "local-detail-data.js");
  fs.writeFileSync(
    outPath,
    `window.LOCAL_DETAIL_DATA = ${JSON.stringify(records)};\n` +
      `window.LOCAL_DETAIL_GENERATED_AT = ${JSON.stringify(today)};\n` +
      `window.LOCAL_ACTIVITY_DATA = ${JSON.stringify(activity)};\n`
  );
  console.log(`已写入 ${outPath}`);
}

main().catch((e) => {
  console.error("生成失败：", e.message);
  process.exit(1);
});
