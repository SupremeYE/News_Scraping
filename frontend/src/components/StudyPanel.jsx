import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../api.js";

// 뉴스 카드 클릭 시 열리는 AI 스터디 모달.
// - 4개 섹션(핵심요약/용어풀이/맥락·연결/나에게의 의미) 해설을 생성/열람(캐시)
// - 자유 질문 Q&A
// - 하이브리드: API 키가 없으면 "프롬프트 복사"로 구독 챗에 붙여넣는 무료 경로
// - 용어장 저장 / 스터디 노트 저장(축적)

const ORDER_FALLBACK = ["summary", "terms", "context", "meaning"];
const LABEL_FALLBACK = {
  summary: "핵심 요약",
  terms: "용어 풀이",
  context: "맥락·연결",
  meaning: "나에게의 의미",
};

// terms 섹션(JSON 배열 문자열)을 파싱. 실패하면 null.
function parseTerms(content) {
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data;
  } catch {
    /* JSON 아니면 일반 텍스트로 취급 */
  }
  return null;
}

export default function StudyPanel({
  article,
  sectionsMeta,
  onClose,
  onToast,
  onGlossaryChange,
}) {
  const order = sectionsMeta?.order?.length ? sectionsMeta.order : ORDER_FALLBACK;
  const labels = sectionsMeta?.labels || LABEL_FALLBACK;

  const [tab, setTab] = useState(order[0]);
  const [study, setStudy] = useState({}); // { section: content }
  const [loading, setLoading] = useState({}); // { section: bool }
  const [warning, setWarning] = useState(null);
  const [promptText, setPromptText] = useState(null); // 복사 실패/수동복사용

  const [note, setNote] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [askedQ, setAskedQ] = useState(""); // 답변에 대응하는 실제 질문(저장용)
  const [asking, setAsking] = useState(false);

  const articleId = article.id;

  // 열릴 때 캐시된 해설 + 노트 로드(LLM 미호출).
  useEffect(() => {
    let alive = true;
    setStudy({});
    setWarning(null);
    setPromptText(null);
    setAnswer(null);
    setQuestion("");
    setTab(order[0]);
    api
      .getStudy(articleId)
      .then((r) => alive && setStudy(r.study || {}))
      .catch(() => {});
    api
      .getNote(articleId)
      .then((r) => alive && setNote(r?.body || ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const generate = useCallback(
    async (section, force = false) => {
      setLoading((l) => ({ ...l, [section]: true }));
      setWarning(null);
      try {
        const res = await api.runStudy(articleId, [section], force);
        if (res.warning) setWarning(res.warning);
        setStudy((s) => ({ ...s, ...res.study }));
      } catch (e) {
        setWarning(e.message);
      } finally {
        setLoading((l) => ({ ...l, [section]: false }));
      }
    },
    [articleId]
  );

  const generateAll = useCallback(async () => {
    const missing = order.filter((s) => !study[s]);
    if (missing.length === 0) {
      onToast("이미 4개 해설이 모두 생성돼 있어요");
      return;
    }
    setLoading((l) => Object.fromEntries(missing.map((s) => [s, true])));
    setWarning(null);
    try {
      const res = await api.runStudy(articleId, missing, false);
      if (res.warning) setWarning(res.warning);
      setStudy((s) => ({ ...s, ...res.study }));
    } catch (e) {
      setWarning(e.message);
    } finally {
      setLoading({});
    }
  }, [articleId, order, study, onToast]);

  const copyPrompt = useCallback(
    async (section) => {
      try {
        const { prompt } = await api.getStudyPrompt(articleId, section);
        setPromptText(prompt);
        try {
          await navigator.clipboard.writeText(prompt);
          onToast("프롬프트 복사됨 · 구독 챗에 붙여넣으세요");
        } catch {
          onToast("아래 상자의 프롬프트를 복사해 사용하세요");
        }
      } catch (e) {
        setWarning(e.message);
      }
    },
    [articleId, onToast]
  );

  const saveNote = useCallback(
    async (body) => {
      setNoteSaving(true);
      try {
        await api.putNote(articleId, body);
        onToast("노트에 저장됨");
      } catch (e) {
        setWarning(e.message);
      } finally {
        setNoteSaving(false);
      }
    },
    [articleId, onToast]
  );

  // 제목(heading) + 내용을 노트에 이어 붙여 저장(섹션/Q&A 공용).
  const appendBlock = useCallback(
    (heading, content) => {
      if (!content) return;
      const block = `${heading}\n${content}`;
      const next = note ? `${note.trimEnd()}\n\n${block}` : block;
      setNote(next);
      saveNote(next);
    },
    [note, saveNote]
  );

  // 섹션 해설을 노트에 이어 붙여 저장.
  const appendToNote = useCallback(
    (section) => appendBlock(`## ${labels[section] || section}`, study[section]),
    [appendBlock, labels, study]
  );

  // Q&A 답변을 '질문 + 답변' 형태로 노트에 저장.
  const saveQaToNote = useCallback(
    () => appendBlock(`## 질문: ${askedQ}`, answer),
    [appendBlock, askedQ, answer]
  );

  const saveTerm = useCallback(
    async (t) => {
      try {
        await api.addTerm({
          term: t.term,
          explanation: t.explanation,
          example: t.example,
          article_id: articleId,
        });
        onToast(`'${t.term}' 용어장에 저장됨`);
        onGlossaryChange && onGlossaryChange();
      } catch (e) {
        setWarning(e.message);
      }
    },
    [articleId, onToast, onGlossaryChange]
  );

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAnswer(null);
    setWarning(null);
    try {
      const res = await api.askArticle(articleId, q);
      if (res.warning) {
        setWarning(res.warning);
        if (res.prompt) setPromptText(res.prompt);
      }
      if (res.answer) {
        setAnswer(res.answer);
        setAskedQ(q);
      }
    } catch (e) {
      setWarning(e.message);
    } finally {
      setAsking(false);
    }
  }, [articleId, question]);

  const pubAbs = useMemo(() => {
    if (!article.pub_date) return "";
    const d = new Date(article.pub_date);
    return isNaN(d.getTime())
      ? article.pub_date
      : d.toLocaleString("ko-KR", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
  }, [article.pub_date]);

  const tabs = [...order, "qa", "note"];
  const tabLabel = (t) =>
    t === "qa" ? "질문하기" : t === "note" ? "내 노트" : labels[t] || t;

  return (
    <div className="study-overlay" onClick={onClose}>
      <div
        className="study-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="study-head">
          <div className="study-head-main">
            <div className="study-title">{article.title}</div>
            <div className="study-sub">
              {article.source && <span>{article.source}</span>}
              {pubAbs && <span>{pubAbs}</span>}
              <a
                href={article.link}
                target="_blank"
                rel="noopener noreferrer"
                className="study-orig"
              >
                원문 열기 ↗
              </a>
            </div>
          </div>
          <button className="study-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="study-actions-top">
          <button className="btn btn-primary btn-sm" onClick={generateAll}>
            ✨ AI로 전체 해설
          </button>
          <button className="btn btn-sm" onClick={() => copyPrompt("all")}>
            📋 전체 프롬프트 복사
          </button>
          <span className="study-hint">
            API 키가 있으면 자동 생성, 없으면 프롬프트를 복사해 구독 챗에 붙여넣으세요.
          </span>
        </div>

        <div className="study-tabs">
          {tabs.map((t) => (
            <button
              key={t}
              className={`study-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
              {order.includes(t) && study[t] && <span className="dot" />}
            </button>
          ))}
        </div>

        {warning && <div className="study-warning">{warning}</div>}

        {promptText && (
          <div className="study-prompt-box">
            <div className="study-prompt-head">
              <span>이 프롬프트를 복사해 ChatGPT/Claude에 붙여넣으세요</span>
              <button
                className="btn btn-sm"
                onClick={() => setPromptText(null)}
              >
                닫기
              </button>
            </div>
            <textarea readOnly value={promptText} rows={8} />
          </div>
        )}

        <div className="study-body">
          {/* 섹션 탭 */}
          {order.includes(tab) && (
            <SectionView
              section={tab}
              label={labels[tab] || tab}
              content={study[tab]}
              loading={!!loading[tab]}
              terms={tab === "terms" ? parseTerms(study[tab]) : null}
              onGenerate={() => generate(tab, !!study[tab])}
              onCopy={() => copyPrompt(tab)}
              onSaveNote={() => appendToNote(tab)}
              onSaveTerm={saveTerm}
            />
          )}

          {/* Q&A 탭 */}
          {tab === "qa" && (
            <div className="study-qa">
              <p className="study-qa-hint">
                이 기사에 대해 궁금한 걸 물어보세요. (예: "이게 왜 중요해?", "○○가
                무슨 뜻이야?")
              </p>
              <div className="study-qa-row">
                <input
                  className="input"
                  placeholder="질문 입력…"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && ask()}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={ask}
                  disabled={asking}
                >
                  {asking ? "생각 중…" : "질문"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => copyPrompt("all")}
                  title="키 없이 구독 챗에서 물어보기"
                >
                  📋
                </button>
              </div>
              {answer && (
                <>
                  <div className="study-content study-answer">{answer}</div>
                  <div className="study-note-actions">
                    <button
                      className="btn btn-sm"
                      onClick={saveQaToNote}
                      disabled={noteSaving}
                    >
                      노트에 저장
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 내 노트 탭 */}
          {tab === "note" && (
            <div className="study-note">
              <p className="study-qa-hint">
                내 정리, 또는 구독 챗에서 받은 답변을 붙여넣어 저장하세요. 저장한
                노트는 "학습 노트"에서 모아볼 수 있습니다.
              </p>
              <textarea
                className="study-note-area"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="여기에 메모하거나 답변을 붙여넣으세요…"
                rows={12}
              />
              <div className="study-note-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => saveNote(note)}
                  disabled={noteSaving}
                >
                  {noteSaving ? "저장 중…" : "노트 저장"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 개별 섹션 렌더링(해설 텍스트 or 용어 카드 목록 + 액션들)
function SectionView({
  section,
  label,
  content,
  loading,
  terms,
  onGenerate,
  onCopy,
  onSaveNote,
  onSaveTerm,
}) {
  return (
    <div className="study-section">
      <div className="study-section-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={onGenerate}
          disabled={loading}
        >
          {loading ? "생성 중…" : content ? "다시 생성" : "✨ AI로 생성"}
        </button>
        <button className="btn btn-sm" onClick={onCopy}>
          📋 프롬프트 복사
        </button>
        {content && (
          <button className="btn btn-sm" onClick={onSaveNote}>
            노트에 저장
          </button>
        )}
      </div>

      {loading && <div className="study-loading">AI가 해설을 작성 중입니다…</div>}

      {!loading && !content && (
        <div className="study-empty">
          아직 생성되지 않았습니다. "AI로 생성"을 누르거나 프롬프트를 복사해
          사용하세요.
        </div>
      )}

      {!loading && content && section === "terms" && terms && (
        <div className="term-list">
          {terms.map((t, i) => (
            <div className="term-card" key={i}>
              <div className="term-head">
                <span className="term-name">{t.term}</span>
                <button
                  className="btn btn-sm btn-save-term"
                  onClick={() => onSaveTerm(t)}
                >
                  + 용어장
                </button>
              </div>
              {t.explanation && (
                <div className="term-exp">{t.explanation}</div>
              )}
              {t.example && (
                <div className="term-ex">예시: {t.example}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && content && !(section === "terms" && terms) && (
        <div className="study-content">{content}</div>
      )}
    </div>
  );
}
