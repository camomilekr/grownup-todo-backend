import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  // AppModule이 PrismaModule을 물게 된 뒤로는 반드시 닫아야 한다. `app.init()`이
  // Postgres 커넥션 풀을 열기 때문에, 닫지 않으면 jest가 열린 핸들 때문에
  // 종료하지 못하고 매달린다.
  afterEach(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  // 부트된 앱에서 BigInt 직렬화가 켜져 있는지 본다. `BigIntJsonModule`의 단위
  // spec은 그 모듈을 직접 import하므로 **AppModule이 그것을 물고 있는지**는
  // 검증하지 못한다 — imports에서 빠져도 통과한다. 모든 PK가 BIGSERIAL이라
  // 꺼진 채 배포되면 첫 응답에서 500이 나므로 배선 자체를 여기서 고정한다.
  it('앱이 부트되면 BigInt를 JSON으로 직렬화할 수 있다', () => {
    expect(JSON.stringify({ id: 1n })).toBe('{"id":"1"}');
  });
});
