import { BadRequestException, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { parseBigIntOrNull } from './parse-bigint.pipe';

/**
 * 요청자 식별자를 실어 오는 헤더. 인증이 없는 동안의 임시 통로다(사용자 확정 —
 * 인증·인가는 user 도메인이 생길 때까지 보류).
 */
export const USER_ID_HEADER = 'x-user-id';

/**
 * `X-User-Id` 헤더에서 요청자 `userId`를 꺼내는 파라미터 데코레이터.
 *
 * **인증이 들어오면 이 구현만 토큰 검증으로 교체한다**(사용자 확정). Controller의
 * 핸들러 서명(`@RequestUserId() userId: bigint`)은 그대로 남는다 — 그것이 헤더
 * 접근을 각 핸들러에 흩뿌리지 않고 데코레이터 하나로 모은 이유다.
 *
 * 파싱 규칙은 경로 파라미터 파이프와 같다(`parseBigIntOrNull`) — `bigint`로
 * 받는 이유도 같다. 기본키가 BIGSERIAL이라 `number`는 2^53 경계에서 다른 행을
 * 가리킨다.
 *
 * @throws {BadRequestException} 헤더가 없거나 십진수 문자열이 아닐 때
 */
export const RequestUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): bigint => {
    const request = ctx.switchToHttp().getRequest<Request>();
    // Express는 헤더 이름을 소문자로 정규화하므로 소문자 키로 읽는다.
    const raw = request.headers[USER_ID_HEADER];

    // 같은 헤더가 여러 번 오면 배열이 된다 — 어느 쪽이 진짜인지 정할 근거가
    // 없으므로 `parseBigIntOrNull`이 문자열이 아닌 값으로 거절한다.
    const parsed = parseBigIntOrNull(raw);
    if (parsed === null) {
      throw new BadRequestException(
        'X-User-Id 헤더가 없거나 int8 범위의 십진수 문자열이 아니다',
      );
    }

    return parsed;
  },
);
