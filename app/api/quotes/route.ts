import { NextResponse, connection } from "next/server";
import { loadHoldingsCached, profitPct } from "@/lib/holdings";
import { getQuotes } from "@/lib/quotes";
import { isMarketOpen } from "@/lib/quotes/market-hours";
import { evaluateAlerts } from "@/lib/alerts/evaluate";
import { recentEvents } from "@/lib/alerts/events";
import { errorMessage } from "@/lib/errors";

// 화면이 7초마다 부르는 곳이라 Supabase 전송량(egress)을 최소로 유지한다:
// 보유종목·알림기록은 바뀌었을 때만 DB에서 받고(그 외엔 작은 확인 값만 읽음), 시세는 메모리 캐시를 쓴다.
export async function GET() {
  await connection(); // 항상 요청 시점에 실행 (빌드 시 프리렌더 방지)
  try {
    const holdings = await loadHoldingsCached();
    const { quotes, provider } = await getQuotes(holdings.map((h) => ({ code: h.code, market: h.market })));
    await evaluateAlerts(holdings, quotes); // 방금 발동/재무장한 상태는 holdings에 바로 반영된다
    const events = await recentEvents();

    return NextResponse.json({
      serverTime: new Date().toISOString(),
      marketOpen: isMarketOpen(),
      provider,
      holdings: holdings.map((h) => {
        const q = quotes.get(h.code);
        return {
          ...h,
          price: q?.price ?? null,
          changePct: q?.changePct ?? null,
          stale: q ? q.stale : true,
          quotedAt: q?.quotedAt ?? null,
          profitPct: q ? profitPct(q.price, h.avg_price) : null,
        };
      }),
      events,
    });
  } catch (e) {
    console.error("[api/quotes]", e);
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
