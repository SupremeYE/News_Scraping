# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

관심 **키워드(네이버 검색)** 와 **뉴스 채널(RSS)** 로 뉴스를 매일 수집·분류하는 대시보드.
FastAPI 백엔드 + React/Vite 프론트, SQLite 저장, APScheduler 로 매일 자동 수집.

## 실행 / 개발 명령

```bash
# 백엔드 (포트 8000)
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# 프론트 (포트 5173)
cd frontend
npm install
npm run dev          # 개발 서버
npm run build        # 프로덕션 빌드 (타입/JSX 오류 확인용으로도 사용)
```

- `backend/.env` 필요: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` (https://developers.naver.com "검색" API), 선택 `DAILY_FETCH_TIME`(기본 `08:00`). `.env.example` 참고.
- Vite proxy 로 `/api` → `http://localhost:8000` 전달 (`vite.config.js`). CORS 는 `main.py` 에서 5173 허용.
- 테스트 프레임워크 없음. 검증은 `npm run build`(프론트) + 엔드포인트 수동 호출(curl)로 한다.
- **Windows/pyenv 주의**: `python -c "여러 줄"` 은 pyenv 셸에서 깨진다. 다중 줄 파이썬은 임시 `.py` 파일로 실행할 것. 콘솔은 cp949 라 한글이 깨져 보여도 데이터는 정상(UTF-8).
- SQLite `news.db` 는 최초 기동 시 자동 생성. 스키마는 **추가 컬럼 마이그레이션**(`init_db` 의 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`)으로 진화하므로, 컬럼을 바꿀 때 기존 `news.db` 를 지울 필요 없음.

## 핵심 아키텍처

### 통합 "채널" 모델 (가장 중요)
`keywords` 테이블 한 곳이 **모든 수집 채널**을 담는다. 채널은 두 종류(`kind`):
- `kind='naver'`: `keyword` 를 네이버 검색어로 사용 → 여러 매체에서 수집.
- `kind='rss'`: `feed_url` 의 RSS 피드를 수집. `filter_kw` 가 있으면 그 피드 안에서 제목/요약에 해당 키워드가 든 기사만 표시, `source_label` 은 출처 표시명(예: `보안뉴스`). `keyword` 는 고유 표시명(예: `보안뉴스 · KISA`).

이 모델 덕분에 네이버 키워드와 "RSS 소스 안의 키워드"가 **동일 구조**로 동작한다(각 채널 = 대시보드의 한 패널). 새 수집원을 추가할 때도 이 테이블에 행을 추가하는 식으로 확장한다.

### 백엔드 파이프라인 (`backend/`)
- `db.py` — SQLite 저장 계층. 테이블 2개: `keywords`(채널), `articles`. 핵심 규칙:
  - **중복 제거**: `articles` 의 `UNIQUE(keyword_id, link)` → 재수집 시 신규 기사만 삽입(신규 건수 반환).
  - **날짜 분류는 발행일 기준**: `article_date` 는 기사 **발행일(pub_date)** 을 파싱한 `YYYY-MM-DD`. `_article_date()` 가 RFC822(네이버)와 ISO8601(RSS `dc:date`) 둘 다 파싱, 실패 시 오늘로 fallback. `dashboard(date)` 는 이 값으로 그룹핑하므로 수집일이 아니라 **발행일**로 날짜 이동이 된다.
  - `dashboard()` 가 RSS 채널의 `filter_kw` 를 SQL `LIKE`(제목 OR 요약, 다중어는 OR)로 적용해 표시 필터링한다.
- `naver.py` — 네이버 검색 API 호출. `fetch_news(keyword)` 는 `sort=date` 로 키워드당 최신 30건. `_clean()` 이 HTML 태그/엔티티 제거(다른 수집기에서 재사용). 자격증명 없으면 `NaverCredentialsError`.
- `rss.py` — `fetch_rss(feed_url)`. feedparser 로 파싱(EUC-KR·`dc:date` 자동 처리), `naver._clean` 재사용, `pub_date` 는 원문 문자열 저장. 실패 시 `RssError`.
- `main.py` — FastAPI 앱 + 엔드포인트 + APScheduler.
  - `fetch_all_keywords()` 가 채널 `kind` 별로 분기 수집. **네이버 자격증명이 없어도 RSS 채널은 계속 수집**된다(네이버 채널만 skip, `naver_warning` 반환) — 이 분리는 의도된 것이니 유지할 것.
  - 스케줄러: 기동 시 1회 + 매일 `DAILY_FETCH_TIME` 자동 수집(백엔드 실행 중일 때만).
  - `RSS_PRESETS` 상수 = 한 번에 추가 가능한 RSS 소스 목록(현재 보안뉴스). 새 매체는 여기 한 줄 추가.

주요 엔드포인트: `GET /api/keywords`, `POST /api/keywords`(네이버 `{keyword}` / RSS `{keyword, kind:'rss', feed_url, source_label}`), `DELETE /api/keywords/{id}`, `GET /api/rss/presets`, `GET /api/dashboard?date=`, `GET /api/dates`, `POST /api/update`(전체 재수집).

### 프론트 (`frontend/src/`)
- `App.jsx` — 전역 상태/오케스트레이션(채널·대시보드·날짜·프리셋 로드, 추가/삭제/업데이트 핸들러).
- `api.js` — `/api` fetch 래퍼. `addChannel(payload)` 은 payload 객체를 그대로 POST.
- `components/KeywordManager.jsx` — 출처 선택(네이버/RSS 프리셋) + 키워드 입력으로 채널 추가, 채널 칩/삭제.
- `components/Dashboard.jsx` — 채널마다 **접이식 패널**(처음엔 모두 접힘, `open` 상태로 펼침 추적). 펼치면 뉴스 **카드 그리드**. 패널 헤더에 출처 배지 + 제목(RSS는 `filter_kw||'전체'`) + 건수.
- `components/NewsCard.jsx` — 개별 카드. `pub_date` 로 "몇 분 전" 상대시각을 **브라우저 현재 시각 기준**으로 계산해 표시.
- `index.css` — 단일 CSS 파일(라이트/다크 대응). UI 라이브러리 없음.

## 데이터 흐름 요약
채널 추가/업데이트 → (naver: `fetch_news` / rss: `fetch_rss`) → `save_articles`(발행일로 `article_date` 산출, link 중복 제거) → `dashboard(date)` 가 채널별 그룹 + RSS `filter_kw` 적용 → 프론트가 패널로 렌더.
