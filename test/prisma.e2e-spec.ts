import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * 실제 Supabase Postgres에 붙는다. 그래서 단위 테스트가 아니라 e2e다
 * (`.claude/rules/nestjs.md` — "DB를 실제로 붙이는 테스트는 e2e로 분류한다").
 *
 * `.env`의 DATABASE_URL이 필요하다. 이 테스트가 확인하는 것은 스키마가 아니라
 * **배선**이다 — 어댑터·환경변수·라이프사이클 훅이 한 줄로 이어졌는지.
 */
describe('Prisma (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('트랜잭션 모드 풀러로 쿼리를 돌린다', async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`select 1::int as ok`;

    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('DATABASE_URL이 가리키는 곳은 Supabase의 postgres DB다', async () => {
    const rows = await prisma.$queryRaw<
      { db: string }[]
    >`select current_database() as db`;

    expect(rows[0].db).toBe('postgres');
  });

  it('여러 쿼리를 동시에 보내도 커넥션이 엉키지 않는다', async () => {
    // 트랜잭션 모드 풀러는 커넥션을 트랜잭션 단위로 회수한다. 드라이버가
    // 이름 있는 prepared statement를 쓰면 여기서 "prepared statement does not
    // exist"로 깨진다 — node-postgres 어댑터가 그렇지 않다는 것을 고정한다.
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(
        (n) => prisma.$queryRaw<{ n: number }[]>`select ${n}::int as n`,
      ),
    );

    expect(results.map(([row]) => row.n)).toEqual([1, 2, 3, 4, 5]);
  });
});
