// Cloudflare Pages Functions —— 实时换手/量比 边缘代理（腾讯主 · 东财备）
// 浏览器请求看板自身域名下的 /api/auction?codes=002343,300308,... 由本函数在 CF 边缘服务端代取行情再回传，
// 彻底绕开客户端网络对第三方域名（东财 / 腾讯）的拦截与跨域限制。
//
// 口径说明（重要，2026-10-15 三次修正）：
//   ① 「竞价换手 / 竞价委比」是 09:25 集合竞价的「定格值」，盘后无法回溯；云端 today.js 因此置 null，
//      前端这两格长期显示 "--"。本接口提供「实时口径」。
//   ② 委比盘后区分度极低（涨停票恒 +100%），已改为回填「量比」。
//   ③ 主源为何是腾讯而非东财：
//      - 东财 ulist.np/clist 用的是 f2(价)/f3(涨幅)/f8(换手) 这套字段号，**不是** stock/get 的
//        f43/f170/f168（混用会返回错位垃圾值，实测 price 变 84076.82）；
//      - 且 fltt=2 时字段已是真实值，不能再 ÷100（双重缩放同样出垃圾）；
//      - 仓库 today.js 实测结论：「东财接口拿不到量比」——量比只有腾讯 f[49] 可靠。
//      故腾讯为主源（换手+量比齐全），东财降为备源（价/涨幅/换手，量比置 null）。
//   ④ 所有行过「可信校验」：价/涨幅/换手/量比超出物理合理区间一律丢弃，防脏数据污染卡片。
//
// 铁律（同 fund.js/data.js）：任何路径都返回 application/json，绝不抛错——
//   抛错会被 Pages SPA 回退成 HTML，前端 r.json() 炸出「无数据」误报。

/* 腾讯：f[3]价 · f[32]涨幅% · f[38]换手% · f[49]量比（均为真实值，不缩放） */
const 东财字段 = "f12,f14,f2,f3,f8"; /* fltt=2 → 真实值；东财无量比字段 */
const 东财域表 = [
  "push2.eastmoney.com",
  "82.push2.eastmoney.com",
  "48.push2.eastmoney.com",
  "25.push2.eastmoney.com",
];

const 超时毫秒 = 6000;
const 缓存键前缀 = "https://astock-board-9t0.pages.dev/api/auction#";
const 缓存秒 = 3; /* 盘中 3 秒刷新，边缘缓存同频 */

function 归一码(c) {
  return String(c || "").replace(/[^0-9]/g, "").slice(0, 6);
}
function 是沪(码) {
  return /^(60|68|90|11|5)/.test(码);
}
function 是北(码) {
  return /^(43|83|87|88|92)/.test(码);
}
function 东财secid(码) {
  return (是沪(码) ? "1." : "0.") + 码;
}
function 腾讯secid(码) {
  return 是北(码) ? "bj" + 码 : 是沪(码) ? "sh" + 码 : "sz" + 码;
}
function 数字(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
/* 脏数据闸门：任何超出物理合理区间的值一律视为错位/异常，直接丢行 */
function 行可信(r) {
  if (!r || !/^\d{6}$/.test(r.code || "")) return false;
  if (r.price != null && !(r.price > 0 && r.price < 200000)) return false;
  if (r.pct != null && Math.abs(r.pct) > 35) return false;
  if (r.turnover != null && !(r.turnover >= 0 && r.turnover <= 300)) return false;
  if (r.liang_bi != null && !(r.liang_bi >= 0 && r.liang_bi <= 100)) return false;
  return true;
}
function 过筛(rows) {
  return (rows || []).filter(行可信);
}

async function 取腾讯(codes) {
  const syms = codes.map(腾讯secid);
  const r = await fetch("https://qt.gtimg.cn/q=" + syms.join(","), {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(超时毫秒),
  });
  if (!r.ok) return null;
  const buf = await r.arrayBuffer();
  const t = new TextDecoder("gbk").decode(buf);
  const rows = [];
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const f = m[2].split("~");
    if (f.length < 50) continue;
    const 价 = 数字(f[3]);
    rows.push({
      code: m[1].replace(/^[a-z]{2}/, ""),
      name: String(f[1] || ""),
      price: 价 != null && 价 > 0 ? 价 : null,
      pct: 数字(f[32]),
      turnover: 数字(f[38]),
      liang_bi: 数字(f[49]),
    });
  }
  const 可信 = 过筛(rows);
  return 可信.length ? { 源: "腾讯财经(边缘代理)", rows: 可信 } : null;
}

function 解东财行(diff) {
  const rows = [];
  for (const d of diff) {
    if (!d || !d.f12) continue;
    rows.push({
      code: String(d.f12),
      name: String(d.f14 || ""),
      price: 数字(d.f2),
      pct: 数字(d.f3),
      turnover: 数字(d.f8),
      liang_bi: null, /* 东财接口不提供量比 */
    });
  }
  return rows;
}

async function 取东财一域(域, secids) {
  const url =
    "https://" + 域 + "/api/qt/ulist.np/get?ut=fa5fd1943c7b386f172d6893dbfba10b&invt=2&fltt=2&secids=" +
    secids +
    "&fields=" +
    东财字段;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(超时毫秒),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const diff = (j && j.data && j.data.diff) || [];
  const rows = 过筛(解东财行(diff));
  return rows.length ? rows : null;
}

async function 取东财(codes) {
  const secids = codes.map(东财secid).join(",");
  for (const 域 of 东财域表) {
    try {
      const rows = await 取东财一域(域, secids);
      if (rows) return { 源: "东方财富(边缘代理)", rows };
    } catch (e) {}
  }
  return null;
}

async function 读缓存(键) {
  try {
    const c = await caches.default.match(键);
    if (!c) return null;
    const j = await c.json();
    return j && j.rows && j.rows.length ? j : null;
  } catch (e) {
    return null;
  }
}
async function 写缓存(键, 出) {
  try {
    const r = new Response(JSON.stringify(出), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + 缓存秒,
      },
    });
    await caches.default.put(键, r.clone());
  } catch (e) {}
}
function 出响应(出, 边缘缓存) {
  return new Response(JSON.stringify(出), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": 边缘缓存 ? "public, max-age=30" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const 码列 = (url.searchParams.get("codes") || "")
    .split(",")
    .map(归一码)
    .filter((x) => /^\d{6}$/.test(x));
  const 唯一 = Array.from(new Set(码列)).slice(0, 60); /* 单次最多 60 只，超长分批由前端做 */
  if (!唯一.length) return 出响应({ ok: false, 源: "缺 codes 参数", rows: [] }, false);

  const 键 = 缓存键前缀 + 唯一.join(",");
  const 及格线 = Math.ceil(唯一.length * 0.5);
  try {
    const 缓存 = await 读缓存(键);
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    if (缓存 && Date.now() - 缓存时间 < 缓存秒 * 1000) return 出响应(缓存, false);

    /* 主源腾讯（换手+量比齐全）→ 可信行不足半数则试东财，取行数多的一方 */
    let 命中 = await 取腾讯(唯一);
    if (!命中 || 命中.rows.length < 及格线) {
      const 备 = await 取东财(唯一);
      if (备 && (!命中 || 备.rows.length > 命中.rows.length)) 命中 = 备;
    }

    if (命中) {
      const 出 = { ok: true, 源: 命中.源, rows: 命中.rows, 缓存于: new Date().toISOString() };
      await 写缓存(键, 出);
      return 出响应(出, false);
    }
    if (缓存) return 出响应(Object.assign({}, 缓存, { stale: true }), true);
    return 出响应({ ok: false, 源: "服务端代理全部上游失败", rows: [] }, false);
  } catch (e) {
    try {
      const 缓存 = await 读缓存(键);
      if (缓存) return 出响应(Object.assign({}, 缓存, { stale: true }), true);
    } catch (e2) {}
    return 出响应(
      { ok: false, 源: "服务端代理异常:" + String((e && e.message) || e).slice(0, 60), rows: [] },
      false
    );
  }
}
