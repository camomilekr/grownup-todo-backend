# 참조 — iOS 실기기 빌드와 Android 캐시

실기기·시뮬레이터 빌드를 하거나 Android를 건드릴 때 읽는다.

```bash
npm run ios            # iOS 시뮬레이터 (Debug + Metro)
npm run android        # Android 에뮬레이터 — 아래 "캐시" 경고를 먼저 읽어라
npm run web            # 브라우저

npm run ios:device     # 실기기 Release. JS 번들 내장, Metro 없이 독립 실행
npm run ios:device:dev # 실기기 Debug. Metro 연결로 JS 수정 즉시 반영
npm run ios:devices    # 연결된 기기 목록
```

## git에 없는 수동 설정 두 개

무료 Apple ID(Personal Team)로 개인 iPhone에 설치해 쓰고 있다. `ios/`는 gitignore 대상이라 **아래 두 설정은 커밋으로 보존되지 않는다.** `npx expo prebuild`를 실행하면 초기화되므로 그때마다 다시 넣어야 한다.

| 설정 | 값 | 없으면 |
|---|---|---|
| `DEVELOPMENT_TEAM` | `939QT76C63` | 서명 실패. Xcode에서 Team 재선택 필요 |
| `ENABLE_USER_SCRIPT_SANDBOXING` | `NO` | 번들 스크립트가 `main.jsbundle`을 못 지워 빌드 실패 |

```bash
sed -i '' 's/ENABLE_USER_SCRIPT_SANDBOXING = YES;/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g' \
  ios/*.xcodeproj/project.pbxproj
```

**의존성만 바꿀 때는 prebuild 대신 `pod install`을 쓴다.** `ios/`에서 `pod install`만 실행하면 Pods만 갱신되고 위 두 설정이 보존된다.

## 밟으면 빌드가 깨지는 것 셋

- **Xcode의 "권장 설정으로 업데이트"를 수락하지 말 것.** 이게 `ENABLE_USER_SCRIPT_SANDBOXING = YES`를 켜서 빌드를 깨뜨린다. React Native의 번들 스크립트는 DerivedData에 파일을 쓰고 지워야 해서 샌드박싱과 양립하지 않는다
- **`app.json` plugins에 `expo-notifications`를 넣지 말 것.** 이 플러그인이 iOS에 `aps-environment`(Push Notifications) entitlement를 추가하는데 **무료 개인 팀은 이 권한을 프로비저닝할 수 없어** 빌드가 막힌다. 이 앱은 로컬 알림만 쓰므로 플러그인이 필요 없다 — 네이티브 모듈은 패키지가 `dependencies`에 있으면 autolinking이 처리하며 config plugin과 무관하다
- **iPhone 잠금을 풀어 둘 것.** 잠겨 있으면 빌드·설치까지 성공하고 실행 단계에서 `CommandError: ... because the device is locked`로 실패한다. 재빌드는 필요 없고 홈 화면에서 앱을 열면 된다

## 무료 개인 팀의 제약

- **프로비저닝 프로파일이 7일 후 만료**된다. `npm run ios:device`를 다시 실행해 재설치한다. 번들 ID가 같으면 **저장된 할 일은 유지**된다
- 첫 설치 후 기기에서 **설정 → 일반 → VPN 및 기기 관리 → 개발자 앱 → 신뢰**를 눌러야 실행된다
- iOS 16+는 **설정 → 개인정보 보호 및 보안 → 개발자 모드**가 켜져 있어야 한다

## 빌드 전 확인

- `DEVELOPER_DIR`이 필요하다. `xcode-select`가 `CommandLineTools`를 가리키고 있어서다. `ios:device` 스크립트에 이미 포함돼 있다
- CocoaPods가 Homebrew에 있어 `PATH`에 `/opt/homebrew/bin`이 필요하다. 역시 스크립트에 포함돼 있다

## `expo run:ios`는 스스로 종료되지 않는다

빌드·설치·실행이 끝나도 Metro를 유지하려고 프로세스가 살아 있다. **프로세스 종료를 완료 신호로 기다리면 안 된다.** 로그에서 아래가 보이면 끝난 것이다.

```
› Build Succeeded
✔ Complete 100%
› Logs for your project will appear below.
```

Release 빌드는 JS가 앱에 내장되므로 이후 Metro는 필요 없다.

## 워크트리에서 빌드하지 않는다

`ios/`가 gitignore 대상이라 워크트리에 없고, `prebuild`를 돌리면 위의 수동 설정 두 개가 날아간다. 대신 **저장소 루트를 detached HEAD로 옮겨** 루트의 `ios/`(Pods와 두 설정이 살아 있다)를 그대로 쓴다. 워크트리가 브랜치를 점유한 채로도 detached 체크아웃은 된다.

```bash
cd ~/projects/my-todo-app
git switch --detach feature/fix-added-todo-not-visible
npm run ios:device
git switch develop        # 확인이 끝나면 되돌린다
```

설치된 앱은 빌드 산출물이라 이후 루트의 체크아웃 상태와 무관하다.

## Android 빌드 캐시가 `node_modules`를 GB 단위로 불린다

**`npm run android`를 한 번 돌리면 `node_modules` 안에 수 GB가 쌓이고 그대로 남는다.** Gradle이 각 네이티브 패키지의 `android/build`와 `android/.cxx`에 디버그 `.so`를 ABI 4개분(arm64-v8a, x86_64, x86, armeabi-v7a) 만들어 둔다. 디버그 심볼이 붙어 파일 하나가 200MB를 넘는다.

2026-07-27에 실측한 결과다.

| | 배포 크기 | 빌드 후 디스크 |
|---|---|---|
| `node_modules` 전체 | — | **5.7GB** (정리 후 592MB) |
| `react-native-reanimated` | 4.4MB | 2.4GB |
| `expo-modules-core` | 31.7MB | 2.0GB |
| `react-native-worklets` | 1.0MB | 812MB |
| `react-native-gesture-handler` | — | 878MB |

**패키지가 큰 것이 아니다.** reanimated가 크다고 의심되면 이것을 먼저 확인해라 — 배포 크기는 4.4MB이고 나머지 전부가 빌드 산출물이다. 레지스트리의 실제 크기는 `npm view <패키지>@<버전> dist.unpackedSize`로 확인한다.

이 앱은 **걸음 수가 iOS 전용이라 Android를 쓰지 않는다.** 그래서 이 캐시는 한 번 생기면 죽은 채로 남는다.

```bash
find node_modules -maxdepth 4 -type d \( -path '*/android/build' -o -path '*/android/.cxx' \) \
  -prune -print0 | xargs -0 rm -rf
rm -rf android/app/build
```

**지워도 안전하다.** 다음 Android 빌드에 재생성되며(첫 빌드가 오래 걸린다) JS 테스트·타입체크·iOS 빌드와 무관하다. 지운 뒤 `npm run verify` 전체가 통과하는 것을 확인했다.

`ios/Pods`(598MB)는 **건드리지 않는다.** iOS 빌드에 필요한 의존성이다.

**워크트리를 복제하기 전에 정리하는 편이 낫다.** `npm run android`를 돌린 상태에서 `cp -Rc`하면 죽은 캐시까지 함께 간다.
