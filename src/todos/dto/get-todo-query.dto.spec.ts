// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetTodoQueryDto } from './get-todo-query.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(GetTodoQueryDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

describe('GetTodoQueryDto', () => {
  const from = '2026-08-01T00:00:00.000Z';
  const until = '2026-08-10T00:00:00.000Z';

  it('from·until이 있으면 통과한다', async () => {
    expect(await violationsOf({ from, until })).toEqual([]);
  });

  it('from을 생략하면 거절한다 — Service의 assertRange가 요구하는 필수 값이다', async () => {
    expect(await violationsOf({ until })).toContain('from');
  });

  it('until을 생략하면 거절한다', async () => {
    expect(await violationsOf({ from })).toContain('until');
  });

  it('해석할 수 없는 값은 거절한다', async () => {
    expect(await violationsOf({ from: '지난주', until })).toContain('from');
  });
});
