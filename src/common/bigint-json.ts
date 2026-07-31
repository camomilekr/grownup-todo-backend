/**
 * `BigInt`를 JSON으로 직렬화할 수 있게 만든다.
 *
 * 모든 PK가 `BIGSERIAL`이라 Prisma가 돌려주는 값이 `bigint`다. 그런데
 * `JSON.stringify`는 `bigint`를 만나면 `TypeError: Do not know how to serialize
 * a BigInt`로 죽는다 — 응답 직렬화 시점이라 컨트롤러 코드에는 아무 흔적이 없고
 * 500만 나간다. 필드마다 `.toString()`을 부르는 대응은 하나 빠뜨리면 그 엔드포인트가
 * 죽으므로, 한 곳에서 프로토타입에 `toJSON`을 심는다.
 *
 * **숫자가 아니라 문자열로 내보낸다.** `Number`로 바꾸면 2^53을 넘는 PK에서 정밀도가
 * 조용히 깨져 다른 행을 가리키는 ID가 클라이언트에 전달된다.
 *
 * 호출 지점은 `BigIntJsonModule`의 `onModuleInit` 하나다 — 직접 부르지 마라.
 * 여러 번 불러도 같은 구현으로 덮어쓰는 것뿐이라 안전하다.
 */
export function enableBigIntJsonSerialization(): void {
  // `declare global`로 전역 `BigInt` 인터페이스를 확장하지 않는다. 확장하면 프로그램
  // 전체에서 `someBigInt.toJSON()`이 typecheck를 통과하는데, 이 함수를 부르지 않은
  // 경로에서는 런타임에 `toJSON is not a function`으로 죽는다 — 타입이 런타임 보장
  // 없이 존재를 약속하게 된다. 대신 이 한 줄에서만 좁은 타입으로 단언한다.
  //
  // `JSON.stringify`는 프로퍼티 이름으로 `toJSON`을 찾으므로 타입 선언과 무관하게
  // 동작한다. 값을 직접 문자열로 바꿀 때는 `String(value)`를 쓴다.
  (BigInt.prototype as { toJSON?: () => string }).toJSON = function toJSON(
    this: bigint,
  ): string {
    return this.toString();
  };
}
