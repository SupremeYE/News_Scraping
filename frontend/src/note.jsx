// 스터디 노트 본문의 마크다운-라이트 렌더러(공유). 라이브러리 없이 정규식 기반.
// 지원: # ~ ###### 제목, - · * 불릿, 1. 번호목록, 1) 소제목, **굵게**, [텍스트](url),
//       ![alt](url) 또는 이미지 확장자 URL 단독 줄 → 이미지, --- 구분선,
//       **제목**만 있는 줄 → 소제목.
// LibraryView(노트 펼침 렌더)와 StudyPanel(내 노트 미리보기)에서 함께 쓴다.

const IMG_MD_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/; // ![alt](url)
const IMG_URL_RE = /^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))(\?\S*)?$/i;
const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
// 줄머리 장식 기호. 복사 프롬프트가 섹션을 "■ 1. 핵심 요약" 으로 표시하는데 챗이
// 이 기호를 그대로 따라 쓰는 일이 잦다. 떼고 판정해야 "1." 이 섹션 제목으로 잡힌다.
// ('-'·'*' 는 불릿 규칙이 따로 처리하므로 여기 넣지 않는다.)
const DECOR_RE = /^[■◆▪●▶◦□▷※]\s*/;
// 구분선(---, ***, ⸻ …) — 챗 응답이 섹션 사이에 자주 넣는다.
const HR_RE = /^(-{3,}|\*{3,}|_{3,}|—{2,}|⸻+)$/;
// 줄 전체가 **굵게** 인 경우 → 소제목으로 본다(챗이 제목을 굵게만 쓰는 경우가 많다).
const BOLD_ONLY_RE = /^\*\*([^*]+)\*\*[:：]?$/;
// "무엇을: …", "통관 기준 잠정치: …" 처럼 짧은 레이블로 시작하는 줄 → 레이블만 강조.
const LABEL_RE = /^([^:：*[\]]{1,24})([:：])\s+(\S.*)$/;
// "(예: …)" 예시 줄
const EX_RE = /^\(\s*예/;

// 레이블(무엇을:) 이 있으면 굵게, 없으면 그냥 인라인 렌더.
function renderLead(text, key) {
  const m = text.match(LABEL_RE);
  if (m) {
    return [
      <strong className="note-label" key={`${key}-lb`}>
        {m[1]}
        {m[2]}{" "}
      </strong>,
      ...[].concat(renderInline(m[3], key)),
    ];
  }
  return renderInline(text, key);
}

// 한 줄 안의 **굵게** / [링크](url) 를 React 노드 배열로.
function renderInline(text, keyPrefix) {
  const nodes = [];
  let last = 0;
  let i = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>);
    } else {
      nodes.push(
        <a
          key={`${keyPrefix}-a${i}`}
          href={m[3]}
          target="_blank"
          rel="noopener noreferrer"
        >
          {m[2]}
        </a>
      );
    }
    last = INLINE_RE.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : text;
}

// 노트 본문(문자열) → React 요소 배열.
export function renderNoteBody(body) {
  const lines = (body || "").split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const raw = line.trim();
    const decorated = DECOR_RE.test(raw); // '■ 1. 핵심 요약' 처럼 장식 기호가 붙었나
    const t = raw.replace(DECOR_RE, "");
    const key = `l${i}`;

    // 이미지 (마크다운 또는 이미지 URL 단독 줄)
    const mdImg = t.match(IMG_MD_RE);
    const urlImg = t.match(IMG_URL_RE);
    if (mdImg || urlImg) {
      const src = mdImg ? mdImg[2] : urlImg[1] + (urlImg[2] || "");
      const alt = mdImg ? mdImg[1] : "";
      out.push(
        <img className="note-img" src={src} alt={alt} key={key} loading="lazy" />
      );
      return;
    }

    // 구분선 (---, ***, ⸻)
    if (HR_RE.test(t)) {
      out.push(<hr className="note-hr" key={key} />);
      return;
    }

    // 제목 (# ~ ######). 4단계 이상은 h3 스타일로 묶는다(챗이 #### 를 자주 쓴다).
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(
        <div className={`note-h note-h${Math.min(h[1].length, 3)}`} key={key}>
          {renderInline(h[2], key)}
        </div>
      );
      return;
    }

    // '■ 1. 핵심 요약' — 장식 기호 + 번호는 최상위 섹션 머리로 본다. 이렇게 해야
    // 그 안의 '1. 왜 지금…' 하위 항목과 크기가 구분돼 계층이 보인다.
    // ('● 항목' 처럼 번호 없는 장식 줄은 그냥 불릿이므로 여기 걸리지 않는다.)
    if (decorated && /^\d{1,2}[.)]\s+/.test(t)) {
      out.push(
        <div className="note-h note-h2" key={key}>
          {renderInline(t, key)}
        </div>
      );
      return;
    }

    // 번호 제목 (1. 핵심 요약) → 섹션 제목(크게·굵게). 1~2자리만(연도 "2026." 오인 방지)
    const sec = t.match(/^(\d{1,2})\.\s+(.*)$/);
    if (sec) {
      out.push(
        <div className="note-sec" key={key}>
          <span className="note-sec-n">{sec[1]}.</span> {renderInline(sec[2], key)}
        </div>
      );
      return;
    }

    // 소제목 (1) 왜 …) → 굵게
    const sub = t.match(/^(\d{1,2})\)\s+(.*)$/);
    if (sub) {
      out.push(
        <div className="note-subh" key={key}>
          {sub[1]}) {renderInline(sub[2], key)}
        </div>
      );
      return;
    }

    // 줄 전체가 **굵게** 뿐이면 소제목으로.
    const boldOnly = t.match(BOLD_ONLY_RE);
    if (boldOnly) {
      out.push(
        <div className="note-subh" key={key}>
          {boldOnly[1]}
        </div>
      );
      return;
    }

    // 예시 줄 "(예: …)" — 눈에 덜 띄게 별도 스타일.
    if (EX_RE.test(t)) {
      out.push(
        <div className="note-ex" key={key}>
          {renderInline(t, key)}
        </div>
      );
      return;
    }

    if (t === "") {
      out.push(<div className="note-gap" key={key} />);
      return;
    }

    // 불릿 목록(- 항목, * 항목) + 일반 본문 → 들여쓴 불릿으로 통일(가독성).
    const ul = t.match(/^[-*]\s+(.*)$/);
    out.push(
      <div className="note-point" key={key}>
        {renderLead(ul ? ul[1] : t, key)}
      </div>
    );
  });
  return out;
}

// 접힘 상태 미리보기: 마크다운 기호·이미지 제거 후 앞부분만.
export function notePreview(body, max = 120) {
  const clean = (body || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // 이미지 제거
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // 링크 → 텍스트
    .replace(/\*\*([^*]+)\*\*/g, "$1") // 굵게 → 텍스트
    .replace(/^\s*[■◆▪●▶◦□▷※]\s*/gm, "") // 줄머리 장식 기호
    .replace(/^\s*(-{3,}|\*{3,}|_{3,}|—{2,}|⸻+)\s*$/gm, "") // 구분선
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\d{1,2}\.\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
