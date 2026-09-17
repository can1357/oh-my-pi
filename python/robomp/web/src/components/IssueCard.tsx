import { type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { fmtAge, fmtDuration, shortDelivery, shortText } from "../format";
import { runCancel, runTrigger } from "../state";
import type { WorkItem } from "../work-items";
import { IssueLink, PrLink } from "./IssueLink";
import { LifecycleStepper } from "./LifecycleStepper";
import { Pill } from "./Pill";

export interface IssueCardProps {
  item: WorkItem;
}

// Verbatim cancel-confirm copy retained from the previous running table so the
// operator-facing wording does not drift.
const CANCEL_CONFIRM =
  "Kill this running task? The omp subprocess dies and the row lands in 'failed'.";

// One issue = one card. Full shape when the item has an issue ref (the
// common case); compact shape for orphan deliveries with no bound issue.
// State tint is carried by `data-bucket` + CSS — no side-stripe, no shadow.
export function IssueCard(props: IssueCardProps): JSX.Element {
  const item = (): WorkItem => props.item;
  const ref = () => item().ref;
  const full = (): boolean => ref() !== null;

  return (
    <article class="rmp-card" data-bucket={item().bucket}>
      <Show when={full()} fallback={<CompactHead item={item()} />}>
        <div class="rmp-card-head">
          <div class="rmp-card-id">
            <Pill>{item().classification ?? "issue"}</Pill>
            <IssueLink repo={ref()!.repo} number={String(ref()!.number)} />
          </div>
          <ActivityPill item={item()} />
        </div>
        <LifecycleStepper
          state={item().issueState}
          classification={item().classification}
          failed={item().bucket === "failed"}
          live={item().live !== null || item().inflightOnly}
        />
      </Show>
      <MetaRow item={item()} />
      <Show when={item().bucket === "failed" && item().error}>
        <div class="rmp-card-error err-cell" title={item().error ?? ""}>
          {shortText(item().error, 200)}
        </div>
      </Show>
      <Show
        when={
          CONFIG.replayEnabled &&
          (item().bucket === "failed" ||
            (item().bucket === "running" && item().live !== null))
        }
      >
        <div class="rmp-card-actions">
          <Show when={item().bucket === "failed" && item().deliveryId}>
            <button
              class="tiny"
              onClick={() => void runTrigger({ mode: "retry", delivery_id: item().deliveryId })}
            >
              retry
            </button>
          </Show>
          <Show when={item().bucket === "running" && item().live !== null && item().deliveryId}>
            <button class="tiny danger" onClick={() => void cancel(item().deliveryId)}>
              cancel
            </button>
          </Show>
        </div>
      </Show>
    </article>
  );
}

function CompactHead(props: { item: WorkItem }): JSX.Element {
  return (
    <div class="rmp-card-head">
      <div class="rmp-card-id">
        <code>{shortDelivery(props.item.deliveryId)}</code>
      </div>
      <ActivityPill item={props.item} />
    </div>
  );
}

function ActivityPill(props: { item: WorkItem }): JSX.Element {
  const state = (): string | undefined =>
    props.item.latestEvent?.state ?? (props.item.bucket === "running" ? "running" : undefined);
  const label = (): string =>
    props.item.latestEvent?.state ??
    (props.item.bucket === "running" ? (props.item.inflightOnly ? "inflight" : "running") : "—");
  return (
    <Pill state={state()} dot={props.item.bucket === "running"}>
      {label()}
    </Pill>
  );
}

function MetaRow(props: { item: WorkItem }): JSX.Element {
  const item = (): WorkItem => props.item;
  const live = () => item().live;

  // Only the applicable fragments render; the CSS layer draws a · separator
  // before every non-first child, so we never emit leading/trailing dots.
  return (
    <div class="rmp-card-meta">
      <Show when={live()}>
        <Show when={live()!.model}>
          <code title={live()!.model ?? ""}>{live()!.model}</code>
        </Show>
        <Show when={live()!.last_tool}>
          <span>
            last action <code>{live()!.last_tool}</code>{" "}
            <span class="rmp-card-meta-dim">{fmtAge(live()!.last_tool_ts)}</span>
          </span>
        </Show>
        <span>
          elapsed <span class="tabular">{liveElapsed(live()!.started_at)}</span>
        </span>
        <span>attempt #{live()!.attempts}</span>
      </Show>
      <Show when={!live() && item().inflightOnly}>
        <span>held by pool</span>
      </Show>
      <Show when={item().branch}>
        <code>{item().branch}</code>
      </Show>
      <Show when={item().ref && item().prNumber != null}>
        <PrLink repo={item().ref!.repo} number={item().prNumber} />
      </Show>
      <Show
        when={
          item().bucket !== "running" &&
          item().bucket !== "failed" &&
          item().latestEvent
        }
      >
        <span>
          {item().latestEvent!.event_type} · attempt #{item().latestEvent!.attempts} ·{" "}
          {fmtAge(item().latestEvent!.received_at)}
        </span>
      </Show>
    </div>
  );
}

async function cancel(deliveryId: string): Promise<void> {
  if (!window.confirm(CANCEL_CONFIRM)) return;
  await runCancel(deliveryId);
}

// Elapsed for a live run. Guards against invalid/unparseable timestamps so we
// never render a NaN-duration — falls back to "—".
function liveElapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return "—";
  return fmtDuration((Date.now() - t) / 1000);
}
