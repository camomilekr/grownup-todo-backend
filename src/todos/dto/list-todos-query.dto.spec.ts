// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListTodosQueryDto } from './list-todos-query.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(ListTodosQueryDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

describe('ListTodosQueryDto', () => {
  it('at을 생략해도 통과한다 — 서버 현재 시각이 기본이다', async () => {
    expect(await violationsOf({})).toEqual([]);
  });

  it('유효한 at은 Date로 변환된다', async () => {
    const plain = { at: '2026-08-10T09:00:00.000Z' };

    expect(await violationsOf(plain)).toEqual([]);

    const dto = plainToInstance(
      ListTodosQueryDto,
      plain,
    ) as ListTodosQueryDto & { at?: Date };
    expect(dto.at).toBeInstanceOf(Date);
  });

  it('해석할 수 없는 at은 거절한다', async () => {
    expect(await violationsOf({ at: '오늘' })).toContain('at');
  });
});
