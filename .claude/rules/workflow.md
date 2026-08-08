# 워크플로우 — 이 저장소의 구체화

개발 루프(티어 판정, `architect`→`developer`↔`reviewer` 파이프라인, 계획·검토·커밋·PR 규칙)는 **git-workflow 플러그인**이 제공하고 세션 시작 시 주입된다. 이 문서는 그 규칙을 **이 저장소에 맞게 구체화한 것만** 담는다 — 플러그인과 겹치는 내용은 여기에 두지 않는다.

## Jira 없이 진행한다

이 저장소에는 연결된 Jira 프로젝트가 없다. **티켓 없이 진행이 기본값**이고, Jira 조회·요약 게이트의 티켓 부분·상태 전환은 전부 스킵한다. 계획서·기록 파일명의 `{JIRA-KEY}` 자리에는 **브랜치 이름에서 `feature/`를 뗀 부분**을 쓴다.

## 브랜치

- **기준 브랜치는 `develop`이다.** 브랜치는 `feature/{케밥케이스}`, PR도 `develop`으로 보낸다
- 커밋 전 `npm run verify`·`npm test`·`npm run test:e2e` — 세 명령의 역할 분담은 `AGENTS.md`에 있다

## 워크트리는 스크립트로 만든다 (티어 2)

```bash
.claude/scripts/worktree-new.sh <이름> [base 브랜치]   # 기본 base: develop
.claude/scripts/worktree-drop.sh <이름>                # PR 머지 뒤. docs/를 루트로 꺼낸 다음 정리한다
```

`worktree-new.sh`가 브랜치·워크트리 생성, `node_modules` 복제(APFS clonefile), husky 훅 설치, 계획서 복사, 점유 표식 기록을 한 번에 한다. 손으로 하면 하나를 빠뜨리고, 빠뜨리는 것은 대개 점유 표식이다.

- 워크트리 위치는 `.claude/worktrees/`다. **점(`.`)으로 시작하는 경로라서 lint·타입 검사가 기본 탐색에서 건너뛰어 루트의 verify와 충돌하지 않는다** — 근거 실측은 `.claude/ref/troubleshooting.md`
- **`Agent` 도구의 `isolation: "worktree"`를 쓰지 않는다.** 이 규약 밖의 경로에 워크트리를 만들어 스크립트가 세워 주는 것(복제·훅·표식·계획서)과 점 디렉터리 격리를 둘 다 잃는다
- **IDE로 워크트리 코드를 편집할 때는 별도 창으로 연다.** 루트 창에서는 워크트리 파일이 어느 프로젝트에도 속하지 않아 jest 전역(`describe`·`it`)을 모르는 이름으로 표시한다. 루트 `tsconfig.json`에 워크트리를 포함시키는 우회는 금지 — 루트 verify에서 같은 클래스가 두 번 선언된 것으로 보인다

## 지문은 스크립트로 찍는다

```bash
.claude/scripts/fingerprint.sh <워크트리 경로>    # 경로 인자를 빼먹지 마라
```

플러그인의 수동 지문 명령(`git add -N . && git diff | shasum`) 대신 이 스크립트를 쓴다 — `git add -N`을 품고 있고, 경로 인자를 받아 셸 위치가 루트로 되돌아간 상태에서 잘못 찍히는 것을 막는다.

## 참조 문서 분담

일반 함정은 플러그인 `ref/`에, 이 저장소 고유 함정은 `.claude/ref/`에 있다. 같은 주제가 양쪽에 있으면 **플러그인이 일반 원리, 이쪽이 저장소 구체화**다.

| 상황 | 먼저 읽는 것 | 이 저장소 고유 |
|---|---|---|
| 명령 실패·증상 원인 불명 | 플러그인 `ref/troubleshooting.md` | `.claude/ref/troubleshooting.md` (스크립트·lint·husky) |
| 테스트가 예상과 다름 | 플러그인 `ref/testing-traps.md` | `.claude/ref/testing-traps.md` (BigInt·`@db.Date`·Supabase) |
| 병렬 트랙 | 플러그인 `ref/parallel.md` | 워크트리 생성만 위 스크립트로 대체 |
| 규약의 근거 | 플러그인 `ref/incidents.md` (이 저장소의 사고 기록이 원본이다) | — |
