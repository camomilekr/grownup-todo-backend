import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnv } from './env.validation';

/**
 * 배포 설정에 흩어진 포트 값이 서로 어긋나는 것을 막는다.
 *
 * 포트는 이제 환경변수 `PORT`가 정하지만, 그 값이 무엇이든 **같은 파드 안의
 * 다른 선언들과 같아야 한다.** 어긋나면 증상이 원인에서 멀다 — 애플리케이션은
 * 정상 기동해 로그도 깨끗한데 준비 확인(readiness) 프로브만 연결 거부로
 * 실패하고, 파드는 영원히 `0/1 Running`에 머무르거나 재시작을 반복한다.
 *
 * 이 파일들은 서로 다른 언어로 쓰여 있어서 컴파일러도 타입 검사도 불일치를
 * 잡아 주지 않는다. 테스트가 유일한 관문이다.
 *
 * 짝이 되는 소스 파일이 없는 `.spec.ts`인 것은 검사 대상이 TypeScript 코드가
 * 아니라 저장소 루트의 배포 설정 파일이기 때문이다.
 */
describe('배포 설정의 포트 일관성', () => {
  const 저장소루트 = join(__dirname, '..', '..');

  function 파일읽기(...상대경로: string[]): string {
    return readFileSync(join(저장소루트, ...상대경로), 'utf8');
  }

  const dockerfile = 파일읽기('Dockerfile');
  const deployment = 파일읽기('k8s', 'deployment.yaml');
  const service = 파일읽기('k8s', 'service.yaml');

  /**
   * 기본 포트를 모듈 내부 상수가 아니라 `validateEnv`를 지나서 얻는다.
   *
   * 기본값 상수를 테스트를 위해 export하지 않는 이유는, 이 파일이 대조해야 하는
   * 것이 "코드에 적힌 숫자"가 아니라 **환경변수 `PORT`를 주지 않았을 때
   * 애플리케이션이 실제로 여는 포트**이기 때문이다. 검증 함수를 지나 나온 값이
   * 바로 그것이라, 이 경로로 얻으면 기본값을 채우는 코드가 사라지는 회귀까지
   * 함께 걸린다 — 상수만 import하면 그 회귀는 통과한다.
   *
   * `DATABASE_URL`은 검증을 통과시키기 위한 최소 입력이다. 이 함수는 값의 형태만
   * 보고 접속하지 않으므로 실제 접속 문자열이 아니어도 된다.
   */
  const 기본포트 = String(
    validateEnv({ DATABASE_URL: 'postgresql://검증용' }).PORT,
  );

  it('Deployment가 주입하는 PORT 환경변수가 기본 포트와 같다', () => {
    // 기본값과 달라도 애플리케이션은 뜨지만, 그러면 이미지를 쿠버네티스 밖에서
    // 그냥 실행했을 때와 포트가 갈린다. 검증 문서의 명령이 두 벌이 된다
    const port = deployment.match(
      /-\s*name:\s*PORT\s*\n\s*value:\s*['"]?(\d+)['"]?/,
    );

    expect(port?.[1]).toBe(기본포트);
  });

  it('Deployment의 containerPort가 기본 포트와 같다', () => {
    const containerPort = deployment.match(/^\s*-?\s*containerPort:\s*(\d+)/m);

    expect(containerPort?.[1]).toBe(기본포트);
  });

  it('Service의 port가 기본 포트와 같다', () => {
    // Service의 port는 컨테이너 포트와 달라도 동작하지만, 다르게 두면
    // 포트 포워딩 명령과 검증 문서의 주소가 갈린다
    const port = service.match(/^\s*-?\s*port:\s*(\d+)/m);

    expect(port?.[1]).toBe(기본포트);
  });

  it('Dockerfile의 EXPOSE가 기본 포트와 같다', () => {
    // EXPOSE는 실행에 영향을 주지 않는 문서 성격의 선언이다. 그래서 더더욱
    // 조용히 낡는다 — 환경변수를 주지 않고 이미지를 실행하면 애플리케이션은
    // 기본 포트를 열므로, EXPOSE가 가리켜야 할 값은 기본 포트다
    const expose = dockerfile.match(/^EXPOSE\s+(\d+)/m);

    expect(expose?.[1]).toBe(기본포트);
  });

  it('프로브와 Service는 포트를 숫자가 아니라 이름으로 가리킨다', () => {
    // 매니페스트 안에서 포트 숫자가 사는 곳을 줄인다. 프로브가 숫자를 따로
    // 들고 있으면 포트를 바꿀 때 한쪽만 고치는 실수가 나고, 그때 나는 증상이
    // 이 파일 맨 위에 적은 "원인에서 먼 증상"이다
    const 프로브포트들 = deployment.match(/^\s+port:\s*(\S+)/gm) ?? [];

    expect(프로브포트들.length).toBeGreaterThan(0);
    프로브포트들.forEach((줄) => expect(줄).toMatch(/port:\s*http\s*$/));
    expect(service).toMatch(/targetPort:\s*http/);
  });
});
