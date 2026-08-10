import { Controller, Get } from '@nestjs/common';

/**
 * k8s liveness·readiness 프로브 대상.
 *
 * 의도적으로 DB를 보지 않는다 — 프로브가 DB 상태에 묶이면 DB 장애 때
 * k8s가 멀쩡한 파드를 재시작해 장애를 키운다. 프로세스가 HTTP 요청에
 * 응답할 수 있는지만 답한다.
 */
@Controller('api')
export class HealthController {
  @Get('ping')
  ping(): string {
    return 'pong';
  }
}
