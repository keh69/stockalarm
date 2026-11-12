import { db } from "@/lib/supabase-server";
import { isLiveWindow } from "./market-hours";
import { KisProvider } from "./kis";
import { NaverProvider } from "./naver";
import { YahooProvider } from "./yahoo";
import type { Market, Quote, QuoteProvider } from "./provider";
import { T } from "@/lib/tables";

/** 폴백이 쓰인 경우(예: 네이버 장애 → Yahoo) 최근 20초간 그 이름을 화면에 알린다 */
let fallbackName: string | null = null;
let fallbackUntil = 0;
const activeProviderName = (primary: string) => (fallbackName && Date.now() < fallbackUntil ? fallbackName : primary);

/** 앞 제공자가 못 가져온 종목은 다음 제공자로 넘기는 폴백 체인 */
class ChainProvider implements QuoteProvider {
  readonly name: string;
  constructor(private chain: QuoteProvider[]) {
    this.name = chain[0].name;
  }
  async fetchQuotes(items: { code: string; market: Market }[]): Promise<Quote[]> {
    const got = new Map<string, Quote>();
    for (const p of this.chain) {
      const rest = items.filter((i) => !got.has(i.code));
      if (!rest.length) break;
      try {
        const res = await p.fetchQuotes(rest);
        for (const q of res) got.set(q.code, q);
        if (res.length && p !== this.chain[0]) {
          fallbackName = p.name;
          fallbackUntil = Date.now() + 20_000;
        }
      } catch (e) {
        console.error(`[quotes] ${p.name} failed`, e);
      }
    }
    return [...got.values()];
  }
}

/** KIS 키가 있으면 KIS(공식·실시간) → 네이버(실시간, 비공식) → Yahoo(지연) 순 */
export function getProvider(): QuoteProvider {
  const chain: QuoteProvider[] = [];
  if (process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) chain.push(new KisProvider());
  chain.push(new NaverProvider(), new YahooProvider());
  return new ChainProvider(chain);
}

export type CachedQuote = Quote & { stale: boolean };

/** 종목코드만 주거나, 시장(KOSPI/KOSDAQ)을 알면 함께 준다 — 시장을 알면 종목 테이블을 조회하지 않는다 */
export type QuoteInput = string | { code: string; market: Market };

// 인스턴스 메모리 시세 캐시. 평소에는 DB 캐시를 읽지 않고 이것만 쓴다(Supabase egress 절약).
const mem = new Map<string, { quote: Quote; fetchedAt: number }>();
// DB 시세 캐시(price_cache)에는 1분에 한 번만 써 둔다 — 시세 제공자가 모두 실패했을 때와 서버가 새로 뜬 직후의 대비용.
const DB_WRITE_EVERY_MS = 60_000;
let lastDbWrite = 0;

/**
 * 시세 조회. 평일 08–19시 3초 / 그 외 5분 이내에 가져온 값은 메모리에서 재사용해
 * 여러 탭·cron이 동시에 호출해도 증권사 API 호출 제한을 넘기지 않는다.
 * 실시간 조회에 실패한 종목만 메모리 → DB 캐시 순으로 마지막 값을 쓴다(stale 표시).
 */
export async function getQuotes(input: QuoteInput[]): Promise<{ quotes: Map<string, CachedQuote>; provider: string }> {
  const provider = getProvider();
  const marketOf = new Map<string, Market | undefined>();
  for (const it of input) {
    const code = typeof it === "string" ? it : it.code;
    const market = typeof it === "string" ? undefined : it.market || undefined;
    if (!marketOf.has(code) || market) marketOf.set(code, market ?? marketOf.get(code));
  }
  const unique = [...marketOf.keys()];
  const quotes = new Map<string, CachedQuote>();
  if (!unique.length) return { quotes, provider: provider.name };

  const ttlMs = isLiveWindow() ? 3_000 : 5 * 60_000; // 평일 08–19시 3초, 그 외 5분
  const now = Date.now();

  for (const code of unique) {
    const m = mem.get(code);
    if (m && now - m.fetchedAt <= ttlMs) quotes.set(code, { ...m.quote, stale: false });
  }

  const need = unique.filter((c) => !quotes.has(c));
  if (need.length) {
    // 시장을 모르는 종목만 종목 테이블에서 찾는다
    const unknown = need.filter((c) => !marketOf.get(c));
    if (unknown.length) {
      const { data: meta } = await db().from(T.stocks).select("code, market").in("code", unknown);
      for (const m of meta ?? []) marketOf.set(m.code as string, m.market as string);
    }
    const items = need.filter((c) => marketOf.get(c)).map((c) => ({ code: c, market: marketOf.get(c)! }));
    try {
      const live = items.length ? await provider.fetchQuotes(items) : [];
      const fetchedAt = Date.now();
      for (const q of live) {
        mem.set(q.code, { quote: q, fetchedAt });
        quotes.set(q.code, { ...q, stale: false });
      }
      if (live.length && fetchedAt - lastDbWrite >= DB_WRITE_EVERY_MS) {
        lastDbWrite = fetchedAt;
        const iso = new Date(fetchedAt).toISOString();
        const { error } = await db()
          .from(T.priceCache)
          .upsert(live.map((q) => ({ code: q.code, price: q.price, change_pct: q.changePct, quoted_at: q.quotedAt, fetched_at: iso })));
        if (error) console.error("[quotes] cache write failed", error);
      }
    } catch (e) {
      console.error("[quotes] provider failed", e); // 아래에서 마지막 값으로 degrade
    }

    // 실시간 조회에 실패한 종목: 메모리의 마지막 값 → 없으면 DB 캐시
    const missing = need.filter((c) => !quotes.has(c));
    const fromDb: string[] = [];
    for (const code of missing) {
      const m = mem.get(code);
      if (m) quotes.set(code, { ...m.quote, stale: true });
      else fromDb.push(code);
    }
    if (fromDb.length) {
      const { data: cached } = await db().from(T.priceCache).select("code, price, change_pct, quoted_at, fetched_at").in("code", fromDb);
      for (const c of cached ?? []) {
        const age = now - new Date(c.fetched_at ?? c.quoted_at).getTime();
        quotes.set(c.code, {
          code: c.code,
          price: Number(c.price),
          changePct: c.change_pct === null ? null : Number(c.change_pct),
          quotedAt: c.quoted_at,
          stale: age > ttlMs,
        });
      }
    }
  }
  return { quotes, provider: activeProviderName(provider.name) };
}
