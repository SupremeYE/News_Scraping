"""RSS 피드 수집기.

특정 언론사(예: 보안뉴스)의 RSS 피드를 파싱해, 네이버 수집 결과와 동일한
형태의 기사 리스트로 정규화한다. feedparser 가 인코딩(EUC-KR 등)과
dc:date/pubDate 를 알아서 처리한다.
"""
import time
from urllib.parse import urlparse

import feedparser

from naver import _clean  # HTML 태그/엔티티 제거 로직 재사용


class RssError(RuntimeError):
    """RSS 피드를 가져오거나 파싱하지 못했을 때 발생."""


def _entry_pub_date(entry) -> str:
    """엔트리 발행일 문자열을 반환한다.

    원문 문자열(+09:00 같은 타임존 유지)을 우선 사용하고,
    없으면 파싱된 struct_time 으로 ISO(UTC, 'Z')를 만든다.
    """
    for key in ("published", "updated", "date", "created"):
        val = entry.get(key)
        if val:
            return val
    for key in ("published_parsed", "updated_parsed"):
        st = entry.get(key)
        if st:
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", st)
    return ""


def _source_name(parsed, link: str) -> str:
    title = (parsed.feed.get("title") or "").strip() if parsed.feed else ""
    if title:
        return title
    try:
        host = urlparse(link).netloc
        return host.replace("www.", "") if host else ""
    except Exception:
        return ""


def fetch_rss(feed_url: str) -> list:
    """RSS 피드를 파싱해 정규화된 기사 리스트를 반환한다.

    각 기사: { title, link, description, pub_date, source }
    """
    try:
        parsed = feedparser.parse(feed_url)
    except Exception as e:  # feedparser 는 대개 예외를 안 내지만 방어
        raise RssError(f"RSS 파싱 실패: {e}") from e

    entries = parsed.get("entries", [])
    if not entries:
        # bozo_exception 이 있으면 원인을 함께 알린다.
        reason = parsed.get("bozo_exception")
        raise RssError(
            f"RSS 피드에서 기사를 찾지 못했습니다: {feed_url}"
            + (f" ({reason})" if reason else "")
        )

    source = _source_name(parsed, feed_url)
    articles = []
    for e in entries:
        link = e.get("link", "")
        summary = e.get("summary", "") or e.get("description", "")
        articles.append(
            {
                "title": _clean(e.get("title", "")),
                "link": link,
                "description": _clean(summary),
                "pub_date": _entry_pub_date(e),
                "source": source,
            }
        )
    return articles
