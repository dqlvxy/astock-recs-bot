// Cloudflare Pages Functions —— 云端实时「市场温度」接口（2026-10-16 新增）
//
// 起因（用户实测 2026-10-16 11:48）：今日三大指数 +0.95%/+1.19%/+0.96%、涨停 77 家、
//   最高连板 11 板、跌停 0 家，看板温度卡却仍是 21 分「冰点/退潮」——那是 10-15 收盘的冻结值。
//   根因：today.json 由 daily.yml（cron "30 6 * * 1-5" = 北京 14:30）每日只生成一次，
//   盘前/盘中温度不会更新，与「3 秒刷新的实时看板」定位不符。
//
// 用户要求（架构原则）：温度必须在云端算，看板只负责实时拉取显示，刷新频率 3 秒。
//   → 本函数在 CF 边缘现场拉数据、按 engine.js temperature() 同算法算温度并返回 JSON；
//     看板每 3 秒拉一次 /api/temp，只做渲染（本地不重算、不编造）。
//
// 数据源与口径（与 engine.js / today.js 严格一致）：
//   ① 三大指数   东财 ulist.np（fltt=2 → f3 直接是百分比）；备源 腾讯日K（盘中最后一根即当日）
//   ② 涨停数/连板 东财 push2ex getTopicZTPool（pool.length 与 max(lbc)）
//   ③ 炸板数     涨停池中 zbc>0 的只数（today.js 同口径；勿用东财炸板池 tc，两者定义不同）
//   ④ 跌停数     全市场涨幅 ≤ -9.8% 的只数（engine.getDTPool 同口径，非东财跌停池）
//   ⑤ 涨跌家数   东财 clist 按涨幅降序二分定位分界（每页 100，约 6 次请求；45 秒缓存）
//
// 稳定性设计（2026-10-16 实测：并发请求会被东财限流，第 2 次调用即全部失败）：
//   · 取JSON 内置 3 次重试（递增退避）
//   · 三段数据串行拉取，避免瞬时并发触发限流
//   · 指数有腾讯备源；任一段失败则该项降级（广度缺失按引擎的中位 15 分口径）
//   · 成功结果另存 300 秒兜底缓存：上游全挂时回传上次结果（标 stale），看板不会闪回空值
//
// 铁律（同 data.js）：任何路径都返回 application/json，绝不抛错——抛错会被 Pages 回退成 HTML。

const 指数路径 = "api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006,1.000688&fields=f2,f3,f12,f14";
const 指数域名表 = ["push2", "1.push2", "82.push2", "push2his", "push2delay"]; /* 主域名偶发被限流，多镜像兜底 */
const 缓存前缀 = "https://astock-board-9t0.pages.dev/__temp#";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const 超时毫秒 = 6000;

const 东财头 = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  Referer: "https://quote.eastmoney.com/",
  Accept: "application/json, text/plain, */*",
};

/* 北京日期（YYYYMMDD）——池子接口按交易日取数；非交易日自动回退最近交易日 */
function 今日() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
function 北京时刻() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}
function 歇(毫秒) {
  return new Promise((r) => setTimeout(r, 毫秒));
}

/* 带重试的 JSON 取数（3 次，递增退避）——边缘到东财偶发限流，单发失败率明显 */
async function 取JSON(url, 次 = 3, 超时 = 超时毫秒) {
  for (let i = 0; i < 次; i++) {
    try {
      const r = await fetch(url, { headers: 东财头, signal: AbortSignal.timeout(超时) });
      if (r.ok) {
        const j = await r.json();
        if (j) return j;
      }
    } catch (e) {}
    if (i < 次 - 1) await 歇(300 + i * 300);
  }
  return null;
}

/* 多域名兜底取数：同一 path 在不同 push2 镜像可达性不同（实测主域名 push2 偶发被限流，
   镜像 1.push2 / push2his 通常可用）。逐域名各试 1 次（域名轮换即冗余，避免单域名 2~3 次重试
   叠加多域名把耗时拖到 20s+ 被 Promise.race 截断），命中即返回。 */
async function 取JSON域名(路径, 域名表, 超时 = 超时毫秒, 次 = 1) {
  for (const h of 域名表) {
    const d = await 取JSON(`https://${h}.eastmoney.com/${路径}`, 次, 超时);
    if (d) return d;
  }
  return null;
}

async function 带缓存(键, 秒, 工厂) {
  const url = 缓存前缀 + 键;
  let 旧 = null;
  try {
    const c = await caches.default.match(url);
    if (c) {
      const j = await c.json();
      旧 = j;
      if (j && j.缓存于 && Date.now() - Date.parse(j.缓存于) < 秒 * 1000) return j.值;
    }
  } catch (e) {}
  let v = null;
  try {
    v = await 工厂();
  } catch (e) {}
  if (v != null) {
    try {
      await caches.default.put(
        url,
        new Response(JSON.stringify({ 缓存于: new Date().toISOString(), 值: v }), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=" + 秒 },
        })
      );
    } catch (e) {}
    return v;
  }
  return 旧 ? 旧.值 : null;
}

/* ── ① 三大指数：东财主源 → 腾讯日K备源 ── */
function 拉指数() {
  return 带缓存("idx", 5, async () => {
    const d = await 取JSON域名(指数路径, 指数域名表, 3500);
    const rows = (d && d.data && d.data.diff) || null;
    if (rows && rows.length) {
      return rows.map((x) => ({ f12: String(x.f12 || ""), f2: x.f2, f3: typeof x.f3 === "number" ? x.f3 : null }));
    }
    /* 备源：腾讯日K（盘中最后一根为当日实时），无需 GBK 解码 */
    const 码表 = [["sh000001", "000001"], ["sz399001", "399001"], ["sz399006", "399006"], ["sh000688", "000688"]];
    const out = [];
    for (const [全码, 码] of 码表) {
      const q = await 取JSON(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${全码},day,,,3,qfq`, 2);
      const 节点 = q && q.data && q.data[全码];
      const 行 = 节点 && (节点.qfqday || 节点.day);
      if (!行 || 行.length < 2) continue;
      const 今 = parseFloat(行[行.length - 1][2]);
      const 昨 = parseFloat(行[行.length - 2][2]);
      if (今 > 0 && 昨 > 0) out.push({ f12: 码, f2: 今, f3: ((今 - 昨) / 昨) * 100 });
    }
    return out.length >= 3 ? out : null;
  });
}

/* ── ② 涨停池（含 lbc 连板数 / zbc 炸板次数）──
   回退保护（2026-10-16）：边缘偶发拉到空池/失败，若直接采信会让温度瞬间从 90 掉到 74
   （涨停 0 / 连板 0 / 炸板 0）。故空池或失败时回退「上次成功的池子」（长 TTL 2 小时），
   A 股极少出现全天零涨停，用最近一次真实池子远好于采信异常空值。 */
function 拉涨停池() {
  return 带缓存("zt", 15, async () => {
    const d = await 取JSON(
      `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fbt%3Aasc&date=${今日()}`
    );
    const pool = d && d.data && d.data.pool;
    if (!pool) return null;
    return pool;
  });
}
async function 拉涨停池稳() {
  const 上次键 = 缓存前缀 + "zt_last";
  const r = await 拉涨停池();
  if (Array.isArray(r) && r.length) {
    await 写缓存JSON(上次键, r, 7200);
    return r;
  }
  const 上次 = await 读缓存JSON(上次键);
  return Array.isArray(上次) && 上次.length ? 上次 : r || null;
}

/* ── ⑤ 涨跌家数 + 跌停数（东财 clist 按涨幅降序二分）──
   降序序列 f3 单调不增 → 二分定位：
     · 第一个末条 f3 <= 0 的页 → 涨家数 = 前面整页 + 该页内 f3>0 的只数
     · 第一个末条 f3 <= -9.8 的页 → 跌停数 = 总只数 - 该页之前 - 该页内 f3>-9.8 的只数 */
/* clist 在边缘偶发不可达（实测同一 URL 时通时不通、三个镜像域名可达性还不同）→
   三域名轮换 + 多轮尝试；成功时记住可用域名，后续优先走它。 */
const CLIST域名 = ["push2", "1.push2", "push2his"];
let 域名游标 = 0;

async function 取页(pn) {
  const 查询 =
    `api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3` +
    `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3`;
  for (let i = 0; i < CLIST域名.length; i++) {
    const h = CLIST域名[(域名游标 + i) % CLIST域名.length];
    const d = await 取JSON(`https://${h}.eastmoney.com/${查询}`, 2, 3500);
    const diff = d && d.data && d.data.diff;
    if (diff) {
      域名游标 = (域名游标 + i) % CLIST域名.length; /* 记住可用域名 */
      const rows = Array.isArray(diff) ? diff : Object.values(diff);
      const 值 = rows.map((x) => (typeof x.f3 === "number" ? x.f3 : null)).filter((v) => v !== null);
      return { total: (d.data && d.data.total) || 0, 值 };
    }
  }
  return null;
}

async function 找界页(阈, 页数) {
  let lo = 1,
    hi = 页数,
    界 = 页数 + 1,
    界页数据 = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = await 取页(mid);
    if (!p || !p.值.length) {
      lo = mid + 1;
      continue;
    }
    if (p.值[p.值.length - 1] > 阈) lo = mid + 1;
    else {
      界 = mid;
      界页数据 = p;
      hi = mid - 1;
    }
  }
  return { 界, 界页数据 };
}

function 真正拉家数() {
  return 带缓存("breadth", 600, async () => {
    const 首 = await 取页(1);
    if (!首 || !首.total) return null;
    const total = 首.total;
    const 页数 = Math.ceil(total / 100);
    /* 二分定位涨跌分界（2026-10-16 第三次重构）：
       前一版「46 页并发分页」实测被东财限流 — 单页串行请求全通（0.2~6.7 秒），
       但 16 并发时大量页失败 → 家数恒 null（广度退化成中位 15 分，温度偏低 15 分）。
       改回二分：仅 ~6 次串行请求，不触发限流；单页超时 3 秒 + 三域名轮换兜底。 */
    let lo = 1, hi = 页数, 界 = 页数 + 1, 界页数据 = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = await 取页(mid);
      if (!p || !p.值.length) {
        lo = mid + 1; /* 该页取不到 → 保守右移（涨家数宁多不少，避免低估人气） */
        continue;
      }
      if (p.值[p.值.length - 1] > 0) lo = mid + 1;
      else {
        界 = mid;
        界页数据 = p;
        hi = mid - 1;
      }
    }
    let up;
    if (界 > 页数) up = total;
    else {
      const 页内涨 = 界页数据 ? 界页数据.值.filter((v) => v > 0).length : 0;
      up = (界 - 1) * 100 + 页内涨;
    }
    if (up > total) up = total;
    if (up <= 0 && !界页数据) return null;
    return { up, total };
  });
}

/* 跌停数（2026-10-16）：东财跌停池 tc。
   注：engine.getDTPool 口径为「全市场涨幅 ≤ -9.8%」，此处用东财跌停池（封死跌停），
   普涨日两者可能差 0~5 家（影响温度 ≤6 分），暴跌日基本一致；
   换取的是不在边缘跑 12 次 tail 分页（配额更省、更稳）。 */
function 拉跌停数() {
  return 带缓存("dt", 15, async () => {
    const d = await 取JSON(
      `https://push2ex.eastmoney.com/getTopicDTPool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=${今日()}`
    );
    const tc = d && d.data && d.data.tc;
    return typeof tc === "number" ? tc : null;
  });
}

/* 家数获取包装（2026-10-16）：
   ① 失败后 30 秒内不重试（二分 12 次请求，连续重试会拖垮后台刷新）
   ② 失败时回退「上次成功的家数」（长 TTL 2 小时）——实测不这样做会导致温度在
      有广度/无广度之间跳变（84 ↔ 75，因不同边缘节点家数缓存状态不同），
      广度是慢变量，用 20 分钟前的值远好于退化成引擎中位口径。 */
async function 拉家数() {
  const 失败键 = 缓存前缀 + "breadth_fail";
  const 上次键 = 缓存前缀 + "breadth_last";
  const 失败 = await 读缓存JSON(失败键);
  if (失败 && 失败.于 && Date.now() - Date.parse(失败.于) < 30000) {
    return (await 读缓存JSON(上次键)) || null;
  }
  const r = await 真正拉家数();
  if (r) {
    await 写缓存JSON(上次键, r, 7200);
    return r;
  }
  await 写缓存JSON(失败键, { 于: new Date().toISOString() }, 30);
  return (await 读缓存JSON(上次键)) || null;
}

/* 沪深两市总成交额（2026-10-22 切换数据源）：纳入市场稳定评分「量能」维度。
   数据源与看板「涨跌分布」模块完全一致——腾讯 qt.gtimg.cn/q=sh000001,sz399001，
   GBK 解码，split("~") 后 f[37] 为成交额（单位万元），两市求和 ÷1e4 = 亿元。
   该源稳定（CF 边缘可直连，不像东财 ulist.np 在 CF 常被限流），且与前端展示同源同值。
   低频缓存 10 分钟（量能为慢变量）。取数失败则额亿=null → 量能按中位 5 分。 */
async function 拉三市成交额() {
  return 带缓存("amount", 600, async () => {
    try {
      const r = await fetch("https://qt.gtimg.cn/q=sh000001,sz399001", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const txt = new TextDecoder("gbk").decode(await r.arrayBuffer());
      const 正则 = /v_[a-z]{2}\d{6}="([^"]*)"/g;
      let m, amt = 0;
      while ((m = 正则.exec(txt)) !== null) {
        const f = m[1].split("~");
        if (f.length > 40) amt += (parseFloat(f[37]) || 0);
      }
      if (amt <= 0) return null; /* 全都没取到 → 视为失败，下一轮重试 */
      return Math.round(amt / 10000); /* 万元→亿元，例：14293亿，与看板涨跌分布同值 */
    } catch (e) {
      return null;
    }
  });
}

/* ── 温度算法：与 engine.js temperature() 逐项一致（含权重与硬顶）──
   权重定版（2026-10-16 用户要求指数最高；2026-10-21 新增量能 10 分，总权重重配为 100）：
     指数 35（上证+深证+创业板+科创50 四指数均值）> 广度 15 > 涨停 12 + 跌停 12 > 量能 10 > 炸板 13 > 连板 3。
   并输出分项明细供看板展示计算逻辑。 */
function 算温度(idxs, zt, dtN, zbN, breadth, 额亿) {
  const r1 = (v) => Math.round(v * 10) / 10;
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
  const 涨比 = breadth && breadth.total > 0 && breadth.up != null ? breadth.up / breadth.total : null;

  /* 指数项线性双向（2026-10-16 用户要求，2026-10-21 权重 40→35）：
     +3% 满分 35、0% 得 17.5、−3% 清零，斜率 17.5/3 ≈ 5.83 分每 1%。 */
  const 指数分 = Math.max(0, Math.min(35, 17.5 + 指均 * (17.5 / 3)));
  const 涨停分 = Math.min(12, (zt.length / 45) * 12);
  /* 跌停项（2026-10-21 加严）：每家 −1.0 → −1.5 分，10 家清零。
     原口径 5 家跌停只扣 5 分、仍白拿 10/15，弱市里偏松。权重 15→12。 */
  const 跌停分 = Math.max(0, 12 - dtN * 1.5);
  /* 广度项（2026-10-21 重构）：改为以 50% 涨比为中位的对称线性 ——
     50% 得中位 7.5，65% 满分 15，35% 清零。
     原口径「0%~60% 线性满分」过宽：涨比 35%（近 2/3 个股下跌）仍能拿 8.7/15，
     叠加涨停满分 15 + 跌停 10 + 连板 4，导致「指数小跌 + 个股普跌」也能给到 52 分「中性偏强」。 */
  const 广度分 = 涨比 != null ? Math.max(0, Math.min(15, 7.5 + ((涨比 - 0.5) / 0.15) * 7.5)) : 7.5;
  const 炸板分 = Math.max(0, 13 - Math.max(0, zbRate - 15) * 1.3);
  const 连板分 = Math.min(3, (maxLb / 5) * 3);
  /* 量能项（2026-10-21 新增，2026-10-22 口径改为沪深两市总成交；数据源与看板「涨跌分布」同源：
     腾讯 qt.gtimg 上证 000001 + 深证 399001 成交额求和。
     2026-10-22 用户重定评分规则：1 万亿以下 0 分、4 万亿满分 10，中间线性
     （中位 2.5 万亿得 5 分）；额亿缺失（首次/取数失败）给中位 5 分不偏袒。 */
  const 量能分 = 额亿 != null ? Math.max(0, Math.min(10, (额亿 - 10000) / 30000 * 10)) : 5;

  let s = 指数分 + 涨停分 + 跌停分 + 广度分 + 炸板分 + 连板分 + 量能分;
  let 硬顶 = "未触发";
  if (指均 < -1) { s = Math.min(s, 55); 硬顶 = "已触发：四指数均跌≥1% → 总分封顶 55"; }
  if (指均 < -2) { s = Math.min(s, 28); 硬顶 = "已触发：四指数均跌≥2% → 总分封顶 28"; }
  if (指均 < -3) { s = Math.min(s, 12); 硬顶 = "已触发：四指数均跌≥3% → 总分封顶 12"; }
  /* 指数-广度背离硬顶（2026-10-21 新增）：
     指数跌幅不大但个股普跌时，涨停/连板等结构性指标会虚抬温度（如 10-21：指均 −0.74%、
     涨比 34.9%、跌停 5 家，原算法仍给 52 分「中性偏强 · 仓位 40-60%」，与实际赚钱效应背离）。
     故按涨比分两档封顶，把「指数小跌 + 个股杀跌」压回「中性偏弱」。 */
  if (涨比 != null && 指均 < 0) {
    if (涨比 < 0.40) { s = Math.min(s, 45); 硬顶 = "已触发：指数下跌且涨比<40%（个股普跌）→ 总分封顶 45"; }
    else if (涨比 < 0.50) { s = Math.min(s, 58); 硬顶 = "已触发：指数下跌且涨比<50% → 总分封顶 58"; }
  }
  s = Math.max(0, Math.min(100, Math.round(s)));

  const state = s >= 70 ? "强势" : s >= 50 ? "中性偏强" : s >= 35 ? "中性偏弱" : "冰点/退潮";
  const pos_advice =
    s >= 70 ? "总仓位 60-80%，可适度追强"
      : s >= 50 ? "总仓位 40-60%，低吸为主不追高"
      : s >= 35 ? "总仓位 20-40%，只做确定性最高 1-2 只"
      : "总仓位 ≤10%，降频 1-2 只试探（不空仓），等主线明确再加仓";

  const 分项 = [
    { 名: "指数涨跌", 权重: 35, 得分: r1(指数分), 判据: `沪深创科四指数均值 ${指均 >= 0 ? "+" : ""}${r1(指均)}%（+3% 满分、0% 得 17.5 分、−3% 清零）` },
    { 名: "涨停数", 权重: 12, 得分: r1(涨停分), 判据: `${zt.length} 家（45 家即满分）` },
    { 名: "跌停数", 权重: 12, 得分: r1(跌停分), 判据: `${dtN} 家（每家 −1.5 分，10 家清零）` },
    { 名: "涨跌家数", 权重: 15, 得分: r1(广度分), 判据: 涨比 != null ? `涨 ${breadth.up}/${breadth.total} 只（涨比 ${r1(涨比 * 100)}%，50% 得中位、35% 清零）` : "数据未取到 → 按中位 7.5 分（不偏袒）" },
    { 名: "炸板率", 权重: 13, 得分: r1(炸板分), 判据: `${r1(zbRate)}%（>15% 后每 1% 扣 1.3 分）` },
    { 名: "最高连板", 权重: 3, 得分: r1(连板分), 判据: `${maxLb} 板（5 板即满分）` },
    { 名: "量能(沪深成交)", 权重: 10, 得分: r1(量能分), 判据: 额亿 != null ? `沪深成交 ${r1(额亿)} 亿（与看板「涨跌分布」同源；1 万亿以下 0 分、4 万亿满分 10）` : "数据未取到 → 按中位 5 分（不偏袒）" },
  ];

  return {
    temp: s, zt_count: zt.length, dt_count: dtN, zb_count: zbN, max_lb: maxLb, state, pos_advice,
    shChg: Math.round(shChg * 100) / 100, 指均: Math.round(指均 * 100) / 100,
    广度: 涨比 != null ? r1(涨比 * 100) : null,
    分项, 硬顶,
    分档: [
      { 区间: "≥70", 状态: "强势", 建议: "总仓位 60-80%，可适度追强" },
      { 区间: "50~70", 状态: "中性偏强", 建议: "总仓位 40-60%，低吸为主不追高" },
      { 区间: "35~50", 状态: "中性偏弱", 建议: "总仓位 20-40%，只做确定性最高 1-2 只" },
      { 区间: "<35", 状态: "冰点/退潮", 建议: "总仓位 ≤10%，降频 1-2 只试探（不空仓）" },
    ],
    联动: "温度低于门槛（默认 35）→ 引擎降频不空仓：常态 5 只 → 弱市 3 只 → 冰点 2 只 → 极弱 1 只",
    数据源: "CF 边缘实时计算 · 指数 5 秒 / 涨停池 15 秒 / 涨跌家数 10 分钟刷新 · 指数含科创50",
  };
}

function 出响应(出) {
  return new Response(JSON.stringify(出), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", /* 内部各数据源已分别缓存，本响应不缓存 */
      "access-control-allow-origin": "*",
    },
  });
}

/* ── 结果缓存 + 后台刷新（stale-while-revalidate，2026-10-16 压测后引入）──
   压测实测：边缘到东财单次约 1 秒，家数二分需 12 次串行 → 一次完整重算 12~33 秒，
   3 秒刷新的看板等不起（连续请求大面积超时）。故三层提速：
     ① SWR：有缓存立即返回（毫秒级），重算丢 waitUntil 后台；距上次计算 >5 秒才触发（节流）
     ② 快慢分离：温度 = 指数 + 涨停池 + 广度，其中前两项 2 次请求约 2 秒即为"当前值"，
        广度（涨跌家数，clist 二分）最慢、且 90~180 秒才需更新一次 → 冷启动不阻塞它
     ③ 冷启动：有兜底缓存直接秒回；无兜底则先跑"快算"（指数+涨停池）出值，
        广度由 waitUntil 后台补齐并刷新缓存
   ⇒ 看板侧响应恒为毫秒级；温度随指数/涨停池 3~8 秒级更新，广度分钟级更新。 */
const 结果键 = 缓存前缀 + "result";
const 兜底键 = 缓存前缀 + "last";
let 刷新锁时间戳 = 0; /* 时间戳锁：防并发重算；waitUntil 截断导致 finally 不执行时 30s 自动失效，避免永久卡死 */
const 刷新锁时效 = 30000;
async function 取刷新锁() {
  const n = Date.now();
  if (n - 刷新锁时间戳 > 刷新锁时效) { 刷新锁时间戳 = n; return true; }
  return false;
}
function 释放刷新锁() { 刷新锁时间戳 = 0; }
function 刷新进行中() { return Date.now() - 刷新锁时间戳 <= 刷新锁时效; }

async function 读缓存JSON(键) {
  try {
    const c = await caches.default.match(键);
    if (!c) return null;
    const j = await c.json();
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    return null;
  }
}
async function 写缓存JSON(键, 值, 秒) {
  try {
    await caches.default.put(
      键,
      new Response(JSON.stringify(值), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=" + 秒 },
      })
    );
  } catch (e) {}
}

function 组装(idxs, ztPool, 家数, 跌停数, 额亿) {
  const zt = Array.isArray(ztPool) ? ztPool : [];
  let zbN = 0;
  for (const x of zt) if (Number(x.zbc || 0) > 0) zbN++; /* 炸板数 = 涨停池中炸过板的只数（today.js 同口径） */
  const dtN = 跌停数 != null ? 跌停数 : (家数 && 家数.跌停 != null ? 家数.跌停 : 0);
  const 数据 = 算温度(idxs, zt, dtN, zbN, 家数 || null, 额亿);
  return {
    ok: true,
    源: "CF 边缘实时计算（与 engine.js 同算法）",
    算于: 北京时刻(),
    算于ISO: new Date().toISOString(),
    数据,
    明细: {
      指数: idxs.map((x) => ({ 码: x.f12, 涨跌: x.f3 })),
      涨: 家数 ? 家数.up : null,
      总: 家数 ? 家数.total : null,
      家数状态: 家数 ? "已取到" : "未取到（广度按引擎中位 15 分口径，后台补齐中）",
      额亿: 额亿 != null ? 额亿 : null,
      跌停源: "东财跌停池",
    },
    原料: { idxs, zt, dtN, zbN }, /* 原始输入，供前台按最新子缓存(额亿/家数)合并重算 */
  };
}

/* 快算：指数 + 涨停池（约 2 秒）——冷启动首屏用 */
async function 快算并写() {
  const [idxs, ztPool, 跌停数] = await Promise.all([拉指数(), 拉涨停池稳(), 拉跌停数()]);
  if (!idxs || !idxs.length) return null;
  const 出 = 组装(idxs, ztPool, null, 跌停数);
  await 写缓存JSON(结果键, 出, 300);
  await 写缓存JSON(兜底键, 出, 300);
  return 出;
}

/* 完整重算（两阶段增量写，2026-10-21 重构以修复后台写库失败 / 额亿不上屏）：
   ① 原布尔锁 刷新中 在 waitUntil 被截断时 finally 不执行 → 锁永久卡死、永不写 结果键；改时间戳锁（30s 自愈）。
   ② 额亿(三市成交) 「最先单独取」——它与拉指数同为 ulist.np，若在 Promise.all 里并发打东财，
      会互相争抢限流配额双双被限流返回 null（实测：debug 单独调=13995 正常、后台并发调=null）。
   ③ 家数(clist 二分) 冷取在限流下可能 >15s，由取或空() 限时降级并「先写一版」（缺则 null，保证必有写），
      再 best-effort 补全暖缓存，被截断则下一轮刷新自愈。 */
async function 完整重算() {
  if (!(await 取刷新锁())) return null;
  try {
    const 取或空 = (p, ms) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);
    /* 额亿先单独取（趁东财配额未被其他 ulist.np 请求占用）；竞速 15s 尽力暖 amount 缓存，
       超时即降级 null（量能按中位 5）——额亿上屏改由前台 合并最新 按 amount 子缓存负责，不阻塞重算。 */
    const 额亿1 = await 取或空(拉三市成交额(), 15000);
    const [idxs, ztPool, 跌停数] = await Promise.all([拉指数(), 拉涨停池稳(), 拉跌停数()]);
    if (!idxs || !idxs.length) return null;
    /* 阶段1：用已取额亿 + 缓存家数先写一版（家数缺则 null，保证 结果键 必有写） */
    const 家数1 = await 取或空(拉家数(), 15000);
    const 出1 = 组装(idxs, ztPool, 家数1, 跌停数, 额亿1);
    await 写缓存JSON(结果键, 出1, 300);
    await 写缓存JSON(兜底键, 出1, 300);
    /* 阶段2：缺失项补全（best-effort） */
    if (家数1 == null || 额亿1 == null) {
      const 家数2 = 家数1 != null ? 家数1 : await 拉家数().catch(() => null);
      const 额亿2 = 额亿1 != null ? 额亿1 : await 拉三市成交额().catch(() => null);
      const 出2 = 组装(idxs, ztPool, 家数2, 跌停数, 额亿2);
      await 写缓存JSON(结果键, 出2, 300);
      await 写缓存JSON(兜底键, 出2, 300);
    }
    return true;
  } finally {
    释放刷新锁();
  }
}

async function 取兜底() {
  const j = await 读缓存JSON(兜底键);
  return j && j.data ? j : null;
}

/* ── 2026-10-23 广度改用看板「涨跌分布」的现成数字（老板要求：别再重复取数）──
   看板 拉全市场→涨跌分档 已算出涨/平/跌家数，随请求以 up/flat/down/total 带来；
   这里只校验合法性，随后用缓存的原料（指数/涨停池/跌停数/额亿）按同款算法重算。
   东财 clist 在 CF 边缘常被限流（广度长期 null、按中位 7.5 分），改为直接吃这份数据。 */
function 取请求家数(req) {
  try {
    const u = new URL(req.url);
    const up = parseInt(u.searchParams.get("up"), 10);
    const total = parseInt(u.searchParams.get("total"), 10);
    if (!isFinite(up) || !isFinite(total) || up < 0 || total <= 0) return null;
    const flat = parseInt(u.searchParams.get("flat"), 10);
    const down = parseInt(u.searchParams.get("down"), 10);
    return { up, total, flat: isFinite(flat) ? flat : null, down: isFinite(down) ? down : null };
  } catch (e) { return null; }
}

/* 用请求带来的家数按原料重算；不写共享缓存（不同请求的家数不该互相覆盖） */
function 按请求家数重算(基线, 家数) {
  try {
    if (!基线 || !基线.原料 || !基线.原料.idxs) return 基线;
    const 额亿 = 基线.明细 && 基线.明细.额亿 != null ? 基线.明细.额亿 : null;
    return 组装(基线.原料.idxs, 基线.原料.zt, 家数, 基线.原料.dtN, 额亿);
  } catch (e) { return 基线; }
}

/* 前台合并（2026-10-21）：读 amount/breadth 子缓存，若有别于当前结果则按 原料 重算温度并回写。
   量能(额亿)/广度(家数) 冷取慢、后台单点写库在 CF 限流下不可靠；改为前台按子缓存合并——
   一旦子缓存暖热，即随「下一次请求」上屏，不再依赖后台完整重算是否成功写库。 */
async function 合并最新(旧) {
  if (!旧 || !旧.原料 || !旧.原料.idxs) return 旧;
  try {
    const [额缓存, 家缓存] = await Promise.all([读缓存JSON(缓存前缀 + "amount"), 读缓存JSON(缓存前缀 + "breadth")]);
    const 额亿 = 额缓存 && 额缓存.值 != null ? 额缓存.值 : (旧.数据 ? 旧.数据.额亿 : null);
    const 家数 = 家缓存 && 家缓存.值 != null ? 家缓存.值 : null;
    const 额变 = (旧.数据.额亿 == null) !== (额亿 == null) || 旧.数据.额亿 !== 额亿;
    const 家变 = (旧.明细.总 == null) !== (家数 != null);
    if (!额变 && !家变) return 旧; /* 无变化不重算，避免每请求都回写 */
    const 出 = 组装(旧.原料.idxs, 旧.原料.zt, 家数, 旧.原料.dtN, 额亿);
    await 写缓存JSON(结果键, 出, 300);
    await 写缓存JSON(兜底键, 出, 300);
    return 出;
  } catch (e) {
    return 旧;
  }
}

/* 后台刷新统一入口（2026-10-16 修正）：恒走「完整重算」——
   原按「家数是否已取到」二选一，导致家数未取到时只跑快算、广度永远补不上（实测广度恒 null）。
   现在统一走完整重算：指数(5s)/涨停池(15s)/家数(180s) 各有缓存，缓存热时同样毫秒级；
   家数未命中时才跑二分，且失败有 30 秒节流，不会拖垮后台。 */
function 后台刷新(context) {
  const 跑 = 完整重算().catch(function () {});
  try {
    context.waitUntil(跑);
  } catch (e) {}
  return 跑;
}

/* 逐页诊断：依次取第 1/28/56 页，暴露每页结果（定位二分链路断点） */
async function 逐页诊断() {
  const out = [];
  for (const pn of [1, 28, 56]) {
    const t = Date.now();
    const p = await 取页(pn);
    out.push({ 页: pn, 通: !!p, total: p ? p.total : null, 条数: p ? p.值.length : 0,
      首值: p && p.值.length ? p.值[0] : null, 末值: p && p.值.length ? p.值[p.值.length - 1] : null,
      毫秒: Date.now() - t });
  }
  const 家 = await 真正拉家数();
  return { 页结果: out, 家数: 家 };
}

export async function onRequest(context) {
  try {
    /* 诊断开关（2026-10-16）：?debug=1 同步跑一次家数拉取，暴露每步结果 */
    if (new URL(context.request.url).searchParams.get("debug") === "1") {
      const t0 = Date.now();
      /* 多域名可达性探测：clist 在主域名边缘不可达（实测首页 null），找可用镜像 */
      const 域名表 = ["push2", "1.push2", "82.push2", "push2delay", "push2his"];
      const 探测 = await Promise.all(
        域名表.map(async (h) => {
          const u = `https://${h}.eastmoney.com/api/qt/clist/get?pn=1&pz=3&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3,f12`;
          const d = await 取JSON(u, 1);
          const rows = d && d.data && d.data.diff;
          return { 域名: h, 通: !!(rows && rows.length), total: (d && d.data && d.data.total) || null };
        })
      );
      /* 腾讯行情/列表接口可达性 */
      const 腾 = await Promise.all([
        (async () => {
          const d = await 取JSON("https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=sh000001,day,,,2,qfq", 1);
          return !!(d && d.data);
        })(),
        (async () => {
          const r = await fetch("https://qt.gtimg.cn/q=sh600000", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
          if (!r || !r.ok) return false;
          const t = await r.text().catch(() => "");
          return t.indexOf("v_sh600000") >= 0;
        })(),
      ]);
      const 额t0 = Date.now();
      const 额亿探测 = await 拉三市成交额().catch((e) => "ERR:" + String(e).slice(0, 40));
      const 额耗时 = Date.now() - 额t0;
      const 家t0 = Date.now();
      const 家数探测 = await 拉家数().catch((e) => "ERR:" + String(e).slice(0, 40));
      const 家耗时 = Date.now() - 家t0;
      return 出响应({
        调试: true,
        耗时毫秒: Date.now() - t0,
        clist域名探测: 探测,
        腾讯日K: 腾[0],
        腾讯行情: 腾[1],
        指数: (await 拉指数() || []).map((x) => x.f3),
        涨停池条数: ((await 拉涨停池()) || []).length,
        额亿探测, 额耗时毫秒: 额耗时,
        家数探测, 家耗时毫秒: 家耗时,
        逐页尝试: await 逐页诊断(),
      });
    }
    /* 2026-10-23：看板「涨跌分布」已算好的家数随请求带来，优先于边缘自取（边缘取不到） */
    const 请求家数 = 取请求家数(context.request);
    const 旧 = await 读缓存JSON(结果键);
    if (旧 && 旧.数据) {
      /* 超过 5 秒才触发后台刷新：看板 3 秒一次请求不会引发重算风暴 */
      const 距今 = 旧.算于ISO ? Date.now() - Date.parse(旧.算于ISO) : 99999;
      if (距今 > 5000 && !刷新进行中()) 后台刷新(context);
      const 基线 = await 合并最新(旧);
      return 出响应(请求家数 ? 按请求家数重算(基线, 请求家数) : 基线);
    }
    /* 冷启动：有兜底 → 秒回 + 后台完整重算 */
    const 兜 = await 取兜底();
    if (兜) {
      if (!刷新进行中()) 后台刷新(context);
      return 出响应({ ...兜, stale: true, 源: "启动中：回传上次结果，正在后台刷新" });
    }
    /* 首次无任何缓存：快算出值（约 2 秒），广度后台补 */
    const 快 = await 快算并写();
    if (快) {
      后台刷新(context); /* 后台补齐广度 */
      const 基线 = await 合并最新(快);
      return 出响应(请求家数 ? 按请求家数重算(基线, 请求家数) : 基线);
    }
    const 兜2 = await 取兜底();
    if (兜2) return 出响应({ ...兜2, stale: true, 源: "上游暂不可达，回传上次结果" });
    return 出响应({ ok: false, 源: "温度数据未取到（上游不可达或被限流）", 数据: null, 算于: 北京时刻() });
  } catch (e) {
    const 兜 = await 取兜底();
    if (兜) return 出响应({ ...兜, stale: true, 源: "计算异常，回传上次结果" });
    return 出响应({
      ok: false,
      源: "云端温度计算异常:" + String((e && e.message) || e).slice(0, 80),
      数据: null,
      算于: 北京时刻(),
    });
  }
}
