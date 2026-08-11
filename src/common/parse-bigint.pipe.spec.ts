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
    // 자릿수(19)는 상한과 같고 값만 큰 경우다. 길이만 보는 가드로는 걸리지
    // 않으므로 값 비교가 남아 있어야 거절된다.
    ['자릿수는 상한과 같고 값만 큰 것', '9999999999999999999'],
    // 자릿수가 하나 더 많은 경우다. 값 비교까지 가지 않고 길이에서 걸린다.
    ['자릿수가 하나 더 많은 값', '12345678901234567890'],
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

  it('앞자리 0이 아무리 길어도 나머지가 int8 범위면 통과한다', () => {
    // 자릿수 가드가 깨뜨릴 수 있는 자리 중 하나다. 문자열 길이만 세면 값이
    // 42인 입력이 거절되어 **가드를 넣기 전과 반환값이 달라진다** — 앞자리
    // 0은 값에 기여하지 않으므로 자릿수에서 빼야 한다.
    expect(pipe.transform(`${'0'.repeat(100)}42`, metadata)).toBe(42n);
  });

  it('전부 0인 문자열은 자릿수가 아무리 길어도 0으로 통과한다', () => {
    // 자릿수 가드가 깨뜨릴 수 있는 나머지 자리다. 전부 0이면 유효한 자리가
    // 하나도 없어 "앞자리 0이 끝나는 위치"를 찾지 못하는데(-1), 그 경우를
    // 따로 0으로 잡지 않으면 자릿수를 1 크게 세어 상한을 넘는 것으로 오인한다.
    //
    // **19자리 이상이어야 이 단정이 제 일을 한다.** 그보다 짧으면 자릿수를
    // 1 크게 세도 상한(19) 안이라 잘못된 구현에서도 통과해 아무것도 지키지 못한다.
    expect(pipe.transform('0'.repeat(19), metadata)).toBe(0n);
  });

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
