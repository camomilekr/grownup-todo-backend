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
| 워크트리 디렉터리를 손으로 지웠다 | `git worktree prune`으로 남은 등록 정보를 정리한다 |
| `git worktree remove`가 느리거나 거부한다 | `node_modules`를 먼저 지우지 않았다. `worktree-drop.sh`가 순서를 지킨다 |
| `rm -rf .../node_modules`가 `Directory not empty` | 정상이다. 아래 참고 |
| 커밋 하나에 여러 관심사가 들어갔다 | `git add -A`를 썼다. 경로를 지정해 의미 단위로 나눈다 |
| `git stash -k -u`가 `Entry '...' not uptodate. Cannot merge.` | `fingerprint.sh`가 남긴 `git add -N` 표식이 있는 파일을 그 뒤에 편집했다. `git reset`으로 인덱스를 비운 뒤 다시 스테이징한다 |
| 푸시·브랜치 삭제에 `Repository rule violations` 경고가 뜨는데 결과는 성공 | ruleset의 `bypass_actors`에 admin이 있으면 위반을 보고하고 허용한다. **실패와 구분하는 기준은 `[deleted]`·`[new branch]` 줄이 있는지다** |

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

## 워크트리를 격리하는 것은 설정이 아니라 점 디렉터리다

**`.claude/worktrees/`를 제외하는 설정이 어디에도 없다.** 확인한 결과다 — `.prettierignore`에는 `/src/generated`·`/dist`·`/coverage`만, `.eslintrc.js`의 `ignorePatterns`에는 `.eslintrc.js`·`src/generated/**`만, jest 설정(`package.json`)에는 아무것도 없다. `.gitignore`에도 없다.

그런데도 충돌이 나지 않는다. **`.claude/`가 점으로 시작해서 도구들이 기본적으로 건너뛰기 때문이다.**

| 도구 | 왜 안 걸리는가 |
|---|---|
| TypeScript | `include` 기본값이 점 디렉터리를 매칭하지 않는다. 루트 tsconfig의 파일 목록에 워크트리 파일이 **0개**다 |
| ESLint | 점 디렉터리를 기본 무시한다 (`File ignored by default.`) |
| Prettier·jest | 글롭이 `{src,apps,libs,test}`, `rootDir`이 `src`라 애초에 `.claude/` 밖이다 |

**그 격리의 대가가 IDE 지원이다.** 같은 이유로 저장소 루트를 열어 둔 편집기는 워크트리 파일을 어느 프로젝트에도 속하지 않은 것으로 취급해, `describe`·`it` 같은 jest 전역을 모르는 이름으로 표시한다. **워크트리를 별도 창으로 열어야 한다**(`.claude/rules/core.md`).

**루트 `tsconfig.json`에 워크트리를 포함시켜 해결하려 하지 마라.** 루트에서 `verify`를 돌릴 때 같은 클래스가 두 번 선언된 것으로 보인다.

`docs/`도 `.gitignore`에 없다. 규약은 "`docs/`는 추적되지 않는다"를 전제하는데 실제로는 추적 대상이므로, **`git add -A`를 쓰면 계획서와 개발 기록이 저장소에 들어간다.** 커밋할 파일을 경로로 지정해라.

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

## husky

- **`prepare`가 `husky || true`인 이유는 프로덕션 설치다.** `npm ci --omit=dev`는 `prepare`를 실행하면서 `husky`(devDependency)를 설치하지 않아 `husky: command not found`로 exit 127이 되고, 설치 전체가 실패한다. `|| true`가 그것만 흡수한다. **부작용은 훅 설치 실패도 조용해진다는 것** — 훅이 걸렸는지는 `git config core.hooksPath`와 `.husky/_`의 존재로 확인해라
- **훅이 없는 곳이 셋 있다.** (1) 클론 직후 `npm install` 전 (2) `.husky/_`가 없는 워크트리 (3) `HUSKY=0`이 설정된 셸. 셋 다 **경고 없이** 훅을 건너뛴다. 워크트리는 `worktree-new.sh`가 `npm run prepare`를 돌려 세운다
- 로컬 훅은 강제 수단이 아니라 편의 장치다. `--no-verify`·`HUSKY=0`·`core.hooksPath` 변경으로 우회된다. **실제 강제는 CI의 몫이고 이 저장소에는 아직 CI가 없다**

규칙을 끄거나 낮출 때는 **반드시 이유를 주석으로 남긴다.** 전체를 끄기보다 파일 단위로 좁혀서 끈다.

```js
// .eslintrc.js — 파일 단위로 좁혀서 끈다
{
  files: ['*.spec.ts'],
  rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
}
```

`.eslintrc.js`가 `@typescript-eslint/no-explicit-any`를 끈 것이 예다. 끄거나 낮춘 자리마다 왜 그랬는지와 되돌릴 조건을 함께 남긴다.
