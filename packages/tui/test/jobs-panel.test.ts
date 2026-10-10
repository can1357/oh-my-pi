/**
 * The jobs sheet is the only surface that stops a background job. A read-only
 * sheet — a focused subagent view reads the MAIN session's jobs through it, so
 * cancelling there would kill a job that session owns (#14814) — must not reach
 * `cancel` at all: no Cancel job action, and the X key and the native `cancel`
 * action stay unbound.
 */
import { describe, expect, it, vi } from "bun:test";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { JobsSheet, type JobsPanelJob, type JobsSheetSource } from "@oh-my-pi/pi-tui/overlays/jobs-panel";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => false, feature: () => false };
const X = "x";

const RUNNING: JobsPanelJob = {
	id: "job-1",
	type: "bash",
	status: "running",
	label: "cargo test --workspace",
	startTime: Date.now() - 1_000,
};

/** Depth-first search over described nodes. */
function find(root: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode | undefined {
	for (const child of root.c ?? []) {
		if (typeof child !== "object" || child === null || !("k" in child)) continue;
		if (predicate(child)) return child;
		const found = find(child, predicate);
		if (found) return found;
	}
	return undefined;
}

/** A sheet over one running job; a `cancel` callback is what makes it stoppable. */
function sheet(cancel?: (id: string) => void) {
	const close = vi.fn();
	const source: JobsSheetSource = {
		load: () => ({ running: [RUNNING], recent: [] }),
		inspect: () => ({ pids: [4242] }),
		close,
	};
	if (cancel) source.cancel = cancel;
	return { sheet: new JobsSheet(source), close };
}

describe("JobsSheet cancel affordance", () => {
	it("cancels the selected running job through the action and the X key", () => {
		const cancel = vi.fn();
		const { sheet: keyed } = sheet(cancel);
		expect(find(keyed.describe(CX), node => node.key === "cancel")).toBeDefined();

		const { sheet: clicked } = sheet(cancel);
		clicked.handleInput(X);
		clicked.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(cancel.mock.calls).toEqual([["job-1"], ["job-1"]]);
	});

	it("offers no Cancel job and binds neither X nor the cancel action when the source cannot cancel", () => {
		const { sheet: readOnly, close } = sheet();
		const described = readOnly.describe(CX);
		expect(find(described, node => node.key === "cancel")).toBeUndefined();
		expect(find(described, node => node.key === "close")).toBeDefined();

		readOnly.handleInput(X);
		readOnly.handleNativeEvent({ type: "action", key: "cancel", act: "cancel", mods: [] });
		expect(close).not.toHaveBeenCalled();

		// The job and its detail stay; only the way to stop it is gone.
		const rows = readOnly.render(100).join("\n");
		expect(rows).toContain("cargo test --workspace");
		expect(rows).toContain("pid 4242");
	});
});
