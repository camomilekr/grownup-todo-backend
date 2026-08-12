// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { UpdateTodoInput } from '../todos.service';
import { UpdateTodoDto } from './update-todo.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(UpdateTodoDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

describe('UpdateTodoDto', () => {
  it('빈 본문은 통과한다 — 부분 갱신이라 아무것도 고치지 않는 요청도 유효하다', async () => {
    expect(await violationsOf({})).toEqual([]);
  });

  it('title 키를 생략하면 통과한다 ("그대로 두라")', async () => {
    expect(await violationsOf({ description: '설명만 고친다' })).toEqual([]);
  });

  it('title에 null을 보내면 거절한다 — 비울 수 없는 필수 컬럼이다', async () => {
    // `@IsOptional()`은 null과 undefined를 모두 통과시키므로 그것만으로는
    // 이 구분("키 생략 허용, null 거절")을 만들 수 없다.
    expect(await violationsOf({ title: null })).toContain('title');
  });

  it('title이 200자를 넘으면 거절한다', async () => {
    expect(await violationsOf({ title: '가'.repeat(201) })).toContain('title');
  });

  it('빈 title은 거절한다', async () => {
    expect(await violationsOf({ title: '' })).toContain('title');
  });

  it.each([
    ['description'],
    ['remindAt'],
    ['shouldDoAt'],
    ['targetValue'],
    ['targetUnit'],
    ['activeFrom'],
    ['activeUntil'],
  ])('%s에 null을 보내면 통과한다 ("비우라")', async (field) => {
    expect(await violationsOf({ [field]: null })).toEqual([]);
  });

  it('remindAt이 HH:mm 형식이 아니면 거절한다', async () => {
    expect(await violationsOf({ remindAt: '9시 30분' })).toContain('remindAt');
  });

  it('targetValue가 Decimal(12,2) 상한을 넘으면 거절한다', async () => {
    expect(await violationsOf({ targetValue: 1e13 })).toContain('targetValue');
  });

  it('targetValue가 Decimal(12,2) 하한을 넘는 음수면 거절한다', async () => {
    expect(await violationsOf({ targetValue: -1e13 })).toContain('targetValue');
  });

  it('targetUnit이 16자를 넘으면 거절한다 (컬럼이 VarChar(16)이다)', async () => {
    expect(await violationsOf({ targetUnit: 'ㄱ'.repeat(17) })).toContain(
      'targetUnit',
    );
  });

  it('날짜 자리에 해석할 수 없는 문자열이 오면 거절한다', async () => {
    expect(await violationsOf({ activeFrom: '어제쯤' })).toContain(
      'activeFrom',
    );
  });

  it('날짜 문자열이 Date 인스턴스로 변환된다', () => {
    const dto = plainToInstance(UpdateTodoDto, {
      shouldDoAt: '2026-08-15T09:00:00.000Z',
    }) as UpdateTodoDto & { shouldDoAt?: Date };

    expect(dto.shouldDoAt).toBeInstanceOf(Date);
  });

  it('todoType·completeType은 DTO에 없는 필드라 거절한다 — 만든 뒤 바꿀 수 없다', async () => {
    expect(await violationsOf({ todoType: 'GENERAL' })).toContain('todoType');
    expect(await violationsOf({ completeType: 'ONCE' })).toContain(
      'completeType',
    );
  });

  it('DTO에 없는 필드가 섞이면 거절한다 (forbidNonWhitelisted)', async () => {
    expect(await violationsOf({ userId: 1 })).toContain('userId');
  });

  it('Service 입력 타입에 그대로 대입된다', () => {
    const dto = plainToInstance(UpdateTodoDto, { title: '고친 제목' });

    const input: UpdateTodoInput = dto;

    expect(input.title).toBe('고친 제목');
  });
});
