// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UncompleteTodoQueryDto } from './uncomplete-todo-query.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(
    plainToInstance(UncompleteTodoQueryDto, plain),
    {
      whitelist: true,
      forbidNonWhitelisted: true,
    },
  );

  return errors.map((error) => error.property);
}

describe('UncompleteTodoQueryDto', () => {
  it('유효한 performedAt은 통과한다', async () => {
    expect(
      await violationsOf({ performedAt: '2026-08-10T09:00:00.000Z' }),
    ).toEqual([]);
  });

  it('performedAt을 생략하면 거절한다 — 어느 날짜의 기록을 취소하는지 정하는 값이다', async () => {
    expect(await violationsOf({})).toContain('performedAt');
  });

  it('해석할 수 없는 값은 거절한다', async () => {
    expect(await violationsOf({ performedAt: '오늘' })).toContain(
      'performedAt',
    );
  });
});
