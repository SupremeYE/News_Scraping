"""뉴스레터(뉴닉 등) 수집기 — 공개 웹 공유 링크에서 본문을 뽑아 기사 dict로 정규화.

뉴닉 같은 이메일 뉴스레터는 RSS 가 없고 메인 사이트는 JS 앱이라 스크래핑이 안 되지만,
Stibee 웹 공유 링크(`https://stibee.com/api/v1.0/emails/share/…`)는 **서버 렌더**라
본문 전체가 HTML 에 그대로 들어있다. 이 링크를 받아 제목/발행일/본문을 추출한다.

핵심 차이(rss.py/boannews.py 대비): 뉴스레터는 **이메일용 테이블 HTML** 이라
extract.py 의 기본 추출(`include_tables=False`)로는 본문이 얇게 나온다. 그래서
표(table)를 포함해 추출하고, 그래도 얇으면 태그를 전부 걷어내는 폴백을 쓴다.

반환 dict 는 다른 수집기와 동일: { title, link, description, pub_date, source, body }.
(body 는 뉴스레터 전용 추가 키 — 호출부가 save_article_body 로 캐시한다.)
"""
import re

import httpx

from naver import _clean  # HTML 태그/엔티티 제거 재사용

try:  # trafilatura 미설치 환경에서도 앱이 죽지 않도록(본문추출 전문 라이브러리)
    import trafilatura
except Exception:  # pragma: no cover
    trafilatura = None

_UA = "Mozilla/5.0"  # 짧은 UA (rss.py/extract.py 와 동일 정책)
_MAX_CHARS = 12000   # 뉴스레터는 장문 → 넉넉히. 프롬프트(_article_block)엔 본문 제한 없음
_SOURCE = "뉴닉"     # 현재 지원 대상(뉴닉 뉴스레터)

# 본문 뒤에 붙는 스티비/뉴닉 공통 푸터 시작 마커(기사 본문엔 나올 일 없는 문자열).
# 이 중 가장 먼저 등장하는 위치에서 본문을 자른다.
_FOOTER_MARKERS = (
    "카톡 친구 추가하기",
    "수신거부",
    "Unsubscribe",
    "스티비가 함께 합니다",
    "무료로 구독하기",
)

# "2026.07.16" / "2026년 07월 16일" / "2026-07-16" 등에서 발행일 추출
_DATE_RE = re.compile(r"(20\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})")
# content 값은 제목에 작은따옴표('롤러코스피')가 들어갈 수 있으므로 여는 따옴표와
# 같은 종류의 닫는 따옴표까지 캡처한다(역참조 (?P=q)).
_OG_TITLE_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+'
    r'content=(?P<q>["\'])(?P<val>.*?)(?P=q)',
    re.IGNORECASE | re.DOTALL,
)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


class NewsletterError(RuntimeError):
    """뉴스레터 링크를 가져오거나 본문을 추출하지 못했을 때 발생."""


def _download(url: str) -> str:
    """공유 링크 HTML 을 문자열로. 실패 시 NewsletterError."""
    try:
        r = httpx.get(
            url, headers={"User-Agent": _UA}, timeout=15.0, follow_redirects=True
        )
    except httpx.RequestError as e:
        raise NewsletterError(f"뉴스레터 링크를 가져오지 못했습니다: {e}") from e
    if r.status_code != 200:
        raise NewsletterError(
            f"뉴스레터 링크 응답 오류(HTTP {r.status_code}): {url}"
        )
    return r.text


def _clean_title(raw: str) -> str:
    """제목에서 발송 메일의 '(광고)' 법적 표기 접두어 등 잡음을 제거한다."""
    title = _clean(raw)
    title = re.sub(r"^\s*\(\s*광고\s*\)\s*", "", title)  # 스티비 '(광고)' 접두어 제거
    return title.strip()


def _parse_title(html: str) -> str:
    m = _OG_TITLE_RE.search(html)
    if m:
        title = _clean_title(m.group("val"))
        if title:
            return title
    m = _TITLE_RE.search(html)
    if m:
        title = _clean_title(m.group(1))
        if title:
            return title
    return "뉴스레터"


def _parse_pub_date(*texts: str) -> str:
    """텍스트(제목/원문 HTML)에서 발행일을 찾아 ISO8601(+09:00)로 반환(없으면 "").

    뉴닉 공유 페이지는 발행일(예: 2026.07.16)이 문서 앞부분에 먼저 나오고, 회사
    등록일·저작권연도 등은 뒤(푸터)에 있으므로 **첫 매칭**이 발행일이다.
    db._article_date 가 ISO 를 파싱하므로 발행일 기준 날짜 분류가 그대로 된다.
    """
    for t in texts:
        if not t:
            continue
        m = _DATE_RE.search(t)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            try:
                return f"{y:04d}-{mo:02d}-{d:02d}T00:00:00+09:00"
            except ValueError:
                continue
    return ""


def _strip_to_text(html: str) -> str:
    """태그를 전부 걷어내고 문단 단위 텍스트만 남기는 폴백 추출.

    이메일 테이블 HTML 처럼 trafilatura 가 본문을 얇게 뽑을 때 사용. <br>/블록 종료
    태그를 줄바꿈으로 바꾼 뒤 나머지 태그를 제거하고, 너무 짧은 줄(메뉴/장식)은 버린다.
    """
    cleaned = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?i)</(p|div|td|tr|li|h[1-6])>", "\n", cleaned)
    cleaned = re.sub(r"(?s)<[^>]+>", " ", cleaned)
    cleaned = _clean(cleaned)  # HTML 엔티티 정리 + 공백 정돈
    lines = []
    seen = set()
    for ln in cleaned.splitlines():
        ln = ln.strip()
        if len(ln) >= 10 and ln not in seen:  # 짧은 장식/중복 줄 제거
            seen.add(ln)
            lines.append(ln)
    return "\n".join(lines)


def _trim_footer(text: str) -> str:
    """본문 뒤 스티비/뉴닉 푸터(수신거부·주소 등)를 잘라낸다.

    푸터 마커 중 가장 먼저(그러나 본문 앞부분 오탐 방지를 위해 전체의 절반 이후에서)
    등장하는 위치에서 자른다.
    """
    half = len(text) // 2
    cut = len(text)
    for marker in _FOOTER_MARKERS:
        pos = text.find(marker, half)  # 앞부분 우연 매칭 방지 위해 후반부에서만 탐색
        if pos != -1:
            cut = min(cut, pos)
    return text[:cut].strip()


def _extract_body(html: str) -> str:
    """뉴스레터 본문 텍스트를 반환. 표 포함 추출 → 얇으면 태그제거 폴백 → 푸터 제거 → 컷."""
    text = ""
    if trafilatura is not None:
        try:
            # 이메일 본문은 표(table) 안에 있으므로 include_tables=True 가 핵심.
            text = trafilatura.extract(
                html, include_comments=False, include_tables=True
            ) or ""
        except Exception:
            text = ""
    if len(text) < 300:  # 추출이 얇으면 폴백과 비교해 더 긴 쪽 채택
        fallback = _strip_to_text(html)
        if len(fallback) > len(text):
            text = fallback
    text = _trim_footer(text.strip())
    return text[:_MAX_CHARS]


def fetch_newsletter(url: str) -> dict:
    """뉴스레터 공유 링크에서 기사 dict 를 만든다.

    반환: { title, link, description, pub_date, source, body }
    실패(다운로드/본문 없음) 시 NewsletterError.
    """
    if not url:
        raise NewsletterError("뉴스레터 링크가 비어 있습니다.")
    html = _download(url)
    title = _parse_title(html)
    body = _extract_body(html)
    if not body:
        raise NewsletterError(
            "뉴스레터 본문을 추출하지 못했습니다. 본문 텍스트를 직접 붙여넣어 보세요."
        )
    # 발행일: 제목에 없으면 원문 HTML 앞부분의 첫 날짜(=발행일)를 쓴다.
    pub_date = _parse_pub_date(title, html)
    # 카드 스니펫: 표 추출 시 생기는 '|' 구분자와 앞쪽 잡음을 정리.
    description = re.sub(r"\s*\|\s*", " ", body[:240]).replace("\n", " ")
    description = re.sub(r"^[\s#>]+", "", description).strip()[:200]
    return {
        "title": title,
        "link": url,
        "description": description,
        "pub_date": pub_date,  # 없으면 저장 시 오늘로 fallback
        "source": _SOURCE,
        "body": body,
    }
