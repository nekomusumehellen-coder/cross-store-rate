// 本地专用：生成"有效套餐明细"数据文件，供 local-detail.html 查看。
// ⚠️ 输出文件 local-detail-data.js 含真实客户手机号/昵称，写进了 .gitignore，不会被提交/公开。
//
// 用法：
//   FUNC_SHARED_SECRET=xxx node gen-local-detail.js
// 跑完双击打开 local-detail.html 即可（跟看板一样用 <script src> 加载数据，本地双击也能用）。

const fs = require("fs");
const path = require("path");
const { beijingDateStr, buildCardRecords } = require("./lib.js");

async function main() {
  const today = beijingDateStr(0);
  console.log(`正在拉取截止到 ${today} 的全部购买+验券记录...`);
  const records = await buildCardRecords(today);
  console.log(`拉到 ${records.length} 条记录`);

  const outPath = path.join(__dirname, "local-detail-data.js");
  fs.writeFileSync(outPath, `window.LOCAL_DETAIL_DATA = ${JSON.stringify(records)};\nwindow.LOCAL_DETAIL_GENERATED_AT = ${JSON.stringify(today)};\n`);
  console.log(`已写入 ${outPath}`);
}

main().catch((e) => {
  console.error("生成失败：", e.message);
  process.exit(1);
});
