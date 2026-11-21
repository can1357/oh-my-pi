/**
 * A call on a tab that is still running another call fails at once. Tabs are shared by name across agents, so the
 * error must say whether the running call is the caller's own (it ran calls together) or another agent's (its own
 * calls were sequential, and the advice to await them would send it in circles).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	type PendingRun,
	releaseTab,
	runInTab,
	type TabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const TAB = "shared-busy";
const TERN_TAB = "tern-redirected";
let daemon: FakeDaemon | undefined;

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

afterEach(async () => {
	getTabsMapForTest().delete(TAB);
	await releaseTab(TERN_TAB, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
});

/** A fake Tern window and the id of the first page-world evaluation it left unanswered. */
interface RedirectingWindow {
	fake: FakeDaemon;
	evaluation: Promise<number>;
}

/**
 * A Tern window whose page answers no `tab.evaluate` once called: like a Laravel page whose unauthenticated request
 * 302s to /login, the evaluation's document is replaced and its answer never comes. Block 9 is the tab's own.
 */
async function startRedirectingWindow(): Promise<RedirectingWindow> {
	let seq = 0;
	let redirected = false;
	const evaluation = Promise.withResolvers<number>();
	const fake = await startFakeDaemon((op, id): FakeAnswer => {
		switch (op.op) {
			case "open":
				return { ok: { block: 9, url: "about:blank" } };
			case "events": {
				const events: object[] = op.after === 0 ? [{ seq: ++seq, type: "loaded", url: "about:blank" }] : [];
				if (redirected && seq === 1) {
					events.push({ seq: ++seq, type: "committed", url: "https://app.test/login" });
				}
				return { ok: { events, next: seq, dropped: 0 } };
			}
			case "state":
				return {
					ok: {
						url: redirected ? "https://app.test/login" : "about:blank",
						title: "",
						loading: false,
						shown: true,
						width: 800,
						height: 600,
					},
				};
			case "eval":
				// omp's own evaluations (the kit's `frames`, script installers) answer; the call's never does.
				if (typeof op.function !== "string" || !op.function.includes("document.title")) {
					return { ok: { value: { value: [] } } };
				}
				redirected = true;
				evaluation.resolve(id);
				return null;
			default:
				return { ok: {} };
		}
	});
	daemon = fake;
	return { fake, evaluation: evaluation.promise };
}

function ternSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

async function openRedirectingTab(): Promise<RedirectingWindow> {
	const opened = await startRedirectingWindow();
	const browser = await acquireBrowser({ kind: "tern", socketPath: opened.fake.socketPath, pane: 3 }, { cwd: "/tmp" });
	await acquireTab(TERN_TAB, browser, { timeoutMs: 5_000 });
	return opened;
}

const NEVER_ANSWERED = "return await tab.evaluate(() => document.title);";

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

	it("takes the next call after an evaluation a navigation left unanswered times out", async () => {
		const { fake, evaluation } = await openRedirectingTab();
		const session = ternSession();
		// A real (short) run budget: the timers under test end the run, and the fake answers over a real socket.
		await expect(runInTab(TERN_TAB, { code: NEVER_ANSWERED, timeoutMs: 1_500, session })).rejects.toThrow();
		// The engine's answer for the replaced document arrives after the call gave up.
		fake.answer(await evaluation, {
			error: { kind: "failed", message: "eval: the page navigated away before the function returned" },
		});
		expect(getTabsMapForTest().get(TERN_TAB)?.pending.size).toBe(0);
		const next = await runInTab(TERN_TAB, { code: "return 1;", timeoutMs: 5_000, session });
		expect(next.returnValue).toBe(1);
	});

	it("takes the next call after a cancelled call whose evaluation a navigation left unanswered", async () => {
		const { evaluation } = await openRedirectingTab();
		const session = ternSession();
		const cancel = new AbortController();
		const call = runInTab(TERN_TAB, { code: NEVER_ANSWERED, timeoutMs: 60_000, signal: cancel.signal, session });
		await evaluation;
		cancel.abort();
		await expect(call).rejects.toThrow();
		expect(getTabsMapForTest().get(TERN_TAB)?.pending.size).toBe(0);
		const next = await runInTab(TERN_TAB, { code: "return 1;", timeoutMs: 5_000, session });
		expect(next.returnValue).toBe(1);
	});
});
