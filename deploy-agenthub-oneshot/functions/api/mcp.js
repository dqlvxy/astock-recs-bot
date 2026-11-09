// agent-hub-mcp：豆包/WorkBuddy 四端共享 MCP 中枢
// 部署：Cloudflare Pages Functions，账本在 GitHub 仓库 dqlvxy/agent-hub
// 协议：MCP Streamable HTTP（无状态模式），JSON-RPC 2.0

const MCP_VERSION = "2025-03-26";

// ---------- base64（UTF-8 安全，Node 与 Workers 双兼容）----------
// 原实现 atob/btoa + unescape 在读取时会把中文解成 latin1，导致 state.json 里中文乱码。
// 这里用 Buffer（Node）与 TextEncoder/TextDecoder（Workers）各走一条，两端都不乱。

const B64 = {
  enc(text) {
    if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64");
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  dec(b64) {
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  },
};

// ---------- GitHub 读写 ----------

async function ghGet(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-hub-mcp",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GH GET ${path} -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (Array.isArray(j)) return { isDir: true, entries: j.map((e) => e.name) };
  return {
    isDir: false,
    sha: j.sha,
    content: j.encoding === "base64" ? B64.dec(j.content) : j.content,
  };
}

async function ghPut(env, path, text, message, sha) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: B64.enc(text),
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-hub-mcp",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GH PUT ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// 读 JSON：不存在返回 defaultValue
async function readJson(env, path, defaultValue) {
  const r = await ghGet(env, path);
  if (!r || r.isDir) return defaultValue;
  try { return JSON.parse(r.content); } catch { return defaultValue; }
}

// 写 JSON：自动带 sha
async function writeJson(env, path, obj, message) {
  const old = await ghGet(env, path);
  const sha = old && !old.isDir ? old.sha : undefined;
  return ghPut(env, path, JSON.stringify(obj, null, 2), message, sha);
}

// 追加一行到 jsonl：读旧文件 → 加一行 → 写回
async function appendJsonl(env, path, record, message) {
  const old = await ghGet(env, path);
  let text = "";
  let sha = undefined;
  if (old && !old.isDir) { text = old.content; sha = old.sha; }
  text += JSON.stringify(record) + "\n";
  return ghPut(env, path, text, message, sha);
}

// 读 jsonl 并解析成数组
async function readJsonl(env, path) {
  const r = await ghGet(env, path);
  if (!r || r.isDir) return [];
  return r.content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ---------- 工具实现 ----------

const TOOLS = [
  {
    name: "status",
    title: "云端概览",
    description: "中枢概览：项目数、文件数、最近 5 条交接与摘要。每次开工先调它。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_list",
    title: "列出全部项目",
    description: "列出所有项目及其当前状态摘要。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_get",
    title: "读取项目状态",
    description: "读某个项目的完整状态文件。",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: { slug: { type: "string", description: "项目短名，例如 astock、简历" } },
    },
  },
  {
    name: "project_set",
    title: "写入项目状态",
    description:
      "写某个项目的状态文件（整体覆盖）。字段建议：title、progress、owner、next_action、files、updated_by、updated_at。",
    inputSchema: {
      type: "object",
      required: ["slug", "state"],
      properties: {
        slug: { type: "string" },
        state: { type: "object", description: "完整状态对象，整体覆盖旧文件" },
        message: { type: "string", description: "本次改动一句话说明（进 git commit）" },
      },
    },
  },
  {
    name: "file_put",
    title: "登记产物文件",
    description: "登记一个产物文件/链接到索引。其他端靠它找到你做的东西。",
    inputSchema: {
      type: "object",
      required: ["path_or_url", "title"],
      properties: {
        path_or_url: { type: "string", description: "本地绝对路径或 http(s) 链接" },
        title: { type: "string" },
        project: { type: "string", description: "归属项目 slug，可空" },
        note: { type: "string", description: "一句话说明这个文件是啥" },
        by: { type: "string", description: "哪个端写的：手机豆包/电脑豆包/手机端/电脑端" },
      },
    },
  },
  {
    name: "file_list",
    title: "列出文件索引",
    description: "列文件索引，可按项目过滤。",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
    },
  },
  {
    name: "handoff_append",
    title: "追加交接日志",
    description:
      "追加一条交接日志：你刚干完啥、留下了啥、下次从哪接。其他端读它就能接着干。",
    inputSchema: {
      type: "object",
      required: ["project", "summary"],
      properties: {
        project: { type: "string" },
        summary: { type: "string", description: "做了什么、关键文件、下一步建议" },
        by: { type: "string" },
      },
    },
  },
  {
    name: "handoff_list",
    title: "读取交接日志",
    description: "读交接日志，可按项目过滤。",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "chat_summary_append",
    title: "存聊天摘要",
    description:
      "把你这端对话里的关键结论/决策/待办写成摘要丢进来（不是聊天原文，只是要点）。其他端靠它知道你聊过啥。",
    inputSchema: {
      type: "object",
      required: ["topic", "points"],
      properties: {
        topic: { type: "string", description: "话题，例如 astock 看板 sw 版本" },
        points: { type: "array", items: { type: "string" }, description: "关键要点列表" },
        by: { type: "string" },
      },
    },
  },
  {
    name: "chat_summary_list",
    title: "读聊天摘要",
    description: "读聊天摘要，可按 topic 模糊过滤。",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" }, limit: { type: "number" } },
    },
  },
];

async function callTool(env, name, args) {
  const now = new Date().toISOString();
  switch (name) {
    case "status": {
      const [projectsDir, files, handoff, chats] = await Promise.all([
        ghGet(env, "projects"),
        readJson(env, "files/index.json", []),
        readJsonl(env, "handoff/log.jsonl"),
        readJsonl(env, "chats/summary.jsonl"),
      ]);
      return {
        project_count: projectsDir && projectsDir.isDir ? projectsDir.entries.length : 0,
        file_count: Array.isArray(files) ? files.length : 0,
        handoff_recent: handoff.slice(-5).reverse(),
        chat_summary_recent: chats.slice(-5).reverse(),
        server_time: now,
      };
    }
    case "project_list": {
      const dir = await ghGet(env, "projects");
      if (!dir || !dir.isDir) return { projects: [] };
      const projects = await Promise.all(
        dir.entries.map(async (slug) => {
          const s = await readJson(env, `projects/${slug}/state.json`, null);
          return { slug, state: s };
        })
      );
      return { projects };
    }
    case "project_get": {
      const s = await readJson(env, `projects/${args.slug}/state.json`, null);
      if (!s) return { slug: args.slug, exists: false };
      return { slug: args.slug, exists: true, state: s };
    }
    case "project_set": {
      await writeJson(env, `projects/${args.slug}/state.json`, args.state, args.message || `update ${args.slug}`);
      return { ok: true, slug: args.slug };
    }
    case "file_put": {
      const files = await readJson(env, "files/index.json", []);
      files.push({
        path: args.path_or_url,
        title: args.title,
        project: args.project || "",
        note: args.note || "",
        by: args.by || "unknown",
        at: now,
      });
      await writeJson(env, "files/index.json", files, `file: ${args.title}`);
      return { ok: true, total: files.length };
    }
    case "file_list": {
      const files = await readJson(env, "files/index.json", []);
      if (!args.project) return { files };
      return { files: files.filter((f) => f.project === args.project) };
    }
    case "handoff_append": {
      await appendJsonl(
        env,
        "handoff/log.jsonl",
        { project: args.project, by: args.by || "unknown", at: now, summary: args.summary },
        `handoff: ${args.project}`
      );
      return { ok: true, at: now };
    }
    case "handoff_list": {
      const all = await readJsonl(env, "handoff/log.jsonl");
      const filtered = args.project ? all.filter((r) => r.project === args.project) : all;
      const limit = args.limit || 20;
      return { entries: filtered.slice(-limit).reverse() };
    }
    case "chat_summary_append": {
      await appendJsonl(
        env,
        "chats/summary.jsonl",
        { topic: args.topic, by: args.by || "unknown", at: now, points: args.points || [] },
        `chat: ${args.topic}`
      );
      return { ok: true, at: now };
    }
    case "chat_summary_list": {
      const all = await readJsonl(env, "chats/summary.jsonl");
      const filtered = args.topic ? all.filter((r) => r.topic && r.topic.includes(args.topic)) : all;
      const limit = args.limit || 20;
      return { entries: filtered.slice(-limit).reverse() };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ---------- MCP 协议入口 ----------

function jsonrpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonrpcErr(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // 鉴权
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const token = bearer || request.headers.get("x-mcp-token") || "";
  if (token !== env.MCP_TOKEN) {
    return new Response(JSON.stringify(jsonrpcErr(null, -32001, "unauthorized")), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify(jsonrpcErr(null, -32700, "parse error")), { status: 400, headers: { "content-type": "application/json" } }); }

  let result;
  try {
    switch (body.method) {
      case "initialize":
        result = jsonrpc(body.id, {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-hub-mcp", version: "0.1.0" },
        });
        break;
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        result = jsonrpc(body.id, { tools: TOOLS });
        break;
      case "tools/call": {
        const { name, arguments: args } = body.params || {};
        const out = await callTool(env, name, args || {});
        result = jsonrpc(body.id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
        break;
      }
      default:
        result = jsonrpcErr(body.id, -32601, `method not found: ${body.method}`);
    }
  } catch (e) {
    result = jsonrpcErr(body.id, -32000, String(e && e.message || e));
  }

  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": MCP_VERSION,
      "access-control-expose-headers": "mcp-protocol-version",
    },
  });
}

// CORS 预检
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    },
  });
}

// GET 探活
export async function onRequestGet(context) {
  return new Response(
    JSON.stringify({ ok: true, name: "agent-hub-mcp", time: new Date().toISOString() }),
    { headers: { "content-type": "application/json" } }
  );
}
