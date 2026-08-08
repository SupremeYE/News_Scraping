import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api.js";
import { renderNoteBody } from "../note.jsx";

// 뉴스 카드 클릭 시 열리는 AI 스터디 모달.
// - 섹션별 해설을 생성/열람(캐시). 섹션 목록은 서버(GET /api/study/sections)가 정한다.
// - 자유 질문 Q&A
// - 하이브리드: API 키가 없으면 "프롬프트 복사"로 구독 챗에 붙여넣는 무료 경로
// - 용어장 저장 / 스터디 노트 저장(축적)

// 서버에서 섹션 메타를 못 받았을 때만 쓰는 폴백. 백엔드 SECTION_ORDER 와 맞춰둘 것.
const ORDER_FALLBACK = ["summary", "terms", "context", "critique", "meaning"];
const LABEL_FALLBACK = {
  summary: "핵심 요약",
  terms: "용어 풀이",
  context: "맥락·연결",
  critique: "짚어볼 점",
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
  const [noteSaved, setNoteSaved] = useState(false); // 저장 직후 "완료!" 표시(잠깐)
  const [notePreviewOn, setNotePreviewOn] = useState(false);
  const noteDirty = useRef(false); // 사용자가 노트를 편집했는지(비동기 로드 덮어쓰기 방지)
  // 노트 저장 직후 "새 용어 N개 담을까요?" 안내. { count, text } | null
  const [termHint, setTermHint] = useState(null);
  const [termHintBusy, setTermHintBusy] = useState(false);

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
    setTermHint(null);
    setTab(order[0]);
    noteDirty.current = false; // 새 기사: 편집 플래그 리셋
    api
      .getStudy(articleId)
      .then((r) => alive && setStudy(r.study || {}))
      .catch(() => {});
    api
      .getNote(articleId)
      // 사용자가 이미 타이핑했으면(레이스) 로드로 덮어쓰지 않는다.
      .then((r) => alive && !noteDirty.current && setNote(r?.body || ""))
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
      onToast(`이미 ${order.length}개 해설이 모두 생성돼 있어요`);
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
        onToast("저장되었습니다 ✓");
        setNoteSaved(true);
        setTimeout(() => setNoteSaved(false), 1800);
        // 노트 본문에 아직 용어장에 없는 용어가 있으면 담을지 물어본다.
        // (자동 저장하지 않는 이유: 파서가 엉뚱한 줄을 용어로 볼 수 있어서.)
        try {
          const r = await api.parseTerms({ text: body });
          setTermHint(r?.new_count > 0 ? { count: r.new_count, text: body } : null);
        } catch {
          setTermHint(null); // 파싱 실패는 노트 저장과 무관하므로 조용히 넘어간다.
        }
      } catch (e) {
        setWarning(e.message);
      } finally {
        setNoteSaving(false);
      }
    },
    [articleId, onToast]
  );

  // 안내 배너에서 "용어장에 담기": 이미 있는 용어는 건드리지 않는다(only_new).
  const importNewTermsFromNote = useCallback(async () => {
    if (!termHint || termHintBusy) return;
    setTermHintBusy(true);
    try {
      // 이미 있는 용어는 서버가 알아서 건너뛴다(기본 동작).
      const res = await api.importTerms({
        text: termHint.text,
        article_id: articleId,
      });
      onToast(`용어 ${res.count}개를 용어장에 담았습니다 ✓`);
      setTermHint(null);
      onGlossaryChange && onGlossaryChange();
    } catch (e) {
      setWarning(e.message);
    } finally {
      setTermHintBusy(false);
    }
  }, [termHint, termHintBusy, articleId, onToast, onGlossaryChange]);

  // 제목(heading) + 내용을 노트에 이어 붙여 저장(섹션/Q&A 공용).
  const appendBlock = useCallback(
    (heading, content) => {
      if (!content) return;
      noteDirty.current = true;
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

  // AI 가 만든 설명이므로 기존 항목은 덮어쓰지 않는다(overwrite 안 보냄).
  // 이미 있으면 조용히 넘어가지 말고 그렇다고 알려준다.
  const saveTerm = useCallback(
    async (t) => {
      try {
        const res = await api.addTerm({
          term: t.term,
          explanation: t.explanation,
          example: t.example,
          article_id: articleId,
        });
        onToast(
          res.created
            ? `'${t.term}' 용어장에 저장됨${api.similarNote(res.similar)}`
            : `'${t.term}' 은(는) 이미 용어장에 있어요 (설명은 그대로 뒀습니다)`
        );
        onGlossaryChange && onGlossaryChange();
      } catch (e) {
        setWarning(e.message);
      }
    },
    [articleId, onToast, onGlossaryChange]
  );

  // GPT 응답(복사 경로)을 붙여넣어 용어를 일괄 저장. 담긴 건수를 반환.
  // 이미 있는 용어는 서버가 건너뛴다(skipped) — 그 사실을 토스트에 같이 보여준다.
  const importTerms = useCallback(
    async (text) => {
      const res = await api.importTerms({ text, article_id: articleId });
      const base = res.skipped
        ? `${res.count}개 담김 · ${res.skipped}개는 이미 있어 건너뜀`
        : `${res.count}개 용어장에 담겼어요`;
      // 표기만 다른 기존 용어가 있으면 첫 건만 짚어준다(토스트가 길어지지 않게).
      onToast(base + api.similarNote(res.similar?.[0]?.to));
      onGlossaryChange && onGlossaryChange();
      return res.count + res.skipped; // 0 이면 UI 가 실패로 보므로 처리한 총량을 반환
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

        {/* 노트 저장 후 새 용어 안내. 섹션/Q&A 저장에서도 뜨도록 탭 바깥에 둔다. */}
        {termHint && (
          <div className="term-hint">
            <span className="term-hint-text">
              이 노트에서 아직 담지 않은 용어 <b>{termHint.count}개</b>를
              찾았어요.
            </span>
            <div className="term-hint-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={importNewTermsFromNote}
                disabled={termHintBusy}
              >
                {termHintBusy ? "담는 중…" : "용어장에 담기"}
              </button>
              <button className="btn btn-sm" onClick={() => setTermHint(null)}>
                닫기
              </button>
            </div>
          </div>
        )}

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
              onImportTerms={importTerms}
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
                  <div className="study-answer note-render">
                    {renderNoteBody(answer)}
                  </div>
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
                이 칸 <b>전체가 저장</b>됩니다. 기존 내용을 지우지 말고 이어서 쓰세요.
                (열 때 저장해둔 내용이 자동으로 채워집니다.)
                <br />
                <span className="note-syntax">
                  지원: <code>## 제목</code> · <code>- 목록</code> ·{" "}
                  <code>1. 번호</code> · <code>1) 소제목</code> ·{" "}
                  <code>**굵게**</code> · <code>---</code> ·{" "}
                  <code>[링크](url)</code> · <code>![](이미지url)</code>
                  <br />
                  ChatGPT 답변을 그대로 붙여넣어도 제목·목록이 인식됩니다.
                </span>
              </p>
              <textarea
                className="study-note-area"
                value={note}
                onChange={(e) => {
                  noteDirty.current = true;
                  setNote(e.target.value);
                }}
                placeholder="여기에 메모하거나 답변을 붙여넣으세요…"
                rows={12}
              />
              <div className="study-note-actions">
                <button
                  className={`btn btn-sm ${noteSaved ? "btn-saved" : "btn-primary"}`}
                  onClick={() => saveNote(note)}
                  disabled={noteSaving}
                >
                  {noteSaving ? "저장 중…" : noteSaved ? "✓ 완료!" : "노트 저장"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setNotePreviewOn((v) => !v)}
                >
                  {notePreviewOn ? "미리보기 닫기" : "미리보기"}
                </button>
              </div>
              {notePreviewOn && (
                <div className="note-preview-box">
                  {note.trim() ? (
                    renderNoteBody(note)
                  ) : (
                    <div className="study-empty">아직 내용이 없습니다.</div>
                  )}
                </div>
              )}
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
  onImportTerms,
}) {
  const [importText, setImportText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const runImport = async () => {
    const text = importText.trim();
    if (!text || importing) return;
    setImporting(true);
    try {
      const n = await onImportTerms(text);
      if (n > 0) {
        setImportText("");
        setImportOpen(false);
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="study-section">
      {section === "terms" && (
        <div className="terms-import">
          <button
            className="terms-import-toggle"
            onClick={() => setImportOpen((v) => !v)}
          >
            <span className={`chevron ${importOpen ? "down" : "right"}`}>▸</span>
            GPT 응답 붙여넣어 용어장에 담기
          </button>
          {importOpen && (
            <div className="terms-import-body">
              <p className="study-qa-hint">
                프롬프트를 복사해 ChatGPT/Claude에서 받은 답을 그대로 붙여넣으세요.
                (용어 부분만, 또는 전체 응답을 붙여넣어도 용어만 골라 담습니다.)
              </p>
              <textarea
                className="input"
                rows={5}
                placeholder="예) - **통관 기준 잠정치**: 세관을 통과한… (예시: …)"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <div className="study-note-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={runImport}
                  disabled={importing || !importText.trim()}
                >
                  {importing ? "담는 중…" : "용어장에 담기"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
        <div className="note-render">{renderNoteBody(content)}</div>
      )}
    </div>
  );
}
