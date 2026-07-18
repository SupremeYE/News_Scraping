import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";

// "학습 노트" 뷰 — 축적된 용어장 + 스터디 노트를 모아본다(input 저장소).
// refreshKey 가 바뀌면 다시 로드(스터디 패널에서 용어/노트 저장 시).
export default function LibraryView({ refreshKey, onOpenArticle, onToast }) {
  const [terms, setTerms] = useState([]);
  const [notes, setNotes] = useState([]);
  const [q, setQ] = useState("");
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

  const noteArticle = (n) => ({
    id: n.article_id,
    title: n.title,
    link: n.link,
    source: n.source,
    pub_date: n.pub_date,
  });

  return (
    <div className="library">
      <section className="lib-block">
        <div className="lib-head">
          <h2>용어장</h2>
          <span className="lib-count">{terms.length}개</span>
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

      <section className="lib-block">
        <div className="lib-head">
          <h2>스터디 노트</h2>
          <span className="lib-count">{notes.length}개</span>
        </div>
        {notes.length === 0 ? (
          <div className="empty">
            아직 저장된 노트가 없습니다. 뉴스 카드의 "내 노트" 또는 "노트에 저장"으로
            기록해보세요.
          </div>
        ) : (
          <div className="note-list">
            {notes.map((n) => (
              <article className="note-item" key={n.id}>
                <div className="note-item-head">
                  <button
                    className="note-item-title"
                    onClick={() => onOpenArticle && onOpenArticle(noteArticle(n))}
                    title="스터디 패널 열기"
                  >
                    {n.title}
                  </button>
                  <a
                    href={n.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="note-item-orig"
                  >
                    원문 ↗
                  </a>
                </div>
                {n.source && <div className="note-item-src">{n.source}</div>}
                <div className="note-item-body">{n.body}</div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
