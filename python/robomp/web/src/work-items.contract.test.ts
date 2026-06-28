import { describe, expect, test } from "bun:test";
import { buildWorkItems } from "./work-items";
import type { StatusResponse } from "./types";

// Read from test/fixtures/status-contract.json relative to src/
const status = await Bun.file(
  new URL("../test/fixtures/status-contract.json", import.meta.url).pathname
).json() as StatusResponse;

describe("buildWorkItems contract validation", () => {
  test("satisfies relational properties on real status-contract payload", () => {
    const items = buildWorkItems(status);

    // 1. The merged issue key is absent from results
    const mergedKey = "octo/widget#4";
    expect(items.some((item) => item.key === mergedKey)).toBe(false);

    // 2. The superseded older-failed delivery id is absent
    const supersededId = "superseded-failed";
    expect(items.some((item) => item.deliveryId === supersededId)).toBe(false);

    // 3. The currently-failed issue is present with bucket: "failed"
    const failedItem = items.find((item) => item.key === "octo/widget#2");
    expect(failedItem).toBeDefined();
    expect(failedItem?.bucket).toBe("failed");
    expect(failedItem?.error).toBe("repro diverged");

    // and sorts before any running card
    const failedIndices = items
      .map((item, idx) => (item.bucket === "failed" ? idx : null))
      .filter((idx): idx is number => idx !== null);
    const runningIndices = items
      .map((item, idx) => (item.bucket === "running" ? idx : null))
      .filter((idx): idx is number => idx !== null);

    if (failedIndices.length > 0 && runningIndices.length > 0) {
      const maxFailedIndex = Math.max(...failedIndices);
      const minRunningIndex = Math.min(...runningIndices);
      expect(maxFailedIndex).toBeLessThan(minRunningIndex);
    }

    // 4. The issue-less failed delivery is present with ref: null, bucket: "failed"
    const orphanFailed = items.find((item) => item.deliveryId === "orphan-failed-x");
    expect(orphanFailed).toBeDefined();
    expect(orphanFailed?.ref).toBeNull();
    expect(orphanFailed?.bucket).toBe("failed");
    expect(orphanFailed?.error).toBe("orphan failed error");

    // 5. The running issue appears exactly once with bucket: "running"
    const runningItems = items.filter((item) => item.key === "octo/widget#1");
    expect(runningItems).toHaveLength(1);
    const runningItem = runningItems[0];
    expect(runningItem.bucket).toBe("running");
    expect(runningItem.live).not.toBeNull();
    expect(runningItem.live?.model).toBe("anthropic/claude-3-5-sonnet");
    expect(runningItem.live?.last_tool).toBe("edit");

    // 6. Bucket order is non-decreasing by rank (failed < running < queued < active)
    const ranks = { failed: 0, running: 1, queued: 2, active: 3 };
    for (let i = 0; i < items.length - 1; i++) {
      const rankA = ranks[items[i].bucket];
      const rankB = ranks[items[i + 1].bucket];
      expect(rankA).toBeLessThanOrEqual(rankB);
    }
  });
});
