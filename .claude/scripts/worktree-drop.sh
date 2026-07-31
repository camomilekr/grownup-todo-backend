#!/usr/bin/env bash
#
# 워크트리와 브랜치를 정리한다. 규약은 `.claude/rules/core.md`.
#
#   .claude/scripts/worktree-drop.sh <이름> [--drop-docs]
#
# 계획서와 개발 루프 기록(docs/plan, docs/dev-loop)은 커밋하지 않으므로 추적되지 않는
# 파일이고, worktree remove가 그것을 함께 지운다.
# 그래서 기본값은 저장소 루트로 꺼내는 것이고, 버리려면 --drop-docs를 준다.
set -euo pipefail

NAME=${1:?"사용법: worktree-drop.sh <이름> [--drop-docs]"}
KEEP_DOCS=1
[ "${2:-}" = "--drop-docs" ] && KEEP_DOCS=0

REPO=$(git rev-parse --show-toplevel)
WT="$REPO/.claude/worktrees/$NAME"
BRANCH="feature/$NAME"

[ -d "$WT" ] || { echo "그런 워크트리가 없다: $WT" >&2; exit 1; }

# 워크트리 안에 있는 채로는 지울 수 없다.
case "$PWD/" in "$WT/"*) echo "워크트리 안이다. 저장소 루트로 나온 뒤 실행해라." >&2; exit 1 ;; esac

if [ "$KEEP_DOCS" = 1 ] && [ -d "$WT/docs" ]; then
  mkdir -p "$REPO/docs"
  cp -R "$WT/docs/." "$REPO/docs/"
  echo "docs/를 $REPO/docs/로 꺼냈다"
fi

# 추적되지 않는 파일 수만 개를 두고 worktree remove를 부르면 느리거나 거부한다.
# 그리고 이 rm은 거의 항상 한 번 실패한다 — macOS가 rm이 도는 동안 .DS_Store를 다시 써서
# 마지막 rmdir만 ENOTEMPTY로 끝난다. 내용은 이미 지워졌으므로 한 번 더 부르면 된다.
if [ -d "$WT/node_modules" ]; then
  rm -rf "$WT/node_modules" 2>/dev/null || rm -rf "$WT/node_modules" 2>/dev/null || true
fi

git -C "$REPO" worktree remove "$WT"

# -d는 병합 여부를 확인하며 지운다. 병합되지 않았으면 거부하는 것이 맞다.
if git -C "$REPO" branch -d "$BRANCH" 2>/dev/null; then
  echo "브랜치 삭제: $BRANCH"
else
  echo "브랜치 $BRANCH 는 아직 병합되지 않았다. 남겨 둔다."
fi

git -C "$REPO" fetch --prune --quiet 2>/dev/null || true
echo "정리 완료: $NAME"
