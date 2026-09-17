import { createEffect, createSignal, For, type JSX, Show } from "solid-js";

import { fmtTimestamp } from "../format";
import { logsResource } from "../state";
import { LEVEL_ORDER, type LogEntry } from "../types";
import { GlassCard } from "./GlassCard";

const RESERVED_LOG_FIELDS = new Set(["ts", "level", "logger", "msg", "exc"]);

interface Extra {
  key: string;
  value: string;
}

interface FormattedRow {
  index: number;
  ts: string;
  level: string;
  logger: string;
  message: string;
  extras: Extra[];
  exc: string | null;
}

function formatExtraValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildExtras(entry: LogEntry): Extra[] {
  const out: Extra[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    out.push({ key, value: formatExtraValue(value) });
  }
  return out;
}

export function Logs(): JSX.Element {
  const [level, setLevel] = createSignal<string>("INFO");
  const [filter, setFilter] = createSignal<string>("");
  const [follow, setFollow] = createSignal<boolean>(true);

  let scrollEl: HTMLDivElement | undefined;

  const allEntries = (): LogEntry[] => logsResource()?.entries ?? [];

  const rows = (): FormattedRow[] => {
    const wantLevel = level();
    const minOrd = wantLevel ? (LEVEL_ORDER[wantLevel] ?? 0) : 0;
    const needle = filter().trim().toLowerCase();
    const out: FormattedRow[] = [];
    let index = 0;
    for (const entry of allEntries()) {
      const lvl = entry.level ?? "INFO";
      if ((LEVEL_ORDER[lvl] ?? 20) < minOrd) continue;
      const msg = entry.msg ?? "";
      const extras = buildExtras(entry);
      if (needle) {
        const haystack = (
          msg +
          " " +
          extras.map((e) => `${e.key}=${e.value}`).join(" ")
        ).toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      out.push({
        index: index++,
        ts: fmtTimestamp(entry.ts),
        level: lvl,
        logger: entry.logger ?? "",
        message: msg,
        extras,
        exc: entry.exc ?? null,
      });
    }
    return out;
  };

  createEffect(() => {
    // Touch dependencies so effect re-runs on new data / toggles.
    rows();
    if (follow() && scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });

  return (
    <GlassCard
      heading="agent logs"
      accessory={
        <span class="tabular">
          {rows().length} / {allEntries().length}
        </span>
      }
    >
      <div class="px-4 pb-3 pt-1 flex flex-wrap items-center gap-3 border-b border-stroke-soft">
        <label class="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-ink-400">
          level
          <select value={level()} onChange={(ev) => setLevel(ev.currentTarget.value)}>
            <option value="">all</option>
            <option value="DEBUG">debug+</option>
            <option value="INFO">info+</option>
            <option value="WARNING">warn+</option>
            <option value="ERROR">error</option>
          </select>
        </label>
        <label class="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-ink-400 flex-1 min-w-[200px]">
          filter
          <input
            type="search"
            value={filter()}
            placeholder="substring"
            onInput={(ev) => setFilter(ev.currentTarget.value)}
            class="flex-1"
          />
        </label>
        <label class="flex items-center gap-2 text-[12px] text-ink-300 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={follow()}
            onChange={(ev) => setFollow(ev.currentTarget.checked)}
          />
          follow tail
        </label>
      </div>
      <div class="logs scrollable" ref={(el) => (scrollEl = el)}>
        <Show when={rows().length} fallback={<div class="empty">no log entries match</div>}>
          <For each={rows()}>
            {(row) => (
              <div class="log-row">
                <span class="ts">{row.ts}</span>
                <span class={`lvl ${row.level}`}>{row.level}</span>
                <span class="logger">{row.logger}</span>
                <span>
                  <span class="msg">{row.message}</span>
                  <Show when={row.extras.length}>
                    <span class="extras">
                      <For each={row.extras}>
                        {(extra) => (
                          <span>
                            {" "}
                            <b>{extra.key}</b>={extra.value}
                          </span>
                        )}
                      </For>
                    </span>
                  </Show>
                  <Show when={row.exc}>
                    <span class="exc">{row.exc}</span>
                  </Show>
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </GlassCard>
  );
}
