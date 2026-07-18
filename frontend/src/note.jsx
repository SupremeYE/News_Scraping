// 스터디 노트 본문의 마크다운-라이트 렌더러(공유). 라이브러리 없이 정규식 기반.
// 지원: # / ## / ### 제목, - · * 불릿, 1. 번호목록, **굵게**, [텍스트](url),
//       ![alt](url) 또는 이미지 확장자 URL 단독 줄 → 이미지.
// LibraryView(노트 펼침 렌더)와 StudyPanel(내 노트 미리보기)에서 함께 쓴다.

const IMG_MD_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/; // ![alt](url)
const IMG_URL_RE = /^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))(\?\S*)?$/i;
const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;

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
    const t = line.trim();
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

    // 제목 (#, ##, ###)
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      out.push(
        <div className={`note-h note-h${h[1].length}`} key={key}>
          {renderInline(h[2], key)}
        </div>
      );
      return;
    }

    // 번호 목록 (1. 항목) — 1~2자리만(연도 "2026." 오인 방지)
    const ol = t.match(/^(\d{1,2})\.\s+(.*)$/);
    if (ol) {
      out.push(
        <div className="note-li note-li-num" key={key} data-n={`${ol[1]}.`}>
          {renderInline(ol[2], key)}
        </div>
      );
      return;
    }

    // 불릿 목록 (- 항목, * 항목)
    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) {
      out.push(
        <div className="note-li" key={key}>
          {renderInline(ul[1], key)}
        </div>
      );
      return;
    }

    if (t === "") {
      out.push(<div className="note-gap" key={key} />);
      return;
    }

    out.push(
      <div className="note-p" key={key}>
        {renderInline(line, key)}
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
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^\d{1,2}\.\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
