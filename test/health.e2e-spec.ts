import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { setupApp } from './../src/app-setup';
import { PinoLoggerService } from './../src/logging/pino-logger.service';
import { ShutdownRegistry } from './../src/shutdown/shutdown-registry.service';

describe('Health (e2e)', () => {
  let app: INestApplication;
  /** `RequestLoggingMiddleware`가 남긴 로그. 미들웨어가 탔는지를 이것으로 본다 */
  let loggedEvents: unknown[];

  beforeEach(async () => {
    loggedEvents = [];

    // 로거를 대역으로 바꾼다. pino의 실제 출력을 파싱하는 대신 이 자리를
    // 고르는 이유는, 여기서 보고 싶은 것이 "무엇이 어떻게 찍혔는가"가 아니라
    // **미들웨어가 그 요청을 탔는가**이기 때문이다. 출력 형식은
    // `pino-logger.service.spec.ts`가 따로 고정한다.
    const loggerStub: Partial<PinoLoggerService> = {
      log: (message: unknown) => {
        loggedEvents.push(message);
      },
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
      fatal: () => undefined,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PinoLoggerService)
      .useValue(loggerStub)
      .compile();

    app = moduleFixture.createNestApplication();
    // 프로덕션(`main.ts`)과 같은 HTTP 설정(전역 prefix)을 여기서도 건다.
    // 부르지 않으면 프로브 경로가 `/ping`으로 보여, 실제 배포 경로
    // `/api/v1/ping`과 다른 것을 검증하게 된다.
    setupApp(app);
    await app.init();
  });

  // AppModule이 PrismaModule을 물고 있어 `app.init()`이 Postgres 커넥션 풀을
  // 연다. 닫지 않으면 jest가 열린 핸들 때문에 종료하지 못하고 매달린다.
  afterEach(async () => {
    await app.close();
  });

  // k8s liveness·readiness 프로브 대상. AppModule로 부트하는 이유는 라우트
  // 자체가 아니라 **AppModule이 HealthModule을 물고 있는지**까지 고정하기
  // 위해서다 — 컨트롤러만 따로 부트하면 imports에서 빠져도 통과한다.
  it('GET /api/v1/ping은 200과 문자열 pong으로 응답한다', () => {
    return request(app.getHttpServer())
      .get('/api/v1/ping')
      .expect(200)
      .expect('pong');
  });

  // 프로브 경로가 전역 prefix 아래로 정확히 한 번만 들어가는지를 본다.
  // 컨트롤러에 `api`가 남아 `/api/v1/api/ping`이 되는 회귀는 위의 200 테스트가
  // 잡고, 이 테스트는 **옛 경로가 호환용으로 되살아나지 않는 것**을 고정한다.
  it('prefix 없는 GET /api/ping은 404다', () => {
    return request(app.getHttpServer()).get('/api/ping').expect(404);
  });

  it('GET /api/v1/ready는 200과 문자열 ready로 응답한다', () => {
    return request(app.getHttpServer())
      .get('/api/v1/ready')
      .expect(200)
      .expect('ready');
  });

  describe('종료 드레인', () => {
    // 컨테이너에서 꺼낸 코디네이터의 드레인 국면을 **시그널 없이** 부른다 —
    // 시그널을 주면 실제 대기 시간만큼 테스트가 멈춘다. 종료 플래그만 세우는
    // 것이 여기서 보려는 상태다.
    async function 종료를_시작한다(): Promise<void> {
      await app.get(ShutdownRegistry).beforeApplicationShutdown();
    }

    it('종료가 시작되면 readiness는 503이 된다', async () => {
      await 종료를_시작한다();

      await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    });

    // 이 단정이 이 기능의 핵심이다 — 겸용 경로 하나를 종료 시 503으로 바꾸는
    // 구현과 이 구현을 가르는 지점이다. liveness까지 503이 되면 무엇을 잃는지는
    // `docs/k8s-local-verification.md` ① 절에 실측과 함께 있다.
    it('종료가 시작돼도 liveness는 200을 유지한다', async () => {
      await 종료를_시작한다();

      await request(app.getHttpServer())
        .get('/api/v1/ping')
        .expect(200)
        .expect('pong');
    });

    it('종료가 시작돼도 일반 요청은 계속 처리된다', async () => {
      // 드레인의 목적이 이것이다 — readiness만 내리고 처리는 계속한다
      await 종료를_시작한다();

      await request(app.getHttpServer())
        .get('/api/v1')
        .expect(200)
        .expect('Hello World!');
    });
  });

  describe('요청 로깅 제외', () => {
    // k8s 프로브가 수 초마다 때리므로 로그가 프로브 기록에 잠긴다. 제외가
    // 풀려도 응답은 정상이라 사람이 알아채지 못한다 — 그래서 배선을 여기서
    // 고정한다. exclude 경로에 전역 prefix를 직접 붙이면(`api/v1/ping`)
    // Nest가 한 번 더 붙여 제외가 조용히 풀리는데, 그 회귀를 이 테스트가 잡는다.
    it('liveness 요청은 요청 로그를 남기지 않는다', async () => {
      await request(app.getHttpServer()).get('/api/v1/ping').expect(200);

      expect(loggedEvents).toHaveLength(0);
    });

    it('readiness 요청은 요청 로그를 남기지 않는다', async () => {
      await request(app.getHttpServer()).get('/api/v1/ready').expect(200);

      expect(loggedEvents).toHaveLength(0);
    });

    // 위 테스트들만 있으면 미들웨어가 아예 걸리지 않은 상태에서도 통과한다.
    // 프로브가 아닌 요청이 로그를 남기는 것을 함께 단정해 그 경우를 배제한다.
    it('프로브가 아닌 요청은 요청 로그를 남긴다', async () => {
      await request(app.getHttpServer()).get('/api/v1').expect(200);

      // 요청 수신 1건 + 응답 완료 1건
      expect(loggedEvents).toHaveLength(2);
    });
  });
});
