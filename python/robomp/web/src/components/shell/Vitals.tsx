import { type JSX, Show } from "solid-js";

import { fmtDuration } from "../../format";
import { isFetching, lastTickAt, lastTickError, statusResource } from "../../state";
import { EVENT_STATE_ORDER } from "../../types";

// Ported verbatim from Header.tsx (dissolved).
function relativeAgo(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 5) return "just now";
  return `${fmtDuration(seconds)} ago`;
}

const STATE_TONE: Record<string, string> = {
  queued: "var(--color-info)",
  running: "var(--color-warn)",
  done: "var(--color-ok)",
  failed: "var(--color-err)",
  skipped: "var(--color-ink-300)",
};

export function Vitals(): JSX.Element {
  const runtime = () => statusResource()?.runtime;

  // issue_event_counts ?? event_counts — preserves the Stats.tsx accessor + title.
  const counts = (): Record<string, number> => {
    const status = statusResource();
    if (!status) return { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    return status.issue_event_counts ?? status.event_counts;
  };

  // Match the pipeline derivation: running_events and the inflight snapshot overlap
  // (the worker pool keys inflight by `issue_key || delivery_id`), so union by
  // that same key instead of summing lengths — otherwise one live job counts as two.
  const runningTotal = (): number => {
    const s = statusResource();
    if (!s) return 0;
    const keys = new Set(s.running_events.map((e) => e.issue_key ?? e.delivery_id));
    for (const key of s.inflight) keys.add(key);
    return keys.size;
  };

  const failedCount = (): number => counts().failed ?? 0;

  const allowlist = (): string => {
    const list = runtime()?.repo_allowlist;
    return list && list.length ? list.join(", ") : "(none)";
  };

  const syncTone = (): string => {
    if (lastTickError()) return "err";
    if (isFetching()) return "warn";
    return "ok";
  };

  const syncText = (): string => {
    if (lastTickError()) return lastTickError()!;
    if (isFetching()) return "syncing…";
    return `synced ${relativeAgo(lastTickAt())}`;
  };

  return (
    <div class="rmp-vitals">
      {/* health / sync */}
      <div class="rmp-vital-sync" title={lastTickError() ?? undefined}>
        <span
          class={`rmp-vital-dot ${syncTone()}${isFetching() ? " pulse" : ""}`}
        />
        <Show
          when={lastTickError()}
          fallback={<span>{syncText()}</span>}
        >
          <span class="text-err truncate">{syncText()}</span>
        </Show>
      </div>

      {/* big running / failed */}
      <div class="rmp-vital-big">
        <div class="rmp-vital-big-cell">
          <span class="rmp-vital-big-label">running</span>
          <span
            class={`rmp-vital-big-num${
              runningTotal() > 0 ? " running-nonzero" : ""
            }`}
          >
            {runningTotal()}
          </span>
        </div>
        <div class="rmp-vital-big-cell">
          <span class="rmp-vital-big-label">failed</span>
          <span
            class={`rmp-vital-big-num${
              failedCount() > 0 ? " failed-nonzero" : ""
            }`}
          >
            {failedCount()}
          </span>
        </div>
      </div>

      {/* 5 state counts (compact 2-col) */}
      <div class="rmp-vital-counts" title="newest non-skipped event per issue">
        {EVENT_STATE_ORDER.map((state) => (
          <div class="rmp-vital-count">
            <span class="rmp-vital-count-label">{state}</span>
            <span
              class="rmp-vital-count-num"
              style={{ color: STATE_TONE[state] ?? "var(--color-ink-200)" }}
            >
              {counts()[state] ?? 0}
            </span>
          </div>
        ))}
      </div>

      {/* runtime meta */}
      <div class="rmp-vital-runtime">
        <RuntimeRow label="bot" value={runtime()?.bot_login} mono />
        <RuntimeRow
          label="model"
          value={runtime()?.model}
          mono
          title={
            runtime()?.thinking_level ? `thinking ${runtime()?.thinking_level}` : undefined
          }
        />
        <RuntimeRow
          label="conc"
          value={
            runtime()?.max_concurrency != null
              ? String(runtime()?.max_concurrency)
              : undefined
          }
        />
        <RuntimeRow
          label="up"
          value={
            runtime()?.uptime_seconds != null
              ? fmtDuration(runtime()?.uptime_seconds)
              : undefined
          }
        />
        <RuntimeRow label="repos" value={allowlist()} mono title={allowlist()} />
      </div>
    </div>
  );
}

interface RuntimeRowProps {
  label: string;
  value?: string;
  mono?: boolean;
  title?: string;
}

function RuntimeRow(props: RuntimeRowProps): JSX.Element {
  return (
    <div class="rmp-vital-runtime-row" title={props.title}>
      <span class="rmp-vital-runtime-label">{props.label}</span>
      <span
        class={`rmp-vital-runtime-value${props.mono ? " mono" : ""}`}
        title={props.value}
      >
        {props.value ?? "—"}
      </span>
    </div>
  );
}
