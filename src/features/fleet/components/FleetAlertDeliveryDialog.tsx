/**
 * FleetAlertDeliveryDialog — configure always-on alert delivery (Slack + email).
 *
 * This drives the SERVER-SIDE alerter (the poller delivers even with no browser
 * open), distinct from the bell's per-browser toast/desktop toggles. Super-admin
 * only. Secrets are never read back: a blank webhook/password means "keep the
 * existing one"; the trash button clears a channel.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, MessagesSquare, Mail, Send, Loader2, Trash2, Radio, Stethoscope, Info, Clock, PlayCircle } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchFleetAlertConfig,
  updateFleetAlertConfig,
  testFleetAlertConfig,
  testScheduledReport,
  fetchDoctorModels,
} from "@/api/fleet";

const SCHEDULED_INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 180, label: "3 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
];

const labelCls = "font-mono text-[10px] uppercase tracking-[0.14em] text-paper-dim";
const inputCls =
  "h-9 rounded-xs border-ink-500 bg-ink-200 text-[13px] text-paper focus-visible:border-brand focus-visible:ring-0";

export default function FleetAlertDeliveryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["fleet", "alert-config"],
    queryFn: fetchFleetAlertConfig,
    enabled: open,
  });
  const modelsQuery = useQuery({
    queryKey: ["fleet", "doctor", "models"],
    queryFn: fetchDoctorModels,
    enabled: open,
  });
  const models = modelsQuery.data ?? [];

  const [enabled, setEnabled] = useState(true);
  const [memoryPercent, setMemoryPercent] = useState(85);
  const [queryMemoryGb, setQueryMemoryGb] = useState(0);
  const [longQueryMin, setLongQueryMin] = useState(0);
  const [slackUrl, setSlackUrl] = useState("");
  const [emailUser, setEmailUser] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [slackEnabled, setSlackEnabled] = useState(true);
  const [googleChatUrl, setGoogleChatUrl] = useState("");
  const [googleChatEnabled, setGoogleChatEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [aiRcaOnBreach, setAiRcaOnBreach] = useState(false);
  const [aiRcaModelId, setAiRcaModelId] = useState<string>();
  const resolvedRcaModelId = aiRcaModelId ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id;
  // Scheduled report state — proactive periodic health summary.
  const [schEnabled, setSchEnabled] = useState(false);
  const [schInterval, setSchInterval] = useState(60);
  const [schMinQueries, setSchMinQueries] = useState(10);
  const [schMaxRunsPerDay, setSchMaxRunsPerDay] = useState(50);
  const [schModelId, setSchModelId] = useState<string>();
  const resolvedSchModelId = schModelId ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id;

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setAiRcaOnBreach(data.aiRcaOnBreach);
    setAiRcaModelId(data.aiRcaModelId ?? undefined);
    setMemoryPercent(data.rules.memoryPercent);
    setQueryMemoryGb(data.rules.queryMemoryGb);
    setLongQueryMin(data.rules.longQueryMin);
    setSlackUrl("");
    setGoogleChatUrl("");
    setEmailUser(data.email.user);
    setEmailTo(data.email.to);
    setEmailPassword("");
    setSlackEnabled(data.slack.enabled);
    setGoogleChatEnabled(data.googleChat?.enabled ?? true);
    setEmailEnabled(data.email.enabled);
    setSchEnabled(data.scheduledReport?.enabled ?? false);
    setSchInterval(data.scheduledReport?.intervalMinutes ?? 60);
    setSchMinQueries(data.scheduledReport?.minQueries ?? 10);
    setSchMaxRunsPerDay(data.scheduledReport?.maxRunsPerDay ?? 50);
    setSchModelId(data.scheduledReport?.aiModelId ?? undefined);
  }, [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["fleet", "alert-config"] });

  const save = useMutation({
    mutationFn: () =>
      updateFleetAlertConfig({
        enabled,
        aiRcaOnBreach,
        aiRcaModelId: resolvedRcaModelId,
        rules: { memoryPercent, queryMemoryGb, longQueryMin },
        slackWebhookUrl: slackUrl.trim() || undefined,
        slackEnabled,
        googleChatWebhookUrl: googleChatUrl.trim() || undefined,
        googleChatEnabled,
        email:
          emailUser.trim() && emailTo.trim()
            ? { user: emailUser.trim(), to: emailTo.trim(), password: emailPassword || undefined }
            : undefined,
        emailEnabled,
        scheduledReport: {
          enabled: schEnabled,
          intervalMinutes: schInterval,
          minQueries: schMinQueries,
          maxRunsPerDay: schMaxRunsPerDay,
          aiModelId: resolvedSchModelId,
        },
      }),
    onSuccess: () => {
      toast.success("Delivery settings saved");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save"),
  });

  const testScheduled = useMutation({
    mutationFn: () => testScheduledReport(),
    onSuccess: (r) => {
      const channels = [
        r.delivered.slack ? "Slack" : null,
        r.delivered.googleChat ? "Google Chat" : null,
        r.delivered.email ? "email" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      toast.success(
        channels ? `Scheduled report sent → ${channels}` : "Scheduled report generated",
        {
          description: `${r.connection} · last ${r.windowMinutes} min · ${r.totalQueries.toLocaleString()} queries · ${r.totalErrors.toLocaleString()} errors · ${r.suggestionsCount} suggestion${r.suggestionsCount === 1 ? "" : "s"} (${r.aiModel ?? "rule-based"})`,
          duration: 7000,
        },
      );
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Scheduled report test failed";
      // Long, narrative server messages → split title (first sentence) and
      // description (rest) so the toast stays readable instead of a wall of
      // text. Falls back to single-line for short messages.
      const firstStop = msg.search(/[.!?](?:\s|$)/);
      if (firstStop > 0 && msg.length > firstStop + 2) {
        toast.error(msg.slice(0, firstStop + 1), {
          description: msg.slice(firstStop + 1).trim(),
          duration: 10000,
        });
      } else {
        toast.error(msg, { duration: 7000 });
      }
    },
  });

  const test = useMutation({
    mutationFn: testFleetAlertConfig,
    onSuccess: (r) => {
      const channels = [
        r.slack ? "Slack" : null,
        r.googleChat ? "Google Chat" : null,
        r.email ? "email" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      toast.success(channels ? `Test alert sent → ${channels}` : "Test alert sent", {
        duration: 5000,
      });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Test failed — save a channel first";
      // Long narrative server messages (e.g. "No channel is set up yet — ...")
      // get split into title + description so the toast stays readable.
      const firstStop = msg.search(/[.!?](?:\s|$)/);
      if (firstStop > 0 && msg.length > firstStop + 2) {
        toast.error(msg.slice(0, firstStop + 1), {
          description: msg.slice(firstStop + 1).trim(),
          duration: 10000,
        });
      } else {
        toast.error(msg, { duration: 7000 });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (which: "slack" | "googleChat" | "email") =>
      updateFleetAlertConfig({
        enabled,
        rules: { memoryPercent, queryMemoryGb, longQueryMin },
        ...(which === "slack" ? { removeSlack: true } : {}),
        ...(which === "googleChat" ? { removeGoogleChat: true } : {}),
        ...(which === "email" ? { removeEmail: true } : {}),
      }),
    onSuccess: () => {
      toast.success("Channel removed");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to remove"),
  });

  const busy = save.isPending || remove.isPending;
  const canTest = Boolean(data?.slack.configured || data?.googleChat?.configured || data?.email.configured);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto rounded-xs border-ink-500 bg-ink-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-paper">
            <span className="grid h-9 w-9 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-muted">
              <Radio className="h-4 w-4" aria-hidden />
            </span>
            <span className="flex flex-col gap-0.5 text-left">
              <span className="text-[16px] font-semibold tracking-tight">Alert delivery</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
                Slack · Google Chat · email
              </span>
            </span>
          </DialogTitle>
          <DialogDescription className="text-paper-muted">
            Server-side delivery — fires even with no browser open. Separate from the
            bell's per-browser toast / desktop notifications.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-paper-dim" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Master enable */}
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className="flex w-full items-center justify-between rounded-xs border border-ink-500 bg-ink-200 px-4 py-3"
            >
              <span className="text-[13px] font-medium text-paper">Delivery enabled</span>
              <span
                className={cn(
                  "inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors",
                  enabled ? "bg-brand" : "bg-ink-400",
                )}
              >
                <span
                  className={cn(
                    "h-3 w-3 rounded-full bg-ink-50 transition-transform",
                    enabled ? "translate-x-3" : "translate-x-0",
                  )}
                />
              </span>
            </button>

            {/* Config sections dim while delivery is disabled — nothing fires. */}
            <div className={cn("space-y-5 transition-opacity", !enabled && "opacity-40")}>

            {/* Rules */}
            <div className="space-y-2">
              <div className={labelCls}>Thresholds · 0 = off</div>
              <div className="grid grid-cols-3 gap-2">
                <NumField label="Node mem %" value={memoryPercent} min={0} max={100} onChange={setMemoryPercent} />
                <NumField label="Query GB" value={queryMemoryGb} min={0} max={1024} onChange={setQueryMemoryGb} />
                <NumField label="Query min" value={longQueryMin} min={0} max={1440} onChange={setLongQueryMin} />
              </div>
            </div>

            {/* Slack */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[13px] font-medium text-paper">
                  <MessageSquare className="h-3.5 w-3.5 text-paper-muted" aria-hidden /> Slack
                  {data?.slack.configured && (
                    <span className="rounded-xs border border-emerald-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-600 dark:border-emerald-500/50 dark:text-emerald-400">
                      Configured
                    </span>
                  )}
                </span>
                <Switch checked={slackEnabled} onChange={setSlackEnabled} label="Enable Slack delivery" />
              </div>
              <Input
                value={slackUrl}
                onChange={(e) => setSlackUrl(e.target.value)}
                placeholder={data?.slack.configured ? "•••• keep current webhook (paste to replace)" : "https://hooks.slack.com/services/…"}
                className={cn(inputCls, !slackEnabled && "opacity-50")}
              />
              {data?.slack.configured && (
                <button
                  type="button"
                  onClick={() => remove.mutate("slack")}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" aria-hidden /> Remove webhook
                </button>
              )}
            </div>

            {/* Google Chat */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[13px] font-medium text-paper">
                  <MessagesSquare className="h-3.5 w-3.5 text-paper-muted" aria-hidden /> Google Chat
                  {data?.googleChat?.configured && (
                    <span className="rounded-xs border border-emerald-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-600 dark:border-emerald-500/50 dark:text-emerald-400">
                      Configured
                    </span>
                  )}
                </span>
                <Switch checked={googleChatEnabled} onChange={setGoogleChatEnabled} label="Enable Google Chat delivery" />
              </div>
              <Input
                value={googleChatUrl}
                onChange={(e) => setGoogleChatUrl(e.target.value)}
                placeholder={data?.googleChat?.configured ? "•••• keep current webhook (paste to replace)" : "https://chat.googleapis.com/v1/spaces/…"}
                className={cn(inputCls, !googleChatEnabled && "opacity-50")}
              />
              {data?.googleChat?.configured && (
                <button
                  type="button"
                  onClick={() => remove.mutate("googleChat")}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" aria-hidden /> Remove webhook
                </button>
              )}
            </div>

            {/* Email */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[13px] font-medium text-paper">
                  <Mail className="h-3.5 w-3.5 text-paper-muted" aria-hidden /> Email (Gmail)
                  {data?.email.configured && (
                    <span className="rounded-xs border border-emerald-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-600 dark:border-emerald-500/50 dark:text-emerald-400">
                      Configured
                    </span>
                  )}
                </span>
                <Switch checked={emailEnabled} onChange={setEmailEnabled} label="Enable email delivery" />
              </div>
              <div className={cn("space-y-2", !emailEnabled && "opacity-50")}>
                <div className="grid grid-cols-2 gap-2">
                  <Input value={emailUser} onChange={(e) => setEmailUser(e.target.value)} placeholder="you@gmail.com" className={inputCls} />
                  <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="send to: ops@team.com" className={inputCls} />
                </div>
                <Input
                  type="password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  placeholder={data?.email.configured ? "•••• keep current app password" : "Gmail app password (16 chars)"}
                  className={inputCls}
                />
              </div>
              <p className="text-[11px] text-paper-faint">
                Gmail needs an <strong className="text-paper-muted">App Password</strong> (Account → Security → 2-Step Verification → App passwords), not your normal password.
              </p>
              {data?.email.configured && (
                <button
                  type="button"
                  onClick={() => remove.mutate("email")}
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" aria-hidden /> Remove email
                </button>
              )}
            </div>

            {/* AI auto-RCA on breach */}
            <div className="rounded-xs border border-ink-500 bg-ink-200 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[13px] font-medium text-paper">
                  <Stethoscope className="h-3.5 w-3.5 text-brand" aria-hidden /> AI auto-RCA on breach
                </span>
                <Switch checked={aiRcaOnBreach} onChange={setAiRcaOnBreach} label="Enable AI auto-RCA on breach" />
              </div>
              <p className="mt-1.5 text-[11px] text-paper-faint">
                When a new breach fires, Chouse AI investigates the fleet and posts a root-cause
                analysis to the channels above. Needs an AI provider configured (Settings → AI).
              </p>
              {aiRcaOnBreach && (
                <p className="mt-2 flex gap-1.5 rounded-xs bg-ink-100 px-2.5 py-2 text-[11px] leading-relaxed text-paper-faint">
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-paper-dim" aria-hidden />
                  <span>
                    To control cost, scans are throttled to <strong className="text-paper-muted">~once every 15 min</strong>.
                    A breach during the cooldown won't spawn its own scan — but that query still appears in the
                    next report's <strong className="text-paper-muted">Heavy Query Analysis</strong> (6h window).
                  </span>
                </p>
              )}
              {aiRcaOnBreach && models.length > 1 && (
                <label className="mt-2.5 flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-paper-dim">Model</span>
                  <select
                    value={resolvedRcaModelId ?? ""}
                    onChange={(e) => setAiRcaModelId(e.target.value)}
                    className="h-8 max-w-[230px] rounded-xs border border-ink-500 bg-ink-100 px-2 text-[11px] text-paper focus:border-brand focus:outline-none"
                    title="Model for the autonomous RCA scan"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.model}
                        {m.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* Scheduled health report — periodic AI-enriched summary delivered
                on a clock, independent of breach state. Reuses the channels
                configured above. */}
            <div className="rounded-xs border border-ink-500 bg-ink-200 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[13px] font-medium text-paper">
                  <Clock className="h-3.5 w-3.5 text-brand" aria-hidden /> Scheduled health report
                </span>
                <Switch checked={schEnabled} onChange={setSchEnabled} label="Enable scheduled health report" />
              </div>
              <p className="mt-1.5 text-[11px] text-paper-faint">
                Periodic <strong className="text-paper-muted">data-grounded</strong> report:
                server snapshot, top 5 problematic queries (with cores + query_id + timestamps),
                errors in the window, and AI-written suggestions. Delivered to the channels above.
              </p>

              {schEnabled && (
                <>
                  <div className="mt-3 grid grid-cols-[1fr_auto_auto] items-end gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">
                        Every
                      </span>
                      <select
                        value={schInterval}
                        onChange={(e) => setSchInterval(Number(e.target.value))}
                        className="h-9 rounded-xs border border-ink-500 bg-ink-100 px-2 text-[12px] text-paper focus:border-brand focus:outline-none"
                      >
                        {SCHEDULED_INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NumField
                      label="Min queries"
                      value={schMinQueries}
                      min={0}
                      max={100000}
                      onChange={setSchMinQueries}
                    />
                    <NumField
                      label="Max runs/day"
                      value={schMaxRunsPerDay}
                      min={0}
                      max={500}
                      onChange={setSchMaxRunsPerDay}
                    />
                  </div>
                  <p className="mt-2 flex gap-1.5 rounded-xs bg-ink-100 px-2.5 py-2 text-[11px] leading-relaxed text-paper-faint">
                    <Info className="mt-0.5 h-3 w-3 shrink-0 text-paper-dim" aria-hidden />
                    <span>
                      Window matches the interval — every <strong className="text-paper-muted">{
                        SCHEDULED_INTERVAL_OPTIONS.find((o) => o.value === schInterval)?.label ?? `${schInterval}m`
                      }</strong> means
                      "report on the last {SCHEDULED_INTERVAL_OPTIONS.find((o) => o.value === schInterval)?.label ?? `${schInterval}m`}". Skips delivery when the window had fewer
                      than <strong className="text-paper-muted">{schMinQueries}</strong> queries; caps
                      at <strong className="text-paper-muted">{schMaxRunsPerDay}</strong> runs per day
                      (set 0 to disable each gate).
                    </span>
                  </p>
                  {models.length > 1 && (
                    <label className="mt-2.5 flex items-center gap-2">
                      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-paper-dim">
                        Suggestion model
                      </span>
                      <select
                        value={resolvedSchModelId ?? ""}
                        onChange={(e) => setSchModelId(e.target.value)}
                        className="h-8 max-w-[230px] rounded-xs border border-ink-500 bg-ink-100 px-2 text-[11px] text-paper focus:border-brand focus:outline-none"
                        title="Model used for the suggestions section (data sections are always pure SQL)"
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} · {m.model}
                            {m.isDefault ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => testScheduled.mutate()}
                    disabled={testScheduled.isPending || !canTest}
                    title={
                      canTest
                        ? "Fire one report now to the configured channels (bypasses min-queries gate)"
                        : "Configure at least one channel above first"
                    }
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xs border border-ink-500 bg-ink-100 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted transition-colors hover:bg-ink-300 hover:text-paper disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {testScheduled.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <PlayCircle className="h-3 w-3" aria-hidden />
                    )}
                    Send now
                  </button>
                </>
              )}
            </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between border-t border-ink-500 pt-4">
              <Button
                variant="ghost"
                onClick={() => test.mutate()}
                disabled={!canTest || test.isPending}
                className="h-9 gap-2 rounded-xs border border-ink-500 bg-ink-200 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-muted hover:bg-ink-300 hover:text-paper"
              >
                {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Send test
              </Button>
              <Button
                onClick={() => save.mutate()}
                disabled={busy}
                className="h-9 gap-2 rounded-xs bg-brand px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-50 hover:bg-brand-soft"
              >
                {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-paper-faint">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
        className="h-9 rounded-xs border-ink-500 bg-ink-200 text-right font-mono text-[13px] text-paper focus-visible:border-brand focus-visible:ring-0"
      />
    </label>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        checked ? "bg-brand" : "bg-ink-400",
      )}
    >
      <span
        className={cn(
          "h-3 w-3 rounded-full bg-ink-50 shadow-sm transition-transform",
          checked ? "translate-x-3" : "translate-x-0",
        )}
        aria-hidden
      />
    </button>
  );
}
