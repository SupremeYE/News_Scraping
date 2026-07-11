"""SQLite 저장 계층 — 키워드와 수집된 기사를 보관한다.

외부 DB 없이 stdlib sqlite3만 사용한다. DB 파일은 backend/news.db 에 생성된다.
"""
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime

# "최근" 기본 뷰가 모아 보여줄 일수(발행일 기준 최근 N일). env 로 조정 가능.
RECENT_DAYS = int(os.getenv("RECENT_DAYS", "7"))


def _article_date(pub_date: str, fallback: str) -> str:
    """기사 발행일(pub_date)을 'YYYY-MM-DD'로 변환한다.

    두 형식을 모두 지원한다:
    - RFC822 (네이버): 'Sat, 11 Jul 2026 18:41:00 +0900'
    - ISO 8601 (보안뉴스 dc:date): '2026-07-11T16:17:00+09:00' (말미 'Z' 포함)
    파싱 실패하거나 값이 없으면 fallback(보통 오늘)을 쓴다.
    """
    if pub_date:
        # 1) RFC822 시도
        try:
            return parsedate_to_datetime(pub_date).date().isoformat()
        except (TypeError, ValueError, OverflowError):
            pass
        # 2) ISO 8601 시도 ('Z' → '+00:00' 치환)
        try:
            return datetime.fromisoformat(pub_date.replace("Z", "+00:00")).date().isoformat()
        except (TypeError, ValueError):
            pass
    return fallback

DB_PATH = os.path.join(os.path.dirname(__file__), "news.db")


@contextmanager
def get_conn():
    """행을 dict처럼 접근할 수 있는 커넥션을 제공한다."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    """앱 시작 시 테이블을 생성한다(이미 있으면 무시).

    keywords 테이블은 "채널"로 일반화되어 있다:
      - kind='naver' : keyword 를 네이버 검색어로 사용
      - kind='rss'   : feed_url 의 RSS 피드를 그대로 수집(keyword 는 표시용 이름)
    """
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS keywords (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword     TEXT NOT NULL UNIQUE,
                kind        TEXT NOT NULL DEFAULT 'naver',
                feed_url    TEXT,
                filter_kw   TEXT,
                source_label TEXT,
                sort_order  INTEGER,
                created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            )
            """
        )
        # 기존 DB(구 스키마) 마이그레이션: 없는 컬럼만 추가해 데이터 보존.
        existing_cols = {r["name"] for r in conn.execute("PRAGMA table_info(keywords)")}
        if "kind" not in existing_cols:
            conn.execute(
                "ALTER TABLE keywords ADD COLUMN kind TEXT NOT NULL DEFAULT 'naver'"
            )
        if "feed_url" not in existing_cols:
            conn.execute("ALTER TABLE keywords ADD COLUMN feed_url TEXT")
        if "filter_kw" not in existing_cols:
            conn.execute("ALTER TABLE keywords ADD COLUMN filter_kw TEXT")
        if "source_label" not in existing_cols:
            conn.execute("ALTER TABLE keywords ADD COLUMN source_label TEXT")
        if "sort_order" not in existing_cols:
            conn.execute("ALTER TABLE keywords ADD COLUMN sort_order INTEGER")
        # sort_order 가 비어 있는(신규 컬럼/기존 행) 채널은 id 순서로 초기화한다.
        conn.execute(
            "UPDATE keywords SET sort_order = id WHERE sort_order IS NULL"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS articles (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword_id    INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
                title         TEXT NOT NULL,
                link          TEXT NOT NULL,
                description   TEXT,
                pub_date      TEXT,
                source        TEXT,
                article_date  TEXT NOT NULL,
                created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE(keyword_id, link)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(article_date)"
        )


# ---------- 키워드 ----------

def list_keywords():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, keyword, kind, feed_url, filter_kw, source_label, sort_order, created_at "
            "FROM keywords ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def add_keyword(keyword: str, kind: str = "naver", feed_url: str = None,
                filter_kw: str = None, source_label: str = None):
    """채널(키워드 또는 RSS)을 추가하고 (row, created) 튜플을 반환.

    이미 같은 이름(keyword)이 있으면 created=False, 기존 row를 반환한다.
    keyword 는 고유 표시명. kind='rss' 인 경우:
      - feed_url: 피드 URL
      - filter_kw: 그 피드 안에서 보여줄 키워드(없으면 전체)
      - source_label: 출처 표시명(예: '보안뉴스')
    """
    keyword = keyword.strip()
    with get_conn() as conn:
        # 새 채널은 맨 끝 순서로 추가한다.
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM keywords"
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT OR IGNORE INTO keywords "
            "(keyword, kind, feed_url, filter_kw, source_label, sort_order) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (keyword, kind, feed_url, filter_kw, source_label, next_order),
        )
        created = cur.rowcount > 0
        row = conn.execute(
            "SELECT id, keyword, kind, feed_url, filter_kw, source_label, sort_order, created_at "
            "FROM keywords WHERE keyword = ?",
            (keyword,),
        ).fetchone()
        return dict(row), created


def reorder_keywords(ordered_ids: list) -> bool:
    """드래그로 정해진 id 순서대로 sort_order 를 0,1,2… 로 재설정한다.

    ordered_ids 에 없는 채널(경합/삭제 등)은 뒤쪽에 원래 상대순서로 이어 붙인다.
    """
    with get_conn() as conn:
        existing = [r["id"] for r in conn.execute(
            "SELECT id FROM keywords ORDER BY sort_order ASC, id ASC"
        ).fetchall()]
        seen = set()
        final = []
        for kid in ordered_ids:
            if kid in existing and kid not in seen:
                final.append(kid)
                seen.add(kid)
        for kid in existing:  # 목록에 빠진 채널은 뒤에 유지
            if kid not in seen:
                final.append(kid)
        for pos, kid in enumerate(final):
            conn.execute(
                "UPDATE keywords SET sort_order = ? WHERE id = ?", (pos, kid)
            )
    return True


def update_filter(keyword_id: int, filter_kw: str) -> bool:
    """채널의 필터 키워드를 갱신한다. 빈 값이면 필터 해제(NULL)."""
    filter_kw = (filter_kw or "").strip() or None
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE keywords SET filter_kw = ? WHERE id = ?", (filter_kw, keyword_id)
        )
        return cur.rowcount > 0


def delete_keyword(keyword_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM keywords WHERE id = ?", (keyword_id,))
        return cur.rowcount > 0


# ---------- 기사 ----------

def save_articles(keyword_id: int, articles: list, fallback_date: str = None) -> int:
    """기사 목록을 저장. 중복(keyword_id, link)은 무시. 신규 저장 건수를 반환.

    분류 날짜는 각 기사의 **발행일(pub_date)** 을 기준으로 한다.
    발행일 파싱이 안 되면 fallback_date(기본 오늘)로 분류한다.
    """
    if fallback_date is None:
        fallback_date = date.today().isoformat()
    inserted = 0
    with get_conn() as conn:
        for a in articles:
            article_date = _article_date(a.get("pub_date", ""), fallback_date)
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO articles
                    (keyword_id, title, link, description, pub_date, source, article_date)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    keyword_id,
                    a.get("title", ""),
                    a.get("link", ""),
                    a.get("description", ""),
                    a.get("pub_date", ""),
                    a.get("source", ""),
                    article_date,
                ),
            )
            inserted += cur.rowcount
    return inserted


def dashboard(target_date: str = None, recent_days: int = None):
    """뉴스를 채널별로 그룹핑해 반환한다.

    두 가지 모드:
      - **recent 모드**(target_date 가 None 또는 "recent"): 발행일이 최근 recent_days
        이내인 기사를 최신순으로 모아 보여준다("최근" 기본 뷰).
      - **특정일 모드**(target_date 가 'YYYY-MM-DD'): 그 발행일의 기사만.

    반환: [{ "keyword_id", "keyword", "kind", "filter_kw", "source_label",
             "count", "articles": [...] }, ...]
    채널은 등록되어 있으면 해당 조건 기사가 없어도 빈 목록으로 포함된다.
    """
    recent_mode = target_date is None or target_date == "recent"
    if recent_mode:
        window = recent_days if recent_days is not None else RECENT_DAYS
        cutoff = (date.today() - timedelta(days=max(0, window - 1))).isoformat()
    with get_conn() as conn:
        keywords = conn.execute(
            "SELECT id, keyword, kind, filter_kw, source_label "
            "FROM keywords ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        result = []
        for kw in keywords:
            if recent_mode:
                sql = (
                    "SELECT title, link, description, pub_date, source "
                    "FROM articles WHERE keyword_id = ? AND article_date >= ?"
                )
                params = [kw["id"], cutoff]
            else:
                sql = (
                    "SELECT title, link, description, pub_date, source "
                    "FROM articles WHERE keyword_id = ? AND article_date = ?"
                )
                params = [kw["id"], target_date]

            # RSS/보안뉴스 채널 필터: 제목/요약에 필터 키워드(들)가 포함된 기사만.
            terms = _filter_terms(kw["filter_kw"])
            if terms:
                ors = " OR ".join(["title LIKE ? OR description LIKE ?" for _ in terms])
                sql += f" AND ({ors})"
                for t in terms:
                    params += [f"%{t}%", f"%{t}%"]

            sql += " ORDER BY pub_date DESC, id DESC"
            arts = conn.execute(sql, params).fetchall()
            result.append(
                {
                    "keyword_id": kw["id"],
                    "keyword": kw["keyword"],
                    "kind": kw["kind"],
                    "filter_kw": kw["filter_kw"],
                    "source_label": kw["source_label"],
                    "count": len(arts),
                    "articles": [dict(a) for a in arts],
                }
            )
        return result


def _filter_terms(filter_kw: str):
    """필터 문자열을 개별 키워드 리스트로 분해(공백/쉼표 구분). ANY(OR) 매칭용."""
    if not filter_kw:
        return []
    return [t for t in re.split(r"[\s,]+", filter_kw.strip()) if t]


def list_dates():
    """기사 발행일 목록(최신순)."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT article_date FROM articles ORDER BY article_date DESC"
        ).fetchall()
        return [r["article_date"] for r in rows]
