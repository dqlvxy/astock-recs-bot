# astock 协作入口（外部 AI 先读这一份）

> 给**手机端豆包、电脑端豆包、手机/电脑 WorkBuddy** 共用。
> 一次读完就能知道：项目是什么、文件在哪、你能改什么、怎么改才不闯祸。
> 规程见 `collab-rules.md`，变更历史见 `collab-log.md`。
> 版本 v3.0 · 2026-11-09 16:05 · **豆包已获得写/删权限，与 WorkBuddy 同等**

---

## 一、项目是什么

一套 A 股「尾盘 14:50 买入 · 次日 14:30 卖出」的量化选股系统，外加看板与网格回测两个前端工具。
**不是模拟盘**，是按推荐真实下单的，任何改动都可能影响真实交易决策。

## 二、三个模块

| 模块 | 目录 | 线上地址 | 说明 |
|---|---|---|---|
| ① 策略引擎 | 仓库根（`engine.js` 等） | 无独立域名，产物进仓库 | GitHub Actions 每交易日 14:05–14:45 五档 cron 自动跑，产出 `recs.json` / `today.json` / `watch.json`；15:30 跑 `review.js` 复盘与账户模拟 |
| ② 看板 | `site/` | `astock-board-9t0.pages.dev` | 单文件 `index.html`（约 720KB），`functions/api/*.js` 7 个边缘代理，从 GitHub raw 读数 |
| ③ 网格回测 | `grid/` | `astock-grid.pages.dev`（原 surge 域名不再更新） | 单文件 `index.html`（约 132KB），跌买涨卖逆向网格，与另两个模块完全独立 |

依赖关系：② 的数据全部来自 ①；③ 完全独立。

## 三、文件地图

```
astock-recs-bot/                仓库根
├── engine.js          71KB    选股五层漏斗（温度→初筛→硬过滤 9 关→信号优选→形态分）
├── generate.js        11KB    生成当日定稿 recs.json，含「当日定稿冻结」规则
├── review.js          55KB    收盘复盘：多周期胜率、账户模拟、回测统计、逐日均涨
├── today.js           24KB    全模块快照 today.json + watch.json
├── yaogu.js           12KB    妖股/异动辅助
├── test/                      引擎与账户模拟回归测试
├── scripts/提交产物.sh        5 轮重试推送脚本（CI 调用，中文名例外，不动）
├── .github/workflows/         daily.yml（5 档 cron）/ review.yml（15:30）
├── site/                      ② 看板
│   ├── index.html     720KB   单文件，全部 UI 与逻辑
│   ├── sw.js                  缓存版本闸，改 HTML 必须与 ?v=N 同步 +1
│   ├── 自检.sh        16KB    30 项检查，含 EXPECT_MD5 基线
│   ├── 运维手册.md    83KB    历史踩坑全记录
│   ├── _headers / manifest-board.json / icon-*.png
│   └── functions/api/         7 个边缘代理（data/recs/fund/temp/auction/status/dashboard）
├── grid/                      ③ 网格回测
│   ├── index.html     132KB   单文件
│   ├── sw.js / CNAME / manifest-grid.json / icon-*.png
├── collab-entry.md            本文件（外部 AI 入口）
├── collab-rules.md            协作规程
└── collab-log.md              协作台账
```

## 四、当前状态（每次改动后更新本节）

| 项 | 值 |
|---|---|
| 最新 commit | `2b7b74c`（2026-11-09 16:10，site/ 与 grid/ 入库，四端协作 v3.0） |
| 看板缓存版本 | `sw.js` v27（`index.html` 内 `sw.js?v=27`） |
| 网格缓存版本 | v6 |
| 荐股存档期数 | 22 期（最后一期 20261109，5 只） |
| 近 6 个月 T+1 胜率 | 52.1%（38/73），等权均收 -0.39% |
| 账户模拟（5 万本金 / 1 万每票） | 净收益 -6.75%，最大回撤 -12.91%，费用吃掉毛利约 45.8% |
| CI 触发方式 | **仅 cron，无任何手动入口**（dispatch 返回 422） |

## 五、四端权限（v3.0 起豆包与 WorkBuddy 同级）

| 端 | 读 | 写 | 删 | 部署 | 改 CI |
|---|---|---|---|---|---|
| 电脑端 WorkBuddy | ✔ | ✔ | ✔ | ✔ | ✔ 需 `workflow` 权限 |
| 手机端 WorkBuddy | ✔ | ✔ | ✔ | ✔ | ✘ 除非令牌带 `workflow` |
| 电脑端豆包 | ✔ | ✔ | ✔ | 自动 | ✘ |
| 手机端豆包 | ✔ | ✔ | ✔ | 自动 | ✘ |

**部署分两种情况**（见 `四端同步_开启自动部署.md`）：
- 自动部署已开启：四端改完 `site/` 或 `grid/` 推送后，GitHub Actions 约 1–2 分钟自动上线，谁改都一样。
- 尚未开启：部署仍由电脑端 WorkBuddy 用 `wrangler pages deploy` 执行，豆包改完要说「请 WorkBuddy 部署」。

**唯一硬差异**：不能改 `.github/workflows/**`（服务端硬拦，普通令牌也拦）。

## 六、你是豆包：怎么读写仓库

### 6.1 连接方式

| 项 | 值 |
|---|---|
| 端点 | `https://astock-mcp.pages.dev/mcp` |
| 协议 | MCP Streamable HTTP（JSON-RPC 2.0） |
| 鉴权 | Header `Authorization: Bearer <MCP_TOKEN>`（口令向用户索取，不写进任何文件） |
| 可操作仓库 | `dqlvxy/astock-recs-bot` @ `main`，**唯一**目标 |

在豆包/扣子的「MCP 服务器」里新增一条：类型选 HTTP/SSE，URL 填上面端点，自定义 Header 加一行 `Authorization: Bearer <MCP_TOKEN>`。

### 6.2 八个工具

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `status` | 仓库 HEAD、最近 5 次提交、关键文件大小 | — |
| `list_dir` | 列目录 | `path`（根目录传 `""`） |
| `read_file` | 读文本文件，超 300KB 截断 | `path` `max_chars` |
| `search_in_file` | 单文件内搜关键词，返回行号与整行 | `path` `keyword` `context` |
| `list_commits` | 最近提交 | `limit` |
| `write_file` | 新建或整文件覆盖，自动取旧 sha | `path` `content` `message` `allow_data_file` |
| `delete_file` | 删文件 | `path` `message` |
| `append_log` | 往 `collab-log.md` 变更记录顶部追加一行 | `device` `files` `summary` `commit` `verify` |

### 6.3 每次动手的固定顺序

```
status  →  list_dir(相关目录)  →  read_file(要改的文件)  →  write_file
        →  read_file 复核  →  append_log 记台账
```

**禁止凭记忆改文件。** 没 read 就 write，等于用你的想象覆盖别人的工作。

### 6.4 硬限制（服务端拦，绕不过）

1. 不能写 `.github/workflows/**`
2. 写 `recs.json` / `today.json` / `watch.json` / `review_log.json` / `params.json` 必须显式传 `allow_data_file: true`——**正常情况下永远不要传**，这五个文件只由 Actions 生成
3. 路径不能含 `..`、不能绝对路径
4. 不能删 `collab-*.md` 三份协作文档
5. 单文件内容别超过 800KB（`site/index.html` 已 720KB，改动请用精确替换的思路描述清楚，必要时请 WorkBuddy 在本地改）

### 6.5 改看板的两个连带动作

1. 改了 `site/index.html` → `site/sw.js` 的缓存名 +1，且 `index.html` 里 `sw.js?v=N` 同步 +1，两处必须一致
2. 改完让 WorkBuddy 跑 `cd site && bash 自检.sh`，30 项全过再推送（自动部署开启后推送即上线）

## 七、你的输出该怎么写

```
【结论】一句话说清问题或机会

【依据】引用文件路径 + 函数名或可搜索的原文片段（不许编造行号）

【改动】已改 / 建议改
  文件：site/index.html
  定位：搜索 `var 明细行 = 明细源.map`
  改成：<具体到字段与表达式>

【风险】可能坏的场景，以及怎么验

【下一步】需要 WorkBuddy 做什么（部署 / 跑自检 / 改 CI）
```

## 八、五条红线

1. 令牌、口令、API Key 不许写进任何文件
2. 五个运行产物 JSON 不许手改，只由 Actions 生成
3. `sw.js` 版本号与 `index.html` 的 `?v=` 必须同步
4. 统计口径改动必须同时看 `review.js`（后端算）与 `site/index.html`（前端渲染），只改一边会显示错乱
5. 不许删「当日定稿冻结」（`generate.js`）与「今日定稿闸门」（`daily.yml`）——这是防同一天出两个版本荐股的最后防线
