import { db } from "@/lib/supabase-server";
import { T } from "@/lib/tables";
import type { AlertEvent } from "@/lib/types";

// 최근 알림 기록 20건을 서버 메모리에 두고, 가장 최근 기록의 id만 확인해 바뀌었을 때만 다시 받는다.
// (화면이 7초마다 20건 전체를 받던 것을 id 하나로 줄여 Supabase egress 절약. cron이 다른 서버에서 보낸 알림도 id로 감지된다)
const LIMIT = 20;
let cache: { headId: string | null; list: AlertEvent[] } | null = null;

export async function recentEvents(): Promise<AlertEvent[]> {
  const { data: head, error } = await db().from(T.alertEvents).select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const headId = (head?.id as string | undefined) ?? null;
  if (cache && cache.headId === headId) return cache.list;

  const { data, error: e2 } = await db()
    .from(T.alertEvents)
    .select("id, code, name, kind, price, profit_pct, created_at")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (e2) throw e2;
  const list = (data ?? []) as AlertEvent[];
  cache = { headId: list[0]?.id ?? null, list };
  return list;
}
