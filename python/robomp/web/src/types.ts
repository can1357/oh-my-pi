// Mirrors the JSON shapes emitted by `src/server.py`. Kept narrow on
// purpose: anything `unknown` here is something the backend explicitly does
// not promise to keep stable.

export type EventState = "queued" | "running" | "done" | "failed" | "skipped";

export type IssueState =
  | "new"
  | "reproducing"
  | "fixing"
  | "reviewing"
  | "opened"
  | "merged"
  | "closed"
  | "needs_info"
  | "abandoned";

export interface RuntimeInfo {
  bot_login: string;
  repo_allowlist: string[];
  max_concurrency: number;
  model: string;
  thinking_level: string;
  uptime_seconds: number;
}

export interface LatestEvent {
  delivery_id: string;
  event_type: string;
  state: EventState;
  attempts: number;
  received_at: string;
  last_error: string | null;
}

export interface IssueRow {
  key: string;
  repo: string;
  number: number;
  branch: string | null;
  pr_number: number | null;
  state: IssueState;
  classification: string | null;
  updated_at: string;
  latest_event: LatestEvent | null;
}

export interface RunningEvent {
  delivery_id: string;
  event_type: string;
  repo: string | null;
  issue_key: string | null;
  received_at: string;
  started_at: string | null;
  attempts: number;
  model: string | null;
  last_tool: string | null;
  last_tool_ts: string | null;
}

export interface RecentEvent {
  delivery_id: string;
  event_type: string;
  repo: string | null;
  issue_key: string | null;
  state: EventState;
  attempts: number;
  received_at: string;
  last_error: string | null;
  issue_state: IssueState | null;
}

export interface StatusResponse {
  runtime: RuntimeInfo;
  event_counts: Record<EventState, number>;
  issue_event_counts: Record<EventState, number>;
  running_events: RunningEvent[];
  inflight: string[];
  issues: IssueRow[];
  recent_events: RecentEvent[];
}

// Log entries carry arbitrary structured extras. We expose the known fields
// with concrete types and leave unknown extras as `unknown` so callers must
// narrow before using.
export interface LogEntry {
  ts?: string;
  level?: string;
  logger?: string;
  msg?: string;
  exc?: string;
  [key: string]: unknown;
}

export interface LogsResponse {
  entries: LogEntry[];
  count: number;
  limit: number;
}

export interface BrowseIssue {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  labels: string[];
  comments: number;
  updated_at: string;
  created_at: string;
  html_url: string;
  processed: boolean;
}

export interface BrowseError {
  repo: string;
  error: string;
}

export interface BrowseCacheMeta {
  hit: boolean;
  fetched_at: number;
}

export interface BrowseResponse {
  issues: BrowseIssue[];
  errors: BrowseError[];
  repos: string[];
  cache: BrowseCacheMeta;
}

export interface TriggerResponse {
  delivery: string;
  state: string;
  mode?: string;
}

export interface CancelResponse {
  delivery: string;
  fired: boolean;
  previous_state: string;
}

export const TERMINAL_ISSUE_STATES: ReadonlySet<string> = new Set([
  "merged",
  "closed",
  "abandoned",
]);

export const LEVEL_ORDER: Readonly<Record<string, number>> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  RAW: 20,
};

export const EVENT_STATE_ORDER: readonly EventState[] = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped",
];
