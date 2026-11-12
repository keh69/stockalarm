import { db } from "@/lib/supabase-server";
import { T } from "@/lib/tables";
import { bumpHoldingsRev } from "@/lib/holdings";

// 공공데이터포털 '금융위원회_KRX상장종목정보' (GetKrxListedInfoService/getItemInfo)
const ENDPOINT = "https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo";

type Item = { srtnCd?: string; isinCd?: string; itmsNm?: string; mrktCtg?: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function fetchPage(basDt: string, pageNo: number): Promise<{ items: Item[]; total: number }> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", process.env.DATA_GO_KR_KEY!);
  url.searchParams.set("resultType", "json");
  url.searchParams.set("numOfRows", "1000");
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("basDt", basDt);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`data.go.kr ${res.status}`);
  const json = await res.json();
  const body = json?.response?.body;
  const raw = body?.items?.item;
  const items: Item[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { items, total: Number(body?.totalCount ?? 0) };
}

/** 최근 영업일 기준으로 전체 상장종목을 stocks 테이블에 upsert */
export async function syncStocks(): Promise<{ basDt: string; count: number }> {
  if (!process.env.DATA_GO_KR_KEY) throw new Error("DATA_GO_KR_KEY 환경변수가 필요합니다");

  // 데이터가 있는 가장 최근 날짜 탐색 (주말/공휴일/미갱신일 대비 최대 10일)
  let basDt = "";
  let first: { items: Item[]; total: number } | null = null;
  for (let back = 0; back < 10 && !first?.items.length; back++) {
    basDt = ymd(new Date(Date.now() - back * 86_400_000));
    first = await fetchPage(basDt, 1);
  }
  if (!first?.items.length) throw new Error("종목 데이터를 찾지 못했습니다");

  const all: Item[] = [...first.items];
  for (let page = 2; all.length < first.total; page++) {
    const { items } = await fetchPage(basDt, page);
    if (!items.length) break;
    all.push(...items);
  }

  const rows = new Map<string, { code: string; name: string; market: string; isin: string | null; updated_at: string }>();
  const now = new Date().toISOString();
  for (const it of all) {
    const code = (it.srtnCd ?? "").replace(/^A/, "").toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(code) || !it.itmsNm) continue;
    rows.set(code, { code, name: it.itmsNm.trim(), market: it.mrktCtg ?? "", isin: it.isinCd ?? null, updated_at: now });
  }

  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 500) {
    const { error } = await db().from(T.stocks).upsert(list.slice(i, i + 500));
    if (error) throw error;
  }
  await bumpHoldingsRev(); // 종목명이 바뀌었을 수 있으므로
  return { basDt, count: list.length };
}
