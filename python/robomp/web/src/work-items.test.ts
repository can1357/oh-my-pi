import { describe, expect, test } from "bun:test";

import { buildWorkItems, stageOrdinal } from "./work-items";
import type {
  EventState,
  IssueRow,
  LatestEvent,
  RecentEvent,
  RunningEvent,
  RuntimeInfo,
  StatusResponse,
} from "./types";

const BASE_RUNTIME: RuntimeInfo = {
  bot_login: "robomp",
  repo_allowlist: [],
  max_concurrency: 1,
  model: "test-model",
  thinking_level: "low",
  uptime_seconds: 0,
};

function eventCounts(): Record<EventState, number> {
  return {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };
}

function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    runtime: BASE_RUNTIME,
    event_counts: eventCounts(),
    issue_event_counts: eventCounts(),
    running_events: [],
    inflight: [],
    issues: [],
    recent_events: [],
    ...overrides,
  };
}

function issue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    key: "owner/repo#1",
    repo: "owner/repo",
    number: 1,
    branch: null,
    pr_number: null,
    state: "new",
    classification: "bug",
    updated_at: "2026-06-17T00:00:00Z",
    latest_event: null,
    ...overrides,
  };
}

function latestEvent(overrides: Partial<LatestEvent> = {}): LatestEvent {
  return {
    delivery_id: "delivery-1",
    event_type: "issues",
    state: "queued",
    attempts: 1,
    received_at: "2026-06-17T00:00:00Z",
    last_error: null,
    ...overrides,
  };
}

function runningEvent(overrides: Partial<RunningEvent> = {}): RunningEvent {
  return {
    delivery_id: "delivery-1",
    event_type: "issues",
    repo: "owner/repo",
    issue_key: "owner/repo#1",
    received_at: "2026-06-17T00:00:00Z",
    started_at: "2026-06-17T00:01:00Z",
    attempts: 1,
    model: "test-model",
    last_tool: null,
    last_tool_ts: null,
    ...overrides,
  };
}

function recentEvent(overrides: Partial<RecentEvent> = {}): RecentEvent {
  return {
    delivery_id: "failed-delivery",
    event_type: "issues",
    repo: "owner/repo",
    issue_key: null,
    state: "failed",
    attempts: 1,
    received_at: "2026-06-17T00:00:00Z",
    last_error: "boom",
    issue_state: null,
    ...overrides,
  };
}

describe("buildWorkItems", () => {
  test("deduplicates a running issue that is also inflight", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#7",
            number: 7,
            latest_event: latestEvent({
              delivery_id: "delivery-7",
              state: "running",
            }),
          }),
        ],
        running_events: [
          runningEvent({
            delivery_id: "delivery-7",
            issue_key: "owner/repo#7",
          }),
        ],
        inflight: ["owner/repo#7"],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#7",
      deliveryId: "delivery-7",
      bucket: "running",
      inflightOnly: false,
    });
    expect(items[0].live?.delivery_id).toBe("delivery-7");
  });

  test("excludes terminal issues", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#2",
            number: 2,
            state: "merged",
            latest_event: latestEvent({ delivery_id: "done-2", state: "done" }),
          }),
        ],
      }),
    );

    expect(items).toEqual([]);
  });

  test("keeps live terminal issues visible until the running delivery disappears", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#223",
            number: 223,
            state: "merged",
            latest_event: latestEvent({ delivery_id: "done-223", state: "done" }),
          }),
        ],
        running_events: [
          runningEvent({
            delivery_id: "live-terminal-223",
            issue_key: "owner/repo#223",
          }),
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#223",
      deliveryId: "live-terminal-223",
      issueState: "merged",
      bucket: "running",
      inflightOnly: false,
    });
    expect(items[0].live?.delivery_id).toBe("live-terminal-223");
  });

  test("terminal issues stay excluded from orphan recent-event fallback", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#222",
            number: 222,
            state: "abandoned",
            latest_event: latestEvent({
              delivery_id: "failed-terminal",
              state: "failed",
              last_error: "terminal failure",
            }),
          }),
        ],
        recent_events: [
          recentEvent({
            delivery_id: "failed-terminal",
            issue_key: "owner/repo#222",
            received_at: "2026-06-17T00:07:00Z",
            last_error: "terminal failure",
          }),
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  test("uses issue latest_event as authority for failed issue rows", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#3",
            number: 3,
            latest_event: latestEvent({
              delivery_id: "done-3",
              state: "done",
              received_at: "2026-06-17T00:03:00Z",
            }),
          }),
          issue({
            key: "owner/repo#4",
            number: 4,
            latest_event: latestEvent({
              delivery_id: "failed-4",
              state: "failed",
              received_at: "2026-06-17T00:04:00Z",
              last_error: "current failure",
            }),
          }),
        ],
        recent_events: [
          recentEvent({
            delivery_id: "old-failed-3",
            issue_key: "owner/repo#3",
            received_at: "2026-06-17T00:02:00Z",
            last_error: "superseded failure",
          }),
          recentEvent({
            delivery_id: "failed-4",
            issue_key: "owner/repo#4",
            received_at: "2026-06-17T00:04:00Z",
            last_error: "current failure",
          }),
        ],
      }),
    );

    expect(items.some((item) => item.deliveryId === "old-failed-3")).toBe(false);
    expect(items.filter((item) => item.deliveryId === "failed-4")).toHaveLength(1);
    expect(items.find((item) => item.deliveryId === "failed-4")).toMatchObject({
      key: "owner/repo#4",
      bucket: "failed",
      error: "current failure",
    });
  });

  test("includes issue-less failed recent events as orphan failed items", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "orphan-failed",
            issue_key: null,
            received_at: "2026-06-17T00:05:00Z",
            last_error: "orphan failure",
          }),
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "orphan-failed",
      ref: null,
      deliveryId: "orphan-failed",
      bucket: "failed",
      error: "orphan failure",
      latestEvent: {
        delivery_id: "orphan-failed",
        state: "failed",
        last_error: "orphan failure",
      },
    });
  });

  test("orders buckets by severity before ordering newest first within a bucket", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#1",
            number: 1,
            latest_event: latestEvent({
              delivery_id: "failed-old",
              state: "failed",
              received_at: "2026-06-17T00:01:00Z",
            }),
          }),
          issue({
            key: "owner/repo#2",
            number: 2,
            latest_event: latestEvent({
              delivery_id: "running-2",
              state: "running",
              received_at: "2026-06-17T00:02:00Z",
            }),
          }),
          issue({
            key: "owner/repo#3",
            number: 3,
            latest_event: latestEvent({
              delivery_id: "queued-3",
              state: "queued",
              received_at: "2026-06-17T00:03:00Z",
            }),
          }),
          issue({
            key: "owner/repo#4",
            number: 4,
            updated_at: "2026-06-17T00:04:00Z",
          }),
          issue({
            key: "owner/repo#5",
            number: 5,
            latest_event: latestEvent({
              delivery_id: "failed-new",
              state: "failed",
              received_at: "2026-06-17T00:05:00Z",
            }),
          }),
        ],
      }),
    );

    expect(items.map((item) => `${item.bucket}:${item.key}`)).toEqual([
      "failed:owner/repo#5",
      "failed:owner/repo#1",
      "running:owner/repo#2",
      "queued:owner/repo#3",
      "active:owner/repo#4",
    ]);
  });

  test("returns no work items for an empty status response", () => {
    expect(buildWorkItems(status())).toEqual([]);
  });

  test("1. inflight-only active issue", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#12",
            number: 12,
            latest_event: null,
          }),
        ],
        inflight: ["owner/repo#12"],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#12",
      bucket: "running",
      inflightOnly: true,
      live: null,
    });
  });

  test("2. orphan running issue key absent from issues yields ref and keeps delivery/action data", () => {
    const items = buildWorkItems(
      status({
        running_events: [
          runningEvent({
            issue_key: "octo/widget#999",
            delivery_id: "run-x",
            last_tool: "edit",
            last_tool_ts: "2026-06-17T00:02:00Z",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    // The issue row is absent, but the issue-shaped key recovers the ref so the
    // orphan card can still link to octo/widget#999.
    expect(items[0]).toMatchObject({
      ref: { repo: "octo/widget", number: 999 },
      bucket: "running",
      deliveryId: "run-x",
      inflightOnly: false,
    });
    // Delivery id and live action data survive the orphan path.
    expect(items[0].live?.delivery_id).toBe("run-x");
    expect(items[0].live?.last_tool).toBe("edit");
    expect(items[0].live?.model).toBe("test-model");
  });

  test("3. orphan inflight-only issue key absent from issues yields ref with no real delivery", () => {
    const items = buildWorkItems(
      status({
        inflight: ["octo/widget#888"],
      }),
    );
    expect(items).toHaveLength(1);
    // Issue-shaped inflight key recovers the ref even with no issue row.
    expect(items[0]).toMatchObject({
      ref: { repo: "octo/widget", number: 888 },
      bucket: "running",
      inflightOnly: true,
      live: null,
    });
    // No running event, so there is no real delivery id; it falls back to the key.
    expect(items[0].deliveryId).toBe("octo/widget#888");
  });

  test("3b. non-issue orphan delivery/key keeps ref null", () => {
    const items = buildWorkItems(
      status({
        running_events: [
          runningEvent({
            issue_key: null,
            delivery_id: "run-bare-uuid",
          }),
        ],
        inflight: ["inflight-bare-uuid"],
      }),
    );
    expect(items).toHaveLength(2);
    // Neither key is issue-shaped (no `#`), so both stay ref: null.
    const running = items.find((i) => i.deliveryId === "run-bare-uuid");
    const inflight = items.find((i) => i.key === "inflight-bare-uuid");
    expect(running?.ref).toBeNull();
    expect(inflight?.ref).toBeNull();
    expect(inflight?.inflightOnly).toBe(true);
  });

  test("4. failed issue with last_error:null", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#14",
            latest_event: latestEvent({
              state: "failed",
              last_error: null,
            }),
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      bucket: "failed",
      error: null,
    });
  });

  test("5. recent failed event with empty delivery_id", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "",
            issue_key: null,
          }),
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  test("6. recent failed event duplicating an already-seen delivery_id", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#15",
            latest_event: latestEvent({
              delivery_id: "dup",
              state: "failed",
            }),
          }),
        ],
        recent_events: [
          recentEvent({
            delivery_id: "dup",
            issue_key: "owner/repo#15",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe("dup");
  });

  test("7. recent failed event for an already-seen issue_key, different delivery, issue latest is that same failed delivery", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#16",
            latest_event: latestEvent({
              delivery_id: "A",
              state: "failed",
            }),
          }),
        ],
        recent_events: [
          recentEvent({
            delivery_id: "B",
            issue_key: "owner/repo#16",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].deliveryId).toBe("A");
  });

  test("8. orphan failed event, issue_key non-numeric after # / plainstring", () => {
    const items1 = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            issue_key: "weird#abc",
            delivery_id: "w1",
          }),
        ],
      }),
    );
    expect(items1).toHaveLength(1);
    expect(items1[0].ref).toBeNull();

    const items2 = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            issue_key: "plainstring",
            delivery_id: "w2",
          }),
        ],
      }),
    );
    expect(items2).toHaveLength(1);
    expect(items2[0].ref).toEqual({
      repo: "plainstring",
      number: 0,
    });
  });

  test("9. stageOrdinal direct", () => {
    expect(stageOrdinal(null)).toBe(0);
    expect(stageOrdinal("nonsense")).toBe(0);
    expect(stageOrdinal("new")).toBe(0);
    expect(stageOrdinal("reproducing")).toBe(1);
    // needs_info is set by mark_unable_to_reproduce during reproduction and
    // cleared back to reproducing by repro_record in host_tools; it stays in
    // the reproduction phase (ordinal 1), not advanced past fixing.
    expect(stageOrdinal("needs_info")).toBe(1);
    expect(stageOrdinal("fixing")).toBe(2);
    // reviewing is PR review work (tasks.py sets it on PR-opened issues); it
    // lives on the PR step, same stage as opened (ordinal 3).
    expect(stageOrdinal("opened")).toBe(3);
    expect(stageOrdinal("reviewing")).toBe(3);
    expect(stageOrdinal("merged")).toBe(4);
  });

  test("10. parseTs invalid -> 0 tiebreak", () => {
    const items = buildWorkItems(
      status({
        running_events: [
          runningEvent({
            delivery_id: "run-invalid-ts",
            issue_key: null,
            started_at: null,
            received_at: "invalid-date",
          }),
          runningEvent({
            delivery_id: "run-valid-ts",
            issue_key: null,
            started_at: "2026-06-17T00:01:00Z",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(2);
    expect(items.map(i => i.deliveryId)).toEqual(["run-valid-ts", "run-invalid-ts"]);
  });

  test("live running event outranks a newer failed latest_event for the same issue", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#20",
            number: 20,
            latest_event: latestEvent({
              delivery_id: "failed-newer",
              state: "failed",
              received_at: "2026-06-17T00:09:00Z",
              last_error: "stale failure",
            }),
          }),
        ],
        running_events: [
          runningEvent({
            delivery_id: "live-older",
            issue_key: "owner/repo#20",
            received_at: "2026-06-17T00:01:00Z",
            started_at: "2026-06-17T00:02:00Z",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#20",
      bucket: "running",
      deliveryId: "live-older",
      inflightOnly: false,
      error: null,
    });
    // Cancel button targets the live delivery, not the stale failed row.
    expect(items[0].live?.delivery_id).toBe("live-older");
    // ActivityPill renders running, never the superseded failed state.
    expect(items[0].latestEvent?.state).toBe("running");
  });

  test("live running event outranks a newer done latest_event for the same issue", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#21",
            number: 21,
            latest_event: latestEvent({
              delivery_id: "done-newer",
              state: "done",
              received_at: "2026-06-17T00:09:00Z",
            }),
          }),
        ],
        running_events: [
          runningEvent({
            delivery_id: "live-older-2",
            issue_key: "owner/repo#21",
            received_at: "2026-06-17T00:01:00Z",
            started_at: "2026-06-17T00:02:00Z",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#21",
      bucket: "running",
      deliveryId: "live-older-2",
    });
    expect(items[0].live?.delivery_id).toBe("live-older-2");
    expect(items[0].latestEvent?.state).toBe("running");
  });

  test("live running event outranks a newer queued latest_event for the same issue", () => {
    const items = buildWorkItems(
      status({
        issues: [
          issue({
            key: "owner/repo#22",
            number: 22,
            latest_event: latestEvent({
              delivery_id: "queued-newer",
              state: "queued",
              received_at: "2026-06-17T00:09:00Z",
            }),
          }),
        ],
        running_events: [
          runningEvent({
            delivery_id: "live-older-3",
            issue_key: "owner/repo#22",
            received_at: "2026-06-17T00:01:00Z",
            started_at: "2026-06-17T00:02:00Z",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#22",
      bucket: "running",
      deliveryId: "live-older-3",
      inflightOnly: false,
      error: null,
    });
    expect(items[0].live?.delivery_id).toBe("live-older-3");
    expect(items[0].latestEvent?.state).toBe("running");
    expect(items[0].latestEvent?.delivery_id).toBe("live-older-3");
  });

  test("suppresses an orphan failed recent event superseded by a newer done recent event for the same absent issue", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "done-newer-orphan",
            issue_key: "owner/repo#30",
            state: "done",
            received_at: "2026-06-17T00:06:00Z",
            last_error: null,
          }),
          recentEvent({
            delivery_id: "failed-older-orphan",
            issue_key: "owner/repo#30",
            received_at: "2026-06-17T00:04:00Z",
            last_error: "superseded orphan failure",
          }),
        ],
      }),
    );
    expect(items.some((item) => item.deliveryId === "failed-older-orphan")).toBe(false);
    expect(items).toEqual([]);
  });

  test("suppresses an orphan failed recent event when a newer queued event appears later in the list", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "failed-older-out-of-order",
            issue_key: "owner/repo#32",
            received_at: "2026-06-17T00:04:00Z",
            last_error: "older failure",
          }),
          recentEvent({
            delivery_id: "queued-newer-out-of-order",
            issue_key: "owner/repo#32",
            state: "queued",
            received_at: "2026-06-17T00:06:00Z",
            last_error: null,
          }),
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  test("suppresses a same-timestamp orphan failure when a non-failed recent event exists", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "failed-same-time",
            issue_key: "owner/repo#33",
            received_at: "2026-06-17T00:06:00Z",
            last_error: "ambiguous failure",
          }),
          recentEvent({
            delivery_id: "done-same-time",
            issue_key: "owner/repo#33",
            state: "done",
            received_at: "2026-06-17T00:06:00Z",
            last_error: null,
          }),
        ],
      }),
    );
    expect(items).toEqual([]);
  });

  test("does not let a newer skipped event suppress a retryable orphan failure", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "failed-before-skipped",
            issue_key: "owner/repo#34",
            received_at: "2026-06-17T00:04:00Z",
            last_error: "real failure",
          }),
          recentEvent({
            delivery_id: "skipped-newer-noise",
            issue_key: "owner/repo#34",
            state: "skipped",
            received_at: "2026-06-17T00:06:00Z",
            last_error: null,
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      deliveryId: "failed-before-skipped",
      bucket: "failed",
      error: "real failure",
    });
  });

  test("renders an orphan failed recent event that is the newest for an absent issue", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          recentEvent({
            delivery_id: "failed-newest-orphan",
            issue_key: "owner/repo#31",
            received_at: "2026-06-17T00:06:00Z",
            last_error: "current orphan failure",
          }),
          recentEvent({
            delivery_id: "done-older-orphan",
            issue_key: "owner/repo#31",
            state: "done",
            received_at: "2026-06-17T00:04:00Z",
            last_error: null,
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "owner/repo#31",
      deliveryId: "failed-newest-orphan",
      bucket: "failed",
      error: "current orphan failure",
    });
  });

  test("suppresses a failed recent event for an absent issue whose issue_state is terminal", () => {
    const items = buildWorkItems(
      status({
        recent_events: [
          // octo/widget#900 is outside the capped status.issues window, so the
          // only authority for its lifecycle is the issue_state /api/status
          // attached. It is "merged", so this stale failure must not surface.
          recentEvent({
            delivery_id: "failed-terminal-orphan",
            issue_key: "octo/widget#900",
            issue_state: "merged",
            received_at: "2026-06-17T00:06:00Z",
            last_error: "stale terminal failure",
          }),
          // A retryable failure for a different, non-terminal absent issue must
          // still render: the terminal skip only drops its own event.
          recentEvent({
            delivery_id: "failed-retryable-orphan",
            issue_key: "octo/widget#901",
            issue_state: "fixing",
            received_at: "2026-06-17T00:05:00Z",
            last_error: "live failure",
          }),
        ],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "octo/widget#901",
      deliveryId: "failed-retryable-orphan",
      bucket: "failed",
      issueState: "fixing",
      error: "live failure",
    });
  });

});
