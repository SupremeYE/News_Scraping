import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";

// "학습 노트" 뷰 — 축적된 용어장 + 스터디 노트를 모아본다(input 저장소).
// 서브 탭(용어장 | 스터디 노트)으로 한 번에 하나만 보여 스크롤을 줄이고,
// 노트는 아코디언(기본 접힘)으로 접어 둔다. refreshKey 가 바뀌면 다시 로드.

// ── 마크다운-라이트: 노트 본문의 '## 소제목' / '- 목록' 을 렌더(라이브러리 없이) ──
function renderNoteBody(body) {
  const lines = (body || "").split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (/^#{2,3}\s+/.test(t)) {
      out.push(
        <div className="note-h" key={i}>
          {t.replace(/^#{2,3}\s+/, "")}
        </div>
      );
    } else if (/^[-*]\s+/.test(t)) {
      out.push(
        <div className="note-li" key={i}>
          {t.replace(/^[-*]\s+/, "")}
        </div>
      );
    } else if (t === "") {
      out.push(<div className="note-gap" key={i} />);
    } else {
      out.push(
        <div className="note-p" key={i}>
          {line}
        </div>
      );
    }
  });
  return out;
}

// 접힘 상태 미리보기: 마크다운 기호 제거 후 앞부분만.
function notePreview(body, max = 120) {
  const clean = (body || "")
    .replace(/^#{2,3}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export default function LibraryView({ refreshKey, onOpenArticle, onToast }) {
  const [tab, setTab] = useState("glossary"); // 'glossary' | 'notes'
  const [terms, setTerms] = useState([]);
  const [notes, setNotes] = useState([]);
  const [q, setQ] = useState("");
  const [openNotes, setOpenNotes] = useState({}); // { [note.id]: true } = 펼침
  // 용어 직접 추가 폼(복사 경로로 GPT에서 받은 용어를 손으로 담을 때)
  const [nTerm, setNTerm] = useState("");
  const [nExp, setNExp] = useState("");
  const [nEx, setNEx] = useState("");
  const [adding, setAdding] = useState(false);

  const loadTerms = useCallback(async (query) => {
    try {
      setTerms(await api.getGlossary(query || undefined));
    } catch {
      /* ignore */
    }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await api.getNotes());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadTerms(q);
    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const onSearch = (e) => {
    const val = e.target.value;
    setQ(val);
    loadTerms(val);
  };

  const removeTerm = async (id, term) => {
    try {
      await api.deleteTerm(id);
      setTerms((ts) => ts.filter((t) => t.id !== id));
      onToast && onToast(`'${term}' 삭제됨`);
    } catch {
      /* ignore */
    }
  };

  const addTerm = async () => {
    const term = nTerm.trim();
    if (!term) return;
    setAdding(true);
    try {
      await api.addTerm({
        term,
        explanation: nExp.trim() || null,
        example: nEx.trim() || null,
      });
      setNTerm("");
      setNExp("");
      setNEx("");
      await loadTerms(q);
      onToast && onToast(`'${term}' 용어장에 추가됨`);
    } catch (e) {
      onToast && onToast(e.message || "용어 추가 실패");
    } finally {
      setAdding(false);
    }
  };

  const toggleNote = (id) => setOpenNotes((o) => ({ ...o, [id]: !o[id] }));

  const noteArticle = (n) => ({
    id: n.article_id,
    title: n.title,
    link: n.link,
    source: n.source,
    pub_date: n.pub_date,
  });

  return (
    <div className="library">
      <div className="lib-tabs">
        <button
          className={`lib-tab ${tab === "glossary" ? "active" : ""}`}
          onClick={() => setTab("glossary")}
        >
          용어장 <span className="lib-tab-count">{terms.length}</span>
        </button>
        <button
          className={`lib-tab ${tab === "notes" ? "active" : ""}`}
          onClick={() => setTab("notes")}
        >
          스터디 노트 <span className="lib-tab-count">{notes.length}</span>
        </button>
      </div>

      {tab === "glossary" && (
        <section className="lib-block">
          <div className="lib-head">
            <input
              className="input lib-search"
              placeholder="용어 검색…"
              value={q}
              onChange={onSearch}
            />
          </div>

          <div className="term-add-form">
            <input
              className="input term-add-term"
              placeholder="용어 (예: PBR)"
              value={nTerm}
              onChange={(e) => setNTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTerm()}
            />
            <input
              className="input term-add-exp"
              placeholder="쉬운 설명"
              value={nExp}
              onChange={(e) => setNExp(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTerm()}
            />
            <input
              className="input term-add-ex"
              placeholder="예시 (선택)"
              value={nEx}
              onChange={(e) => setNEx(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTerm()}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={addTerm}
              disabled={adding || !nTerm.trim()}
            >
              {adding ? "추가 중…" : "+ 추가"}
            </button>
          </div>

          {terms.length === 0 ? (
            <div className="empty">
              아직 저장된 용어가 없습니다. 뉴스 카드를 열고 "용어 풀이 → + 용어장"으로
              모아보세요.
            </div>
          ) : (
            <div className="term-grid">
              {terms.map((t) => (
                <div className="term-card" key={t.id}>
                  <div className="term-head">
                    <span className="term-name">{t.term}</span>
                    <button
                      className="term-del"
                      onClick={() => removeTerm(t.id, t.term)}
                      aria-label="삭제"
                      title="삭제"
                    >
                      ✕
                    </button>
                  </div>
                  {t.explanation && <div className="term-exp">{t.explanation}</div>}
                  {t.example && <div className="term-ex">예시: {t.example}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "notes" && (
        <section className="lib-block">
          {notes.length === 0 ? (
            <div className="empty">
              아직 저장된 노트가 없습니다. 뉴스 카드의 "내 노트" 또는 "노트에 저장"으로
              기록해보세요.
            </div>
          ) : (
            <div className="note-list">
              {notes.map((n) => {
                const isOpen = !!openNotes[n.id];
                return (
                  <article
                    className={`note-item ${isOpen ? "open" : "closed"}`}
                    key={n.id}
                  >
                    <div className="note-item-head">
                      <button
                        className="note-item-toggle"
                        onClick={() => toggleNote(n.id)}
                        aria-expanded={isOpen}
                      >
                        <span className={`chevron ${isOpen ? "down" : "right"}`}>
                          ▸
                        </span>
                        <span className="note-item-title">{n.title}</span>
                      </button>
                      {n.source && (
                        <span className="note-item-src">{n.source}</span>
                      )}
                      <a
                        href={n.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="note-item-orig"
                        onClick={(e) => e.stopPropagation()}
                      >
                        원문 ↗
                      </a>
                    </div>

                    {isOpen ? (
                      <div className="note-item-body">
                        {renderNoteBody(n.body)}
                        <div className="note-item-actions">
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              onOpenArticle && onOpenArticle(noteArticle(n))
                            }
                          >
                            스터디 패널에서 편집 ↗
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="note-preview"
                        onClick={() => toggleNote(n.id)}
                      >
                        {notePreview(n.body)}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
