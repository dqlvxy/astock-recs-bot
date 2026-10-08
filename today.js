// today.js —— 全模块云端快照生成器
//
// 目的：把原先「写死在 HTML 内嵌快照里、永不更新」的模块数据搬到云端，
//       每个交易日 14:30 由 GitHub Actions 重新生成并提交 today.json。
//
// 产出：today.json（结构与前端 T1D 完全一致，可整体覆盖 T1D）
//   {
//     gen_time, trade_date, auction_time,
//     index:{sh,sz,cyb}, market_stat:{up,down,flat,total},
//     zt_total, ladder:{1,2,3,4p}, lhb:[...], yaogu:[...],
//     hit_total, temperature:{...}, main_lines:[...]
//   }
//
// 覆盖模块：妖股雷达 / 连板梯队 / 昨日复盘 / 竞价扫描 / 市场温度 / 大盘指数
import {
  今日键, 是周末, 是休市日, 上一交易日,
  getIndex, getZTPool, getDTPool, 拉全市场,
  mainLines, temperature, 批行业,
  取日K,
} from "./engine.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const 输出文件 = process.env.TODAY_FILE || "today.json";

const 码键 = (d) =>
  d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);

/* 交易日键 → 无横线格式（东财接口用） */
const 无横 = (k) => String(k || "").replace(/-/g, "");

/* ── 1. 大盘指数：转成前端 T1D.index 的结构 ── */
async function 建指数() {
  const idx = await getIndex();
  const out = {};
  const 映 = { "000001": "sh", "399001": "sz", "399006": "cyb" };
  for (const x of idx || []) {
    const k = 映[x.f12] || (x.f12 === "000001" ? "sh" : null);
    if (!k) continue;
    out[k] = {
      name: x.f14 || "",
      price: x.f2 || 0,
      pre_close: x.f18 || 0,
      open: x.f17 || 0,
      high: x.f15 || 0,
      low: x.f16 || 0,
      chg: x.f4 || 0,
      chg_pct: x.f3 || 0,
      amount_wan: x.f6 || 0,
      turnover: x.f8 || 0,
      vol: x.f5 || 0,
      time: String(x.f124 || ""),
    };
  }
  return out;
}

/* ── 2. 连板梯队：按连续板数分层 ── */
function 建梯队(zt) {
  const 层 = { 1: [], 2: [], 3: [], "4p": [] };
  for (const x of zt || []) {
    const lbc = Number(x.lbc || 1);
    const 行 = {
      code: String(x.c || ""),
      name: x.n || "",
      lbc,
      chg: x.zdp != null ? Number(x.zdp) : 10,
      fbt: String(x.fbt || ""),
      zbc: Number(x.zbc || 0),
      hybk: x.hybk || "",
      ltsz_yi: x.ltsz != null ? Math.round((x.ltsz / 1e8) * 10) / 10 : 0,
      fund_yi: x.fund != null ? Math.round((x.fund / 1e8) * 100) / 100 : 0,
    };
    if (lbc >= 4) 层["4p"].push(行);
    else if (lbc === 3) 层[3].push(行);
    else if (lbc === 2) 层[2].push(行);
    else 层[1].push(行);
  }
  for (const k in 层) 层[k].sort((a, b) => (b.ltsz_yi || 0) - (a.ltsz_yi || 0));
  return 层;
}

/* ── 3. 妖股雷达：从涨停池里按五因子打分选出候选 ──
 * 五因子（与前端展示口径一致）：
 *   f1 三日内涨停 25 · f2 竞价换手>2.1% 25 · f3 封板资金 20 · f4 流通市值 15 · f5 换手活跃 15
 * 说明：竞价换手需盘中快照，收盘后生成时以「昨日涨停强度」等替代占位，前端会自行用实时行情刷新价格。 */
function 建妖股(zt, 行业映射) {
  const 候选 = [];
  for (const x of zt || []) {
    const lbc = Number(x.lbc || 1);
    const 封资亿 = x.fund != null ? x.fund / 1e8 : 0;
    const 流通亿 = x.ltsz != null ? x.ltsz / 1e8 : 0;
    const 换手 = x.hs != null ? Number(x.hs) : 0;
    const zbc = Number(x.zbc || 0);

    /* 五因子打分 */
    const f1 = 25;                                              // 当天在涨停池 → 必然三日内涨停
    const f2 = 换手 >= 20 ? 25 : 换手 >= 10 ? 18 : 换手 >= 5 ? 12 : 6;
    const f3 = 封资亿 >= 1 ? 20 : 封资亿 >= 0.5 ? 16 : 封资亿 >= 0.2 ? 12 : 8;
    const f4 = 流通亿 > 0 && 流通亿 <= 30 ? 15 : 流通亿 <= 60 ? 12 : 流通亿 <= 120 ? 8 : 5;
    const f5 = zbc === 0 ? 15 : zbc <= 2 ? 11 : zbc <= 5 ? 7 : 3;
    const score = Math.min(100, f1 + f2 + f3 + f4 + f5);

    候选.push({
      code: String(x.c || ""),
      name: x.n || "",
      price: x.p != null ? Number(x.p) / 100 : 0,
      chg: x.zdp != null ? Number(x.zdp) : 10,
      lbc,
      auction_hs: null,                        // 竞价换手需 09:25 快照，云端收盘后生成时置空
      wei_ratio: null,
      sell_gt_buy: null,
      mv_yi: Math.round(流通亿 * 10) / 10,
      score,
      hit: score >= 85 ? 1 : 0,
      prob_label: score >= 85 ? "高" : score >= 70 ? "中" : "低",
      prob_color: score >= 85 ? "#ff5d5d" : score >= 70 ? "#ff9a3d" : "#8a94a6",
      f1, f2, f3, f4, f5,
      zt3: 1,
      hybk: 行业映射[String(x.c || "")] || x.hybk || "",
      fund_yi: Math.round(封资亿 * 100) / 100,
      fbt: String(x.fbt || ""),
      zbc,
      lhb_net_yi: 0,
      lhb_reason: "",
      turnover: Math.round(换手 * 100) / 100,
    });
  }
  候选.sort((a, b) => b.score - a.score);
  return 候选.slice(0, 60);
}

/* ── 4. 龙虎榜（东财） ── */
async function 建龙虎榜(日) {
  try {
    const d = await fetch(
      "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW" +
        "&columns=ALL&filter=(TRADE_DATE%3D%27" + 日 + "%27)&pageNumber=1&pageSize=80&sortColumns=NET_BUY_AMT&sortTypes=-1" +
        "&source=WEB&client=WEB",
      { headers: { "User-Agent": UA } }
    ).then((r) => r.json());
    const rows = (d && d.result && d.result.data) || [];
    return rows.map((x) => ({
      code: String(x.SECURITY_CODE || ""),
      name: x.SECURITY_NAME_ABBR || "",
      chg: x.CHANGE_RATE != null ? Math.round(Number(x.CHANGE_RATE) * 100) / 100 : 0,
      close: x.CLOSE_PRICE != null ? Number(x.CLOSE_PRICE) : 0,
      turnover: x.TURNOVERRATE != null ? Math.round(Number(x.TURNOVERRATE) * 100) / 100 : 0,
      mcap_yi: x.FREE_MARKET_CAP != null ? Math.round((Number(x.FREE_MARKET_CAP) / 1e8) * 10) / 10 : 0,
      buy_yi: x.BILLBOARD_BUY_AMT != null ? Math.round((Number(x.BILLBOARD_BUY_AMT) / 1e8) * 100) / 100 : 0,
      sell_yi: x.BILLBOARD_SELL_AMT != null ? Math.round((Number(x.BILLBOARD_SELL_AMT) / 1e8) * 100) / 100 : 0,
      net_yi: x.NET_BUY_AMT != null ? Math.round((Number(x.NET_BUY_AMT) / 1e8) * 100) / 100 : 0,
      reason: x.EXPLAIN || "",
      explain: x.EXPLANATION || "",
      is_org: /机构/.test(String(x.EXPLANATION || "")) ? 1 : 0,
    }));
  } catch (e) {
    return [];
  }
}

/* ── 5. 自选关注：只拉行情，不改列表 ──
 * 说明：自选列表是「用户资产」（他关注哪些票），云端无权生成或覆盖，
 *       故本模块只负责按 watchlist.json 里登记的代码拉最新行情与 K 线，
 *       保证换设备打开时自选股的价格/走势也是新的。
 * 列表来源优先级：watchlist.json（仓库内，可手工编辑/由前端上报）> 内置兜底清单。 */
const 自选兜底 = ["588170","515880","159995","501096","512400","501046","515330"];

function 读自选清单(){
  try{
    const p = process.env.WATCH_FILE || "watchlist.json";
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      const arr = Array.isArray(raw) ? raw : (raw.items || raw.codes || []);
      const 码 = arr.map((x) => (typeof x === "string" ? x : x && x.code)).filter(Boolean);
      if (码.length) return 码.map(String);
    }
  }catch(e){}
  return 自选兜底.slice();
}

/* 批量取腾讯行情：ETF/LOF 不在东财全市场股票接口里，必须单独取。
 * 返回 { 代码: {name, price, pre_close, pct, turnover, amount_yi, ...} }
 * 腾讯字段位（~ 分隔）：1名称 2代码 3现价 4昨收 5今开 6成交量 31涨跌 32涨跌% 33最高 34最低 36成交量 37成交额(万) 38换手 */
async function 批腾讯行情(码表){
  const 映 = {};
  try{
    const 带前缀 = 码表.map((c) => (/^[a-z]{2}/.test(c) ? c : (c.charAt(0) === "6" || c.charAt(0) === "5" ? "sh" + c : "sz" + c)));
    const r = await fetch("https://qt.gtimg.cn/q=" + 带前缀.join(","), { headers: { "User-Agent": UA } });
    const buf = await r.arrayBuffer();
    const t = new TextDecoder("gbk").decode(buf);
    for (const seg of t.split(";")) {
      const m = seg.match(/v_([a-z]{2}\d{6})="([^"]*)"/);
      if (!m) continue;
      const 部 = m[2].split("~");
      const 码 = 部[2] || m[1].slice(2);
      const 数 = (i) => { const v = parseFloat(部[i]); return isNaN(v) ? null : v; };
      映[码] = {
        name: 部[1] || "",
        price: 数(3),
        pre_close: 数(4),
        pct: 数(32),
        turnover: 数(38),
        amount_yi: 数(37) != null ? Math.round((数(37) / 10000) * 100) / 100 : null,
        vol_ratio: null,
      };
    }
  }catch(e){}
  return 映;
}

/* 由日K自算统计指标，产出与前端 renderWatch 消费的 prob 结构一致。
 *
 * 为什么要在这里算：
 *   自选卡片要显示「68%区间 / 涨超1% / 跌超1% / 近5日动量 / 20日均收益 /
 *   20日波动 / 次日置信分」。原先这些字段指望数据源给，但本脚本 early
 *   版本直接写了 prob: null，导致走云端的自选卡片这些格子全是「—」「-」。
 *   前端已加 K 线自算兜底，这里同步产出，做到「云端给了就用、没给前端自己算」。
 *
 * 口径（近 20 个交易日日收益率，样本标准差）：
 *   momentum  近5日涨跌幅              (收盘/5日前收盘 - 1) × 100
 *   mean_ret  日收益率均值
 *   std       日收益率样本标准差
 *   range     现价 × (1 ± std/100)
 *   p_down1   正态假设 P(日收益 < -1%)
 *   p_up1     正态假设 P(日收益 > +1%)
 *   score / prob_up  由「涨跌概率差」与动量方向合成
 * 注：该口径与前端 自算自选概率() 完全一致，改一处必须同步另一处。 */
function 算自选概率(kline) {
  try {
    if (!kline || kline.length < 16) return null;
    const cl = kline.map((r) => Number(r[2])).filter((v) => v > 0);
    if (cl.length < 16) return null;
    const n = cl.length, 现价 = cl[n - 1];

    const 全 = [];
    for (let j = 1; j < n; j++) 全.push(((cl[j] - cl[j - 1]) / cl[j - 1]) * 100);
    const r = 全.slice(-20);
    if (r.length < 15) return null;

    const 均 = r.reduce((s, v) => s + v, 0) / r.length;
    const 方 = r.reduce((s, v) => s + (v - 均) * (v - 均), 0) / (r.length - 1);
    const 标 = Math.sqrt(方);
    if (!(标 > 0)) return null;

    const 动 = (cl[n - 1] / cl[Math.max(0, n - 6)] - 1) * 100;

    /* 标准正态 CDF（Abramowitz-Stegun 近似） */
    const 正态 = (z) => {
      const 符 = z < 0 ? -1 : 1, x = Math.abs(z);
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
            a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const t = 1 / (1 + p * x);
      const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return 0.5 * (1 + 符 * y);
    };
    const 取整 = (x, d) => { const q = Math.pow(10, d); return Math.round(x * q) / q; };

    const 跌超1 = 100 * 正态((-1 - 均) / 标);
    const 涨超1 = 100 * (1 - 正态((1 - 均) / 标));
    const 净 = 涨超1 - 跌超1;
    const 分 = Math.max(0, Math.min(100, 50 + 净 * 0.42 + 动 * 1.6));
    const 置信 = Math.max(0, Math.min(99, 50 + 净 * 0.30 + 动 * 1.2));

    const 片 = cl.slice(-20);
    const 高20 = Math.max(...片), 低20 = Math.min(...片);
    const 位 = (高20 - 低20) > 0 ? (现价 - 低20) / (高20 - 低20) : 0.5;
    let 语;
    if (动 > 4) 语 = "近5日动量偏强";
    else if (动 < -4) 语 = "近5日动量偏弱";
    else if (标 > 2.8) 语 = "近期波动较大，仓位宜轻";
    else 语 = "动量与波动处于中性区间";
    if (位 > 0.85 && 动 > 0) 语 += "；现价接近20日高点，短期回归压力";
    if (位 < 0.15 && 动 < 0) 语 += "；现价接近20日低点，存在修复动能";

    return {
      momentum: 取整(动, 2),
      mean_ret: 取整(均, 2),
      std: 取整(标, 2),
      range_lo: 取整(现价 * (1 - 标 / 100), 4),
      range_hi: 取整(现价 * (1 + 标 / 100), 4),
      score: 取整(分, 1),
      prob_up: 取整(置信, 1),
      p_up1: 取整(涨超1, 1),
      p_down1: 取整(跌超1, 1),
      note: 语,
    };
  } catch (e) { return null; }
}

async function 建自选(全市场映射){
  const 码表 = 读自选清单();
  /* ETF/LOF 取腾讯行情（东财全市场不含基金），个股优先用全市场数据 */
  const 腾讯表 = await 批腾讯行情(码表);
  const items = [];
  for (const code of 码表) {
    const 行 = 全市场映射[code] || 腾讯表[code] || null;
    let kline = [];
    try {
      const rows = await 取日K(code);
      /* 取 60 根：前端要用近 20 个日收益率算波动率与区间概率，
         只给 20 根会差一根凑不满样本。多给不占多少体积，还能画更长的 K 线。 */
      kline = (rows || []).slice(-60).map((r) => [
        r.TRADE_DATE, r.OPEN_PRICE, r.CLOSE_PRICE, r.HIGH_PRICE, r.LOW_PRICE, r.VOLUME,
      ]);
    } catch (e) {}
    const 收盘 = kline.length ? kline[kline.length - 1][2] : (行 ? 行.price : null);
    const 前收 = kline.length > 1 ? kline[kline.length - 2][2] : (行 ? 行.pre_close : null);
    let pct = (收盘 != null && 前收) ? Math.round(((收盘 - 前收) / 前收) * 10000) / 100 : null;
    if (pct == null && 行) pct = (行.pct != null ? 行.pct : 行.chg);
    if (pct == null) pct = 0;
    pct = Math.round(pct * 100) / 100;
    const recent5 = kline.slice(-6).map((r, i, a) => ({
      d: String(r[0] || "").slice(5), c: r[2],
      pct: i > 0 && a[i - 1][2] ? Math.round(((r[2] - a[i - 1][2]) / a[i - 1][2]) * 10000) / 100 : 0,
    })).slice(1);
    /* 量比自算：ETF/LOF 在腾讯与东财接口都拿不到量比，用 K 线量能倒推。
       口径：当日成交量 ÷ 之前 5 个交易日平均成交量（与常见行情软件近似）。 */
    let 量比 = 行 ? Number(行.vol_ratio || 0) : 0;
    if (!量比 && kline.length >= 6) {
      const 末 = Number(kline[kline.length - 1][5]) || 0;
      const 前五 = kline.slice(-6, -1).map((r) => Number(r[5]) || 0);
      const 均 = 前五.reduce((s, v) => s + v, 0) / (前五.length || 1);
      if (均 > 0 && 末 > 0) 量比 = Math.round((末 / 均) * 100) / 100;
    }
    /* 换手/成交额：接口没给时留 0，前端会显示「—」，不做无依据估算 */
    items.push({
      code,
      name: (行 && 行.name) || (腾讯表[code] && 腾讯表[code].name) || code,
      price: 收盘,
      chg: pct,
      pct,
      turnover: 行 ? (行.turnover || 0) : 0,
      vol_ratio: 量比,
      amt_yi: 行 ? (行.amount_yi || 0) : 0,
      /* 由日K自算：区间 / 涨跌超1%概率 / 动量 / 波动 / 置信分 */
      prob: 算自选概率(kline),
      kline,
      recent5,
    });
  }
  return { ok: true, updated: new Date().toLocaleString("sv-SE").replace("T", " "), items };
}

/* 数据归属交易日：这份快照的数据「属于哪一天」。
 *
 * 关键：不能用「今天是交易日 → 就写今天」。原因是本脚本有两个运行时机：
 *   · 14:30 定时跑（A股盘中）→ 抓到的是当日实时数据，应标当日；
 *   · 凌晨 / 盘前 / 周末补跑   → 抓到的是「上一交易日收盘」的数据，
 *     若仍标当日，前端会显示成「今天是这个数据日」，历史复盘时日期全错。
 * 判据：处于交易时段（9:15~15:05）且当日为交易日 → 当日；否则回溯到最近收盘交易日。
 * 这样 14:30 定时正确、凌晨补跑也正确。 */
function 数据归属日(){
  const d = new Date();
  const 分 = d.getHours() * 60 + d.getMinutes();
  const 在盘中 = 分 >= 9 * 60 + 15 && 分 <= 15 * 60 + 5;   /* 9:15 ~ 15:05 */
  const 今 = 今日键();
  if (在盘中 && !是周末() && !是休市日(今)) return 今;
  return 上一交易日();
}

async function main() {
  const 今日 = 今日键();
  const 是交易日 = !(是周末() || 是休市日(今日));
  const 数据日 = 数据归属日();
  console.log(`开始生成全模块云端快照：运行日=${今日}（交易日=${是交易日}）· 数据归属日=${数据日}`);

  /* ① 指数 & 涨跌家数 */
  console.log("  [1/7] 拉大盘指数…");
  const index = await 建指数();

  /* ② 全市场统计 */
  console.log("  [2/7] 拉全市场行情…");
  let 全 = [];
  try { 全 = await 拉全市场(); } catch (e) { 全 = []; }
  let up = 0, down = 0, flat = 0;
  for (const x of 全) {
    const c = x.f3 != null ? Number(x.f3) : 0;
    if (c > 0) up++; else if (c < 0) down++; else flat++;
  }
  const market_stat = { up, down, flat, total: 全.length };

  /* ③ 涨停池 / 跌停数 */
  console.log("  [3/7] 拉涨停池…");
  const zt = await getZTPool();
  const dtN = await getDTPool();
  let zbN = 0;
  for (const x of zt || []) if (Number(x.zbc || 0) > 0) zbN++;

  /* ④ 梯队 + 行业归属 */
  console.log(`  [4/7] 建连板梯队（涨停 ${zt.length} 只）…`);
  let 行业映射 = {};
  try {
    行业映射 = await 批行业((zt || []).slice(0, 60).map((x) => ({ code: String(x.c || "") })));
  } catch (e) {}
  const ladder = 建梯队(zt);

  /* ⑤ 妖股雷达 */
  console.log("  [5/7] 建妖股雷达候选…");
  const yaogu = 建妖股(zt, 行业映射);
  const hit_total = yaogu.filter((x) => x.hit).length;

  /* ⑥ 龙虎榜 + 市场温度 + 主线 */
  console.log("  [6/7] 龙虎榜 / 温度 / 主线…");
  const 交易键 = 无横(数据日);
  const lhb = await 建龙虎榜(交易键);
  const 温 = temperature(index ? Object.entries(index).map(([k, v]) => ({
    f12: k === "sh" ? "000001" : k === "sz" ? "399001" : "399006",
    f3: v.chg_pct, f2: v.price, f14: v.name,
  })) : [], zt, dtN, zbN);
  const 主线 = mainLines(zt);

  /* ⑦ 自选关注行情 */
  console.log("  [7/7] 自选关注行情…");
  let 全市场映射 = {};
  for (const x of 全) 全市场映射[String(x.f12 || x.code || "")] = x;
  let watch = { ok: true, items: [] };
  try { watch = await 建自选(全市场映射); } catch (e) { console.log("  自选生成失败：", e.message); }

  const 包 = {
    ok: true,
    gen_time: new Date().toLocaleString("sv-SE").replace("T", " "),
    trade_date: 数据日,
    auction_time: "",
    index,
    market_stat,
    zt_total: (zt || []).length,
    ladder,
    lhb,
    yaogu,
    hit_total,
    temperature: 温,
    main_lines: 主线,
    watch: watch,
  };

  writeFileSync(输出文件, JSON.stringify(包, null, 2), "utf-8");
  /* 自选单独出文件，便于前端按需拉取/上报 */
  try { writeFileSync("watch.json", JSON.stringify(watch, null, 2), "utf-8"); } catch (e) {}
  console.log(
    `✅ 已写入 ${输出文件}：指数 ${Object.keys(index).length} 个 · 涨停 ${包.zt_total} · ` +
      `梯队 ${Object.values(ladder).reduce((s, v) => s + v.length, 0)} · 妖股 ${yaogu.length}(命中 ${hit_total}) · 龙虎榜 ${lhb.length} · 自选 ${watch.items.length}`
  );
}

main().catch((e) => {
  console.error("快照生成失败：", e);
  process.exit(1);
});
