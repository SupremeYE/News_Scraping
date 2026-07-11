// 개별 뉴스 기사 카드. 클릭 시 원문을 새 탭으로 연다.

// 절대 시각: "MM/DD HH:MM"
function formatDate(pubDate) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return pubDate;
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 상대 시각: "방금 전 / N분 전 / N시간 전 / N일 전"
// 브라우저 현재 시각 기준으로 각 뉴스마다 계산된다.
function relativeTime(pubDate) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return "";
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 0) return "방금 전"; // 시계 오차 대비
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

export default function NewsCard({ article }) {
  const rel = relativeTime(article.pub_date);
  const abs = formatDate(article.pub_date);
  return (
    <a
      className="news-card"
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="title">{article.title}</div>
      {article.description && <div className="desc">{article.description}</div>}
      <div className="meta">
        {rel && (
          <span className="rel" title={abs}>
            {rel}
          </span>
        )}
        {article.source && <span>{article.source}</span>}
      </div>
    </a>
  );
}
