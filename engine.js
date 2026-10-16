// engine.js —— 稳健版选股引擎（Node 移植版）
// 移植自 A股选股看板.html 的 FS.run（稳健版：技术40%+消息40%+基本面20%）+ 共享数据层 FS工具。
// 纯计算 + 公开行情接口；去除了所有 window/DOM 依赖；gbk 解码用 iconv-lite。
// 输出结构对齐前端「拉后端存档 / 合并十日荐股」契约：{ date, gen_time, picks, temperature, main_lines }
import iconv from "iconv-lite";
import { readFileSync, existsSync } from "node:fs";

/* ── 动态参数：读取 review.js 每日收盘后生成的 params.json（自动复盘优化）──
   滚动成功率低 → 引擎自动温和收紧硬门槛；全部带硬上下限，防止过度激进。
   params.json 不存在时用默认值（即原引擎阈值）。 */
let CFG = 读动态参数();
/* 过滤统计（2026-10-16）：dryrun.js 演练用，记录 hardFilter 各阶段剔除数——主流程只累加，不影响选股 */
export const 过滤统计 = { 本次: null };
function 读动态参数() {
  const def = { 追高上限: 5, 量比下限: 1, 量比上限: 5, 换手下限: 2, 换手上限: 20, 温度下限: 35, 连板阈值: 2, 止损率: 0.92, 急涨上限: 30,
    /* 技术形态策略参数（2026-10-16 新增：金叉选股 / 死叉排除 / 底顶背离） */
    金叉窗口: 5, 死叉窗口: 3, 背离窗口: 30, 金叉加分: 2, 均线金叉加分: 1, 底背离加分: 4,
    /* 强势延续策略（2026-10-16 新增，90 交易日回溯驱动）：
       昨涨停 + 今涨幅 ≥ 强势延续下限 → 次日 +2.06%、胜率 57%（526 只次）；
       昨涨停 + 今浅回踩(-3%~+0.5%) → 次日 +0.79%、胜率 54%。两者均豁免追高上限。 */
    强势延续下限: 5, 回调回踩下限: -3, 回调回踩上限: 0.5, 强势延续只数: 1,
    /* 金叉必选 = 1：技术信号票（MACD金叉 / 均线金叉 / 底背离）≥5 只时只从信号票中选股；
       <5 只时自动放宽（全部候选参与、加分仍生效），避免弱势市况选不出票而空仓 */
    金叉必选: 1,
    /* 降频不空仓（2026-10-16 用户要求）：温度分档决定推荐只数，弱市不再是空仓而是压缩数量 */
    常态只数: 5, 弱市只数: 3, 冰点只数: 2, 极弱只数: 1 };
  const 钳 = (v, lo, hi) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  try {
    if (existsSync("params.json")) {
      const p = JSON.parse(readFileSync("params.json", "utf-8"));
      const c = p && typeof p === "object" ? (p.cfg || p) : {};
      const v = (k, lo, hi) => { const x = 钳(c[k], lo, hi); if (x != null) def[k] = Math.round(x * 100) / 100; };
      v("追高上限", 2, 6); v("量比下限", 0.5, 4); v("量比上限", 3, 8);
      v("换手下限", 0.5, 10); v("换手上限", 10, 35); v("温度下限", 30, 50);
      v("连板阈值", 1, 5); v("止损率", 0.85, 0.97); v("急涨上限", 15, 60);
      v("金叉窗口", 2, 15); v("死叉窗口", 1, 10); v("背离窗口", 15, 60);
      v("金叉加分", 0, 6); v("均线金叉加分", 0, 5); v("底背离加分", 0, 8);
      v("金叉必选", 0, 1);
      v("强势延续下限", 3, 9.5); v("回调回踩下限", -6, 0); v("回调回踩上限", 0, 3);
      v("强势延续只数", 1, 3);
      v("常态只数", 3, 8); v("弱市只数", 1, 5); v("冰点只数", 1, 4); v("极弱只数", 1, 3);
    }
  } catch (e) {}
  return def;
}

const UA =
  "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

/* ── 基础工具 ── */
function today() {
  const d = new Date();
  return (
    "" + d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2)
  );
}
function 今日键() {
  return today();
}
function calcMA(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
// 带超时 + 重试的 JSON GET
async function j(url, { timeout = 12000, retries = 2 } = {}) {
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
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}
// 文本 GET（东财 search-api 返回 JSONP，需正则抽取）
async function jt(url, { timeout = 12000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const 控 = new AbortController();
    const t = setTimeout(() => 控.abort(), timeout);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: 控.signal });
      clearTimeout(t);
      return await r.text();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
// Node 并发器（替代浏览器 workers 池，n 路并发）
function workers(n, tasks, taskFn) {
  let i = 0;
  const ps = [];
  function loop() {
    const k = i++;
    if (k >= tasks.length) return Promise.resolve();
    return Promise.resolve(taskFn(tasks[k], k)).then(loop);
  }
  for (let w = 0; w < n; w++) ps.push(loop());
  return Promise.all(ps);
}

/* ── 交易日判断（移植自原文件 3833-3900）── */
const 休市日 = {
  "2026-01-01": 1, "2026-01-02": 1,
  "2026-02-16": 1, "2026-02-17": 1, "2026-02-18": 1, "2026-02-19": 1, "2026-02-20": 1,
  "2026-02-23": 1,
  "2026-04-06": 1,
  "2026-05-01": 1, "2026-05-04": 1, "2026-05-05": 1,
  "2026-06-19": 1,
  "2026-09-25": 1,
  "2026-10-01": 1, "2026-10-02": 1, "2026-10-05": 1, "2026-10-06": 1, "2026-10-07": 1,
};
function 是周末() {
  const w = new Date().getDay();
  return w === 0 || w === 6;
}
function 是休市日(键) {
  return !!休市日[键 || 今日键()];
}
function 上一交易日() {
  const d = new Date();
  let 步 = 0;
  let 键 = 今日键();
  if (d.getHours() < 16) d.setDate(d.getDate() - 1);
  while (步++ < 40) {
    键 = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    const 周 = d.getDay();
    if (周 !== 0 && 周 !== 6 && !休市日[键]) return 键;
    d.setDate(d.getDate() - 1);
  }
  return 键;
}
function 选股日键() {
  const d = new Date();
  if (d.getHours() >= 16 && !是周末() && !是休市日(今日键())) return 今日键();
  return 上一交易日();
}

/* ── 数据层 ── */
async function getIndex() {
  try {
    const r = await fetch("https://qt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000688", {
      headers: { "User-Agent": UA },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const txt = iconv.decode(buf, "gbk");
    const out = [];
    const 正则 = /v_([a-z]{2}\d{6})="([^"]*)"/g;
    let m;
    while ((m = 正则.exec(txt)) !== null) {
      const f = m[2].split("~");
      if (f.length < 50) continue;
      out.push({
        f12: m[1].replace(/^[a-z]{2}/, ""),
        f14: m[1],
        f2: parseFloat(f[3]) || 0,
        f3: parseFloat(f[32]) || 0,
        成交额万: parseFloat(f[37]) || 0,
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}
async function getZTPool() {
  const 候选 = [];
  const d0 = new Date();
  for (let i = 0; i < 5; i++) {
    const dd = new Date(d0.getTime() - i * 86400000);
    const w = dd.getDay();
    if (w === 0 || w === 6) continue;
    const 串 =
      "" + dd.getFullYear() + ("0" + (dd.getMonth() + 1)).slice(-2) + ("0" + dd.getDate()).slice(-2);
    候选.push(串);
  }
  for (const 日 of 候选) {
    try {
      const d = await j(
        "https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fbt%3Aasc&date=" +
          日
      );
      const pool = (d && d.data && d.data.pool) || [];
      if (pool.length) return pool;
    } catch (e) {}
  }
  return [];
}
async function getDTPool() {
  /* 2026-10-16 口径统一（用户选 H）：改用东财跌停池 tc ——
     原口径「全市场涨幅 ≤ -9.8%」把创业板/科创板跌 10%（未封死）的票也算成跌停，
     实测同一时点 23 家 vs 跌停池 8 家，导致引擎定稿温度比看板实时值高约 13 分。
     统一为「东财跌停池」（真正封死的跌停股）；接口异常时回退原全市场统计。
     注：仅影响温度的「跌停数」项，个股归因（跌停闷杀）用的仍是个股自身日K数据。 */
  try {
    const d = await j(
      `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${today()}`
    );
    const tc = d && d.data && d.data.tc;
    if (typeof tc === "number") return tc;
  } catch (e) {}
  try {
    const 全部 = await 拉全市场();
    let n = 0;
    for (const x of 全部) if ((x.f3 || 0) <= -9.8) n++;
    return n;
  } catch (e) {
    return 0;
  }
}
function mainLines(zt) {
  const byHy = {};
  for (const x of zt) {
    const h = x.hybk || "其他";
    if (!byHy[h]) byHy[h] = { zt_count: 0, fund: 0 };
    byHy[h].zt_count++;
    byHy[h].fund += x.fund || 0;
  }
  const out = [];
  for (const k in byHy) {
    const v = byHy[k];
    if (v.zt_count >= 2 && v.fund > 0)
      out.push({ name: k, zt_count: v.zt_count, net_in: Math.round((v.fund / 1e8) * 100) / 100 });
  }
  out.sort((a, b) => b.net_in - a.net_in);
  return out.slice(0, 5);
}
function temperature(idxs, zt, dtN, zbN, breadth) {
  /* 权重定版（2026-10-16 用户要求：指数涨跌权重最高、涨跌停家数次之）——
     指数 40（上证+深证+创业板+科创50 四指数均值）> 涨停 15 + 跌停 15 > 广度 15 > 炸板 10 > 连板 5。
     演进：原算法（30/20/15/20/15，只看上证）→ 10-16 首次重构（30/14/6/18/10/22 三指数）
     → 本次按用户要求把指数提到最高（22→40）、加入科创50、涨跌停合计 30 分列第二。 */
  let shChg = 0, 指和 = 0, 指数 = 0;
  for (const x of idxs) {
    const raw = x.f3 || 0;
    const v = Math.abs(raw) > 20 ? raw / 100 : raw;
    指和 += v;
    指数++;
    if (x.f12 === "000001") shChg = v;
  }
  const 指均 = 指数 ? 指和 / 指数 : 0;
  let maxLb = 0;
  for (const x of zt) if (x.lbc > maxLb) maxLb = x.lbc;
  const zbRate = zt.length + zbN > 0 ? (zbN / (zt.length + zbN)) * 100 : 0;
  let s = 0;
  /* ① 指数涨跌 40 分（最高权重）：沪深创科四指数等权均值，**线性双向映射**——
     +3% 及以上拿满分 40；0% 得中点 20；-3% 及以下清零。斜率 20/3 ≈ 6.67 分每 1%。
     2026-10-16 用户要求：原规则「只在下跌时扣分」→ 平盘/微跌也拿 38~40 分，40 分权重形同不区分；
     现要求「涨 3% 才配满分、跌 3% 扣光」，故改为双向线性，涨幅同样需要挣分。 */
  s += Math.max(0, Math.min(40, 20 + 指均 * (20 / 3)));
  /* ② 涨停数 15 分（次高）：45 家满分 */
  s += Math.min(15, (zt.length / 45) * 15);
  /* ③ 跌停数 15 分（次高）：每家 -1.0 分，15 家清零 */
  s += Math.max(0, 15 - dtN * 1.0);
  /* ④ 涨跌家数（广度）15 分：涨家占比 60% 视为满分；数据缺失给中位 7.5 分不偏袒 */
  if (breadth && breadth.total > 0 && breadth.up != null) {
    const 涨比 = breadth.up / breadth.total;
    s += Math.max(0, Math.min(15, (涨比 / 0.6) * 15));
  } else {
    s += 7.5;
  }
  /* ⑤ 炸板率 10 分：>15% 后每 1% 扣 1.2 分 */
  s += Math.max(0, 10 - Math.max(0, zbRate - 15) * 1.2);
  /* ⑥ 最高连板 5 分：5 板满分（弱市连板不代表人气，权重最低） */
  s += Math.min(5, (maxLb / 5) * 5);
  if (指均 < -1) s = Math.min(s, 55);
  if (指均 < -2) s = Math.min(s, 28);
  if (指均 < -3) s = Math.min(s, 12);
  s = Math.max(0, Math.min(100, Math.round(s)));
  const state = s >= 70 ? "强势" : s >= 50 ? "中性偏强" : s >= 35 ? "中性偏弱" : "冰点/退潮";
  const pos_advice =
    s >= 70 ? "总仓位 60-80%，可适度追强"
      : s >= 50 ? "总仓位 40-60%，低吸为主不追高"
      : s >= 35 ? "总仓位 20-40%，只做确定性最高 1-2 只"
      : "总仓位 ≤10%，降频 1-2 只试探（不空仓），等主线明确再加仓";
  const 分项 = [
    { 名: "指数涨跌", 权重: 40, 得分: Math.round(Math.max(0, Math.min(40, 20 + 指均 * (20 / 3))) * 10) / 10,
      判据: `沪深创科四指数均值 ${指均 >= 0 ? "+" : ""}${Math.round(指均 * 100) / 100}%（+3% 满分、0% 得 20 分、−3% 清零）` },
    { 名: "涨停数", 权重: 15, 得分: Math.round(Math.min(15, (zt.length / 45) * 15) * 10) / 10, 判据: `${zt.length} 家（45 家即满分）` },
    { 名: "跌停数", 权重: 15, 得分: Math.round(Math.max(0, 15 - dtN * 1.0) * 10) / 10, 判据: `${dtN} 家（每家 −1.0 分，15 家清零）` },
    { 名: "涨跌家数", 权重: 15, 得分: breadth && breadth.total ? Math.round(Math.max(0, Math.min(15, (breadth.up / breadth.total / 0.6) * 15)) * 10) / 10 : 7.5,
      判据: breadth && breadth.total ? `涨 ${breadth.up}/${breadth.total} 只（涨比 ${Math.round((breadth.up / breadth.total) * 1000) / 10}%，60% 即满分）` : "数据未取到 → 按中位 7.5 分" },
    { 名: "炸板率", 权重: 10, 得分: Math.round(Math.max(0, 10 - Math.max(0, zbRate - 15) * 1.2) * 10) / 10, 判据: `${Math.round(zbRate * 10) / 10}%（>15% 后每 1% 扣 1.2 分）` },
    { 名: "最高连板", 权重: 5, 得分: Math.round(Math.min(5, (maxLb / 5) * 5) * 10) / 10, 判据: `${maxLb} 板（5 板即满分）` },
  ];
  const 硬顶 = 指均 < -3 ? "已触发：四指数均跌≥3% → 总分封顶 12"
    : 指均 < -2 ? "已触发：四指数均跌≥2% → 总分封顶 28"
    : 指均 < -1 ? "已触发：四指数均跌≥1% → 总分封顶 55" : "未触发";
  return { temp: s, zt_count: zt.length, dt_count: dtN, zb_count: zbN, max_lb: maxLb,
           state: state, pos_advice: pos_advice, 分项, 硬顶,
           shChg: Math.round(shChg * 100) / 100, 指均: Math.round(指均 * 100) / 100,
           广度: breadth && breadth.total ? Math.round((breadth.up / breadth.total) * 1000) / 10 : null };
}

/* ── 全市场扫描（腾讯 qt.gtimg，gbk）── */
const 代码段 =
  "sh600000-600999|sh601000-601999|sh603000-603999|sh605000-605999" +
  "|sz0-999|sz1000-1999|sz2000-2999|sz3000-3999|sz300000-301999";
let 全市场代码 = null;
function 展开代码段() {
  if (全市场代码) return 全市场代码;
  const out = [];
  const 段 = 代码段.split("|");
  for (const s of 段) {
    const 市 = s.slice(0, 2);
    const 界 = s.slice(2).split("-");
    const a = parseInt(界[0], 10),
      b = parseInt(界[1], 10);
    for (let n = a; n <= b; n++) {
      let 数 = String(n);
      while (数.length < 6) 数 = "0" + 数;
      out.push(市 + 数);
    }
  }
  全市场代码 = out;
  return out;
}
const 行情块 = 200;
let _全市场缓存 = null,
  _全市场缓存时 = 0;
async function 取行情文本(批) {
  const 址 = "https://qt.gtimg.cn/q=" + 批.join(",");
  try {
    const r = await fetch(址, { headers: { "User-Agent": UA } });
    const buf = Buffer.from(await r.arrayBuffer());
    return iconv.decode(buf, "gbk");
  } catch (e) {
    return "";
  }
}
function 解行情(文本) {
  const out = [];
  const 正则 = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = 正则.exec(文本)) !== null) {
    const f = m[2].split("~");
    if (f.length < 50) continue;
    const 价 = parseFloat(f[3]);
    if (!(价 > 0)) continue;
    out.push({
      f12: m[1].replace(/^[a-z]{2}/, ""),
      f14: f[1],
      全码: m[1],
      价: 价,
      涨跌: parseFloat(f[32]) || 0,
      量: parseFloat(f[6]) || 0,
      涨停价: parseFloat(f[47]) || 0,
      跌停价: parseFloat(f[48]) || 0,
      换手: parseFloat(f[38]) || 0,
      量比: parseFloat(f[49]) || 0,
      流通市值: parseFloat(f[44]) || 0,
      市盈率: parseFloat(f[39]) || 0,
      总市值: parseFloat(f[45]) || 0,
      主力净流入: parseFloat(f[86]) || 0,
    });
  }
  return out;
}
function 转东财结构(r) {
  return {
    f12: r.f12,
    f14: r.f14,
    全码: r.全码,
    f2: r.价,
    f3: r.涨跌,
    f8: r.换手,
    f9: r.量比,
    f21: r.流通市值 * 1e8,
    f20: r.总市值 * 1e8,
    f23: 0,
    f9_: r.市盈率,
    f62: 0,
    f100: "",
    f15: 0,
    f16: 0,
    f17: 0,
    f18: 0,
    量: r.量,
    涨停价: r.涨停价,
    跌停价: r.跌停价,
    主力净流入: r.主力净流入,
  };
}
async function 拉全市场() {
  const 现在 = Date.now();
  if (_全市场缓存 && 现在 - _全市场缓存时 < 10000) return _全市场缓存;
  const 码 = 展开代码段();
  const 批组 = [];
  for (let i = 0; i < 码.length; i += 行情块) 批组.push(码.slice(i, i + 行情块));
  let 结果 = [];
  let idx = 0;
  function loop() {
    const k = idx++;
    if (k >= 批组.length) return Promise.resolve();
    return 取行情文本(批组[k]).then((t) => {
      结果 = 结果.concat(解行情(t));
      return loop();
    });
  }
  const ps = [];
  for (let w = 0; w < 8; w++) ps.push(loop());
  await Promise.all(ps);
  const out = 结果.map(转东财结构);
  if (out.length > 3000) {
    _全市场缓存 = out;
    _全市场缓存时 = Date.now();
  }
  return out;
}

/* ── 日K / 批量 ── */
async function 取日K(代码) {
  const 全码 = /^[a-z]{2}/.test(代码) ? 代码 : 代码.charAt(0) === "6" ? "sh" + 代码 : "sz" + 代码;
  const 址 =
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=" +
    全码 +
    ",day,,,80,qfq";
  try {
    const d = await j(址);
    const 节点 = d && d.data && d.data[全码];
    const 行集 = (节点 && (节点.qfqday || 节点.day)) || [];
    return 行集.map((r) => ({
      TRADE_DATE: r[0],
      OPEN_PRICE: parseFloat(r[1]),
      CLOSE_PRICE: parseFloat(r[2]),
      HIGH_PRICE: parseFloat(r[3]),
      LOW_PRICE: parseFloat(r[4]),
      VOLUME: parseFloat(r[5]),
    }));
  } catch (e) {
    return [];
  }
}
async function batchKlines(cands) {
  const map = {};
  const 码表 = cands.map((c) => c.code);
  let idx = 0;
  function loop() {
    const k = idx++;
    if (k >= 码表.length) return Promise.resolve();
    const 代码 = 码表[k];
    const 原始 = cands[k].原始码 || 代码;
    return 取日K(原始).then((rows) => {
      map[代码] = rows;
      return loop();
    });
  }
  const ps = [];
  for (let w = 0; w < 8; w++) ps.push(loop());
  await Promise.all(ps);
  return map;
}

/* ── 行业归属（东财 f127）── */
async function 批行业(候选) {
  const map = {};
  await workers(4, 候选.slice(), (p) => {
    const sec = (p.code.charAt(0) === "6" ? "1." : "0.") + p.code;
    return fetch(
      "https://push2.eastmoney.com/api/qt/stock/get?secid=" +
        sec +
        "&fields=f127&ut=fa5fd1943c7b386f172d6893dbfba10b",
      { headers: { "User-Agent": UA } }
    )
      .then((r) => r.json())
      .then((d) => {
        map[p.code] = (d && d.data && d.data.f127) || "";
      })
      .catch(() => {
        map[p.code] = "";
      });
  });
  return map;
}

/* ── 新闻情感（东财 search-api JSONP → Node 走文本解析）── */
const SENTI_POS = ["涨停","上涨","大涨","增长","大增","超预期","中标","签约","利好","回购","增持","扭亏","盈利","创新高","突破","大单","预增","翻倍","放量","新高","分红","扩产","获批","合作","订单","提升","改善","创收","净增","看好","强于","跑赢","上修","领涨","走强","活跃","景气","提速","加码"];
const SENTI_NEG = ["下跌","下滑","大跌","亏损","减持","质押","处罚","违规","立案","退市","预警","利空","商誉","减值","暴跌","跌停","下调","低于预期","诉讼","冻结","终止","问询","监管","套现","被查","风险","承压","降级","退潮","炸板","净流出","流出","回落","走弱","失守","中止","取消"];
const SENTI_TRAP = ["利好出尽","不及预期","假涨停","涨停打开","涨停回落","涨停跳水","涨停炸板","高位放量","放量下跌","放量滞涨","上涨乏力","冲高跳水","断板","天地板","核按钮"];
function analyzeSentiment(titles) {
  let pos = 0,
    neg = 0;
  for (const t of titles) {
    let tt = t;
    for (const trap of SENTI_TRAP) while (tt.indexOf(trap) >= 0) {
      neg++;
      tt = tt.replace(trap, "□");
    }
    for (const w of SENTI_POS) if (tt.indexOf(w) >= 0) pos++;
    for (const w of SENTI_NEG) if (tt.indexOf(w) >= 0) neg++;
  }
  let net = pos - neg;
  if (net > 3) net = 3;
  if (net < -3) net = -3;
  return net;
}
async function getStockNews(code) {
  const param = {
    uid: "",
    keyword: code,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "time", pageIndex: 1, pageSize: 10, preTag: "", postTag: "" } },
  };
  const url =
    "https://search-api-web.eastmoney.com/search/jsonp?cb=scb&param=" +
    encodeURIComponent(JSON.stringify(param));
  try {
    const txt = await jt(url);
    const titles = [];
    const s2 = String(txt);
    const i1 = s2.indexOf("("),
      i2 = s2.lastIndexOf(")");
    if (i1 >= 0 && i2 > i1) {
      const d = JSON.parse(s2.slice(i1 + 1, i2));
      const arr = (d.result && d.result.cmsArticleWebOld) || [];
      for (const x of arr) if (x.title) titles.push(String(x.title).replace(/<[^>]+>/g, ""));
    }
    return titles;
  } catch (e) {
    return [];
  }
}
async function batchNews(hard) {
  const map = {};
  await workers(4, hard.slice(), (it) =>
    getStockNews(it.p.code).then((titles) => {
      map[it.p.code] = { n: titles.length, senti: analyzeSentiment(titles) };
    })
  );
  return map;
}

/* ── 稳健版漏斗（移植自 FS.run）── */
function scan(cands, ztCodes) {
  const out = [];
  const zs = {};
  for (const c of ztCodes) zs[c] = 1;
  for (const r of cands) {
    const code = String(r.f12),
      name = String(r.f14 || "");
    const price = r.f2,
      chg = r.f3,
      turn = r.f8,
      vr = r.f9,
      fmv = r.f21 ? r.f21 / 1e8 : 0;
    if (price == null || price <= 0) continue;
    if (chg == null || chg <= 0) continue; // 当日红盘
    /* 2026-10-16 数据驱动改造：追高过滤从初筛移到 hardFilter 精判。
       原因：判断「昨日是否涨停」需要日K，初筛只有行情快照拿不到；而数据显示
       「昨日涨停 + 今日涨幅 ≥5%」是全场唯一可买入的正收益组合（次日 +2.06%、胜率 57%），
       原初筛把 ≥追高上限 一刀切掉，导致这类票永远无法入选（也解释了 B3/B6 从未触发）。
       此处只截在涨停线前（封死涨停的票尾盘买不到）。 */
    if (chg >= 9.8) continue;
    /* 2026-10-16：量比/换手同追高一样从初筛移到 hardFilter 精判 ——
       强势延续票（昨涨停+今续强）天然高量比高换手，被初筛区间挡在门外
       （实测：皇台酒业换手 25% 超上限；新华文轩量比盘中飙升）。初筛只留宽松边界。 */
    if (vr == null || vr < 0.5 || vr > 20) continue; // 量比宽松边界（精判见 hardFilter）
    if (turn == null || turn < 1 || turn > 80) continue; // 换手宽松边界（精判见 hardFilter）
    if (fmv < 20 || fmv > 800) continue; // 流通市值 20-800亿
    if (price > 60) continue; // 股价 <= 60（用户放宽）
    if (code.startsWith("688")) continue; // 排除科创板（用户要求，仅留沪深主板+创业）
    if (name.indexOf("ST") >= 0 || name.indexOf("*") >= 0 || name.indexOf("N") === 0 || name.indexOf("退") >= 0) continue;
    if (zs[code]) continue; // 涨停封死买不进
    if (chg >= 9.5) continue; // 未涨停（主板）
    out.push({
      code,
      name,
      price,
      chg,
      turn,
      vr,
      fmv,
      f62: r.f62 || 0,
      hybk: r.f100 || "",
      原始码: r.全码 || code,
      市盈率: r.f9_ || 0,
    });
  }
  return out;
}
function macdSeries(closes) {
  const n = closes.length;
  if (n < 35) return null;
  let ema12 = closes[0],
    ema26 = closes[0],
    dea = 0;
  const difArr = [],
    deaArr = [],
    histArr = [];
  const k12 = 2 / 13,
    k26 = 2 / 27,
    k9 = 2 / 10;
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    ema12 = c * k12 + ema12 * (1 - k12);
    ema26 = c * k26 + ema26 * (1 - k26);
    const dif = ema12 - ema26;
    dea = i === 0 ? dif : dif * k9 + dea * (1 - k9);
    difArr.push(dif);
    deaArr.push(dea);
    histArr.push(2 * (dif - dea));
  }
  return { dif: difArr[n - 1], dea: deaArr[n - 1], hist: histArr[n - 1], histArr, histPrev: n >= 2 ? histArr[n - 2] : null, difArr, deaArr };
}

/* ── 金叉/死叉/背离（2026-10-16 新增，用户要求：金叉选股、死叉排除、底/顶背离策略）──
   数据：日K 80 根（取日K 已拉），MACD 用 12/26/9 标准参数，与 macdSeries 同源。
   策略定位：金叉 / 底背离 = 加分优选（买入信号）；死叉 / 顶背离 = 硬剔除（风险信号）。
   金叉不作为唯一必要条件——否则与「红柱加长」叠加会使候选池枯竭（实测候选数 20-60 只，全要金叉会显著减少）。 */

/* MACD 金叉：近 窗 日内发生 DIF 上穿 DEA；返回距今天数（1 = 当日金叉），0 表示未发生 */
function macd金叉序(mc, 窗) {
  if (!mc || !mc.difArr || !mc.deaArr) return 0;
  const d = mc.difArr, e = mc.deaArr, n = d.length;
  for (let k = 0; k < 窗; k++) {
    const i = n - 1 - k;
    if (i < 1) break;
    if (d[i] > e[i] && d[i - 1] <= e[i - 1]) return k + 1;
  }
  return 0;
}
/* MACD 死叉：近 窗 日内发生 DIF 下穿 DEA（走弱初期，剔除） */
function macd死叉序(mc, 窗) {
  if (!mc || !mc.difArr || !mc.deaArr) return 0;
  const d = mc.difArr, e = mc.deaArr, n = d.length;
  for (let k = 0; k < 窗; k++) {
    const i = n - 1 - k;
    if (i < 1) break;
    if (d[i] < e[i] && d[i - 1] >= e[i - 1]) return k + 1;
  }
  return 0;
}
/* 均线某位置值（含第 i 根的 n 日均值）；样本不足返回 null */
function maAt(closes, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += closes[j];
  return s / n;
}
/* 均线金叉/死叉：近 窗 日内 MA5 上穿（或下穿）MA10；返回距今天数，0 = 未发生 */
function 均线交叉序(closes, 窗, 向上) {
  const n = closes.length;
  for (let k = 0; k < 窗; k++) {
    const i = n - 1 - k;
    if (i < 10) break;
    const a0 = maAt(closes, 5, i), b0 = maAt(closes, 10, i);
    const a1 = maAt(closes, 5, i - 1), b1 = maAt(closes, 10, i - 1);
    if (a0 == null || b0 == null || a1 == null || b1 == null) break;
    if (向上 ? (a0 > b0 && a1 <= b1) : (a0 < b0 && a1 >= b1)) return k + 1;
  }
  return 0;
}
/* 背离判定（价 vs MACD DIF）：窗口内前后半段极值比较，间隔需 ≥5 日（过滤噪声）
   底背离 = 后半段最低收盘更低、但该处 DIF 更高 → 下跌动能衰竭（看涨）
   顶背离 = 后半段最高收盘更高、但该处 DIF 更低 → 上涨动能衰竭（看跌） */
function 背离判定(closes, mc, 窗) {
  const 空 = { 底背离: false, 顶背离: false, 低差: 0, 高差: 0 };
  if (!mc || !mc.difArr) return 空;
  const n = closes.length, dif = mc.difArr;
  const 起 = Math.max(0, n - (窗 || 30));
  if (n - 起 < 12) return 空;
  const 中 = 起 + Math.floor((n - 起) / 2);
  let 低A = 起, 高A = 起, 低B = 中, 高B = 中;
  for (let i = 起; i < 中; i++) {
    if (closes[i] < closes[低A]) 低A = i;
    if (closes[i] > closes[高A]) 高A = i;
  }
  for (let i = 中; i < n; i++) {
    if (closes[i] < closes[低B]) 低B = i;
    if (closes[i] > closes[高B]) 高B = i;
  }
  const 底 = (低B - 低A) >= 5 && closes[低B] < closes[低A] && dif[低B] > dif[低A];
  const 顶 = (高B - 高A) >= 5 && closes[高B] > closes[高A] && dif[高B] < dif[高A];
  return {
    底背离: 底, 顶背离: 顶,
    低差: Math.round((closes[低B] - closes[低A]) / closes[低A] * 1000) / 10,
    高差: Math.round((closes[高B] - closes[高A]) / closes[高A] * 1000) / 10,
  };
}
/* B3 涨停回调形态识别：近10日内曾涨停、其后缩量回调、且不破MA10 */
/* 涨停回调（B3）——2026-10-16 按 90 交易日回溯修正：
   昨涨停股按「今日涨跌档」看次日收益：-2~0%（浅回踩）+0.79%/胜率54%、-5~-2% +0.09%、
   0~2% 0.00%、2~5% -0.68%、<-5%（深回踩）-1.54%。原条件（回调窗口 10 日、不限今日幅度）
   把深回踩与中继整理全放进来，且成交额/形态叠加后从未触发。现收窄为：
   回调窗口 ≤2 日 + 今日回踩幅度限定 [回调回踩下限, 回调回踩上限]。 */
function detect涨停回调(rows, closes, ma10) {
  const n = closes.length;
  if (n < 12 || ma10 == null) return null;
  const last = closes[n - 1];
  const 昨收 = closes[n - 2];
  if (last < ma10) return null;
  if (昨收 > 0) {
    const 今涨 = ((last - 昨收) / 昨收) * 100;
    if (!(今涨 >= CFG.回调回踩下限 && 今涨 <= CFG.回调回踩上限)) return null;
  }
  let 涨停序 = -1;
  for (let i = n - 2; i >= Math.max(1, n - 3); i--) {
    const 收 = closes[i],
      昨 = closes[i - 1];
    if (昨 > 0 && (收 - 昨) / 昨 >= 0.098) {
      涨停序 = i;
      break;
    }
  }
  if (涨停序 < 0) return null;
  const 涨停收 = closes[涨停序];
  if (last >= 涨停收) return null;
  const 涨停量 = (rows[涨停序] && rows[涨停序].VOLUME) || 0;
  if (!(涨停量 > 0)) return null;
  let 回量 = 0,
    回日 = 0;
  for (let j = 涨停序 + 1; j < n; j++) {
    const v = (rows[j] && rows[j].VOLUME) || 0;
    if (v > 0) {
      回量 += v;
      回日++;
    }
  }
  if (回日 < 1) return null;
  const 均量 = 回量 / 回日;
  const 缩量比 = 1 - 均量 / 涨停量;
  if (缩量比 < 0.15) return null;
  if (last < 昨收涨停防线(closes, 涨停序)) return null;
  return { 涨停日: (rows[涨停序] && rows[涨停序].TRADE_DATE) || "", 回调天数: n - 1 - 涨停序, 缩量比: Math.round(缩量比 * 100) };
}
/* 强势延续（B6）——2026-10-16 新增，数据驱动：
   昨日涨停 + 今日涨幅 ∈ [强势延续下限, 9.8%) → 次日 +2.06%、胜率 57%（526 只次，90 交易日）。
   上限截 9.8% 是因为收盘封死涨停的票尾盘买不到（可买性约束），只取仍在交易区间的。
   注：与「连板高位」反向——连板是近 5 日 ≥2 次涨停（易炸板），这里只要求昨日 1 次涨停 + 今日续强。 */
function detect强势延续(rows, closes, code) {
  const n = closes.length;
  if (n < 4) return null;
  const c = String(code || "");
  const 涨停线 = c.charAt(0) === "3" || c.startsWith("688") ? 19.8 : 9.8;
  const 今 = closes[n - 1], 昨 = closes[n - 2], 前 = closes[n - 3];
  if (前 <= 0 || 昨 <= 0) return null;
  const 昨涨 = ((昨 - 前) / 前) * 100;
  const 今涨 = ((今 - 昨) / 昨) * 100;
  if (昨涨 < 涨停线 - 0.2) return null;                      /* 昨日须涨停 */
  if (今涨 < CFG.强势延续下限 || 今涨 >= 涨停线 - 0.2) return null;  /* 今日续强但未封死 */
  return { 昨涨: Math.round(昨涨 * 10) / 10, 今涨: Math.round(今涨 * 10) / 10 };
}

function 昨收涨停防线(closes, 涨停序) {
  if (涨停序 < 1) return 0;
  const 前收 = closes[涨停序 - 1];
  return 前收 + (closes[涨停序] - 前收) * 0.5;
}
/* 温度 → 推荐只数（降频不空仓，2026-10-16 用户要求）：
   ≥50 常态 5 只；35~50 弱市 3 只；20~35 冰点 2 只；<20 极弱 1 只。
   原先温度 < 门槛直接空仓，会整段错过弱市中的结构性机会，改为压缩数量、只做最高分的少数票。 */
function 温度目标只数(t) {
  if (t == null) return CFG.常态只数;
  if (t >= 50) return CFG.常态只数;
  if (t >= CFG.温度下限) return CFG.弱市只数;
  if (t >= 20) return CFG.冰点只数;
  return CFG.极弱只数;
}

function hardFilter(pool, klineMap) {
  const out = [];
  const 统计 = { 输入: pool.length, 数据不足: 0, 均线不足: 0, 连板剔除: 0, 急涨剔除: 0,
    均线空头: 0, 均线未上行: 0, 死叉剔除: 0, 均线死叉剔除: 0, 顶背离剔除: 0, 形态不符: 0,
    追高剔除: 0, 量比剔除: 0, 换手剔除: 0, 通过: 0, 金叉票: 0, 均线金叉票: 0, 底背离票: 0, 强势延续票: 0, 涨停回调票: 0 };
  for (const p of pool) {
    const rows = klineMap[p.code];
    if (!rows || rows.length < 35) { 统计.数据不足++; continue; }
    rows.sort((a, b) => (a.TRADE_DATE < b.TRADE_DATE ? -1 : 1));
    const closes = rows.map((r) => r.CLOSE_PRICE);
    const ma5 = calcMA(closes, 5),
      ma10 = calcMA(closes, 10),
      ma30 = calcMA(closes, 30);
    const ma5p = calcMA(closes.slice(0, -1), 5),
      ma10p = calcMA(closes.slice(0, -1), 10),
      ma30p = calcMA(closes.slice(0, -1), 30);
    if (ma5 == null || ma10 == null || ma30 == null || ma5p == null) { 统计.均线不足++; continue; }
    // 接近连板过滤：近5个交易日出现≥2次涨停/接近涨停（按板块涨停线）即视为连板/接近连板，剔除追高接盘
    const 涨停线 = p.code.charAt(0) === "3" || p.code.startsWith("688") ? 0.198 : 0.098;
    let 近5涨停 = 0;
    for (let i = closes.length - 1; i >= Math.max(0, closes.length - 5); i--) {
      const 昨 = closes[i - 1];
      if (昨 > 0 && (closes[i] - 昨) / 昨 >= 涨停线 * 0.98) 近5涨停++;
    }
    /* 2026-10-16：强势延续票豁免连板剔除——「昨涨停+今续强」的组合天然属于近 5 日≥2 次涨停，
       若不豁免，新策略（实测次日 +2.06%、胜率 57%）将永远无法入选，成为死代码。
       实测根因：dryrun 中 10-16 的 2 只合格票（皇台酒业/新华文轩）分别被换手上限与连板剔除挡掉。 */
    /* 强势延续判定必须放在连板剔除之前（只需收盘价序列与代码，不依赖均线） */
    const 强势延续 = detect强势延续(rows, closes, p.code);
    if (近5涨停 >= CFG.连板阈值 && !强势延续) { 统计.连板剔除++; continue; } // 连板阈值（复盘自适应；强势延续豁免）
    // 急涨（近似90度斜率）过滤：近5个交易日累计涨幅过大视为竖直拉升，避免高位接盘（用户要求，复盘自适应）
    const 近5涨幅 = closes.length >= 6 && closes[closes.length - 6] > 0
      ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      : 0;
    if (近5涨幅 >= CFG.急涨上限) { 统计.急涨剔除++; continue; } // 斜率过陡剔除阈值（复盘自适应）
    /* 2026-10-16 数据驱动豁免：强势延续票不要求均线多头/上行 ——
       回溯（600 只样本池）显示昨涨停+今续强（5~9.8%）中，均线多头组次日 -0.64%（149 只次），
       均线非多头组次日 +1.47%/胜率 57%（79 只次）→ 差 -2.11pct。
       机理：昨涨停+今续强且均线已多头 = 连涨一段（易见顶）；均线未走好的多为底部第一波反弹（空间大）。
       注意：均线门槛在全样本上仍有微弱正效（+0.09pct），故只对本策略豁免，不做全局放宽。 */
    if (!(ma5 > ma10 && ma10 > ma30) && !强势延续) { 统计.均线空头++; continue; } // 均线多头（强势延续豁免）
    if (!(ma5 > ma5p && ma10 > ma10p && ma30 > ma30p) && !强势延续) { 统计.均线未上行++; continue; } // 同步上行（强势延续豁免）
    const last = closes[closes.length - 1];
    const mc = macdSeries(closes);
    /* ── 金叉/死叉/背离（2026-10-16 用户策略：金叉选股、死叉排除、底/顶背离）──
       死叉 = 走弱初期（近 CFG.死叉窗口 日 DIF 下穿 DEA）→ 硬剔除；
       均线死叉 = MA5 下穿 MA10 → 硬剔除；
       顶背离 = 价创新高而 DIF 走低（上涨动能衰竭）→ 硬剔除；
       金叉 / 底背离 → 不剔除，作为加分优选（见 scoreTechDetail / buildPicks） */
    const 死叉序 = macd死叉序(mc, CFG.死叉窗口);
    /* 死叉排除的边界：MACD 死叉 + 跌破 MA10（破位确认）才剔除。
       理由——B3 涨停回调形态本质是回踩，回踩中 MACD 短期死叉常见且健康；
       若一律剔除会误杀缩量回踩的强势票。破位（收盘 < MA10）才代表回踩失败、动能转弱。 */
    if (死叉序 > 0 && last < ma10) { 统计.死叉剔除++; continue; }
    const 均线死叉序 = 均线交叉序(closes, CFG.死叉窗口, false);
    if (均线死叉序 > 0) { 统计.均线死叉剔除++; continue; }
    const 背离 = 背离判定(closes, mc, CFG.背离窗口);
    if (背离.顶背离) { 统计.顶背离剔除++; continue; }
    const 金叉序 = macd金叉序(mc, CFG.金叉窗口);
    const 均线金叉序 = 均线交叉序(closes, CFG.金叉窗口, true);
    const 红柱 = !!(mc && mc.dif > mc.dea && mc.hist > 0);
    // MACD 红柱必须处于「加长阶段」：当前红柱 > 前一根红柱（动能增强）；缩短阶段剔除，避免强弩之末
    const 红柱加长 = !!(红柱 && mc.histPrev != null && mc.hist > mc.histPrev);
    const 涨停回调 = detect涨停回调(rows, closes, ma10);
    /* 追高精判（2026-10-16 从初筛移入）：涨幅 ≥ 追高上限 且 非「强势延续」→ 剔除；
       强势延续票（昨涨停+今续强）豁免，因此类组合实测次日 +2.06%/胜率 57%。 */
    if (p.chg != null && p.chg >= CFG.追高上限 && !强势延续) { 统计.追高剔除++; continue; }
    /* 量比/换手精判（2026-10-16 从初筛移入）：非强势延续票仍按自适应区间剔除，强势延续票豁免 */
    if (!强势延续) {
      if (p.vr == null || p.vr < CFG.量比下限 || p.vr > CFG.量比上限) { 统计.量比剔除++; continue; }
      if (p.turn == null || p.turn < CFG.换手下限 || p.turn > CFG.换手上限) { 统计.换手剔除++; continue; }
    }
    if (!((last >= ma5 && 红柱加长) || 涨停回调 || 强势延续)) { 统计.形态不符++; continue; }
    let redDays = 0;
    if (mc && mc.histArr)
      for (let d = mc.histArr.length - 1; d >= 0; d--) {
        if (mc.histArr[d] > 0) redDays++;
        else break;
      }
    let h20 = 0;
    for (let h = Math.max(0, closes.length - 20); h < closes.length; h++) if (closes[h] > h20) h20 = closes[h];
    out.push({ p, ma5, ma10, ma30, redDays, h20, 涨停回调, 强势延续, 红柱加长, 近5涨幅: Math.round(近5涨幅 * 10) / 10,
      金叉序, 均线金叉序, 底背离: 背离.底背离, 背离 });
    统计.通过++;
    if (强势延续) 统计.强势延续票++;
    if (涨停回调) 统计.涨停回调票++;
    if (金叉序 > 0) 统计.金叉票++;
    if (均线金叉序 > 0) 统计.均线金叉票++;
    if (背离.底背离) 统计.底背离票++;
  }
  过滤统计.本次 = 统计;
  return out;
}
function scoreFund(roe, yoy, gm, pe) {
  let s = 0;
  s += Math.min(4, (Math.max(0, roe) / 10) * 4);
  s += Math.min(3, (Math.max(0, yoy) / 150) * 3);
  s += Math.min(2, (Math.max(0, gm) / 50) * 2);
  s += pe != null && pe < 100 ? 1 : 0;
  return Math.round(s * 10) / 10;
}
async function getFin(codes) {
  const c = codes.map((x) => '"' + x + '"').join(",");
  try {
    const d = await j(
      "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=SECURITY_CODE,REPORT_DATE,ROEJQ,PARENTNETPROFIT,XSMLL&filter=(SECURITY_CODE+in+(" +
        encodeURIComponent(c) +
        "))&pageNumber=1&pageSize=" +
        codes.length * 6 +
        "&sortColumns=REPORT_DATE&sortTypes=-1"
    );
    return (d.result && d.result.data) || [];
  } catch (e) {
    return [];
  }
}
async function getZBPool() {
  try {
    const d = await j(
      "https://push2ex.eastmoney.com/getTopicZBPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fund%3Aasc&date=" +
        today()
    );
    const pool = (d.data && d.data.pool) || [];
    const s = {};
    for (const x of pool) s[String(x.c)] = 1;
    return s;
  } catch (e) {
    return {};
  }
}
/* 新浪快讯（Node 走普通 JSON，无 JSONP/DOM）；失败返回 null → 关闭快讯加权 */
async function getFlash() {
  try {
    const txt = await jt("https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=80&page=1");
    const s = String(txt);
    const i1 = s.indexOf("("),
      i2 = s.lastIndexOf(")");
    const data = i1 >= 0 && i2 > i1 ? JSON.parse(s.slice(i1 + 1, i2)) : JSON.parse(s);
    const arr = (data.result && data.result.data) || [];
    const t = [];
    for (const x of arr) if (x.title) t.push(String(x.title));
    return t;
  } catch (e) {
    return null;
  }
}
async function batchFin(hard) {
  const codes = hard.map((x) => x.p.code);
  const map = {},
    tasks = [];
  for (let j = 0; j < codes.length; j += 30) tasks.push(codes.slice(j, j + 30));
  await workers(3, tasks, (batch) =>
    getFin(batch).then((rows) => {
      for (const r of rows) {
        const c = r.SECURITY_CODE;
        if (!map[c]) map[c] = [];
        map[c].push(r);
      }
    })
  );
  return map;
}
/* ── 三维细项打分（各 10 分满分）· 供 UI 点开显示逐条理由 ── */
function scoreTechDetail(it, p) {
  const 项 = [];
  const 均线分 = it.maOk ? 4 : it.redDays > 0 ? 2 : 0;
  项.push({ 名称: "均线多头排列", 得分: 均线分, 满分: 4, 说明: it.maOk ? "MA5>MA10>MA20>MA30，多头格局确立" : "均线尚未完全多头，形态偏弱" });
  const 红盘分 = Math.min(3, Math.round((it.redDays / 45) * 3 * 10) / 10);
  项.push({ 名称: "连续红盘", 得分: 红盘分, 满分: 3, 说明: `近 45 日内红盘 ${it.redDays} 天（越长越强）` });
  const vr = p.vr || 0;
  const 量比分 = Math.round(Math.min(3, Math.max(0, (vr - 1) * 1.5)) * 10) / 10;
  项.push({ 名称: "量能比", 得分: 量比分, 满分: 3, 说明: `量比 ${Math.round(vr * 10) / 10}（1~3 倍为健康放量）` });
  if (it.涨停回调) 项.push({ 名称: "涨停回调形态", 得分: 0, 满分: 0, 加分: 0, 说明: `${it.涨停回调.回调天数} 日内涨停，缩量 ${it.涨停回调.缩量比}%（强势回踩，综合分额外 +3）` });
  /* 技术形态信号（2026-10-16 新增）：展示用，加分在 buildPicks 里计入综合分（100 分制） */
  if (it.底背离) 项.push({ 名称: "底背离", 得分: 0, 满分: 0, 加分: 0, 说明: `价创新低而 MACD 抬高（${it.背离 && it.背离.低差 != null ? "低点差 " + it.背离.低差 + "%" : "下跌动能衰竭"}，综合分额外 +${CFG.底背离加分}）` });
  if (it.金叉序 > 0) 项.push({ 名称: "MACD金叉启动", 得分: 0, 满分: 0, 加分: 0, 说明: `${it.金叉序} 日前 DIF 上穿 DEA（综合分额外 +${CFG.金叉加分}）` });
  if (it.均线金叉序 > 0) 项.push({ 名称: "均线金叉", 得分: 0, 满分: 0, 加分: 0, 说明: `${it.均线金叉序} 日前 MA5 上穿 MA10（综合分额外 +${CFG.均线金叉加分}）` });
  const 总 = 项.reduce((a, b) => a + (b.满分 ? b.得分 : 0), 0);
  return { 分: Math.min(10, Math.round(总 * 10) / 10), 项 };
}
function scoreMsgDetail(sn, flashN, flashOk) {
  const 项 = [];
  const 热度分 = Math.min(3, Math.round((sn.n || 0) * 0.6 * 10) / 10);
  项.push({ 名称: "新闻热度", 得分: 热度分, 满分: 3, 说明: `近 30 天相关新闻 ${sn.n || 0} 条${(sn.n || 0) === 0 ? "（无个股新闻）" : ""}` });
  const senti = sn.senti || 0;
  const 情感分 = Math.min(4, Math.max(0, Math.round((senti + 3) * 0.6667 * 10) / 10));
  项.push({ 名称: "情感倾向", 得分: 情感分, 满分: 4, 说明: `正向词 - 负向词 = ${senti > 0 ? "+" : ""}${senti}（利好词与利空词相抵后的净倾向）` });
  const 快讯分 = Math.min(3, Math.round((flashN || 0) * 0.6 * 10) / 10);
  项.push({ 名称: "快讯提及", 得分: 快讯分, 满分: 3, 说明: flashN > 0 ? `7×24 快讯提及 ${flashN} 次` : flashOk ? "快讯未提及" : "快讯数据缺失，按基准分" });
  const 总 = 项.reduce((a, b) => a + b.得分, 0);
  return { 分: Math.min(10, Math.round(总 * 10) / 10), 项 };
}
function scoreFundDetail(roe, yoy, gm, pe) {
  const 项 = [];
  const roe分 = Math.round(Math.min(4, Math.max(0, ((roe || 0) / 10) * 4)) * 10) / 10;
  项.push({ 名称: "ROE 净资产收益率", 得分: roe分, 满分: 4, 说明: `ROE ${roe == null ? "--" : Math.round(roe * 10) / 10 + "%"}（10% 以上为优）` });
  const 同比分 = Math.round(Math.min(3, Math.max(0, ((yoy == null ? 0 : yoy) / 150) * 3)) * 10) / 10;
  项.push({ 名称: "净利润同比", 得分: 同比分, 满分: 3, 说明: yoy == null ? "无同比数据" : `净利同比 ${Math.round(yoy * 10) / 10}%（增速越快越高）` });
  const 毛利分 = Math.round(Math.min(2, Math.max(0, ((gm || 0) / 50) * 2)) * 10) / 10;
  项.push({ 名称: "销售毛利率", 得分: 毛利分, 满分: 2, 说明: gm == null ? "无毛利率数据" : `毛利率 ${Math.round(gm * 10) / 10}%` });
  const 估值分 = pe != null && pe > 0 && pe < 100 ? 1 : 0;
  项.push({ 名称: "估值合理性", 得分: 估值分, 满分: 1, 说明: pe == null ? "市盈率数据缺失" : `PE ${Math.round(pe * 10) / 10}${估值分 ? "（<100，估值合理）" : "（偏高）"}` });
  const 总 = 项.reduce((a, b) => a + b.得分, 0);
  return { 分: Math.min(10, Math.round(总 * 10) / 10), 项 };
}
function buildPicks(hard, finMap, flashTitles, mainNames, flashOk, newsMap, 已推码集, 目标数) {
  const N = Math.max(1, 目标数 || 5);   // 推荐只数（温度分档决定，降频不空仓）
  const mainSet = {};
  for (const m of mainNames) mainSet[m] = 1;
  const news = {};
  for (const t of flashTitles || []) {
    for (const h of hard) {
      const nm = h.p.name;
      if (t.indexOf(nm) >= 0) news[nm] = (news[nm] || 0) + 1;
    }
  }
  let picks = [];
  for (const it of hard) {
    const p = it.p;
    const finRows = finMap[p.code] || [];
    if (!finRows.length) continue;
    finRows.sort((a, b) => (a.REPORT_DATE < b.REPORT_DATE ? 1 : -1));
    const cur = finRows[0];
    const roe = cur.ROEJQ,
      np = cur.PARENTNETPROFIT,
      gm = cur.XSMLL;
    if (roe == null || np == null) continue;
    if (roe < 0 || np < 0) continue; // 排除亏损
    let yoy = null;
    for (let m = 1; m < finRows.length; m++) {
      const pr = finRows[m];
      const yr = (cur.REPORT_DATE || "").slice(0, 4),
        mr = (cur.REPORT_DATE || "").slice(5, 7);
      const yr2 = (pr.REPORT_DATE || "").slice(0, 4),
        mr2 = (pr.REPORT_DATE || "").slice(5, 7);
      if (mr === mr2 && parseInt(yr, 10) - parseInt(yr2, 10) === 1) {
        const b = pr.PARENTNETPROFIT;
        yoy = b ? ((np - b) / Math.abs(b)) * 100 : null;
        break;
      }
    }
    if (yoy != null && yoy < 0) continue; // 基本面过滤：净利同比为负 一票否决（规避业绩下滑/雷股）
    /* ── 三维打分（各 10 分满分）· 细项可追溯 ──
       权重：技术面 40% + 消息面 40% + 基本面 20%，综合分 = 三者加权 × 10（满分 100） */
    const n = news[p.name] || 0;
    const sn = (newsMap && newsMap[p.code]) || { n: 0, senti: 0 };
    const 技术 = scoreTechDetail(it, p);
    const 消息 = scoreMsgDetail(sn, n, flashOk);
    const 基本面 = scoreFundDetail(roe, yoy, gm, null);
    const tech = 技术.分, msg = 消息.分, fund = 基本面.分;
    let score = Math.round((tech * 0.4 + msg * 0.4 + fund * 0.2) * 10 * 10) / 10;
    const isMain = !!mainSet[p.hybk];
    const 主线加分 = isMain ? 5 : 0;
    if (isMain) score += 5;
    const 回调加分 = it.涨停回调 ? 3 : 0;
    if (it.涨停回调) score += 3;
    /* 技术形态加分（2026-10-16 用户策略）：金叉启动 / 均线金叉 / 底背离 → 优选加分。
       金叉不设为必要条件——与「红柱加长」叠加会使候选池枯竭；死叉/顶背离已在 hardFilter 硬剔除 */
    const 技术形态加分 = (it.强势延续 ? 3 : 0)
      + (it.金叉序 > 0 ? CFG.金叉加分 : 0)
      + (it.均线金叉序 > 0 ? CFG.均线金叉加分 : 0)
      + (it.底背离 ? CFG.底背离加分 : 0);
    if (技术形态加分) score += 技术形态加分;
    score = Math.round(Math.min(100, score) * 10) / 10;
    let buyType;
    if (it.强势延续) buyType = "强势延续(B6)";
    else if (it.底背离) buyType = "底背离买(B5)";
    else if (it.金叉序 > 0 && it.金叉序 <= 3) buyType = "金叉买(B4)";
    else if (it.涨停回调) buyType = "涨停回调(B3)";
    else if (p.chg < 5 && p.vr > 1.5) buyType = "突破买(B1)";
    else buyType = "回踩买(B2)";
    const buyPrice = buyType === "突破买(B1)" ? Math.round(it.h20 * 1.005 * 100) / 100 : Math.round(it.ma10 * 1.005 * 100) / 100;
    let stop = Math.round(buyPrice * CFG.止损率 * 100) / 100; // 统一止损（止损率由复盘自适应，默认 -8%）
    const prob = Math.round(Math.min(92, Math.max(20, score + Math.min(8, (p.vr - 1) * 2) + Math.min(6, it.redDays * 0.8))) * 10) / 10;
    picks.push({
      code: p.code,
      name: p.name,
      price: p.price,
      pct: p.chg,
      chg: p.chg,
      industry: p.hybk || "",
      score,
      prob,
      概率: prob,
      scores: { msg, tech, fund },
      scores_detail: {
        tech: 技术.项, msg: 消息.项, fund: 基本面.项,
        权重: { tech: 40, msg: 40, fund: 20 },
        加分: [
          isMain ? { 名称: "主线行业", 得分: 主线加分, 说明: `命中当日主线板块：${p.hybk || ""}` } : null,
          回调加分 ? { 名称: "涨停回调形态", 得分: 回调加分, 说明: "B3 强势回踩，综合分额外加权" } : null,
        ].filter(Boolean),
      },
      buy_type: buyType,
      buy_price: buyPrice,
      买入价: buyPrice,
      stop_loss: stop,
      止损: stop,
      is_main: isMain,
      流通市值: p.fmv || 0,
      float_mv: (p.fmv || 0) * 1e8,
      buyable: true,
      buyable_note: "未封板，可买入",
      pct_chg: p.chg,
      pct_chg_5d: it.近5涨幅 != null ? Math.round(it.近5涨幅 * 100) / 100 : null,
      turnover: Math.round(p.turn * 100) / 100,
      vol_ratio: Math.round(p.vr * 100) / 100,
      reasons: {
        tech: "MA多头·MACD" + (it.红柱加长 ? "红柱加长" : (it.redDays > 0 ? "红柱缩短" : "无红柱")) + (it.redDays > 0 ? "·红" + it.redDays + "天" : "") + "·量比" + Math.min(99, Math.round(p.vr * 10) / 10) + "·换手" + Math.round(p.turn * 10) / 10 + "%" + (it.涨停回调 ? "·涨停回调(" + it.涨停回调.回调天数 + "日内涨停,缩量" + it.涨停回调.缩量比 + "%)" : ""),
        fund: "ROE " + Math.round(roe * 10) / 10 + "% · 净利同比 " + (yoy == null ? "-" : Math.round(yoy * 10) / 10 + "%"),
        msg: sn.n > 0 ? "近30天新闻 " + sn.n + " 条 · 情感净分 " + (sn.senti > 0 ? "+" : "") + sn.senti : flashOk ? "快讯提及 " + n + " 次 · 无个股新闻" : "无近期新闻，按基准分",
      },
    });
  }
  picks.sort((a, b) => b.score - a.score);
  /* ── 去重（稳健版）──
     ① 同日去重：同一只票只保留一次
     ② 跨期去重：排除「最近 3 期」已推荐过的票（由调用方经 已推码集 传入） */
  const 已见 = {};
  const 池1 = [];
  for (const p of picks) {
    if (已见[p.code]) continue;
    已见[p.code] = 1;
    池1.push(p);
  }
  const 池2 = 已推码集 && Object.keys(已推码集).length ? 池1.filter((p) => !已推码集[p.code]) : 池1;
  const 去重后 = 池2.length >= 3 ? 池2 : 池1; // 兜底：排除后不足 3 只则放开跨期限制
  picks = 去重后;

  const seen = {},
    top = [];
  /* 强势延续票限量（2026-10-16）：这类票（昨涨停+今续强、多数均线未走好）波动更大，
     单期最多纳入 CFG.强势延续只数（默认 1），避免风险敞口过度集中。 */
  let 强势延续已选 = 0;
  const 可加 = (it) => !(it.强势延续 && 强势延续已选 >= (CFG.强势延续只数 || 1));
  const 记入 = (it) => { if (it.强势延续) 强势延续已选++; };
  for (const it2 of picks) {
    if (top.length >= N) break;
    if (!可加(it2)) continue;
    const 键 = it2.industry || "其他";
    if (seen[键]) continue;
    seen[键] = 1;
    top.push(it2); 记入(it2);
  }
  if (top.length < N) {
    for (const p of picks) {
      if (top.length >= N) break;
      if (!可加(p)) continue;
      if (top.indexOf(p) < 0) { top.push(p); 记入(p); }
    }
  }
  return top.slice(0, N);
}

/* ── 主流程 runShort（对齐前端取短线后端契约）── */
const TL = {
  getIndex,
  getZTPool,
  getDTPool,
  temperature,
  mainLines,
  batchKlines,
  batchNews,
  批行业,
  workers,
};

/* ── 主流程 runStable（对齐前端 拉后端存档 / 合并十日荐股 契约）──
   稳健版：技术面40% + 消息面40% + 基本面20%；尾盘买入，持股 1–4 周。
   动态参数：硬门槛（追高上限/量比区间/换手区间/温度下限/连板阈值/急涨上限/止损率）由 review.js
   每日收盘复盘后写入 params.json 自适应调整，均带硬上下限钳制；params.json 缺失时用默认值。
   急涨上限：近5个交易日累计涨幅≥此值视为近似90度竖直拉升，剔除（默认30%，用户要求）。
   去重：同日去重 + 跨期去重（近 3 期已推票由调用方经 已推码集 传入）。
   输出：{ ok, empty, date, gen_time, temperature, main_lines, picks, mode, note, elapsed } */
async function runStable(prog, 已推码集) {
  const t0 = Date.now();
  function P(p, m) {
    if (prog) prog(p, m);
  }
  function 空仓(原因) {
    return {
      ok: true,
      empty: true,
      空仓原因: 原因,
      date: 今日键(),
      gen_time: new Date().toLocaleString("sv-SE").replace("T", " "),
      temperature: null,
      main_lines: [],
      picks: [],
      mode: "stable",
      note: "稳健版引擎",
    };
  }
  P(3, "抓取指数/涨跌停/跌停/炸板池…");
  const A = await Promise.all([getIndex(), getZTPool(), getDTPool(), getZBPool()]);
  const idxs = A[0],
    zt = A[1],
    dtN = A[2],
    zbMap = A[3];
  const zbN = Object.keys(zbMap).length;
  P(24, "扫描全市场（沪深主板）…");
  let all;
  try {
    all = await 拉全市场();
  } catch (e) {
    return 空仓("全市场行情拉取失败：" + (e && e.message));
  }
  /* 涨跌家数（2026-10-16 温度重构）：直接从全市场扫描结果统计，不额外拉一次行情 */
  let 广度 = null;
  if (Array.isArray(all) && all.length) {
    let up = 0, down = 0, flat = 0;
    for (const r of all) {
      const c = r.f3 == null ? null : (Math.abs(r.f3) > 20 ? r.f3 / 100 : r.f3);
      if (c == null) continue;
      if (c > 0) up++; else if (c < 0) down++; else flat++;
    }
    广度 = { up, down, flat, total: up + down + flat };
  }
  const temp = temperature(idxs, zt, dtN, zbN, 广度);
  /* 降频不空仓（2026-10-16 用户要求）：低于温度门槛不再空仓，改为压缩推荐只数 */
  const 目标数 = 温度目标只数(temp.temp);
  const 降频中 = temp.temp < CFG.温度下限;
  if (降频中) {
    P(18, "市场温度 " + temp.temp + " 分（" + temp.state + "，涨 " + (广度 ? 广度.up : "—") + "/跌 " + (广度 ? 广度.down : "—") + "）→ 降频 " + 目标数 + " 只（不空仓）");
  } else if (目标数 < CFG.常态只数) {
    P(18, "市场温度 " + temp.temp + " 分（" + temp.state + "）→ 降频 " + 目标数 + " 只");
  }
  const main = mainLines(zt);
  const mainNames = main.map((x) => x.name);
  P(18, "温度 " + temp.temp + " 分 · 涨停 " + temp.zt_count + " 家 · 涨 " + (广度 ? 广度.up : "—") + "/跌 " + (广度 ? 广度.down : "—") + " · 主线 " + mainNames.length + " 个");
  const ztCodes = zt.map((x) => String(x.c));
  const cands = scan(all, ztCodes);
  P(40, "初筛候选 " + cands.length + " 只（红盘/量比/换手/市值/可买）");
  if (!cands.length) return 空仓("无候选股票（红盘/量比/换手/市值均不符或全为涨停）");

  P(46, "拉取日线计算均线/MACD（" + cands.length + " 只）…");
  const kmap = await batchKlines(cands);
  let hard = hardFilter(cands, kmap);
  P(72, "硬条件通过 " + hard.length + " 只（均线多头/MACD红/量价健康）");
  /* ── 技术信号优选层（2026-10-16 用户策略：金叉选股）──
     信号定义 = MACD 金叉（近 CFG.金叉窗口 日 DIF 上穿 DEA）/ 均线金叉（MA5 上穿 MA10）/ 底背离。
     信号票 ≥5 只 → 收窄到信号票（金叉选股）；<5 只 → 全部候选参与（兜底，避免弱势市况空仓），
     此时金叉/底背离仍以加分形式影响排序（buildPicks 技术形态加分）。 */
  try {
    const 信号票 = hard.filter((it) => it.金叉序 > 0 || it.均线金叉序 > 0 || it.底背离);
    if (CFG.金叉必选 && 信号票.length >= 5 && 信号票.length < hard.length) {
      P(74, `技术信号优选：金叉/均线金叉/底背离 ${信号票.length} 只（原 ${hard.length} 只）→ 按金叉选股口径收窄`);
      hard = 信号票;
    } else if (CFG.金叉必选) {
      P(74, `技术信号票 ${信号票.length} 只，不足 5 只 → 放宽为全候选参与（加分仍生效）`);
    }
  } catch (e) {}
  if (!hard.length) return 空仓("硬条件无通过标的（市场环境弱）");

  P(78, "拉取财务与个股新闻（ROE/消息面）…");
  const B = await Promise.all([batchFin(hard), batchNews(hard), getFlash()]);
  const fmap = B[0],
    newsMap = B[1],
    flash = B[2];
  P(90, "三维打分中（消息面按个股新闻）…");
  const picks = buildPicks(hard, fmap, flash || [], mainNames, flash !== null, newsMap, 已推码集, 目标数);
  if (目标数 < CFG.常态只数) P(88, "降频模式：本期限推 " + 目标数 + " 只（温度 " + temp.temp + " 分）");
  P(96, "三维打分完成 · 综合排序");
  if (!picks.length) return 空仓("财务过滤后无推荐（亏损或数据缺失）");
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;
  P(100, "完成，共 " + picks.length + " 只");
  return {
    ok: true,
    empty: false,
    adapted_n: 5,
    gen_time: new Date().toLocaleString("sv-SE").replace("T", " "),
    elapsed,
    date: 今日键(),
    temperature: temp,
    main_lines: main,
    picks,
    mode: "stable",
    note: "稳健版引擎 · 技术40%+消息40%+基本面20% · 尾盘买入持股1-4周",
  };
}

export {
  runStable,
  选股日键,
  今日键,
  是周末,
  是休市日,
  拉全市场,
  scan,
  hardFilter,
  buildPicks,
  macdSeries,
  detect涨停回调,
  getFin,
  getFlash,
  mainLines,
  temperature,
  scoreTechDetail,
  scoreMsgDetail,
  scoreFundDetail,
  /* ── 供 today.js（全模块云端快照）复用 ── */
  getIndex,
  getZTPool,
  getDTPool,
  取日K,
  batchKlines,
  批行业,
  上一交易日,
  取行情文本,
  解行情,
};
