import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

type DrillView = "days" | "months" | "years";

interface RangePickerDrilldownProps {
  range: { from?: Date; to?: Date } | null;
  /** Fired on every selection change. The parent owns the normalisation
   * (full-day snapping) that runs when Apply is clicked. */
  onChange: (range: { from?: Date; to?: Date } | null) => void;
  /** Year range for the year-grid view. */
  fromYear?: number;
  toYear?: number;
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function RangePickerDrilldown({
  range,
  onChange,
  fromYear = 2015,
  toYear = new Date().getFullYear() + 1,
}: RangePickerDrilldownProps) {
  const [view, setView] = useState<DrillView>("days");
  const [displayedMonth, setDisplayedMonth] = useState<Date>(
    () => range?.from ?? new Date()
  );
  const [yearChunkStart, setYearChunkStart] = useState<number>(() => {
    const cur = (range?.from ?? new Date()).getFullYear();
    return Math.floor(cur / 12) * 12;
  });

  const currentYear = displayedMonth.getFullYear();
  const currentMonthIdx = displayedMonth.getMonth();

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header — drill-up + nav */}
      <div className="flex items-center justify-between gap-2">
        <NavButton
          onClick={() => {
            if (view === "days") {
              setDisplayedMonth(new Date(currentYear, currentMonthIdx - 1, 1));
            } else if (view === "months") {
              setDisplayedMonth(new Date(currentYear - 1, currentMonthIdx, 1));
            } else {
              setYearChunkStart((y) => Math.max(fromYear, y - 12));
            }
          }}
          label="Previous"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </NavButton>

        <button
          type="button"
          onClick={() => {
            if (view === "days") setView("months");
            else if (view === "months") {
              setYearChunkStart(Math.floor(currentYear / 12) * 12);
              setView("years");
            } else setView("days");
          }}
          className="rounded-xs border border-transparent bg-transparent px-3 py-1 text-[13px] font-medium tracking-tight text-paper transition-colors hover:border-ink-500 hover:bg-ink-200"
        >
          {view === "days"
            ? `${MONTH_LABELS[currentMonthIdx]} ${currentYear}`
            : view === "months"
              ? `${currentYear}`
              : `${yearChunkStart} – ${yearChunkStart + 11}`}
        </button>

        <NavButton
          onClick={() => {
            if (view === "days") {
              setDisplayedMonth(new Date(currentYear, currentMonthIdx + 1, 1));
            } else if (view === "months") {
              setDisplayedMonth(new Date(currentYear + 1, currentMonthIdx, 1));
            } else {
              setYearChunkStart((y) => Math.min(toYear - 11, y + 12));
            }
          }}
          label="Next"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </NavButton>
      </div>

      {/* Body — switches per drill view */}
      {view === "days" && (
        <DayPicker
          mode="range"
          selected={{ from: range?.from, to: range?.to }}
          onSelect={(r) => onChange(r ? { from: r.from, to: r.to } : null)}
          month={displayedMonth}
          onMonthChange={setDisplayedMonth}
          showOutsideDays
          hideNavigation
          classNames={SHARED_CLASSNAMES}
        />
      )}

      {view === "months" && (
        <div className="grid grid-cols-3 gap-1.5">
          {MONTH_LABELS.map((label, i) => {
            const active = i === currentMonthIdx;
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setDisplayedMonth(new Date(currentYear, i, 1));
                  setView("days");
                }}
                className={cn(
                  "rounded-xs border px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors",
                  active
                    ? "border-brand bg-brand text-ink-50"
                    : "border-ink-500 bg-ink-200 text-paper-muted hover:border-ink-700 hover:bg-ink-300 hover:text-paper"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {view === "years" && (
        <YearGrid
          start={yearChunkStart}
          currentYear={currentYear}
          fromYear={fromYear}
          toYear={toYear}
          onPick={(y) => {
            setDisplayedMonth(new Date(y, currentMonthIdx, 1));
            setView("months");
          }}
        />
      )}

      {/* Footer hint — only show on days view */}
      {view === "days" && (
        <p className="border-t border-ink-500 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
          {range?.from && !range?.to
            ? "Click another day to set the end. Same day = full 24h."
            : range?.from && range?.to
              ? "Range set. Click Apply to load."
              : "Click a day. Same day again = full 24h."}
        </p>
      )}
    </div>
  );
}

const SHARED_CLASSNAMES = {
  months: "flex flex-col",
  month: "space-y-2",
  month_caption: "hidden",
  month_grid: "w-full border-collapse",
  weekdays: "flex",
  weekday:
    "text-paper-faint w-9 font-normal text-[0.75rem] font-mono uppercase tracking-[0.14em]",
  week: "flex w-full mt-1",
  day: "h-9 w-9 text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
  day_button: cn(
    buttonVariants({ variant: "ghost" }),
    "h-9 w-9 p-0 font-normal hover:bg-ink-200 hover:text-paper"
  ),
  selected:
    "bg-brand text-ink-50 hover:bg-brand-soft focus:bg-brand rounded-xs",
  today: "bg-ink-200 text-paper rounded-xs",
  outside: "text-paper-faint opacity-50",
  disabled: "text-paper-faint opacity-40",
  range_middle: "bg-brand/10 text-brand !rounded-none",
  range_start: "bg-brand text-ink-50 hover:bg-brand-soft rounded-l-xs",
  range_end: "bg-brand text-ink-50 hover:bg-brand-soft rounded-r-xs",
  hidden: "invisible",
};

function NavButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-muted transition-colors hover:border-ink-700 hover:bg-ink-300 hover:text-paper"
    >
      {children}
    </button>
  );
}

function YearGrid({
  start,
  currentYear,
  fromYear,
  toYear,
  onPick,
}: {
  start: number;
  currentYear: number;
  fromYear: number;
  toYear: number;
  onPick: (year: number) => void;
}) {
  const years = useMemo(
    () => Array.from({ length: 12 }, (_, i) => start + i),
    [start]
  );
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {years.map((y) => {
        const active = y === currentYear;
        const disabled = y < fromYear || y > toYear;
        return (
          <button
            key={y}
            type="button"
            disabled={disabled}
            onClick={() => onPick(y)}
            className={cn(
              "rounded-xs border px-3 py-2.5 font-mono text-[12px] tabular-nums transition-colors",
              active
                ? "border-brand bg-brand text-ink-50"
                : "border-ink-500 bg-ink-200 text-paper-muted hover:border-ink-700 hover:bg-ink-300 hover:text-paper",
              disabled && "cursor-not-allowed opacity-30"
            )}
          >
            {y}
          </button>
        );
      })}
    </div>
  );
}
