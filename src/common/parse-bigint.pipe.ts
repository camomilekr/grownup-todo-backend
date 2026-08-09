import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

/**
 * 자릿수가 십진 숫자뿐인 문자열만 통과시킨다. 음수·소수점·공백·지수 표기를 전부
 * 거절한다 — 이 값의 쓰임이 BIGSERIAL 기본키라 양의 정수 밖은 전부 잘못된 입력이다.
 */
const DECIMAL_DIGITS_ONLY = /^\d+$/;

/**
 * BIGSERIAL(int8)의 상한, 2^63−1. 이 밖의 번호는 컬럼에 존재할 수 없어 저장·조회
 * 자체가 불가능하다 — 형식은 숫자여도 잘못된 입력이다.
 */
const INT8_MAX = 2n ** 63n - 1n;

/**
 * 십진수 문자열을 `bigint`로 바꾼다. 형식이 어긋나거나 int8 상한을 넘으면 `null`이다.
 *
 * **파이프와 헤더 데코레이터(`request-user-id.decorator.ts`)가 공유하는 파싱
 * 규칙이다.** 각자 파싱하면 경로 파라미터와 헤더가 받는 값의 범위가 조용히 갈린다.
 * 무엇이 잘못됐는지 알려 주는 일(예외의 메시지)은 자리를 아는 부르는 쪽이 맡는다.
 *
 * **상한 검사가 여기 있는 이유도 같다.** 상한을 넘는 번호를 흘려보내면 Prisma가
 * int8에 담다 실패해 클라이언트 입력 문제가 500으로 나간다 — 존재할 수 없는 번호는
 * 형식 오류와 같은 자리에서 걸러야 두 통로(경로·헤더)가 같은 판정을 갖는다.
 */
export function parseBigIntOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL_DIGITS_ONLY.test(value)) {
    return null;
  }

  const parsed = BigInt(value);

  return parsed > INT8_MAX ? null : parsed;
}

/**
 * 경로 파라미터를 `bigint`로 바꾸는 파이프.
 *
 * **`ParseIntPipe`를 쓰지 않는 이유는 정밀도다.** 그쪽은 `number`를 돌려주는데
 * 기본키가 BIGSERIAL이라 2^53을 넘을 수 있고, `number`로 담으면 그 경계에서 서로
 * 다른 행이 같은 값이 되어 **다른 행을 가리키는 조회가 조용히 성립한다.**
 *
 * @throws {BadRequestException} 값이 없거나 십진수 문자열이 아닐 때
 */
@Injectable()
export class ParseBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string, metadata: ArgumentMetadata): bigint {
    const parsed = parseBigIntOrNull(value);
    if (parsed === null) {
      // 자리 이름만 담고 받은 값은 담지 않는다 — 경로에 실린 임의 문자열을
      // 응답에 되돌려 주면 그 문자열이 화면에 그대로 꽂히는 통로가 된다.
      throw new BadRequestException(
        `${metadata.data ?? '경로 파라미터'}는 int8 범위의 십진수 문자열이어야 한다`,
      );
    }

    return parsed;
  }
}
