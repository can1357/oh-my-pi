/**
 * A call on a tab that is still running another call fails at once. Tabs are shared by name across agents, so the
 * error must say whether the running call is the caller's own (it ran calls together) or another agent's (its own
 * calls were sequential, and the advice to await them would send it in circles).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getTabsMapForTest,
	type PendingRun,
	runInTab,
	type TabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const TAB = "shared-busy";

function sessionOf(owner: string): ToolSession {
	return {
		cwd: "/tmp/omp-busy-tab",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getEvalKernelOwnerId: () => owner,
	} as unknown as ToolSession;
}

/** A live tab with one call of `owner` in flight. */
function busyTab(owner: string): TabSession {
	const pending = new Map<string, PendingRun>([["run-1", { session: sessionOf(owner) } as unknown as PendingRun]]);
	return { name: TAB, state: "alive", backend: "worker", info: {}, pending } as unknown as TabSession;
}

afterEach(() => {
	getTabsMapForTest().delete(TAB);
});

describe("busy tab", () => {
	it("tells an agent whose call collides with another agent's to wait for it or open its own tab", async () => {
		getTabsMapForTest().set(TAB, busyTab("parent"));
		const call = runInTab(TAB, { code: "", timeoutMs: 1_000, session: sessionOf("subagent") });
		await expect(call).rejects.toThrow(/another agent is driving it/);
		await expect(call).rejects.not.toThrow(/Promise\.all/);
	});

	it("tells an agent whose own calls overlap to await each one", async () => {
		getTabsMapForTest().set(TAB, busyTab("parent"));
		await expect(runInTab(TAB, { code: "", timeoutMs: 1_000, session: sessionOf("parent") })).rejects.toThrow(
			/Await each call before starting the next/,
		);
	});
});
