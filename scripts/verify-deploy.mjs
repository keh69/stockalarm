// 푸시 후 실제 홈페이지(Vercel)에 새 버전이 반영됐는지 확인한다.
// 사용: node scripts/verify-deploy.mjs [버전]   (버전 생략 시 lib/version.ts 의 값)
// 환경변수 SITE_URL 로 주소 변경 가능.
// 규칙: 1분(60초) 안에 반영되지 않으면 기다리기를 멈추고 GitHub에 기록된 Vercel 배포 상태를 보여준다
//       (종료코드 3 → 원인을 찾아 고치고 다시 푸시한 뒤 이 스크립트를 다시 실행).
import { readFileSync } from "node:fs";

const site = process.env.SITE_URL ?? "https://stockprofit-psi.vercel.app";
const repo = "keh69/stockprofit";
const LIMIT_MS = 60_000;
const version =
  process.argv[2] ?? /APP_VERSION = "([^"]+)"/.exec(readFileSync(new URL("../lib/version.ts", import.meta.url), "utf8"))?.[1];
if (!version) throw new Error("버전을 찾지 못했습니다");

const started = Date.now();
let live = "(없음)";
for (;;) {
  try {
    const res = await fetch(`${site}/?cb=${Date.now()}`, { cache: "no-store" });
    const html = await res.text();
    live = /v(?:<!-- -->)?(\d{4}-\d{2}-\d{2}-\d+)/.exec(html)?.[1] ?? `(HTTP ${res.status}, 버전 표시 없음)`;
    if (res.ok && live === version) {
      const api = await fetch(`${site}/api/quotes`, { cache: "no-store" });
      const sec = Math.round((Date.now() - started) / 1000);
      console.log(`✅ 실제 홈페이지 반영 확인: v${live} (${site}) · /api/quotes HTTP ${api.status} · 확인까지 ${sec}초`);
      process.exit(api.ok ? 0 : 2);
    }
  } catch (e) {
    live = `(접속 오류: ${e.message})`;
  }
  if (Date.now() - started > LIMIT_MS) break;
  console.log(`… 대기 ${Math.round((Date.now() - started) / 1000)}초 — 홈페이지 v${live}, 기다리는 버전 v${version}`);
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(`\n⏱ 1분이 지났는데 아직 반영되지 않음 (홈페이지 v${live}, 기대 v${version}). 기다리기를 멈추고 원인을 확인합니다.`);
try {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/main/status`, { headers: { "user-agent": "verify-deploy" } });
  const j = await r.json();
  console.log(`GitHub 커밋 ${String(j.sha).slice(0, 7)} 상태: ${j.state}`);
  for (const s of j.statuses ?? []) console.log(` - ${s.context}: ${s.state} — ${s.description}\n   ${s.target_url}`);
  if (j.state === "failure" || j.state === "error") console.log("→ 배포 실패: 로컬에서 `npm run build` 로 같은 오류를 재현해 수정하세요.");
  else console.log("→ 아직 빌드 중이거나 상태 미보고: 로컬 `npm run build` 가 통과하는지 확인한 뒤 다시 실행하세요.");
} catch (e) {
  console.log(`GitHub 상태 조회 실패: ${e.message}`);
}
process.exit(3);
