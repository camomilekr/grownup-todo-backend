// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CreateTodoInput } from '../todos.service';
import { CreateTodoDto } from './create-todo.dto';

/**
 * `validate()`를 직접 불러 검증 규칙을 고정한다. 전역 `ValidationPipe`와 같은
 * 옵션(whitelist·forbidNonWhitelisted)을 걸어 실제 요청이 지나는 판정과 같게 한다.
 * 파이프·라우팅과 함께 걸린 상태는 `test/todos-http.e2e-spec.ts`가 본다.
 */
async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateTodoDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

/** 유효한 본문을 기본값으로 두고 필요한 필드만 덮어쓴다 */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    title: '물 마시기',
    todoType: 'NUMERIC',
    completeType: 'DAILY',
    targetValue: 2000,
    targetUnit: 'ml',
    ...overrides,
  };
}

describe('CreateTodoDto', () => {
  it('유효한 본문은 통과한다', async () => {
    expect(await violationsOf(validBody())).toEqual([]);
  });

  it('필수·옵션 필드를 전부 채워도 통과한다', async () => {
    expect(
      await violationsOf(
        validBody({
          description: '하루 2리터',
          remindAt: '09:30',
          activeFrom: '2026-08-01T00:00:00.000Z',
          activeUntil: '2026-08-31T00:00:00.000Z',
        }),
      ),
    ).toEqual([]);
  });

  it('title이 없으면 거절한다', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).title;

    expect(await violationsOf(body)).toContain('title');
  });

  it('title이 200자를 넘으면 거절한다 (컬럼이 VarChar(200)이다)', async () => {
    expect(
      await violationsOf(validBody({ title: '가'.repeat(201) })),
    ).toContain('title');
  });

  it('title 200자는 통과한다 (경계값)', async () => {
    expect(await violationsOf(validBody({ title: '가'.repeat(200) }))).toEqual(
      [],
    );
  });

  it('빈 title은 거절한다', async () => {
    expect(await violationsOf(validBody({ title: '' }))).toContain('title');
  });

  it.each([
    ['정의에 없는 값', 'WEEKLY'],
    ['소문자', 'daily'],
  ])('completeType이 %s이면 거절한다', async (_label, completeType) => {
    expect(await violationsOf(validBody({ completeType }))).toContain(
      'completeType',
    );
  });

  it('todoType이 정의에 없는 값이면 거절한다', async () => {
    expect(await violationsOf(validBody({ todoType: 'HABIT' }))).toContain(
      'todoType',
    );
  });

  it.each([
    ['시가 24를 넘는 것', '25:00'],
    ['분이 59를 넘는 것', '09:60'],
    ['구분자가 없는 것', '0930'],
    ['초까지 붙은 것', '09:30:00'],
    ['자릿수가 모자란 것', '9:30'],
  ])('remindAt이 %s이면 거절한다', async (_label, remindAt) => {
    expect(await violationsOf(validBody({ remindAt }))).toContain('remindAt');
  });

  it.each([['00:00'], ['23:59'], ['09:05']])(
    'remindAt %s은 통과한다',
    async (remindAt) => {
      expect(await violationsOf(validBody({ remindAt }))).toEqual([]);
    },
  );

  it('날짜 문자열이 Date 인스턴스로 변환된다', () => {
    const dto = plainToInstance(
      CreateTodoDto,
      validBody({ shouldDoAt: '2026-08-15T09:00:00.000Z' }),
    ) as CreateTodoDto & { shouldDoAt?: Date };

    expect(dto.shouldDoAt).toBeInstanceOf(Date);
    expect(dto.shouldDoAt?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
  });

  it('날짜 자리에 해석할 수 없는 문자열이 오면 거절한다', async () => {
    // 걸러지지 않으면 Invalid Date가 Service로 흘러 자리에 따라 500이 된다.
    expect(await violationsOf(validBody({ shouldDoAt: '어제쯤' }))).toContain(
      'shouldDoAt',
    );
  });

  it('DTO에 없는 필드가 섞이면 거절한다 (forbidNonWhitelisted)', async () => {
    expect(await violationsOf(validBody({ ownerId: 999 }))).toContain(
      'ownerId',
    );
  });

  it('targetValue가 숫자가 아니면 거절한다', async () => {
    expect(await violationsOf(validBody({ targetValue: '2000' }))).toContain(
      'targetValue',
    );
  });

  it('targetValue가 Decimal(12,2) 상한을 넘으면 거절한다', async () => {
    // 컬럼이 numeric(12, 2)라 최대 9,999,999,999.99다. 걸러지지 않으면 DB까지
    // 흘러가 클라이언트 입력 문제가 500으로 나간다.
    expect(await violationsOf(validBody({ targetValue: 1e13 }))).toContain(
      'targetValue',
    );
  });

  it('targetValue가 Decimal(12,2) 상한값이면 통과한다 (경계값)', async () => {
    expect(
      await violationsOf(validBody({ targetValue: 9999999999.99 })),
    ).toEqual([]);
  });

  it('targetValue가 Decimal(12,2) 하한을 넘는 음수면 거절한다', async () => {
    // 하한도 −9,999,999,999.99다. 상한만 막으면 큰 음수가 DB까지 흘러가
    // "numeric field overflow"로 500이 난다.
    expect(await violationsOf(validBody({ targetValue: -1e13 }))).toContain(
      'targetValue',
    );
  });

  it('targetValue가 Decimal(12,2) 하한값이면 통과한다 (경계값 — 음수 자체는 거절하지 않는다)', async () => {
    expect(
      await violationsOf(validBody({ targetValue: -9999999999.99 })),
    ).toEqual([]);
  });

  it('targetUnit이 16자를 넘으면 거절한다 (컬럼이 VarChar(16)이다)', async () => {
    expect(
      await violationsOf(validBody({ targetUnit: 'ㄱ'.repeat(17) })),
    ).toContain('targetUnit');
  });

  it('targetUnit 16자는 통과한다 (경계값)', async () => {
    expect(
      await violationsOf(validBody({ targetUnit: 'ㄱ'.repeat(16) })),
    ).toEqual([]);
  });

  it('Service 입력 타입에 그대로 대입된다', () => {
    const dto = plainToInstance(CreateTodoDto, validBody());

    // 대입이 깨지면 이 파일이 컴파일되지 않는다 — DTO와 Service 입력의 어긋남을
    // typecheck가 잡게 하는 줄이다.
    const input: CreateTodoInput = dto;

    expect(input.title).toBe('물 마시기');
  });
});
