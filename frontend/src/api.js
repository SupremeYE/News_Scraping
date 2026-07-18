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
