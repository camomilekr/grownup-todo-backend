import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { setupApp } from './../src/app-setup';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * todos 도메인의 HTTP 경계 e2e. **라우팅·전역 파이프·직렬화가 함께 걸린 상태**를
 * 검증한다(`.claude/rules/nestjs.md` — Controller는 e2e가 값어치가 크다). 비즈니스
 * 규칙 자체는 Service spec과 `todos.e2e-spec.ts`가 이미 고정하고, 여기서는 요청이
 * 경계를 지나 올바른 상태 코드와 형태로 나오는지를 본다.
 *
 * **공유 DB를 쓰므로 데이터를 남기지 않는다.** 랜덤 email로 전용 유저를 만들고
 * `afterAll`에서 지운다 — FK가 cascade라 하위 행이 함께 사라진다
 * (`todos.e2e-spec.ts`와 같은 방식).
 */
describe('Todos HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: bigint;
  // 소유자 경계 검증용 두 번째 유저. 이 유저의 할 일이 `userId`의 요청에 보이면 안 된다.
  let otherUserId: bigint;

  /** `X-User-Id` 헤더 값. supertest의 `.set()`은 문자열을 받는다 */
  let userIdHeader: string;

  const timeZone = 'Asia/Seoul';

  function uniqueEmail(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // 프로덕션과 같은 HTTP 설정(전역 prefix)을 건다. 전역 ValidationPipe는
    // `APP_PIPE`라 모듈에서 자동으로 걸린다(`src/app.module.ts`).
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);

    const [user, otherUser] = await Promise.all([
      prisma.appUser.create({
        data: { email: uniqueEmail('todos-http'), timeZone },
      }),
      prisma.appUser.create({
        data: { email: uniqueEmail('todos-http-other'), timeZone },
      }),
    ]);
    userId = user.userId;
    otherUserId = otherUser.userId;
    userIdHeader = String(userId);
  });

  afterAll(async () => {
    await prisma.appUser.deleteMany({
      where: { userId: { in: [userId, otherUserId] } },
    });
    await app.close();
  });

  /** 타인 소유의 할 일 하나를 DB에 직접 만든다 — 소유자 경계 검증용 */
  async function createOtherUsersTodo(): Promise<bigint> {
    const row = await prisma.todoTemplate.create({
      data: {
        userId: otherUserId,
        title: '남의 할 일',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      },
    });

    return row.todoId;
  }

  describe('GET /api/v1/todo (목록)', () => {
    let onceTodoId: bigint;

    beforeAll(async () => {
      // 픽스처는 DB에 직접 만든다. POST 라우트를 거치면 이 절이 생성 라우트의
      // 정상 동작에 묶여, 그쪽이 깨졌을 때 조회 테스트까지 무더기로 실패한다.
      const once = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '목록의 일회성',
          todoType: 'GENERAL',
          completeType: 'ONCE',
          shouldDoAt: new Date('2026-08-15T09:00:00.000Z'),
        },
      });
      onceTodoId = once.todoId;

      await prisma.todoTemplate.create({
        data: {
          userId,
          title: '목록의 매일 반복',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '2000',
          targetUnit: 'ml',
        },
      });

      await createOtherUsersTodo();
    });

    it('본인의 할 일만 담긴 목록이 200으로 온다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .query({ at: '2026-08-10T09:00:00.000Z' })
        .expect(200);

      const titles = response.body.map((item: { title: string }) => item.title);
      expect(titles).toContain('목록의 일회성');
      expect(titles).toContain('목록의 매일 반복');
      expect(titles).not.toContain('남의 할 일');
    });

    it('항목의 todoId는 문자열이고 날짜는 ISO 문자열이다 (BigInt·Date 직렬화)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .query({ at: '2026-08-10T09:00:00.000Z' })
        .expect(200);

      const once = response.body.find(
        (item: { title: string }) => item.title === '목록의 일회성',
      );
      // BigInt PK는 문자열로 나간다. Number면 2^53 경계에서 다른 행을 가리킨다.
      expect(once.todoId).toBe(String(onceTodoId));
      expect(once.shouldDoAt).toBe('2026-08-15T09:00:00.000Z');
      // 아직 손대지 않은 할 일의 상태는 빈 객체가 아니라 null이다.
      expect(once.progress).toBeNull();
      // 응답에 소유자 번호와 삭제 시각이 새지 않는다.
      expect(once).not.toHaveProperty('userId');
      expect(once).not.toHaveProperty('deletedAt');
    });

    it('at을 생략하면 서버 현재 시각 기준으로 200이다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('해석할 수 없는 at은 400이다', () => {
      return request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .query({ at: '오늘' })
        .expect(400);
    });

    it('X-User-Id 헤더가 없으면 400이다', () => {
      return request(app.getHttpServer()).get('/api/v1/todo').expect(400);
    });

    it('X-User-Id 헤더가 숫자가 아니면 400이다', () => {
      return request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', 'abc')
        .expect(400);
    });
  });

  describe('GET /api/v1/todo/:todoId (상세)', () => {
    const range = {
      from: '2026-08-01T00:00:00.000Z',
      until: '2026-08-10T00:00:00.000Z',
    };
    let dailyTodoId: bigint;

    beforeAll(async () => {
      const daily = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '상세의 매일 반복',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '30',
          targetUnit: '회',
        },
      });
      dailyTodoId = daily.todoId;
    });

    it('본인의 할 일 상세가 200으로 온다 — 매일 반복은 이력 배열을 담는다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/todo/${dailyTodoId}`)
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(200);

      expect(response.body.todoId).toBe(String(dailyTodoId));
      expect(response.body.completeType).toBe('DAILY');
      expect(response.body.histories).toEqual([]);
      // 매일 반복 상세에는 progress가 없다 — 날짜마다 상태가 달라 하나를 고를 수 없다.
      expect(response.body).not.toHaveProperty('progress');
    });

    it('남의 할 일 상세는 404다 — 권한 없음으로 구분해 주지 않는다', async () => {
      const otherTodoId = await createOtherUsersTodo();

      return request(app.getHttpServer())
        .get(`/api/v1/todo/${otherTodoId}`)
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(404);
    });

    it('from을 생략하면 400이다', () => {
      return request(app.getHttpServer())
        .get(`/api/v1/todo/${dailyTodoId}`)
        .set('X-User-Id', userIdHeader)
        .query({ until: range.until })
        .expect(400);
    });

    it('until을 생략하면 400이다', () => {
      return request(app.getHttpServer())
        .get(`/api/v1/todo/${dailyTodoId}`)
        .set('X-User-Id', userIdHeader)
        .query({ from: range.from })
        .expect(400);
    });

    it('비숫자 todoId는 400이다', () => {
      return request(app.getHttpServer())
        .get('/api/v1/todo/abc')
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(400);
    });

    it('2^53을 넘는 todoId도 500 없이 조회된다 (bigint 정밀도)', () => {
      // 존재하지 않는 번호라 404가 맞다 — number로 담다 터지면 500이 난다.
      return request(app.getHttpServer())
        .get('/api/v1/todo/9007199254740993')
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(404);
    });

    it('int8 상한(2^63−1)을 넘는 todoId는 400이다 — 저장 불가능한 번호가 500이 되지 않는다', () => {
      return request(app.getHttpServer())
        .get('/api/v1/todo/99999999999999999999999')
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(400);
    });

    it('int8 상한을 넘는 X-User-Id는 400이다', () => {
      return request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', '99999999999999999999999')
        .expect(400);
    });
  });

  describe('POST /api/v1/todo (생성)', () => {
    it('유효한 본문이면 201로 만들어지고 progress는 null이다', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '생성된 할 일',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: 2000,
          targetUnit: 'ml',
          remindAt: '09:00',
        })
        .expect(201);

      expect(response.body.title).toBe('생성된 할 일');
      expect(typeof response.body.todoId).toBe('string');
      // 방금 만든 정의라 완료 기록이 있을 수 없다.
      expect(response.body.progress).toBeNull();
    });

    it('규칙 위반 본문은 400이다 — NUMERIC인데 목표치가 없다 (assertShape)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '목표 없는 숫자형',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
        })
        .expect(400);

      // 경계(DTO)가 아니라 Service의 조합 규칙이 거절했다는 것을 메시지로 확인한다.
      expect(response.body.message).toContain('목표치와 단위가 함께 필요하다');
    });

    it('DTO에 없는 필드가 섞이면 400이다 (forbidNonWhitelisted)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '이상한 필드',
          todoType: 'GENERAL',
          completeType: 'ONCE',
          userId: 999,
        })
        .expect(400);
    });

    it('remindAt이 HH:mm 형식이 아니면 400이다', () => {
      return request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '형식이 틀린 알림',
          todoType: 'GENERAL',
          completeType: 'ONCE',
          remindAt: '9시',
        })
        .expect(400);
    });

    it('targetValue가 Decimal(12,2) 상한을 넘으면 400이다 — 저장 불가능한 값이 500이 되지 않는다', () => {
      return request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '상한 넘는 목표치',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: 1e13,
          targetUnit: 'ml',
        })
        .expect(400);
    });

    it('targetValue가 Decimal(12,2) 하한을 넘는 음수면 400이다 — numeric field overflow가 500이 되지 않는다', () => {
      return request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '하한 넘는 목표치',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: -1e13,
          targetUnit: 'ml',
        })
        .expect(400);
    });

    it('targetUnit이 16자를 넘으면 400이다 (컬럼이 VarChar(16)이다)', () => {
      return request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '긴 단위',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: 10,
          targetUnit: 'ㄱ'.repeat(17),
        })
        .expect(400);
    });
  });

  describe('PUT /api/v1/todo/:todoId (수정)', () => {
    const range = {
      from: '2026-08-01T00:00:00.000Z',
      until: '2026-08-10T00:00:00.000Z',
    };

    /** 수정 대상 픽스처. 테스트마다 새로 만들어 서로의 수정에 간섭받지 않는다 */
    async function createTargetTodo(): Promise<bigint> {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '수정 전 제목',
          description: '수정 전 설명',
          todoType: 'GENERAL',
          completeType: 'ONCE',
          remindAt: '08:00',
        },
      });

      return row.todoId;
    }

    it('부분 갱신이 204이고, 보내지 않은 필드는 보존되고 null은 비워진다', async () => {
      const todoId = await createTargetTodo();

      await request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .send({ title: '수정 후 제목', remindAt: null })
        .expect(204);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(200);

      expect(response.body.title).toBe('수정 후 제목');
      // 보내지 않은 필드는 그대로다.
      expect(response.body.description).toBe('수정 전 설명');
      // null은 "비우라"다.
      expect(response.body.remindAt).toBeNull();
    });

    it('title에 null을 보내면 400이다 — 비울 수 없는 필수 컬럼이다', async () => {
      const todoId = await createTargetTodo();

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .send({ title: null })
        .expect(400);
    });

    it('todoType을 고치려 하면 400이다 — 만든 뒤 바꿀 수 없다', async () => {
      const todoId = await createTargetTodo();

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .send({ todoType: 'NUMERIC' })
        .expect(400);
    });

    it('남의 할 일 수정은 404다', async () => {
      const otherTodoId = await createOtherUsersTodo();

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${otherTodoId}`)
        .set('X-User-Id', userIdHeader)
        .send({ title: '남의 것 고치기' })
        .expect(404);
    });
  });

  describe('DELETE /api/v1/todo/:todoId (삭제)', () => {
    const range = {
      from: '2026-08-01T00:00:00.000Z',
      until: '2026-08-10T00:00:00.000Z',
    };

    it('삭제가 204이고, 그 뒤 목록과 상세에서 사라진다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '지워질 할 일',
          todoType: 'GENERAL',
          completeType: 'ONCE',
        },
      });

      await request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}`)
        .set('X-User-Id', userIdHeader)
        .expect(204);

      const list = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .expect(200);
      const titles = list.body.map((item: { title: string }) => item.title);
      expect(titles).not.toContain('지워질 할 일');

      await request(app.getHttpServer())
        .get(`/api/v1/todo/${row.todoId}`)
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(404);
    });

    it('이미 지운 할 일을 다시 지우면 404다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '두 번 지워질 할 일',
          todoType: 'GENERAL',
          completeType: 'ONCE',
        },
      });

      await request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}`)
        .set('X-User-Id', userIdHeader)
        .expect(204);

      return request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}`)
        .set('X-User-Id', userIdHeader)
        .expect(404);
    });

    it('남의 할 일 삭제는 404다', async () => {
      const otherTodoId = await createOtherUsersTodo();

      return request(app.getHttpServer())
        .delete(`/api/v1/todo/${otherTodoId}`)
        .set('X-User-Id', userIdHeader)
        .expect(404);
    });
  });

  describe('PUT /api/v1/todo/:todoId/progress (진행값 저장)', () => {
    const performedAt = '2026-08-10T09:00:00.000Z';

    it('진행값을 저장하면 200으로 저장된 상태가 온다 — 목표치를 채워도 완료가 아니다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '진행값을 기록할 할 일',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '2000',
          targetUnit: 'ml',
        },
      });

      const response = await request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 2000, performedAt })
        .expect(200);

      expect(response.body.progressValue).toBe(2000);
      // 기록에 복사된 그날 기준의 목표치다.
      expect(response.body.targetValue).toBe(2000);
      expect(response.body.targetUnit).toBe('ml');
      // 목표치를 채워도 서버가 완료를 찍지 않는다(사용자 확정).
      expect(response.body.isCompleted).toBe(false);
      expect(response.body.completedAt).toBeNull();
    });

    it('GENERAL 할 일에 진행값을 저장하면 400이다 — 진행률을 그릴 기준이 없다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '체크만 하는 할 일',
          todoType: 'GENERAL',
          completeType: 'DAILY',
        },
      });

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 10, performedAt })
        .expect(400);
    });

    it('performedAt이 없으면 400이다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '순간 없는 진행값',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '10',
          targetUnit: '회',
        },
      });

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 5 })
        .expect(400);
    });

    it('progressValue가 Decimal(12,2) 상한을 넘으면 400이다 — 저장 불가능한 값이 500이 되지 않는다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '상한 넘는 진행값',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '10',
          targetUnit: '회',
        },
      });

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 1e13, performedAt })
        .expect(400);
    });

    it('progressValue가 Decimal(12,2) 하한을 넘는 음수면 400이다 — numeric field overflow가 500이 되지 않는다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '하한 넘는 진행값',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '10',
          targetUnit: '회',
        },
      });

      return request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: -1e13, performedAt })
        .expect(400);
    });
  });

  describe('PUT·DELETE /api/v1/todo/:todoId/completion (완료·완료취소)', () => {
    const performedAt = '2026-08-10T09:00:00.000Z';

    it('완료하면 200으로 완료 상태가, 취소하면 200으로 해제된 상태가 온다 (왕복)', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '완료 왕복 할 일',
          todoType: 'GENERAL',
          completeType: 'DAILY',
        },
      });

      const completed = await request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .send({ performedAt })
        .expect(200);

      expect(completed.body.isCompleted).toBe(true);
      expect(completed.body.completedAt).toBe(performedAt);

      // DELETE의 performedAt은 본문이 아니라 쿼리다 — DELETE 본문은 중간 장비가
      // 버릴 수 있다(확정된 라우트 서명).
      const uncompleted = await request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .query({ performedAt })
        .expect(200);

      expect(uncompleted.body.isCompleted).toBe(false);
      expect(uncompleted.body.completedAt).toBeNull();
    });

    it('완료를 취소해도 진행값은 남는다 — 취소는 삭제가 아니라 완료 시각을 비우는 수정이다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '진행값이 남는 취소',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: '100',
          targetUnit: '쪽',
        },
      });

      await request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 30, performedAt })
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .send({ performedAt })
        .expect(200);

      const uncompleted = await request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .query({ performedAt })
        .expect(200);

      expect(uncompleted.body.isCompleted).toBe(false);
      expect(uncompleted.body.progressValue).toBe(30);
    });

    it('기록이 없는 완료취소는 404다 — 빈 행을 만들지 않는다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '기록 없는 취소',
          todoType: 'GENERAL',
          completeType: 'DAILY',
        },
      });

      return request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .query({ performedAt })
        .expect(404);
    });

    it('완료취소의 performedAt을 생략하면 400이다', async () => {
      const row = await prisma.todoTemplate.create({
        data: {
          userId,
          title: '쿼리 없는 취소',
          todoType: 'GENERAL',
          completeType: 'DAILY',
        },
      });

      return request(app.getHttpServer())
        .delete(`/api/v1/todo/${row.todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .expect(400);
    });
  });

  describe('전체 시나리오 — 생성→진행→완료→취소→수정→상세→삭제', () => {
    it('요청 원문의 흐름 전부가 한 번에 지나간다', async () => {
      const performedAt = '2026-08-10T12:00:00.000Z';
      const range = {
        from: '2026-08-01T00:00:00.000Z',
        until: '2026-08-31T00:00:00.000Z',
      };

      // 1. 생성
      const created = await request(app.getHttpServer())
        .post('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .send({
          title: '시나리오 할 일',
          todoType: 'NUMERIC',
          completeType: 'DAILY',
          targetValue: 50,
          targetUnit: '쪽',
        })
        .expect(201);
      const todoId: string = created.body.todoId;

      // 2. 목록에 나온다
      const listed = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .query({ at: performedAt })
        .expect(200);
      expect(
        listed.body.map((item: { todoId: string }) => item.todoId),
      ).toContain(todoId);

      // 3. 진행값 저장
      const progressed = await request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}/progress`)
        .set('X-User-Id', userIdHeader)
        .send({ progressValue: 20, performedAt })
        .expect(200);
      expect(progressed.body.progressValue).toBe(20);

      // 4. 완료
      const completed = await request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .send({ performedAt })
        .expect(200);
      expect(completed.body.isCompleted).toBe(true);
      // 진행값은 그대로 남는다 — 완료는 완료 시각만 바꾼다.
      expect(completed.body.progressValue).toBe(20);

      // 5. 완료취소
      const uncompleted = await request(app.getHttpServer())
        .delete(`/api/v1/todo/${todoId}/completion`)
        .set('X-User-Id', userIdHeader)
        .query({ performedAt })
        .expect(200);
      expect(uncompleted.body.isCompleted).toBe(false);

      // 6. 수정 (부분 갱신)
      await request(app.getHttpServer())
        .put(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .send({ title: '시나리오 할 일 (수정)' })
        .expect(204);

      // 7. 상세 — 수정이 반영되고 이력에 그날 기록이 있다
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .query(range)
        .expect(200);
      expect(detail.body.title).toBe('시나리오 할 일 (수정)');
      expect(detail.body.histories).toHaveLength(1);
      // KST(UTC+9)에서 12:00Z는 21:00 — 같은 날짜다.
      expect(detail.body.histories[0].historiedOn).toBe('2026-08-10');
      expect(detail.body.histories[0].progressValue).toBe(20);
      expect(detail.body.histories[0].isCompleted).toBe(false);

      // 8. 삭제 — 목록에서 사라진다
      await request(app.getHttpServer())
        .delete(`/api/v1/todo/${todoId}`)
        .set('X-User-Id', userIdHeader)
        .expect(204);

      const afterDelete = await request(app.getHttpServer())
        .get('/api/v1/todo')
        .set('X-User-Id', userIdHeader)
        .query({ at: performedAt })
        .expect(200);
      expect(
        afterDelete.body.map((item: { todoId: string }) => item.todoId),
      ).not.toContain(todoId);
    });
  });
});
