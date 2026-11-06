/* 双金共振判定 · 确定性单测（无网络、无随机）
   运行：node test/双金共振.test.mjs
   覆盖：① KDJ 计算自洽性 ② 低位聚合后发散 + MACD 刚翻红 → 命中
        ③ 持续下跌（未翻红）→ 不命中 ④ 高位连涨（KDJ 不低位）→ 不命中
        ⑤ KDJ 高位反弹 → 不误判为低位启动 */
import { kdjSeries, detect双金共振, macdSeries } from "../engine.js";

let 通过 = 0, 失败 = 0;
function 断言(名, 条件, 备注) {
  if (条件) { 通过++; console.log("  ✅", 名, 备注 ? "｜" + 备注 : ""); }
  else { 失败++; console.log("  ❌", 名, 备注 ? "｜" + 备注 : ""); }
}

/* 构造日 K：给定收盘价序列，日内振幅 ±0.6% */
function 造K(closes) {
  return closes.map((c, i) => ({
    TRADE_DATE: "2026-01-01",
    OPEN_PRICE: i ? closes[i - 1] : c,
    CLOSE_PRICE: c,
    HIGH_PRICE: c * 1.006,
    LOW_PRICE: c * 0.994,
    VOLUME: 100000,
  }));
}

/* 场景 A（基准形态）：主跌 40 日 → 末跌缩量钝化 6 日（KDJ 低位粘合）→ 连涨 2 日（MACD 翻红、KDJ 发散） */
function 场景A() {
  const a = [];
  let c = 20;
  for (let i = 0; i < 40; i++) { c *= 0.99; a.push(c); }
  for (let i = 0; i < 6; i++) { c *= 0.988; a.push(c); }
  for (let i = 0; i < 2; i++) { c *= 1.02; a.push(c); }
  return a;
}

console.log("一、KDJ 计算自洽性");
{
  const rows = 造K(场景A());
  const kdj = kdjSeries(rows);
  断言("返回三线数组且长度一致", kdj && kdj.kArr.length === rows.length && kdj.dArr.length === rows.length && kdj.jArr.length === rows.length);
  断言("K/D 落在 0~100", kdj.kArr.every((v) => v >= 0 && v <= 100) && kdj.dArr.every((v) => v >= 0 && v <= 100));
  const i = kdj.kArr.length - 1;
  const jErr = Math.abs(kdj.jArr[i] - (3 * kdj.kArr[i] - 2 * kdj.dArr[i]));
  断言("J = 3K − 2D", jErr < 1e-9, "误差 " + jErr.toExponential(2));
  断言("样本不足返回 null", kdjSeries(造K([10, 10.1, 10.2])) === null);
}

console.log("二、双金命中（低位聚合后发散 + MACD 刚翻红）");
{
  const a = 场景A();
  const rows = 造K(a);
  const mc = macdSeries(a);
  const kdj = kdjSeries(rows);
  const r = detect双金共振(mc, kdj);
  断言("基准形态命中", !!r, r ? `翻红序 ${r.翻红序}、前绿 ${r.前绿}、低位 ${r.低位值}、聚合 ${r.聚合间距}→发散 ${r.当前间距}、K/D/J ${r.K}/${r.D}/${r.J}` : "未命中");
  if (r) {
    断言("低位值 ≤ 阈值 30", r.低位值 <= 30, "低位值 " + r.低位值);
    断言("聚合间距 ≤ 阈值 8", r.聚合间距 <= 8, "聚合间距 " + r.聚合间距);
    断言("发散后极差扩大 ≥3", r.当前间距 >= r.聚合间距 + 3, r.聚合间距 + " → " + r.当前间距);
    断言("K > D 且 J ≥ K（多头发散）", r.K > r.D && r.J >= r.K);
    断言("翻红发生在窗口内（≤3 日）", r.翻红序 >= 1 && r.翻红序 <= 3, "翻红序 " + r.翻红序);
    断言("翻红前有 ≥3 根绿柱", r.前绿 >= 3, "前绿 " + r.前绿);
  }
}

console.log("三、持续下跌：KDJ 低位但不发散、MACD 未翻红 → 不命中");
{
  const a = []; let c = 20;
  for (let i = 0; i < 60; i++) { c *= 0.985; a.push(c); }
  const rows = 造K(a);
  const r = detect双金共振(macdSeries(a), kdjSeries(rows));
  断言("未命中", r === null, r ? "误命中 " + JSON.stringify(r) : "返回 null");
}

console.log("四、高位单边连涨：MACD 红柱但 KDJ 不在低位 → 不命中");
{
  const a = []; let c = 10;
  for (let i = 0; i < 70; i++) { c *= 1.008; a.push(c); }
  const rows = 造K(a);
  const r = detect双金共振(macdSeries(a), kdjSeries(rows));
  断言("未命中", r === null, r ? "误命中 " + JSON.stringify(r) : "返回 null");
}

console.log("五、高位横盘后回落再反弹（KDJ 曾高位）→ 不得按低位启动处理");
{
  const a = []; let c = 10;
  for (let i = 0; i < 30; i++) { c *= 1.01; a.push(c); }
  for (let i = 0; i < 6; i++) { c *= 0.995; a.push(c); }
  for (let i = 0; i < 5; i++) { c *= 1.015; a.push(c); }
  const rows = 造K(a);
  const kdj = kdjSeries(rows);
  const r = detect双金共振(macdSeries(a), kdj);
  const 近10最低K = Math.min(...kdj.kArr.slice(-10));
  断言("近 10 日 K 未进低位则不命中", r === null, "近 10 日最低 K " + Math.round(近10最低K * 10) / 10 + (r ? "，但命中" : ""));
}

console.log("\n结果：" + 通过 + " 通过 / " + 失败 + " 失败");
process.exit(失败 ? 1 : 0);
