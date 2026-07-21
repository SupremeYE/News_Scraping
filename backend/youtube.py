"""유튜브 영상 수집기 — 링크로 제목/작성자를 얻고, (브라우저에서 복사한) 자막을 본문으로.

유튜브 자동자막은 서버(비로그인/데이터센터 IP)에서 직접 다운로드가 막혀 있다. 대신
사용자는 브라우저 확장프로그램/‘스크립트 표시’로 **자막 텍스트를 복사해 붙여넣는다**.
이 모듈은 그 자막을 학습 본문(body)으로 쓰고, 제목/작성자/썸네일은 **oEmbed**(키 불필요)로 채운다.

반환 dict 는 다른 수집기와 동일: { title, link, description, pub_date, source, body }.
(body 는 저장 계층이 무시하므로 호출부가 save_article_body 로 캐시한다.)
"""
import glob
import json
import os
import re
import tempfile
from datetime import date

import httpx

from naver import _clean  # HTML 엔티티/공백 정리 재사용

try:  # yt-dlp 미설치 환경에서도 앱이 죽지 않도록(자동 자막추출용)
    from yt_dlp import YoutubeDL
except Exception:  # pragma: no cover
    YoutubeDL = None

_UA = "Mozilla/5.0"
_MAX_CHARS = 12000  # 자막은 뉴스보다 길다 — 스터디 프롬프트에서 다시 4000자로 컷되지만 원문은 넉넉히 보관
_SOURCE = "유튜브"

# watch?v=ID / youtu.be/ID / embed/ID / shorts/ID 에서 11자 영상 id 추출
_ID_RE = re.compile(r"(?:v=|/embed/|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})")
# 붙여넣은 텍스트 안에서 유튜브 URL 을 찾아낸다
_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?(?:youtube\.com/[^\s]+|youtu\.be/[^\s]+)",
    re.IGNORECASE,
)


class YoutubeError(RuntimeError):
    """유튜브 영상 정보를 만들지 못했을 때 발생."""


def find_url(text: str) -> str:
    """텍스트(붙여넣기)에서 첫 유튜브 URL 을 반환(없으면 "")."""
    if not text:
        return ""
    m = _URL_RE.search(text)
    return m.group(0) if m else ""


def _video_id(url: str) -> str:
    m = _ID_RE.search(url or "")
    return m.group(1) if m else ""


def _oembed(clean_url: str):
    """oEmbed 로 (title, author, thumbnail) 반환. 실패 시 (None, None, None)."""
    try:
        r = httpx.get(
            "https://www.youtube.com/oembed",
            params={"url": clean_url, "format": "json"},
            headers={"User-Agent": _UA},
            timeout=15.0,
        )
        if r.status_code == 200:
            j = r.json()
            return (
                _clean(j.get("title", "")) or None,
                _clean(j.get("author_name", "")) or None,
                j.get("thumbnail_url") or None,
            )
    except (httpx.RequestError, ValueError):
        pass
    return None, None, None


def _parse_json3(text: str) -> str:
    """yt-dlp json3 자막 → 평문. events[].segs[].utf8 를 이어붙인다."""
    try:
        data = json.loads(text)
    except ValueError:
        return ""
    lines = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        line = "".join(s.get("utf8", "") for s in segs).replace("\n", " ").strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _parse_vtt(text: str) -> str:
    """VTT 자막 → 평문. 타임스탬프/큐/인라인 태그 제거 + 연속 중복 줄 제거."""
    out = []
    for raw in text.splitlines():
        ln = raw.strip()
        if not ln or ln == "WEBVTT" or "-->" in ln or ln.isdigit():
            continue
        if ln.startswith(("Kind:", "Language:", "NOTE")):
            continue
        ln = re.sub(r"<[^>]+>", "", ln)  # <c>, <00:00:00.000> 등 제거
        ln = _clean(ln).strip()
        if ln and (not out or out[-1] != ln):  # 자동자막의 연속 중복 제거
            out.append(ln)
    return "\n".join(out)


def fetch_transcript(url: str) -> str:
    """yt-dlp 로 한국어 자막(수동 우선, 없으면 자동)을 받아 평문으로 반환.

    실패(미설치/봇차단/자막없음 등)하면 "" — 호출부가 붙여넣기 폴백으로 넘어간다.
    유튜브가 서버 자막 다운로드를 막아도 yt-dlp 는 플레이어 클라이언트를 흉내 내
    받아오는 경우가 많다(가정용 IP 에서 성공률 높음). 봇 차단 시엔 실패할 수 있다.
    """
    if YoutubeDL is None or not url:
        return ""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            opts = {
                "skip_download": True,
                "writesubtitles": True,       # 수동 자막
                "writeautomaticsub": True,    # 자동 생성 자막
                "subtitleslangs": ["ko", "ko-orig", "ko-KR"],
                "subtitlesformat": "json3/vtt/best",
                "outtmpl": os.path.join(tmp, "%(id)s.%(ext)s"),
                "quiet": True,
                "no_warnings": True,
                "noprogress": True,   # 서버 콘솔에 다운로드 진행바 안 찍히도록
                "no_color": True,
            }
            with YoutubeDL(opts) as ydl:
                ydl.download([url])
            files = (
                glob.glob(os.path.join(tmp, "*.json3"))
                or glob.glob(os.path.join(tmp, "*.vtt"))
            )
            if not files:
                return ""
            with open(files[0], encoding="utf-8") as f:
                content = f.read()
            text = _parse_json3(content) if files[0].endswith(".json3") else _parse_vtt(content)
            return text.strip()
    except Exception:  # yt-dlp 는 다양한 예외를 던짐 — 모두 폴백 처리
        return ""


def fetch_youtube(url: str, transcript: str) -> dict:
    """유튜브 영상 1건을 기사 dict 로 만든다.

    - url: 영상 링크. 제목/작성자를 oEmbed 로 채우고, 자막을 못 받으면 yt-dlp 로 자동 추출.
    - transcript: 브라우저에서 복사한 자막 텍스트(= 학습 본문). 붙여넣으면 그걸 우선 사용.

    자막을 붙여넣지도 않고 자동 추출(yt-dlp)도 실패하면 YoutubeError.
    """
    vid = _video_id(url)
    clean_url = f"https://www.youtube.com/watch?v={vid}" if vid else (url or "").strip()

    body = (transcript or "").strip()
    if not body and clean_url:
        # 자막을 안 붙였으면 링크에서 자동 추출 시도(실패하면 "").
        body = fetch_transcript(clean_url)
    if not body:
        raise YoutubeError(
            "자막을 자동으로 가져오지 못했습니다. 유튜브 ‘스크립트 표시’나 확장프로그램에서 "
            "자막을 복사해 붙여넣어 주세요."
        )
    body = body[:_MAX_CHARS]

    title = author = None
    if vid:
        title, author, _thumb = _oembed(clean_url)

    if not title:
        # 링크가 없거나 oEmbed 실패 → 자막 첫 줄로 임시 제목.
        first = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
        title = (first[:70] + "…") if len(first) > 70 else (first or "유튜브 영상")

    source = author or _SOURCE
    # 링크가 없으면 (자막만) 제목 기반 합성 링크로 중복(UNIQUE)만 방지.
    link = clean_url or f"youtube://{title}"
    description = re.sub(r"\s+", " ", body[:220]).strip()[:200]

    return {
        "title": title,
        "link": link,
        "description": description,
        "pub_date": date.today().isoformat(),  # 추가한 날짜로 분류(자막엔 발행일이 없음)
        "source": source,
        "body": body,
    }
