// worker.js —— 读端 + 上报端
//   GET  /api/recs      读 KV 最新稳健版荐股，返回前端契约结构 { ok, recs:[多期] }
//   POST /api/recs/push 前端 14:30 后上报定稿荐股，写入 KV history
//   GET  /api/health    健康检查
// 部署：wrangler deploy（KV 绑定 ASTOCK_SYNC 见 wrangler.toml）
//
// 数据契约（与前端 A股选股看板.html 的 拉后端存档() 对齐）：
//   GET /api/recs → { ok:true, recs:[ { date, gen_time, picks:[...] }, ... ] }  按日期升序
//   KV key astock_recs_stable  ：最新一期完整对象（引擎产出，含 temperature/main_lines）
//   KV key astock_recs_history ：近 12 期精简数组，用于合并展示 + 跨期去重

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, "Cache-Control": cache },
  });
}

/* 把「最新一期 stable」+「history 数组」合并成前端要的 recs 数组（按日期升序、去重、留近 10 期） */
function 合并({ stable, history }) {
  const 全 = {};
  const 收 = (g) => {
    if (!g || !g.date || !Array.isArray(g.picks) || !g.picks.length) return;
    const 旧 = 全[g.date];
    if (!旧) 全[g.date] = g;
    else {
      // 同一日期：最新一期 stable 字段最全，优先保留字段更多的一方
      const 新字段 = Object.keys(g).length, 旧字段 = Object.keys(旧).length;
      if (新字段 > 旧字段) 全[g.date] = g;
    }
  };
  if (Array.isArray(history)) history.forEach(收);
  if (stable) 收(stable);
  const 列表 = Object.keys(全).map((k) => 全[k]).sort((a, b) => (a.date < b.date ? -1 : 1));
  return 列表.length > 10 ? 列表.slice(-10) : 列表;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    /* ── 健康检查 ── */
    if (url.pathname === "/api/health") {
      return json({ ok: true, svc: "astock-recs-reader", t: new Date().toISOString() });
    }

    /* ── 读端：返回前端契约 { ok, recs:[多期] } ── */
    if (url.pathname === "/api/recs" || url.pathname === "/") {
      try {
        const [sRaw, hRaw] = await Promise.all([
          env.ASTOCK_SYNC.get("astock_recs_stable"),
          env.ASTOCK_SYNC.get("astock_recs_history"),
        ]);
        const stable = sRaw ? JSON.parse(sRaw) : null;
        const history = hRaw ? JSON.parse(hRaw) : [];
        const recs = 合并({ stable, history });
        return json({ ok: true, recs, count: recs.length, source: "kv" });
      } catch (e) {
        return json({ ok: false, error: String(e), recs: [] }, 500);
      }
    }

    /* ── 上报端：前端 14:30 后推定稿荐股 ── */
    if (url.pathname === "/api/recs/push" && req.method === "POST") {
      try {
        const body = await req.json();
        if (!body || !body.date || !Array.isArray(body.picks) || !body.picks.length) {
          return json({ ok: false, err: "缺少 date/picks" }, 400);
        }
        const hRaw = await env.ASTOCK_SYNC.get("astock_recs_history");
        const 历史 = hRaw ? JSON.parse(hRaw) : [];
        const 精简 = {
          date: body.date,
          gen_time: body.gen_time || "",
          picks: body.picks.map((x) => ({
            code: x.code, name: x.name, prob: x.prob, score: x.score,
            buy_price: x.buy_price, stop_loss: x.stop_loss, industry: x.industry,
            buy_type: x.buy_type, reasons: x.reasons, tech: x.tech,
          })),
          src: body.src || "frontend",
        };
        const 新历史 = (Array.isArray(历史) ? 历史 : [])
          .filter((g) => g && g.date !== body.date)
          .concat([精简])
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .slice(-12);
        await env.ASTOCK_SYNC.put("astock_recs_history", JSON.stringify(新历史));
        return json({ ok: true, date: body.date, picks: 精简.picks.length, hist_n: 新历史.length });
      } catch (e) {
        return json({ ok: false, err: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
