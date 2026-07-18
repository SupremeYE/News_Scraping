"""네이버 뉴스 키워드 대시보드 — FastAPI 백엔드.

- 채널(키워드/RSS) CRUD
- 채널별/발행일별 뉴스 대시보드
- 수동 업데이트 엔드포인트("업데이트" 버튼)
- APScheduler 로 매일 자동 수집

채널 종류:
  - kind='naver' : 키워드를 네이버 검색어로 사용
  - kind='rss'   : 지정한 RSS 피드(예: 보안뉴스)를 그대로 수집
"""
import os
from contextlib import asynccontextmanager
from datetime import date

from dotenv import load_dotenv

load_dotenv()  # backend/.env 로드

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import extract
import llm
from boannews import BoannewsError, search_boannews
from naver import NaverApiError, NaverCredentialsError, fetch_news
from rss import RssError, fetch_rss

scheduler = BackgroundScheduler()

# 큐레이션된 RSS 프리셋(한 번 클릭으로 추가). 정보보안 + 경제.
# name 이 곧 출처 표시명(source_label)이 된다. feed_url 은 실제 응답 확인된 것만 등록.
RSS_PRESETS = [
    {
        "name": "보안뉴스",
        "feed_url": "https://www.boannews.com/media/news_rss.xml",
        "description": "정보보안·AI 보안 전문 매체(전체기사)",
    },
    {
        "name": "연합뉴스 경제",
        "feed_url": "https://www.yna.co.kr/rss/economy.xml",
        "description": "연합뉴스 경제면(속보 다수, 커버리지 넓음)",
    },
    {
        "name": "한국경제",
        "feed_url": "https://www.hankyung.com/feed/economy",
        "description": "한국경제 경제면",
    },
    {
        "name": "한국경제 금융",
        "feed_url": "https://www.hankyung.com/feed/finance",
        "description": "한국경제 금융·증시면",
    },
    {
        "name": "동아일보 경제",
        "feed_url": "https://rss.donga.com/economy.xml",
        "description": "동아일보 경제면",
    },
    {
        "name": "한겨레 경제",
        "feed_url": "https://www.hani.co.kr/rss/economy/",
        "description": "한겨레 경제면",
    },
]


def fetch_all_keywords() -> dict:
    """등록된 모든 채널의 뉴스를 수집한다.

    - kind='naver' : 네이버 검색. 자격증명이 없으면 네이버 채널만 건너뛴다.
    - kind='rss'   : RSS 피드. 자격증명과 무관하게 항상 수집.
    반환: { per_keyword, total_new, naver_warning }
    """
    today = date.today().isoformat()
    per_keyword = {}
    total_new = 0
    naver_warning = None

    for kw in db.list_keywords():
        name = kw["keyword"]
        try:
            if kw["kind"] == "rss":
                articles = fetch_rss(kw["feed_url"])
            elif kw["kind"] == "boannews":
                articles = search_boannews(kw["filter_kw"] or "")
            else:
                articles = fetch_news(name)
        except NaverCredentialsError as e:
            # 네이버 자격증명이 없으면 네이버 채널만 건너뛰고 RSS/보안뉴스는 계속 처리.
            naver_warning = str(e)
            continue
        except (NaverApiError, RssError, BoannewsError) as e:
            print(f"[fetch] '{name}' 수집 실패: {e}")
            continue
        new_count = db.save_articles(kw["id"], articles, today)
        per_keyword[name] = new_count
        total_new += new_count

    return {"per_keyword": per_keyword, "total_new": total_new, "naver_warning": naver_warning}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    # 서버 기동 시 1회 수집.
    try:
        fetch_all_keywords()
    except Exception as e:  # 기동을 막지 않도록 방어
        print(f"[startup] 초기 수집 중 오류: {e}")

    # 매일 지정 시각에 자동 수집.
    fetch_time = os.getenv("DAILY_FETCH_TIME", "08:00")
    try:
        hour, minute = (int(x) for x in fetch_time.split(":"))
    except ValueError:
        hour, minute = 8, 0
    scheduler.add_job(
        fetch_all_keywords,
        CronTrigger(hour=hour, minute=minute),
        id="daily_fetch",
        replace_existing=True,
    )
    scheduler.start()
    print(f"[startup] 매일 {hour:02d}:{minute:02d} 자동 수집 예약 완료")
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


app = FastAPI(title="네이버 뉴스 키워드 대시보드", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- 스키마 ----------

class KeywordIn(BaseModel):
    keyword: str = ""              # 네이버: 검색어 / RSS·boannews: 그 소스 안에서 필터할 키워드
    kind: str = "naver"           # 'naver' | 'rss' | 'boannews'
    feed_url: str | None = None   # kind='rss' 일 때 필수
    source_label: str | None = None  # kind='rss' 출처명(예: '보안뉴스')


class FilterIn(BaseModel):
    filter_kw: str | None = None  # 빈 값이면 필터 해제


class ReorderIn(BaseModel):
    order: list[int]  # 채널 id 를 원하는 표시 순서대로


# ---------- 채널(키워드/RSS) ----------

@app.get("/api/keywords")
def get_keywords():
    return db.list_keywords()


@app.get("/api/rss/presets")
def get_rss_presets():
    """한 번에 추가할 수 있는 큐레이션 RSS 채널 목록."""
    return RSS_PRESETS


@app.post("/api/keywords")
def create_keyword(payload: KeywordIn):
    kind = payload.kind if payload.kind in ("naver", "rss", "boannews") else "naver"
    term = payload.keyword.strip()

    if kind == "rss":
        feed_url = (payload.feed_url or "").strip()
        source_label = (payload.source_label or "").strip() or "RSS"
        if not feed_url:
            raise HTTPException(status_code=400, detail="RSS 채널은 feed_url 이 필요합니다.")
        # 고유 표시명: 키워드가 있으면 '보안뉴스 · KISA', 없으면 '보안뉴스'(전체).
        display = f"{source_label} · {term}" if term else source_label
        row, created = db.add_keyword(
            display, kind="rss", feed_url=feed_url,
            filter_kw=(term or None), source_label=source_label,
        )
    elif kind == "boannews":
        # 보안뉴스 사이트 검색(최근 기사 크롤링 후 키워드 필터). 키워드 필수.
        if not term:
            raise HTTPException(status_code=400, detail="보안뉴스 검색어를 입력하세요.")
        source_label = "보안뉴스"
        display = f"{source_label} 검색 · {term}"
        row, created = db.add_keyword(
            display, kind="boannews",
            filter_kw=term, source_label=source_label,
        )
    else:
        if not term:
            raise HTTPException(status_code=400, detail="키워드를 입력하세요.")
        row, created = db.add_keyword(term, kind="naver")

    # 추가 즉시 1회 수집.
    new_count = 0
    warning = None
    try:
        if kind == "rss":
            articles = fetch_rss(row["feed_url"])
        elif kind == "boannews":
            articles = search_boannews(row["filter_kw"] or "")
        else:
            articles = fetch_news(term)
        new_count = db.save_articles(row["id"], articles)
    except NaverCredentialsError as e:
        warning = str(e)
    except (NaverApiError, RssError, BoannewsError) as e:
        warning = str(e)

    return {"keyword": row, "created": created, "new_count": new_count, "warning": warning}


@app.patch("/api/keywords/{keyword_id}")
def update_keyword_filter(keyword_id: int, payload: FilterIn):
    """채널(주로 RSS)의 표시 필터 키워드를 설정/해제한다."""
    if not db.update_filter(keyword_id, payload.filter_kw):
        raise HTTPException(status_code=404, detail="해당 채널을 찾을 수 없습니다.")
    return {"id": keyword_id, "filter_kw": (payload.filter_kw or "").strip() or None}


@app.post("/api/keywords/reorder")
def reorder_keywords(payload: ReorderIn):
    """드래그로 정한 순서(order: 채널 id 배열)대로 채널 표시 순서를 저장한다."""
    db.reorder_keywords(payload.order)
    return {"ok": True, "order": payload.order}


@app.delete("/api/keywords/{keyword_id}")
def remove_keyword(keyword_id: int):
    if not db.delete_keyword(keyword_id):
        raise HTTPException(status_code=404, detail="해당 채널을 찾을 수 없습니다.")
    return {"deleted": keyword_id}


# ---------- 대시보드 ----------

@app.get("/api/dashboard")
def get_dashboard(date: str | None = None):
    """date 없음/'recent' → 최근 N일 모아보기, 'YYYY-MM-DD' → 그 발행일만."""
    if date is None or date == "recent":
        return {"date": "recent", "groups": db.dashboard(target_date="recent")}
    return {"date": date, "groups": db.dashboard(target_date=date)}


@app.get("/api/dates")
def get_dates():
    return db.list_dates()


# ---------- 업데이트("업데이트" 버튼) ----------

@app.post("/api/update")
def run_update():
    """모든 채널(네이버+RSS)을 지금 즉시 재수집한다.

    네이버 자격증명이 없어도 RSS 채널은 정상 수집되며,
    결과의 naver_warning 으로 네이버 미수집 사유를 알린다.
    """
    return fetch_all_keywords()


def _today() -> str:
    return date.today().isoformat()


# ---------- 학습(스터디) 레이어 ----------

class StudyIn(BaseModel):
    sections: list[str] | None = None  # 없으면 4개 전부
    force: bool = False                # True 면 캐시 무시하고 재생성


class AskIn(BaseModel):
    question: str = ""


class TermIn(BaseModel):
    term: str = ""
    explanation: str | None = None
    example: str | None = None
    article_id: int | None = None


class NoteIn(BaseModel):
    body: str = ""


def _load_article(article_id: int):
    """기사 조회 + 원문 본문 지연수집(최초 1회). 없으면 None.

    본문이 비어 있으면 링크에서 긁어와 캐시하고, 실패하면 요약 스니펫으로 폴백(그대로).
    """
    art = db.get_article(article_id)
    if art is None:
        return None
    if not (art.get("body") or "").strip():
        try:
            text = extract.fetch_article_text(art["link"])
        except Exception:
            text = ""
        if text:
            db.save_article_body(article_id, text)
            art["body"] = text
    return art


@app.get("/api/study/sections")
def get_study_sections():
    """섹션 순서와 표시 이름(프론트 탭 라벨을 서버와 일치시킴)."""
    return {
        "order": llm.SECTION_ORDER,
        "labels": {k: v["label"] for k, v in llm.SECTIONS.items()},
    }


@app.get("/api/articles/{article_id}/study")
def get_article_study(article_id: int):
    """기사의 캐시된 AI 해설만 반환(LLM 미호출). 패널 열 때 사용."""
    if db.get_article(article_id) is None:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")
    return {"study": db.get_study(article_id)}


@app.post("/api/articles/{article_id}/study")
def run_article_study(article_id: int, payload: StudyIn):
    """요청 섹션 중 없는(또는 force) 것만 LLM 호출→캐시 저장 후 전체를 반환.

    키가 없으면 warning 을 담아 반환(프론트는 '프롬프트 복사'로 유도).
    """
    article = _load_article(article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")

    requested = payload.sections or llm.SECTION_ORDER
    sections = [s for s in requested if s in llm.SECTIONS]

    cached = db.get_study(article_id)
    result = dict(cached)
    warning = None
    model = llm.get_model()

    def _save(section, content):
        db.save_study(article_id, section, content, model)
        result[section] = content

    # 생성이 필요한 섹션(캐시에 없거나 force).
    remaining = [s for s in sections if payload.force or s not in cached]

    # 2개 이상이면 통합 1회 호출로 본문 반복입력을 피한다(토큰 절약).
    if len(remaining) >= 2:
        try:
            combined = llm.run_all_sections(article)
            for s in list(remaining):
                if s in combined:
                    _save(s, combined[s])
                    remaining.remove(s)
        except llm.LlmCredentialsError as e:
            warning = str(e)
            remaining = []  # 키 문제면 개별 시도도 무의미
        except llm.LlmError:
            pass  # 통합 실패(파싱 등) → 아래 섹션별 폴백

    # 남은 섹션은 개별 호출(통합 실패분 또는 단일 요청).
    for s in remaining:
        try:
            content = llm.run_section(article, s)
        except llm.LlmCredentialsError as e:
            warning = str(e)
            break
        except llm.LlmError as e:
            warning = str(e)
            continue
        _save(s, content)

    return {"study": result, "warning": warning}


@app.get("/api/articles/{article_id}/prompt")
def get_article_prompt(article_id: int, section: str = "all"):
    """무료 경로용 복사 프롬프트(구독 챗에 붙여넣기). section='all'|각 섹션명.

    복사본에도 원문 본문이 담기도록 지연수집한다(붙여넣기만으로 챗이 내용을 알게).
    """
    article = _load_article(article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")
    if section != "all" and section not in llm.SECTIONS:
        raise HTTPException(status_code=400, detail="알 수 없는 섹션입니다.")
    return {"prompt": llm.build_copy_prompt(article, section)}


@app.post("/api/articles/{article_id}/ask")
def ask_article(article_id: int, payload: AskIn):
    """기사에 대한 자유 질문 Q&A. 키 없으면 복사 프롬프트를 warning 과 함께 반환."""
    article = _load_article(article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="질문을 입력하세요.")
    system, user = llm.build_question_messages(article, question)
    try:
        answer = llm.generate(system, user)
    except llm.LlmCredentialsError as e:
        return {"answer": None, "warning": str(e), "prompt": f"{system}\n\n{user}"}
    except llm.LlmError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"answer": answer, "warning": None}


# ---------- 용어장 ----------

@app.get("/api/glossary")
def get_glossary(q: str | None = None):
    return db.list_glossary(q)


@app.post("/api/glossary")
def add_term(payload: TermIn):
    term = (payload.term or "").strip()
    if not term:
        raise HTTPException(status_code=400, detail="용어를 입력하세요.")
    return db.upsert_term(term, payload.explanation, payload.example, payload.article_id)


@app.delete("/api/glossary/{term_id}")
def remove_term(term_id: int):
    if not db.delete_term(term_id):
        raise HTTPException(status_code=404, detail="해당 용어를 찾을 수 없습니다.")
    return {"deleted": term_id}


# ---------- 스터디 노트 ----------

@app.get("/api/notes")
def get_notes():
    return db.list_notes()


@app.get("/api/notes/{article_id}")
def get_one_note(article_id: int):
    """기사의 노트(없으면 빈 객체)."""
    return db.get_note(article_id) or {}


@app.put("/api/notes/{article_id}")
def put_note(article_id: int, payload: NoteIn):
    if db.get_article(article_id) is None:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")
    return db.upsert_note(article_id, payload.body)


# ---------- 정적 프론트 서빙(단일 서버 배포) ----------
# 빌드된 프론트(frontend/dist)가 있으면 같은 포트에서 웹까지 서빙한다.
# 프론트는 상대경로 /api 를 쓰므로 CORS 없이 동작한다. 위의 모든 /api 라우트가
# 먼저 등록되므로 "/" 마운트보다 우선 매칭된다. dist 가 없으면(개발 중) 마운트 생략.
_DIST_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
if os.path.isdir(_DIST_DIR):
    app.mount("/", StaticFiles(directory=_DIST_DIR, html=True), name="static")

