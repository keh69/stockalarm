import { db } from "@/lib/supabase-server";
import { bumpHoldingsRev, profitPct, type HoldingRow } from "@/lib/holdings";
import type { CachedQuote } from "@/lib/quotes";
import { sendTelegram } from "./telegram";
import { T } from "@/lib/tables";

const REARM_BAND = 1; // %p — 경계에서 왔다갔다할 때 알람 폭탄 방지
const COOLDOWN_MS = 10_000; // 알람(텔레그램) 발송 후 10초간은 다음 알람을 보내지 않음

const won = (n: number) => n.toLocaleString("ko-KR");
const sign = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);

/**
 * 시세로 알람 조건을 평가한다. 상태 전환은 `WHERE alert_state='armed'` 조건부 UPDATE로
 * 원자적으로 처리해, 탭 폴링과 cron이 동시에 돌아도 한 번만 발송된다.
 * 상태가 바뀐 종목은 넘겨받은 holdings 객체에도 그대로 반영한다(호출한 쪽이 DB를 다시 읽지 않아도 되게).
 * 반환값: 이번 호출에서 새로 발동한 holding id 목록
 */
export async function evaluateAlerts(holdings: HoldingRow[], quotes: Map<string, CachedQuote>): Promise<string[]> {
  const fired: string[] = [];
  let lastSent: number | null = null; // 가장 최근 알람 발송 시각 (조건을 만족하는 종목이 생겼을 때만 조회)
  let changed = false;

  for (const h of holdings) {
    const q = quotes.get(h.code);
    if (!q || q.stale || !h.enabled) continue;
    const pct = profitPct(q.price, h.avg_price);

    if (h.alert_state === "triggered") {
      // 수익률이 목표보다 REARM_BAND 아래로 내려가면 다시 무장
      if (pct < h.target_pct - REARM_BAND) {
        const { data: rearmed } = await db()
          .from(T.holdings)
          .update({ alert_state: "armed", triggered_kind: null, triggered_at: null })
          .eq("id", h.id)
          .eq("alert_state", "triggered")
          .select("id");
        if (rearmed?.length) changed = true;
        Object.assign(h, { alert_state: "armed", triggered_kind: null, triggered_at: null });
      }
      continue;
    }

    if (pct < h.target_pct) continue;

    // 쿨다운: 직전 알람 후 10초 이내면 이번엔 보내지 않는다. 종목은 armed 상태로 남아
    // 다음 평가(탭 5초 폴링 / cron)에서 쿨다운이 끝나면 다시 발송되므로 알람이 유실되지 않는다.
    if (lastSent === null) {
      const { data: last } = await db().from(T.alertEvents).select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
      lastSent = last ? new Date(last.created_at).getTime() : 0;
    }
    if (Date.now() - lastSent < COOLDOWN_MS) continue;

    const triggeredAt = new Date().toISOString();
    const { data: won_ } = await db()
      .from(T.holdings)
      .update({ alert_state: "triggered", triggered_kind: "target", triggered_at: triggeredAt })
      .eq("id", h.id)
      .eq("alert_state", "armed")
      .select("id");
    if (!won_?.length) continue; // 다른 요청이 먼저 발동시킴

    changed = true;
    Object.assign(h, { alert_state: "triggered", triggered_kind: "target", triggered_at: triggeredAt });
    fired.push(h.id);
    lastSent = Date.now();
    await db().from(T.alertEvents).insert({
      holding_id: h.id,
      code: h.code,
      name: h.name,
      kind: "target",
      price: q.price,
      profit_pct: pct,
    });
    await sendTelegram(
      `🔔🔴 <b>${h.name}</b> (${h.code})
목표 수익률 +${h.target_pct}% 도달
현재가 ${won(q.price)}원 · 매수단가 ${won(h.avg_price)}원
수익률 <b>${sign(pct)}%</b>`,
    );
  }
  if (changed) await bumpHoldingsRev();
  return fired;
}
