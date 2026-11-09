/* 双金共振 B7 · 日线 + 周线双周期判定 · 确定性单测（无网络、无随机）
   运行：node test/双金共振.test.mjs
   2026-11-09 升级：日线 KDJ 低位阈值 30→20；新增周线 MACD（刚翻红/即将翻红）+ 周线 KDJ（≤20 聚合发散）。

   覆盖：
   一、周 K 聚合（日 K → 周 K 的开高低收量规则）
   二、KDJ「低位→聚合→发散」三连判定（日线周线共用函数，直接喂构造数据）
   三、周线 MACD「刚翻红 / 即将翻红」判定（含三种必须被拒的假信号）
   四、双周期共振端到端（含「只有日线、没有周线」必须不命中——这是本次升级的核心） */
import {
  kdjSeries, macdSeries, detect双金共振,
  聚合成周K, 周线指标, 判断KDJ低位发散, 判断周MACD红临门,
} from "../engine.js";

let 通过 = 0, 失败 = 0;
function 断言(名, 条件, 备注) {
  if (条件) { 通过++; console.log("  ✅", 名, 备注 ? "｜" + 备注 : ""); }
  else { 失败++; console.log("  ❌", 名, 备注 ? "｜" + 备注 : ""); }
}

/* 连续交易日（跳过周末），UTC 解析，跨时区稳定 */
function 交易日(n) {
  const out = [];
  let d = new Date(Date.UTC(2024, 0, 1));
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/* 按「段」造日 K：[天数, 日涨跌率]，首段第三个参数为起始价 */
function 造段(段) {
  const 价 = [];
  let c = 段[0][2];
  for (const [天, 率] of 段) for (let i = 0; i < 天; i++) { c *= 率; 价.push(c); }
  const 日 = 交易日(价.length);
  return 价.map((x, i) => ({
    TRADE_DATE: 日[i],
    OPEN_PRICE: i ? 价[i - 1] : x,
    CLOSE_PRICE: x,
    HIGH_PRICE: x * 1.006,
    LOW_PRICE: x * 0.994,
    VOLUME: 100000,
  }));
}

/* 基准形态：长期缓跌（周线 MACD 贴零轴微负）→ 8 日加速下跌（日线转深绿、KDJ 贴地）
   → 3 日急涨（日线 MACD 当日翻红、日线 KDJ 发散、周线 MACD 即将翻红、周线 KDJ 发散） */
const 基准段 = [[160, 0.9975, 30], [8, 0.985, 0], [3, 1.045, 0]];
/* 同形态但末段涨 4 日 → 周线 MACD 真正翻红（用于验证「刚翻红」分支） */
const 周刚翻红段 = [[160, 0.9975, 30], [8, 0.985, 0], [4, 1.045, 0]];

console.log("一、周 K 聚合规则");
{
  const rows = 造段(基准段);
  const 周 = 聚合成周K(rows);
  断言("周数约为日数 ÷ 5（171 日 → 34~36 周）", 周.length >= 34 && 周.length <= 36, "实际 " + 周.length + " 周 / " + rows.length + " 日");
  断言("首周开盘 = 首日开盘", Math.abs(周[0].OPEN_PRICE - rows[0].OPEN_PRICE) < 1e-9);
  断言("末周收盘 = 末日收盘", Math.abs(周[周.length - 1].CLOSE_PRICE - rows[rows.length - 1].CLOSE_PRICE) < 1e-9);
  断言("周高低包住周内所有日高低", 周.every((w) => w.HIGH_PRICE >= w.LOW_PRICE && w.HIGH_PRICE > 0));
  断言("周日期严格升序", 周.every((w, i) => i === 0 || w.TRADE_DATE > 周[i - 1].TRADE_DATE));
  const 总日量 = rows.reduce((s, r) => s + r.VOLUME, 0);
  const 总周量 = 周.reduce((s, w) => s + w.VOLUME, 0);
  断言("周成交量求和守恒", Math.abs(总日量 - 总周量) < 1e-6, 总日量 + " vs " + 总周量);
}

console.log("二、KDJ「低位 → 聚合 → 向上发散」判定");
{
  /* 命中：K/D 长时间粘在低位（极差 1），末段 K 冲起、J 领涨（极差 30） */
  const K = [...Array(11).fill(15), 30];
  const D = [...Array(11).fill(14), 20];
  const 命中 = 判断KDJ低位发散({ kArr: K, dArr: D, jArr: K.map((k, i) => 3 * k - 2 * D[i]) }, 20, 8, 5);
  断言("低位聚合后发散 → 命中", !!命中, JSON.stringify(命中));
  if (命中) {
    断言("低位值 ≤ 20", 命中.低位值 <= 20, "低位值 " + 命中.低位值);
    断言("聚合间距 ≤ 8", 命中.聚合间距 <= 8, "聚合间距 " + 命中.聚合间距);
    断言("极差扩大 ≥ 3", 命中.当前间距 >= 命中.聚合间距 + 3, 命中.聚合间距 + " → " + 命中.当前间距);
  }

  /* 不命中：K 全程高位（没进过超卖区） */
  const K2 = [...Array(11).fill(60), 75];
  const D2 = [...Array(11).fill(58), 65];
  const 高位 = 判断KDJ低位发散({ kArr: K2, dArr: D2, jArr: K2.map((k, i) => 3 * k - 2 * D2[i]) }, 20, 8, 5);
  断言("K 从未 ≤20（高位启动）→ 不命中", 高位 === null);

  /* 不命中：K 从低位一路拉开，近 5 日从未粘合 */
  const K3 = [5, 10, 18, 26, 34, 42, 50, 58, 66, 74, 82, 90];
  const D3 = [4, 8, 14, 20, 26, 32, 38, 44, 50, 56, 62, 68];
  const 未聚合 = 判断KDJ低位发散({ kArr: K3, dArr: D3, jArr: K3.map((k, i) => 3 * k - 2 * D3[i]) }, 20, 8, 5);
  断言("低位但从头到尾未粘合 → 不命中", 未聚合 === null);

  /* 不命中：粘合了，但发散幅度不足（极差只扩大 2） */
  const K4 = [...Array(11).fill(15), 16];
  const D4 = [...Array(11).fill(15), 15.2];
  const 发散不足 = 判断KDJ低位发散({ kArr: K4, dArr: D4, jArr: K4.map((k, i) => 3 * k - 2 * D4[i]) }, 20, 8, 5);
  断言("粘合后发散不足 3 → 不命中", 发散不足 === null);
}

console.log("三、周线 MACD「刚翻红 / 即将翻红」判定");
{
  const 造MC = (hist) => ({ histArr: hist, difArr: hist.map((x, i) => x / 2 + i * 0.01), deaArr: hist.map(() => 0) });

  const 刚 = 判断周MACD红临门(造MC([-1, -0.8, -0.6, -0.4, -0.2, 0.05, 0.1]), 10);
  断言("绿柱转红柱 → 刚翻红", 刚 && 刚.状态 === "刚翻红", JSON.stringify(刚));

  const 临门 = 判断周MACD红临门(造MC([-1, -0.8, -0.6, -0.4, -0.2, -0.1, -0.05]), 10);
  断言("负值收窄且贴零轴（0.5%）→ 即将翻红", 临门 && 临门.状态 === "即将翻红", JSON.stringify(临门));

  const 扩大 = 判断周MACD红临门(造MC([-1, -0.8, -0.6, -0.4, -0.3, -0.05, -0.12]), 10);
  断言("绿柱重新放大 → 不命中", 扩大 === null);

  const 远离 = 判断周MACD红临门(造MC([-2, -1.8, -1.6, -1.4, -1.2, -1.0, -0.9]), 10);
  断言("绿柱收窄但距零轴 9%（>0.5%）→ 不命中", 远离 === null);
}

console.log("四、双周期共振端到端");
{
  const rows = 造段(基准段);
  const 收 = rows.map((r) => r.CLOSE_PRICE);
  const mc = macdSeries(收);
  const kdj = kdjSeries(rows);
  const 周 = 周线指标(rows);
  const r = detect双金共振(mc, kdj, 周);

  断言("基准形态（日线刚翻红 + 周线临门 + 双周期 KDJ 低位发散）→ 命中", !!r,
    r ? `日线翻红序 ${r.翻红序}、前绿 ${r.前绿}、低位 ${r.低位值}、聚合 ${r.聚合间距}→${r.当前间距}｜周线 ${r.周状态}、柱 ${r.周柱值}、低位 ${r.周低位值}、聚合 ${r.周聚合间距}→${r.周当前间距}、${r.周数} 周` : "未命中");
  if (r) {
    断言("日线低位值 ≤ 20（阈值由 30 收紧）", r.低位值 <= 20, "低位值 " + r.低位值);
    断言("周线低位值 ≤ 20", r.周低位值 <= 20, "周低位值 " + r.周低位值);
    断言("周线状态为刚翻红或即将翻红", r.周状态 === "刚翻红" || r.周状态 === "即将翻红", r.周状态);
    断言("周线 KDJ 聚合后极差扩大 ≥3", r.周当前间距 >= r.周聚合间距 + 3, r.周聚合间距 + " → " + r.周当前间距);
    断言("返回体带周线明细（便于复盘归因）", "周状态" in r && "周数" in r);
  }

  /* 核心回归：只有日线满足、周线数据不足时，必须不命中——旧版只看日线会把这种反弹中继判成 S 级 */
  const 短序列 = 造段([[40, 0.99, 20], [6, 0.988, 0], [2, 1.02, 0]]);
  const 短收 = 短序列.map((r2) => r2.CLOSE_PRICE);
  const 短周 = 周线指标(短序列);
  const 只有日线 = detect双金共振(macdSeries(短收), kdjSeries(短序列), 短周);
  断言("周 K 不足 35 根（周线指标为 null）→ 不命中", 短周 === null && 只有日线 === null,
    "周线指标 " + (短周 ? 短周.周数 + " 周" : "null"));

  /* 持续下跌：KDJ 低位但从不发散、MACD 始终绿柱 */
  const 跌段 = 造段([[180, 0.992, 30]]);
  const 跌收 = 跌段.map((r2) => r2.CLOSE_PRICE);
  const 下跌 = detect双金共振(macdSeries(跌收), kdjSeries(跌段), 周线指标(跌段));
  断言("长期单边下跌 → 不命中", 下跌 === null, 下跌 ? "误命中" : "返回 null");

  /* 高位连涨：KDJ 不在低位 */
  const 涨段 = 造段([[180, 1.004, 10]]);
  const 涨收 = 涨段.map((r2) => r2.CLOSE_PRICE);
  const 高位 = detect双金共振(macdSeries(涨收), kdjSeries(涨段), 周线指标(涨段));
  断言("长期单边上涨（KDJ 高位）→ 不命中", 高位 === null, 高位 ? "误命中" : "返回 null");

  /* 周线真正翻红的分支 */
  const rows2 = 造段(周刚翻红段);
  const 收2 = rows2.map((r2) => r2.CLOSE_PRICE);
  const r2 = detect双金共振(macdSeries(收2), kdjSeries(rows2), 周线指标(rows2));
  断言("末段多涨一日 → 周线走「刚翻红」分支仍命中", !!r2 && r2.周状态 === "刚翻红",
    r2 ? r2.周状态 : "未命中");
}

console.log("\n结果：" + 通过 + " 通过 / " + 失败 + " 失败");
process.exit(失败 ? 1 : 0);
