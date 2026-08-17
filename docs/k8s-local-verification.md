# 로컬 쿠버네티스에서 검증하기

Docker Desktop에 들어 있는 쿠버네티스로 이 서버를 실제로 띄우고, 아래 세 가지가
**진짜 쿠버네티스의 종료 절차에서도** 작동하는지 확인하는 절차다.

1. 프로브 경로 **둘**이 각자의 역할로 동작한다 — `GET /api/v1/ping`은 생존
   확인(liveness)·기동 확인(startup)용이라 **종료 중에도 200**이고,
   `GET /api/v1/ready`는 준비 확인(readiness)용이라 **종료가 시작되면 503**이다
2. 종료 신호(SIGTERM)를 받으면 드레인(요청을 계속 받으며 대기) → HTTP 서버 닫기
   (처리 중 요청 완료 대기) → 자원 해제 순서를 밟는다
3. 종료 직전에 남긴 로그가 유실되지 않고 `kubectl logs`에 남는다

그리고 이 셋이 모두 맞을 때 나오는 결과인 **"재배포 중 실패한 요청 0건"**을 직접 센다.

이 문서에 적힌 명령은 전부 실제로 실행해 확인한 것이고, 붙여 놓은 출력도 그때
받은 것이다(마지막 실측 2026-08-17, Docker Desktop 쿠버네티스 v1.36.1).

---

## 0. 준비

### Docker Desktop의 쿠버네티스를 켠다

Docker Desktop > Settings > Kubernetes > **Enable Kubernetes** 체크 > Apply & Restart.
처음 켜면 클러스터를 만드는 데 몇 분 걸린다.

준비됐는지 확인한다.

```bash
kubectl config use-context docker-desktop
kubectl get nodes
```

```
NAME                    STATUS   ROLES           AGE     VERSION
desktop-control-plane   Ready    control-plane   5h37m   v1.36.1
```

### 데이터베이스는 클러스터 밖에 있다

이 서버는 Supabase의 PostgreSQL에 붙는다. 클러스터 안에 데이터베이스를 띄우지
않으므로, 인터넷과 `.env`의 `DATABASE_URL`만 있으면 된다.

### 작업 위치

아래 명령은 모두 **저장소 루트**에서 실행한다.

---

## 1. 이미지를 만든다

```bash
docker build -t grownup-todo-backend:local .
```

레지스트리에 올리지 않는다. Docker Desktop의 쿠버네티스는 호스트의 이미지
저장소를 그대로 참조하므로, 방금 만든 이미지를 클러스터가 바로 쓴다.

만들어졌는지 확인한다.

```bash
docker images grownup-todo-backend
```

```
IMAGE                        ID             DISK USAGE   CONTENT SIZE
grownup-todo-backend:local   fcb1c9e86a14        848MB          178MB
```

> **코드를 고친 뒤에는 반드시 이 명령을 다시 돌려야 한다.** 태그가 같아도
> 내용은 바뀌므로, 다시 만들지 않으면 옛 이미지가 그대로 뜬다. 매니페스트의
> `imagePullPolicy: Always`가 "다시 만든 이미지를 확실히 집어 오는" 쪽은
> 책임지지만, "다시 만드는 것" 자체는 사람이 해야 한다.

---

## 2. 접속 정보를 Secret으로 넣는다

접속 문자열은 이미지에도 매니페스트에도 들어 있지 않다. 클러스터에 따로 넣는다.

**이 절차는 이 문서에만 있다.** `k8s/secret.example.yaml`은 값을 채울 자리와
형태만 보여 주고 절차를 다시 적지 않는다 — 같은 절차를 두 곳에 두면 갈라지고,
실제로 한 번 갈라졌다.

### 예시 파일을 복사해 채운다

```bash
cp k8s/secret.example.yaml k8s/secret.yaml
```

`k8s/secret.yaml`을 열어 `DATABASE_URL: ''`의 따옴표 사이에 `.env`의
`DATABASE_URL` 값을 붙여 넣는다.

```yaml
stringData:
  DATABASE_URL: 'postgresql://postgres.xxxx:비밀번호@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres'
```

> **값을 감싼 큰따옴표는 빼고 내용만 넣는다.** `.env`에
> `DATABASE_URL="postgresql://..."`처럼 적혀 있으면 큰따옴표는 셸의 문법이라
> 값이 아니다. 따옴표가 값에 섞이면 접속 문자열 검증에 걸려 파드가
> `CrashLoopBackOff`가 되고, 로그에는
> `환경변수 DATABASE_URL이 postgres 접속 문자열이 아니다`만 남는다(실측).

`k8s/secret.yaml`은 `.gitignore`와 `.dockerignore` 양쪽에 등록되어 있어 커밋되지도,
이미지에 실리지도 않는다. 이름에 `secret`이 든 매니페스트는 전부 같은 방어선
안에 있으므로(`k8s/db-secret.yaml` 등) 다른 이름을 붙여도 커밋 후보로 올라오지
않는다.

### `.env`에서 바로 만드는 방법은 권장하지 않는다

`kubectl create secret generic ... --from-env-file=.env`는 한 줄로 끝나 보이지만
**이 저장소에서는 그대로 쓰면 실패한다.** `--from-env-file`은 값을 감싼 큰따옴표를
벗겨 주지 않고(실측), 이 저장소의 `.env`는 값에 큰따옴표를 쓴다. 위의 파일 복사
방법을 쓴다.

`.env`의 값에 따옴표가 없는 것을 직접 확인했다면 쓸 수 있다. 그때는 이름공간이
먼저 있어야 하므로 3단계의 첫 명령을 앞서 실행한다.

---

## 3. 배포한다

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml        # kubectl create secret으로 만들었다면 건너뛴다
kubectl apply -f k8s/deployment.yaml -f k8s/service.yaml
```

> **파일을 하나씩, 이 순서대로 지정한다. `kubectl apply -f k8s/`처럼 폴더째
> 넘기지 마라.** 폴더를 넘기면 `kubectl`이 파일명 순으로 처리하는데, 이
> 폴더에서는 `deployment.yaml`이 `namespace.yaml`보다 앞이다. 이름공간이 아직
> 없는 상태에서 Deployment를 만들려다 실패한다(실측).
>
> ```
> namespace/grownup-todo created
> secret/grownup-todo-backend-env created
> service/grownup-todo-backend created
> Error from server (NotFound): error when creating ".../deployment.yaml": namespaces "grownup-todo" not found
> ```
>
> **오류가 마지막 줄에 한 번만 나오고 앞의 세 줄은 성공이라, 훑어보면 다 된 것처럼
> 보인다.** 실제로는 Service와 Secret은 만들어졌고 **Deployment만 빠져 있다** —
> 그래서 증상이 "파드가 아예 없다"로 나타난다.
>
> `k8s/secret.yaml`을 아직 만들지 않았다면 문제가 하나 더 겹친다. 값이 비어 있는
> `secret.example.yaml`이 함께 적용되어 **빈 Secret이 생성되고**, 나중에 Deployment를
> 제대로 만들어도 파드가 `CrashLoopBackOff`가 된다.
>
> 반대로 **`secret.yaml`을 이미 만들어 뒀다면 예시 파일이 그것을 덮지는 않는다.**
> `secret.example.yaml`이 `secret.yaml`보다 파일명 순으로 앞이라 실제 값이 나중에
> 적용되어 살아남는다(실측: `created` → `configured`, 최종 값은 실제 값). 폴더째
> 넘기지 말아야 하는 이유는 덮어쓰기가 아니라 **위의 순서 문제**다.

파드가 준비될 때까지 기다린다.

```bash
kubectl rollout status deployment/grownup-todo-backend -n grownup-todo
```

```
Waiting for deployment "grownup-todo-backend" rollout to finish: 0 of 1 updated replicas are available...
deployment "grownup-todo-backend" successfully rolled out
```

```bash
kubectl get pods -n grownup-todo
```

```
NAME                                    READY   STATUS    RESTARTS   AGE
grownup-todo-backend-7dcbd5b54b-vbxtb   1/1     Running   0          4s
```

`READY`가 `1/1`이면 준비 확인 프로브(`GET /api/v1/ready`)가 통과했다는 뜻이다 —
**확인 항목 ①의 절반은 여기서 이미 증명된다.** 프로브가 실패하면 `0/1`에 머무른다.

> 이미 배포되어 있는 상태에서 다시 적용하면 첫 줄이 `created`가 아니라
> `configured`이고, 롤아웃은 새 파드가 준비될 때까지 기다린 뒤 옛 파드를
> 내린다(`1 old replicas are pending termination`). 그 순서가 `maxUnavailable: 0`
> 이 만드는 것이고, 아래 ④번이 그 사이에 요청이 실패하지 않는지를 센다.

---

## 4. 확인한다

### ① 프로브 경로 둘

호스트에서 클러스터 안으로 통로를 뚫는다. 이 명령은 끝나지 않으므로 터미널을
하나 따로 쓴다.

```bash
kubectl port-forward -n grownup-todo service/grownup-todo-backend 4080:4080
```

다른 터미널에서 둘을 각각 호출한다.

```bash
curl -s -w "\n상태=%{http_code}\n" http://localhost:4080/api/v1/ping
curl -s -w "\n상태=%{http_code}\n" http://localhost:4080/api/v1/ready
```

```
pong
상태=200
ready
상태=200
```

평시에는 둘 다 200이다. **갈라지는 것은 종료가 시작된 뒤이고, 그것을 ②에서 센다.**

어느 프로브가 어느 경로를 보는지도 확인한다. 이 배선이 이 문서에서 가장 중요한
설정이다.

```bash
kubectl get deployment grownup-todo-backend -n grownup-todo \
  -o jsonpath='{range .spec.template.spec.containers[0]}기동={.startupProbe.httpGet.path}{"\n"}생존={.livenessProbe.httpGet.path}{"\n"}준비={.readinessProbe.httpGet.path}{"\n"}{end}'
```

```
기동=/api/v1/ping
생존=/api/v1/ping
준비=/api/v1/ready
```

**준비 확인만 `ready`여야 한다.** 이 배선은 `src/health/deployment-probe.spec.ts`가
테스트로도 고정하므로, 매니페스트를 손으로 고쳤다면 `npm test`가 먼저 알려 준다.

**이 배선이 왜 이래야 하는지는 아래 한 곳에만 적는다.** 저장소의 다른 자리(매니페스트
주석, 폴더 문서, 코드 주석, 테스트 주석)는 규칙 한 줄과 이 문서 참조만 두었다 — 같은
인과를 여러 곳에서 다시 유도하다가 한쪽만 고쳐지는 일이 실제로 반복됐기 때문이다.

#### 배선을 잘못하면 무엇을 잃는가 — 종료 경로에 따라 다르다

이 문서가 안내하는 **파드 삭제·재배포**와, 파드를 지우지 않고 프로세스에 종료 신호가
가는 경로가 다르게 움직인다.

| 배선 | 파드 삭제 경로(재배포 포함) | 파드를 지우지 않는 종료 경로 |
|---|---|---|
| 준비 확인이 `ping` | 엔드포인트 제거는 삭제 표식이 이미 했으므로 트래픽은 끊긴다. **잃는 것은 503 신호 자체** — 종료 중인 파드가 `1/1`로 남아 사람도 다른 도구도 그 상태를 구별하지 못한다 | **새 요청이 계속 들어온다.** 이 경로에서는 503이 유일한 신호다 |
| 생존 확인이 `ready` | **컨테이너가 죽지 않는다.** 삭제 표식이 붙으면 kubelet이 생존 확인을 멈춘다 | **프로브 값과 드레인 값에 따라 갈린다** — 아래 실측 표의 `kill -TERM 1` 세 행을 보라. 이 칸에 결과를 요약해 두지 마라 |

#### 그 표의 근거 — 실측 여섯 건

격리한 이름공간에 실험 파드를 띄워 확인했다(2026-08-17). **실험 파드는 이 애플리케이션이
아니라 앱 이미지의 node로 띄운 모사 서버다** — 데이터베이스가 필요 없어 `k8s/secret.yaml`을
실험에 끌어들이지 않는다. 종료 신호를 받으면 정해진 시간만큼 기다린 뒤 종료하고, 그동안
생존 확인 경로가 503을 돌려준다(= 생존 확인을 준비 확인 경로에 붙인 배선의 재현).
유예 시간은 우리 값 30초다.

**표를 읽을 때 왼쪽 네 열을 먼저 보라. 같은 값에서도 종료 방법이, 같은 종료 방법에서도
붙인 프로브가 결과를 가른다.** 그래서 이 표의 어느 행도 조건 없이 요약할 수 없다.

| 종료 방법 | 드레인 | 생존 확인 값 | 붙인 프로브 | 결과 |
|---|---|---|---|---|
| 파드 삭제 | 20초 | 주기 1초·시간 초과 1초·실패 허용 1회 (**최악보다 민감**) | 생존·준비 | 드레인 20초 완주. **생존 확인 실패 사건 0건.** 준비 확인 실패 사건은 남았다 — kubelet이 프로브를 전부 멈춘 것은 아니다 |
| 파드 삭제 | 8초 (**우리 값**) | 주기 10초·시간 초과 2초·실패 허용 3회 (**우리 값**) | 생존만 | **생존 확인 실패 사건 0건.** 사건 목록에 남는 것은 `Killing: Stopping container server` 하나뿐이다 |
| 파드 삭제 | 60초 (검증 상한) | 우리 값 | 생존만 | **생존 확인 실패 사건 0건.** 드레인 완료 로그가 없는데 그 원인은 판정이 아니라 유예 30초의 SIGKILL이다 |
| `kill -TERM 1` (파드는 남는다) | 20초 | 주기 1초·시간 초과 1초·실패 허용 1회 | 생존·준비 | 1초 만에 `Liveness probe failed: HTTP probe failed with statuscode: 503` → `Container server failed liveness probe, will be restarted`, 재시작 횟수 1 |
| `kill -TERM 1` (파드는 남는다) | 8초 (**우리 값**) | 우리 값 | 생존만 | 드레인 8.0초 **완주**, 종료 코드 **0**, 종료 원인 `Completed`. 경고 사건은 **0~1건** — 주기 10초와 드레인 8초의 위상에 달렸다(1건과 0건을 각각 관측했다) |
| `kill -TERM 1` (파드는 남는다) | 60초 (검증 상한) | 우리 값 | 생존만 | **약 28초에 재시작 판정**(`Liveness probe failed … 503` → `will be restarted`) → 두 번째 종료 신호 → 강제 종료. 드레인 완료 로그가 끝내 찍히지 않았다 |

**"붙인 프로브" 열이 사건 목록을 가른다. 이 매니페스트로 배포한 파드는 준비 확인 프로브가
있으므로 2·3행처럼 사건이 하나만 남지 않는다.**

| 붙인 프로브 | 파드를 지웠을 때 사건 목록 |
|---|---|
| 생존·준비 (**이 매니페스트의 구성**) | `Killing`과 함께 `Warning Unhealthy Readiness probe failed: HTTP probe failed with statuscode: 503`이 **반드시 남는다** — 드레인 8초에서 8건, 20초에서 20건, 60초에서 24~25건 |
| 생존만 (2·3·5·6행의 실험) | `Normal Killing Stopping container server` **하나**, `Unhealthy` 0건 |

**준비 확인 실패 경고는 이 구성의 정상 동작이다** — 종료가 시작되면 준비 확인이 503을
돌려주도록 만든 것이 이 설계이고, ④ 절의 "옛 파드가 `0/1`로 보이는 것이 준비 확인 503이
실제로 관측됐다는 표시"가 같은 사실의 다른 얼굴이다. 그 경고를 보고 준비 확인 값을
조정하지 마라.

> `kill -TERM 1`을 재현할 때 **`kubectl exec -n <이름공간> <파드> -- kill -TERM 1`은
> 동작하지 않는다.** `kill`이 셸 내장 명령이라 `executable file not found in $PATH`가
> 나고 신호는 가지 않는다 — 재시작 0건·사건 0건을 "신호를 보냈는데 아무 일도 없었다"로
> 잘못 읽게 되는 자리다. `-- sh -c 'kill -TERM 1'`로 셸을 거쳐야 한다.

읽는 법이 셋이다.

- **파드 삭제 경로(재배포 포함)에서는 배선이 틀려도 생존 확인이 관측되지 않는다.** 드레인
  8초·60초 어느 쪽에서도 실패 사건이 0건이었다. **그래서 이 어긋남은 이 문서의 검증
  절차로는 만들 수 없고**, `src/health/deployment-probe.spec.ts`가 그 자리를 대신 지킨다
- **파드를 지우지 않는 종료 경로에서 우리 값이면 종료 절차가 완주한다.** 드레인 8초가
  재시작 판정보다 먼저 끝나기 때문이다. 남는 것은 `Liveness probe failed` 경고 0~1건이고,
  그것이 종료 원인 추적을 흐린다
- **절차가 실제로 잘리는 것은 그 경로에서 드레인과 자원 해제의 합이 재시작 판정 시간을
  넘길 때다.** 판정 시간은 **최소 20초·최대 30초**다 — 첫 실패가 종료 신호와 프로브 주기의
  위상에 따라 0~10초 사이에 오기 때문이다(실측 약 28초). 검증 상한 60초 사례가 그
  극단이다. **이 저장소의 예산은 그 최소값에 닿지 않는다**: 드레인 8초 + 자원 해제 상한
  10초 = 18초 < 20초

세 가지는 아직 확인하지 않았으므로 그렇게 읽어라. ① 위 표는 **모사 서버**의 값이다 —
종료 코드 `0`·종료 원인 `Completed`는 이 애플리케이션에서 다시 볼 값어치가 있다(앱의
종료 코드가 0이 아닌 경로가 있으면 그 항목만 달라진다) ② 자원 해제가 상한 10초를 다
쓰는 경우는 **산술이고 실측이 아니다** — 실측에서는 2밀리초에 끝났다 ③ **기동 확인
프로브는 관측하지 않았다.** 위 표의 "붙인 프로브" 열에 기동 확인이 없다 — 어떤 실험에도
붙이지 않았다. 삭제 경로에서 기동 확인도 함께 멈춘다는 것은 kubelet 동작에서 같은 부류로
묶은 **추론**이고, 기동 확인 경로를 `ready`로 바꾸는 제안을 검토한다면 그 항목부터
측정해야 한다.

> **`kubectl port-forward`는 파드 하나에 고정된다.** Service를 대상으로 걸어도
> 처음에 고른 파드에 붙어 있는 것이라, 그 파드가 재배포로 사라지면 통로가
> 끊긴다. 그래서 아래 ④번(재배포 중 실패 0건)에는 이 방법을 쓰지 않는다.

### ② SIGTERM을 받으면 자원을 해제한다 · ③ 종료 직전 로그가 남는다

이 둘은 한 번에 확인한다. **중요한 순서가 있다 — 로그를 먼저 붙여 놓고 지워야
한다.** 파드가 사라지면 `kubectl logs`로 그 파드의 로그를 볼 수 없기 때문이다.

터미널 하나에서 로그를 따라 붙인다.

```bash
POD=$(kubectl get pods -n grownup-todo \
  -l app.kubernetes.io/name=grownup-todo-backend \
  -o jsonpath='{.items[0].metadata.name}')

kubectl logs -f -n grownup-todo "$POD"
```

다른 터미널에서 그 파드를 지운다. 쿠버네티스가 실제 종료 절차(전달 대상 목록에서
제외와 SIGTERM 전달을 **동시에** 시작 → 유예 시간 → SIGKILL)를 그대로 밟는다.

```bash
kubectl delete pod -n grownup-todo "$POD"
```

로그 쪽 터미널에 네 줄이 순서대로 나오면 셋 다 확인된 것이다.

```
{"level":30,"time":1786963320263,"pid":1,"hostname":"grownup-todo-backend-54f75d5885-j54bf","context":"ShutdownRegistry","msg":"종료 드레인 시작 — 8000ms 동안 요청을 계속 받는다 (SIGTERM)"}
{"level":30,"time":1786963328263,"pid":1,"hostname":"grownup-todo-backend-54f75d5885-j54bf","context":"ShutdownRegistry","msg":"종료 드레인 완료 — HTTP 서버를 닫는다 (SIGTERM)"}
{"level":30,"time":1786963328266,"pid":1,"hostname":"grownup-todo-backend-54f75d5885-j54bf","context":"ShutdownRegistry","msg":"postgres 해제 시작 (SIGTERM)"}
{"level":30,"time":1786963328268,"pid":1,"hostname":"grownup-todo-backend-54f75d5885-j54bf","context":"ShutdownRegistry","msg":"postgres 해제 완료 (SIGTERM)"}
```

읽는 법이 중요하다. 이 네 줄은 다섯 가지를 동시에 말한다.

- **`(SIGTERM)`** — 종료 신호가 node 프로세스까지 실제로 도달했다. 도달하지
  못했다면 이 로그는 아예 나오지 않고, 파드는 유예 시간이 다 지난 뒤 강제
  종료된다. **오류가 나지 않기 때문에 로그를 보지 않으면 정상으로 보인다** —
  그래서 이 확인이 이 문서에서 가장 중요하다
- **`"pid":1`** — node가 1번 프로세스다. 신호는 1번 프로세스에게만 간다.
  `npm run ...`으로 실행했다면 npm이 1번이 되어 node는 신호를 받지 못한다
- **`8000ms`** — 매니페스트가 주입한 `SHUTDOWN_DRAIN_DELAY_MS`가 실제로
  적용됐다. 기본값(5000)이 찍혀 있으면 환경변수가 파드에 닿지 않은 것이다
- **드레인 시작과 완료 사이가 정확히 8.000초, `해제 시작`은 그 3밀리초 뒤**
  (실측: 320263 → 328263 → 328266) — 자원 해제가 HTTP 서버를 닫은 **뒤에**
  일어난다. 순서가 반대면 처리 중 요청이 끊긴 데이터베이스를 만난다
- **네 줄이 남아 있는 것 자체** — 종료 직전의 로그가 유실되지 않았다

삭제 명령부터 드레인 시작까지는 약 60밀리초였다(삭제 요청 1786963320205 →
드레인 시작 1786963320263). 종료 전체가 8.1초에 끝나 유예 시간 30초 안에
충분히 들어온다 — 예산 계산은 `k8s/deployment.yaml`의
`terminationGracePeriodSeconds` 주석에 있다.

### ②-1 종료 중 프로브 두 경로가 갈리는 것을 직접 본다

이것이 이번 설계의 핵심이라 따로 센다. **종료 중인 파드를 Service로는 찌를 수
없으므로**(이미 전달 대상에서 빠졌다) 파드 주소를 직접 찌른다.

```bash
POD=$(kubectl get pods -n grownup-todo \
  -l app.kubernetes.io/name=grownup-todo-backend \
  -o jsonpath='{.items[0].metadata.name}')
IP=$(kubectl get pod "$POD" -n grownup-todo -o jsonpath='{.status.podIP}')

kubectl run prober -n grownup-todo --image=grownup-todo-backend:local \
  --restart=Never --command -- node -e '
const base = process.argv[1];
const 상태 = (r) => (r.status === "fulfilled" ? r.value.status : "연결실패");
setInterval(async () => {
  const r = await Promise.allSettled([fetch(base + "/ping"), fetch(base + "/ready")]);
  console.log(Date.now(), "ping", 상태(r[0]), "ready", 상태(r[1]));
}, 250);
' "http://$IP:4080/api/v1"

kubectl wait --for=condition=Ready pod/prober -n grownup-todo --timeout=60s
kubectl logs -f -n grownup-todo prober &
kubectl delete pod -n grownup-todo "$POD" --wait=false
```

실측 결과다(삭제 요청 시각 1786963320205).

```
1786963320200 ping 200 ready 200      ← 삭제 직전
1786963320450 ping 200 ready 503      ← 준비 확인만 503으로 바뀐다
...
1786963328255 ping 200 ready 503      ← 드레인 끝까지 생존 확인은 200을 유지한다
1786963328508 ping 연결실패 ready 연결실패   ← HTTP 서버가 닫혔다
```

503으로 관측된 시점은 삭제 0.25초 뒤지만 **실제 전환은 그보다 앞이다** — 프로버의
폴링 간격이 0.25초이고, 앱의 드레인 시작 로그는 삭제 0.06초 뒤에 찍혔다. 준비 확인
503은 그 로그와 같은 순간에 시작된다(플래그를 대기 전에 세우므로).

읽는 법이 셋이다.

- **`ready`가 즉시 503으로 바뀐다** — 드레인 국면이 종료 플래그를 대기 **전에**
  세운다는 뜻이다. 대기 뒤에 세우면 이 줄들이 8초 내내 200으로 남는다
- **`ping`이 끝까지 200이다** — 배선이 지켜졌다는 뜻이다. **이 경로에서 컨테이너가
  죽지 않은 이유가 이것은 아니다** — 삭제 표식이 붙으면 kubelet이 생존 확인을 멈추므로,
  여기서는 `ping`이 503이 되더라도 죽지 않는다(① 절의 표). 잘못된 배선의 대가는 파드를
  지우지 않는 종료 경로에서 나타난다
- **연결 실패는 드레인이 끝난 뒤에야 나타난다** — 8초 동안 요청을 계속 받았다

확인이 끝나면 프로버를 지운다.

```bash
kubectl delete pod prober -n grownup-todo
```

### ②-2 파드가 트래픽 경로에서 빠지는 방아쇠는 준비 확인이 아니다

`EndpointSlice`의 조건과 파드의 `Ready` 조건을 각각 폴링해 두 전환 시점을 비교했다
(실측 2026-08-17, 폴링 간격 약 0.03초).

| 시각(epoch 초) | 관측 | 방아쇠 |
|---|---|---|
| 1786963450.481 | 파드에 `deletionTimestamp`가 붙었다. `Ready`는 아직 `True` | 삭제 요청 |
| 1786963450.482 | EndpointSlice가 `ready:false`·`terminating:true` | **삭제 자체** |
| 1786963452.192 | 파드 `Ready=False`, EndpointSlice `serving:false` | 준비 확인 503 (주기 1초 × 실패 허용 2회) |

읽는 법은 **드레인이 두 신호를 모두 덮는다**는 것이다. 삭제 경로에서는 삭제 자체가
먼저 파드를 준비된 주소 목록에서 빼고, 준비 확인 503은 1.7초 뒤에 따라온다. 파드가
지워지지 않는 종료 경로(컨테이너에 직접 SIGTERM이 가는 경우)에서는 준비 확인 503이
**유일한 신호**다. 드레인 8초는 둘 중 어느 경로든 전파가 끝날 시간을 남긴다.

`deletionTimestamp`가 삭제 요청 시각이 아니라 **유예 시간이 지난 시각**
(요청 + 30초)으로 찍히는 것도 함께 확인할 수 있다 — 삭제 요청이 10:44:10Z일 때
값은 `2026-08-17T10:44:40Z`였다. 그 차이가 매니페스트의
`terminationGracePeriodSeconds`다.

파드는 Deployment가 곧바로 다시 만든다.

```bash
kubectl get pods -n grownup-todo
```

### ④ 재배포 중 실패한 요청 0건

**요청을 클러스터 안에서 만들어야 한다.** 호스트의 `port-forward`는 위에 적은
대로 파드 하나에 고정되므로, 그것으로 세면 "파드가 바뀌어서 끊긴 것"과
"서비스가 요청을 놓친 것"을 구별할 수 없다.

클러스터 안에 요청을 계속 보내는 파드를 하나 띄운다. 이미지는 방금 만든
애플리케이션 이미지를 그대로 쓴다 — Node.js가 들어 있어서 따로 받아 올 것이 없다.

```bash
kubectl run loadgen -n grownup-todo \
  --image=grownup-todo-backend:local --restart=Never --command -- \
  node -e 'let ok=0,fail=0;const u="http://grownup-todo-backend:4080/api/v1/ping";setInterval(()=>{fetch(u).then(r=>{r.status===200?ok++:fail++}).catch(()=>{fail++})},50);setInterval(()=>console.log(new Date().toISOString(),"성공",ok,"실패",fail),1000)'
```

50밀리초마다 Service 주소로 요청을 보내고, 1초마다 누적 성공·실패를 찍는다.
따라 붙여 둔다.

```bash
kubectl logs -f -n grownup-todo loadgen
```

```
2026-08-17T10:43:08.781Z 성공 19 실패 0
2026-08-17T10:43:09.781Z 성공 39 실패 0
```

부하가 흐르는 상태 그대로, 다른 터미널에서 재배포를 건다.

```bash
kubectl rollout restart deployment/grownup-todo-backend -n grownup-todo
kubectl rollout status deployment/grownup-todo-backend -n grownup-todo
```

```
Waiting for deployment "grownup-todo-backend" rollout to finish: 1 old replicas are pending termination...
deployment "grownup-todo-backend" successfully rolled out
```

재배포가 끝난 뒤 부하 쪽 터미널을 본다. **실패가 계속 0이어야 한다.** 아래는
재배포를 10:43:13.8에 걸었을 때의 실측이고, 옛 파드가 드레인을 지나 사라지는
구간(약 10:43:13.8 ~ 10:43:22)이 그 안에 들어 있다.

```
2026-08-17T10:43:13.782Z 성공 117 실패 0
2026-08-17T10:43:14.783Z 성공 136 실패 0
...
2026-08-17T10:43:23.783Z 성공 311 실패 0
2026-08-17T10:43:24.784Z 성공 330 실패 0
```

파드가 실제로 교체됐는지도 함께 본다. 이름이 바뀌어 있어야 재배포가 일어난 것이다.

```bash
kubectl get pods -n grownup-todo
```

```
NAME                                    READY   STATUS        RESTARTS   AGE
grownup-todo-backend-54f75d5885-cjnf2   0/1     Terminating   0          85s
grownup-todo-backend-656fdcdf77-r4mj6   1/1     Running       0          12s
loadgen                                 1/1     Running       0          18s
```

옛 파드가 `Terminating`인데도 실패가 0인 것이 핵심이다. 세 가지가 겹쳐서 나오는
결과다.

- `maxUnavailable: 0` — 새 파드가 준비된 뒤에야 옛 파드를 내린다
- **드레인 8초** — 전달 대상 목록에서 빠진 사실이 각 노드로 퍼질 동안에도 옛
  파드가 요청을 계속 받는다. 준비 확인은 그 사이 503이라 새 트래픽이 이 파드로
  향하지 않는다(`preStop` 훅은 두지 않는다 — 같은 창을 덮으므로 함께 두면 대기가
  이중으로 쌓인다)
- 애플리케이션의 정상 종료 — 이미 받은 요청을 끝낸 뒤에 자원을 해제한다

옛 파드가 `0/1`로 보이는 것이 준비 확인 503이 실제로 관측됐다는 표시다 — 종료 중인
파드가 `1/1`로 남아 있으면 준비 확인이 `ping`을 보고 있는 것이다.

셋 중 하나만 빼도 이 숫자가 0이 아니게 된다. 확인이 끝나면 부하 파드를 지운다.

> **재배포와 "파드 직접 삭제"는 결과가 다르다.** 같은 부하로 두 경로를 각각 실측했다.
>
> | 경로 | 결과 |
> |---|---|
> | `kubectl rollout restart` | 실패 0건 (2회 측정, 요청 330건·467건) |
> | `kubectl delete pod` (파드가 하나뿐인 구성) | **실패 1건** — 옛 파드가 HTTP 서버를 닫는 순간(드레인 종료 시점, 삭제 8.0초 뒤)에 발생 |
>
> 남는 1건의 정체는 **keep-alive 커넥션이다.** 엔드포인트 제거는 새 커넥션에만
> 영향을 주고, 이미 맺어진 커넥션은 옛 파드에 그대로 붙어 있다(부하 발생기가
> 드레인 8초 동안 옛 파드로 요청을 계속 성공시킨 것이 그 증거다). 드레인은 그
> 커넥션이 닫히는 시점을 미루기만 하고 없애지 못하므로, 닫는 순간에 요청이 실려
> 있으면 그 하나가 실패한다. 재배포 경로에서 0건이 나온 것도 이 경합이 없어진
> 것이 아니라 그 순간에 요청이 실리지 않은 것이다.
>
> 없애려면 애플리케이션이 드레인 중 응답에 `Connection: close`를 실어 커넥션을
> 회수하거나(클라이언트가 다음 요청을 새 커넥션으로 맺게 된다), 호출 측이
> 커넥션 종료에 재시도를 걸어야 한다. **이 저장소는 아직 둘 다 하지 않는다.**

```bash
kubectl delete pod loadgen -n grownup-todo
```

---

## 5. 정리한다

이름공간 하나만 지우면 Deployment·Service·Secret·파드가 함께 사라진다.

```bash
kubectl delete namespace grownup-todo
```

이미지도 지우려면 이렇게 한다.

```bash
docker image rm grownup-todo-backend:local
```

---

## 자주 걸리는 것

### 파드가 `CrashLoopBackOff`다

로그를 본다. 이미 재시작한 뒤라면 직전 컨테이너의 로그를 봐야 한다.

```bash
kubectl logs -n grownup-todo deployment/grownup-todo-backend --previous
```

- `환경변수 DATABASE_URL이 postgres 접속 문자열이 아니다` — Secret의 값에
  큰따옴표가 섞여 들어갔을 가능성이 크다. 2단계의 따옴표 주의를 보라
- `환경변수 PORT가 1~65535 범위의 10진수 정수가 아니다: abc` — Deployment의 `PORT`
  값을 확인한다. 콜론 뒤에 붙은 것이 실제로 들어온 값이라 그것으로 대조하면 된다.
  같은 형태로 `환경변수 SHUTDOWN_DRAIN_DELAY_MS가 0~60000 범위의 10진수 정수가
  아니다: ...`도 난다 — 두 메시지는 `src/config/env.validation.ts`의 같은 헬퍼가
  만든다
- `Cannot find module` — 이미지 빌드가 잘못됐다. `docker build`를 다시 돌린다

### 코드를 고쳤는데 반영되지 않는다

이미지를 다시 만들지 않았거나(1단계), 만들었는데 파드를 새로 띄우지 않은 것이다.

```bash
docker build -t grownup-todo-backend:local .
kubectl rollout restart deployment/grownup-todo-backend -n grownup-todo
```

매니페스트가 `imagePullPolicy: Always`인 것이 이 문제를 막기 위해서다.
`IfNotPresent`(기본값)로 두면 노드가 "그 태그는 이미 있다"고 판단해 다시
가져오지 않고, **아무 오류 없이 옛 코드가 계속 돈다.**

### 파드가 `0/1 Running`에서 넘어가지 않는다

프로브가 실패하고 있다. 어느 프로브인지는 사건 목록이 말해 준다.

```bash
kubectl get events -n grownup-todo --sort-by=.lastTimestamp | tail
```

```
Warning  Unhealthy  Startup probe failed: Get "http://10.244.0.5:4080/api/v1/ping": dial tcp ...: connect: connection refused
```

**첫 용의자는 기동 확인(`Startup probe`)이다.** 기동 확인이 통과하기 전에는
준비 확인과 생존 확인이 **아예 시작되지 않기 때문**에, 이 상태에서
`readinessProbe` 설정을 들여다봐도 단서가 없다. 메시지가 `Readiness probe
failed`로 바뀌어 있을 때에만 준비 확인 쪽을 본다.

메시지 끝에 무엇이 붙어 있는지로 갈린다.

- **`connection refused`** — 대개 **포트**가 어긋난 것이다. 애플리케이션이 여는
  포트는 환경변수 `PORT`가 정하고, 프로브가 찌르는 포트는 `containerPort`가
  정한다 — 둘이 같아야 한다. 이 일치는
  `src/config/deployment-port.spec.ts`가 고정하므로, 매니페스트를 손으로
  고쳤다면 `npm test`가 먼저 알려 준다
- **`statusCode: 404`** — **경로**가 어긋난 것이다. 프로세스는 정상이고 포트도
  맞는데 프로브가 없는 경로를 찌르고 있다. 실제 경로는 전역 접두사
  (`src/app-setup.ts`의 `API_PREFIX`)와 컨트롤러 경로가 합쳐져 만들어지므로,
  접두사를 바꾸면 매니페스트의 프로브 `path` 세 곳(`ping` 둘, `ready` 하나)도
  함께 움직여야 한다. 접두사와 컨트롤러 경로의 일치는
  `test/health.e2e-spec.ts`가, 매니페스트와의 일치는
  `src/health/deployment-probe.spec.ts`가 고정하므로 `npm test`와
  `npm run test:e2e`가 먼저 알려 준다

### 종료 중에 컨테이너가 재시작된다

사건 목록에 `Container server failed liveness probe, will be restarted`가 있고
재시작 횟수가 올라갔다면 **생존 확인이 `/api/v1/ready`를 보고 있다.** 종료 중 503이
생존 실패로 읽힌 것이다.

**이 증상은 파드를 지우는 경로에서는 나타나지 않는다.** 삭제 표식이 붙으면 kubelet이
생존 확인을 멈추기 때문에, 위의 ②(파드 삭제)와 ④(재배포)로는 이 상태를 만들 수
없다 — 실측으로 확인했다(위 ① 절의 표). 이 항목을 보게 되는 것은 파드를 지우지 않고
컨테이너 안의 1번 프로세스에 종료 신호가 가는 경로다.

```bash
kubectl get events -n grownup-todo --sort-by=.lastTimestamp | grep -i liveness
kubectl get pod -n grownup-todo -l app.kubernetes.io/name=grownup-todo-backend \
  -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}{"\n"}'
```

**재배포 중에 드레인이 잘리는 것은 이 원인이 아니다.** 그 경우에는 아래 "재배포 중
실패가 0이 아니다"를 본다.

### 재배포 중 실패가 0이 아니다

**실패 건수가 먼저 갈린다.**

**1건이라면 이미 맺어진 연결일 가능성이 높다.** 옛 파드가 HTTP 서버를 닫는 순간
(드레인 종료 시점)에 요청이 실려 있으면 그 하나가 실패한다 — 실측과 기전은 위 ④의
표에 있다. 이 원인은 **프로브 값이나 드레인 대기를 어떻게 조정해도 남는다**(드레인은
닫는 시점을 미루기만 한다). 실패 시각이 옛 파드의 `종료 드레인 완료` 로그 시각과
겹치는지로 구별한다. 없애려면 드레인 중 응답에 `Connection: close`를 실어 연결을
회수하거나 호출 측 재시도가 필요하고, 이 저장소는 아직 둘 다 하지 않는다.

**여러 건이라면** 드레인이 실제로 도는지부터 본다(②의 네 줄). 로그가 정상이라면 대개
**준비 확인 값과 드레인 대기의 짝**이 어긋난 것이다. 준비 확인이 실패로 판정되기까지
`(periodSeconds + timeoutSeconds) × failureThreshold`가 걸리는데(가드 코드가 쓰는
식이다 — 매 시도가 시간 초과까지 버티는 최악을 센다), 그 값이 드레인 대기에 가까우면
파드가 트래픽 경로에서 빠지기 전에 HTTP 서버가 닫힌다. 두 값은 `k8s/deployment.yaml`
에서 서로 옆에 있고, 짝은 `src/health/deployment-probe.spec.ts`가 고정한다 — **식을
바꿀 때 기준은 그 코드다.**

`SHUTDOWN_DRAIN_DELAY_MS`를 매니페스트에서 지우면 애플리케이션 기본값(5000)이
쓰이는데, **그 값은 현재 프로브 값에 대한 이 저장소 예산(판정 최악 4초 + 전파 여유
2초 = 6초)에 미치지 못한다.** 지우면 `src/health/deployment-probe.spec.ts`의
'준비 확인이 실패로 판정되는 시간이 드레인 대기보다 짧다'가 실패하므로 커밋까지
가지 않는다 — 그 테스트가 깨졌을 때 이 문단이 이유다. 값을 명시한 채로 둔다.

### 종료 로그를 놓쳤다

파드가 지워진 뒤에는 그 파드의 로그를 볼 수 없다. ④번처럼 `kubectl logs -f`를
**먼저** 붙여 놓고 지워야 한다. 지난 파드의 로그까지 남기려면 로그 수집기를
따로 붙여야 하는데, 로컬 검증 범위 밖이다.
