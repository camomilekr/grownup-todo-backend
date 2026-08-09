import type { INestApplication } from '@nestjs/common';

/**
 * 모든 라우트가 이 아래에 산다. 버전을 경로에 두는 이유는 응답 형태를 바꿔야 하는
 * 날 `/api/v2`를 나란히 열고 옮겨 갈 수 있게 하기 위해서다.
 */
export const API_PREFIX = 'api/v1';

/**
 * 프로덕션과 테스트가 함께 부르는 HTTP 공통 설정.
 *
 * **`main.ts`에만 두면 안 되는 설정을 모으는 자리다.** e2e는 `createNestApplication()`
 * 으로 앱을 만들어 `bootstrap()`을 거치지 않으므로, 부트스트랩에만 건 설정은 어떤
 * 테스트도 지나지 않는 코드가 되어 테스트와 프로덕션의 라우팅이 갈린다
 * (`src/common/bigint-json.module.ts`와 같은 근거).
 *
 * 전역 `ValidationPipe`는 여기 없다 — 모듈이 제공하는 `APP_PIPE`로 걸어
 * (`src/app.module.ts`) 이 함수를 부르지 않는 테스트 경로에도 자동으로 포함시킨다.
 * 여기 남는 것은 `INestApplication`이 있어야만 걸 수 있는 설정(전역 prefix)이다.
 */
export function setupApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
}
