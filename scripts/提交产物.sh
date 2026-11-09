#!/usr/bin/env bash
# scripts/提交产物.sh —— 把产物提交并推回 main（带重试 + 冲突兜底）
#
# 用法：
#   bash scripts/提交产物.sh review_log.json params.json review.md
#   bash scripts/提交产物.sh recs.json today.json watch.json
#
# 可用环境变量覆盖：
#   COMMIT_MSG    提交说明（默认带 UTC 时间）
#   RETRY_TIMES   重试轮数（默认 5）
#   RETRY_DELAY   每轮间隔秒数（默认 6）
#
# ⚠ 本脚本所有 shell 变量必须是 ASCII 名。bash 的标识符只认 [a-zA-Z_][a-zA-Z0-9_]，
#   写成 `文件列表=("$@")` 会被解析成命令并以 syntax error 退出（2026-11-09 实测踩到，
#   同一坑此前已在 workflow 注释里记过：中文变量名 = 命令未找到 / 语法错误）。
#
# ── 为什么单独抽成脚本（2026-11-09）──────────────────────────────
# 1. 原来两个 workflow 各自内联了同一段推送逻辑，改一处必须同步改两处，容易漏。
# 2. 改 `.github/workflows/**` 需要 PAT 具备 workflow scope，缺了 GitHub 故意返回
#    404 而不是 403（防止探测），排查成本高。抽出脚本后，调整推送策略只改这里，
#    不再触碰 workflow 文件。
#
# ── 修的是什么问题 ─────────────────────────────────────────────
# 原逻辑：
#     git pull --rebase --autostash origin main || true
#     git push origin main
# 坑：pull 失败被 `|| true` 吞掉，紧接着 push 必然 non-fast-forward 被拒，
#     整步以 bash -e 退出 → 当次产物进不了仓库（artifact 里有，但看板当天不更新，
#     而且日志只显示 "failed to push some refs"，看不出根因）。
# 现在：每轮先 fetch + rebase，rebase 冲突就 abort 后重试，push 被拒也重试，
#     最多 5 轮；全失败则打印 ::error:: 注解（Actions 会标红）并 exit 1，
#     绝不静默吞掉。
#
# 实测（2026-11-09）：
#   · 远端被别的任务抢先提交 → 第 1 轮 rebase + push 即成功，历史保持线性
#   · 两边改同一文件同一行（真冲突）→ 5 轮均 abort 干净、工作区 0 残留、最终显式报错

set -uo pipefail

MSG="${COMMIT_MSG:-chore: 更新产物 $(date -u +'%Y-%m-%d %H:%M UTC')}"
RETRY_TIMES="${RETRY_TIMES:-5}"
RETRY_DELAY="${RETRY_DELAY:-6}"
FILES=("$@")

# 启动横幅：Actions 日志里一眼可辨「脚本确实被调用」。
# 靠这行区分新旧 workflow —— 旧版内联逻辑不会打印它。
echo "== 提交产物.sh 启动（待提交：${FILES[*]:-无}）=="

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::error::未指定要提交的文件（用法：bash scripts/提交产物.sh 文件1 文件2 ...）"
  exit 2
fi

git config user.name "astock-bot"
git config user.email "astock-bot@users.noreply.github.com"

HAS_FILE=0
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    git add "$f"
    HAS_FILE=1
  else
    echo "$f 不存在，跳过"
  fi
done

if [ "$HAS_FILE" = "0" ]; then
  echo "没有任何产物可提交"
  exit 0
fi

if git diff --cached --quiet; then
  echo "文件无变化，无需提交"
  exit 0
fi

if ! git commit -q -m "$MSG"; then
  echo "::error::git commit 失败（产物未入库）"
  exit 1
fi
echo "已提交 $(git rev-parse --short HEAD)：$MSG"

PUSH_OK=0
ROUND=1
while [ "$ROUND" -le "$RETRY_TIMES" ]; do
  # fetch 失败不致命：可能只是网络抖动，继续用已有的 origin/main 试一次
  git fetch origin main --quiet || true

  if ! git rebase origin/main --quiet; then
    git rebase --abort 2>/dev/null || true
    echo "第 ${ROUND} 轮 rebase 失败（远端有冲突改动），${RETRY_DELAY} 秒后重试"
    ROUND=$((ROUND + 1))
    sleep "$RETRY_DELAY"
    continue
  fi

  if git push origin main --quiet; then
    PUSH_OK=1
    echo "第 ${ROUND} 轮推送成功：$(git rev-parse --short HEAD)"
    break
  fi

  echo "第 ${ROUND} 轮 push 被拒（远端已更新），${RETRY_DELAY} 秒后重试"
  ROUND=$((ROUND + 1))
  sleep "$RETRY_DELAY"
done

if [ "$PUSH_OK" != "1" ]; then
  echo "::error::产物推送失败（已重试 ${RETRY_TIMES} 轮）——产物已上传 artifact，下次运行会重新生成，数据不会永久丢失"
  exit 1
fi

exit 0
