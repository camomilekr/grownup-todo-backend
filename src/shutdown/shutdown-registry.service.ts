import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 등록된 해제 콜백. 동기·비동기 모두 받는다. */
type DisposeFn = () => Promise<unknown> | unknown;

interface ShutdownEntry {
  name: string;
  dispose: DisposeFn;
}

/**
 * 자원별 해제 시간 예산. k8s `terminationGracePeriodSeconds` 기본 30초에서
 * HTTP 드레인 몫을 뺀 값이다 — 최종 방어선은 k8s의 SIGKILL이고, 이 상수는
 * 자원 하나가 멈췄을 때 나머지 자원의 해제 기회를 지키기 위한 것이다.
 */
const DISPOSE_TIMEOUT_MS = 10_000;

/**
 * 종료를 한 곳에서 조율하는 종료 코디네이터. 앱에서 유일하게
 * `BeforeApplicationShutdown`·`OnApplicationShutdown`을 구현한다 —
 * 자원(Prisma, 추후 Redis 등)은 자체 종료 훅 없이
 * `register(name, dispose)` 한 줄만 부른다.
 *
 * **두 국면을 맡는다.** Nest의 종료 순서는
 * `onModuleDestroy → beforeApplicationShutdown → HTTP 서버 close →
 * onApplicationShutdown`이다(@nestjs/core 10.4.22 `nest-application-context.js`
 * 실측).
 * - `beforeApplicationShutdown` — **드레인**. 종료 진행 플래그를 세워 readiness를
 *   즉시 503으로 만들고, 시그널 종료라면 대기한다. HTTP close **전**이라 이
 *   동안 들어온 요청은 정상 처리된다
 * - `onApplicationShutdown` — **자원 해제**. HTTP close 이후라 처리 중 요청이
 *   끊긴 DB를 만나지 않는다
 *
 * 자원마다 훅을 두면 얻을 수 없는 것을 공통 규칙으로 보장한다:
 * - **등록 역순 순차 해제** — Nest는 같은 모듈의 훅을 `Promise.all` 병렬로
 *   부르므로(실측) 훅으로는 순서를 제어할 수 없다. 나중에 연 자원을 먼저
 *   닫아야 자원 간 의존이 생겨도 안전하다
 * - **오류 격리** — 시그널 경로에서 훅이 던지면 Nest가 `Logger.error` 후
 *   `process.exit(1)`로 나머지 해제를 전부 건너뛴다(실측)
 * - **자원별 타임아웃** — 멈춘 자원 하나가 전체 종료를 잡아먹지 않는다
 * - **재호출 멱등** — e2e의 `app.close()`처럼 훅은 여러 경로로 들어온다
 */
@Injectable()
export class ShutdownRegistry
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(ShutdownRegistry.name);
  private readonly entries: ShutdownEntry[] = [];
  private disposed = false;
  private shuttingDown = false;
  private drained = false;

  constructor(private readonly configService: ConfigService) {}

  register(name: string, dispose: DisposeFn): void {
    this.entries.push({ name, dispose });
  }

  /**
   * 종료가 시작됐는가. readiness 프로브가 이 값으로 503을 판정한다
   * (`src/health/readiness.service.ts`) — liveness는 이 값을 보지 않는다.
   */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * 드레인 국면. HTTP 서버가 닫히기 **전**에 불린다.
   *
   * 대기하는 이유는 k8s가 파드를 지울 때 "엔드포인트에서 제거"와 "SIGTERM
   * 전달"이 병렬로 일어나기 때문이다 — 시그널을 받은 뒤에도 잠시 새 요청이
   * 도착하고, 그 사이에 HTTP 서버를 닫으면 커넥션 거절이 된다.
   *
   * **시그널이 있을 때만 기다린다.** `app.close()`를 직접 부르는 경로
   * (e2e의 `afterEach`)에는 signal 인자가 없다 — 거기서도 기다리면 e2e가 매
   * 테스트마다 대기 시간만큼 느려지고, 느린 테스트는 결국 실행되지 않는다.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    // 플래그는 대기 **전**에 세운다. 대기가 끝난 뒤에 세우면 드레인하는 동안
    // k8s가 파드를 계속 준비된 것으로 보고 새 요청을 계속 보낸다 — 이 순서가
    // 이 국면의 전부다
    this.shuttingDown = true;

    // 시그널이 연달아 오거나 close가 겹쳐도 종료가 두 배로 늘어지지 않게 한다
    if (this.drained) {
      return;
    }
    this.drained = true;

    if (signal === undefined) {
      return;
    }

    try {
      await this.drain(signal);
    } catch (error) {
      // "예외를 삼키지 않는다" 규약의 의도된 예외다 — 자원 해제 루프와 같은
      // 근거로, 이 훅이 던지면 Nest가 process.exit(1)로 **이후 자원 해제를
      // 전부 건너뛴다**(실측). 드레인을 못 한 대가보다 커넥션이 풀러에 남는
      // 대가가 크므로 여기서 멈추고 종료를 계속 진행시킨다. 종료 경로라 위로
      // 던질 곳이 없어 error 로그가 유일한 출구다.
      this.logger.error(
        `종료 드레인에 실패해 대기를 건너뛴다 (${signal})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 실제 대기. 던질 수 있는 문장(설정 조회)을 품으므로 호출부가 감싼다. */
  private async drain(signal: string): Promise<void> {
    const drainDelayMs = this.configService.getOrThrow<number>(
      'SHUTDOWN_DRAIN_DELAY_MS',
    );
    if (drainDelayMs <= 0) {
      return;
    }

    this.logger.log(
      `종료 드레인 시작 — ${drainDelayMs}ms 동안 요청을 계속 받는다 (${signal})`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, drainDelayMs));
    this.logger.log(`종료 드레인 완료 — HTTP 서버를 닫는다 (${signal})`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    // 실행 도중의 재진입도 막아야 하므로 완료가 아니라 진입 시점에 세운다
    this.disposed = true;

    const signalName = signal ?? '시그널 없음';

    // 등록 역순 순차 — 병렬로 돌리지 않는다. 자원 간 의존(나중에 연 자원이
    // 먼저 연 자원을 쓰는 방향)이 생겨도 안전한 쪽을 기본값으로 택했다.
    for (const entry of [...this.entries].reverse()) {
      this.logger.log(`${entry.name} 해제 시작 (${signalName})`);
      try {
        const outcome = await this.disposeWithTimeout(entry.dispose);
        if (outcome === 'timeout') {
          // 건너뛴 해제 작업은 취소되지 않고 백그라운드에 남는다(JavaScript에
          // 강제 취소가 없다) — 프로세스가 곧 종료되므로 실질적인 해는 없다
          this.logger.warn(
            `${entry.name} 해제가 ${DISPOSE_TIMEOUT_MS}ms 안에 끝나지 않아 건너뛴다 (${signalName})`,
          );
          continue;
        }
        this.logger.log(`${entry.name} 해제 완료 (${signalName})`);
      } catch (error) {
        // "예외를 삼키지 않는다" 규약의 의도된 예외다 — 종료 경로라 위로
        // 던질 곳이 없고, 던지면 Nest가 process.exit(1)로 나머지 자원의
        // 해제를 전부 건너뛴다(실측). error 로그가 유일한 출구다.
        this.logger.error(
          `${entry.name} 해제 실패 (${signalName})`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  /** 해제 하나를 시간 예산 안에서 기다린다. 초과하면 'timeout'을 돌려준다. */
  private async disposeWithTimeout(
    dispose: DisposeFn,
  ): Promise<'ok' | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve(dispose()).then(() => 'ok' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), DISPOSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      // 정상 완료 후 타이머가 살아 있으면 그만큼 프로세스 종료가 늦어진다
      clearTimeout(timer);
    }
  }
}
