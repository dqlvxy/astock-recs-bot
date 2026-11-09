// Cloudflare Pages Functions —— 首页看板数据接口（/api/dashboard）
//
// 起因（2026-10-22 诊断）：/api/dashboard 同样没有 functions 实现，前端 getData
//   只能吃 EMBED 里 2026-09-17 构建时烧录的静态快照（指数/涨跌家数/连板梯队首屏全是 9 月值），
//   虽多数区块有后续实时刷新兜底，首屏仍会闪旧数据。
//
// 方案：本函数服务端代理 GitHub raw 的 today.json，把其字段映射为看板 dashboard 契约：
//   · index    today.json 的 {sh,sz,cyb,kc50} 对象 → 看板需要的数组（code/name/price/pct/chg/amt_yi）
//   · breadth  market_stat → {up,down,flat,total,...}（distribution 缺省由前端默认值兜底，
//              且 loadDash 随后会调 fetchBreadth 拉实时腾讯数据重绘，最终展示以实时为准）
//   · sectors  main_lines → [{name, net_in(元)}]（loadDash 汇总后 ÷1e8 显示亿）
//   · zt       today.json 只有 zt_count，造等长数组仅供前端取 length 显示「涨停 N 家」
//   · dt      跌停明细由前端自行拉取，此处给空数组
//   · temp     透传 today.json 的 temperature（温度卡实际以 /api/temp 实时接口为准）
//
// 铁律（同 data.js/recs.js/status.js）：任何路径都返回 application/json，绝不抛错。
//   上游失败返回 {ok:false, error:"..."}，前端 getData 已按「实时失败回落 EMBED 快照」处理。

const 仓库 = "dqlvxy/astock-recs-bot";
const 分支 = "main";
const 主源URL = "https://raw.githubusercontent.com/" + 仓库 + "/" + 分支 + "/today.json";
const 备源URL = "https://cdn.jsdelivr.net/gh/" + 仓库 + "@" + 分支 + "/today.json";

const 超时毫秒 = 8000;
const 缓存键 = "https://astock-board-9t0.pages.dev/api/dashboard#cache";
const 缓存秒 = 60; /* 快照每日更新，60 秒边缘缓存足够防刷 */

/* today.json index 的 key → 看板指数卡的 code/中文名 */
const 指数表 = {
  sh: { code: "000001", name: "上证指数" },
  sz: { code: "399001", name: "深证成指" },
  cyb: { code: "399006", name: "创业板指" },
  kc50: { code: "000688", name: "科创50" },
};

function 组装(t) {
  if (!t || !t.trade_date) return null;
  /* ① 指数数组 */
  const index = [];
  for (const k in 指数表) {
    const v = (t.index || {})[k];
    if (!v) continue;
    index.push({
      code: 指数表[k].code,
      name: 指数表[k].name,
      price: v.price != null ? v.price : 0,
      pct: v.chg_pct != null ? v.chg_pct : 0,
      chg: v.chg != null ? v.chg : 0,
      amt_yi: v.amount_wan ? Math.round((v.amount_wan / 1e4) * 100) / 100 : 0,
    });
  }
  /* ② 涨跌家数 */
  const ms = t.market_stat || {};
  const breadth = {
    up: ms.up || 0,
    down: ms.down || 0,
    flat: ms.flat || 0,
    total: ms.total || (ms.up || 0) + (ms.down || 0) + (ms.flat || 0),
    amt_yi: null,
    net_in_yi: null,
    distribution: {},
  };
  /* ③ 板块资金流（亿 → 元，与 loadDash 的 ÷1e8 汇总口径对齐） */
  const sectors = (Array.isArray(t.main_lines) ? t.main_lines : []).map((m) => ({
    name: m.name,
    zt_count: m.zt_count,
    net_in: (m.net_in || 0) * 1e8,
  }));
  /* ④ 涨停数：today.json 只存计数，造等长数组供前端取 length */
  const ztN = t.zt_count != null ? t.zt_count : 0;
  const zt = [];
  for (let i = 0; i < ztN; i++) zt.push({});
  return {
    ok: true,
    trade_date: t.trade_date,
    gen_time: t.gen_time || "",
    index,
    breadth,
    sectors,
    zt,
    dt: [],
    temp: t.temperature || null,
    zt_count: ztN,
    dt_count: t.dt_count != null ? t.dt_count : 0,
    zb_count: t.zb_count != null ? t.zb_count : 0,
    pos_advice: t.pos_advice || "",
    源: "GitHub raw(边缘代理)",
  };
}

async function 取上游(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(超时毫秒),
    });
    if (!r.ok) return null;
    return 组装(await r.json());
  } catch (e) {
    return null;
  }
}

async function 读缓存() {
  try {
    const c = await caches.default.match(缓存键);
    if (!c) return null;
    return await c.json();
  } catch (e) {
    return null;
  }
}

async function 写缓存(出) {
  try {
    const r = new Response(JSON.stringify(出), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + 缓存秒,
      },
    });
    await caches.default.put(缓存键, r.clone());
  } catch (e) {}
}

function 出响应(出) {
  return new Response(JSON.stringify(出), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequest() {
  try {
    const 缓存 = await 读缓存();
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    const 缓存新鲜 = 缓存 && 缓存.ok && Date.now() - 缓存时间 < 缓存秒 * 1000;
    if (缓存新鲜) return 出响应(缓存);

    let 命中 = await 取上游(主源URL);
    if (!命中) 命中 = await 取上游(备源URL);

    if (命中) {
      命中.缓存于 = new Date().toISOString();
      await 写缓存(命中);
      return 出响应(命中);
    }
    /* 上游全失败：回退过期缓存（stale 也优于无数据），再无则报错让前端回落 EMBED */
    if (缓存 && 缓存.ok) return 出响应({ ...缓存, stale: true });
    return 出响应({ ok: false, error: "上游不可达（前端应回落内嵌快照）" });
  } catch (e) {
    try {
      const 缓存 = await 读缓存();
      if (缓存 && 缓存.ok) return 出响应({ ...缓存, stale: true });
    } catch (e2) {}
    return 出响应({ ok: false, error: "服务端异常:" + String((e && e.message) || e).slice(0, 60) });
  }
}
