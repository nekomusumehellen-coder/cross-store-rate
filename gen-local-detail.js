// 本地专用：生成"有效套餐明细"+"锁座订单明细"数据文件，供 index.html 里对应的本地专用卡片查看。
// ⚠️ 输出文件 local-detail-data.js 含真实客户手机号/昵称，写进了 .gitignore，不会被提交/公开。
//
// 用法：
//   FUNC_SHARED_SECRET=xxx node gen-local-detail.js
// 跑完刷新本地的 index.html 即可（用 <script src> 加载数据，本地双击直接打开也能用）。
//
// ⚠️ 本店订座记录全量有1.6万+条，分页拉完大概要2~3分钟，比只拉卡记录慢不少——正常现象，耐心等就行。
// "当日状态"（2026-08-11 加）和"锁座订单明细"（2026-08-12 加）都要用到这份订座数据，2026-08-12
// 改成只拉一次共用，不然两边各自拉一次要多等一倍时间。

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardRecords, buildActivityDates, fetchStoreOrders, buildLockedSeatOrderRecords } = require("./lib.js");

async function main() {
  const today = beijingDateStr(0);

  console.log(`正在拉取截止到 ${today} 的全部购买+验券记录...`);
  const records = await buildCardRecords(today);
  console.log(`拉到 ${records.length} 条有效卡记录`);

  console.log(`正在拉取回兴店全量订座历史（1.6万+条，会慢一些），用于算"当日状态"+"锁座订单明细"...`);
  const bookingRows = await fetchStoreOrders(today);

  const activity = await buildActivityDates(today, bookingRows);
  const lockedOrders = await buildLockedSeatOrderRecords(today, bookingRows);
  console.log(`拉到 ${lockedOrders.length} 条锁座订单`);

  const outPath = path.join(__dirname, "local-detail-data.js");
  fs.writeFileSync(
    outPath,
    `window.LOCAL_DETAIL_DATA = ${JSON.stringify(records)};\n` +
      `window.LOCAL_DETAIL_GENERATED_AT = ${JSON.stringify(today)};\n` +
      `window.LOCAL_ACTIVITY_DATA = ${JSON.stringify(activity)};\n` +
      `window.LOCAL_LOCKED_ORDERS = ${JSON.stringify(lockedOrders)};\n`
  );
  console.log(`已写入 ${outPath}`);
}

main().catch((e) => {
  console.error("生成失败：", e.message);
  process.exit(1);
});
