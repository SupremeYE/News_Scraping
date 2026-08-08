"""원문 본문 추출 — 기사 링크에서 광고/메뉴를 걷어낸 본문 텍스트만 뽑는다.

AI 스터디 해설 품질을 위해 제목+요약(스니펫)만이 아니라 **원문 본문**을 프롬프트에
넣으려는 용도. 뉴스 사이트마다 HTML 구조가 달라 trafilatura(본문 추출 전문)를 쓰고,
없거나 실패하면 <p> 태그 정규식 추출로 폴백한다. 최종 실패 시 ""(호출부는 요약으로 폴백).

다운로드는 httpx 로 한다(_download 주석 참고). 본문 추출만 trafilatura 에 맡긴다.
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


_META_CHARSET_RE = re.compile(rb'charset\s*=\s*["\']?\s*([\w-]+)', re.IGNORECASE)


def _decode(r: "httpx.Response") -> str:
    """응답 바이트를 문자열로. 헤더에 charset 이 있으면 그걸 따르고,
    없으면 <meta charset> 을 보고 디코드한다(EUC-KR 국내 매체 대응).
    """
    if r.charset_encoding:  # Content-Type 에 charset 명시 → httpx 판단이 정확
        return r.text
    m = _META_CHARSET_RE.search(r.content[:4096])
    if m:
        try:
            return r.content.decode(m.group(1).decode("ascii", "ignore"), errors="replace")
        except (LookupError, UnicodeDecodeError):
            pass
    return r.text


def _download(url: str) -> str:
    """URL 을 받아 HTML 문자열로.

    httpx 를 먼저 쓴다. trafilatura.fetch_url 은 인코딩을 자동감지하는데
    **EUC-KR(보안뉴스 등 국내 매체)을 GBK 로 오판해 한글이 한자로 깨진다**
    (예: '미토스' → '固配胶'). httpx 는 Content-Type 의 charset 을 그대로
    따르므로 정확하다. httpx 가 실패할 때만 trafilatura 로 폴백한다.
    """
    try:
        r = httpx.get(
            url, headers={"User-Agent": _UA}, timeout=10.0, follow_redirects=True
        )
        if r.status_code == 200:
            html = _decode(r)
            if html:
                return html
    except httpx.RequestError:
        pass
    if trafilatura is not None:
        try:
            return trafilatura.fetch_url(url) or ""
        except Exception:
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
