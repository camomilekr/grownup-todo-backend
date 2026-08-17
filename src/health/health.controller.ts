import { Controller, Get } from '@nestjs/common';
import { ReadinessService } from './readiness.service';

/**
 * liveness 프로브 경로. 최종 노출 경로는 `/api/v1/ping`이다.
 *
 * 상수로 빼 둔 이유는 `AppModule`의 요청 로깅 exclude가 **같은 경로**를
 * 가리켜야 하기 때문이다 — 양쪽에 문자열을 따로 적으면 한쪽만 바뀌었을 때
 * 프로브 요청이 조용히 로그를 채운다.
 */
export const HEALTH_PING_PATH = 'ping';

/** readiness 프로브 경로. 최종 노출 경로는 `/api/v1/ready`다 */
export const HEALTH_READY_PATH = 'ready';

/**
 * k8s liveness·readiness 프로브 대상.
 *
 * 의도적으로 DB를 보지 않는다 — 프로브가 DB 상태에 묶이면 DB 장애 때
 * k8s가 멀쩡한 파드를 재시작해 장애를 키운다. 프로세스가 HTTP 요청에
 * 응답할 수 있는지만 답한다.
 *
 * 컨트롤러 경로가 비어 있는 이유는 전역 prefix(`api/v1`)가 이미 `api`를
 * 담고 있어서다 — `@Controller('api')`로 두면 `/api/v1/api/ping`이 된다.
 */
@Controller()
export class HealthController {
  constructor(private readonly readinessService: ReadinessService) {}

  /**
   * liveness — **종료 중에도 200이다.** 여기에 종료 판정을 넣지 마라. 근거는
   * `docs/k8s-local-verification.md` ① 절에 있다.
   */
  @Get(HEALTH_PING_PATH)
  ping(): string {
    return 'pong';
  }

  /** readiness — 종료가 시작되면 Service가 503을 던진다 */
  @Get(HEALTH_READY_PATH)
  ready(): string {
    return this.readinessService.check();
  }
}
