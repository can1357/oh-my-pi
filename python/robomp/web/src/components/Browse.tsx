import {
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  type ResourceReturn,
  Show,
} from "solid-js";

import { ApiError, api } from "../api";
import { CONFIG } from "../config";
import { fmtAge } from "../format";
import { runTrigger } from "../state";
import type { BrowseResponse } from "../types";
import { GlassCard } from "./GlassCard";
import { Pill } from "./Pill";

interface BrowseQuery {
  state: string;
  refreshCount: number;
}

const EMPTY_RESPONSE: BrowseResponse = {
  issues: [],
  errors: [],
  repos: [],
  cache: { hit: false, fetched_at: 0 },
};

export function Browse(): JSX.Element {
  const [state, setState] = createSignal<string>("open");
  const [refreshCount, setRefreshCount] = createSignal<number>(0);
  const [filter, setFilter] = createSignal<string>("");
  const [hideProcessed, setHideProcessed] = createSignal<boolean>(true);

  const fetchBrowse = async (query: BrowseQuery): Promise<BrowseResponse> => {
    return api.browse(query.state, query.refreshCount > 0);
  };

  const tuple: ResourceReturn<BrowseResponse> = createResource<BrowseResponse, BrowseQuery>(
    () => ({ state: state(), refreshCount: refreshCount() }),
    fetchBrowse,
  );
  const [browseResource] = tuple;

  const data = createMemo<BrowseResponse>(() => browseResource.latest ?? EMPTY_RESPONSE);

  const filtered = createMemo(() => {
    const all = data().issues;
    const needle = filter().trim().toLowerCase();
    const hidden = hideProcessed();
    const list = hidden ? all.filter((i) => !i.processed) : all;
    if (!needle) return list;
    return list.filter((i) => `${i.repo} ${i.title} #${i.number}`.toLowerCase().includes(needle));
  });

  const processedCount = createMemo(() => data().issues.filter((i) => i.processed).length);

  const errorMessage = (): string | null => {
    const err = browseResource.error;
    if (!err) return null;
    if (err instanceof ApiError) return `error ${err.status}: ${err.message}`;
    if (err instanceof Error) return err.message;
    return String(err);
  };

  const meta = (): string => {
    const d = data();
    const totalRepos = d.repos.length ? d.repos.join(", ") : "(allowlist empty)";
    const ageSeconds =
      d.cache.fetched_at > 0 ? Math.max(0, (Date.now() - d.cache.fetched_at * 1000) / 1000) : 0;
    const cacheInfo =
      d.cache.fetched_at > 0
        ? ` · ${d.cache.hit ? "cached" : "loaded"} ${ageSeconds.toFixed(0)}s ago`
        : "";
    const hidden =
      hideProcessed() && processedCount() > 0 ? ` · ${processedCount()} processed hidden` : "";
    return `${filtered().length}/${d.issues.length} from ${totalRepos}${cacheInfo}${hidden}`;
  };

  const triggerFor = (mode: "triage" | "retry", repo: string, number: number): void => {
    void runTrigger({ mode, issue: `${repo}#${number}` });
  };

  return (
    <GlassCard heading="browse" accessory={<span class="text-[11px] text-ink-400">{meta()}</span>}>
      <Show
        when={CONFIG.replayEnabled}
        fallback={
          <div class="px-5 py-7 text-ink-300 text-[13px] leading-relaxed">
            issue browser disabled — same gate as the trigger surface.
          </div>
        }
      >
        <div class="px-4 pb-3 pt-1 flex flex-wrap items-center gap-3 border-b border-stroke-soft">
          <select value={state()} onChange={(ev) => setState(ev.currentTarget.value)}>
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="all">all</option>
          </select>
          <input
            type="search"
            class="flex-1 min-w-[180px]"
            placeholder="filter title or repo"
            value={filter()}
            onInput={(ev) => setFilter(ev.currentTarget.value)}
          />
          <label class="flex items-center gap-2 text-[12px] text-ink-300 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={hideProcessed()}
              onChange={(ev) => setHideProcessed(ev.currentTarget.checked)}
            />
            hide processed
          </label>
          <button
            class="ghost"
            disabled={browseResource.loading}
            onClick={() => setRefreshCount((n) => n + 1)}
          >
            {browseResource.loading ? "loading…" : "refresh"}
          </button>
        </div>

        <Show when={errorMessage()}>
          <div class="px-5 py-2.5 text-[12px] text-err border-b border-stroke-soft tint-err">
            {errorMessage()}
          </div>
        </Show>

        <Show when={data().errors.length}>
          <For each={data().errors}>
            {(err) => (
              <div class="px-5 py-2 text-[12px] text-err border-b border-stroke-soft tint-err">
                <code>{err.repo}</code> <span class="text-ink-300">{err.error}</span>
              </div>
            )}
          </For>
        </Show>

        <div class="max-h-[44vh] overflow-y-auto scrollable">
          <Show
            when={filtered().length}
            fallback={
              <div class="empty">
                {hideProcessed() &&
                processedCount() > 0 &&
                processedCount() === data().issues.length
                  ? `all ${processedCount()} issues already processed — uncheck "hide processed" to see them`
                  : "no issues"}
              </div>
            }
          >
            <For each={filtered()}>
              {(issue) => (
                <div
                  class="grid items-start gap-4 px-5 py-3.5 border-b border-stroke-soft hover:bg-surface-2 transition-colors"
                  style={{
                    "grid-template-columns": "1fr auto",
                    opacity: issue.processed ? 0.55 : 1,
                  }}
                >
                  <div class="min-w-0">
                    <div class="text-[13px] flex items-center gap-2 flex-wrap">
                      <a
                        class="font-medium text-ink-100 hover:text-accent-2 truncate"
                        href={issue.html_url}
                        target="_blank"
                        rel="noopener"
                      >
                        <span class="font-mono text-[12px] text-ink-300 mr-2">
                          {issue.repo}#{issue.number}
                        </span>
                        {issue.title}
                      </a>
                    </div>
                    <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-400">
                      <Pill state={issue.state}>{issue.state}</Pill>
                      <Show when={issue.processed}>
                        <Pill state="processed">processed</Pill>
                      </Show>
                      <span>by {issue.author || "—"}</span>
                      <span>updated {fmtAge(issue.updated_at)}</span>
                      <span>{issue.comments} comments</span>
                      <For each={issue.labels.slice(0, 6)}>{(label) => <code>{label}</code>}</For>
                    </div>
                  </div>
                  <div class="flex gap-2 flex-shrink-0">
                    <button
                      class="primary tiny"
                      onClick={() => triggerFor("triage", issue.repo, issue.number)}
                    >
                      triage
                    </button>
                    <button
                      class="tiny"
                      onClick={() => triggerFor("retry", issue.repo, issue.number)}
                    >
                      retry
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </GlassCard>
  );
}
