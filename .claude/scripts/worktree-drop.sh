#!/usr/bin/env bash
#
# 워크트리와 브랜치를 정리한다. 규약은 `.claude/rules/workflow.md`.
#
#   .claude/scripts/worktree-drop.sh <이름> [--drop-docs]
#
# 계획서와 개발 루프 기록(docs/plan, docs/dev-loop)은 커밋하지 않으므로 워크트리에
# 커밋되지 않은 파일로 남고, 그것이 남아 있으면 worktree remove가 --force 없이는 거부한다.
# 그래서 기본값은 저장소 루트로 꺼낸 뒤 원본을 치우는 것이고, 버리려면 --drop-docs를 준다.
# 그 둘 밖에 커밋되지 않은 것이 있으면, 또는 꺼내기가 루트의 다른 내용을 덮어쓰게 되면
# 아무것도 지우지 않고 멈춘다 — 지운 것은 되돌릴 수 없으므로 판단은 사람이 한다.
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

# 꺼내거나 버릴 대상은 docs/plan·docs/dev-loop 아래에서 **HEAD에 아직 없는** 파일뿐이다.
# 규약이 "커밋하지 않는다"고 정한 곳이 이 두 폴더뿐이고(`.claude/rules/workflow.md`),
# docs/의 나머지(`docs/todo-schema.md` 등)는 커밋 대상 문서다 — 그쪽에 커밋되지 않은 새 문서가
# 있다면 정리할 것이 아니라 커밋을 빠뜨린 것이므로 아래 검사에서 멈춰 사람이 판단하게 한다.
#
# 두 갈래로 나눠 묻는 이유는 fingerprint.sh가 지문을 찍을 때 `git add -N`(intent-to-add)로
# 그 파일들을 인덱스에 등록해 두기 때문이다 — 그 상태가 되면 `ls-files --others`에 더 이상
# 잡히지 않고(실측: git 2.50), status에는 `A`로 나타난다. 지문을 한 번이라도 찍은 워크트리가
# 정상 흐름이므로 한 갈래만 물으면 그쪽에서 멈춘다.
#
# pathspec 두 개로 갈라져야 하므로 아래 확장은 일부러 인용하지 않는다.
DOC_DIRS="docs/plan docs/dev-loop"
docs_pending() {
  # 순수하게 추적되지 않는 파일
  git -C "$WT" ls-files --others --exclude-standard -z -- $DOC_DIRS
  # 인덱스에는 있으나 HEAD에는 없는 파일 (intent-to-add가 여기 잡힌다)
  git -C "$WT" diff --name-only --diff-filter=A -z HEAD -- $DOC_DIRS
}

# 그 밖에 커밋되지 않은 것이 있으면 아무것도 건드리지 않고 멈춘다.
# --force로 밀어 버리면 사용자가 아직 쓰고 있던 작업이 조용히 사라지고, 그것은
# 되돌릴 수 없다. worktree remove가 무엇 때문에 거부하는지를 사람이 보고 판단하게 한다.
# 이 검사를 node_modules 삭제보다 앞에 두는 이유는 부작용을 0으로 두기 위해서다 —
# 멈춘 뒤 파일을 정리하고 다시 실행하면 처음부터 그대로 진행된다.
BLOCKERS=$(
  # 계획서·기록 폴더 밖에 남은 것은 종류를 가리지 않고 전부 — 추적 파일 수정이든 새 파일이든
  git -C "$WT" -c core.quotePath=false status --porcelain -- ':(exclude)docs/plan' ':(exclude)docs/dev-loop'
  # 그 두 폴더 안에서는 이미 커밋된 문서를 고치거나 지운 것만 문제다. 새 문서는 아래에서 꺼낸다
  git -C "$WT" -c core.quotePath=false diff --name-status --diff-filter=MDRTUX HEAD -- $DOC_DIRS
)

if [ -n "$BLOCKERS" ]; then
  # .gitignore가 무시하는 파일(워크트리의 .env 등)은 이 검사에 오르지 않는다 — 루트 사본이라
  # 워크트리와 함께 사라지는 것이 의도된 결과다. 문구가 그보다 넓게 읽히지 않도록 밝혀 둔다.
  echo "워크트리에 예상 밖의 변경이 남아 있다(무시되는 파일은 검사하지 않는다)." >&2
  echo "아무것도 지우지 않고 멈춘다:" >&2
  printf '%s\n' "$BLOCKERS" | sed 's/^/  /' >&2
  echo "내용을 확인해 옮기거나 지운 뒤 다시 실행해라. 전부 버려도 된다면:" >&2
  echo "  git -C \"$REPO\" worktree remove --force \"$WT\"" >&2
  exit 1
fi

# 꺼내기는 곧 덮어쓰기다. 목적지에 같은 경로의 문서가 이미 있고 내용이 다르면 그 내용은
# 어디에도 남지 않는다. worktree-new.sh가 루트의 계획서를 새 워크트리로 복사하므로
# (같은 경로가 양쪽에 있는 것이 정상이다) 그 뒤 루트 쪽을 고친 상태가 실제로 생긴다.
# 아래 복사 뒤의 cmp는 이 손실을 잡지 못한다 — 방금 덮어쓴 목적지와 비교하니 항상 일치한다.
# 그래서 복사 전에 따로 묻고, 하나라도 걸리면 아무것도 하지 않고 멈춘다.
if [ "$KEEP_DOCS" = 1 ]; then
  CLASHES=""
  while IFS= read -r -d '' REL; do
    [ -f "$WT/$REL" ] || continue
    if [ -e "$REPO/$REL" ] && ! cmp -s "$WT/$REL" "$REPO/$REL"; then
      CLASHES="$CLASHES  $REL"$'\n'
    fi
  done < <(docs_pending)

  if [ -n "$CLASHES" ]; then
    echo "저장소 루트에 같은 경로의 문서가 있고 내용이 다르다. 꺼내면 루트 쪽 내용이" >&2
    echo "어디에도 남지 않으므로 아무것도 하지 않고 멈춘다:" >&2
    printf '%s' "$CLASHES" >&2
    echo "루트 쪽을 확인해 합치거나 옮긴 뒤 다시 실행해라." >&2
    echo "워크트리 쪽 사본을 버려도 된다면:" >&2
    echo "  .claude/scripts/worktree-drop.sh $NAME --drop-docs" >&2
    exit 1
  fi
fi

# docs/plan·docs/dev-loop에는 커밋된 문서도 함께 살 수 있어(이 저장소에 그런 브랜치가 있다)
# 폴더를 통째로 다루면 두 가지가 어긋난다 — 통째로 복사하면 그 브랜치의 문서 수정본이 저장소
# 루트의 문서를 덮어쓰고, 통째로 지우면 추적 파일을 지운 것이 되어 remove가 다시 거부한다.
# 그래서 파일 하나씩 다룬다.
DOCS_DONE=0
DOCS_LIST=""
while IFS= read -r -d '' REL; do
  # 인덱스에만 남고 작업 트리에서는 이미 사라진 항목이 섞일 수 있어 존재를 확인한다
  [ -f "$WT/$REL" ] || continue
  if [ "$KEEP_DOCS" = 1 ]; then
    mkdir -p "$REPO/$(dirname "$REL")"
    cp -p "$WT/$REL" "$REPO/$REL"
    # 복사가 부분 실패한 채로 원본을 지우면 문서가 사라진다. 내용이 같은 것을
    # 확인한 뒤에만 지운다 — 확인이 안 되면 원본을 남기고 멈추는 쪽이 안전하다.
    if ! cmp -s "$WT/$REL" "$REPO/$REL"; then
      echo "복사를 확인할 수 없다: $REL — 원본을 남기고 멈춘다." >&2
      exit 1
    fi
  fi
  # 남겨 두면 커밋되지 않은 파일 때문에 remove가 거부한다. 그래서 --force 없이
  # 지울 수 있도록 원본을 치운다. --drop-docs는 복사 없이 이 삭제만 한다.
  rm -f "$WT/$REL"
  DOCS_DONE=$((DOCS_DONE + 1))
  DOCS_LIST="$DOCS_LIST  $REL"$'\n'
done < <(docs_pending)

# intent-to-add로 등록된 항목은 파일을 지워도 인덱스에 남아 `D`(삭제)로 보이고,
# 그 상태에서도 remove는 거부한다(실측: 문서를 꺼낸 뒤에도 fatal로 끝났다).
# docs/ 인덱스를 HEAD로 되돌려 떼어 낸다 — 커밋되지 않은 문서 수정은 위 검사에서
# 이미 걸러졌으므로 여기서 잃는 것이 없고, 인덱스는 이 워크트리 전용이라
# (`.git/worktrees/<이름>/index`) 저장소 루트의 인덱스에는 영향이 없다.
# 꺼낸 파일이 하나도 없어도 돌려야 하므로 아래 조건 밖에 둔다 — 인덱스에만 남고 작업
# 트리에서는 이미 사라진 항목은 위 루프가 건너뛰는데(`[ -f ... ] || continue`),
# 그런 항목만 있는 워크트리에서 이 줄을 건너뛰면 remove가 안내 없이 fatal로 끝난다.
git -C "$WT" reset -q -- docs

if [ "$DOCS_DONE" -gt 0 ]; then
  # 되돌릴 수 없는 이동·삭제이므로 개수만이 아니라 경로를 남긴다 — 무엇이 사라졌는지
  # 사후에 확인할 방법이 이 출력뿐이다.
  if [ "$KEEP_DOCS" = 1 ]; then
    echo "커밋되지 않은 문서 ${DOCS_DONE}개를 $REPO/docs/로 꺼냈다:"
  else
    echo "커밋되지 않은 문서 ${DOCS_DONE}개를 버렸다 (--drop-docs):"
  fi
  printf '%s' "$DOCS_LIST"
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
