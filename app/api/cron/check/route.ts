import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { loadHoldingsCached } from "@/lib/holdings";
import { getQuotes } from "@/lib/quotes";
import { isMarketOpen } from "@/lib/quotes/market-hours";
import { evaluateAlerts } from "@/lib/alerts/evaluate";


// Supabase pg_cron + pg_net이 1분마다 호출 (탭이 닫혀 있어도 알람 발송)
export async function POST(req: Request) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMarketOpen()) return NextResponse.json({ skipped: "market closed" });

  const holdings = (await loadHoldingsCached()).filter((h) => h.enabled);
  if (!holdings.length) return NextResponse.json({ checked: 0, fired: [] });
  const { quotes } = await getQuotes(holdings.map((h) => ({ code: h.code, market: h.market })));
  const fired = await evaluateAlerts(holdings, quotes);
  return NextResponse.json({ checked: holdings.length, fired });
}
