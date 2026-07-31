import { Module, OnModuleInit } from '@nestjs/common';
import { enableBigIntJsonSerialization } from './bigint-json';

/**
 * `BigInt` JSON 직렬화 가드를 앱 초기화 시점에 켠다.
 *
 * **왜 `main.ts`가 아니라 모듈인가.** `bootstrap()`은 테스트가 실행하지 않는다 —
 * e2e도 `createNestApplication()`으로 앱을 만들어 `main.ts`를 거치지 않는다. 거기에만
 * 두면 이 가드는 **어떤 테스트도 지나지 않는 코드**가 되어, 누가 호출을 지워도 전부
 * 초록으로 통과한다. 더 나쁜 것은 그동안 테스트 환경과 프로덕션의 직렬화 동작이
 * 달라진다는 점이다 — e2e에서 HTTP 경계를 타면 프로덕션에서 켜져 있는 것이 꺼져 있다.
 *
 * `AppModule`이 이 모듈을 import하므로 앱을 부트하는 모든 경로(프로덕션·e2e·테스팅
 * 모듈)가 같은 상태를 본다.
 *
 * Provider가 없는 모듈인 것은 의도한 것이다. 하는 일이 전역 프로토타입 확장 하나뿐이라
 * 주입할 것이 없다.
 */
@Module({})
export class BigIntJsonModule implements OnModuleInit {
  onModuleInit(): void {
    enableBigIntJsonSerialization();
  }
}
