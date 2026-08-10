import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
  it('GET /api/ping은 200과 문자열 pong으로 응답한다', () => {
    return request(app.getHttpServer())
      .get('/api/ping')
      .expect(200)
      .expect('pong');
  });
});
