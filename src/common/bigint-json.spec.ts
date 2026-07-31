import { enableBigIntJsonSerialization } from './bigint-json';

/** 전역 프로토타입을 원래대로 되돌린다. */
function restoreToJSON(original: (() => string) | undefined): void {
  const proto = BigInt.prototype as { toJSON?: () => string };
  if (original) {
    proto.toJSON = original;
  } else {
    delete proto.toJSON;
  }
}

describe('enableBigIntJsonSerialization', () => {
  // 이 함수는 **프로세스 전역**을 바꾼다. jest는 같은 워커에서 여러 spec 파일을
  // 돌리므로 누출을 남기면 실행 순서에 따라 통과하는 테스트가 만들어진다 —
  // `--runInBand`, `-t` 필터, 워커 수 변경에서 결과가 갈린다. "부르는 것이 멱등이라
  // 무해하다"는 반대 방향만 본 것이다: 위험한 쪽은 **다른 spec이 켜진 상태를
  // 물려받는 것**이다.
  const originalToJSON = (BigInt.prototype as { toJSON?: () => string }).toJSON;

  beforeAll(() => {
    enableBigIntJsonSerialization();
  });

  afterAll(() => {
    restoreToJSON(originalToJSON);
  });

  it('BigInt가 들어간 객체를 JSON.stringify로 직렬화할 수 있다', () => {
    expect(JSON.stringify({ id: 1n })).toBe('{"id":"1"}');
  });

  it('숫자가 아니라 문자열로 직렬화한다', () => {
    // Number로 내보내면 2^53을 넘는 PK에서 정밀도가 조용히 깨진다.
    // BIGSERIAL PK가 그 범위에 도달할 수 있으므로 문자열이어야 한다.
    const beyondSafeInteger = 2n ** 60n;

    expect(JSON.stringify({ id: beyondSafeInteger })).toBe(
      `{"id":"${beyondSafeInteger.toString()}"}`,
    );
  });

  it('음수와 0도 문자열로 직렬화한다', () => {
    expect(JSON.stringify({ zero: 0n, negative: -42n })).toBe(
      '{"zero":"0","negative":"-42"}',
    );
  });

  it('중첩된 객체와 배열 안의 BigInt도 직렬화한다', () => {
    expect(JSON.stringify({ rows: [{ id: 7n }] })).toBe(
      '{"rows":[{"id":"7"}]}',
    );
  });

  it('여러 번 불러도 동작이 바뀌지 않는다', () => {
    // main.ts와 테스트가 각각 부를 수 있으므로 멱등이어야 한다.
    enableBigIntJsonSerialization();
    enableBigIntJsonSerialization();

    expect(JSON.stringify({ id: 3n })).toBe('{"id":"3"}');
  });

  it('BigInt가 아닌 값의 직렬화는 그대로 둔다', () => {
    expect(JSON.stringify({ n: 1, s: '2', b: true, nil: null })).toBe(
      '{"n":1,"s":"2","b":true,"nil":null}',
    );
  });
});
