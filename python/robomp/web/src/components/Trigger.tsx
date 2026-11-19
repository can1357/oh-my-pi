import { createSignal, type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { runTrigger, triggerStatus } from "../state";
import { GlassCard } from "./GlassCard";

const STATUS_TONE = {
  idle: "text-ink-400",
  pending: "text-ink-200",
  ok: "text-ok",
  err: "text-err",
} as const;

export interface TriggerProps {
  /**
   * `bar`  — slim one-line command row for the Operations landing view.
   * `panel` — fuller form (current look) for the Triage view.
   * Both gate on CONFIG.replayEnabled; read-only degrades to a slim inline
   * chip (bar) or the first-run explainer panel (panel, handled by Triage).
   */
  variant?: "bar" | "panel";
}

export function Trigger(props: TriggerProps): JSX.Element {
  const variant = (): "bar" | "panel" => props.variant ?? "panel";
  const [issue, setIssue] = createSignal<string>("");

  const validate = (): string | null => {
    const value = issue().trim();
    if (!value) return "enter owner/repo#NN or github issue url";
    return null;
  };

  const handleTriage = (): void => {
    const value = issue().trim();
    if (!value) return;
    void runTrigger({ mode: "triage", issue: value });
  };

  const handleRetry = (): void => {
    const value = issue().trim();
    if (!value) return;
    void runTrigger({ mode: "retry", issue: value });
  };

  // ── bar variant: slim command row (Operations). Read-only → inline chip. ──
  return (
    <Show when={variant() === "bar"} fallback={<PanelBody issue={issue} setIssue={setIssue} handleTriage={handleTriage} handleRetry={handleRetry} validate={validate} />}>
      <Show
        when={CONFIG.replayEnabled}
        fallback={
          <div class="rmp-trigger-bar">
            <span class="rmp-readonly-chip">trigger disabled · read-only</span>
            <span class="rmp-trigger-bar-status">set ROBOMP_REPLAY_TOKEN to enable</span>
          </div>
        }
      >
        <div class="rmp-trigger-bar">
          <input
            type="text"
            spellcheck={false}
            placeholder="owner/repo#NN or issue url"
            autocomplete="off"
            value={issue()}
            onInput={(ev) => setIssue(ev.currentTarget.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") handleTriage();
            }}
            class="flex-1 min-w-[200px] font-mono"
          />
          <button class="primary tiny" onClick={handleTriage}>
            triage
          </button>
          <button class="tiny" onClick={handleRetry}>
            retry latest
          </button>
          <Show when={triggerStatus().text}>
            <span class={`rmp-trigger-bar-status ${STATUS_TONE[triggerStatus().kind]}`}>
              {triggerStatus().text}
            </span>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

interface PanelBodyProps {
  issue: () => string;
  setIssue: (v: string) => void;
  handleTriage: () => void;
  handleRetry: () => void;
  validate: () => string | null;
}

// ── panel variant: fuller form (Triage). Read-only handled by the Triage
//    view's first-run panel; if replay is on, this is the active form. ──
function PanelBody(p: PanelBodyProps): JSX.Element {
  return (
    <GlassCard
      heading="trigger"
    >
      <Show
        when={CONFIG.replayEnabled}
        fallback={
          <div class="px-5 py-7 text-ink-300 text-[13px] leading-relaxed">
            trigger disabled. set <code>ROBOMP_REPLAY_TOKEN</code> in the server env to enable
            manual triage and retry actions.
          </div>
        }
      >
        <div class="px-5 pb-5 pt-1 flex flex-col gap-4">
          <div class="form-row">
            <input
              type="text"
              spellcheck={false}
              placeholder="octo/widget#42 or https://github.com/owner/repo/issues/42"
              autocomplete="off"
              value={p.issue()}
              onInput={(ev) => p.setIssue(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") p.handleTriage();
              }}
              class="flex-1 min-w-[220px] font-mono"
            />
            <button class="primary" onClick={p.handleTriage}>
              fetch &amp; triage
            </button>
            <button onClick={p.handleRetry}>retry latest run</button>
          </div>
          <Show
            when={triggerStatus().text}
            fallback={
              <span class={`text-[12px] ${STATUS_TONE.idle}`}>{p.validate() ?? "ready"}</span>
            }
          >
            <span class={`text-[12px] ${STATUS_TONE[triggerStatus().kind]}`}>
              {triggerStatus().text}
            </span>
          </Show>
        </div>
      </Show>
    </GlassCard>
  );
}
