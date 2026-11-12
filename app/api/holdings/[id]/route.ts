import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase-server";
import { errorMessage } from "@/lib/errors";
import { snapshotHolding } from "@/lib/history";
import { bumpHoldingsRev } from "@/lib/holdings";
import { T } from "@/lib/tables";

const patchSchema = z
  .object({
    avg_price: z.number().positive(),
    qty: z.number().int().positive().nullable(),
    target_pct: z.number().positive().max(1000),
    enabled: z.boolean(),
    rearm: z.boolean(),
    note: z.string().trim().max(100).nullable(),
    bought_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .partial();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "입력값을 확인해 주세요" }, { status: 400 });
  const { rearm, ...fields } = parsed.data;

  // 조건(단가/목표)이 바뀌거나 사용자가 다시 켜면 알람을 재무장
  const conditionChanged = "avg_price" in fields || "target_pct" in fields;
  const update: Record<string, unknown> = { ...fields };
  if (rearm || conditionChanged || fields.enabled === true) {
    update.alert_state = "armed";
    update.triggered_kind = null;
    update.triggered_at = null;
  }
  const { data, error } = await db().from(T.holdings).update(update).eq("id", id).select().maybeSingle();
  if (error) return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  if (!data) return NextResponse.json({ error: "종목을 찾을 수 없습니다" }, { status: 404 });
  await bumpHoldingsRev();
  return NextResponse.json({ holding: data });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  await snapshotHolding(id); // 삭제 당시의 표 한 줄을 기록으로 보관
  const { error } = await db().from(T.holdings).delete().eq("id", id);
  if (error) return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  await bumpHoldingsRev();
  return NextResponse.json({ ok: true });
}
