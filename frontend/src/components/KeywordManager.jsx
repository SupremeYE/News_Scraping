import { useState } from "react";

// 채널 관리: 출처(네이버/RSS 소스)를 고르고 키워드를 추가. 네이버·RSS 동일 구조.
// - 출처 '네이버' + 키워드 → 네이버 검색 채널
// - 출처 '보안뉴스' + 키워드 → 보안뉴스 피드에서 그 키워드 기사만 (키워드 비우면 전체)
export default function KeywordManager({
  keywords,
  presets = [],
  onAddChannel,
  onDelete,
  onFocusChannel,
  busy,
}) {
  const [value, setValue] = useState("");
  const [source, setSource] = useState("naver"); // 'naver' 또는 preset.name

  const submit = (e) => {
    e.preventDefault();
    const term = value.trim();
    if (source === "naver") {
      if (!term) return;
      onAddChannel({ keyword: term, kind: "naver" });
    } else if (source === "boannews") {
      // 보안뉴스 사이트 검색(최근 기사에서 키워드 매칭). 검색어 필수.
      if (!term) return;
      onAddChannel({ keyword: term, kind: "boannews", source_label: "보안뉴스" });
    } else {
      const preset = presets.find((p) => p.name === source);
      if (!preset) return;
      onAddChannel({
        keyword: term, // 비우면 전체 피드
        kind: "rss",
        feed_url: preset.feed_url,
        source_label: preset.name,
      });
    }
    setValue("");
  };

  const isNaver = source === "naver";
  const isBoannews = source === "boannews";
  const isRss = !isNaver && !isBoannews;

  const placeholder = isBoannews
    ? "보안뉴스에서 검색할 키워드 예: 취약점, 랜섬웨어…"
    : isRss
    ? `${source} 안에서 볼 키워드 (예: KISA · 비우면 전체)`
    : "네이버 키워드 예: 기준금리, AI, 반도체…";

  return (
    <div className="keyword-manager">
      <h2>채널 관리</h2>

      <form className="keyword-add" onSubmit={submit}>
        <select
          className="select"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={busy}
          title="출처 선택"
        >
          <option value="naver">네이버</option>
          <option value="boannews">보안뉴스 검색</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} (RSS)
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          추가
        </button>
      </form>
      <p className="add-hint">
        <b>네이버</b>는 여러 매체에서 검색, <b>보안뉴스 검색</b>은 보안뉴스 최근 기사에서
        키워드 매칭(사이트 검색), <b>RSS</b>는 그 매체의 최신 헤드라인 수집입니다.
        키워드마다 별도 블럭으로 쌓입니다.
      </p>

      {keywords.length === 0 ? (
        <div className="empty" style={{ padding: "8px 0", textAlign: "left" }}>
          아직 채널이 없습니다. 위에서 출처를 고르고 키워드를 추가하세요.
        </div>
      ) : (
        <div className="chips">
          {keywords.map((k) => {
            const tagged = k.kind === "rss" || k.kind === "boannews";
            const tagLabel =
              k.kind === "boannews"
                ? `${k.source_label || "보안뉴스"} 검색`
                : `${k.source_label || "RSS"} RSS`;
            return (
            <span className={`chip ${tagged ? "chip-rss" : ""}`} key={k.id}>
              <button
                type="button"
                className="chip-label"
                title="이 채널로 이동"
                onClick={() => onFocusChannel && onFocusChannel(k.id)}
              >
                {tagged && <span className="chip-tag">{tagLabel}</span>}
                {tagged ? k.filter_kw || "전체" : k.keyword}
              </button>
              <button
                title="삭제"
                onClick={() => onDelete(k.id, k.keyword)}
                disabled={busy}
              >
                ×
              </button>
            </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
