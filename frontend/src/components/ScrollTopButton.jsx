import { useEffect, useState } from "react";

// 스크롤을 어느 정도 내리면 우하단에 나타나는 원형 "맨 위로" 버튼.
export default function ScrollTopButton() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // 초기 상태 반영
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      className="scroll-top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="맨 위로"
      title="맨 위로"
    >
      ↑
    </button>
  );
}
