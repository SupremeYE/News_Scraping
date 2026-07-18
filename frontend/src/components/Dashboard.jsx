import { useEffect, useRef, useState } from "react";
import NewsCard from "./NewsCard.jsx";

// 키워드/채널마다 접이식 패널(블럭). 헤더를 누르면 펼치기/접기.
// 좌측 ⠿ 그립을 잡고 위/아래로 드래그하면 순서를 직접 옮길 수 있고(onReorder),
// 상단 키워드 칩을 누르면 해당 패널로 스크롤 + 펼침(focus prop).
export default function Dashboard({
  groups,
  isRecent = false,
  onReorder,
  onOpenArticle,
  focus = { id: null, n: 0 },
  busy = false,
}) {
  const [open, setOpen] = useState({}); // { [keyword_id]: true } = 펼침
  const [dragId, setDragId] = useState(null); // 드래그 중인 채널
  const [overId, setOverId] = useState(null); // 드롭 대상으로 지나는 채널
  const fromHandle = useRef(false); // 그립에서 시작한 드래그만 허용

  // 키워드 칩 클릭 시: 해당 패널을 펼치고 그 위치로 스크롤.
  useEffect(() => {
    if (focus.id == null) return;
    setOpen((o) => ({ ...o, [focus.id]: true }));
    const el = document.getElementById(`channel-${focus.id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);

  if (!groups || groups.length === 0) {
    return (
      <div className="empty">
        표시할 채널이 없습니다. 위에서 키워드를 추가한 뒤 "업데이트"를 눌러보세요.
      </div>
    );
  }

  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  // 그립을 눌렀을 때만 드래그를 허용(다른 곳을 잡으면 드래그 안 됨).
  const armDrag = () => {
    fromHandle.current = true;
    const disarm = () => {
      fromHandle.current = false;
      window.removeEventListener("mouseup", disarm);
    };
    window.addEventListener("mouseup", disarm);
  };

  const reset = () => {
    fromHandle.current = false;
    setDragId(null);
    setOverId(null);
  };

  const handleDragStart = (e, id) => {
    if (!fromHandle.current) {
      e.preventDefault(); // 그립이 아닌 곳에서 시작된 드래그는 취소
      return;
    }
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(id));
    } catch {
      /* 일부 브라우저 대비 */
    }
  };

  const handleDragOver = (e, id) => {
    if (dragId == null) return;
    e.preventDefault(); // 드롭 허용
    e.dataTransfer.dropEffect = "move";
    if (id !== overId) setOverId(id);
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const src = dragId;
    reset();
    if (src == null || src === targetId) return;
    const ids = groups.map((g) => g.keyword_id);
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1); // 원위치에서 빼서
    ids.splice(to, 0, src); // 대상 위치에 삽입
    if (onReorder) onReorder(ids);
  };

  return (
    <div className="panels">
      {groups.map((g) => {
        const isOpen = !!open[g.keyword_id];
        const tag =
          g.kind === "boannews"
            ? `${g.source_label || "보안뉴스"} 검색`
            : g.kind === "rss"
            ? `${g.source_label || "RSS"} RSS`
            : null;
        const cls =
          `panel ${isOpen ? "open" : "closed"}` +
          (dragId === g.keyword_id ? " dragging" : "") +
          (overId === g.keyword_id && dragId !== g.keyword_id ? " drag-over" : "");
        return (
          <section
            className={cls}
            id={`channel-${g.keyword_id}`}
            key={g.keyword_id}
            draggable={!busy}
            onDragStart={(e) => handleDragStart(e, g.keyword_id)}
            onDragEnd={reset}
            onDragOver={(e) => handleDragOver(e, g.keyword_id)}
            onDrop={(e) => handleDrop(e, g.keyword_id)}
          >
            <div className="panel-header-row">
              <span
                className="drag-grip"
                title="드래그해서 순서 이동"
                onMouseDown={armDrag}
                aria-label="순서 이동 손잡이"
              >
                ⠿
              </span>
              <button
                className="panel-header"
                onClick={() => toggle(g.keyword_id)}
                aria-expanded={isOpen}
              >
                <span className={`chevron ${isOpen ? "down" : "right"}`}>▸</span>
                <span className="panel-title">
                  {tag && <span className="kw-tag">{tag}</span>}
                  {g.kind === "rss" || g.kind === "boannews"
                    ? g.filter_kw || "전체"
                    : g.keyword}
                </span>
                <span className="panel-count">{g.count}건</span>
              </button>
            </div>

            {isOpen && (
              <div className="panel-body">
                {g.articles.length === 0 ? (
                  <div className="empty section-empty">
                    {isRecent
                      ? g.filter_kw
                        ? `최근 '${g.filter_kw}' 관련 기사가 없습니다.`
                        : "최근 수집된 뉴스가 없습니다."
                      : g.filter_kw
                      ? `이 날짜에 '${g.filter_kw}' 관련 기사가 없습니다.`
                      : "이 날짜에 수집된 뉴스가 없습니다."}
                  </div>
                ) : (
                  <div className="card-grid">
                    {g.articles.map((a, idx) => (
                      <NewsCard
                        key={a.id ?? idx}
                        article={a}
                        onOpen={onOpenArticle}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
