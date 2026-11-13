"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, GripVertical, Pencil, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { pct, tone, won } from "@/lib/format";
import { COLUMN_DEFS, dLabel, elapsedDays, gridVars, type ColKey, type SortKey, type SortState } from "@/lib/columns";
import type { ClientHolding } from "@/lib/types";

export const COLS = "hts-grid";

export type { SortKey, SortState };
export type DropPos = "before" | "after" | null;

/** YYYY-MM-DD → YY.MM.DD */
const shortDate = (d: string) => (d ? `${d.slice(2, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}` : "–");

/** 모바일에서 숨기는 열(= sm 너비가 없는 열)은 md 이상에서만 보인다 */
const cellCls = (c: ColKey) => {
  const d = COLUMN_DEFS[c];
  return `${d.sm ? "" : "hidden md:block"} text-center`;
};

export function HoldingHeader({ cols, sort, onSort }: { cols: ColKey[]; sort: SortState; onSort: (k: SortKey) => void }) {
  return (
    <div style={gridVars(cols)} className={`${COLS} border-b border-border bg-surface-2 px-3 py-1 text-[11px] font-semibold text-muted`}>
      {cols.map((c) => {
        const d = COLUMN_DEFS[c];
        const active = sort?.key === d.sort;
        return (
          <div key={c} className={cellCls(c)}>
            <button
              onClick={() => onSort(d.sort)}
              title="클릭: 오름차순 → 내림차순 → 원래 순서"
              className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded px-0.5 py-0.5 hover:bg-border md:px-1 ${active ? "text-foreground" : ""}`}
            >
              {d.label}
              {active ? sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : <span className="w-3" />}
            </button>
          </div>
        );
      })}
      <div />
    </div>
  );
}

/** 매수일: 클릭하면 날짜 선택으로 바뀌어 수정할 수 있다 */
function DateCell({ value, onChange, className = "" }: { value: string; onChange: (d: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      try {
        ref.current?.showPicker?.();
      } catch {
        /* 일부 브라우저는 showPicker 미지원 */
      }
    }
  }, [editing]);

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} title="클릭해서 매수일 수정" className={`num rounded px-1 hover:bg-surface hover:underline ${className}`}>
        {shortDate(value)}
      </button>
    );
  }
  return (
    <input
      ref={ref}
      type="date"
      defaultValue={value}
      max="9999-12-31"
      onChange={(e) => {
        if (e.target.value && e.target.value !== value) {
          onChange(e.target.value);
          setEditing(false);
        }
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
      className="num w-28 rounded border border-primary bg-surface px-1 text-[12px] outline-none"
      aria-label="매수일 수정"
    />
  );
}

/** HTS 스타일: 한 종목 = 한 줄. 줄을 잡고 위아래로 끌면 순서가 바뀐다. */
export function HoldingRow({
  h,
  cols,
  dropPos,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onEdit,
  onDelete,
  onRearm,
  onDateChange,
}: {
  h: ClientHolding;
  cols: ColKey[];
  dropPos: DropPos;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRearm: () => void;
  onDateChange: (d: string) => void;
}) {
  const [copied, setCopied] = useState(false); // 종목명 복사 직후 1.2초간 ✓ 표시 (팝업 없이)
  const prev = useRef<number | null>(h.price);
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (h.price != null && prev.current != null && h.price !== prev.current) {
      setFlash(h.price > prev.current ? "flash-up" : "flash-down");
      const t = setTimeout(() => setFlash(""), 900);
      prev.current = h.price;
      return () => clearTimeout(t);
    }
    prev.current = h.price;
  }, [h.price]);

  const profit = h.profitPct;
  const progress = profit != null && profit > 0 ? Math.min(profit / h.target_pct, 1) : 0;
  const triggered = h.alert_state === "triggered";
  const dropCls = dropPos === "before" ? "shadow-[inset_0_2px_0_0_var(--primary)]" : dropPos === "after" ? "shadow-[inset_0_-2px_0_0_var(--primary)]" : "";

  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <div className="min-w-0">
        <GripVertical size={14} className="absolute left-1 top-1/2 -translate-y-1/2 text-muted/50" aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center justify-center gap-1 truncate font-bold">
            {triggered && (
              <button onClick={onRearm} title="목표 도달 — 눌러서 알림 다시 켜기" aria-label="알림 다시 켜기" className="shrink-0">
                🔔
              </button>
            )}
            <a
              href={`https://www.tossinvest.com/stocks/A${h.code}/order`}
              target="_blank"
              rel="noopener noreferrer"
              draggable={false}
              title="토스증권에서 보기"
              className="truncate hover:text-primary hover:underline"
            >
              {h.name}
            </a>
          </div>
          <div className="num text-[10px] text-muted">
            {h.code}
            <span className="hidden sm:inline"> · {h.market}</span>
            <span className="md:hidden">
              {" · "}
              <DateCell value={h.bought_at} onChange={onDateChange} />
            </span>
          </div>
        </div>
      </div>
    ),
    price: (
      <div className={`num text-sm font-bold ${tone(h.changePct)}`}>
        <span className={`rounded px-1 ${flash}`}>{h.price != null ? won(h.price) : "–"}</span>
        <div className={`md:hidden text-[10px] font-normal ${tone(h.changePct)}`}>{h.changePct != null ? pct(h.changePct) : ""}</div>
      </div>
    ),
    changePct: <div className={`num ${tone(h.changePct)}`}>{h.changePct != null ? pct(h.changePct) : "–"}</div>,
    avg_price: <div className="num text-muted">{won(h.avg_price)}</div>,
    profitPct: <div className={`num text-sm font-extrabold ${tone(profit)}`}>{profit != null ? pct(profit) : "–"}</div>,
    target: (
      <div className="num">
        <div className="text-[11px] text-muted">
          +{h.target_pct}%
        </div>
        <div className="mx-auto mt-0.5 h-1.5 w-full max-w-20 overflow-hidden rounded-full bg-surface-2 md:bg-border" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="목표 달성률">
          <div className={`h-full rounded-full ${progress >= 1 ? "bg-up" : "bg-primary"}`} style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    ),
    note: (
      <div className="truncate text-[12px]" title={h.note ?? ""}>
        {h.note}
      </div>
    ),
    bought_at: (
      <div className="text-[12px] text-muted">
        <DateCell value={h.bought_at} onChange={onDateChange} />
        {h.stale && <div className="text-[10px] text-warn">시세 지연</div>}
      </div>
    ),
    elapsed: <div className="num text-[12px] font-semibold">{dLabel(elapsedDays(h.bought_at))}</div>,
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={gridVars(cols)}
      className={`${COLS} relative cursor-grab border-b border-border px-3 py-2 text-[13px] transition-colors hover:bg-surface-2 active:cursor-grabbing ${
        triggered ? "bg-up-soft" : ""
      } ${h.enabled ? "" : "opacity-50"} ${dropCls}`}
    >
      {cols.map((c) => (
        <div key={c} className={`min-w-0 ${cellCls(c)}`}>
          {cells[c]}
        </div>
      ))}

      <div className="flex justify-center gap-0.5 text-muted">
        {triggered && (
          <button onClick={onRearm} aria-label="알림 다시 켜기" title="알림 다시 켜기" className="hidden rounded p-1.5 text-up hover:bg-surface md:block">
            <RotateCcw size={15} />
          </button>
        )}
        <button onClick={onEdit} aria-label="수정" title="수정" className="rounded p-1 hover:bg-surface md:p-1.5">
          <Pencil size={15} />
        </button>
        <button
          onClick={async () => {
            if (await copyText(h.name)) {
              toast.success("종목명이 복사되었습니다", { duration: 1000, closeButton: false }); // 1초 후 자동으로 사라짐
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
          aria-label={`${h.name} 이름 복사`}
          title="종목명 복사"
          className="rounded p-1 hover:bg-surface md:p-1.5"
        >
          {copied ? <Check size={15} className="text-up" /> : <Copy size={15} />}
        </button>
        <button onClick={onDelete} aria-label={`${h.name} 삭제`} title="삭제" className="rounded p-1 hover:bg-surface hover:text-up md:p-1.5">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
