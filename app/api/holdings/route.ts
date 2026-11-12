import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase-server";
import { getQuotes } from "@/lib/quotes";
import { bumpHoldingsRev, isMissingColumn } from "@/lib/holdings";
import { errorMessage } from "@/lib/errors";
import { T } from "@/lib/tables";


const createSchema = z.object({
  code: z.string().regex(/^[0-9A-Z]{6}$/),
  avg_price: z.number().positive(),
  qty: z.number().int().positive().nullable().optional(),
  target_pct: z.number().positive().max(1000),
  note: z.string().trim().max(100).optional(),
  bought_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // 생략 시 DB 기본값 = 오늘(KST)
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "입력값을 확인해 주세요" }, { status: 400 });
  const body = parsed.data;

  const { data: stock } = await db().from(T.stocks).select("code").eq("code", body.code).maybeSingle();
  if (!stock) return NextResponse.json({ error: "존재하지 않는 종목코드입니다" }, { status: 404 });

  // 실제로 시세가 조회되는 종목만 저장 (잘못된 코드 / 거래정지 방지)
  const { quotes } = await getQuotes([body.code]);
  if (!quotes.has(body.code)) {
    return NextResponse.json({ error: "현재가를 조회할 수 없는 종목입니다" }, { status: 422 });
  }

  const row = {
    ...(body.note ? { note: body.note } : {}), // 비고는 입력했을 때만 저장 (0006 SQL 실행 전에도 비고 없이는 추가 가능)
    code: body.code,
    avg_price: body.avg_price,
    qty: body.qty ?? null,
    target_pct: body.target_pct,
  };
  // 새 종목은 맨 아래로 (sort_order = 현재 최대값 + 1). 컬럼이 아직 없으면 기본 필드만 저장.
  const last = await db().from(T.holdings).select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const extra = isMissingColumn(last.error) ? null : { sort_order: (last.data?.sort_order ?? 0) + 1, ...(body.bought_at ? { bought_at: body.bought_at } : {}) };
  let { data, error } = await db().from(T.holdings).insert(extra ? { ...row, ...extra } : row).select().single();
  if (isMissingColumn(error) && body.note && /note/i.test(error?.message ?? "")) {
    return NextResponse.json({ error: "비고를 저장하려면 DB 업데이트가 필요해요 — supabase/migrations/0006_note.sql 을 SQL Editor에서 실행하세요" }, { status: 500 });
  }
  if (isMissingColumn(error)) ({ data, error } = await db().from(T.holdings).insert(row).select().single());
  if (error) {
    console.error("[holdings.create]", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
  await bumpHoldingsRev();
  return NextResponse.json({ holding: data }, { status: 201 });
}
