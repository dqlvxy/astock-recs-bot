# astock 四端协作规程

> 手机端 WorkBuddy（云电脑沙箱） · 电脑端 WorkBuddy · 手机端豆包 · 电脑端豆包
> 四者共用一套代码与一份台账。
> 版本 v3.0 · 2026-11-09 16:05 · **动手前必读，收工必写台账**

---

## 一、四端是什么关系

```
                     ┌─────────────────────────┐
                     │  GitHub 仓库 main 分支    │  ← 唯一真相源
                     │  dqlvxy/astock-recs-bot  │
                     └───────────┬─────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │ 读 + 写 + 删            │ 读 + 写 + 删            │ 读 + 写 + 删
   ┌────┴─────┐            ┌─────┴─────┐          ┌───────┴────────┐
   │ 电脑端    │            │ 手机端     │          │ 豆包 ×2        │
   │ WorkBuddy │            │ WorkBuddy │          │ 手机端 + 电脑端 │
   │ 执行+部署 │            │ 执行+部署 │          │ 执行，不部署    │
   └──────────┘            └───────────┘          └────────────────┘
        │                        │                        │
        └──── 部署 ──────────────┘                        │
              ↓                                           │
       线上：astock-board-9t0.pages.dev  /  astock-grid.surge.sh
```

**结论：四端都能改代码，只有 WorkBuddy 能上线。豆包写代码，WorkBuddy 负责自检与部署。**

## 二、四端能力边界

| 端 | 读仓库 | 改文件 | 删文件 | 部署 | 改 CI | 看线上效果 |
|---|---|---|---|---|---|---|
| 电脑端 WorkBuddy | ✔ | ✔ | ✔ | ✔ | ✔（需 `workflow` 权限） | ✔ |
| 手机端 WorkBuddy | ✔ | ✔ | ✔ | ✔ | ✘ 除非令牌带 `workflow` | ✔ 可截图 |
| 电脑端豆包 | ✔ MCP | ✔ MCP | ✔ MCP | ✘ | ✘ | ✔ 只能读 |
| 手机端豆包 | ✔ MCP | ✔ MCP | ✔ MCP | ✘ | ✘ | ✔ 只能读 |

**v3.0 起豆包与 WorkBuddy 同级：都能读、写、删。** 差异只在两处——豆包不能部署、不能改 CI（服务端硬拦）。
豆包改完代码，由 WorkBuddy 执行部署与自检；豆包不许谎称"已上线"。

## 三、三个模块的文件地图

| # | 模块 | 目录 | 关键文件 | 线上 | 部署 |
|---|---|---|---|---|---|
| ① | 策略引擎 | `astock-recs-bot/`（仓库根） | `engine.js` `generate.js` `review.js` `today.js` `test/` `scripts/提交产物.sh` `.github/workflows/` | 产物进仓库 | GitHub Actions cron |
| ② | 看板 | `site/` | `index.html`(720KB) `sw.js` `自检.sh` `运维手册.md` `functions/api/*.js`(7 个) `_headers` `manifest-board.json` `icon-*.png` | `astock-board-9t0.pages.dev` | `wrangler pages deploy` |
| ③ | 网格回测 | `grid/` | `index.html`(132KB) `manifest-grid.json` `sw.js` `CNAME` `icon-*.png` | `astock-grid.surge.sh` | surge |

依赖关系：② 的数据全部来自 ①；③ 与另两个完全独立。

## 四、三个协作文件

| 文件 | 给谁看 | 谁更新 | 更新时机 |
|---|---|---|---|
| `collab-entry.md` | **豆包**（外部 AI 入口） | WorkBuddy | 每次改动影响结构/状态时，更新第三节「当前状态」 |
| `collab-rules.md` | 四端全体（本文件） | WorkBuddy | 协作机制变更时 |
| `collab-log.md` | 四端全体（台账） | WorkBuddy | 每次改动后追加一行 |

**豆包每次被唤醒时的固定动作：先读 `collab-entry.md`，需要细节再读 `collab-log.md` 最后 10 条。**

## 五、WorkBuddy 每次改动的 8 步 SOP

### 1 · 拉取

```bash
git pull --rebase origin main
git log --oneline -5
```

### 2 · 读台账

`collab-log.md` 两处：顶部「当前占用」表 + 最后 10 条变更。

### 3 · 写占用（改文件之前，必须先 push）

```
| 手机端 | site/index.html | 2026-11-09 16:00 | 加「均涨」列 | 预计 30 分钟 |
```

### 4 · 改文件

只改声明范围内。要动别的文件，先更新声明。

### 5 · 自检

| 模块 | 命令 | 通过标准 |
|---|---|---|
| ② 看板 | `cd site && bash 自检.sh` | 30 项全过 |
| ① 引擎 | `node --check engine.js` / `node test/*.mjs` / `node test-stable.js` | 无报错，回归全过 |
| ③ 网格 | 浏览器打开点「重新拉取行情并计算」 | 表格出数，控制台无报错 |
| YAML | `python3 -c "import yaml;yaml.safe_load(open('x.yml'))"` | 解析通过 |

### 6 · 部署

```bash
# ② 看板
cd site && CLOUDFLARE_ACCOUNT_ID=bebe9230db6ff26dff3368b43387d521 \
  CLOUDFLARE_API_TOKEN=<本机环境变量> \
  npx wrangler pages deploy . --project-name=astock-board --branch=main

# ③ 网格
cd grid && surge . astock-grid.surge.sh
```

### 7 · 提交推送

```bash
git add -A && git commit -m "feat(site): 逐日明细加均涨列" && git push origin main
```

类型：`feat` / `fix` / `style` / `refactor` / `revert` / `chore`；范围：`(site)` `(grid)` `(engine)` `(review)` `(ci)`。

### 8 · 回填台账

删占用行 + 追加变更记录（含 commit sha、线上版本、自检结果）+ 若结构有变则同步更新 `collab-entry.md` 第三节。

**没回填 = 对方和豆包永远不知道你改了什么。**

## 六、豆包的接入方式（四步）

### 步骤 1 · 给豆包装上 MCP 服务器

在豆包 / 扣子的「MCP 服务器」入口新增一条：

| 项 | 值 |
|---|---|
| 类型 | HTTP（Streamable HTTP） |
| URL | `https://astock-mcp.pages.dev/mcp` |
| Header | `Authorization: Bearer <MCP_TOKEN>` |

口令单独发给用户，**不写进对话以外的任何文件**。装好后豆包就能直接 `read_file` / `write_file` / `delete_file`，不再依赖 raw 链接。

### 步骤 2 · 每次新对话先发这段

```
你是 astock 项目的协作者，对这个仓库有读、写、删权限。
先调 status 看仓库现状，再调 read_file 读 collab-entry.md 与 collab-log.md 最后 10 条，然后回答我。

规则：
1. 改文件前必须先 read_file，禁止凭记忆覆盖。
2. 不能改 .github/workflows/**，不能碰 5 个运行产物 JSON，不能删 collab-*.md。
3. 改完调 append_log 记台账，device 填「手机豆包」或「电脑豆包」。
4. 需要部署时告诉我去找 WorkBuddy，不要声称已上线。
5. 建议按 collab-entry.md 第七节的五段格式：结论 / 依据 / 改动 / 风险 / 下一步。
```

### 步骤 3 · 豆包改完，WorkBuddy 接手

豆包写完文件后，用户在 WorkBuddy 里说：

```
豆包刚改了 <文件>，commit <sha>。你 pull 一下，跑自检，确认没问题再部署。
```

WorkBuddy 负责：`git pull` → 自检 → 部署 → 回填台账的「线上版本」列。豆包负责代码，WorkBuddy 负责上线，职责不重叠。

### 步骤 4 · 闭环反馈

改完在 `collab-log.md` 把对应待办标「已完成 commit xxx」。
下次任一端读台账就知道这条已经落地，不会重复改。

## 七、冲突高发点

| # | 位置 | 风险 | 规程 |
|---|---|---|---|
| 1 | `site/sw.js` + `site/index.html` 的 `sw.js?v=N` | 两端各 +1 造成版本回退，用户拿旧缓存 | 只 +1，push 前必 pull，看到对方已 +1 就取更大值；两处必须一致 |
| 2 | `site/自检.sh` 的 `EXPECT_MD5` | 改了 index.html 忘更新基线 → 自检报警 | 跑自检拿当前 md5 回填 |
| 3 | `site/index.html`（720KB 单文件） | 两端同时改必冲突，无法行级合并 | 靠占用锁。真冲突后到者放弃自己版本，基于对方重做 |
| 4 | `*.json` 运行产物 | 手改污染数据 | 永不手改，只由 Actions 生成 |
| 5 | `.github/workflows/**` | 令牌只有 `repo` 时 GitHub 回 **404 而非 403** | 原则不改；要改先确认有 `workflow` 权限 |
| 6 | 中文文件名 | 豆包读 raw 链接需 URL 编码，易失败 | **仓库新文件一律 ASCII 命名**，中文标题写进文件内容。已有 `scripts/提交产物.sh` 例外，不动它 |

## 八、红线

1. 令牌、Key 永不入库。入库前扫：`grep -rE "cfut_[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}" site/ grid/`
2. 不手改 `recs.json` / `today.json` / `watch.json` / `review_log.json` / `params.json`
3. `sw.js` 版本号与 `index.html` 的 `?v=` 必须同步
4. 部署凭据只在本机环境变量
5. 两端不得同时改同一文件
6. 改完必须回填台账
7. 不许删「当日定稿冻结」（generate.js）与「今日定稿闸门」（daily.yml）—— 这是防止同一天出两个版本荐股的最后防线

## 九、初始化状态（2026-11-09 16:05 已完成）

| # | 事项 | 状态 |
|---|---|---|
| 1 | `site/` 入库 | ✔ 23 个文件，928KB |
| 2 | `grid/` 入库 | ✔ 7 个文件，168KB |
| 3 | 三份 collab 文档入库 | ✔ 仓库根 |
| 4 | `site/运维手册.md` 脱敏 | ✔ 无明文令牌（扫描 `cfut_` / `ghp_` / `github_pat_` 零命中） |
| 5 | MCP 服务器上线 | ✔ `astock-mcp.pages.dev`，8 个工具，写删已实测 |

新设备接入只需两步：`git clone https://github.com/dqlvxy/astock-recs-bot`，然后读 `collab-entry.md`。

## 十、验收

| # | 验收项 | 通过标准 |
|---|---|---|
| 1 | 仓库有 `site/index.html`、`grid/index.html` | 大小 719645 / 131772 字节 |
| 2 | 两端 HEAD 相同 | `git rev-parse HEAD` 一致 |
| 3 | 台账可双向读写 | 一端 push，另一端 pull 后可见 |
| 4 | 占用锁生效 | 一端写占用，另一端 pull 后停止改动 |
| 5 | 无令牌泄露 | `grep -rE "cfut_\|ghp_" site/ grid/` 无结果 |
| 6 | 豆包能读能写 | 豆包装上 MCP 后，`status` 返回 HEAD，`write_file` 能建测试文件并 `delete_file` 删掉 |
| 7 | 部署可独立执行 | 两端各自按第六步命令能成功部署 |

---

**规程变更本身也要记台账。**
