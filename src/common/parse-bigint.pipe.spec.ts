import { BadRequestException } from '@nestjs/common';
import { ParseBigIntPipe } from './parse-bigint.pipe';

describe('ParseBigIntPipe', () => {
  const pipe = new ParseBigIntPipe();
  // 경로 파라미터라는 것을 알려 주는 메타데이터. 오류 메시지가 자리 이름을 담는다.
  const metadata = { type: 'param', data: 'todoId' } as const;

  it('십진수 문자열을 bigint로 바꾼다', () => {
    expect(pipe.transform('42', metadata)).toBe(42n);
  });

  it('2^53을 넘는 값도 정밀도를 잃지 않고 보존한다', () => {
    // Number를 거치면 2^53 + 1이 2^53과 같은 값이 되어 다른 행을 가리킨다.
    expect(pipe.transform('9007199254740993', metadata)).toBe(
      9007199254740993n,
    );
  });

  it('int8 상한(2^63−1)까지는 통과한다 (경계값)', () => {
    expect(pipe.transform('9223372036854775807', metadata)).toBe(
      9223372036854775807n,
    );
  });

  it.each([
    ['상한 바로 다음 값', '9223372036854775808'],
    ['자릿수가 한참 넘는 값', '99999999999999999999999'],
  ])(
    'int8 상한을 넘는 %s은 BadRequestException으로 거절한다',
    (_label, value) => {
      // 기본키가 BIGSERIAL(int8)이라 이 밖의 값은 저장·조회 자체가 불가능하다.
      // 거르지 않으면 Prisma까지 흘러가 클라이언트 입력 문제가 500으로 나간다.
      expect(() => pipe.transform(value, metadata)).toThrow(
        BadRequestException,
      );
    },
  );

  it.each([
    ['비숫자 문자열', 'abc'],
    ['소수점이 섞인 문자열', '1.5'],
    ['음수', '-1'],
    ['빈 문자열', ''],
    ['숫자에 다른 문자가 붙은 것', '12abc'],
    ['공백이 섞인 것', ' 12'],
  ])('%s은 BadRequestException으로 거절한다', (_label, value) => {
    expect(() => pipe.transform(value, metadata)).toThrow(BadRequestException);
  });

  it('값이 없으면 BadRequestException으로 거절한다', () => {
    // strictNullChecks가 꺼져 있어 undefined가 넘어오는 호출을 컴파일러가 막지
    // 못한다. 그대로 두면 BigInt(undefined)가 TypeError를 던져 500이 된다.
    expect(() => pipe.transform(undefined, metadata)).toThrow(
      BadRequestException,
    );
  });

  it('거절 메시지에 자리 이름이 담긴다', () => {
    expect(() => pipe.transform('abc', metadata)).toThrow(/todoId/);
  });
});
