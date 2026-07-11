import { useCallback, useEffect, useState } from "react";
import Dashboard from "./components/Dashboard.jsx";
import KeywordManager from "./components/KeywordManager.jsx";
import * as api from "./api.js";

export default function App() {
  const [keywords, setKeywords] = useState([]);
  const [presets, setPresets] = useState([]);
  const [groups, setGroups] = useState([]);
  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState("recent"); // "recent" = 최근 모아보기
  const [updating, setUpdating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banner, setBanner] = useState(null);
  // 키워드 클릭 시 해당 패널로 스크롤/펼침 요청. n 을 증가시켜 같은 채널 반복 클릭도 반영.
  const [focus, setFocus] = useState({ id: null, n: 0 });

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const loadDashboard = useCallback(async (date) => {
    const data = await api.getDashboard(date || undefined);
    setGroups(data.groups);
  }, []);

  const refreshAll = useCallback(
    async (date) => {
      const [kw, ds] = await Promise.all([api.getKeywords(), api.getDates()]);
      setKeywords(kw);
      setDates(ds);
      await loadDashboard(date);
    },
    [loadDashboard]
  );

  // 최초 로드 — "최근" 모아보기로 시작
  useEffect(() => {
    refreshAll("recent").catch((e) => setBanner(e.message));
    api.getPresets().then(setPresets).catch(() => {});
  }, [refreshAll]);

  const onSelectDate = async (e) => {
    const date = e.target.value;
    setSelectedDate(date);
    try {
      await loadDashboard(date);
    } catch (err) {
      setBanner(err.message);
    }
  };

  // 채널 추가 공통 처리. payload = { keyword, kind, feed_url, source_label }
  const onAddChannel = async (payload) => {
    setBusy(true);
    try {
      const res = await api.addChannel(payload);
      if (res.warning) setBanner(res.warning);
      else setBanner(null);
      // "최근" 모아보기로 돌아가면 방금 수집된(최근 며칠치) 기사가 바로 보인다.
      setSelectedDate("recent");
      await refreshAll("recent");
      const name = res.keyword?.keyword || payload.keyword || "채널";
      showToast(
        res.warning
          ? `'${name}' 추가됨 (수집 경고: 확인 필요)`
          : `'${name}' 추가 · 뉴스 ${res.new_count}건 수집`
      );
    } catch (err) {
      setBanner(err.message);
    } finally {
      setBusy(false);
    }
  };

  // 드래그로 채널 순서 변경 → 낙관적 재배열 후 서버에 저장
  const onReorderChannels = async (orderIds) => {
    const byId = (arr, key) => (id) => arr.find((x) => x[key] === id);
    setGroups((gs) => orderIds.map(byId(gs, "keyword_id")).filter(Boolean));
    setKeywords((ks) => orderIds.map(byId(ks, "id")).filter(Boolean));
    try {
      await api.reorderChannels(orderIds);
    } catch (err) {
      setBanner(err.message);
      await refreshAll(selectedDate); // 실패 시 서버 상태로 복구
    }
  };

  // 키워드(칩) 클릭 → 해당 채널 패널로 스크롤 + 펼침
  const onFocusChannel = (id) => setFocus((f) => ({ id, n: f.n + 1 }));

  const onDeleteKeyword = async (id, keyword) => {
    setBusy(true);
    try {
      await api.deleteKeyword(id);
      await refreshAll(selectedDate);
      showToast(`'${keyword}' 삭제됨`);
    } catch (err) {
      setBanner(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = async () => {
    setUpdating(true);
    try {
      const res = await api.runUpdate();
      setBanner(null);
      setSelectedDate("recent"); // 최근 모아보기로 이동
      await refreshAll("recent");
      showToast(`업데이트 완료 · 신규 뉴스 ${res.total_new}건`);
    } catch (err) {
      setBanner(err.message);
      showToast("업데이트 실패");
    } finally {
      setUpdating(false);
    }
  };

  // 로컬 기준 오늘(YYYY-MM-DD) — 드롭다운에서 오늘 날짜를 "오늘"로 라벨링.
  const todayIso = new Date().toLocaleDateString("sv-SE");

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          <span className="badge">NEWS</span>
          뉴스 대시보드
        </h1>
        <div className="topbar-actions">
          <select className="select" value={selectedDate} onChange={onSelectDate}>
            <option value="recent">최근</option>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d === todayIso ? `오늘 (${d})` : d}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            onClick={onUpdate}
            disabled={updating}
          >
            {updating ? (
              <>
                <span className="spinner" />
                동기화 중…
              </>
            ) : (
              "↻ 업데이트"
            )}
          </button>
        </div>
      </div>
      <p className="subtitle">
        관심 키워드(네이버)와 뉴스 채널(RSS)로 매일 뉴스를 수집·분류합니다.
        "업데이트"를 누르면 지금 바로 최신 뉴스를 동기화합니다.
      </p>

      {banner && <div className="banner">{banner}</div>}

      <KeywordManager
        keywords={keywords}
        presets={presets}
        onAddChannel={onAddChannel}
        onDelete={onDeleteKeyword}
        onFocusChannel={onFocusChannel}
        busy={busy}
      />

      <Dashboard
        groups={groups}
        isRecent={selectedDate === "recent"}
        onReorder={onReorderChannels}
        focus={focus}
        busy={busy}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
