# LOG:ON 물류 포트폴리오

기존 공개 LOG:ON 사이트의 소스입니다. [운영 사이트](https://log-on-logistics-portfolio.gayoungk1.chatgpt.site)에서 초대 코드로 회원가입, 이름과 비밀번호 로그인, 개인 포트폴리오 저장 및 PDF 인쇄를 사용할 수 있습니다.

회장과 부회장은 회원 관리에서 7일 유효한 일회용 초대 코드를 만들고, 일반 부원을 비활성화하거나 복구할 수 있습니다. 비활성화하면 로그인 세션이 종료되며 포트폴리오 기록은 보관됩니다.

## 구조

- `web/`에 프런트엔드가 있습니다.
- `worker/index.mjs`에서 회원 인증, 세션, 권한 및 포트폴리오 저장을 처리합니다.
- `drizzle/`에 D1 마이그레이션이 있습니다.
- Node.js로 `node worker/build.mjs`를 실행하면 Worker 아티팩트를 만듭니다.

별도 Sites 프로젝트에 배포할 때는 해당 프로젝트 ID를 `.openai/hosting.json`에 설정하고 D1의 `DB` 바인딩과 SQL 마이그레이션을 적용합니다. 관리자 기능에는 서버 환경변수 `LOGON_ADMIN_NAME`, `LOGON_ADMIN_EMAIL`, `LOGON_INVITED_ADMIN_NAME`, `LOGON_PARK_INVITE_HASH`가 사용됩니다. 공개 저장소에는 실제 값과 운영 데이터베이스를 포함하지 않습니다.

GitHub는 이 소스의 저장소이며, 운영에는 Worker와 D1이 필요합니다.
