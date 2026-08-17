import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ShutdownRegistry } from '../shutdown/shutdown-registry.service';

/**
 * readiness 프로브의 판정.
 *
 * 컨트롤러가 아니라 Service에 두는 이유는 규약이다 — 컨트롤러에 조건 분기가
 * 생기면 Service로 내린다(`.claude/rules/nestjs.md`). 판정이 한 줄이어도
 * 여기 있어야 나중에 "종료 중"이 아닌 다른 미준비 조건이 생겼을 때 둘 자리가
 * 이미 있다.
 *
 * **liveness와 다른 점이 이 클래스의 전부다.** 종료 중에 503이 되는 것은 readiness
 * 하나이고, liveness(`ping`)는 200을 유지한다 — 그렇게 갈라야 하는 근거와 어긋났을
 * 때의 대가는 `docs/k8s-local-verification.md`의 ① 절 한 곳에 실측과 함께 있다.
 *
 * **DB를 보지 않는다.** `src/health/CONTEXT.md`가 금지하는 것과 같은 이유다 —
 * 프로브가 DB에 묶이면 DB 장애 때 멀쩡한 파드가 엔드포인트에서 빠진다.
 */
@Injectable()
export class ReadinessService {
  constructor(private readonly shutdownRegistry: ShutdownRegistry) {}

  check(): string {
    if (this.shutdownRegistry.isShuttingDown()) {
      // 상태 코드를 손으로 만들지 않고 내장 예외를 쓴다(규약). 503은
      // "지금은 못 받는다"이고, k8s가 이 파드를 엔드포인트에서 뺀다
      throw new ServiceUnavailableException(
        '종료 중이라 새 요청을 받지 않는다',
      );
    }
    return 'ready';
  }
}
