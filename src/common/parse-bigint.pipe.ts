import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

/**
 * 자릿수가 십진 숫자뿐인 문자열만 통과시킨다. 음수·소수점·공백·지수 표기를 전부
 * 거절한다 — 이 값의 쓰임이 BIGSERIAL 기본키라 양의 정수 밖은 전부 잘못된 입력이다.
 */
const DECIMAL_DIGITS_ONLY = /^\d+$/;

/**
 * 앞자리 0이 끝나는 자리, 곧 값에 처음으로 기여하는 숫자를 찾는다. 전부 0이면
 * 찾지 못한다(`search`가 -1) — 그 경우가 값 0이다.
 *
 * `g` 플래그를 붙이지 않는다. **지금 이 상수의 유일한 쓰임인 `search`에서는 붙여도
 * 동작이 달라지지 않는다** — `String.prototype.search`는 매칭 전에 `lastIndex`를 0으로
 * 되돌리고 끝나면 원래 값을 복원하도록 정의돼 있어(ECMA-262의 `RegExp.prototype[@@search]`)
 * 호출 사이에 상태가 남지 않는다. 그런데도 붙이지 않는 것은 나중에 이 상수를 `test()`나
 * `exec()`로 물리는 날을 위한 선택이다. 그쪽은 `lastIndex`를 실제로 다음 자리까지 밀어
 * 두므로, 모듈 상수를 공유하는 요청들이 서로의 검색 위치를 물려받아 같은 입력이 호출
 * 순서에 따라 다른 결과를 낸다.
 */
const FIRST_NON_ZERO_DIGIT = /[^0]/;

/**
 * BIGSERIAL(int8)의 상한, 2^63−1. 이 밖의 번호는 컬럼에 존재할 수 없어 저장·조회
 * 자체가 불가능하다 — 형식은 숫자여도 잘못된 입력이다.
 */
const INT8_MAX = 2n ** 63n - 1n;

/**
 * int8 상한을 십진수로 적었을 때의 자릿수(19). 손으로 적지 않고 상한에서 뽑는다 —
 * 두 값이 따로 살면 한쪽만 고쳐지는 날이 온다.
 */
const INT8_MAX_DIGIT_COUNT = INT8_MAX.toString().length;

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
 *
 * **자릿수 검사는 값 비교와 같은 결론을 더 이른 자리에서 낸다.** 걸러지는 입력의
 * 집합도 반환값도 달라지지 않는다. 이것을 굳이 앞에 두는 이유는 비용의 상한이
 * 이 함수 밖에 있기 때문이다 — `BigInt(문자열)` 파싱은 자릿수가 길어질수록
 * 급격히 비싸지는데, 얼마나 긴 문자열이 여기까지 오는지는 이 코드가 아니라
 * Node HTTP 파서의 헤더 예산(`--max-http-header-size`)이 정한다. 기본값에서는
 * 도달 가능한 최악이 요청당 0.1밀리초대라 문제가 되지 않지만, 그 값을 올려 둔
 * 배포에서는 파싱 비용이 함께 올라간다. 가드는 그 상한을 바깥 설정에 맡기지
 * 않고 이 함수 안으로 가져온다.
 */
export function parseBigIntOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL_DIGITS_ONLY.test(value)) {
    return null;
  }

  // 앞자리 0은 값에 기여하지 않으므로 자릿수에서 뺀다. 문자열 길이를 그대로
  // 재면 `0`을 100개 붙인 `42`가 거절되어 **가드를 넣기 전과 결과가 달라진다.**
  // `search`는 자리만 돌려주므로 잘라 낸 문자열을 새로 만들지 않는다.
  const firstSignificantIndex = value.search(FIRST_NON_ZERO_DIGIT);
  // 전부 0이면 기여하는 자리가 하나도 없다. 여기서 0으로 잡지 않으면 -1을 빼게
  // 되어 자릿수를 1 크게 세고, 0이 열아홉 개인 입력이 상한을 넘는 것으로 오인된다.
  const significantDigitCount =
    firstSignificantIndex === -1 ? 0 : value.length - firstSignificantIndex;

  if (significantDigitCount > INT8_MAX_DIGIT_COUNT) {
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
