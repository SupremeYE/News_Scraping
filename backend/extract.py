"""원문 본문 추출 — 기사 링크에서 광고/메뉴를 걷어낸 본문 텍스트만 뽑는다.

AI 스터디 해설 품질을 위해 제목+요약(스니펫)만이 아니라 **원문 본문**을 프롬프트에
넣으려는 용도. 뉴스 사이트마다 HTML 구조가 달라 trafilatura(본문 추출 전문)를 쓰고,
없거나 실패하면 <p> 태그 정규식 추출로 폴백한다. 최종 실패 시 ""(호출부는 요약으로 폴백).
"""
import re

import httpx

from naver import _clean  # HTML 태그/엔티티 제거 재사용

try:  # trafilatura 미설치 환경에서도 앱이 죽지 않도록
    import trafilatura
except Exception:  # pragma: no cover
    trafilatura = None

_UA = "Mozilla/5.0"  # 짧은 UA (rss.py 와 동일 정책: 일부 매체 UA 차단 회피)
_P_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.DOTALL | re.IGNORECASE)

DEFAULT_MAX_CHARS = 4000  # 토큰 비용 관리를 위한 본문 컷


def _regex_extract(html: str) -> str:
    """<p> 문단만 모아 대략적인 본문 추출(폴백). 짧은 조각(메뉴 등)은 버린다."""
    parts = [_clean(m) for m in _P_RE.findall(html)]
    parts = [p for p in parts if len(p) >= 30]
    return "\n".join(parts)


def _download(url: str) -> str:
    """URL 을 받아 HTML 문자열로. trafilatura(인코딩 처리 우수) 우선, 실패 시 httpx."""
    if trafilatura is not None:
        try:
            html = trafilatura.fetch_url(url)
            if html:
                return html
        except Exception:
            pass
    try:
        r = httpx.get(
            url, headers={"User-Agent": _UA}, timeout=10.0, follow_redirects=True
        )
        if r.status_code == 200:
            return r.text
    except httpx.RequestError:
        pass
    return ""


def fetch_article_text(url: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """기사 URL 의 본문 텍스트를 반환(실패하면 "").

    - trafilatura.extract 로 본문 추출(댓글/표 제외)
    - 실패하면 <p> 정규식 폴백
    - max_chars 로 잘라 토큰 비용을 제한
    """
    if not url:
        return ""
    html = _download(url)
    if not html:
        return ""
    text = ""
    if trafilatura is not None:
        try:
            text = trafilatura.extract(
                html, include_comments=False, include_tables=False
            ) or ""
        except Exception:
            text = ""
    if not text:
        text = _regex_extract(html)
    return (text or "").strip()[:max_chars]
