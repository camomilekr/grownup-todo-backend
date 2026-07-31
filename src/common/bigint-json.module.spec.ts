import { Test } from '@nestjs/testing';
import { BigIntJsonModule } from './bigint-json.module';

/**
 * 이 spec은 **호출 지점**을 검증한다. `bigint-json.spec.ts`가 함수 자체를 보는 것과
 * 역할이 다르다.
 *
 * `main.ts`의 `bootstrap()`은 `npm test`도 `npm run test:e2e`도 실행하지 않는다.
 * e2e는 `createNestApplication()`으로 앱을 만들어 `main.ts`를 아예 거치지 않는다.
 * 그래서 호출을 부트스트랩에만 두면 **아무 테스트도 지나지 않는 코드**가 되고,
 * 지워도 세 명령이 다 통과한다. 모듈 초기화로 옮겨야 테스트와 프로덕션이 같은
 * 직렬화 상태를 본다.
 */
type BigIntProto = { toJSON?: () => string };

describe('BigIntJsonModule', () => {
  // 전역 프로토타입을 건드리는 테스트다. 원래 상태를 저장해 두고 되돌린다 —
  // jest는 같은 워커에서 여러 spec 파일이 프로세스 전역을 공유하므로, 누출을
  // 남기면 실행 순서에 따라 통과하는 테스트가 만들어진다.
  const originalToJSON = (BigInt.prototype as BigIntProto).toJSON;

  beforeEach(() => {
    // 켜지지 않은 상태에서 출발해야 "모듈이 켰다"를 확인할 수 있다.
    delete (BigInt.prototype as BigIntProto).toJSON;
  });

  afterAll(() => {
    const proto = BigInt.prototype as BigIntProto;
    if (originalToJSON) {
      proto.toJSON = originalToJSON;
    } else {
      delete proto.toJSON;
    }
  });

  it('모듈을 초기화하기 전에는 BigInt 직렬화가 꺼져 있다', () => {
    // 이 단정이 아래 테스트의 전제다. 이것이 깨지면 다른 곳에서 이미 켠 것이고,
    // 그러면 아래 테스트가 모듈 덕분에 통과하는 것인지 알 수 없다.
    expect(() => JSON.stringify({ id: 1n })).toThrow(TypeError);
  });

  it('모듈이 초기화되면 BigInt 직렬화가 켜진다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BigIntJsonModule],
    }).compile();

    await moduleRef.init();

    expect(JSON.stringify({ id: 1n })).toBe('{"id":"1"}');

    await moduleRef.close();
  });
});
