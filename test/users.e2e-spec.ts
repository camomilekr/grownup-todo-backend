import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { UsersRepository } from './../src/users/users.repository';
import { UsersModule } from './../src/users/users.module';

/**
 * 실제 Supabase Postgres에 붙는다(`.claude/rules/nestjs.md` — "DB를 실제로 붙이는
 * 테스트는 e2e로 분류한다"). Repository는 단위 테스트를 만들지 않는다 —
 * `PrismaService`를 대역으로 바꾸면 쿼리가 무엇을 돌려주는지가 아니라 호출 인자만
 * 검증하게 되고, 그건 구현 세부사항 테스트다.
 *
 * `UsersModule`을 `imports`에 함께 넣는다. **아직 `AppModule`이 그것을 물지 않기
 * 때문이다** — 타임존을 읽는 쪽(`TodosService`)이 생기는 라운드에서 배선이 붙는다.
 * `PrismaModule`은 두 모듈이 같은 클래스를 import하므로 인스턴스가 하나로 공유된다.
 *
 * **공유 DB를 쓰므로 데이터를 남기지 않는다.** 랜덤 email로 전용 유저를 만들고
 * `afterAll`에서 지운다.
 */
describe('Users Repository (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let users: UsersRepository;
  const createdUserIds: bigint[] = [];

  function uniqueEmail(prefix: string): string {
    // 병렬 실행·재실행에서 유니크 충돌이 나지 않게 매번 다른 값을 쓴다.
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  }

  async function createUser(data: { timeZone?: string; deletedAt?: Date }) {
    const user = await prisma.appUser.create({
      data: { email: uniqueEmail('users-e2e'), ...data },
    });
    createdUserIds.push(user.userId);
    return user;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, UsersModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    users = app.get(UsersRepository);
  });

  afterAll(async () => {
    await prisma.appUser.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await app.close();
  });

  it('유저의 타임존을 돌려준다', async () => {
    // 매일 반복 할 일의 "오늘"이 이 값으로 정해진다. 기본값이 아닌 이름을 써서
    // 저장한 값이 그대로 돌아오는 것을 본다.
    const user = await createUser({ timeZone: 'America/New_York' });

    expect(await users.findTimeZone(user.userId)).toBe('America/New_York');
  });

  it('없는 번호면 null이다', async () => {
    expect(await users.findTimeZone(999999999n)).toBeNull();
  });

  it('탈퇴한 유저면 null이다', async () => {
    // 탈퇴는 행을 지우지 않고 `deletedAt`에 시각을 적는 방식이다. 조건을 빼면 탈퇴한
    // 유저의 할 일에 계속 날짜 키가 만들어져 기록이 쌓인다.
    const user = await createUser({
      timeZone: 'Asia/Seoul',
      deletedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(await users.findTimeZone(user.userId)).toBeNull();
  });
});
