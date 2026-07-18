"""LLM 스터디 해설 계층 — 프로바이더-무관 얇은 래퍼.

기사(제목+요약)를 받아 학습용 해설 4종을 생성한다:
  - summary : 핵심 요약(무엇을/왜/그래서)
  - terms   : 어려운 용어 풀이 + 예시(JSON 배열)
  - context : 배경·맥락·연결
  - meaning : 나에게의 의미(경제 문해력/커리어/투자)

기본 프로바이더는 OpenAI(신규 SDK 없이 httpx 로 직접 호출). LLM_PROVIDER env 로
분기 가능하게 구성해 두어, 나중에 Anthropic(Claude) 등으로 스왑하기 쉽다.

키(OPENAI_API_KEY)가 없으면 naver.py 의 자격증명 가드와 동일한 패턴으로
LlmCredentialsError 를 던진다. 이 경우 엔드포인트는 '프롬프트 복사'(무료 경로)만
안내하고 warning 을 반환한다.
"""
import json
import os

import httpx

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4o-mini"


class LlmError(RuntimeError):
    """LLM 호출이 실패했을 때 발생."""


class LlmCredentialsError(LlmError):
    """LLM API 키가 설정되지 않았을 때 발생."""


# ---------- 섹션 정의 ----------
# 각 섹션: 사람이 읽는 제목 + 사용자 프롬프트(지시문). system 은 공용.

SECTIONS = {
    "summary": {
        "label": "핵심 요약",
        "instruction": (
            "이 뉴스가 핵심적으로 무엇을 말하는지 3줄로 정리해줘.\n"
            "1) 무엇을: 한 문장\n"
            "2) 왜/배경: 한 문장\n"
            "3) 그래서 뭐가 중요한가: 한 문장\n"
            "불필요한 수식 없이 간결하게."
        ),
    },
    "terms": {
        "label": "용어 풀이",
        # API 경로: 앱이 용어 카드로 파싱하므로 JSON 강제.
        "instruction": (
            "이 뉴스에 나오는 어려운 용어나 개념을 최대 5개 골라 초심자도 이해할 수 있게 "
            "쉬운 말로 설명해줘. 각 용어마다 한두 줄 설명과 일상적인 예시 한 개.\n"
            "반드시 아래 JSON 배열 형식으로만 답해(그 외 텍스트/코드블록 금지):\n"
            '[{"term":"용어","explanation":"쉬운 설명","example":"예시"}]'
        ),
        # 복사(수동) 경로: 사람이 읽으므로 목록 형식.
        "copy_instruction": (
            "이 뉴스에 나오는 어려운 용어나 개념을 최대 5개 골라 초심자도 이해할 수 있게 "
            "쉬운 말로 설명해줘. 각 용어마다 다음 형식으로 정리해줘:\n"
            "- **용어**: 쉬운 설명 (예시: 일상적인 예 한 개)"
        ),
    },
    "context": {
        "label": "맥락·연결",
        "instruction": (
            "이 뉴스의 맥락을 초심자에게 설명해줘.\n"
            "1) 왜 지금 이런 일이 벌어졌는지\n"
            "2) 이 뉴스가 어떤 더 큰 흐름/이슈와 연결되는지\n"
            "3) 앞으로 무엇을 지켜보면 좋을지\n"
            "각 항목 2~3문장."
        ),
    },
    "meaning": {
        "label": "나에게의 의미",
        "instruction": (
            "이 뉴스가 '나'(여러 분야의 지식을 쌓아 커리어에 활용하려는 사람)에게 주는 "
            "의미를 알려줘.\n"
            "1) 이 분야에서 알아두면 좋은 핵심 포인트\n"
            "2) 커리어/실무에 주는 시사점\n"
            "3) (경제·산업·투자와 관련된 뉴스일 때만) 투자·자산 관점의 참고 포인트 "
            "— 관련이 없으면 이 항목은 넣지 마\n"
            "각 항목 2~3문장. 특정 종목 추천이나 단정적 투자 조언은 피하고 '참고' 수준으로."
        ),
    },
}

SECTION_ORDER = ["summary", "terms", "context", "meaning"]

SYSTEM_PROMPT = (
    "너는 뉴스를 초심자에게 쉽게 풀어주는 학습 도우미다. "
    "기사의 주제 분야(경제, 기술·AI, 보안, 산업, 과학, 정치·사회 등)를 스스로 파악하고 "
    "그 분야에 맞게 설명한다. 독자는 여러 분야의 지식을 쌓아 커리어와 판단에 활용하려는 "
    "사람이다. 기사 본문 전체가 아니라 제목과 요약만 주어질 수 있으니, 부족한 부분은 "
    "일반 지식으로 보완하되 확실하지 않은 사실은 단정하지 말고 '아마/일반적으로'처럼 "
    "표현한다. 전문 용어는 풀어서 쓰고, 답변은 한국어로 한다."
)


def _topic_hint(article: dict) -> str:
    """기사가 속한 채널에서 분야/맥락 힌트를 만든다(없으면 '').

    - RSS/보안뉴스: 출처명(+필터 키워드) 예) '보안뉴스 (키워드 '취약점')'
    - 네이버: 검색 키워드가 곧 주제 예) 관심 키워드 'AI'
    """
    kind = article.get("channel_kind")
    if kind in ("rss", "boannews"):
        label = article.get("source_label") or "뉴스 채널"
        kw = article.get("filter_kw")
        return f"{label}" + (f" (키워드 '{kw}')" if kw else "")
    kw = article.get("channel_name")
    return f"관심 키워드 '{kw}'" if kw else ""


def _article_block(article: dict) -> str:
    """기사 제목/출처/분야/본문(또는 요약)을 프롬프트에 넣을 텍스트 블록으로.

    원문 본문(body)이 수집돼 있으면 그것을 우선 사용하고, 없으면 요약 스니펫으로
    폴백한다. 원문 링크도 참고로 첨부한다.
    """
    parts = [f"제목: {article.get('title', '')}"]
    if article.get("source"):
        parts.append(f"출처: {article['source']}")
    hint = _topic_hint(article)
    if hint:
        parts.append(f"분야/맥락: {hint}")
    body = (article.get("body") or "").strip()
    if body:
        parts.append(f"본문:\n{body}")
    elif article.get("description"):
        parts.append(f"요약: {article['description']}")
    if article.get("link"):
        parts.append(f"원문 링크: {article['link']}")
    return "\n".join(parts)


def build_messages(article: dict, section: str):
    """OpenAI chat 메시지(system/user)를 구성해 반환."""
    if section not in SECTIONS:
        raise LlmError(f"알 수 없는 섹션: {section}")
    user = (
        f"{_article_block(article)}\n\n"
        f"[요청]\n{SECTIONS[section]['instruction']}"
    )
    return SYSTEM_PROMPT, user


def _copy_instruction(section: str) -> str:
    """복사(수동) 경로용 지시문. 사람이 읽는 형식(copy_instruction)이 있으면 그걸 쓴다.

    용어 풀이는 API 경로에선 JSON을 강제하지만, 복사본에선 목록으로 읽기 좋게 낸다.
    """
    return SECTIONS[section].get("copy_instruction") or SECTIONS[section]["instruction"]


def build_copy_prompt(article: dict, section: str = "all") -> str:
    """무료 경로용 '복사 프롬프트'. 구독 챗(ChatGPT/Claude)에 붙여넣어 쓴다.

    section='all' 이면 4개 섹션 지시를 한 번에 담는다. 사람이 읽는 용도라
    용어 풀이도 JSON 대신 읽기 좋은 목록으로 요청한다.
    """
    block = _article_block(article)
    if section == "all":
        lines = [SYSTEM_PROMPT, "", "다음 뉴스를 아래 4가지 관점에서 설명해줘.", "", block, ""]
        for i, key in enumerate(SECTION_ORDER, 1):
            lines.append(f"■ {i}. {SECTIONS[key]['label']}")
            lines.append(_copy_instruction(key))
            lines.append("")
        return "\n".join(lines).strip()
    if section not in SECTIONS:
        raise LlmError(f"알 수 없는 섹션: {section}")
    user = f"{_article_block(article)}\n\n[요청]\n{_copy_instruction(section)}"
    return f"{SYSTEM_PROMPT}\n\n{user}"


def build_question_messages(article: dict, question: str):
    """자유 질문 Q&A 용 메시지(system/user)."""
    user = (
        f"{_article_block(article)}\n\n"
        f"[질문]\n{question}\n\n"
        "위 뉴스를 바탕으로 초심자도 이해할 수 있게 구체적으로 답해줘."
    )
    return SYSTEM_PROMPT, user


# ---------- 프로바이더 호출 ----------

def get_model() -> str:
    return os.getenv("STUDY_MODEL", "").strip() or DEFAULT_MODEL


def _openai_key() -> str:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    placeholders = {"", "your_openai_api_key_here", "sk-...", "your_api_key_here"}
    if key in placeholders:
        raise LlmCredentialsError(
            "OpenAI API 키가 없습니다. backend/.env 에 OPENAI_API_KEY 를 설정하거나, "
            "'프롬프트 복사'로 구독 중인 챗(ChatGPT/Claude)에 붙여넣어 사용하세요."
        )
    return key


def _openai_chat(system: str, user: str, model: str) -> str:
    key = _openai_key()
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        # temperature 는 보내지 않는다(기본값 사용).
        # gpt-5 계열 등 일부 모델은 커스텀 temperature 를 거부(기본 1만 허용)하므로,
        # 모델 호환성을 위해 생략한다.
    }
    try:
        resp = httpx.post(OPENAI_URL, headers=headers, json=payload, timeout=60.0)
    except httpx.RequestError as e:
        raise LlmError(f"LLM 요청 실패: {e}") from e
    if resp.status_code != 200:
        raise LlmError(f"LLM 오류 (HTTP {resp.status_code}): {resp.text[:200]}")
    try:
        return resp.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, ValueError) as e:
        raise LlmError(f"LLM 응답 파싱 실패: {e}") from e


def generate(system: str, user: str, model: str = None) -> str:
    """프로바이더에 맞춰 텍스트를 생성한다(기본 OpenAI)."""
    provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()
    model = model or get_model()
    if provider == "openai":
        return _openai_chat(system, user, model)
    # 향후 확장 지점: 'anthropic' 등. 지금은 openai 만 구현.
    raise LlmError(f"지원하지 않는 LLM_PROVIDER: {provider}")


def run_section(article: dict, section: str) -> str:
    """한 섹션의 해설을 생성해 문자열로 반환. terms 는 JSON 문자열."""
    system, user = build_messages(article, section)
    content = generate(system, user)
    if section == "terms":
        content = _normalize_terms(content)
    return content


## ---------- 통합 호출(4섹션 1회) ----------
# "전체 해설"을 한 번의 호출로 처리해 본문(최대 4000자)을 4번 반복 입력하지 않게 한다.
# 응답은 아래 JSON 객체 하나. terms 만 배열(카드 렌더용), 나머지는 문자열.

ALL_INSTRUCTION = (
    "위 뉴스를 아래 4가지 관점에서 설명하고, 반드시 JSON 객체 하나로만 답해라. "
    "코드블록(```)이나 다른 설명 문장 없이 순수 JSON만 출력해.\n"
    "형식:\n"
    "{\n"
    '  "summary": "무엇을 / 왜·배경 / 그래서 왜 중요한가를 각각 한 문장씩, 줄바꿈(\\n)으로 구분한 3줄",\n'
    '  "terms": [{"term":"용어","explanation":"초심자용 쉬운 설명","example":"일상적인 예시"}],\n'
    '  "context": "1) 왜 지금 벌어졌나 2) 무엇과 연결되나 3) 앞으로 볼 것 — 각 2~3문장",\n'
    '  "meaning": "1) 이 분야에서 알아둘 핵심 2) 커리어·실무 시사점 3) (경제·산업 관련일 때만) 투자 참고 — 각 2~3문장"\n'
    "}\n"
    "terms 는 최대 5개. 특정 종목 추천이나 단정적 투자 조언은 피하고 '참고' 수준으로."
)


def build_all_messages(article: dict):
    """통합(4섹션) 호출용 메시지."""
    user = f"{_article_block(article)}\n\n[요청]\n{ALL_INSTRUCTION}"
    return SYSTEM_PROMPT, user


def _parse_all(raw: str) -> dict:
    """통합 응답에서 JSON 객체를 파싱. 코드펜스/앞뒤 잡텍스트를 걷어낸다. 실패 시 LlmError."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    # 앞뒤에 설명이 붙은 경우 첫 '{' ~ 마지막 '}' 만 추출해 재시도
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            pass
    raise LlmError("통합 응답 JSON 파싱 실패")


def run_all_sections(article: dict) -> dict:
    """1회 호출로 4섹션을 생성해 { section: content } 로 반환(terms 는 JSON 문자열).

    파싱 실패/자격증명 문제는 예외로 올려 호출부가 섹션별 방식으로 폴백하게 한다.
    """
    system, user = build_all_messages(article)
    data = _parse_all(generate(system, user))
    result = {}
    for key in SECTION_ORDER:
        val = data.get(key)
        if val is None:
            continue
        if key == "terms":
            if isinstance(val, list):
                result[key] = json.dumps(val, ensure_ascii=False)
            elif isinstance(val, str):
                result[key] = _normalize_terms(val)
        elif isinstance(val, str):
            result[key] = val
        else:  # 혹시 객체/배열이면 문자열화
            result[key] = json.dumps(val, ensure_ascii=False)
    return result


def _normalize_terms(content: str) -> str:
    """terms 응답을 JSON 배열 문자열로 정규화. 파싱 실패 시 원문 텍스트를 그대로 둔다."""
    text = content.strip()
    # 코드블록 펜스 제거(```json ... ```)
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return json.dumps(data, ensure_ascii=False)
    except ValueError:
        pass
    return content
