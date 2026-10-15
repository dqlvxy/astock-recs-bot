// review.js —— 每日收盘后复盘闭环
//  1) 读 recs.json 全部历史荐股
//  2) 对「推荐日之后第一个交易日」已发生的期，拉个股日K，算「次日收盘」相对「推荐日收盘」涨跌
//  3) 归因失败票：次日跌幅 / 推荐日涨幅(是否高位追高) / 量比 / 换手 / 当日大盘
//  4) 统计滚动成功率 + 失败模式
//  5) 输出 review_log.json（逐期明细）+ review.md（人类可读复盘报告）
//  6) 生成 params.json 的 cfg（滚动成功率低→温和收紧阈值，含硬上下限），供 engine.js 次日读取自适应
//
// 由 .github/workflows/review.yml 每天收盘后（北京时间 15:30 = UTC 07:30）自动触发
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

const 存档文件 = process.env.RECS_FILE || "recs.json";
const 复盘文件 = process.env.REVIEW_FILE || "review_log.json";
const 参数文件 = process.env.PARAMS_FILE || "params.json";
const 报告文件 = process.env.REVIEW_MD || "review.md";

// 带超时 + 重试的 JSON GET
async function j(url, { timeout = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const 控 = new AbortController();
    const t = setTimeout(() => 控.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: 控.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr || new Error("fetch 失败");
}

// 板块前缀：60/68 → 沪(1.)，00/30 → 深(0.)
function secid(code) {
  const c = String(code);
  if (/^6/.test(c)) return "1." + c;
  return "0." + c;
}

// 拉近 N 日 日K（前复权）：返回 [{date:"2026-10-08", close:12.34}]
async function 拉K线(code, lmt = 15) {
  return 拉K线Sec(secid(code), lmt);
}

// 拉K线（secid 直传）：专供指数使用。secid() 只懂个股板块前缀，
// 上证指数 000001 会被判成深市平安银行(0.000001)——「大盘涨跌」语义全错，故指数必须直传 1.000001
async function 拉K线Sec(sec, lmt = 15) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?` +
    `secid=${sec}&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&beg=0&end=20500101&lmt=${lmt}`;
  try {
    const d = await j(url);
    if (!d || !d.data || !d.data.klines) return null;
    return d.data.klines.map((k) => {
      const [date, close] = k.split(",");
      return { date, close: parseFloat(close) };
    });
  } catch (e) {
    return null;
  }
}

// 在K线里定位推荐日 index，取 index+1（下一交易日）收盘，算次日涨跌%
function 次日涨跌(kline, recDate) {
  if (!kline || !kline.length) return null;
  for (let i = 0; i < kline.length - 1; i++) {
    if (kline[i].date.replace(/-/g, "") === String(recDate)) {
      const c0 = kline[i].close;
      const c1 = kline[i + 1].close;
      if (c0 > 0 && c1 > 0) return ((c1 - c0) / c0) * 100;
    }
  }
  return null;
}

// 大盘当日涨跌（上证指数日K，secid=1.000001 直传）
async function 大盘涨跌(date) {
  const kline = await 拉K线Sec("1.000001", 15);
  if (!kline) return null;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].date.replace(/-/g, "") === String(date)) {
      const c = kline[i].close;
      const pc = i > 0 ? kline[i - 1].close : null;
      if (pc > 0) return ((c - pc) / pc) * 100;
      return null;
    }
  }
  return null;
}

// 近5交易日涨停/接近涨停次数（复刻 engine.js hardFilter 口径：3x/688 涨停线 19.8%、其余 9.8%，
// 单日涨幅 ≥ 涨停线×0.98 计一次；窗口 = 推荐日往前 5 个交易日，逐日 vs 前收）。
// 背景：engine 产出端从未落过 near_limit_up 字段，归档/复盘两侧该判据一直空转（连板失败率恒 0）。
// 复盘侧已拉到每票日K，按同一口径重算——历史期与未来期一并补齐，不依赖归档补字段。
function 近5涨停数(kline, recDate, code) {
  if (!kline || !kline.length) return null;
  const c = String(code || "");
  const 涨停线 = c.charAt(0) === "3" || c.startsWith("688") ? 0.198 : 0.098;
  let i0 = -1;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].date.replace(/-/g, "") === String(recDate)) { i0 = i; break; }
  }
  if (i0 < 1) return null;
  let n = 0;
  for (let i = Math.max(1, i0 - 4); i <= i0; i++) {
    const 昨 = kline[i - 1].close, 今 = kline[i].close;
    if (昨 > 0 && 今 > 0 && (今 - 昨) / 昨 >= 涨停线 * 0.98) n++;
  }
  return n;
}

// 推荐日前近5日累计涨幅（复刻 engine.js 急涨口径：推荐日收盘 vs 其前第 5 个交易日收盘）。
// 归档白名单 10-14 才补传 pct_chg_5d，此前历史期该字段为 null，急涨归因空转——同样按日K重算兜底。
function 近5涨幅(kline, recDate) {
  if (!kline || !kline.length) return null;
  let i0 = -1;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].date.replace(/-/g, "") === String(recDate)) { i0 = i; break; }
  }
  if (i0 < 6) return null;
  const 起 = kline[i0 - 5].close, 终 = kline[i0].close;
  if (!(起 > 0) || !(终 > 0)) return null;
  return Math.round(((终 - 起) / 起) * 10000) / 100;
}

// 默认参数 + 硬上下限保护
function 默认参数() {
  return {
    updated: "",
    note: "由 review.js 根据近 N 期滚动成功率自动生成；engine.js 读取后对硬门槛做温和、有界的收紧。",
    cfg: { 追高上限: 5, 量比上限: 5, 换手上限: 20, 温度下限: 35, 连板阈值: 2, 止损率: 0.92, 急涨上限: 30 },
    stats: { 期数: 0, 样本票数: 0, 胜数: 0, 成功率: null, 追高失败率: null, 情绪失败率: null, 弱市失败率: null, 平均失败跌幅: null, 急涨失败率: null },
  };
}
const 限 = { 追高上限: [2, 6], 量比上限: [3, 8], 换手上限: [10, 35], 温度下限: [30, 50], 连板阈值: [1, 5], 止损率: [0.85, 0.97], 急涨上限: [15, 60] };
const 钳 = (v, k) => {
  const [lo, hi] = 限[k];
  return Math.min(hi, Math.max(lo, v));
};

function 算优化参数(items) {
  const 参数 = 默认参数();
  const 有效 = items.filter((x) => x.verifiable);
  if (!有效.length) return 参数;
  const total = 有效.reduce((s, x) => s + x.picks.length, 0);
  const win = 有效.reduce((s, x) => s + x.picks.filter((p) => p.ret > 0).length, 0);
  const 成功率 = total ? Math.round((win / total) * 1000) / 10 : null;
  const 失败 = 有效.flatMap((x) => x.picks.filter((p) => p.ret < 0).map((p) => ({ ...p, 大盘: x.market_chg })));
  const 追高失败率 = 失败.length ? 失败.filter((p) => p.chg != null && p.chg >= 4).length / 失败.length : null;
  const 情绪失败率 = 失败.length ? 失败.filter((p) => p.vr > 5 || p.turn > 20).length / 失败.length : null;
  const 弱市失败率 = 失败.length ? 失败.filter((p) => p.大盘 != null && p.大盘 < 0).length / 失败.length : null;
  const 平均失败跌幅 = 失败.length ? Math.round((失败.reduce((s, p) => s + p.ret, 0) / 失败.length) * 10) / 10 : null;
  const 连板失败率 = 失败.length ? 失败.filter((p) => p.near_limit_up != null && p.near_limit_up >= 2).length / 失败.length : null;
  const 急涨失败率 = 失败.length ? 失败.filter((p) => p.chg5 != null && p.chg5 >= 30).length / 失败.length : null;

  const cfg = 参数.cfg;
  // 滚动成功率低 → 收紧追高 + 提高弱市门槛
  if (成功率 != null && 成功率 < 40) {
    cfg.追高上限 = 钳(Math.min(cfg.追高上限, 4), "追高上限");
    cfg.温度下限 = 钳(Math.max(cfg.温度下限, cfg.温度下限 + 3), "温度下限");
  } else if (成功率 != null && 成功率 < 50) {
    cfg.追高上限 = 钳(Math.min(cfg.追高上限, 4.5), "追高上限");
  }
  // 失败票多因高位追高 → 收紧追高上限
  if (追高失败率 != null && 追高失败率 > 0.5) cfg.追高上限 = 钳(Math.min(cfg.追高上限, 4), "追高上限");
  // 失败票多因情绪 → 收紧量比上限
  if (情绪失败率 != null && 情绪失败率 > 0.4) cfg.量比上限 = 钳(Math.min(cfg.量比上限, 4), "量比上限");
  // 失败票集中在大盘下跌日 → 提高弱市门槛
  if (弱市失败率 != null && 弱市失败率 > 0.6) cfg.温度下限 = 钳(Math.min(45, Math.max(35, cfg.温度下限 + 2)), "温度下限");
  // 失败平均跌幅深 → 止损更严（0.94 = 止损 -6%）
  if (平均失败跌幅 != null && 平均失败跌幅 < -10) cfg.止损率 = 钳(0.94, "止损率");
  // 连板/接近连板失败占比高 → 提高连板剔除阈值（1 最严）
  if (连板失败率 != null && 连板失败率 > 0.5) cfg.连板阈值 = 钳(Math.max(1, cfg.连板阈值 - 1), "连板阈值");
  // 失败票多因90度急拉（近5日涨幅≥30%）→ 收紧急涨上限
  if (急涨失败率 != null && 急涨失败率 > 0.5) cfg.急涨上限 = 钳(Math.min(cfg.急涨上限, 20), "急涨上限");

  参数.cfg = cfg;
  参数.stats = { 期数: 有效.length, 样本票数: total, 胜数: win, 成功率, 追高失败率, 情绪失败率, 弱市失败率, 平均失败跌幅, 连板失败率, 急涨失败率 };
  参数.updated = new Date().toLocaleString("sv-SE").replace("T", " ");
  return 参数;
}

async function 主流程() {
  let 包 = { recs: [] };
  try { 包 = JSON.parse(readFileSync(存档文件, "utf-8")); } catch (e) {}
  const recs = (包.recs || []).sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`复盘 ${recs.length} 期存档…`);

  // 已复盘记录（保留历史固定期，避免下次重复验证）
  let done = {};
  if (existsSync(复盘文件)) {
    try { const rr = JSON.parse(readFileSync(复盘文件, "utf-8")); (rr.items || []).forEach((x) => x && (done[x.date] = 1)); } catch (e) {}
  }

  const items = [];
  for (const g of recs) {
    const 期 = { date: g.date, gen_time: g.gen_time || "", picks: [], verifiable: false, market_chg: null, success: null };
    const picks = g.picks || [];
    if (!picks.length) continue;
    // 推荐日之后第一个交易日是否已发生：拉该期第一只票K线，看推荐日 index+1 是否存在
    let kline = await 拉K线(picks[0].code, 15);
    let 次日存在 = false;
    if (kline) {
      for (let i = 0; i < kline.length - 1; i++) if (kline[i].date.replace(/-/g, "") === String(g.date)) { 次日存在 = true; break; }
    }
    if (!次日存在) { console.log(`  期 ${g.date}: 次日尚未发生，跳过（待下次复盘）`); continue; }
    期.verifiable = true;
    期.market_chg = await 大盘涨跌(g.date);
    let 涨 = 0;
    for (const p of picks) {
      const kl = await 拉K线(p.code, 15);   // 每只票独立拉K线，不能复用
      const ret = 次日涨跌(kl, g.date);
      const r = {
        code: p.code, name: p.name, score: p.score, prob: p.prob,
        chg: p.pct_chg != null ? p.pct_chg : null,   // 推荐日涨幅（追高判据）
        vr: p.vol_ratio != null ? p.vol_ratio : null,  // 量比
        turn: p.turnover != null ? p.turnover : null,  // 换手
        near_limit_up: p.near_limit_up != null ? p.near_limit_up : 近5涨停数(kl, g.date, p.code),
        chg5: p.pct_chg_5d != null ? p.pct_chg_5d : 近5涨幅(kl, g.date),   // 推荐日前近5日累计涨幅（急涨判据）
        ret: ret != null ? Math.round(ret * 100) / 100 : null,
      };
      if (ret != null && ret > 0) 涨++;
      期.picks.push(r);
    }
    期.success = 期.picks.filter((p) => p.ret != null).length ? 涨 : null;
    items.push(期);
    console.log(`  期 ${g.date}: ${期.picks.filter((p)=>p.ret!=null).length}/${期.picks.length} 可验证，胜 ${涨} 只`);
  }

  // 合并：历史固定期 + 本次新复盘期（按 date 去重，保留本次）
  const 历史项 = existsSync(复盘文件) ? (JSON.parse(readFileSync(复盘文件, "utf-8")).items || []) : [];
  const 合并 = {};
  for (const it of 历史项) if (it && it.date && !it.verifiable) 合并[it.date] = it;
  for (const it of items) if (it && it.date) 合并[it.date] = it;
  const 全部项 = Object.values(合并).sort((a, b) => (a.date < b.date ? -1 : 1));

  const 参数 = 算优化参数(全部项.filter((x) => x.verifiable));

  const 复盘包 = { ok: true, updated: new Date().toLocaleString("sv-SE").replace("T", " "), count: 全部项.length, items: 全部项 };
  writeFileSync(复盘文件, JSON.stringify(复盘包, null, 2), "utf-8");
  writeFileSync(参数文件, JSON.stringify(参数, null, 2), "utf-8");

  // 人类可读复盘报告 review.md
  const 线 = (s) => s + "\n";
  let md = 线("# 每日荐股复盘报告");
  md += 线("> 由 review.js 在每日收盘后自动生成（北京时间 15:30），验证上期荐股「次日收盘」表现并归因失败。");
  md += 线("");
  md += 线("## 滚动统计（近 N 期已到次日）");
  const st = 参数.stats;
  md += 线(`- 样本期数：**${st.期数}** · 样本票数：**${st.样本票数}** · 次日收涨 **${st.胜数}** 只`);
  md += 线(`- 滚动成功率：**${st.成功率 == null ? "—" : st.成功率 + "%"}**（次日收盘上涨的票占比）`);
  md += 线(`- 追高失败率（推荐日涨幅≥4% 后失败）：${st.追高失败率 == null ? "—" : (Math.round(st.追高失败率 * 100) + "%")}`);
  md += 线(`- 情绪失败率（量比>5/换手>20 后失败）：${st.情绪失败率 == null ? "—" : (Math.round(st.情绪失败率 * 100) + "%")}`);
  md += 线(`- 弱市失败率（大盘下跌日失败占比）：${st.弱市失败率 == null ? "—" : (Math.round(st.弱市失败率 * 100) + "%")}`);
  md += 线(`- 连板/接近连板失败率：${st.连板失败率 == null ? "—" : (Math.round(st.连板失败率 * 100) + "%")}`);
  md += 线(`- 急涨失败率（近5日涨幅≥30% 后失败）：${st.急涨失败率 == null ? "—" : (Math.round(st.急涨失败率 * 100) + "%")}`);
  md += 线(`- 平均失败跌幅：**${st.平均失败跌幅 == null ? "—" : st.平均失败跌幅 + "%"}**`);
  md += 线("");
  md += 线("## 本轮优化后的引擎参数（engine.js 将读取）");
  const cg = 参数.cfg;
  md += 线(`- 追高上限（当日涨幅≥此值不追）：**${cg.追高上限}%**`);
  md += 线(`- 量比上限（>此值剔情绪票）：**${cg.量比上限}**`);
  md += 线(`- 换手上限（>此值剔情绪票）：**${cg.换手上限}%**`);
  md += 线(`- 弱市温度下限（<此值空仓停推）：**${cg.温度下限}**`);
  md += 线(`- 接近连板剔除阈值（近5日≥此次数涨停剔除）：**${cg.连板阈值}**`);
  md += 线(`- 急涨上限（近5日累计涨幅≥此值剔除，90度斜率）：**${cg.急涨上限}%**`);
  md += 线(`- 统一止损率：**${Math.round((1 - cg.止损率) * 100)}%**（buyPrice × ${cg.止损率}）`);
  md += 线("");
  md += 线("## 各期明细");
  for (const it of 全部项) {
    if (!it.verifiable) { md += 线(`- **${it.date}**：尚未到次日，待验证`); continue; }
    const ok = it.picks.filter((p) => p.ret != null && p.ret > 0).length;
    const tot = it.picks.filter((p) => p.ret != null).length;
    md += 线(`- **${it.date}**（大盘 ${it.market_chg == null ? "—" : it.market_chg + "%"}）：${ok}/${tot} 胜`);
    for (const p of it.picks) {
      const 涨跌 = p.ret == null ? "—" : (p.ret > 0 ? "🔺" + p.ret + "%" : "🔻" + p.ret + "%");
      md += 线(`   - ${p.name}(${p.code}) 次日收盘 ${涨跌}｜推荐日涨幅 ${p.chg == null ? "—" : p.chg + "%"}｜量比 ${p.vr ?? "—"}｜换手 ${p.turn ?? "—"}%`);
    }
  }
  writeFileSync(报告文件, md, "utf-8");

  console.log(`✅ 复盘完成：${全部项.filter((x) => x.verifiable).length} 期可验证，滚动成功率 ${st.成功率 == null ? "—" : st.成功率 + "%"}`);
  console.log(`   产出 ${复盘文件} / ${参数文件} / ${报告文件}`);
}

主流程().catch((e) => { console.error(e); process.exit(1); });
