#!/usr/bin/env bash
#
# 워크트리 하나를 규약대로 준비한다. 규약은 `.claude/rules/workflow.md`.
#
#   .claude/scripts/worktree-new.sh <이름> [base 브랜치]
#
# 하는 일: 브랜치·워크트리 생성 → node_modules 복제 → 계획서 복사 → 점유 표식 기록.
# 이 넷을 손으로 하면 하나를 빠뜨리고, 빠뜨리는 것은 대개 점유 표식이다.
set -euo pipefail

NAME=${1:?"사용법: worktree-new.sh <이름> [base 브랜치]"}
BASE=${2:-develop}

REPO=$(git rev-parse --show-toplevel)
WT="$REPO/.claude/worktrees/$NAME"
BRANCH="feature/$NAME"

# git ref는 파일시스템 기반이라 같은 이름이 파일이면서 디렉터리일 수 없다.
# feature/foo가 있으면 feature/foo/bar를 만들 수 없다 — 트랙은 하이픈으로 잇는다.
case "$NAME" in
  */*) echo "이름에 슬래시를 쓸 수 없다. 하이픈으로 이어라: ${NAME//\//-}" >&2; exit 1 ;;
esac

if [ -e "$WT" ]; then
  echo "이미 있다: $WT" >&2
  echo "다른 잡이 쓰고 있을 수 있다. docs/dev-loop/의 점유 표식을 먼저 확인해라." >&2
  exit 1
fi

git -C "$REPO" worktree add -b "$BRANCH" "$WT" "$BASE"

# node_modules는 npm install(수 분) 대신 APFS clonefile로 복제한다.
# copy-on-write라 12초에 끝나고 디스크는 사실상 늘지 않는다.
# 복제 시간은 크기가 아니라 파일 개수로 결정된다 — 592MB와 5.7GB가 둘 다 12초였다.
if [ -d "$REPO/node_modules" ] && cp -Rc "$REPO/node_modules" "$WT/node_modules" 2>/dev/null; then
  echo "node_modules 복제 완료 (clonefile)"
else
  # APFS가 아니면 -c가 실패한다. 패키지를 추가하는 작업이면 복제 뒤에도 한 번 더 돌려야 한다.
  echo "clonefile 복제가 안 된다. npm install로 되돌린다."
  (cd "$WT" && npm install)
fi

# husky 훅은 `.husky/_` 아래에 살고 그것은 추적되지 않는다 — `prepare`가 만든다.
# clonefile 복제는 npm install을 건너뛰므로 워크트리에 `.husky/_`가 없고,
# git은 core.hooksPath가 없는 디렉터리를 가리키면 **경고 없이** 훅을 건너뛴다.
# 그러면 티어 2 작업의 커밋만 verify를 통과하지 않고 들어간다 — 무거운 작업일수록
# 검증이 없는 곳에서 커밋하게 되므로 여기서 반드시 세운다.
(cd "$WT" && npm run prepare >/dev/null 2>&1)
[ -d "$WT/.husky/_" ] && echo "pre-commit 훅 설치 완료" || echo "경고: 훅 설치 실패. 워크트리에서 커밋은 verify를 거치지 않는다" >&2

mkdir -p "$WT/docs/plan" "$WT/docs/dev-loop"

# 계획서와 개발 루프 기록은 커밋하지 않으므로 추적되지 않는 파일이고, 그래서 새 워크트리에
# 딸려오지 않는다(git은 커밋된 것만 가져간다). 이름이 맞는 계획서가 있으면 복사해 온다.
cp "$REPO"/docs/plan/*"$NAME".md "$WT/docs/plan/" 2>/dev/null && echo "계획서를 가져왔다" || true

# 점유 표식 — 워크트리를 만든 그 자리에서 남긴다.
# 깨끗한 워크트리는 주인이 없다는 증거가 아니다. 생성부터 첫 쓰기까지 13분이 빈 사고가 있었다
# (git-workflow 플러그인 `ref/incidents.md`). 이 파일이 주인이 있다는 유일한 표식이다.
JOB=$(ls -t "$HOME/.claude/jobs" 2>/dev/null | head -1 || true)
REC="$WT/docs/dev-loop/$(date '+%Y-%m-%d')-$NAME.md"

if [ ! -f "$REC" ]; then
  cat > "$REC" <<EOF
# $NAME

- **브랜치**: \`$BRANCH\` (base: \`$BASE\`)
- **소유 잡**: \`${JOB:-불명}\` (스크립트 추정값 — 정확한 잡 ID를 알면 고쳐 넣어라)
- **점유 시각**: $(date '+%Y-%m-%d %H:%M:%S')
- **결과**: 진행 중

## 목표

(사용자가 요청한 것 그대로)
EOF
fi

echo
echo "워크트리: $WT"
echo "기록:     $REC"
echo "브랜치:   $BRANCH  (base: $BASE)"
