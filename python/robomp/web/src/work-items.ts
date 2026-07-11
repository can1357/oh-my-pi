import { splitIssueKey } from "./format";
import {
  type LatestEvent,
  type RecentEvent,
  type RunningEvent,
  type StatusResponse,
  TERMINAL_ISSUE_STATES,
} from "./types";

export type WorkBucket = "failed" | "running" | "queued" | "active";

export interface WorkItem {
  key: string;
  ref: { repo: string; number: number } | null;
  deliveryId: string;
  issueState: string | null;
  classification: string | null;
  branch: string | null;
  prNumber: number | null;
  latestEvent: LatestEvent | null;
  live: RunningEvent | null;
  inflightOnly: boolean;
  bucket: WorkBucket;
  error: string | null;
  sortTs: number;
}

export const CODE_STAGES = ["new", "reproducing", "fixing", "PR", "done"] as const;
export const SIMPLE_STAGES = ["triaged", "resolved"] as const;
export const SIMPLE_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  "question",
  "enhancement",
  "proposal",
  "invalid",
  "duplicate",
]);

const STATE_ORDINAL: Record<string, number> = {
  new: 0,
  reproducing: 1,
  needs_info: 1,
  fixing: 2,
  opened: 3,
  reviewing: 3,
  merged: 4,
  closed: 4,
  abandoned: 4,
};

const BUCKET_RANK: Record<WorkBucket, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  active: 3,
};

export function stageOrdinal(state: string | null): number {
  return state ? STATE_ORDINAL[state] ?? 0 : 0;
}

export function buildWorkItems(status: StatusResponse): WorkItem[] {
  const runningByKey = new Map<string, RunningEvent>();
  for (const event of status.running_events) {
    runningByKey.set(event.issue_key ?? event.delivery_id, event);
  }

  const inflightSet = new Set(status.inflight);
  const issueByKey = new Map(status.issues.map((issue) => [issue.key, issue]));
  const seen = new Set<string>();
  const items: WorkItem[] = [];

  for (const issue of status.issues) {
    const key = issue.key;
    const live = runningByKey.get(key) ?? null;
    const inflightOnly = !live && inflightSet.has(key);
    if (TERMINAL_ISSUE_STATES.has(issue.state) && !live && !inflightOnly) {
      seen.add(key);
      continue;
    }
    seen.add(key);
    const latest = issue.latest_event;

    // A matching live running_events entry is authoritative over the issue's
    // own latest_event. That summary row can be a newer queued retry/comment,
    // or a failed/done row the live run has not superseded yet. Render the live
    // run so the card stays running, cancel-capable (deliveryId from the live
    // delivery), and free of stale latest-event state.
    if (live) {
      items.push({
        key,
        ref: { repo: issue.repo, number: issue.number },
        deliveryId: live.delivery_id,
        issueState: issue.state,
        classification: issue.classification,
        branch: issue.branch,
        prNumber: issue.pr_number,
        latestEvent: latestEventFromRunning(live),
        live,
        inflightOnly: false,
        bucket: "running",
        error: null,
        sortTs: parseTs(live.started_at ?? live.received_at ?? issue.updated_at),
      });
      continue;
    }

    const latestState = latest?.state;
    const bucket: WorkBucket =
      latestState === "failed"
        ? "failed"
        : inflightOnly || latestState === "running"
          ? "running"
          : latestState === "queued"
            ? "queued"
            : "active";

    items.push({
      key,
      ref: { repo: issue.repo, number: issue.number },
      deliveryId: latest?.delivery_id ?? "",
      issueState: issue.state,
      classification: issue.classification,
      branch: issue.branch,
      prNumber: issue.pr_number,
      latestEvent: latest,
      live: null,
      inflightOnly,
      bucket,
      error: latestState === "failed" ? (latest?.last_error ?? null) : null,
      sortTs: parseTs(latest?.received_at ?? issue.updated_at),
    });
  }

  for (const [key, event] of runningByKey) {
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(orphanLiveItem(key, event, false));
  }

  for (const key of inflightSet) {
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(orphanLiveItem(key, null, true));
  }

  const newestRecentByKey = new Map<string, RecentEvent>();
  for (const event of status.recent_events) {
    if (!event.issue_key || event.state === "skipped") continue;
    const current = newestRecentByKey.get(event.issue_key);
    const eventTs = parseTs(event.received_at);
    const currentTs = current ? parseTs(current.received_at) : 0;
    const nonFailedBreaksTie =
      current != null && eventTs === currentTs && current.state === "failed" && event.state !== "failed";
    if (!current || eventTs > currentTs || nonFailedBreaksTie) {
      newestRecentByKey.set(event.issue_key, event);
    }
  }

  for (const event of status.recent_events) {
    if (event.state !== "failed" || !event.delivery_id || seen.has(event.delivery_id)) continue;
    // Suppress failures for issues that have since gone terminal
    // (merged/closed/abandoned). For issues outside the capped `status.issues`
    // window there is no row to consult, so the event's own issue_state — the
    // current DB state attached by /api/status — is the only authority. This
    // skip only drops the terminal event itself; it never marks the issue_key
    // as seen, so a retryable failure for any other issue is untouched.
    if (event.issue_state && TERMINAL_ISSUE_STATES.has(event.issue_state)) continue;
    if (event.issue_key) {
      const latest = issueByKey.get(event.issue_key)?.latest_event;
      if (latest && (latest.delivery_id !== event.delivery_id || latest.state !== "failed")) {
        continue;
      }
      // For issues outside the capped `status.issues` window, fall back to the
      // newest recent event for this issue_key. If a newer (or non-failed)
      // delivery exists for the same issue, this older failed orphan is stale.
      const newestRecent = newestRecentByKey.get(event.issue_key);
      if (newestRecent && (newestRecent.delivery_id !== event.delivery_id || newestRecent.state !== "failed")) {
        continue;
      }
      if (seen.has(event.issue_key)) continue;
    }

    seen.add(event.delivery_id);
    items.push({
      key: event.issue_key ?? event.delivery_id,
      ref: splitRef(event.issue_key),
      deliveryId: event.delivery_id,
      issueState: event.issue_state,
      classification: null,
      branch: null,
      prNumber: null,
      latestEvent: latestEventFromRecent(event),
      live: null,
      inflightOnly: false,
      bucket: "failed",
      error: event.last_error,
      sortTs: parseTs(event.received_at),
    });
  }

  items.sort((a, b) => BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] || b.sortTs - a.sortTs);
  return items;
}

// Orphan live/inflight rows have no matching issue row, but their key is still
// the canonical issue key when the row came from an `issue_key` (running event)
// or an issue-shaped inflight entry. Recover the ref via splitRef so the card
// can still link to the issue; splitRef returns null when the `#N` suffix is
// missing or non-numeric (e.g. a bare delivery-id key), keeping ref: null.
function orphanLiveItem(key: string, event: RunningEvent | null, inflightOnly: boolean): WorkItem {
  return {
    key,
    ref: key.includes("#") ? splitRef(key) : null,
    deliveryId: event?.delivery_id ?? key,
    issueState: null,
    classification: null,
    branch: null,
    prNumber: null,
    latestEvent: null,
    live: event,
    inflightOnly,
    bucket: "running",
    error: null,
    sortTs: parseTs(event?.started_at ?? event?.received_at),
  };
}

function latestEventFromRecent(event: RecentEvent): LatestEvent {
  return {
    delivery_id: event.delivery_id,
    event_type: event.event_type,
    state: event.state,
    attempts: event.attempts,
    received_at: event.received_at,
    last_error: event.last_error,
  };
}

// Synthesizes an ActivityPill-compatible latest event from a live running_events
// entry. State is pinned to "running" so a stale failed/done issue.latest_event
// cannot leak a terminal pill onto a card the live run still owns.
function latestEventFromRunning(event: RunningEvent): LatestEvent {
  return {
    delivery_id: event.delivery_id,
    event_type: event.event_type,
    state: "running",
    attempts: event.attempts,
    received_at: event.received_at,
    last_error: null,
  };
}

function parseTs(value: string | null | undefined): number {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? 0 : time;
}

function splitRef(issueKey: string | null): { repo: string; number: number } | null {
  if (!issueKey) return null;
  const ref = splitIssueKey(issueKey);
  const number = Number(ref.number);
  return Number.isNaN(number) ? null : { repo: ref.repo, number };
}
