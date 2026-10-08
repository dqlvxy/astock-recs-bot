// engine.js —— 稳健版选股引擎（Node 移植版）
// 移植自 A股选股看板.html 的 FS.run（稳健版：消息30%+技术40%+基本面30%）+ 共享数据层 FS工具。
// 纯计算 + 公开行情接口；去除了所有 window/DOM 依赖；gbk 解码用 iconv-lite。
// 输出结构对齐前端「拉后端存档 / 合并十日荐股」契约：{ date, gen_time, picks, temperature, main_lines }
import iconv from "iconv-lite";

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
    const r = await fetch("https://qt.gtimg.cn/q=sh000001,sz399001,sz399006", {
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
function temperature(idxs, zt, dtN, zbN) {
  let sh = null;
  for (const x of idxs) if (x.f12 === "000001") sh = x;
  const raw = sh ? sh.f3 || 0 : 0;
  const shChg = Math.abs(raw) > 20 ? raw / 100 : raw;
  let maxLb = 0;
  for (const x of zt) if (x.lbc > maxLb) maxLb = x.lbc;
  const zbRate = zt.length + zbN > 0 ? (zbN / (zt.length + zbN)) * 100 : 0;
  let s = 0;
  s += Math.min(30, (zt.length / 45) * 30);
  s += Math.min(20, (maxLb / 5) * 20);
  s += Math.max(0, 15 - dtN * 3);
  s += Math.max(0, 20 - Math.max(0, zbRate - 15) * 0.9);
  s += Math.max(0, 15 - Math.max(0, -shChg) * 10);
  if (shChg < -1) s = Math.min(s, 55);
  if (shChg < -2) s = Math.min(s, 35);
  s = Math.max(0, Math.min(100, Math.round(s)));
  const state = s >= 70 ? "强势" : s >= 50 ? "中性偏强" : s >= 35 ? "中性偏弱" : "冰点/退潮";
  return { temp: s, zt_count: zt.length, state: state, shChg: shChg };
}

/* ── 全市场扫描（腾讯 qt.gtimg，gbk）── */
const 代码段 =
  "sh600000-600999|sh601000-601999|sh603000-603999|sh605000-605999|sh688000-688999" +
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
    if (vr == null || vr < 1) continue; // 量比 >= 1
    if (turn == null || turn < 2 || turn > 25) continue; // 换手 2-25
    if (fmv < 20 || fmv > 800) continue; // 流通市值 20-800亿
    if (price > 50) continue; // 股价 <= 50
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
  return { dif: difArr[n - 1], dea: deaArr[n - 1], hist: histArr[n - 1], histArr };
}
/* B3 涨停回调形态识别：近10日内曾涨停、其后缩量回调、且不破MA10 */
function detect涨停回调(rows, closes, ma10) {
  const n = closes.length;
  if (n < 12 || ma10 == null) return null;
  const last = closes[n - 1];
  if (last < ma10) return null;
  let 涨停序 = -1;
  for (let i = n - 2; i >= Math.max(1, n - 11); i--) {
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
function 昨收涨停防线(closes, 涨停序) {
  if (涨停序 < 1) return 0;
  const 前收 = closes[涨停序 - 1];
  return 前收 + (closes[涨停序] - 前收) * 0.5;
}
function hardFilter(pool, klineMap) {
  const out = [];
  for (const p of pool) {
    const rows = klineMap[p.code];
    if (!rows || rows.length < 35) continue;
    rows.sort((a, b) => (a.TRADE_DATE < b.TRADE_DATE ? -1 : 1));
    const closes = rows.map((r) => r.CLOSE_PRICE);
    const ma5 = calcMA(closes, 5),
      ma10 = calcMA(closes, 10),
      ma30 = calcMA(closes, 30);
    const ma5p = calcMA(closes.slice(0, -1), 5),
      ma10p = calcMA(closes.slice(0, -1), 10),
      ma30p = calcMA(closes.slice(0, -1), 30);
    if (ma5 == null || ma10 == null || ma30 == null || ma5p == null) continue;
    if (!(ma5 > ma10 && ma10 > ma30)) continue; // 均线多头
    if (!(ma5 > ma5p && ma10 > ma10p && ma30 > ma30p)) continue; // 同步上行
    const last = closes[closes.length - 1];
    const mc = macdSeries(closes);
    const 红柱 = !!(mc && mc.dif > mc.dea && mc.hist > 0);
    const 涨停回调 = detect涨停回调(rows, closes, ma10);
    if (!((last >= ma5 && 红柱) || 涨停回调)) continue;
    let redDays = 0;
    if (mc && mc.histArr)
      for (let d = mc.histArr.length - 1; d >= 0; d--) {
        if (mc.histArr[d] > 0) redDays++;
        else break;
      }
    let h20 = 0;
    for (let h = Math.max(0, closes.length - 20); h < closes.length; h++) if (closes[h] > h20) h20 = closes[h];
    out.push({ p, ma5, ma10, ma30, redDays, h20, 涨停回调 });
  }
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
function buildPicks(hard, finMap, flashTitles, mainNames, flashOk, newsMap, 已推码集) {
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
    score = Math.round(Math.min(100, score) * 10) / 10;
    let buyType;
    if (it.涨停回调) buyType = "涨停回调(B3)";
    else if (p.chg < 5 && p.vr > 1.5) buyType = "突破买(B1)";
    else buyType = "回踩买(B2)";
    const buyPrice = buyType === "突破买(B1)" ? Math.round(it.h20 * 1.005 * 100) / 100 : Math.round(it.ma10 * 1.005 * 100) / 100;
    let stop = Math.min(it.h20 * 0.93, it.ma30 * 0.99);
    stop = Math.round(stop * 100) / 100;
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
      turnover: Math.round(p.turn * 100) / 100,
      vol_ratio: Math.round(p.vr * 100) / 100,
      reasons: {
        tech: "MA多头·MACD红" + it.redDays + "天·量比" + Math.min(99, Math.round(p.vr * 10) / 10) + "·换手" + Math.round(p.turn * 10) / 10 + "%" + (it.涨停回调 ? "·涨停回调(" + it.涨停回调.回调天数 + "日内涨停,缩量" + it.涨停回调.缩量比 + "%)" : ""),
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
  for (const it2 of picks) {
    if (top.length >= 5) break;
    const 键 = it2.industry || "其他";
    if (seen[键]) continue;
    seen[键] = 1;
    top.push(it2);
  }
  if (top.length < 5) {
    for (const p of picks) {
      if (top.length >= 5) break;
      if (top.indexOf(p) < 0) top.push(p);
    }
  }
  return top.slice(0, 5);
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
   稳健版：消息面30% + 技术面40% + 基本面30%；尾盘买入，持股 1–4 周。
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
  const temp = temperature(idxs, zt, dtN, zbN);
  const main = mainLines(zt);
  const mainNames = main.map((x) => x.name);
  P(18, "温度 " + temp.temp + " 分 · 涨停 " + temp.zt_count + " 家 · 主线 " + mainNames.length + " 个");

  P(24, "扫描全市场（沪深主板）…");
  let all;
  try {
    all = await 拉全市场();
  } catch (e) {
    return 空仓("全市场行情拉取失败：" + (e && e.message));
  }
  const ztCodes = zt.map((x) => String(x.c));
  const cands = scan(all, ztCodes);
  P(40, "初筛候选 " + cands.length + " 只（红盘/量比/换手/市值/可买）");
  if (!cands.length) return 空仓("无候选股票（红盘/量比/换手/市值均不符或全为涨停）");

  P(46, "拉取日线计算均线/MACD（" + cands.length + " 只）…");
  const kmap = await batchKlines(cands);
  const hard = hardFilter(cands, kmap);
  P(72, "硬条件通过 " + hard.length + " 只（均线多头/MACD红/量价健康）");
  if (!hard.length) return 空仓("硬条件无通过标的（市场环境弱）");

  P(78, "拉取财务与个股新闻（ROE/消息面）…");
  const B = await Promise.all([batchFin(hard), batchNews(hard), getFlash()]);
  const fmap = B[0],
    newsMap = B[1],
    flash = B[2];
  P(90, "三维打分中（消息面按个股新闻）…");
  const picks = buildPicks(hard, fmap, flash || [], mainNames, flash !== null, newsMap, 已推码集);
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
    note: "稳健版引擎 · 消息30%+技术40%+基本面30% · 尾盘买入持股1-4周",
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
};
