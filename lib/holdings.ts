import { db, kvGet, kvSet } from "@/lib/supabase-server";
import { T } from "@/lib/tables";

export type HoldingRow = {
  id: string;
  code: string;
  name: string;
  market: string;
  avg_price: number;
  qty: number | null;
  target_pct: number;
  enabled: boolean;
  alert_state: "armed" | "triggered";
  triggered_kind: "target" | null;
  triggered_at: string | null;
  created_at: string;
  bought_at: string; // YYYY-MM-DD (추가한 날, 수정 가능)
  sort_order: number | null;
  note: string | null;
};

/** 0003_order_date.sql 실행 전(컬럼 없음)인지 판별 — 실행 전에도 앱이 죽지 않게 한다 */
export const isMissingColumn = (e: { message?: string } | null | undefined) =>
  !!e?.message && /column .* does not exist|Could not find the '.*' column/i.test(e.message);

export const kstDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });

export async function loadHoldings(): Promise<HoldingRow[]> {
  const q = () => db().from(T.holdings).select(`*, stocks:${T.stocks}(name, market)`);
  let res = await q().order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (isMissingColumn(res.error)) res = await q().order("created_at", { ascending: true });
  const { data, error } = res;
  if (error) throw error;
  return (data ?? []).map((h) => {
    const { stocks, ...rest } = h as Record<string, unknown> & { stocks: { name: string; market: string } | null };
    return {
      ...rest,
      avg_price: Number(h.avg_price),
      target_pct: Number(h.target_pct),
      name: stocks?.name ?? h.code,
      market: stocks?.market ?? "",
      bought_at: h.bought_at ?? kstDate(h.created_at),
      sort_order: h.sort_order ?? null,
      note: h.note ?? null,
    } as HoldingRow;
  });
}

export const profitPct = (price: number, avg: number) => ((price - avg) / avg) * 100;

// ---- 보유종목 서버 메모리 캐시 (Supabase egress 절약) ----
// 화면이 7초마다 시세를 물어볼 때마다 보유종목 전체를 DB에서 읽으면 전송량이 커진다.
// 그래서 보유종목이 바뀔 때마다 kv의 holdings_rev 값을 새로 바꾸고, 평소에는 이 작은 값만 읽어
// 바뀌지 않았으면 메모리에 둔 목록을 그대로 쓴다. (여러 서버 인스턴스 사이에도 rev로 맞춰진다)
const REV_KEY = "holdings_rev";
const MAX_AGE_MS = 5 * 60_000; // rev를 못 바꾼 경우(DB 직접 수정 등)에 대비해 5분마다는 새로 읽는다
let holdingsCache: { rev: string; at: number; rows: HoldingRow[] } | null = null;

const newRev = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 보유종목을 바꾼 뒤(추가·수정·삭제·순서·알람 상태) 반드시 호출 — 모든 인스턴스가 다음 조회 때 새로 읽게 한다 */
export async function bumpHoldingsRev(): Promise<void> {
  holdingsCache = null;
  try {
    await kvSet(REV_KEY, newRev());
  } catch (e) {
    console.error("[holdings] rev bump failed", e); // 실패해도 MAX_AGE 뒤에는 새로 읽는다
  }
}

/** loadHoldings와 같지만, 바뀐 게 없으면 DB에서 목록을 다시 받지 않는다. 반환값은 복사본이라 고쳐도 캐시에 영향 없음 */
export async function loadHoldingsCached(): Promise<HoldingRow[]> {
  let rev: string | null = null;
  try {
    rev = await kvGet<string>(REV_KEY); // 목록보다 먼저 읽어야, 그 사이 바뀐 내용을 놓치지 않는다
    if (!rev) {
      rev = newRev();
      await kvSet(REV_KEY, rev);
    }
  } catch (e) {
    console.error("[holdings] rev read failed", e);
    rev = null;
  }
  const c = holdingsCache;
  if (!rev || !c || c.rev !== rev || Date.now() - c.at > MAX_AGE_MS) {
    const rows = await loadHoldings();
    holdingsCache = rev ? { rev, at: Date.now(), rows } : null;
    return rows.map((r) => ({ ...r }));
  }
  return c.rows.map((r) => ({ ...r }));
}
