// review.js —— 每日收盘后复盘闭环
//  1) 读 recs.json 全部历史荐股（2026-11-09 起保留近 180 天，约 120 期）
//  2) 对「推荐日之后第一个交易日」已发生的期，拉个股日K，算 T+1 / T+3 / T+5 收盘相对推荐日收盘的涨跌
//  3) 归因失败票（2026-10-16 重锚持股日：用户在荐股日 14:50 买入，荐股日波动不计入盈亏）：
//     持股日归因共十三因子（数量不固定、可继续扩展；因子名统一 4 字），全部解释持股日盈亏——
//     市场类 5：弱市 / 板块 / 独跌 / 闷杀（跳空≤-5%贴地）/ 放量（量≥1.5倍）；
//     形态类 4：低开（隔夜冲击，跳空≤-3%）/ 回落（盘中最高涨≥1% 而收跌≥2%）/
//               缩量（量≤0.8倍且跌）/ 破位（荐股日在 MA5 上方、持股日下穿 MA5）；
//     高位类 2：追高（荐日涨幅≥4%→持股日回吐）/ 急涨（荐日前5日累计≥30%→持股日急跌）；
//     （原「情绪」量比换手、「连板」两条已于 2026-11-09 随引擎关卡一并删除）
//  4) 统计滚动成功率 + 失败模式 + 近 6 个月胜率（T+1/T+3/T+5，并分 S 级 / A 级）
//  5) 输出 review_log.json（逐期明细）+ review.md（人类可读复盘报告），均保留近 180 天
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

async function 拉K线字段(sec, lmt, f1, f2, 段数) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?` +
    `secid=${sec}&fields1=${f1}&fields2=${f2}&klt=101&fqt=1&beg=0&end=20500101&lmt=${lmt}`;
  try {
    const d = await j(url);
    if (!d || !d.data || !d.data.klines) return null;
    return d.data.klines.map((k) => {
      const 段 = k.split(",");
      /* f51日期,f52开,f53收,f54高,f55低,f56量,f57额：close 恒为 段[2]（7段）或 段[1]（2段回退）。
         曾经错写成 段[段数-1]（成交额）→ 大盘涨跌 19%/-19%、ret 全错（2026-10-15 事故二） */
      const r = { date: 段[0], close: parseFloat(段数 >= 6 ? 段[2] : 段[1]) };
      if (段数 >= 6) {
        r.open = parseFloat(段[1]); r.high = parseFloat(段[3]); r.low = parseFloat(段[4]); r.vol = parseFloat(段[5]);
      }
      return r;
    });
  } catch (e) {
    return null;
  }
}

// 拉K线（secid 直传）：专供指数使用。secid() 只懂个股板块前缀，
// 上证指数 000001 会被判成深市平安银行(0.000001)——「大盘涨跌」语义全错，故指数必须直传 1.000001
// fields2 = f51日期,f52开,f53收,f54高,f55低,f56量,f57额：持股日解剖要跳空/最低/量能，只收 close 不够
// 双保险：扩展字段失败（东财对参数组合敏感，2026-10-15 实测曾整批报错）→ 回退最小字段集
//（date+close），保证次日涨跌/近5涨停/近5涨幅不空转；持股日解剖字段缺失时归因少几项但不炸
async function 拉K线Sec(sec, lmt = 15) {
  const k = await 拉K线字段(sec, lmt, "f1,f2,f3,f4,f5,f6", "f51,f52,f53,f54,f55,f56,f57", 7);
  if (k && k.length) return k;
  return 拉K线字段(sec, lmt, "f1,f2,f3", "f51,f53", 2);
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

/* 多周期收益（2026-11-09 老板要求：统计 6 个月胜率）。
   同一根 K 线里一次定位推荐日，顺带取 T+1 / T+3 / T+5 收盘：
   ret1 = 次日收盘（与既有口径完全一致，滚动成功率仍按它算，保证可比）；
   ret3 / ret5 = 持股 3 / 5 个交易日收盘。未发生的周期返回 null，不参与统计。 */
function 多日涨跌(kline, recDate) {
  const 空 = { ret1: null, ret3: null, ret5: null };
  if (!kline || !kline.length) return 空;
  let i0 = -1;
  for (let i = 0; i < kline.length; i++) {
    if (kline[i].date.replace(/-/g, "") === String(recDate)) { i0 = i; break; }
  }
  if (i0 < 0) return 空;
  const c0 = kline[i0].close;
  if (!(c0 > 0)) return 空;
  const 取 = (n) => {
    const j = i0 + n;
    if (j >= kline.length) return null;
    const c = kline[j].close;
    return c > 0 ? Math.round(((c - c0) / c0) * 10000) / 100 : null;
  };
  return { ret1: 取(1), ret3: 取(3), ret5: 取(5) };
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

// 所属板块指数 secid（持股日对标用）：300/301/688 → 创业板指；6xx → 上证指数；00x → 深成指。
// 背景：2026-10-16 用户指示「归因必须以持股日的因素归纳」——荐股日 14:50 买入，荐股日波动与
// 持仓盈亏无关。百洋医药一案：持股日创业板指 -3.10% 而个股仅 -1.21%（跑赢板块 1.89pct），
// 真实跌因是板块拖累，此前「其他」兜底掩盖了这一点。
function 板块Sec(code) {
  const c = String(code || "");
  if (c.startsWith("300") || c.startsWith("301") || c.startsWith("688")) return "0.399006";
  if (c.startsWith("6")) return "1.000001";
  return "0.399001";
}
function 板块名(sec) {
  return sec === "0.399006" ? "创业板指" : sec === "1.000001" ? "上证指数" : "深成指";
}

// 持股日解剖（全部锚定持股日 = 荐股日下一交易日，用户在荐股日 14:50 收盘价买入）：
//   个股涨跌/跳空/贴地/量倍 用已拉的个股K；板块涨跌 拉所属板块指数日K（进程内缓存）；
//   超额 = 个股 - 板块：≤-1pct 判「个股独跌」（个股自身因素，如资金出逃）。
function 持股日解剖(code, kl, recDate, 大盘日K) {
  if (!kl || !kl.length) return null;
  let i0 = -1;
  for (let i = 0; i < kl.length - 1; i++) if (kl[i].date.replace(/-/g, "") === String(recDate)) { i0 = i; break; }
  if (i0 < 1) return null;   // 次日未发生 / 推荐日不在窗口
  const 昨 = kl[i0], 持 = kl[i0 + 1];
  if (!(昨.close > 0) || !(持.close > 0)) return null;
  const 持股日 = 持.date;
  const 个股 = ((持.close - 昨.close) / 昨.close) * 100;
  const 跳空 = ((持.open - 昨.close) / 昨.close) * 100;
  const 贴地 = (持.low - 持.close) / 持.close <= 0.005;   // 收在最低附近：一字跌停/闷杀（第 4 因子判据）
  // 量能：持股日 vs 荐股日前 5 日均量
  let 量倍 = null;
  const 量窗 = kl.slice(Math.max(0, i0 - 5), i0).filter((k) => k.vol > 0);
  if (量窗.length && 持.vol > 0) 量倍 = 持.vol / (量窗.reduce((s, k) => s + k.vol, 0) / 量窗.length);
  // 板块（进程内缓存，同期同板块只拉一次）
  const bsec = 板块Sec(code);
  let 持板块 = null;
  const bk = 大盘日K[bsec];
  if (bk) {
    const 持日 = 持股日.replace(/-/g, "");
    for (let i = 1; i < bk.length; i++) {
      if (bk[i].date.replace(/-/g, "") === 持日) {
        if (bk[i - 1].close > 0) 持板块 = ((bk[i].close - bk[i - 1].close) / bk[i - 1].close) * 100;
        break;
      }
    }
  }
  // 大盘（持股日）
  let 持大盘 = null;
  {
    const mk = 大盘日K["1.000001"];
    if (mk) {
      const 持日 = 持股日.replace(/-/g, "");
      for (let i = 1; i < mk.length; i++) {
        if (mk[i].date.replace(/-/g, "") === 持日) {
          if (mk[i - 1].close > 0) 持大盘 = ((mk[i].close - mk[i - 1].close) / mk[i - 1].close) * 100;
          break;
        }
      }
    }
  }
  /* 均线（含当日的 n 日简单均线）——破位判据用；样本不足返回 null */
  const 均线 = (idx, n) => {
    if (idx < n - 1) return null;
    let s = 0;
    for (let j = idx - n + 1; j <= idx; j++) s += kl[j].close;
    return s / n;
  };
  const ma5荐 = 均线(i0, 5), ma5持 = 均线(i0 + 1, 5);
  /* 破位 = 真实下穿（荐股日收盘 ≥ 当日 MA5，持股日收盘 < 持股日 MA5），
     而非"本就在均线下方"——技术破位信号（2026-10-16 新增，第 15 因子） */
  const 破位 = ma5荐 != null && ma5持 != null && 昨.close >= ma5荐 && 持.close < ma5持;
  return {
    持股日, 个股, 跳空, 贴地, 持板块, 量倍, 持大盘,
    超额: 持板块 != null ? 个股 - 持板块 : null,
    闷杀: 跳空 <= -5 && 贴地,
    跌停闷杀: 跳空 <= -5 && 贴地,   // 4字别名：兼容旧版看板（2字名时期之前导出的 HTML）
    放量: 量倍 != null && 量倍 >= 1.5,
    放量下跌: 量倍 != null && 量倍 >= 1.5,
    板块名: 板块名(bsec),
    /* 形态类 4（2026-10-16 扩展，可继续加；全部 4 字命名）：
       低开 = 隔夜冲击（跳空≤-3%，未达闷杀）；回落 = 盘中冲高出货（最高涨≥1% 而收跌≥2%）；
       缩量 = 无量承接（量能≤前5日均量0.8 倍且收跌）；破位 = 技术破位（下穿 MA5） */
    低开: 跳空 <= -3 && !(跳空 <= -5 && 贴地),
    跳空低开: 跳空 <= -3 && !(跳空 <= -5 && 贴地),
    回落: 昨.close > 0 && 持.high >= 昨.close * 1.01 && 个股 <= -2,
    冲高回落: 昨.close > 0 && 持.high >= 昨.close * 1.01 && 个股 <= -2,
    缩量: 量倍 != null && 量倍 <= 0.8 && 个股 < 0,
    缩量阴跌: 量倍 != null && 量倍 <= 0.8 && 个股 < 0,
    破位: 破位,
    跌破均线: 破位,
  };
}

// 默认参数 + 硬上下限保护
function 默认参数() {
  return {
    updated: "",
    note: "由 review.js 根据近 N 期滚动成功率自动生成；engine.js 读取后对硬门槛做温和、有界的收紧。",
    cfg: { 温度下限: 35, 止损率: 0.92, 急涨上限: 30 },
    stats: { 期数: 0, 样本票数: 0, 胜数: 0, 成功率: null,
      弱市失败率: null, 板块失败率: null, 独跌失败率: null, 闷杀失败率: null, 放量失败率: null,
      低开失败率: null, 回落失败率: null, 缩量失败率: null, 破位失败率: null,
      追高失败率: null, 急涨失败率: null,
      平均失败跌幅: null },
  };
}
const 限 = { 温度下限: [30, 50], 止损率: [0.85, 0.97], 急涨上限: [15, 60] };
const 钳 = (v, k) => {
  const [lo, hi] = 限[k];
  return Math.min(hi, Math.max(lo, v));
};

/* 日期键加减天数（YYYYMMDD），用于「近 6 个月」窗口。
   review.js 保持独立、不 import engine.js，故在此本地实现一份。 */
function 日期键偏移(键, 天数) {
  const s = String(键 || "");
  if (s.length !== 8) return s;
  const d = new Date(`${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)} 12:00:00`);
  if (isNaN(d.getTime())) return s;
  d.setDate(d.getDate() + (天数 || 0));
  return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
}

/* ── 区间胜率统计（2026-11-09 老板要求：统计 6 个月胜率）──
   口径：推荐日 14:50 收盘价买入 → 持有到对应周期收盘卖出，收盘价高于买入价即算胜。
   T1 = 次日收盘（与既有「滚动成功率」完全同源，可直接对比）；
   T3 / T5 = 持股 3 / 5 个交易日收盘（老板实际持股 1~4 周，T5 更贴近真实兑现）。
   分档：S 级（双金共振最高等级）与 A 级分开统计 —— 用来回答「S 级是否真的更准」，
   若 S 级长期低于 A 级，应先收紧周线 KDJ 低位或日线聚合阈值，而不是恢复均线拦截。 */
function 区间统计(期列表) {
  const 全部票 = [];
  for (const x of 期列表) for (const p of x.picks || []) if (p && p.ret != null) 全部票.push(p);
  const 算 = (arr, 键) => {
    const v = arr.map((p) => p[键]).filter((r) => r != null);
    if (!v.length) return { 样本: 0, 胜: 0, 胜率: null, 均值: null };
    const 胜 = v.filter((r) => r > 0).length;
    return {
      样本: v.length, 胜,
      胜率: Math.round((胜 / v.length) * 1000) / 10,
      均值: Math.round((v.reduce((s, r) => s + r, 0) / v.length) * 100) / 100,
    };
  };
  const 档 = (名) => 全部票.filter((p) => (p.tier || "A") === 名);
  const S = 档("S"), A = 档("A");
  return {
    期数: 期列表.length,
    样本票数: 全部票.length,
    T1: 算(全部票, "ret"), T3: 算(全部票, "ret3"), T5: 算(全部票, "ret5"),
    S级: { 样本: S.length, T1: 算(S, "ret"), T5: 算(S, "ret5") },
    A级: { 样本: A.length, T1: 算(A, "ret"), T5: 算(A, "ret5") },
  };
}

function 算优化参数(items) {
  const 参数 = 默认参数();
  const 有效 = items.filter((x) => x.verifiable);
  if (!有效.length) return 参数;
  const total = 有效.reduce((s, x) => s + x.picks.length, 0);
  const win = 有效.reduce((s, x) => s + x.picks.filter((p) => p.ret > 0).length, 0);
  const 成功率 = total ? Math.round((win / total) * 1000) / 10 : null;
  const 失败 = 有效.flatMap((x) => x.picks.filter((p) => p.ret < 0));
  /* 持股日归因九因子失败率（2026-10-16 重锚）：用户在荐股日 14:50 买入，盈亏只与持股日有关——
     前五项为持股日当日可观测的市场因素，后四项为高位类因素（荐股日入场特征，在持股日兑现为回吐/退潮/炸板/急跌） */
  const 弱市失败率 = 失败.length ? 失败.filter((p) => p.持大盘 != null && p.持大盘 < 0).length / 失败.length : null;
  const 板块失败率 = 失败.length ? 失败.filter((p) => p.持板块 != null && p.持板块 <= -1).length / 失败.length : null;
  const 独跌失败率 = 失败.length ? 失败.filter((p) => p.超额 != null && p.超额 <= -1).length / 失败.length : null;
  const 闷杀失败率 = 失败.length ? 失败.filter((p) => p.闷杀).length / 失败.length : null;
  const 放量失败率 = 失败.length ? 失败.filter((p) => p.放量).length / 失败.length : null;
  /* 形态类 4（2026-10-16 扩展） */
  const 低开失败率 = 失败.length ? 失败.filter((p) => p.低开).length / 失败.length : null;
  const 破位失败率 = 失败.length ? 失败.filter((p) => p.破位).length / 失败.length : null;
  const 回落失败率 = 失败.length ? 失败.filter((p) => p.回落).length / 失败.length : null;
  const 缩量失败率 = 失败.length ? 失败.filter((p) => p.缩量).length / 失败.length : null;
  const 追高失败率 = 失败.length ? 失败.filter((p) => p.chg != null && p.chg >= 4).length / 失败.length : null;
  const 平均失败跌幅 = 失败.length ? Math.round((失败.reduce((s, p) => s + p.ret, 0) / 失败.length) * 10) / 10 : null;
  const 急涨失败率 = 失败.length ? 失败.filter((p) => p.chg5 != null && p.chg5 >= 30).length / 失败.length : null;

  const cfg = 参数.cfg;
  /* 2026-11-06：追高上限（当日涨幅硬门槛）已删除，此处不再有对应的自适应规则；
     原「成功率<40%/<50%」与「追高失败率>50%」三条只调这个参数，故一并移除。
     成功率低仍通过提高弱市温度门槛来控制出手频率。 */
  if (成功率 != null && 成功率 < 40) {
    cfg.温度下限 = 钳(Math.max(cfg.温度下限, cfg.温度下限 + 3), "温度下限");
  }
  // 失败集中在持股日弱市日 → 提高弱市门槛（原荐股日口径，2026-10-16 重锚持股日）
  if (弱市失败率 != null && 弱市失败率 > 0.6) cfg.温度下限 = 钳(Math.min(45, Math.max(35, cfg.温度下限 + 2)), "温度下限");
  // 失败集中在持股日板块日 → 同样提高弱市门槛（板块系统性风险）
  if (板块失败率 != null && 板块失败率 > 0.6) cfg.温度下限 = 钳(Math.min(45, Math.max(35, cfg.温度下限 + 2)), "温度下限");
  /* 失败票多是个股独跌（显著弱于板块）原只用来收紧追高上限，追高上限删除后该规则无落点，
     一并移除；独跌失败率仍作为诊断指标输出到复盘报告。 */
  // 失败平均跌幅深 → 止损更严（0.94 = 止损 -6%）
  if (平均失败跌幅 != null && 平均失败跌幅 < -10) cfg.止损率 = 钳(0.94, "止损率");
  // 失败票多因90度急拉（近5日涨幅≥30%）→ 收紧急涨上限
  if (急涨失败率 != null && 急涨失败率 > 0.5) cfg.急涨上限 = 钳(Math.min(cfg.急涨上限, 20), "急涨上限");

  参数.cfg = cfg;
  参数.stats = { 期数: 有效.length, 样本票数: total, 胜数: win, 成功率,
    弱市失败率, 板块失败率, 独跌失败率, 闷杀失败率, 放量失败率,
    低开失败率, 回落失败率, 缩量失败率, 破位失败率,
    追高失败率, 急涨失败率,
    平均失败跌幅 };
  参数.updated = new Date().toLocaleString("sv-SE").replace("T", " ");
  return 参数;
}

async function 主流程() {
  let 包 = { recs: [] };
  try { 包 = JSON.parse(readFileSync(存档文件, "utf-8")); } catch (e) {}
  const recs = (包.recs || []).sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`复盘 ${recs.length} 期存档…`);

  // 已复盘记录（保留历史固定期，避免下次重复验证）
  /* 已复盘记录：存整条期对象（不再只是打点），供增量复盘直接复用。
     存档扩到 180 天后，全量重算会撞 Actions 超时，必须能「跳过已算满的期」。 */
  let done = {};
  if (existsSync(复盘文件)) {
    try { const rr = JSON.parse(readFileSync(复盘文件, "utf-8")); (rr.items || []).forEach((x) => x && x.date && (done[x.date] = x)); } catch (e) {}
  }

  const items = [];
  /* 指数日K进程内缓存：上证 1.000001 / 创业板指 0.399006 / 深成指 0.399001。
     持股日归因（大盘/板块）与荐股日大盘都从这里算，避免每期重复拉指数 */
  const 大盘日K = {};
  for (const sec of ["1.000001", "0.399006", "0.399001"]) {
    try { 大盘日K[sec] = (await 拉K线Sec(sec, 15)) || null; } catch (e) { 大盘日K[sec] = null; }
  }
  // 从已缓存的指数K里算某日大盘涨跌（date 当日 vs 前一日）
  function 指数日涨跌(sec, date) {
    const k = 大盘日K[sec];
    if (!k) return null;
    const d = String(date).replace(/-/g, "");
    for (let i = 1; i < k.length; i++) {
      if (k[i].date.replace(/-/g, "") === d) {
        if (k[i - 1].close > 0 && k[i].close > 0) return ((k[i].close - k[i - 1].close) / k[i - 1].close) * 100;
        return null;
      }
    }
    return null;
  }
  for (const g of recs) {
    /* 增量复盘（2026-11-09）：存档扩到 180 天后，每期每天重算会变成 120 期 × 6 次请求，
       必然撞上 Actions 20 分钟超时。已复盘且多周期已算满（T+5 已发生）的期直接复用旧结果，
       每天只真正计算新期与最近 5 个交易日内的期。 */
    const 旧 = done[g.date];
    if (旧 && 旧.verifiable && 旧.多周期 && (旧.picks || []).some((p) => p && p.ret5 != null)) { items.push(旧); continue; }
    const 期 = { date: g.date, gen_time: g.gen_time || "", picks: [], verifiable: false, market_chg: null, 荐日大盘: null, 持股日: null, success: null, 多周期: 1 };
    const picks = g.picks || [];
    if (!picks.length) continue;
    // 推荐日之后第一个交易日是否已发生：拉该期第一只票K线，看推荐日 index+1 是否存在
    let kline = await 拉K线(picks[0].code, 15);
    let 次日存在 = false, 持股日 = null;
    if (kline) {
      for (let i = 0; i < kline.length - 1; i++) if (kline[i].date.replace(/-/g, "") === String(g.date)) { 次日存在 = true; 持股日 = kline[i + 1].date; break; }
    }
    if (!次日存在) { console.log(`  期 ${g.date}: 次日尚未发生，跳过（待下次复盘）`); continue; }
    期.verifiable = true;
    期.荐日大盘 = 指数日涨跌("1.000001", g.date);
    期.持股日 = 持股日;
    期.market_chg = 指数日涨跌("1.000001", 持股日);   // 2026-10-16 重锚：market_chg 语义改为持股日大盘
    let 涨 = 0;
    for (const p of picks) {
      const kl = await 拉K线(p.code, 15);   // 每只票独立拉K线，不能复用
      const 多 = 多日涨跌(kl, g.date);
      const ret = 多.ret1;
      const r = {
        code: p.code, name: p.name, score: p.score, prob: p.prob,
        /* 荐股等级：S = 双金共振（最高等级）/ A = 常规。分档胜率靠它拆分，
           缺省会全部归入 A 级，S 级统计永远为 0。 */
        tier: p.tier === "S" ? "S" : "A",
        chg: p.pct_chg != null ? p.pct_chg : null,   // 推荐日涨幅（追高判据，持股日归因·高位类）
        chg5: p.pct_chg_5d != null ? p.pct_chg_5d : 近5涨幅(kl, g.date),   // 推荐日前近5日累计涨幅（急涨判据，持股日归因·高位类）
        ret: ret != null ? Math.round(ret * 100) / 100 : null,
        ret3: 多.ret3, ret5: 多.ret5,   // 6 个月胜率的多周期口径（见 区间统计）
        // 持股日解剖（归因重锚：全部字段锚定持股日 = 荐股日 14:50 买入后的第一个交易日）
        ...(持股日解剖(p.code, kl, g.date, 大盘日K) || {}),
      };
      if (ret != null && ret > 0) 涨++;
      期.picks.push(r);
    }
    期.success = 期.picks.filter((p) => p.ret != null).length ? 涨 : null;
    items.push(期);
    console.log(`  期 ${g.date}: ${期.picks.filter((p)=>p.ret!=null).length}/${期.picks.length} 可验证，胜 ${涨} 只`);
  }

  /* 合并：历史各期 + 本次新复盘期（按 date 去重，本次优先）。
     2026-11-09 修正：原逻辑只保留「未验证」的历史项，已复盘期一旦从 recs.json 掉出窗口
     就永久丢失，6 个月样本无从累积。现改为保留全部历史项，只由本次结果覆盖同期。 */
  const 历史项 = existsSync(复盘文件) ? (JSON.parse(readFileSync(复盘文件, "utf-8")).items || []) : [];
  const 合并 = {};
  for (const it of 历史项) if (it && it.date) 合并[it.date] = it;
  for (const it of items) if (it && it.date) 合并[it.date] = it;
  /* 与 recs.json 对齐：只保留近 180 天（再多也只是无限膨胀，且超出统计窗口无用） */
  const 今日键 = new Date().toLocaleString("sv-SE").slice(0, 10).replace(/-/g, "");
  const 保留界 = 日期键偏移(今日键, -180);
  const 全部项 = Object.values(合并)
    .filter((x) => x && x.date && x.date >= 保留界)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const 参数 = 算优化参数(全部项.filter((x) => x.verifiable));

  /* 6 个月胜率（2026-11-09 老板要求）：窗口 = 今日往前 180 天，
     与 recs.json 保留窗口同一把尺子，避免「存档 180 天、统计另一套窗口」的口径漂移。 */
  const 半年统计 = 区间统计(全部项.filter((x) => x.verifiable && x.date >= 保留界));
  const 全量统计 = 区间统计(全部项.filter((x) => x.verifiable));
  参数.half_year = { 窗口起: 保留界, 窗口止: 今日键, ...半年统计 };
  参数.all_time = 全量统计;

  const 复盘包 = { ok: true, updated: new Date().toLocaleString("sv-SE").replace("T", " "), count: 全部项.length, items: 全部项 };
  /* 防空定稿覆盖（2026-10-15 事故：fields 参数整批报错 → 全部期「次日尚未发生」→ 0 期可验证
     → 历史定稿被空 items 清空、params 重置默认）。
     本次 0 期可验证且历史有可验证期 = 通道故障特征，保留历史文件不写，等下次重跑 */
  const 历史可验证 = (历史项 || []).filter((x) => x && x.verifiable).length;
  const 本次可验证 = 全部项.filter((x) => x.verifiable).length;
  if (!本次可验证 && 历史可验证 > 0) {
    console.log(`⚠️ 本次 ${本次可验证} 期可验证、历史 ${历史可验证} 期——疑似K线通道故障，保留历史定稿不覆盖`);
  } else {
    writeFileSync(复盘文件, JSON.stringify(复盘包, null, 2), "utf-8");
    writeFileSync(参数文件, JSON.stringify(参数, null, 2), "utf-8");
  }

  // 人类可读复盘报告 review.md
  const 线 = (s) => s + "\n";
  let md = 线("# 每日荐股复盘报告");
  md += 线("> 由 review.js 在每日收盘后自动生成（北京时间 15:30），验证上期荐股「次日收盘」表现并归因失败。");
  md += 线(">");
  md += 线("> **归因口径（2026-10-16 重锚）**：用户在荐股日 14:50 收盘价买入，盈亏只与持股日（荐股日下一交易日）有关——");
  md += 线("> 失败归因共十一因子（2026-11-09 删「情绪」「连板」两项；**因子名统一 4 字**，全部解释持股日盈亏）：");
  md += 线("> **市场类 5** —— 弱市 / 板块（所属指数跌≥1%）/ 独跌（个股弱于板块≥1pct，个股自身因素）/ 闷杀（跳空≤-5% 且收在最低）/ 放量（量能≥1.5倍）；");
  md += 线("> **形态类 4** —— 低开（隔夜冲击，跳空≤-3%）/ 回落（盘中最高涨≥1% 而收跌≥2%）/ 缩量（量能≤前5日均量0.8倍且收跌）/ 破位（荐股日在 MA5 上方、持股日下穿 MA5）；");
  md += 线("> **高位类 2** —— 追高（荐日涨幅≥4%→持股日回吐）/ 急涨（荐日前5日累计≥30%→持股日急跌）；");
  md += 线("> 兜底分级（判据全部未命中时仍给出原因）：跑输（跌幅大于所属指数）/ 承压（隔夜低开未收复）/ 回调（温和调整中的正常波动）");
  md += 线("");
  md += 线("## 滚动统计（近 N 期已到次日）");
  const st = 参数.stats;
  md += 线(`- 样本期数：**${st.期数}** · 样本票数：**${st.样本票数}** · 次日收涨 **${st.胜数}** 只`);
  md += 线(`- 滚动成功率：**${st.成功率 == null ? "—" : st.成功率 + "%"}**（次日收盘上涨的票占比）`);
  md += 线(`- 追高失败率（推荐日涨幅≥4% 高位买入后失败）：${st.追高失败率 == null ? "—" : (Math.round(st.追高失败率 * 100) + "%")}`);
  md += 线(`- 弱市失败率（持股日上证下跌）：${st.弱市失败率 == null ? "—" : (Math.round(st.弱市失败率 * 100) + "%")}`);
  md += 线(`- 板块失败率（持股日所属板块指数跌≥1%）：${st.板块失败率 == null ? "—" : (Math.round(st.板块失败率 * 100) + "%")}`);
  md += 线(`- 独跌失败率（持股日个股弱于板块≥1pct）：${st.独跌失败率 == null ? "—" : (Math.round(st.独跌失败率 * 100) + "%")}`);
  md += 线(`- 闷杀失败率（持股日跳空≤-5% 且收在最低附近）：${st.闷杀失败率 == null ? "—" : (Math.round(st.闷杀失败率 * 100) + "%")}`);
  md += 线(`- 放量失败率（持股日量能≥前5日均量1.5倍）：${st.放量失败率 == null ? "—" : (Math.round(st.放量失败率 * 100) + "%")}`);
  md += 线(`- 低开失败率（持股日跳空≤-3%）：${st.低开失败率 == null ? "—" : (Math.round(st.低开失败率 * 100) + "%")}`);
  md += 线(`- 回落失败率（盘中最高涨≥1% 而收跌≥2%）：${st.回落失败率 == null ? "—" : (Math.round(st.回落失败率 * 100) + "%")}`);
  md += 线(`- 缩量失败率（量能≤0.8倍且收跌）：${st.缩量失败率 == null ? "—" : (Math.round(st.缩量失败率 * 100) + "%")}`);
  md += 线(`- 破位失败率（荐股日在 MA5 上方、持股日跌破 MA5）：${st.破位失败率 == null ? "—" : (Math.round(st.破位失败率 * 100) + "%")}`);
  md += 线(`- 急涨失败率（近5日涨幅≥30% 后失败）：${st.急涨失败率 == null ? "—" : (Math.round(st.急涨失败率 * 100) + "%")}`);
  md += 线(`- 平均失败跌幅：**${st.平均失败跌幅 == null ? "—" : st.平均失败跌幅 + "%"}**`);
  md += 线("");

  /* ── 近 6 个月胜率（2026-11-09 老板要求）──
     口径：推荐日 14:50 按收盘价买入，持有到对应周期收盘，收盘价高于买入价即算胜。
     T+1 与上面「滚动成功率」同源，可直接对照；T+3 / T+5 更贴近「持股 1~4 周」的真实兑现。 */
  const hy = 参数.half_year;
  md += 线("## 近 6 个月胜率（窗口 " + hy.窗口起 + " → " + hy.窗口止 + "）");
  md += 线(`- 样本：**${hy.期数}** 期 · **${hy.样本票数}** 只（仅计已到下一交易日的票，停牌不参与）`);
  if (hy.样本票数) {
    md += 线("");
    md += 线("| 持有周期 | 样本 | 胜 | 胜率 | 平均收益 |");
    md += 线("|---|---|---|---|---|");
    for (const [名, 键] of [["次日收盘 T+1", "T1"], ["3 日收盘 T+3", "T3"], ["5 日收盘 T+5", "T5"]]) {
      const s = hy[键];
      md += 线(`| ${名} | ${s.样本} | ${s.胜} | **${s.胜率 == null ? "—" : s.胜率 + "%"}** | ${s.均值 == null ? "—" : (s.均值 > 0 ? "+" : "") + s.均值 + "%"} |`);
    }
    md += 线("");
    md += 线("**分档对比（S 级 = 双金共振最高等级，A 级 = 常规）**");
    md += 线("");
    md += 线("| 档位 | 样本 | T+1 胜率 | T+1 均收 | T+5 胜率 | T+5 均收 |");
    md += 线("|---|---|---|---|---|---|");
    for (const [名, d] of [["S 级", hy.S级], ["A 级", hy.A级]]) {
      md += 线(`| ${名} | ${d.样本} | ${d.T1.胜率 == null ? "—" : d.T1.胜率 + "%"} | ${d.T1.均值 == null ? "—" : (d.T1.均值 > 0 ? "+" : "") + d.T1.均值 + "%"} | ${d.T5.胜率 == null ? "—" : d.T5.胜率 + "%"} | ${d.T5.均值 == null ? "—" : (d.T5.均值 > 0 ? "+" : "") + d.T5.均值 + "%"} |`);
    }
    md += 线("");
    md += 线(`> 读法：S 级 T+1 胜率若长期低于 A 级，说明「双金共振」在实际兑现上不如常规形态，`);
    md += 线(`> 处置顺序是收紧周线 KDJ 低位阈值或日线聚合阈值，**不要**恢复周线均线硬拦截（那会直接选不出票）。`);
  } else {
    md += 线("- 窗口内暂无已到次日的样本，随每日荐股与复盘自动累积。");
  }
  md += 线("");
  md += 线("## 本轮优化后的引擎参数（engine.js 将读取）");
  const cg = 参数.cfg;
  md += 线(`- 追高上限：**已删除**（2026-11-06 起当日涨幅不再设硬门槛）`);
  md += 线(`- 量比 / 换手 / 连板 / 流通市值：**四道关卡已删除**（2026-11-09，成交活跃度与市值不再作为选股条件）`);
  md += 线(`- 弱市温度下限（<此值空仓停推）：**${cg.温度下限}**`);
  md += 线(`- 急涨上限（近5日累计涨幅≥此值剔除，90度斜率）：**${cg.急涨上限}%**`);
  md += 线(`- 统一止损率：**${Math.round((1 - cg.止损率) * 100)}%**（buyPrice × ${cg.止损率}）`);
  md += 线("");
  /* 明细只输出最近 30 期：6 个月约 120 期，全量罗列会让报告长到没法读，
     汇总统计已在上面给出，明细仅作近期核对用。 */
  md += 线("## 各期明细（最近 30 期）");
  md += 线(`> 完整 ${全部项.length} 期明细见 review_log.json（保留近 180 天）。`);
  md += 线("");
  for (const it of 全部项.slice(-30)) {
    if (!it.verifiable) { md += 线(`- **${it.date}**：尚未到次日，待验证`); continue; }
    const ok = it.picks.filter((p) => p.ret != null && p.ret > 0).length;
    const tot = it.picks.filter((p) => p.ret != null).length;
    md += 线(`- **${it.date}** 荐股 → **${it.持股日 || "—"}** 持股（大盘 ${it.market_chg == null ? "—" : it.market_chg + "%"}）：${ok}/${tot} 胜`);
    for (const p of it.picks) {
      const 涨跌 = p.ret == null ? "—" : (p.ret > 0 ? "🔺" + p.ret + "%" : "🔻" + p.ret + "%");
      const 多周 = [
        p.ret3 != null ? "T+3 " + (p.ret3 > 0 ? "+" : "") + p.ret3 + "%" : null,
        p.ret5 != null ? "T+5 " + (p.ret5 > 0 ? "+" : "") + p.ret5 + "%" : null,
      ].filter(Boolean).join(" / ");
      const 持股日因 = p.ret != null && p.ret < 0 ? (() => {
        const 因 = [];
        if (p.持大盘 != null && p.持大盘 < 0) 因.push("弱市");
        if (p.持板块 != null && p.持板块 <= -1) 因.push("板块");
        if (p.超额 != null && p.超额 <= -1) 因.push("独跌");
        if (p.闷杀) 因.push("闷杀");
        if (p.放量) 因.push("放量");
        if (p.低开) 因.push("低开");
        if (p.回落) 因.push("回落");
        if (p.缩量) 因.push("缩量");
        if (p.破位) 因.push("破位");
        if (p.chg != null && p.chg >= 4) 因.push("追高");
        if (p.chg5 != null && p.chg5 >= 30) 因.push("急涨");
        /* 兜底分级（2026-10-16 用户要求：跌股必须给出具体原因，不再输出「未命中/其他」）：
           跑输（跌幅大于所属指数）→ 承压（隔夜低开未收复）→ 回调（温和调整中的正常波动） */
        if (!因.length) {
          if (p.超额 != null && p.超额 < 0) 因.push("跑输");
          else if (p.跳空 != null && p.跳空 < 0) 因.push("承压");
          else 因.push("回调");
        }
        return "｜持股日归因：" + 因.join("+");
      })() : "";
      const 等级 = p.tier === "S" ? "S" : "A";
      md += 线(`   - [${等级}] ${p.name}(${p.code}) 次日收盘 ${涨跌}${多周 ? "（" + 多周 + "）" : ""}${持股日因}｜推荐日涨幅 ${p.chg == null ? "—" : p.chg + "%"}`);
    }
  }
  writeFileSync(报告文件, md, "utf-8");

  console.log(`✅ 复盘完成：${全部项.filter((x) => x.verifiable).length} 期可验证，滚动成功率 ${st.成功率 == null ? "—" : st.成功率 + "%"}`);
  const hys = 参数.half_year;
  console.log(`   近 6 个月（${hys.窗口起}→${hys.窗口止}）：${hys.期数} 期 / ${hys.样本票数} 只 · T+1 ${hys.T1.胜率 == null ? "—" : hys.T1.胜率 + "%"} · T+5 ${hys.T5.胜率 == null ? "—" : hys.T5.胜率 + "%"} · S 级 ${hys.S级.样本} 只（T+1 ${hys.S级.T1.胜率 == null ? "—" : hys.S级.T1.胜率 + "%"}）/ A 级 ${hys.A级.样本} 只（T+1 ${hys.A级.T1.胜率 == null ? "—" : hys.A级.T1.胜率 + "%"}）`);
  console.log(`   产出 ${复盘文件} / ${参数文件} / ${报告文件}`);
}

主流程().catch((e) => { console.error(e); process.exit(1); });
