#!/usr/bin/env bash
#
# 검토 대상을 고정하는 지문. 리뷰 시작 전과 커밋 직전에 찍어 대조한다.
#
#   .claude/scripts/fingerprint.sh [워크트리 경로]
#
# `git diff | shasum`만 찍으면 **추적되지 않는 파일이 빠진다.** 신규 테스트 파일 232줄이
# 지문에 들어가지 않아 "고정한 줄 알았던 것이 고정되지 않은" 사례가 있었다
# (git-workflow 플러그인 `ref/incidents.md`). git add -N으로 경로만 인덱스에 등록하면 git diff가 그
# 파일을 신규로 취급해 전체 내용을 포함한다. 내용은 스테이징되지 않으므로 나중에 경로를
# 지정해 의미 단위로 나눠 커밋하는 데 지장이 없다.
set -euo pipefail

cd "${1:-.}"
git rev-parse --is-inside-work-tree >/dev/null

# ---------------------------------------------------------------------------
# 진행 중인 작업이 있으면 지문을 찍지 않고 멈춘다
# ---------------------------------------------------------------------------
#
# 아래 `git add -N .`이 **충돌 단계가 남은 인덱스를 무너뜨린다.** 병합 충돌을
# 편집기로 해소하고 아직 `git add`하지 않은 상태(구현자에게 `git add`를 금지하는
# 이 저장소 규약에서 정상인 상태)에서 이 스크립트를 돌리면, 충돌 파일이
# **삭제로 스테이징된다**(`git status`의 `DA`). 그 상태로 커밋하면 그 파일들이
# 지워진다 — 2026-08-17에 `src/main.ts`·`package.json` 등 4개 파일에서 실제로
# 일어났고, 임시 저장소에서 재현했다.
#
# 판정은 두 갈래다. 진짜 위험한 것은 **인덱스에 남은 충돌 단계**이고(그것이
# `git add -N .`에 무너지는 대상이다), 진행 표식은 그 앞뒤 국면을 함께 잡는다 —
# 충돌 없이 `--no-commit`으로 멈춘 병합처럼 파괴적이지는 않아도, 그 상태의
# 지문은 "평상시 작업 트리"가 아니라 비교 기준으로 쓸 수 없다.
#
# 리베이스·체리픽·되돌리기도 같이 막는다. 세 경우 모두 같은 방식으로 인덱스에
# 충돌 단계를 남기므로 병합만 막을 이유가 없다. 이등분 탐색(bisect)은 넣지
# 않았다 — 충돌 단계를 만들지 않고, 이 저장소의 개발 루프에 등장하지 않는다.
#
# **표식 경로를 `.git/`에 직접 조립하지 않는다.** 워크트리에서는 표식이 저장소
# 루트가 아니라 `.git/worktrees/<이름>/` 아래에 있어서, 직접 조립하면 워크트리에서
# 항상 "진행 중 아님"으로 판정된다 — 정작 이 스크립트가 쓰이는 자리가 워크트리다.
# `git rev-parse --git-path`가 그 차이를 알고 답해 준다.
#
# 감지한 것을 두 변수로 나눠 담는 이유는 **경고 문구가 갈라져야 하기** 때문이다.
# 위의 두 갈래는 위험의 종류가 다르다 — 충돌 단계가 있으면 파일이 지워질 수
# 있고, 표식만 남았으면 지워지지는 않는다. 한 문구로 합쳐 두면 표식만 남은
# 국면에서 일어나지 않는 파괴를 경고하게 되고, 사실이 아닌 경고는 다음번에
# 무시된다.
unmerged=""
markers=""

if [ -n "$(git ls-files --unmerged)" ]; then
  unmerged="  - 인덱스에 충돌 단계가 남아 있다 (git ls-files --unmerged)"$'\n'
fi

for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  marker_path="$(git rev-parse --git-path "$marker")"
  if [ -e "$marker_path" ]; then
    markers="${markers}  - ${marker} 가 있다 (${marker_path})"$'\n'
  fi
done

if [ -n "${unmerged}${markers}" ]; then
  {
    echo "지문을 찍지 않았다 — 진행 중인 작업이 있다:"
    printf '%s' "${unmerged}${markers}"
    echo
    if [ -n "$unmerged" ]; then
      echo "이 상태에서 지문을 찍으면 스크립트 안의 \`git add -N .\`이 충돌 파일의"
      echo "인덱스 단계를 무너뜨려 **파일이 삭제로 스테이징된다**(git status의 DA)."
      echo "그대로 커밋하면 그 파일들이 지워진다."
    else
      echo "인덱스에 충돌 단계가 없으므로 **파일이 지워질 위험은 없다.** 그래도 멈추는"
      echo "이유는 이 작업 트리가 진행 중인 작업의 중간이라서다 — 지문은 라운드 사이에"
      echo "무엇이 바뀌었는지 대조하는 값이고, 중간 상태는 그 기준이 될 수 없다."
    fi
    echo
    # 처방은 두 국면에 공통이다. 첫 줄이 핵심이다 — `git add`까지만 하면 표식이
    # 그대로 남아 같은 경고가 반복된다(실측). 통과 조건은 커밋이나 취소다.
    echo "진행 중인 작업을 **끝까지** 마쳐야 통과한다. \`git add\`까지만 하면 표식이"
    echo "남아 이 경고가 그대로 반복된다."
    echo "  - 마치려면: 남은 충돌을 해소하고 \`git add <경로>\`로 표시한 뒤 커밋한다"
    echo "  - 되돌리려면: \`git merge --abort\` (rebase·cherry-pick·revert도 같다)"
    echo "그 다음에 이 스크립트를 다시 돌린다."
  } >&2
  exit 1
fi

git add -N . >/dev/null
git diff HEAD | shasum | cut -c1-12
