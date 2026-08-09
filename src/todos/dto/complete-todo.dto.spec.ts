// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompleteTodoDto } from './complete-todo.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(CompleteTodoDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

describe('CompleteTodoDto', () => {
  it('유효한 본문은 통과하고 Date로 변환된다', async () => {
    const plain = { performedAt: '2026-08-10T09:00:00.000Z' };

    expect(await violationsOf(plain)).toEqual([]);

    const dto = plainToInstance(CompleteTodoDto, plain) as CompleteTodoDto & {
      performedAt: Date;
    };
    expect(dto.performedAt).toBeInstanceOf(Date);
  });

  it('performedAt이 없으면 거절한다', async () => {
    expect(await violationsOf({})).toContain('performedAt');
  });

  it('performedAt이 해석할 수 없는 문자열이면 거절한다', async () => {
    expect(await violationsOf({ performedAt: '오늘' })).toContain(
      'performedAt',
    );
  });

  it('진행값을 함께 실으면 거절한다 — 완료는 완료 시각 하나만 받는다', async () => {
    expect(
      await violationsOf({
        performedAt: '2026-08-10T09:00:00.000Z',
        progressValue: 500,
      }),
    ).toContain('progressValue');
  });
});
