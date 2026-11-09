# MCP 双服务配置（四端权威说明）

> 建立：2026-11-09 22:35，手机端核验后。
> **以本文为准**：`collab-entry.md` 6.1 / 6.2 节把文件读写工具列在 `/api/mcp` 之下，与云端实测不符，待电脑端同步修正。
> 仓库公开，口令一律用占位符，不写明文。

## 一、为什么是两条

22:08 云端 `astock-mcp.pages.dev` 部署为 `agent-hub-mcp` 协作中枢，实测 `tools/list` 只有状态 / 项目 / 文件索引 / 交接日志 / 聊天摘要 / Actions 只读，**没有** `read_file` / `write_file` / `delete_file`。
文件写删能力因此中断，但台账与规程仍按「豆包能写删」写。为不覆盖电脑端的新中枢，把原来的 8 工具文件读写服务**并存部署**到独立域名，两个服务各管一摊、互不干扰。

## 二、服务 A · 仓库文件读写（8 工具）

| 项 | 值 |
|---|---|
| URL | `https://astock-file-mcp.pages.dev/mcp` |
| 服务标识 | `astock-mcp 1.0.0` |
| 鉴权 | `Authorization: Bearer <MCP_TOKEN>`（口令单独发，不入库） |
| 目标仓库 | `dqlvxy/astock-recs-bot` @ `main`，唯一 |

| 工具 | 用途 |
|---|---|
| `status` | 仓库 HEAD、最近提交、关键文件大小 |
| `list_dir` | 列目录 |
| `read_file` | 读文本，超 300KB 截断 |
| `search_in_file` | 单文件搜关键词，返回行号与整行 |
| `list_commits` | 最近提交 |
| `write_file` | 新建 / 整文件覆盖，自动取旧 sha |
| `delete_file` | 删文件 |
| `append_log` | 往 `collab-log.md` 变更记录顶部追加一行 |

**服务端硬拦**：禁写 `.github/workflows/**`；`recs.json` / `today.json` / `watch.json` / `review_log.json` / `params.json` 需显式 `allow_data_file: true`；路径禁 `..` 与绝对路径；禁删 `collab-entry.md` / `collab-rules.md` / `collab-log.md`；错误口令返回 `unauthorized`。

## 三、服务 B · 协作中枢 + Actions 只读（12 功能）

| 项 | 值 |
|---|---|
| URL | `https://astock-mcp.pages.dev/api/mcp`（旧 `/mcp` 已 404） |
| 服务标识 | `agent-hub-mcp 0.1.0` |
| 鉴权 | 同一个 `Authorization: Bearer <MCP_TOKEN>` |
| 名字 | 每个功能有中文名与英文别名两套，合计 24 个名字 / 12 个功能 |

| 功能（英文别名） | 用途 |
|---|---|
| `status` / `project_list` / `project_get` / `project_set` | 中枢概览、项目状态读写 |
| `file_put` / `file_list` | 产物文件 / 链接索引（**不是写仓库源码**） |
| `handoff_append` / `handoff_list` | 交接日志 |
| `chat_summary_append` / `chat_summary_list` | 聊天摘要（要点，非原文） |
| `actions_list` / `actions_get` | **只读**：Actions 运行与每步结论 |

`actions_list` / `actions_get` **必须带 `repo: "dqlvxy/astock-recs-bot"`**，不带会因路径缺 repo 返回 404。
B 不提供任何仓库文件写删能力。

## 四、四端接入

| 端 | 装 A | 装 B | 改仓库 | 推 main 后上线 |
|---|---|---|---|---|
| 电脑端 WorkBuddy | 可不用（本地 git） | ✔ | ✔ git / MCP | 自动 |
| 手机端 WorkBuddy | 可不用（本地 git） | ✔ | ✔ git / MCP | 自动 |
| 手机端豆包 | ✔ 必装 | ✔ 必装 | ✔ 经 A | 自动 |
| 电脑端豆包 | ✔ 必装 | ✔ 必装 | ✔ 经 A | 自动 |

`deploy.yml` 已开启：任何一端推 `site/**` 或 `grid/**` 到 main，约 1–2 分钟自动部署两个站点；根目录文档改动不触发部署。
四端都能改文件，只有本地 WorkBuddy 能跑自检脚本与改 CI；豆包不许声称「已自检」或「已上线」。

## 五、2026-11-09 22:35 实测记录

| 检查 | 结果 |
|---|---|
| A `initialize` / `tools/list` | `astock-mcp 1.0.0`，8 工具齐全 |
| A 真实写入 / 读回 / 删除 | 通过，commit `12bc098` / `c494515` |
| A 三道硬限制 | 写 workflow、写产物 JSON、删协作文档逐一被拒 |
| A 错误口令 | `unauthorized` |
| B `initialize` / `tools/list` | `agent-hub-mcp 0.1.0`，12 功能 / 24 名字 |
| B `actions_list` / `actions_get`（带 repo） | 返回 127 次 run 与两步 success 结论 |
| 两个线上站点 | 看板 721459 B / sw v28；网格 131773 B，均 200 |

## 六、待电脑端处理

1. `collab-entry.md` 6.1 / 6.2 节：把端点与工具拆成 A / B 两条，删除「/api/mcp 下有 write_file」的错误表述。
2. `collab-rules.md` 第 5 项「12 个工具」与初始化状态表第 7 项「push 自动部署 ⏳ 待开启」：前者按 A/B 拆分，后者改为「✔ 已开启」。
3. 三份旧 Actions secrets（`DEPLOY_PAT` / `MCP_TOKEN` / `AGENTHUB_GH_TOKEN`）需 admin 权限清理，手机端无权限。

---

本报告仅供研究参考，不构成个人投资建议。
