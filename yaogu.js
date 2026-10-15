/* ═══════════════════════════════════════════════════════════════
 * yaogu.js —— 妖股潜力扫描（云端版）
 * 2026-10-15 由前端 FS3 引擎**原样移植**：策略逻辑（硬条件 / 股性 /
 * 筹码位置 / 放量启动 / 板块效应 / 新闻黑名单 / 潜力分）一字未改，
 * 只把三处浏览器专属实现换成 Node：
 *   ① 东财 clist = JSONP(<script>) → fetch 分页
 *   ② 大盘分时   = kJsonp        → fetch 腾讯接口
 *   ③ 共享工具   = window.FS工具 → import engine.js
 * 输出结构与前端原 FS3 完全同构（{empty,date,temperature,picks,mode,...}），
 * 便于前端从"本地算"平滑切到"读云端"。
 * 起因：用户要求「看板本地只做显示、所有运算上云」。
 * ═══════════════════════════════════════════════════════════════ */
import {
  今日键, getIndex, getZTPool, getDTPool, temperature, batchKlines, batchNews, 取日K,
} from "./engine.js";

const 域表 = ["push2.eastmoney.com", "82.push2.eastmoney.com", "48.push2.eastmoney.com", "25.push2.eastmoney.com"];
const UA = "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const 时戳 = () => new Date().toLocaleString("sv-SE").replace("T", " ");

/* ── 全市场（东财 clist，带行业 f100）── */
async function 拉全市场行业版(prog) {
  const fsParam = encodeURIComponent("m:0+t:6,m:1+t:2,m:0+t:80");
  const 字段 = "f12,f14,f2,f3,f8,f21,f100";
  async function 取一页(域, pn, pz) {
    const u = `https://${域}/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fid=f3&fs=${fsParam}&fields=${字段}`;
    const r = await fetch(u, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const d = (j && j.data && j.data.diff) || [];
    return Array.isArray(d) ? d : Object.values(d);
  }
  /* 探总数：多域轮询（某个域不通就换） */
  let total = 0, 域 = 域表[0];
  for (const d of 域表) {
    try { const j = await 取一页(d, 1, 1); if (j.length) { 域 = d; total = 5200; break; } } catch (e) {}
  }
  if (!total) throw new Error("东财 clist 全域不可达");
  const pz = 200, 页数 = Math.min(40, Math.ceil(total / pz));
  const out = [];
  let next = 1, 完成 = 0;
  async function 工() {
    while (next <= 页数) {
      const pn = next++;
      try {
        const arr = await 取一页(域表[pn % 域表.length], pn, pz);
        for (const r of arr) {
          out.push({ code: String(r.f12), name: String(r.f14 || ""), price: Number(r.f2), chg: Number(r.f3),
                     turn: Number(r.f8 || 0), fmv: r.f21 ? Number(r.f21) / 1e8 : 0, hybk: r.f100 || "" });
        }
      } catch (e) {}
      完成++;
      if (prog) prog(10 + Math.round(20 * 完成 / 页数), `拉取全市场行情 ${完成}/${页数} 页…`);
    }
  }
  await Promise.all([0, 1, 2, 3, 4].map(工));
  return out;
}

/* ── 硬性量化条件（原样保留）── */
function scanYao(all, 行业缺失) {
  const 涨图 = {};
  for (const r0 of all) if (r0.chg > 0 && r0.hybk) 涨图[r0.hybk] = (涨图[r0.hybk] || 0) + 1;
  const out = [];
  for (const r of all) {
    const 头 = String(r.code).slice(0, 2);
    if (头 !== "60" && 头 !== "00" && 头 !== "30") continue;
    if (r.name.indexOf("ST") >= 0 || r.name.indexOf("*") >= 0 || r.name.indexOf("退") >= 0 || r.name.indexOf("N") === 0) continue;
    if (!(r.price >= 5 && r.price <= 20)) continue;
    if (!(r.fmv >= 20 && r.fmv <= 80)) continue;
    if (r.turn > 30) continue;
    r.板块涨家 = 涨图[r.hybk] || 0;
    r.行业缺失 = 行业缺失;
    out.push(r);
  }
  return out;
}

/* ── 60日K线：股性 / 筹码位置 / 放量启动 / 黑名单（原样保留）── */
function klineYao(pool, kmap) {
  const out = [];
  for (const p of pool) {
    const rows = kmap[p.code];
    if (!rows || rows.length < 40) continue;
    rows.sort((a, b) => (a.TRADE_DATE < b.TRADE_DATE ? -1 : 1));
    const n = rows.length, 现 = rows[n - 1].CLOSE_PRICE;
    let hi60 = 0;
    for (let k = 0; k < n; k++) if (rows[k].HIGH_PRICE > hi60) hi60 = rows[k].HIGH_PRICE;
    if (!(hi60 > 0) || !(现 > 0)) continue;
    const 位 = 现 / hi60 * 100;
    if (位 >= 75) continue;
    const 基 = rows[Math.max(0, n - 60)].CLOSE_PRICE;
    const 涨60 = 基 > 0 ? (现 / 基 - 1) * 100 : 0;
    if (涨60 > 100) continue;
    const 阈 = String(p.code).slice(0, 2) === "30" ? 0.198 : 0.098;
    let ztN = 0, 近3日zt = 0, 一字N = 0, 放量 = false;
    for (let m = 1; m < n; m++) {
      const 昨 = rows[m - 1].CLOSE_PRICE;
      const 涨 = 昨 > 0 ? (rows[m].CLOSE_PRICE - 昨) / 昨 : 0;
      if (涨 >= 阈) { if (m >= n - 30) ztN++; if (m >= n - 3) 近3日zt++; }
      if (m >= n - 3 && rows[m].HIGH_PRICE === rows[m].LOW_PRICE) 一字N++;
    }
    if (ztN < 1) continue;
    if (近3日zt < 1) continue;
    if (一字N >= 2) continue;
    for (let t = Math.max(6, n - 3); t < n; t++) {
      const 昨收2 = rows[t - 1].CLOSE_PRICE;
      if (!(昨收2 > 0)) continue;
      if ((rows[t].CLOSE_PRICE - 昨收2) / 昨收2 < 阈) continue;
      let 均5 = 0, c5 = 0;
      for (let q = Math.max(0, t - 6); q < t - 1; q++) { 均5 += rows[q].VOLUME; c5++; }
      const 平 = c5 ? 均5 / c5 : 0;
      if (平 > 0 && rows[t].VOLUME >= 平 * 1.5) { 放量 = true; break; }
    }
    if (!放量) continue;
    out.push({ p, 位: Math.round(位), 涨60: Math.round(涨60), ztN, 近3日zt });
  }
  return out;
}

/* ── 潜力分（原样保留）── */
function 评分(h) {
  const p = h.p; let sc = 40; const 明细 = [];
  if (h.ztN >= 2) { sc += 18; 明细.push("涨停基因强·30日" + h.ztN + "次"); }
  else { sc += 10; 明细.push("30日涨停1次"); }
  if (h.近3日zt >= 2) { sc += 20; 明细.push("二板晋级确认"); }
  sc += 15; 明细.push("放量涨停启动");
  const 板块OK = !p.行业缺失 && (p.板块涨家 || 0) >= 3;
  if (p.行业缺失) { /* 行业数据源缺失：不加不扣 */ }
  else if (板块OK) { sc += 12; 明细.push("板块效应·同行业" + p.板块涨家 + "家上涨"); }
  else { sc -= 8; 明细.push("独立股警惕"); }
  if (h.位 < 60) { sc += 5; 明细.push("深度低位·处60日高点" + h.位 + "%"); }
  if (p.turn > 25) { sc -= 5; 明细.push("换手偏高"); }
  return { score: Math.max(0, Math.min(100, sc)), 板块OK, 明细 };
}

/* ── 大盘分时与单边跌（改 fetch）── */
async function 大盘分时() {
  try {
    const r = await fetch("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=sh000001",
      { headers: { "User-Agent": UA, Referer: "https://gu.qq.com/" }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const d = (j.data && j.data.sh000001) || {};
    const arr = ((d.data || {}).data) || [];
    const pts = [];
    for (const item of arr) {
      const q = String(item).split(" ");
      if (q.length >= 2 && !isNaN(parseFloat(q[1]))) pts.push({ t: q[0], p: parseFloat(q[1]) });
    }
    let prev = null;
    const qa = d.qt ? d.qt.sh000001 : null;
    if (qa && qa[4] !== undefined) prev = parseFloat(qa[4]);
    if (isNaN(prev) || !prev) prev = pts.length ? pts[0].p : null;
    return { pts, prev };
  } catch (e) { return null; }
}
function 大盘单跌(pts0, 昨收) {
  if (!pts0 || !pts0.length || !(昨收 > 0)) return false;
  const pts = pts0.filter((x) => x.t >= "0930");
  const n = pts.length;
  if (!n) return false;
  const chg = (pts[n - 1].p / 昨收 - 1) * 100;
  if (chg > -1.5) return false;
  let 高 = -1e9, 低 = 1e9;
  for (const x of pts) { if (x.p > 高) 高 = x.p; if (x.p < 低) 低 = x.p; }
  const 位置 = 高 > 低 ? (pts[n - 1].p - 低) / (高 - 低) : 0.5;
  return 位置 <= 0.2;
}

/* ── 主流程（原样保留，仅把 window.FS工具 换成 import）── */
export async function runYaoQianli(prog) {
  const P = (p, m) => { if (prog) prog(p, m); };
  const t0 = Date.now();
  const 行业缺失 = false;
  P(3, "检查市场情绪（策略前提）…");
  const [idxs, zt, dtN] = await Promise.all([getIndex(), getZTPool(), getDTPool()]);
  const temp = temperature(idxs, zt, dtN, 0);
  P(6, `温度 ${temp.temp} 分 · ${temp.state}`);
  const dp = await 大盘分时();
  const 单跌 = (dp && dp.pts && dp.pts.length && dp.prev > 0) ? 大盘单跌(dp.pts, dp.prev) : false;
  const 空仓 = (原因) => ({ empty: true, 空仓原因: 原因, date: today(), temperature: temp, picks: [], mode: "yao_ql", note: "妖股潜力扫描", gen_time: 时戳() });
  if (temp.temp < 35) return 空仓(`市场温度 ${temp.temp} 分（${temp.state}），情绪退潮，按策略停止妖股博弈`);
  if (单跌) return 空仓("大盘单边放量下跌，系统性风险，按策略空仓等待");
  P(10, "拉取全市场行情（市值 / 股价 / 换手 / 行业）…");
  const all = await 拉全市场行业版(P);
  const pool = scanYao(all, 行业缺失);
  P(34, `硬条件通过 ${pool.length} 只（市值20-80亿 · 股价5-20元 · 换手≤30%）`);
  if (!pool.length) return 空仓("无满足硬性量化条件的标的（20-80亿 · 5-20元），今日无妖股土壤");
  const k池 = pool.slice(0, 120);
  for (const k of k池) k.原始码 = k.code;
  P(38, `批量拉取日K（股性 / 筹码位 / 启动确认 · ${k池.length} 只）…`);
  const kmap = await batchKlines(k池);
  const hard = klineYao(k池, kmap);
  P(66, `K线条件通过 ${hard.length} 只（30日有涨停 · 低位 · 近3日放量启动）`);
  if (!hard.length) return 空仓("K线条件后无候选（近30日涨停 · 60日低位75%内 · 近3日放量涨停启动）");
  P(74, "新闻黑名单扫描（监管 / 减持 / 问询 一票否决）…");
  const newsHard = hard.slice(0, 30);
  let newsMap = {};
  try { newsMap = (await batchNews(newsHard)) || {}; } catch (e) { newsMap = {}; }
  const picks = [];
  for (const h of newsHard) {
    const p = h.p;
    const ni = newsMap[p.code] || { n: 0, senti: 0 };
    if (ni.senti <= -1) continue;
    const rs = 评分(h);
    const 警示 = [];
    if (!rs.板块OK && !p.行业缺失) 警示.push("独立股无板块跟风");
    if (p.turn > 25) 警示.push("换手偏高");
    picks.push({
      code: p.code, name: p.name, price: p.price, chg: p.chg, pct: p.chg,
      industry: p.hybk || "", score: rs.score,
      turnover: Math.round(p.turn * 10) / 10, 流通市值: p.fmv,
      涨停次数: h.ztN, 近3日涨停: h.近3日zt, 筹码位置: h.位, "60日涨幅": h.涨60,
      板块涨家: p.板块涨家 || 0, 板块OK: rs.板块OK, 行业缺失: !!p.行业缺失,
      明细: rs.明细, 警示,
      人工确认: ["题材想象空间", "板块龙头地位", "盘口承接力度"],
    });
  }
  picks.sort((a, b) => b.score - a.score);
  const seen = {}, top = [];
  for (const pk of picks) {
    if (top.length >= 5) break;
    const 键 = pk.industry || "其他";
    if ((seen[键] || 0) >= 2) continue;
    seen[键] = (seen[键] || 0) + 1;
    top.push(pk);
  }
  P(100, `完成 · 潜力标的 ${top.length} 只`);
  if (!top.length) return 空仓("黑名单否决后无可选（新闻负面 / 纯独立股），按策略放弃");
  return { empty: false, date: today(), temperature: temp, picks: top, mode: "yao_ql",
           note: "妖股潜力扫描 · 与五因子雷达并存 · 轻仓博弈" + (行业缺失 ? " · 行业数据源缺失，板块效应未计" : ""),
           gen_time: 时戳(), elapsed: Math.round((Date.now() - t0) / 100) / 10 };
}

/* 单独运行时自测：node yaogu.js */
if (process.argv[1] && process.argv[1].endsWith("yaogu.js")) {
  runYaoQianli((p, m) => console.log(`  [${p}%] ${m}`))
    .then((r) => console.log("\n结果：", JSON.stringify(r, null, 1).slice(0, 2000)))
    .catch((e) => { console.error("失败:", e); process.exit(1); });
}
