"""보안뉴스(boannews.com) 키워드 검색 수집기.

보안뉴스의 사이트 검색은 Google CSE(자바스크립트) 라서 서버에서 스크래핑할 수
없다. 대신 서버렌더되는 '전체기사' 목록 페이지(`t_list.asp`)를 여러 페이지
크롤링해 최근 기사 후보를 모은 뒤, **제목·요약뿐 아니라 기사 본문까지** 훑어
키워드가 든 기사를 골라낸다(실제 사이트 검색처럼 본문 매칭).

본문 매칭이 중요한 이유: 최근 50건 표본에서 제목·요약에만 의존하면 3건, 본문까지
보면 15건이 잡혔다(5배). 대부분의 키워드는 헤드라인이 아니라 본문에 등장한다.

- 장점: 별도 API 키/자격증명 불필요, 발행일이 정확, 특정 매체(보안뉴스)로 한정,
  본문 전체 텍스트 매칭.
- 한계: 전체 아카이브 검색이 아니라 '최근 N페이지'(대략 최근 1~2주) 범위 안에서의
  키워드 필터다. 매일 자동 수집이 누적되므로 일일 대시보드 용도로는 충분하다.
- 비용: 후보 기사마다 본문 페이지를 1회씩 받아온다. 스레드풀로 동시 요청해 속도를
  확보한다(수 초). 키워드가 없으면(둘러보기) 본문은 받지 않는다.

RSS(`rss.py`)가 최신 10건 헤드라인만 주는 한계를 보완한다.
"""
import os
import re
from concurrent.futures import ThreadPoolExecutor

import httpx

from naver import _clean  # HTML 태그/엔티티 정리 재사용

BASE_URL = "https://www.boannews.com/media/t_list.asp"
VIEW_URL = "https://www.boannews.com/media/view.asp"
SOURCE_LABEL = "보안뉴스"

# 크롤링할 목록 페이지 수(1페이지 30건 + 이후 20건). 환경변수로 조정 가능.
# 본문까지 매칭하므로 페이지 수가 적어도 충분히 잡힌다(3페이지 ≈ 70건 ≈ 최근 4~5일).
DEFAULT_PAGES = int(os.getenv("BOANNEWS_PAGES", "3"))
# 본문을 동시에 받아올 스레드 수(과도한 부하 방지). 공유 커넥션풀과 함께 사용.
_BODY_WORKERS = int(os.getenv("BOANNEWS_WORKERS", "12"))

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; NewsDashboard/1.0)"}

# 목록 페이지의 기사 블록 파서(2026-07 기준 boannews 마크업).
_BLOCK = re.compile(r'<div class="news_list">(.*?)</div>', re.S)
_TITLE = re.compile(r'<span class="news_txt"[^>]*>(.*?)</span>', re.S)
_DESC = re.compile(r'class="news_content">(.*?)</a>', re.S)
_LINK = re.compile(r'view\.asp\?idx=(\d+)')
_WRITER = re.compile(r'<span class="news_writer">(.*?)</span>', re.S)
_DATE = re.compile(r'(\d{4})년\s*(\d{2})월\s*(\d{2})일\s*(\d{2}):(\d{2})')
# 기사 본문 컨테이너(schema.org articleBody).
_BODY = re.compile(r'itemprop="articleBody"[^>]*>(.*?)</div>', re.S)


class BoannewsError(RuntimeError):
    """보안뉴스 목록을 가져오거나 파싱하지 못했을 때 발생."""


def _terms(keyword: str):
    """검색어를 개별 토큰으로 분해(공백/쉼표 구분). 하나라도 포함되면 매칭(OR)."""
    return [t for t in re.split(r"[\s,]+", (keyword or "").strip()) if t]


def _parse_pub(writer_text: str) -> str:
    """'... | 2026년 07월 10일 10:28' → ISO8601('2026-07-10T10:28:00+09:00')."""
    m = _DATE.search(writer_text or "")
    if not m:
        return ""
    y, mo, d, h, mi = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:00+09:00"


def _new_client() -> httpx.Client:
    """커넥션을 재사용하는 공유 클라이언트. 매 요청 새 TLS 핸드셰이크를 피해
    본문 다건 조회 속도를 크게 높인다(70건 76s → ~5s)."""
    limits = httpx.Limits(max_connections=16, max_keepalive_connections=16)
    return httpx.Client(
        headers=_HEADERS, timeout=15.0, follow_redirects=True, limits=limits
    )


def _fetch_page(client: httpx.Client, page: int) -> str:
    url = f"{BASE_URL}?Page={page}&kind="
    resp = client.get(url)
    if resp.status_code != 200:
        raise BoannewsError(f"보안뉴스 목록 오류 (HTTP {resp.status_code}, page={page})")
    # 사이트 인코딩은 euc-kr.
    return resp.content.decode("euc-kr", errors="replace")


def _fetch_body(client: httpx.Client, idx: str) -> str:
    """기사 본문(articleBody) 텍스트를 반환한다. 실패하면 빈 문자열."""
    try:
        resp = client.get(VIEW_URL, params={"idx": idx})
        if resp.status_code != 200:
            return ""
        text = resp.content.decode("euc-kr", errors="replace")
    except httpx.RequestError:
        return ""
    m = _BODY.search(text)
    return _clean(m.group(1)) if m else ""


def _articles_in(html_text: str) -> list:
    """목록 페이지 HTML 에서 기사 블록들을 정규화 리스트로 파싱."""
    out = []
    for block in _BLOCK.findall(html_text):
        idx = _LINK.search(block)
        title = _TITLE.search(block)
        if not idx or not title:
            continue
        desc = _DESC.search(block)
        writer = _WRITER.search(block)
        out.append(
            {
                "idx": idx.group(1),
                "title": _clean(title.group(1)),
                "link": f"https://www.boannews.com/media/view.asp?idx={idx.group(1)}",
                "description": _clean(desc.group(1)) if desc else "",
                "pub_date": _parse_pub(writer.group(1) if writer else ""),
                "source": SOURCE_LABEL,
            }
        )
    return out


def search_boannews(keyword: str, pages: int = None) -> list:
    """보안뉴스 최근 기사(여러 페이지)에서 키워드 매칭 기사를 반환한다.

    제목·요약뿐 아니라 **기사 본문까지** 훑어 매칭한다(실제 사이트 검색처럼).
    각 기사: { title, link, description, pub_date, source }
    keyword 가 비어 있으면 크롤링한 최근 기사를 그대로(필터 없이, 본문 조회 없이) 반환.
    """
    if pages is None:
        pages = DEFAULT_PAGES
    pages = max(1, pages)
    terms = _terms(keyword)

    client = _new_client()
    try:
        # 1) 목록 페이지 크롤링 → 후보 기사 수집(중복 제거).
        candidates = {}  # idx → article
        first_error = None
        got_any_page = False

        for p in range(1, pages + 1):
            try:
                html_text = _fetch_page(client, p)
            except (httpx.RequestError, BoannewsError) as e:
                # 일부 페이지 실패는 넘어가되 첫 오류는 기억. 한 페이지도 못 받으면 아래서 raise.
                first_error = e
                continue
            got_any_page = True
            for a in _articles_in(html_text):
                candidates.setdefault(a["idx"], a)

        if not got_any_page:
            raise BoannewsError(
                "보안뉴스 목록을 가져오지 못했습니다"
                + (f" ({first_error})" if first_error else "")
            )

        cand_list = list(candidates.values())

        # 2) 키워드가 없으면 본문 조회 없이 최근 기사 그대로 반환.
        if not terms:
            cand_list.sort(key=lambda a: a["pub_date"], reverse=True)
            return cand_list

        # 3) 각 후보의 본문을 동시에 받아와 제목+요약+본문에서 키워드(OR) 매칭.
        def body_of(a):
            return a["idx"], _fetch_body(client, a["idx"])

        bodies = {}
        with ThreadPoolExecutor(max_workers=_BODY_WORKERS) as pool:
            for idx, body in pool.map(body_of, cand_list):
                bodies[idx] = body
    finally:
        client.close()

    matched = []
    for a in cand_list:
        hay = a["title"] + " " + a["description"] + " " + bodies.get(a["idx"], "")
        if any(t in hay for t in terms):
            matched.append(a)

    # 최신 발행일 순 정렬(발행일 없는 건 뒤로).
    matched.sort(key=lambda a: a["pub_date"], reverse=True)
    return matched
