// 백엔드 API 래퍼. Vite proxy 를 통해 /api → http://localhost:8000 로 전달된다.

async function req(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = `요청 실패 (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const getKeywords = () => req("/keywords");

export const getPresets = () => req("/rss/presets");

// 채널 추가. payload 예:
//   네이버: { keyword: "AI" }
//   RSS:   { keyword: "KISA", kind: "rss", feed_url: "...", source_label: "보안뉴스" }
//   RSS 전체: { keyword: "", kind: "rss", feed_url: "...", source_label: "보안뉴스" }
export const addChannel = (payload) =>
  req("/keywords", { method: "POST", body: JSON.stringify(payload) });

export const deleteKeyword = (id) =>
  req(`/keywords/${id}`, { method: "DELETE" });

// 뉴스레터(뉴닉) 이슈 1건 추가. payload: { url } 또는 { text, title? }
// 반환: { article: { id, title, article_date } | null, channel }
export const addNewsletter = (payload) =>
  req("/newsletter", { method: "POST", body: JSON.stringify(payload) });

// 유튜브 영상 1건 추가. payload: { text } (링크+자막을 함께 붙여넣어도 됨)
// 반환: { article: { id, title, article_date } | null, channel }
export const addYoutube = (payload) =>
  req("/youtube", { method: "POST", body: JSON.stringify(payload) });

// 드래그로 정한 순서 저장. order: 채널 id 배열(원하는 표시 순서)
export const reorderChannels = (order) =>
  req(`/keywords/reorder`, {
    method: "POST",
    body: JSON.stringify({ order }),
  });

// RSS 채널의 표시 필터 키워드 설정/해제 (빈 값이면 해제)
export const setFilter = (id, filterKw) =>
  req(`/keywords/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ filter_kw: filterKw }),
  });

export const getDashboard = (date) =>
  req(`/dashboard${date ? `?date=${encodeURIComponent(date)}` : ""}`);

export const getDates = () => req("/dates");

export const runUpdate = () => req("/update", { method: "POST" });

// ---------- AI 스터디 ----------

// 섹션 순서/라벨(탭 구성). { order: [...], labels: {...} }
export const getStudySections = () => req("/study/sections");

// 기사의 캐시된 해설만 조회(LLM 미호출). { study: { section: content } }
export const getStudy = (articleId) => req(`/articles/${articleId}/study`);

// 해설 생성. sections 없으면 전체, force 면 재생성. { study, warning }
export const runStudy = (articleId, sections, force = false) =>
  req(`/articles/${articleId}/study`, {
    method: "POST",
    body: JSON.stringify({ sections: sections || null, force }),
  });

// 무료 경로용 복사 프롬프트. section='all' | 각 섹션명. { prompt }
export const getStudyPrompt = (articleId, section = "all") =>
  req(`/articles/${articleId}/prompt?section=${encodeURIComponent(section)}`);

// 자유 질문 Q&A. { answer, warning, prompt? }
export const askArticle = (articleId, question) =>
  req(`/articles/${articleId}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  });

// ---------- 용어장 ----------

export const getGlossary = (q) =>
  req(`/glossary${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const addTerm = (payload) =>
  req("/glossary", { method: "POST", body: JSON.stringify(payload) });

// GPT 응답(용어 섹션/전체)을 붙여넣어 용어를 일괄 저장.
// { count, skipped, terms, similar:[{term, to:[…]}] }
export const importTerms = (payload) =>
  req("/glossary/import", { method: "POST", body: JSON.stringify(payload) });

// 용어 저장 결과를 토스트 문구로. 세 경로(+용어장 / 일괄 담기 / 직접추가)가
// 같은 표현을 쓰도록 여기 한 곳에서 만든다.
// similar = 표기만 다른 기존 용어들(저장은 이미 됐고, 확인만 하라는 안내).
export const similarNote = (similar) => {
  if (!similar || !similar.length) return "";
  const [first, ...rest] = similar;
  const more = rest.length ? ` 외 ${rest.length}건` : "";
  return ` · 비슷한 '${first}'${more} 이(가) 이미 있어요`;
};

// 저장 없이 파싱만(노트 저장 후 담을지 물어보는 용도). { count, new_count, terms }
export const parseTerms = (payload) =>
  req("/glossary/parse", { method: "POST", body: JSON.stringify(payload) });

export const deleteTerm = (id) =>
  req(`/glossary/${id}`, { method: "DELETE" });

// ---------- 스터디 노트 ----------

export const getNotes = () => req("/notes");

export const getNote = (articleId) => req(`/notes/${articleId}`);

export const putNote = (articleId, body) =>
  req(`/notes/${articleId}`, {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
