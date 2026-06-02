# Phishing_Chat_Voice 코드 검토 및 수정 보고서

검토/수정일: 2026-05-28  
검토 범위: `frontend`, `backend`, `backend_python_legacy`

## 1. 현재 결론

현재 프로젝트는 보이스피싱 예방 체험의 핵심 흐름이 작동 가능한 형태다. 세션 생성, 음성 녹음/업로드, MiniMax 보이스 클로닝, 수신 전화 UI, LLM 스트리밍, TTS 스트리밍 재생, 음성대화 UI, 정상 종료 삭제, 사용자 진입 시 cleanup 구조가 들어가 있다.

이번 수정으로 보고서에서 바로 처리 필요하다고 판단한 주요 항목을 반영했다.

## 2. 반영 완료 항목

### 2.1 GPT/Gemini LLM 관리자 선택

기존 `gpt-5.4-mini` 하드코딩과 GPT 실패 시 Gemini 자동 폴백 구조를 정리했다.

반영:

- `/admin.html` 관리자 화면 추가
- `GET /api/admin/llm/models` 모델 목록 조회
- `GET /api/admin/llm/settings` 현재 설정 조회
- `POST /api/admin/llm/settings` 확인 후 설정 저장
- 선택 설정은 `backend/data/llm_settings.json`에 저장
- 다음 LLM 요청부터 새 모델 적용
- 자동 Gemini 폴백 제거

기본값:

```text
provider=openai
model=gpt-5.4-mini
```

### 2.2 관리자 접근 보호

`ADMIN_TOKEN` 환경변수가 있으면 관리자 화면/API에 토큰이 필요하도록 처리했다.

사용 예:

```text
http://localhost:3001/admin.html?token=관리자토큰
```

관리자 화면은 토큰을 `localStorage`에 저장하고 이후 API 호출에 `x-admin-token` 헤더로 전달한다. `ADMIN_TOKEN`이 없으면 로컬 개발 편의를 위해 관리자 접근을 허용한다.

### 2.3 클로닝 중 종료 race 보완

기존 위험:

```text
음성 업로드/클로닝 진행 중 사용자가 종료
→ DELETE /api/sessions/:id 실행
→ 이후 clone 성공
→ voiceId가 active로 DB에 남을 수 있음
```

수정:

- `session-manager.js`에 종료된 세션 추적 추가
- clone 완료 직후 세션이 이미 닫혔는지 확인
- 닫힌 세션이면 생성된 voiceId를 즉시 MiniMax 삭제 요청
- DB 상태도 삭제 결과에 맞게 갱신

### 2.4 서버 업로드 크기 제한

서버 `multer.memoryStorage()`에 크기 제한을 추가했다.

```text
voice clone upload: 20MB
STT upload: 10MB
```

초과 시 `413` 응답을 반환한다.

### 2.5 삭제 요청 결과 확인

프론트 `cleanupCurrentSession()`이 `DELETE /api/sessions/:id` 응답의 `res.ok`를 확인하도록 수정했다.

기존에는 HTTP 500이어도 "삭제 요청 완료"로 보일 수 있었다. 현재는 실패 시 "삭제 요청에 실패했습니다. 서버 정리 작업에서 다시 시도합니다."로 처리한다.

### 2.6 세션 생성 완료 전 녹음 방지

기존에는 동의 후 녹음 화면을 먼저 보여주고 세션 생성을 기다렸다. 네트워크가 느리면 `sessionId` 없이 업로드될 가능성이 있었다.

수정:

```text
동의
→ POST /api/sessions 성공
→ sessionId/openingMessage 저장
→ 녹음 화면 표시
```

### 2.7 서버 대화 히스토리와 인터럽트 정책 정합성

프론트는 새 입력 전송 시 이전 턴을 무효화한다. 하지만 기존 서버는 이전 LLM 요청이 늦게 완료되면 그 응답을 세션 히스토리에 저장할 수 있었다.

수정:

- 프론트가 `/v1/chat/completions`에 `turnId` 전달
- 백엔드 세션에 `latestTurnId` 저장
- LLM 완료 시 최신 turnId인 경우에만 `session.conversation` 저장
- stale turn은 `HISTORY_SKIP_STALE_TURN` 로그로 남김

현재 LLM에 전달되는 히스토리 구조:

```text
system prompt
이번 턴 지시
최근 대화 10개 메시지
현재 사용자 입력
```

최근 10개 메시지는 보통 최근 5턴이며, 체험형 대화 기준으로 적절하다.

### 2.8 OpenAI 스트림 fullResponse 파서 개선

기존에는 OpenAI 스트림을 `chunk.toString()` 단위로 파싱해 TCP 청크 분할에 취약했다.

수정:

- OpenAI/Gemini 모두 버퍼 기반 줄 파싱으로 통일
- 프론트 전달용 SSE와 서버 히스토리 누적용 텍스트를 같은 파서에서 처리
- `LLM_FIRST_TOKEN`, `LLM_STREAM_DONE`, `LLM_STREAM_PARSE_FAILED` 로그 추가

### 2.9 분류 실패 로그 추가

분류 실패 시 여전히 안전 기본값은 `RELATED`를 사용한다. 다만 이제 실패가 조용히 숨지 않도록 trace 로그를 남긴다.

추가 로그:

```text
CLASSIFY_START
CLASSIFY_DONE
CLASSIFY_FAILED
```

### 2.10 환경변수 확인과 health API

추가:

- 서버 시작 시 주요 환경변수 누락 경고 로그
- `GET /api/health`

`/api/health`는 API 키 존재 여부를 boolean으로만 보여준다. 실제 키 값은 노출하지 않는다.

### 2.11 첫 음성 시작 지연시간 로그

프론트에 turn 단위 지연시간 로그를 추가했다.

기록 지점:

```text
user_send
llm_first_token
llm_done
tts_first_request
tts_first_packet
audio_play_start
```

로그 예:

```text
[Latency][turn=3] user_send=0ms
[Latency][turn=3] llm_first_token=820ms
[Latency][turn=3] tts_first_request=980ms
[Latency][turn=3] tts_first_packet=1540ms
[Latency][turn=3] audio_play_start=1740ms
```

### 2.12 레거시 파일 정리

현재 메인 앱에서 쓰지 않고 DOM/API 경로가 맞지 않던 파일을 제거했다.

삭제:

- `frontend/js/chat.js`
- `frontend/js/result.js`
- `frontend/js/config.js`
- `frontend/js/core/LLMClient.js`
- `backend/config.js`

### 2.13 관리자 대시보드와 사용량 체크

관리자 화면의 메인을 대시보드로 변경했다. 화면 스타일은 Tabler 계열의 운영 도구형 UI에 맞춰 카드, 탭, 배지, 표 구조로 정리했고, 최대 가로 폭은 800px로 제한했다.

추가/변경:

- `/admin.html` 기본 화면을 사용량 대시보드로 구성
- `GET /api/admin/usage` 추가
- 총 요청 수, 로그 이벤트 수, 메모리 세션 수 표시
- 오늘/전체 이용 세션 수 표시
- 오늘 체험 완료, 오늘 중도 종료, 진행 중 세션 표시
- 오늘/주별/월별 서비스 사용 추이 선그래프 표시
- 그래프는 전체 시도 수와 완료 수 2개 선으로 표시
- 평균 LLM 첫 토큰 시간, 평균 LLM 완료 시간은 보조 성능 지표로 이동
- 현재 LLM provider/model과 API 키 설정 상태 표시
- voice registry 상태 표시
- 분류 통계와 최근 trace 이벤트 표 표시
- LLM 설정은 별도 탭에서 모델 조회/선택/확인 적용

현재 사용량 데이터는 `backend/usage_traces.jsonl`과 메모리 세션 상태, voice registry DB를 기준으로 계산한다. 운영 로그 분석이 필요할 경우 이 로그 파일을 기준으로 원인 분석이 가능하다.

### 2.14 클로닝/TTS 모델 관리자 설정

클로닝 모델과 TTS 모델도 관리자 화면에서 변경할 수 있도록 추가했다.

반영:

- `GET /api/admin/voice/settings` 추가
- `POST /api/admin/voice/settings` 추가
- 관리자 화면에 `음성 모델` 탭 추가
- 클로닝 모델 기본값: `speech-2.8-hd`
- TTS 모델 기본값: `speech-2.8-turbo`
- 설정값은 `backend/data/llm_settings.json`의 `voice` 항목에 저장
- 새 클로닝/TTS 요청부터 변경된 모델 적용

MiniMax 모델 목록은 `GET https://api.minimax.io/v1/models`를 먼저 호출한다. 현재 MiniMax API는 이 엔드포인트에서 텍스트 모델만 반환하고 `speech-*` 모델을 반환하지 않으므로, speech 모델이 없을 때는 공식 MiniMax 문서 스펙에서 음성 모델 enum을 읽어 fallback으로 표시한다.

관리자 화면에는 모델 목록 출처를 표시한다.

- `minimax-api`: MiniMax `/v1/models`에서 speech 모델을 직접 가져온 경우
- `minimax-docs`: `/v1/models`에 speech 모델이 없어 공식 MiniMax 문서 스펙에서 가져온 경우

서버에서는 `speech-*` 형식만 허용하도록 검증한다.

### 2.15 Gemini 스트림 마지막 조각 전달 보강

Gemini 스트림에서 마지막 버퍼가 줄바꿈 없이 끝나는 경우 서버가 `fullResponse`에는 누적하지만 프론트 SSE로 다시 전달하지 않을 수 있었다. 이 경우 화면/히스토리와 TTS 전달 텍스트가 어긋날 수 있으므로, 스트림 종료 시 남은 버퍼 텍스트도 동일한 OpenAI 호환 SSE 형식으로 내려주도록 수정했다.

추가 보강:

- Gemini `content.parts`가 여러 개일 때 전체 `text`를 합쳐 처리
- 마지막 버퍼 텍스트도 프론트에 `data: { choices[].delta.content }`로 전달

## 3. 현재 핵심 구조

### 프론트

핵심 파일:

- `frontend/index.html`
- `frontend/admin.html`
- `frontend/js/app.js`
- `frontend/js/core/TTSClient.js`
- `frontend/js/core/AudioStreamPlayer.js`
- `frontend/js/core/STTClient.js`

`App` 클래스가 화면 전환, 녹음, 클로닝, 채팅, LLM 스트림, TTS 조각화, 음성대화 상태를 관리한다.

### 백엔드

핵심 파일:

- `backend/api-proxy.js`
- `backend/session-manager.js`
- `backend/voice-registry.js`
- `backend/llm-settings.js`
- `backend/stt-api.js`
- `backend/phishing-logic.js`

주요 API:

- `POST /api/sessions`
- `POST /api/sessions/:id/audio`
- `DELETE /api/sessions/:id`
- `POST /api/cleanup`
- `GET /api/tts/stream`
- `POST /api/stt`
- `POST /v1/chat/completions`
- `GET /api/health`
- `GET /api/admin/llm/models`
- `GET /api/admin/llm/settings`
- `POST /api/admin/llm/settings`
- `GET /api/admin/usage`
- `GET /api/admin/voice/settings`
- `POST /api/admin/voice/settings`

## 4. 삭제 플로우

현재 삭제 정책:

```text
정상 종료
→ DELETE /api/sessions/:id
→ 해당 세션 voiceId 삭제 시도
→ 성공 시 DB status=deleted
→ 실패 시 delete_pending/delete_failed

비정상 종료
→ 다음 사용자 서비스 진입
→ POST /api/cleanup
→ 30분 초과 active voice 삭제
→ delete_pending 재시도

클로닝 중 종료
→ 세션 closed 추적
→ clone 완료 후 closed면 즉시 voice 삭제
```

현재 요구사항대로 주기 삭제는 적용하지 않았다.

## 5. 남은 운영 전 체크

아래는 코드 수정이라기보다 실환경 검증 또는 운영 정책 항목이다.

1. 모바일 실기기에서 음성대화 패널/키보드 겹침 확인
2. iOS Safari/WebView에서 `/api/stt` 업로드 방식 확인
3. MiniMax/OpenAI/Gemini 실 API 호출 검증
4. 삭제 실패 케이스 강제 테스트
5. 수신 전화 벨소리 외부 URL을 로컬 asset으로 교체 검토
6. 운영 배포 시 CORS origin 제한
7. 운영 배포 시 rate limit 추가
8. 관리자 토큰 `ADMIN_TOKEN` 설정

## 6. 검증 결과

실행한 검증:

- 백엔드 JS 구문 검사 통과
  - `backend/api-proxy.js`
  - `backend/stt-api.js`
  - `backend/session-manager.js`
  - `backend/llm-settings.js`
  - `backend/voice-registry.js`
- 프론트 JS 모듈 구문 검사 통과
  - `frontend/js/app.js`
  - `frontend/js/core/TTSClient.js`
  - `frontend/js/core/AudioStreamPlayer.js`
  - `frontend/js/core/STTClient.js`
- 삭제한 레거시 파일에 대한 현재 참조 없음 확인

제한:

- 외부 API 실호출은 수행하지 않았다.
- 현재 실행 중인 서버에는 코드 변경이 자동 반영되지 않으므로 서버 재시작이 필요하다.

## 7. 최종 평가

이번 수정 후에는 보고서에서 지적한 주요 코드 이슈가 대부분 처리되었다. 특히 LLM 선택 정책, 서버 히스토리 정합성, 클로닝 중 종료 삭제, 업로드 제한, 지연시간 로그가 들어가면서 시연 안정성이 크게 올라갔다.

남은 핵심은 코드보다 실기기/실 API 검증이다. 다음 단계는 실제 모바일 환경에서 음성 입력, TTS 재생 시작 시간, 삭제 결과를 로그로 확인하는 것이다.
