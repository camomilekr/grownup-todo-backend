# 참조 — 증상과 원인 (이 저장소 고유)

**일반적인 git·워크트리·훅 증상(브랜치 already checked out, ref 슬래시 충돌, `rm -rf node_modules`의 ENOTEMPTY, embedded git repository, ruleset bypass 경고, `git stash -k -u`와 `git add -N` 충돌)은 git-workflow 플러그인의 `ref/troubleshooting.md`에 있다.** 여기는 이 저장소의 스크립트·도구 설정에서만 걸리는 것을 모았다. 테스트 쪽은 `.claude/ref/testing-traps.md`.

## 워크트리 스크립트

| 증상 | 원인 |
|---|---|
| 워크트리에서 `npm test`가 모듈을 못 찾음 | 그 워크트리에 `node_modules`가 없다. `worktree-new.sh`를 썼다면 복제가 실패한 것이다 |
| `cp -Rc`가 실패한다 | APFS가 아니다. 스크립트가 `npm install`로 되돌아간다 |
| `git worktree remove`가 느리거나 거부한다 | `node_modules`를 먼저 지우지 않았다. `worktree-drop.sh`가 순서와 재시도를 지킨다 |

## 지문 스크립트 — 병합 도중에 돌리면 파일이 지워질 수 있었다

**증상**: 병합 충돌을 해소한 뒤(아직 `git add`하지 않은 상태에서) `fingerprint.sh`를 돌렸다. 지문은 정상으로 보이는 값을 뱉었는데, 그 뒤 `git status`에 `DA package.json` 같은 줄이 나타났다. `git diff --cached --name-status HEAD`가 그 파일들을 `D`(삭제)로 보고했다 — **그 상태로 커밋하면 `src/main.ts`·`package.json`을 포함한 파일들이 지워진다.** 2026-08-17에 실제로 이 상태까지 갔고(4개 파일), 커밋 전에 발견해 되돌렸다.

**원인**: 스크립트 안의 `git add -N .`이다. 추적되지 않는 파일을 지문에 포함시키려고 넣은 것인데, 인덱스에 **충돌 단계**(stage 1·2·3)가 남아 있는 파일에 걸리면 그 단계를 걷어내고 intent-to-add로 덮는다. 결과가 "인덱스에는 없고 작업 트리에만 있는 파일" = 삭제로 스테이징된 상태다.

이 저장소 규약이 구현자에게 `git add`를 금지하므로, **병합 충돌을 해소하고 `git add`하지 않은 상태가 정상**이다. 즉 규약을 지키면 이 함정에 정확히 걸린다.

**현재는 스크립트가 막는다.** 진행 중인 작업(`MERGE_HEAD`·`CHERRY_PICK_HEAD`·`REVERT_HEAD`·`rebase-merge`·`rebase-apply`)이나 인덱스에 남은 충돌 단계를 감지하면 지문을 찍지 않고 종료 코드 1로 멈춘다. **경고가 나오면 지문을 얻는 것이 목적이 아니다 — 병합을 먼저 끝내야 한다는 뜻이다.** 충돌을 해소하고 `git add <경로>`로 표시한 뒤 커밋하거나, `git merge --abort`로 되돌린 다음 다시 돌린다.

**표식을 직접 찾으려 하지 마라.** `test -f .git/MERGE_HEAD`는 **워크트리에서 항상 실패한다** — 워크트리의 표식은 `.git/worktrees/<이름>/` 아래에 있다(실측: 오케스트레이터가 이 방식으로 확인해 "병합 아님"이라는 답을 받았다). 정작 이 스크립트가 쓰이는 자리가 워크트리이므로, `git rev-parse --git-path MERGE_HEAD`처럼 git에게 경로를 물어야 한다.

**지문 값은 기준 커밋에 따라 달라진다.** 계산이 `git diff HEAD`라서, 작업 트리가 한 글자도 바뀌지 않아도 그 사이에 커밋이 하나 생기면 값이 바뀐다. 같은 트리를 두 기준에서 찍어 확인했다(`d8f9b12` → `022ac422455a`, `9140273` → `4410fb3b6a83`). **라운드 간 대조는 HEAD가 같은 동안에만 성립한다** — 병합 커밋이나 중간 커밋을 넣은 뒤에는 값을 다시 찍어 기준을 새로 잡아야 한다.

## 워크트리를 격리하는 것은 설정이 아니라 점 디렉터리다

**검사 도구 쪽에는 `.claude/worktrees/`를 제외하는 설정이 하나도 없다.** 확인한 결과다 — `.prettierignore`에는 `/src/generated`·`/dist`·`/coverage`만, `.eslintrc.js`의 `ignorePatterns`에는 `.eslintrc.js`·`src/generated/**`만, jest 설정(`package.json`)에는 `coveragePathIgnorePatterns: ["/generated/"]`뿐이다.

그런데도 충돌이 나지 않는다. **`.claude/`가 점으로 시작해서 도구들이 기본적으로 건너뛰기 때문이다.**

| 도구 | 왜 안 걸리는가 |
|---|---|
| TypeScript | `include` 기본값이 점 디렉터리를 매칭하지 않는다. 루트 tsconfig의 파일 목록에 워크트리 파일이 **0개**다 |
| ESLint | 점 디렉터리를 기본 무시한다 (`File ignored by default.`) |
| Prettier·jest | 글롭이 `{src,apps,libs,test}`, `rootDir`이 `src`라 애초에 `.claude/` 밖이다 |

그 격리의 대가(IDE 지원)와 루트 tsconfig 우회 금지는 `.claude/rules/workflow.md`에 있다.

git 쪽 방어선으로 **`.gitignore`에 `/.claude/worktrees/`가 들어 있다.** `docs/`는 `.gitignore`에 없다 — `docs/todo-schema.md`처럼 추적해야 하는 문서가 같은 폴더에 있어서다. 즉 계획서와 개발 루프 기록은 "무시되는" 것이 아니라 **커밋하지 않기로 한 것뿐**이고, `git add -A`를 쓰면 그대로 들어간다. 커밋할 파일을 경로로 지정해라.

## lint · 포맷

```bash
npm run lint          # ESLint (Prettier 규칙 포함) + 자동 수정(--fix)
npm run lint:check    # 고치지 않고 검사만. verify가 쓰는 것
npm run format        # Prettier 적용
npm run format:check  # 적용하지 않고 위반만 확인
```

- 포맷 위반은 대개 `npm run lint:check`에서 먼저 걸린다. `eslint-plugin-prettier`가 Prettier를 ESLint 규칙으로 돌리기 때문이다. **그래서 `verify`의 `format:check`는 대부분 중복이다 — 하지만 지우지 마라.** `/* eslint-disable */`이 붙은 파일에서는 `prettier/prettier` 규칙도 함께 꺼져서 `format:check`가 그 파일의 **유일한 포맷 방어선**이 된다
- **`plugin:prettier/recommended`는 `extends`의 마지막에 온다.** 충돌 규칙 해제를 담당하므로 뒤에 다른 설정이 오면 무력화된다
- **`.prettierignore`는 Prisma 생성물과 빌드 산출물만 담는다.** 마크다운이 대상에서 빠지는 것은 그 파일 때문이 아니라 `format`·`format:check`의 글롭이 `.ts`로 한정돼 있기 때문이다
- `.prettierrc`에는 `singleQuote`와 `trailingComma`만 있다. **`printWidth`는 기본값 80이다**
- **`format:check`의 글롭은 패턴 하나(`"{src,apps,libs,test}/**/*.ts"`)로 묶여 있다. 여러 패턴으로 쪼개지 마라.** Prettier 3은 **패턴 하나가 아무 파일에도 맞지 않으면 exit 2로 죽는다**(`No files matching the pattern were found`). `"src/**/*.ts" "test/**/*.ts"`처럼 쪼개 두면 `test/`가 없는 순간 verify 전체가 실패하고, 원인은 포맷과 아무 상관이 없어 찾기 어렵다. 중괄호 하나로 묶으면 `src/`만 있어도 통과한다
- **typecheck만 범위가 다르다.** `lint:check`·`format:check`는 `{src,apps,libs,test}`, `typecheck`는 `node_modules`·`dist`를 뺀 전부다. 루트에 둔 `.ts`는 typecheck만 걸린다
- Prettier는 **주석과 문자열을 재배치하지 않는다.** 긴 한국어 주석이 80자를 넘어도 그대로 남는다
- `npm run lint`는 error에서만 실패한다. **`lint:check`에는 `--max-warnings 0`이 붙어 더 엄격하다** — `lint`는 통과했는데 훅이 막는 상황이 여기서 나온다

## husky (pre-commit)

훅이 강제 수단이 아니라 편의 장치라는 일반 원리는 플러그인 `ref/troubleshooting.md`에 있다. 이 저장소의 구체화:

- **`prepare`가 `husky || true`인 이유는 프로덕션 설치다.** `npm ci --omit=dev`는 `prepare`를 실행하면서 `husky`(devDependency)를 설치하지 않아 `husky: command not found`로 exit 127이 되고, 설치 전체가 실패한다. `|| true`가 그것만 흡수한다. **부작용은 훅 설치 실패도 조용해진다는 것** — 훅이 걸렸는지는 `git config core.hooksPath`와 `.husky/_`의 존재로 확인해라. 워크트리는 `worktree-new.sh`가 `npm run prepare`를 돌려 세운다
- **훅은 `verify`만 돌린다.** `npm test`·`npm run test:e2e`는 훅이 돌려 주지 않는다 — 테스트를 깨뜨린 커밋을 막는 자동 관문은 이 저장소에 없고, 실제 강제는 CI의 몫인데 **아직 CI가 없다**
- 훅의 `verify`는 인덱스가 아니라 **프로젝트 전역(작업트리)을 본다.** 부분 스테이징 커밋에서 생기는 사각지대의 일반 원리는 플러그인 `rules/core.md`의 커밋 절에 있다. 스테이징된 내용만 꺼내 검사하려면 `lint-staged`가 필요한데 도입은 결정된 바 없다

규칙을 끄거나 낮출 때는 **반드시 이유를 주석으로 남긴다.** 전체를 끄기보다 파일 단위로 좁혀서 끈다. `.eslintrc.js`가 `*.spec.ts`에서 `@typescript-eslint/no-unsafe-assignment`를 끄고 `@typescript-eslint/no-explicit-any`를 전역에서 끈 것이 그 예다 — 끄거나 낮춘 자리마다 왜 그랬는지와 되돌릴 조건을 함께 남긴다.
