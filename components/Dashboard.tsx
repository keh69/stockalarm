"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Plus, Settings } from "lucide-react";
import { AddHoldingDialog } from "./AddHoldingDialog";
import { EditHoldingDialog } from "./EditHoldingDialog";
import { HoldingHeader, HoldingRow, type DropPos, type SortKey } from "./HoldingRow";
import { sortValue, useColumnPrefs, visibleCols } from "@/lib/columns";
import { useSortPref } from "@/lib/use-sort-pref";
import { isRefreshHours } from "@/lib/quotes/market-hours";
import { useAppTitle } from "@/lib/use-app-title";
import { SummaryCards } from "./SummaryCards";
import { AlertBanner } from "./AlertBanner";
import { SettingsSheet } from "./SettingsSheet";
import { HistoryDialog } from "./HistoryDialog";
import { IndexBar } from "./IndexBar";
import { isAudioReady, notifyBrowser, playAlarm, stopAlarm, unlockAudio } from "@/lib/alarm";
import { pct, timeAgo } from "@/lib/format";
import { useLocalFlag } from "@/lib/use-local-flag";
import { APP_VERSION } from "@/lib/version";
import type { AlertEvent, ClientHolding, QuotesResponse } from "@/lib/types";

const fetcher = async (url: string): Promise<QuotesResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "시세를 불러오지 못했어요");
  return res.json();
};

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 저장 불가 환경 — 무시 */
    }
  },
};

const POLL_MS = 7_000; // 시세 갱신 주기

export function Dashboard() {
  // 자동 갱신은 매일 08:00–19:00(KST)에만. 그 밖의 시간에는 화면을 열 때 한 번만 가져온다.
  // 현재 시각은 렌더 중에 읽지 않고(프리렌더 금지) 1초마다 state로 갱신한다 → 08:00이 되면 자동으로 다시 시작
  const [nowMs, setNowMs] = useState<number | null>(null);
  const inRefreshHours = nowMs === null ? true : isRefreshHours(new Date(nowMs));
  const { data, error, isLoading, mutate } = useSWR<QuotesResponse>("/api/quotes", fetcher, {
    refreshInterval: inRefreshHours ? POLL_MS : 0,
    refreshWhenHidden: true, // 다른 탭/창을 보고 있어도 알림음이 울리도록 계속 확인
    keepPreviousData: true,
    dedupingInterval: 2_000,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState<ClientHolding | null>(null);
  const [soundOn, setSoundOn] = useLocalFlag("sp_sound");
  const [pending, setPending] = useState<AlertEvent[]>([]); // 확인 전 알림 배너
  const known = useRef<Set<string> | null>(null);
  const [sort, setSort] = useSortPref(); // 기본: 매수일 오름차순(맨 아래가 최근), 컴퓨터별 기억
  const [localOrder, setLocalOrder] = useState<string[] | null>(null); // 드래그 직후 즉시 반영용
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: Exclude<DropPos, null> } | null>(null);
  const [title, setTitle] = useAppTitle();
  const [editingTitle, setEditingTitle] = useState(false);
  const titleClicks = useRef<number[]>([]);
  const { prefs, save: saveCols, reset: resetCols } = useColumnPrefs();
  const cols = useMemo(() => visibleCols(prefs), [prefs]);

  useEffect(() => {
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    const t = setInterval(() => setNowMs(Date.now()), 1000); // "n초 전"·갱신 시간대 판정용
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  // 08:00이 되어 갱신 시간이 시작되는 순간 바로 한 번 가져온다 (처음 마운트 때는 SWR이 이미 가져옴)
  const wasInHours = useRef(inRefreshHours);
  useEffect(() => {
    if (inRefreshHours && !wasInHours.current) void mutate();
    wasInHours.current = inRefreshHours;
  }, [inRefreshHours, mutate]);

  // 크롬 탭(창) 제목도 같은 이름으로
  useEffect(() => {
    document.title = title;
  }, [title]);

  // 제목을 1초 안에 5번 빠르게 클릭하면 이름 수정 모드
  const onTitleClick = () => {
    const now = Date.now();
    titleClicks.current = [...titleClicks.current.filter((t) => now - t < 1000), now];
    if (titleClicks.current.length >= 5) {
      titleClicks.current = [];
      setEditingTitle(true);
    }
  };

  // 브라우저는 사용자가 페이지를 한 번 누르기 전에는 소리를 막는다(새로고침하면 다시 잠김).
  // 첫 클릭/키 입력에서 오디오를 미리 풀어두어, 알람이 울릴 때 바로 소리가 나게 한다.
  useEffect(() => {
    const unlock = () => {
      if (!isAudioReady()) void unlockAudio();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // 단축키: 메인 화면에서 숫자 1 → 종목추가 (입력 중이거나 창이 열려 있으면 무시)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "1" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (addOpen || settingsOpen || historyOpen || editing) return;
      e.preventDefault();
      setAddOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen, settingsOpen, historyOpen, editing]);

  // 새 알림 이벤트 감지: 첫 로드엔 소리 없이 배너만, 이후 새 이벤트는 소리+팝업
  useEffect(() => {
    if (!data) return;
    if (known.current === null) {
      known.current = new Set(data.events.map((e) => e.id));
      const lastAck = ls.get("sp_last_ack") ?? "";
      setPending(data.events.filter((e) => e.created_at > lastAck));
      return;
    }
    const fresh = data.events.filter((e) => !known.current!.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => known.current!.add(e.id));
    setPending((p) => [...fresh, ...p]);
    for (const e of fresh) {
      notifyBrowser(`🔔 목표 도달 · ${e.name}`, `수익률 ${pct(Number(e.profit_pct))}`);
    }
    if (soundOn) playAlarm(); // 10초 동안 울림 (확인 버튼을 누르면 즉시 중지)
  }, [data, soundOn]);

  const ack = useCallback(() => {
    stopAlarm();
    ls.set("sp_last_ack", new Date().toISOString());
    setPending([]);
  }, []);

  async function changeSound(on: boolean) {
    setSoundOn(on);
    if (on) {
      await unlockAudio(); // 클릭 직후에 오디오를 풀어야 소리가 난다
      playAlarm(2); // 테스트음
      if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    } else stopAlarm();
  }

  async function patch(h: ClientHolding, body: object) {
    const res = await fetch(`/api/holdings/${h.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) toast.error("변경하지 못했어요");
    await mutate();
  }

  async function remove(h: ClientHolding) {
    const res = await fetch(`/api/holdings/${h.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error("삭제하지 못했어요");
    await mutate();
  }

  const holdings = useMemo(() => data?.holdings ?? [], [data]);

  // 표시 순서: 저장된 순서(드래그 즉시 반영) → 헤더 정렬이 켜져 있으면 그 기준으로 재정렬
  const rows = useMemo(() => {
    let base = holdings;
    if (localOrder) {
      const byId = new Map(holdings.map((h) => [h.id, h]));
      const ordered = localOrder.map((id) => byId.get(id)).filter((h): h is ClientHolding => !!h);
      const rest = holdings.filter((h) => !localOrder.includes(h.id));
      base = [...ordered, ...rest];
    }
    if (!sort) return base;
    const { key, dir } = sort;
    return [...base].sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // 값 없는 종목은 항상 아래
      if (y == null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y as string, "ko") : (x as number) - (y as number);
      return dir === "asc" ? c : -c;
    });
  }, [holdings, localOrder, sort]);

  const onSort = (key: SortKey) => setSort(sort?.key !== key ? { key, dir: "asc" } : sort.dir === "asc" ? { key, dir: "desc" } : null);

  async function saveOrder(ids: string[]) {
    setLocalOrder(ids);
    const res = await fetch("/api/holdings/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? "순서를 저장하지 못했어요");
    mutate();
  }

  function dropOn(targetId: string, pos: Exclude<DropPos, null>) {
    if (!dragId || dragId === targetId) return;
    const ids = rows.map((r) => r.id).filter((id) => id !== dragId);
    let idx = ids.indexOf(targetId);
    if (pos === "after") idx++;
    ids.splice(idx, 0, dragId);
    setSort(null); // 직접 끌어 정렬하면 헤더 정렬은 해제하고 보이는 순서를 새 기본 순서로 저장
    void saveOrder(ids);
  }

  const lastQuoted = holdings.map((h) => h.quotedAt).filter(Boolean).sort().pop();

  return (
    <div className="mx-auto max-w-6xl px-2 pb-10 pt-2 sm:px-4">
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={title}
              maxLength={30}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 무시
                if (e.key === "Enter") {
                  setTitle(e.currentTarget.value);
                  setEditingTitle(false);
                } else if (e.key === "Escape") setEditingTitle(false);
              }}
              onBlur={() => setEditingTitle(false)}
              aria-label="제목 수정"
              placeholder="이름 입력 후 Enter"
              className="h-7 w-48 rounded-sm border border-primary bg-background px-2 text-sm font-bold outline-none"
            />
          ) : (
            <h1 onClick={onTitleClick} className="cursor-default select-none truncate text-base font-extrabold">
              📈 {title}
            </h1>
          )}
          {data && (
            <span className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold ${data.marketOpen ? "bg-up-soft text-up" : "bg-surface-2 text-muted"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${data.marketOpen ? "animate-pulse bg-up" : "bg-muted"}`} />
              {data.marketOpen ? "장중" : "장마감"}
            </span>
          )}
          <span className="num hidden text-[11px] text-muted sm:inline">{!inRefreshHours ? "자동 갱신 중지 (08~19시만 갱신)" : lastQuoted ? `시세 ${timeAgo(lastQuoted)}` : ""}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-bold text-primary-fg hover:opacity-90"
            title="단축키: 1"
          >
            <Plus size={16} strokeWidth={3} /> 종목추가 <kbd className="hidden rounded bg-white/20 px-1 text-[10px] sm:inline">1</kbd>
          </button>
          <button onClick={() => setSettingsOpen(true)} aria-label="알림 설정" className="rounded-lg p-2 hover:bg-surface-2">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <IndexBar live={inRefreshHours} />

      {!soundOn && (
        <button onClick={() => changeSound(true)} className="mb-2 w-full rounded-lg border border-dashed border-primary bg-down-soft px-3 py-1.5 text-left text-xs font-semibold text-primary">
          🔔 소리·팝업 알림 켜기 <span className="font-normal text-muted">— 목표 도달 시 바로 알려드려요</span>
        </button>
      )}

      {soundOn && !isAudioReady() && (
        <div className="mb-2 rounded-lg border border-warn bg-surface-2 px-3 py-1.5 text-xs font-semibold text-warn">
          🔇 알림음이 켜져 있지만 브라우저가 소리를 막고 있어요 — 화면 아무 곳이나 한 번 클릭하면 소리가 켜집니다.
        </div>
      )}

      <AlertBanner events={pending} onAck={ack} />

      {error && !data && <div className="mb-2 rounded-lg bg-up-soft px-3 py-2 text-xs text-up">{error instanceof Error ? error.message : "시세를 불러오지 못했어요"} (자동으로 다시 시도합니다)</div>}
      {data?.provider === "yahoo" && (
        <div className="mb-2 rounded-lg bg-surface-2 px-3 py-1.5 text-[11px] text-muted">
          ⚠️ 네이버 증권 시세를 가져오지 못해 Yahoo Finance(지연 시세)를 쓰고 있어요.
        </div>
      )}

      {isLoading && !data ? (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      ) : holdings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center">
          <p className="text-sm font-semibold">등록한 종목이 없어요</p>
          <p className="mt-1 text-xs text-muted">위의 <b>+ 종목추가</b>를 눌러 종목과 매수가, 목표 수익률을 입력하세요.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <SummaryCards holdings={holdings} />
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <HoldingHeader cols={cols} sort={sort} onSort={onSort} />
            {rows.map((h) => (
              <HoldingRow
                key={h.id}
                h={h}
                cols={cols}
                dropPos={drop?.id === h.id ? drop.pos : null}
                onDragStart={(e) => {
                  setDragId(h.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", h.id); // Firefox 필수
                }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const pos = e.clientY < r.top + r.height / 2 ? "before" : "after";
                  setDrop((d) => (d?.id === h.id && d.pos === pos ? d : { id: h.id, pos }));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drop) dropOn(drop.id, drop.pos);
                  setDragId(null);
                  setDrop(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDrop(null);
                }}
                onDateChange={(d) => patch(h, { bought_at: d })}
                onEdit={() => setEditing(h)}
                onDelete={() => remove(h)}
                onRearm={() => patch(h, { rearm: true })}
              />
            ))}
          </div>
        </div>
      )}

      <div className="mt-1.5 flex justify-end">
        <button
          onClick={() => setHistoryOpen(true)}
          className="h-7 rounded-sm border border-border bg-surface px-3 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-foreground"
        >
          기록
        </button>
      </div>

      <footer className="num mt-4 text-center text-[11px] text-muted">v{APP_VERSION}</footer>

      <HistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} cols={cols} />
      <AddHoldingDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => mutate()} />
      <EditHoldingDialog holding={editing} onClose={() => setEditing(null)} onSaved={() => mutate()} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} events={data?.events ?? []} soundOn={soundOn} onSoundChange={changeSound} colPrefs={prefs} onColPrefs={saveCols} onColReset={resetCols} />
    </div>
  );
}
