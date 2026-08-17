import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_PREFIX } from '../app-setup';
import { HEALTH_PING_PATH, HEALTH_READY_PATH } from './health.controller';

/**
 * 배포 매니페스트의 프로브 배선이 이 폴더의 설계와 어긋나는 것을 막는다.
 *
 * **여기서 잡으려는 어긋남은 전부 오류를 내지 않는다.** 매니페스트는 어떤 경로를
 * 적어도 문법적으로 옳고, 프로브가 200을 받는 한 파드는 `1/1 Running`이라
 * 사람이 보는 화면에서는 정상과 구별되지 않는다. 조용히 사라지는 것은 종료 절차의
 * 안전성뿐이다.
 *
 * 고정하는 것은 규칙 넷이다 — 생존·기동 확인은 `ping`, 준비 확인은 `ready`, 그리고
 * 준비 확인의 실패 판정이 드레인 대기보다 짧다. **각 규칙이 어긋났을 때 어느 종료
 * 경로에서 무엇을 잃는지는 `docs/k8s-local-verification.md`의 ① 절 한 곳에 실측과
 * 함께 있다** — 그 인과를 여기에 옮겨 적지 마라. 여러 곳에서 다시 유도하다 한쪽만
 * 고쳐지는 일이 반복됐다.
 *
 * 매니페스트는 YAML이고 코드는 TypeScript라 컴파일러도 타입 검사도 이 불일치를
 * 보지 못한다. 테스트가 유일한 관문이다 — 짝이 되는 소스 파일이 없는 `.spec.ts`인
 * 이유도 검사 대상이 코드가 아니라 저장소의 배포 설정 파일이기 때문이다
 * (`src/config/deployment-port.spec.ts`와 같은 근거).
 *
 * YAML 파서를 쓰지 않고 정규식으로 읽는다. `js-yaml`은 이 저장소의 직접 의존성이
 * 아니라(다른 도구가 끌고 들어온 전이 의존성일 뿐) 그것에 기대면 관계없는
 * 의존성 갱신에 테스트가 깨진다.
 */
describe('배포 매니페스트의 프로브 배선', () => {
  const deployment = readFileSync(
    join(__dirname, '..', '..', 'k8s', 'deployment.yaml'),
    'utf8',
  );

  const 생존확인경로 = `/${API_PREFIX}/${HEALTH_PING_PATH}`;
  const 준비확인경로 = `/${API_PREFIX}/${HEALTH_READY_PATH}`;

  /**
   * 프로브 하나의 설정 블록만 잘라낸다. 블록으로 좁히지 않으면 `path:`·
   * `periodSeconds:`가 어느 프로브의 것인지 구별할 수 없다.
   *
   * 들여쓰기가 블록의 경계다 — 시작 줄보다 깊은 줄만 그 블록에 속한다.
   * 주석과 빈 줄은 들여쓰기 판정에 넣지 않는다. 이 파일들은 주석이 길고,
   * 주석의 들여쓰기는 블록 구조와 무관하게 붙기 때문이다.
   */
  function 프로브블록(프로브이름: string): string {
    const 줄들 = deployment.split('\n');
    const 시작 = 줄들.findIndex((줄) =>
      new RegExp(`^\\s*${프로브이름}:\\s*$`).test(줄),
    );
    if (시작 < 0) {
      throw new Error(`매니페스트에 ${프로브이름}가 없다`);
    }

    const 기준들여쓰기 = 줄들[시작].search(/\S/);
    const 본문: string[] = [];
    for (const 줄 of 줄들.slice(시작 + 1)) {
      const 내용 = 줄.trim();
      if (내용 === '' || 내용.startsWith('#')) {
        continue;
      }
      if (줄.search(/\S/) <= 기준들여쓰기) {
        break;
      }
      본문.push(줄);
    }
    return 본문.join('\n');
  }

  function 프로브경로(프로브이름: string): string | undefined {
    return 프로브블록(프로브이름).match(/path:\s*(\S+)/)?.[1];
  }

  function 프로브숫자(프로브이름: string, 필드: string): number {
    const 값 = 프로브블록(프로브이름).match(
      new RegExp(`${필드}:\\s*(\\d+)`),
    )?.[1];
    if (값 === undefined) {
      throw new Error(`${프로브이름}에 ${필드}가 없다`);
    }
    return Number(값);
  }

  it('준비 확인은 종료 중에 503이 되는 경로를 본다', () => {
    expect(프로브경로('readinessProbe')).toBe(준비확인경로);
  });

  it('생존 확인은 종료 중에도 200인 경로를 본다', () => {
    // 이 단정이 지키는 것은 "ping이다"가 아니라 "ready가 아니다"에 가깝다.
    // **이 어긋남은 이 저장소의 클러스터 검증 절차(파드 삭제·재배포)로는 만들 수
    // 없다**(근거는 검증 문서 ① 절) — 그래서 넷 중 테스트에 가장 많이 의존한다
    expect(프로브경로('livenessProbe')).toBe(생존확인경로);
  });

  it('기동 확인도 종료와 무관한 경로를 본다', () => {
    // 기동 확인은 "프로세스가 요청을 받을 수 있는가"만 물어야 한다. 준비 확인
    // 경로를 쓰면 미래에 "종료 중" 외의 미준비 조건(캐시 예열 등)이 붙는 날
    // 기동 확인이 그 조건에 묶여 재시작 고리에 빠진다
    expect(프로브경로('startupProbe')).toBe(생존확인경로);
  });

  it('준비 확인이 실패로 판정되는 시간이 드레인 대기보다 짧다', () => {
    // 매니페스트가 드레인 대기를 명시적으로 주입한다. 기본값에 맡기면 이 단정이
    // 검사할 짝이 매니페스트 안에 없어, 프로브 값만 보고는 양립을 판단할 수 없다
    const 드레인대기 = deployment.match(
      /-\s*name:\s*SHUTDOWN_DRAIN_DELAY_MS\s*\n\s*value:\s*['"]?(\d+)['"]?/,
    )?.[1];
    expect(드레인대기).toBeDefined();

    // 최악의 경우를 센다 — 매 시도가 시간 초과까지 버티고 실패 허용 횟수를 모두
    // 소진하는 경로다. kubelet은 프로브 하나가 끝난 뒤 주기만큼 쉬고 다시
    // 시도하므로 시도 간격이 `periodSeconds + timeoutSeconds`까지 늘어난다
    const 최악판정시간 =
      (프로브숫자('readinessProbe', 'periodSeconds') +
        프로브숫자('readinessProbe', 'timeoutSeconds')) *
      프로브숫자('readinessProbe', 'failureThreshold') *
      1000;

    // 판정이 끝난 시점부터 각 노드의 전달 규칙이 갱신될 때까지도 시간이 든다.
    // 그 몫을 남기지 않으면 "판정은 제때 됐는데 전파 중에 HTTP가 닫히는" 자리로
    // 그대로 되돌아간다. 정확한 값을 측정할 수 없는 구간이라 예산으로 잡는다
    const 전파여유 = 2_000;

    expect(최악판정시간 + 전파여유).toBeLessThan(Number(드레인대기));
  });
});
