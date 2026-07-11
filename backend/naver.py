"""네이버 검색 API(뉴스) 클라이언트.

https://openapi.naver.com/v1/search/news.json 를 호출해 키워드별 뉴스를 가져오고,
응답에 섞인 HTML 태그/엔티티를 정리한 표준 형태로 반환한다.
"""
import html
import os
import re
from urllib.parse import urlparse

import httpx

NAVER_NEWS_URL = "https://openapi.naver.com/v1/search/news.json"

_TAG_RE = re.compile(r"<[^>]+>")


class NaverCredentialsError(RuntimeError):
    """네이버 API 자격증명이 설정되지 않았을 때 발생."""


class NaverApiError(RuntimeError):
    """네이버 API가 오류 응답을 반환했을 때 발생."""


def _clean(text: str) -> str:
    """<b> 등 HTML 태그와 &quot; 같은 엔티티를 제거해 순수 텍스트로 만든다."""
    if not text:
        return ""
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    return text.strip()


def _source_from_link(link: str) -> str:
    """기사 링크의 도메인에서 대략적인 출처를 뽑는다."""
    try:
        host = urlparse(link).netloc
        return host.replace("www.", "") if host else ""
    except Exception:
        return ""


def get_credentials():
    client_id = os.getenv("NAVER_CLIENT_ID", "").strip()
    client_secret = os.getenv("NAVER_CLIENT_SECRET", "").strip()
    placeholders = {"", "your_client_id_here", "your_client_secret_here"}
    if client_id in placeholders or client_secret in placeholders:
        raise NaverCredentialsError(
            "네이버 API 자격증명이 없습니다. backend/.env 에 "
            "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 를 설정하세요. "
            "(https://developers.naver.com 에서 발급)"
        )
    return client_id, client_secret


def fetch_news(keyword: str, display: int = 30, sort: str = "date") -> list:
    """키워드로 뉴스를 검색해 정규화된 기사 리스트를 반환한다.

    각 기사: { title, link, description, pub_date, source }
    """
    client_id, client_secret = get_credentials()
    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }
    params = {"query": keyword, "display": display, "sort": sort}

    try:
        resp = httpx.get(NAVER_NEWS_URL, headers=headers, params=params, timeout=10.0)
    except httpx.RequestError as e:
        raise NaverApiError(f"네이버 API 요청 실패: {e}") from e

    if resp.status_code != 200:
        raise NaverApiError(
            f"네이버 API 오류 (HTTP {resp.status_code}): {resp.text[:200]}"
        )

    items = resp.json().get("items", [])
    articles = []
    for it in items:
        link = it.get("originallink") or it.get("link", "")
        articles.append(
            {
                "title": _clean(it.get("title", "")),
                "link": link,
                "description": _clean(it.get("description", "")),
                "pub_date": it.get("pubDate", ""),
                "source": _source_from_link(link),
            }
        )
    return articles
