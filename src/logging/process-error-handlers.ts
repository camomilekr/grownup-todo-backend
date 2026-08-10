import { PinoLoggerService } from './pino-logger.service';

/**
 * `uncaughtException`·`unhandledRejection`을 fatal로 남기고 프로세스를
 * 살려 둔다.
 *
 * Node 기본 동작은 uncaughtException에서 즉시 종료인데, 리스너를 다는 것만으로
 * 그 기본이 대체된다 — 여기서 `process.exit()`을 부르지 않는 것이 "서버가
 * 죽지 않는다"의 구현 전부다. Node 공식 문서는 uncaughtException 이후의 계속
 * 실행을 권장하지 않지만(내부 상태가 온전하다는 보장이 없다), 요청 하나의
 * 오류로 파드 전체가 재시작되는 것을 피하는 쪽을 사용자가 명시적으로 택했다.
 *
 * DI Provider가 아니라 함수다 — 프로세스 전역을 만지는 배선이라 Nest
 * 라이프사이클에 묶으면 앱 인스턴스가 여럿일 때(테스트) 리스너가 중복 등록된다.
 * `main.ts`가 부팅 시 한 번 부른다.
 *
 * @returns 등록한 리스너를 해제하는 함수. 프로세스 전역을 만지는 spec이
 *          원상 복구할 수 있게 반드시 함께 반환한다.
 */
export function registerProcessErrorHandlers(
  logger: PinoLoggerService,
): () => void {
  const context = 'ProcessErrorHandlers';

  const onUncaughtException = (error: Error): void => {
    logger.fatal(error, context);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    // reason은 아무 값이나 될 수 있다(`Promise.reject('문자열')`) — Error가
    // 아니면 감싸서 스택은 없어도 사유는 구조화되게 한다
    const error =
      reason instanceof Error
        ? reason
        : new Error(`처리되지 않은 Promise 거절: ${String(reason)}`);
    logger.fatal(error, context);
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}
