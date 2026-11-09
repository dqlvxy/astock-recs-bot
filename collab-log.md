# 协作台账（collab-log）

> 四端共用：手机端 WorkBuddy / 电脑端 WorkBuddy / 手机端豆包 / 电脑端豆包
> **开工前必读，收工必写。** 规程见 `collab-rules.md`，外部 AI 入口见 `collab-entry.md`。
> 设备代号统一写：`手机端` / `电脑端` / `手机豆包` / `电脑豆包`

---

## 当前占用（改文件前加一行并 push，改完删掉）

| 设备 | 文件 | 开始时间 | 计划改动 | 预计完成 |
|---|---|---|---|---|
| — | — | — | （无占用时保留这一行占位） | — |

---

## 变更记录（新的在最上面，一行一次改动）

| 时间 | 设备 | 文件 | 改动内容 | commit | 线上版本 | 自检 |
|---|---|---|---|---|---|---|
| 2026-11-10 01:34 | 手机豆包 | `site/index.html`、`site/sw.js` | 持仓荐股等级排序修复：上一版排序读 `a.r`，但 recs.json 的 pick 无此字段、全部落到 99，等于没排；改为 `等级信息().序` 作第一主键（buy_rank / 买点等级 / buy_type 反推 / tier 兜底），同等级按形态分降序、未标级排最后；原地更新路径由 `picks[i]` 改为 `排序后[i]`，避免文本错配；缓存 sw 28→29 | 4fc87b3 | sw v29 | `new Function` 编译 renderTodayHold 通过；6 只样例实测排序 一等>二等>六等>七等>未标级 |
| 2026-11-09 23:32 | 手机豆包 | `collab-rules.md` | 第六节步骤 1 的端点拆成 A（`astock-file-mcp.pages.dev/mcp`，8 个文件工具）/ B（`astock-mcp.pages.dev/api/mcp`，12 个功能），并注明文件工具只在 A、B 的 `file_list` 返回空属正常；初始化 #5 由「12 个工具」改为 A/B 双服务对照；初始化 #7「push 自动部署 ⏳ 待开启」改为 ✔ 已开启（`deploy.yml` `8917f6c`，最近三次 run 均 success） | 983c3e9 | — | 读回复核 12232 B，3 处旧表述均已不存在；Actions total 仍 127，未误触发部署 |

| 2026-11-09 23:11 | 手机豆包 | `collab-entry.md` | 6.1 拆成服务 A（`astock-file-mcp.pages.dev/mcp`，8 工具）/ 服务 B（`astock-mcp.pages.dev/api/mcp`，12 功能）两条服务表；6.2 由「十二个工具」改为「A 8 个 + B 12 个功能」两张表；删掉「`/api/mcp` 下有 `write_file`」的错配，补「B 的 `file_list` 查中枢索引、返回空属正常」说明 | 845694d | — | GitHub Contents API 读回复核：10658 B，A/B 两端点俱在，「十二个工具」表述已不存在 |
| 2026-11-09 22:38 | 手机端 | MCP-双服务配置.md | 并存部署文件读写 MCP（astock-file-mcp.pages.dev），恢复豆包写删；修正双服务端点说明 | 32b1c20 | — | A 写读删+3 道红线实测通过；B Actions 只读带 repo 正常 |
| 2026-11-09 22:15 | 电脑端 | `dqlvxy/agent-hub-mcp` 的 `functions/api/mcp.js`、`collab-entry.md`、`collab-rules.md` | 给豆包开 Actions 只读：新增 `actions_list`（列 workflow run）与 `actions_get`（取作业与每一步结论，附 `failed_steps`），工具数 10→12，中文名「查 Actions 运行」「读 Actions 详情」+ 英文别名双注册；`astock-mcp` 与 `agent-hub-mcp` 两个 Pages 项目均已重新部署（`ed07d2d`）；同时修正文档里 MCP 端点路径 `/mcp`→`/api/mcp`（旧路径实测 404） | `ed07d2d` | astock-mcp / agent-hub-mcp | 线上 tools/list 24 条；本地与线上实测 `actions_list` 拉到真实 run、`actions_get` 返回逐步结论 |
| 2026-11-09 21:50 | 电脑端 | `.github/workflows/deploy.yml` | 开启 push 自动部署：建 `CF_ACCOUNT_ID` / `CF_API_TOKEN` 两个 Secret + `deploy.yml`（创建 `6777b69`，wrangler 4.158.0 要求 Node≥22 修正为 `8917f6c`）；手动 run 一次 + 临时改 manifest 一个字推一次验证 push 触发（`5aa450c`），改回再推（`8d3a63b`），三次部署均自动跑绿 | `8917f6c` | 看板 sw v27 / 网格 v6 | Actions 全绿，7 项验收通过 |
| 2026-11-09 21:06 | 手机端 | `collab-rules.md`、`collab-entry.md`、`四端提示词.md` | 建立每轮归档机制：聊天记录与生成文件脱敏后上云到资料库；规程升 v3.2 | 待填 | 资料库 | 脱敏扫描零残留，3 项上传读回通过 |
| 2026-11-09 20:10 | 手机端 | `grid/index.html`、`grid/sw.js` | 网格从 surge 迁到 Cloudflare Pages（`astock-grid.pages.dev`），线上地址改新域名，缓存 v5→v6 | `1ccccdc` | Pages v6 | 线上 md5 与仓库一致 |
| 2026-11-09 16:10 | 手机端 | `site/` 23 文件、`grid/` 7 文件、`collab-entry.md`、`collab-rules.md` | 首次把看板与网格源码纳入仓库；豆包经 MCP 获得读/写/删权限，规程升 v3.0 | 待填 | — | MCP 写删实测通过，令牌扫描零命中 |
| 2026-11-09 15:45 | 手机端 | `collab-entry.md` `collab-rules.md` `collab-log.md` 新建 | 建立四端协作基准（含豆包只读接入），准备把 `site/` `grid/` 纳入仓库 | 待推 | — | 文档自检通过 |
| 2026-11-09 15:20 | 电脑端 | `.github/workflows/daily.yml`、`review.yml`、删除 `dryrun.yml` | 删除全部手动触发入口与 force；daily cron 3 档 → 5 档（14:05/15/25/35/45） | `305c1ef` | — | 5 项验收通过，dispatch 返回 422 |
| 2026-11-09 14:46 | 手机端 | `site/index.html`、`site/sw.js` | 逐日明细「累计」列回退为账户累计收益率，保留「均涨」列 | `8cfed920` | sw v27 | 自检 30/30 ✔ |
| 2026-11-09 12:06 | 手机端 | `astock-recs-bot/review.js` | 账户模拟新增逐日「均涨幅」= 当日荐股涨跌幅算术平均 | `e692f8f3` | — | `node --check` 通过，回归 13 项 ✔ |

---

## 待办与遗留

| # | 事项 | 来源 | 负责方 | 状态 |
|---|---|---|---|---|
| 1 | 首次把 `site/`、`grid/` 与三份 collab 文档纳入仓库 | 手机端发起 | 手机端 | ✔ 已完成 |
| 2 | 网格部署方式确认 | 手机端 | 手机端 | ✔ 已定：Cloudflare Pages，不再用 surge |
| 3 | 11-10 14:05 验证 5 档 cron 是否触发（预期 5 条 schedule，首条生成、后四条 already=1） | 手机端 | 手机端 | 待观察 |
| 4 | 看板「累计均涨」字段留在 `params.json` 但界面不显示 | 手机端 | — | 备用，暂不处理 |
| 5 | 豆包接入 MCP：在豆包/扣子里填端点与口令，验证 `status` 与一次写入 | 手机端 | 用户 | 待用户在客户端配置 |
| 6 | 开启 push 自动部署（两个 Secret + `deploy.yml`） | 手机端 | 用户/手机端 | ✔ 已完成（2026-11-09 20:50 电脑端，deploy.yml `8917f6c`，四端 push 即上线） |

---

## 豆包改动区

v3.0 起豆包能直接改仓库，改完必须调 `append_log` 自动落一行到上面的「变更记录」，device 填 `手机豆包` / `电脑豆包`。
**自动部署已开启（2026-11-09 20:50）**：四端改完 `site/` 或 `grid/` 推送到 main 后，GitHub Actions「部署前端到 Cloudflare Pages」约 1–2 分钟自动上线（手动 run 与 push 触发均已实测全绿），不再需要 WorkBuddy 手工执行 `wrangler pages deploy`。

| 日期 | 来源 | 改动文件 | commit | 部署状态 |
|---|---|---|---|---|
| — | — | （暂无） | — | — |

---

## 规矩速查

1. 改前：`git pull` → 读本文件 → 写占用行 → push 占用行
2. 改后：自检 → 部署 → commit → push → 删占用行 + 追加变更记录 + 必要时更新 `collab-entry.md` 第三节
3. 冲突：后到者放弃自己版本，基于对方版本重做，不手工解 720KB 单文件的冲突
4. 红线：令牌不入库、不手改运行产物、sw 版本号两处同步、仓库新文件用 ASCII 命名
