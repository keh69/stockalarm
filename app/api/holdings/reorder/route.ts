import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase-server";
import { errorMessage } from "@/lib/errors";
import { T } from "@/lib/tables";
import { bumpHoldingsRev } from "@/lib/holdings";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

/** 드래그로 바뀐 전체 순서를 저장: ids[0]이 맨 위 */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "입력값을 확인해 주세요" }, { status: 400 });
  const results = await Promise.all(parsed.data.ids.map((id, i) => db().from(T.holdings).update({ sort_order: i + 1 }).eq("id", id)));
  await bumpHoldingsRev(); // 일부만 성공했어도 바뀐 것은 반영되게
  const failed = results.find((r) => r.error);
  if (failed?.error) return NextResponse.json({ error: errorMessage(failed.error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}
