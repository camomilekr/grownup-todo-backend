// class-transformer·class-validator는 데코레이터 메타데이터를 읽으므로 먼저 로드한다.
// 앱 경로에서는 NestJS가 대신 로드하지만 이 spec은 프레임워크 없이 validate()를 직접 부른다.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { SaveProgressInput } from '../todos.service';
import { SaveProgressDto } from './save-progress.dto';

async function violationsOf(plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(SaveProgressDto, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((error) => error.property);
}

describe('SaveProgressDto', () => {
  const performedAt = '2026-08-10T09:00:00.000Z';

  it('유효한 본문은 통과한다', async () => {
    expect(await violationsOf({ progressValue: 500, performedAt })).toEqual([]);
  });

  it('progressValue 0은 통과한다 — 저장하지 않은 것과 다른 유효한 입력이다', async () => {
    expect(await violationsOf({ progressValue: 0, performedAt })).toEqual([]);
  });

  it('progressValue가 없으면 거절한다', async () => {
    expect(await violationsOf({ performedAt })).toContain('progressValue');
  });

  it('progressValue가 숫자가 아니면 거절한다', async () => {
    expect(await violationsOf({ progressValue: '500', performedAt })).toContain(
      'progressValue',
    );
  });

  it('progressValue가 Decimal(12,2) 상한을 넘으면 거절한다', async () => {
    // 컬럼이 numeric(12, 2)라 최대 9,999,999,999.99다. 걸러지지 않으면 DB까지
    // 흘러가 클라이언트 입력 문제가 500으로 나간다.
    expect(await violationsOf({ progressValue: 1e13, performedAt })).toContain(
      'progressValue',
    );
  });

  it('progressValue가 Decimal(12,2) 상한값이면 통과한다 (경계값)', async () => {
    expect(
      await violationsOf({ progressValue: 9999999999.99, performedAt }),
    ).toEqual([]);
  });

  it('progressValue가 Decimal(12,2) 하한을 넘는 음수면 거절한다', async () => {
    // 하한도 −9,999,999,999.99다. 상한만 막으면 큰 음수가 DB까지 흘러가
    // "numeric field overflow"로 500이 난다.
    expect(await violationsOf({ progressValue: -1e13, performedAt })).toContain(
      'progressValue',
    );
  });

  it('저장 가능한 음수 progressValue는 통과한다 — 음수 자체를 거절하지 않는다 (확정 문서 없음)', async () => {
    expect(await violationsOf({ progressValue: -5, performedAt })).toEqual([]);
  });

  it('performedAt이 없으면 거절한다', async () => {
    expect(await violationsOf({ progressValue: 500 })).toContain('performedAt');
  });

  it('performedAt이 해석할 수 없는 문자열이면 거절한다', async () => {
    expect(
      await violationsOf({ progressValue: 500, performedAt: '오늘' }),
    ).toContain('performedAt');
  });

  it('Service 입력 타입에 그대로 대입된다', () => {
    const dto = plainToInstance(SaveProgressDto, {
      progressValue: 500,
      performedAt,
    });

    const input: SaveProgressInput = dto;

    expect(input.progressValue).toBe(500);
  });
});
