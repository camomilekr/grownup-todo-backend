import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * **Prisma가 표현하지 못해 마이그레이션 SQL에 손으로 넣은 것들을 지키는 관문이다.**
 * 지금 두 종류가 있다 — RLS와 컬럼·테이블 코멘트.
 *
 * **왜 테스트가 필요한가.** 둘 다 Prisma 스키마 문법에 없어서 마이그레이션 SQL에 직접
 * 쓴다. 그런데 `migrate diff`는 둘 중 어느 것도 비교하지 않으므로 **빠져도 drift로
 * 잡히지 않는다** — `migrate status`·`verify`·나머지 테스트가 전부 초록으로 통과한다.
 * 마이그레이션을 다시 뽑는 절차(`src/prisma/CONTEXT.md`)를 밟다가 그 블록을 옮겨
 * 붙이는 것을 잊으면 조용히 사라진 채 배포된다.
 *
 * RLS가 없으면 무엇이 열리는가: Supabase는 `postgres`가 `public`에 만드는 모든 테이블에
 * `anon`·`authenticated` 권한을 자동으로 붙인다(`pg_default_acl`). **이 프로젝트는 현재
 * Data API(PostgREST)가 비활성이라 그 권한에 도달하는 경로가 없다** — RLS는 그것이
 * 켜지는 경우를 위한 대비다. 켜지면 클라이언트에 배포되는 anon 키만으로 전 유저의
 * 이메일과 todo가 열리고, 백엔드는 `rolbypassrls`라 미리 켜 두는 비용이 0이다.
 *
 * 코멘트가 없으면: Prisma의 `///` 주석은 **DB로 가지 않는다.** 생성된 TS 클라이언트의
 * JSDoc으로만 들어가므로, `psql`·DataGrip·Supabase 대시보드로 스키마를 열면 아무 설명이
 * 없다. 스키마를 DB 쪽에서 보는 사람에게는 컬럼 이름만 남는다.
 *
 * **테이블·컬럼 목록을 하드코딩하지 않는다.** default ACL은 앞으로 추가되는 테이블에도
 * 붙고 코멘트도 새 컬럼마다 필요하므로, 목록을 적어 두면 4번째 테이블·다음 컬럼에서
 * 같은 구멍이 재현된다. `public`을 훑어 빠진 것이 하나라도 있으면 실패한다.
 */
describe('스키마 가드 (e2e)', () => {
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

  it('public 스키마의 모든 테이블에 RLS가 켜져 있다', async () => {
    // **예외가 없다.** `_prisma_migrations`도 포함한다 — 그 테이블도 default ACL로
    // `anon`에게 전권이 붙는데, 지워지면 다음 `migrate deploy`가 첫 마이그레이션을
    // 재적용하려 들어 `CREATE TABLE`에서 깨지고, 가짜 행이 들어가면 적용되지 않은
    // 마이그레이션이 조용히 건너뛰어진다.
    const rows = await prisma.$queryRaw<
      { name: string; enabled: boolean }[]
    >`select c.relname::text as name, c.relrowsecurity as enabled
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'`;

    // 테이블이 하나도 안 잡히면 쿼리나 접속이 잘못된 것이다. 그 상태에서 아래
    // 단정은 빈 배열끼리 비교해 조용히 통과한다.
    expect(rows.length).toBeGreaterThan(0);

    const withoutRls = rows
      .filter((row) => !row.enabled)
      .map((row) => row.name);

    expect(withoutRls).toEqual([]);
  });

  it('정책은 하나도 만들지 않는다', async () => {
    // 정책 0개 + RLS on이 이 구조에서 원하는 상태다. `anon`·`authenticated`는 권한이
    // 있어도 아무 행에 닿지 못하고, 백엔드가 쓰는 `postgres`는 `rolbypassrls=true`라
    // 영향을 받지 않는다. Data API를 쓰기로 하면 그때 정책을 추가하고 이 단정을 고친다.
    const rows = await prisma.$queryRaw<
      { count: bigint }[]
    >`select count(*) as count from pg_policies where schemaname = 'public'`;

    expect(Number(rows[0].count)).toBe(0);
  });

  it('백엔드가 쓰는 롤은 RLS를 우회한다', async () => {
    // 이것이 성립하지 않으면 정책 0개인 상태에서 백엔드도 아무것도 읽지 못한다.
    // 위 두 단정이 "안전하지만 동작하지 않는" 상태를 통과시키지 않게 고정한다.
    const rows = await prisma.$queryRaw<
      { bypass: boolean }[]
    >`select rolbypassrls as bypass from pg_roles where rolname = current_user`;

    expect(rows[0].bypass).toBe(true);
  });

  it('모든 테이블에 코멘트가 있다', async () => {
    const rows = await prisma.$queryRaw<
      { name: string }[]
    >`select c.relname::text as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        left join pg_description d on d.objoid = c.oid and d.objsubid = 0
       where c.relkind = 'r'
         -- 코멘트는 _prisma_migrations 를 제외한다. RLS와 달리 이쪽은 예외가
         -- 정당하다 - Prisma가 소유·관리하는 테이블이라 우리 스키마 문서화 대상이
         -- 아니고, Prisma가 그 구조를 바꿀 때 코멘트가 어긋난 채 남는다.
         and c.relname <> '_prisma_migrations'
         and d.description is null`;

    expect(rows.map((row) => row.name)).toEqual([]);
  });

  it('모든 컬럼에 코멘트가 있다', async () => {
    // `objsubid`가 컬럼 번호다(0이면 테이블 자체). `attnum > 0`으로 시스템 컬럼을,
    // `not attisdropped`로 삭제된 컬럼의 잔재를 걸러낸다.
    const rows = await prisma.$queryRaw<
      { table: string; column: string }[]
    >`select c.relname::text as "table", a.attname::text as "column"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        left join pg_description d on d.objoid = c.oid and d.objsubid = a.attnum
       where c.relkind = 'r'
         -- 코멘트는 _prisma_migrations 를 제외한다. RLS와 달리 이쪽은 예외가
         -- 정당하다 - Prisma가 소유·관리하는 테이블이라 우리 스키마 문서화 대상이
         -- 아니고, Prisma가 그 구조를 바꿀 때 코멘트가 어긋난 채 남는다.
         and c.relname <> '_prisma_migrations'
         and d.description is null
       order by c.relname, a.attnum`;

    expect(rows.map((row) => `${row.table}.${row.column}`)).toEqual([]);
  });

  it('코멘트 검사가 실제로 컬럼을 훑고 있다', async () => {
    // 위 두 단정은 빈 배열끼리 비교하므로, 쿼리가 아무 행도 보지 못하는 상태에서도
    // 조용히 통과한다. 실제로 컬럼을 세고 있는지 여기서 고정한다.
    const rows = await prisma.$queryRaw<
      { count: bigint }[]
    >`select count(*) as count
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind = 'r' and c.relname <> '_prisma_migrations'`;

    // 세 테이블에 최소 서른 개 넘는 컬럼이 있다. 정확한 수를 박으면 컬럼을 추가할
    // 때마다 이 테스트를 고쳐야 하므로 하한만 둔다.
    expect(Number(rows[0].count)).toBeGreaterThan(30);
  });
});
