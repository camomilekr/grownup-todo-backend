import { PinoLoggerService } from './pino-logger.service';
import { registerProcessErrorHandlers } from './process-error-handlers';

describe('registerProcessErrorHandlers', () => {
  let fatalCalls: unknown[][];
  let fakeLogger: PinoLoggerService;
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    fatalCalls = [];
    fakeLogger = {
      fatal: (...args: unknown[]) => {
        fatalCalls.push(args);
      },
    } as unknown as PinoLoggerService;
  });

  // 프로세스 전역(리스너)을 만지므로 반드시 원상 복구한다 — 누출되면 다른
  // spec 파일이 등록된 상태를 물려받아 실행 순서에 따라 결과가 갈린다
  afterEach(() => {
    unregister?.();
    unregister = undefined;
    jest.restoreAllMocks();
  });

  /**
   * 등록 전후의 리스너 차집합으로 이번에 등록된 리스너를 얻는다.
   * `process.emit(event, …)`로 진짜 발화시키면 jest 자체의 리스너까지 불려
   * 테스트 러너가 오작동한다 — 우리 리스너만 직접 부른다.
   */
  function captureAddedListener(
    event: 'uncaughtException' | 'unhandledRejection',
    register: () => () => void,
  ): (...args: unknown[]) => void {
    // `process.listeners`의 오버로드가 이벤트 이름 유니언을 받지 못해 한쪽
    // 리터럴로 단언한다 — 리스너 배열 비교에는 이벤트별 타입 차이가 없다
    const eventName = event as 'uncaughtException';
    const before = process.listeners(eventName);
    unregister = register();
    const added = process
      .listeners(eventName)
      .filter((listener) => !before.includes(listener));

    expect(added).toHaveLength(1);
    return added[0] as (...args: unknown[]) => void;
  }

  it('uncaughtException을 fatal로 남긴다', () => {
    const listener = captureAddedListener('uncaughtException', () =>
      registerProcessErrorHandlers(fakeLogger),
    );

    const error = new Error('잡히지 않은 예외');
    listener(error, 'uncaughtException');

    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0][0]).toBe(error);
  });

  it('unhandledRejection을 fatal로 남긴다', () => {
    const listener = captureAddedListener('unhandledRejection', () =>
      registerProcessErrorHandlers(fakeLogger),
    );

    const reason = new Error('처리되지 않은 거절');
    listener(reason, Promise.resolve());

    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0][0]).toBe(reason);
  });

  it('Error가 아닌 rejection 사유도 fatal로 남긴다', () => {
    // Promise.reject('문자열')처럼 reason은 아무 값이나 될 수 있다
    const listener = captureAddedListener('unhandledRejection', () =>
      registerProcessErrorHandlers(fakeLogger),
    );

    listener('문자열 사유', Promise.resolve());

    expect(fatalCalls).toHaveLength(1);
    expect(fatalCalls[0][0]).toBeInstanceOf(Error);
    expect((fatalCalls[0][0] as Error).message).toContain('문자열 사유');
  });

  it('오류를 받아도 process.exit을 부르지 않는다', () => {
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const listener = captureAddedListener('uncaughtException', () =>
      registerProcessErrorHandlers(fakeLogger),
    );

    listener(new Error('잡히지 않은 예외'), 'uncaughtException');

    expect(exit).not.toHaveBeenCalled();
  });

  it('반환된 해제 함수가 등록한 리스너를 전부 제거한다', () => {
    const beforeUncaught = process.listeners('uncaughtException');
    const beforeRejection = process.listeners('unhandledRejection');

    const dispose = registerProcessErrorHandlers(fakeLogger);
    dispose();

    expect(process.listeners('uncaughtException')).toEqual(beforeUncaught);
    expect(process.listeners('unhandledRejection')).toEqual(beforeRejection);
  });
});
