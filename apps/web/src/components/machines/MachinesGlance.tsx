import { Link } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";
import { useGT } from "gt-react";
import { memo, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import {
  meterPercent,
  meterTone,
  type MachineMeter,
  type MachineRow,
  type MeterTone,
} from "./machines.logic";
import { useMachineRows } from "./useMachineRows";

const TONE_CLASS: Record<MeterTone, string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
};

function MeterLine({
  label,
  fraction,
  detail,
  muted,
}: {
  label: string;
  fraction: number | null;
  detail: string;
  muted: boolean;
}) {
  const percent = fraction === null ? 0 : meterPercent(fraction);
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={fraction === null ? undefined : percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
      >
        {fraction === null ? null : (
          <div
            className={cn(
              "h-full rounded-full",
              muted ? "bg-muted-foreground/40" : TONE_CLASS[meterTone(fraction)],
            )}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      <span className="min-w-24 text-right font-mono tabular-nums text-foreground/80">
        {detail}
      </span>
    </div>
  );
}

function BytesLine({
  label,
  meter,
  muted,
}: {
  label: string;
  meter: MachineMeter;
  muted: boolean;
}) {
  const gt = useGT();
  return (
    <MeterLine
      label={label}
      fraction={meter.fraction}
      detail={gt("{used} of {total}", {
        used: formatBytes(meter.used),
        total: formatBytes(meter.total),
      })}
      muted={muted}
    />
  );
}

function MachineStatusText({ row }: { row: MachineRow }) {
  const gt = useGT();
  switch (row.status) {
    case "live":
      return null;
    case "waiting":
      return gt("Sampling");
    case "offline":
      return gt("Offline");
    case "stale": {
      const seconds = row.staleSeconds ?? 0;
      return seconds >= 60
        ? gt("Updated {minutes}m ago", { minutes: Math.floor(seconds / 60) })
        : gt("Updated {seconds}s ago", { seconds });
    }
  }
}

function MachineRowView({ row, onNavigate }: { row: MachineRow; onNavigate: () => void }) {
  const gt = useGT();
  const muted = row.status !== "live";
  return (
    <div className="flex flex-col gap-1.5 px-1 py-2 first:pt-1 last:pb-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <Link
          aria-label={gt("Open diagnostics for {name}", { name: row.label })}
          className={cn(
            "min-w-0 truncate rounded-sm text-sm font-medium outline-hidden ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset",
            muted && "text-muted-foreground",
          )}
          onClick={onNavigate}
          search={{ machine: row.environmentId }}
          to="/settings/diagnostics"
        >
          {row.label}
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground">
          <MachineStatusText row={row} />
        </span>
      </div>
      <div className={cn("flex flex-col gap-1", muted && "opacity-60")}>
        {row.status === "offline" || row.status === "waiting" ? null : (
          <>
            <MeterLine
              label={gt("CPU")}
              fraction={row.cpu?.fraction ?? null}
              detail={
                row.cpu === null
                  ? "..."
                  : gt("{percent}% of {count, plural, one {{count} core} other {{count} cores}}", {
                      percent: meterPercent(row.cpu.fraction),
                      count: row.cpu.cores,
                    })
              }
              muted={muted}
            />
            {row.memory ? (
              <BytesLine label={gt("Memory")} meter={row.memory} muted={muted} />
            ) : null}
            {row.disk ? <BytesLine label={gt("Disk")} meter={row.disk} muted={muted} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Mounted only while the popover is open, so it is the only thing that polls. */
function MachinesGlanceList({ onNavigate }: { onNavigate: () => void }) {
  const rows = useMachineRows();
  return (
    <div className="flex flex-col divide-y divide-border/60">
      {rows.map((row) => (
        <MachineRowView key={row.environmentId} onNavigate={onNavigate} row={row} />
      ))}
    </div>
  );
}

export const MachinesMenuItem = memo(function MachinesMenuItem() {
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const label = gt("Machines");
  const closeOnNavigate = () => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarMenuItem className="shrink-0">
      <Popover onOpenChange={setOpen} open={open}>
        <SharedTooltipTrigger
          render={<PopoverTrigger render={<SidebarMenuButton aria-label={label} size="icon" />} />}
          label={label}
        >
          <CpuIcon />
        </SharedTooltipTrigger>
        <PopoverPopup align="start" padding="compact" side="top" width="md">
          <PopoverTitle className="sr-only">{label}</PopoverTitle>
          <MachinesGlanceList onNavigate={closeOnNavigate} />
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
});
