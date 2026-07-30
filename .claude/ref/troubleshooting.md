# 참조 — 증상과 원인

명령이 실패했거나 증상의 원인을 모를 때 읽는다. 테스트 쪽은 `.claude/ref/testing-traps.md`.

## git · 워크트리

| 증상 | 원인 |
|---|---|
| `fatal: '<브랜치>' is already checked out` | 다른 워크트리가 그 브랜치를 쓰고 있다. `git worktree list`로 찾는다 |
| `fatal: cannot lock ref 'refs/heads/feature/x/y'` | 트랙 브랜치에 슬래시를 썼다. 하이픈으로 잇는다(아래) |
| `git branch -d`가 거부 | 워크트리가 아직 그 브랜치를 붙잡고 있거나, 정말 병합되지 않았다 |
| 워크트리에서 `npm test`가 모듈을 못 찾음 | 그 워크트리에 `node_modules`가 없다. `worktree-new.sh`를 썼다면 복제가 실패한 것이다 |
| `cp -Rc`가 실패한다 | APFS가 아니다. `npm install`로 돌아간다 |
| `Haste module naming collision` | 워크트리를 `.claude/worktrees/` 밖에 만들었거나, 아래 네 곳의 제외 설정이 빠졌다 |
| 워크트리 디렉터리를 손으로 지웠다 | `git worktree prune`으로 남은 등록 정보를 정리한다 |
| `git worktree remove`가 느리거나 거부한다 | `node_modules`를 먼저 지우지 않았다. `worktree-drop.sh`가 순서를 지킨다 |
| `rm -rf .../node_modules`가 `Directory not empty` | 정상이다. 아래 참고 |
| 커밋 하나에 여러 관심사가 들어갔다 | `git add -A`를 썼다. 경로를 지정해 의미 단위로 나눈다 |

### 트랙 브랜치에 슬래시를 쓸 수 없다

`feature/step-goal-presets`가 있는데 `feature/step-goal-presets/store`를 만들 수 없다. **git ref는 파일시스템 기반이라 같은 이름이 파일이면서 디렉터리일 수 없다.**

```
fatal: cannot lock ref 'refs/heads/feature/foo/bar': 'refs/heads/feature/foo' exists;
cannot create 'refs/heads/feature/foo/bar'
```

반대 순서도 막힌다 — `feature/foo/bar`가 있으면 `feature/foo`를 만들 수 없다. 그래서 **하이픈으로 잇는다**: `feature/{작업}-{트랙}`. `worktree-new.sh`가 슬래시를 막는다.

### `node_modules`의 `rm -rf`는 거의 항상 한 번 실패한다

```
rm: .claude/worktrees/step-goal-presets/node_modules: Directory not empty
```

**정상이고, 내용은 이미 다 지워졌다.** macOS가 `rm`이 도는 동안 그 디렉터리에 `.DS_Store`를 다시 쓰고, `rm`은 내용을 비운 뒤 마지막에 `rmdir`을 시도하므로 그 틈에 생긴 파일 하나 때문에 `ENOTEMPTY`로 끝난다. 파일 44,471개를 지우는 동안 창이 넉넉히 열린다. 2026-07-27에 3번 시도해 3번 재현했고 이후에도 재현됐다.

한 번 더 부르면 성공하고, 무시하고 `git worktree remove`로 넘어가도 된다. `worktree-drop.sh`가 재시도를 품고 있다.

**`git worktree remove --force`로 넘어가지 마라.** 추적되지 않는 진짜 작업물(계획서, 개발 루프 기록)까지 함께 버린다.

## 워크트리 경로를 바꾸려면 네 곳을 함께 고쳐야 한다

`.claude/worktrees/`는 저장소 안이라 도구 설정이 받쳐 줘야 한다.

| 파일 | 설정 | 없으면 |
|---|---|---|
| `metro.config.js` | `resolver.blockList` | 같은 모듈이 두 벌로 보여 `Haste module naming collision`으로 Metro가 죽는다 |
| `jest.config.js` | `modulePathIgnorePatterns` | 워크트리의 테스트까지 함께 돌고 haste 충돌이 난다 |
| `eslint.config.js` | `ignores` | 워크트리 코드를 두 번 검사한다 |
| `.prettierignore` | 경로 추가 | 위와 같다 |

`.gitignore`에도 들어 있지만 **그건 별개다.** Metro와 watchman은 git이 아니라 파일 시스템을 보므로 gitignore만으로는 충돌을 막지 못한다. `metro.config.js`는 이 제외 하나 때문에 존재한다.

`docs/`는 git, Jest, ESLint, Prettier, Metro **다섯 곳**에서 빠져 있다. 경로를 바꾸려면 다섯 곳을 함께 고친다.

## lint · 포맷

```bash
npm run lint          # ESLint (Prettier 규칙 포함) + 자동 수정(--fix)
npm run lint:check    # 고치지 않고 검사만. verify가 쓰는 것
npm run format        # Prettier 적용
npm run format:check  # 적용하지 않고 위반만 확인
```

- 포맷 위반은 대개 `npm run lint:check`에서 먼저 걸린다. `eslint-plugin-prettier`가 Prettier를 ESLint 규칙으로 돌리기 때문이다. **그래서 `verify`의 `format:check`는 대부분 중복이다 — 하지만 지우지 마라.** `/* eslint-disable */`이 붙은 파일에서는 `prettier/prettier` 규칙도 함께 꺼져서 `format:check`가 그 파일의 **유일한 포맷 방어선**이 된다
- **`eslint-plugin-prettier/recommended`는 항상 마지막에 온다.** 충돌 규칙 해제를 담당하므로 뒤에 다른 설정이 오면 무력화된다
- **`.prettierignore`가 없다.** 마크다운이 대상에서 빠지는 것은 `format`·`format:check`의 글롭이 `.ts`로 한정돼 있기 때문이다
- `.prettierrc`에는 `singleQuote`와 `trailingComma`만 있다. **`printWidth`는 기본값 80이다**
- **`format:check`의 글롭은 패턴 하나(`"{src,apps,libs,test}/**/*.ts"`)로 묶여 있다. 여러 패턴으로 쪼개지 마라.** Prettier 3은 **패턴 하나가 아무 파일에도 맞지 않으면 exit 2로 죽는다**(`No files matching the pattern were found`). `"src/**/*.ts" "test/**/*.ts"`처럼 쪼개 두면 `test/`가 없는 순간 verify 전체가 실패하고, 원인은 포맷과 아무 상관이 없어 찾기 어렵다. 중괄호 하나로 묶으면 `src/`만 있어도 통과한다
- **typecheck만 범위가 다르다.** `lint:check`·`format:check`는 `{src,apps,libs,test}`, `typecheck`는 `node_modules`·`dist`를 뺀 전부다. 루트에 둔 `.ts`는 typecheck만 걸린다
- Prettier는 **주석과 문자열을 재배치하지 않는다.** 긴 한국어 주석이 80자를 넘어도 그대로 남는다
- `npm run lint`는 error에서만 실패한다. **`lint:check`에는 `--max-warnings 0`이 붙어 더 엄격하다** — `lint`는 통과했는데 훅이 막는 상황이 여기서 나온다

## husky

- **`prepare`가 `husky || true`인 이유는 프로덕션 설치다.** `npm ci --omit=dev`는 `prepare`를 실행하면서 `husky`(devDependency)를 설치하지 않아 `husky: command not found`로 exit 127이 되고, 설치 전체가 실패한다. `|| true`가 그것만 흡수한다. **부작용은 훅 설치 실패도 조용해진다는 것** — 훅이 걸렸는지는 `git config core.hooksPath`와 `.husky/_`의 존재로 확인해라
- **훅이 없는 곳이 셋 있다.** (1) 클론 직후 `npm install` 전 (2) `.husky/_`가 없는 워크트리 (3) `HUSKY=0`이 설정된 셸. 셋 다 **경고 없이** 훅을 건너뛴다. 워크트리는 `worktree-new.sh`가 `npm run prepare`를 돌려 세운다
- 로컬 훅은 강제 수단이 아니라 편의 장치다. `--no-verify`·`HUSKY=0`·`core.hooksPath` 변경으로 우회된다. **실제 강제는 CI의 몫이고 이 저장소에는 아직 CI가 없다**

규칙을 끄거나 낮출 때는 **반드시 이유를 주석으로 남긴다.** 전체를 끄기보다 파일 단위로 좁혀서 끈다.

```js
{
  files: ['jest.setup.ts'],
  rules: { '@typescript-eslint/no-require-imports': 'off' },
}
```

`eslint.config.js`의 `react-hooks/set-state-in-effect`가 예다. 오탐 한 건과 진짜 지적 한 건이 섞여 있어 `warn`으로 낮췄고, 진짜 지적을 정리하면 다시 `error`로 올리도록 적어 두었다.
