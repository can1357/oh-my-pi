import { describe, expect, it, vi } from "bun:test";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	callInProcessTab,
	type InProcessRunContext,
	type InProcessRunTab,
	runInProcessTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/in-process-run";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { SessionSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { type FakeAnswer, startFakeDaemon } from "./tern-fake-daemon";

/** A backend tab (Tern, WebKit, cmux) whose `tab.run` code executes in this process. */
class FakeTab implements InProcessRunTab {
	readonly runLabel = "fake-run";
	readonly page = {};
	readonly browser = {};
	rendererFailure?: Error;
	#runtime: JsRuntime | undefined;
	runtimeCreated = 0;
	discarded = 0;
	contexts: InProcessRunContext[] = [];
	navigatedUrls: string[] = [];
	recordedCalls: Array<{ method: string; args: unknown[] }> = [];

	ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (!this.#runtime) {
			this.runtimeCreated++;
			this.#runtime = new JsRuntime({ initialCwd: session.cwd, sessionId: `fake-${crypto.randomUUID()}` });
		}
		return this.#runtime;
	}

	setRunContext(context: InProcessRunContext): void {
		this.contexts.push(context);
	}

	clearRunContext(): void {}

	discardRuntime(): void {
		this.discarded++;
		this.#runtime?.dispose();
		this.#runtime = undefined;
	}

	async goto(url: string): Promise<void> {
		this.navigatedUrls.push(url);
	}

	async evaluate(fn: unknown, ...args: unknown[]): Promise<unknown> {
		this.recordedCalls.push({ method: "evaluate", args: [fn, ...args] });
		return {
			fnType: typeof fn,
			fnSource: typeof fn === "function" ? fn.toString() : fn,
			args,
		};
	}

	async waitFor(selector: string, opts?: { timeout?: number }): Promise<object | null> {
		this.recordedCalls.push({ method: "waitFor", args: [selector, opts] });
		return selector === "#present" ? {} : null;
	}

	async id(n: number): Promise<object> {
		this.recordedCalls.push({ method: "id", args: [n] });
		return {
			evaluate: async (fn: unknown, ...args: unknown[]) => {
				this.recordedCalls.push({ method: "id.evaluate", args: [fn, ...args] });
				return { fnType: typeof fn, fnSource: typeof fn === "function" ? fn.toString() : fn, args };
			},
		};
	}

	async frame(selector: string): Promise<object> {
		this.recordedCalls.push({ method: "frame", args: [selector] });
		return {
			waitFor: async (target: string, opts?: { timeout?: number }) => {
				this.recordedCalls.push({ method: "frame.waitFor", args: [target, opts] });
				return true;
			},
		};
	}

	async click(selector: string): Promise<void> {
		this.recordedCalls.push({ method: "click", args: [selector] });
		if (selector === "#hang") {
			await Promise.withResolvers<void>().promise;
		}
	}
}

const snapshot: SessionSnapshot = { cwd: process.cwd() };
const session = { cwd: process.cwd() } as ToolSession;

function run(tab: FakeTab, code: string, timeoutMs = 5_000) {
	return runInProcessTab(tab, { code, timeoutMs, session, snapshot });
}

describe("in-process browser runs", () => {
	it("runs code of different tabs at once by taking turns in the shared realm", async () => {
		const first = new FakeTab();
		const second = new FakeTab();
		const gate = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessGate = gate.promise;
		try {
			// The first run holds the realm until the gate opens, while the second is already waiting for it.
			const runs = Promise.all([
				run(first, "await globalThis.__inProcessGate; return 1;"),
				run(second, "return 2;"),
			]);
			gate.resolve();
			expect((await runs).map(result => result.returnValue)).toEqual([1, 2]);
		} finally {
			delete globals.__inProcessGate;
			first.discardRuntime();
			second.discardRuntime();
		}
	});

	it("frees the realm for other tabs when a run never settles", async () => {
		const hung = new FakeTab();
		const other = new FakeTab();
		try {
			// The run's own budget is the timer under test: a short real one.
			await expect(run(hung, "await Promise.withResolvers().promise;", 100)).rejects.toThrow(
				"timed out after 100ms",
			);
			expect(hung.discarded).toBe(1);
			expect((await run(other, "return 3;")).returnValue).toBe(3);
		} finally {
			hung.discardRuntime();
			other.discardRuntime();
		}
	});

	it("runs direct helper calls on another tab immediately while a tab.run holds the shared realm", async () => {
		const holder = new FakeTab();
		const caller = new FakeTab();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessHoldStarted = started.resolve;
		globals.__inProcessHoldRelease = release.promise;
		try {
			const blockedRun = runInProcessTab(holder, {
				code: "globalThis.__inProcessHoldStarted(); await globalThis.__inProcessHoldRelease; return 'done';",
				timeoutMs: 5_000,
				session,
				snapshot,
				tabName: "webcss",
			});
			await started.promise;

			// Direct helper call on a sibling tab completes while `blockedRun` is still parked on `release`.
			await callInProcessTab(caller, {
				chain: [{ method: "goto", args: ["http://127.0.0.1:3921/ascii.html"] }],
				timeoutMs: 5_000,
				snapshot,
			});
			expect(caller.navigatedUrls).toEqual(["http://127.0.0.1:3921/ascii.html"]);
			expect(caller.runtimeCreated).toBe(0);

			release.resolve();
			expect((await blockedRun).returnValue).toBe("done");
		} finally {
			delete globals.__inProcessHoldStarted;
			delete globals.__inProcessHoldRelease;
			holder.discardRuntime();
			caller.discardRuntime();
		}
	});

	it("materializes functions, regexes, wait sentinels, presence booleans, and one-hop handle calls", async () => {
		const tab = new FakeTab();

		const evaluated = await callInProcessTab(tab, {
			chain: [
				{
					method: "evaluate",
					args: [
						{ __omp_fn: "(a, b) => a + b // trailing comment" },
						{ filter: { __omp_re: { source: "woff2", flags: "i" } } },
					],
				},
			],
			timeoutMs: 5_000,
			snapshot,
		});
		const evalArgs = tab.recordedCalls.at(-1)?.args;
		const fnArg = evalArgs?.[0];
		expect(typeof fnArg).toBe("function");
		if (typeof fnArg === "function") {
			expect(fnArg.toString()).toBe("(a, b) => a + b");
		}
		const secondArg = evalArgs?.[1];
		expect(isRecord(secondArg)).toBe(true);
		const nestedFilter = isRecord(secondArg) ? secondArg.filter : undefined;
		expect(nestedFilter).toBeInstanceOf(RegExp);
		if (nestedFilter instanceof RegExp) {
			expect(nestedFilter.source).toBe("woff2");
			expect(nestedFilter.flags).toBe("i");
		}
		expect(isRecord(evaluated.returnValue) ? evaluated.returnValue.fnType : undefined).toBe("function");

		const present = await callInProcessTab(tab, {
			chain: [{ method: "waitFor", args: ["#present", { timeout: Number.POSITIVE_INFINITY }] }],
			timeoutMs: 5_000,
			snapshot,
		});
		expect(present.returnValue).toBe(true);
		expect(tab.recordedCalls.at(-1)?.args).toEqual(["#present", { timeout: 0 }]);

		const absent = await callInProcessTab(tab, {
			chain: [{ method: "waitFor", args: ["#missing"] }],
			timeoutMs: 5_000,
			snapshot,
		});
		expect(absent.returnValue).toBe(false);

		const elEval = await callInProcessTab(tab, {
			chain: [
				{ method: "id", args: [5] },
				{ method: "evaluate", args: ["node => node.textContent", "extra"] },
			],
			timeoutMs: 5_000,
			snapshot,
		});
		expect(elEval.returnValue).toEqual({
			fnType: "function",
			fnSource: "node => node.textContent",
			args: ["extra"],
		});

		const frameWait = await callInProcessTab(tab, {
			chain: [
				{ method: "frame", args: ["#pay"] },
				{ method: "waitFor", args: ["#btn", { timeout: Number.POSITIVE_INFINITY }] },
			],
			timeoutMs: 5_000,
			snapshot,
		});
		expect(frameWait.returnValue).toBe(true);
		expect(tab.recordedCalls.at(-1)?.args).toEqual(["#btn", { timeout: 0 }]);

		tab.rendererFailure = new ToolError("renderer unresponsive");
		await expect(
			callInProcessTab(tab, {
				chain: [{ method: "goto", args: ["https://example.test"] }],
				timeoutMs: 5_000,
				snapshot,
			}),
		).rejects.toThrow("renderer unresponsive");
		tab.rendererFailure = undefined;

		await expect(
			callInProcessTab(tab, {
				chain: [{ method: "click", args: ["#hang"] }],
				timeoutMs: 50,
				snapshot,
			}),
		).rejects.toThrow("timed out after 50ms (stalled on tab.click())");
	});

	it("names the blocking tab and agent when a queued tab.run times out before starting", async () => {
		const holder = new FakeTab();
		const waiter = new FakeTab();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessQueueStarted = started.resolve;
		globals.__inProcessQueueRelease = release.promise;
		const subagentSession = { cwd: process.cwd(), getAgentId: () => "WebCssSplit" } as ToolSession;
		try {
			const holding = runInProcessTab(holder, {
				code: "globalThis.__inProcessQueueStarted(); await globalThis.__inProcessQueueRelease; return 'ok';",
				timeoutMs: 5_000,
				session: subagentSession,
				snapshot,
				tabName: "webcss",
			});
			await started.promise;

			const err = await runInProcessTab(waiter, {
				code: "return 1;",
				timeoutMs: 60,
				session,
				snapshot,
				tabName: "fonts",
			}).catch((error: unknown) => error);
			expect(String(err)).toContain('timed out after 60ms before starting on tab "fonts"');
			expect(String(err)).toContain('tab "webcss"');
			expect(String(err)).toContain('agent "WebCssSplit"');
			expect(waiter.contexts).toHaveLength(0);

			release.resolve();
			expect((await holding).returnValue).toBe("ok");
		} finally {
			delete globals.__inProcessQueueStarted;
			delete globals.__inProcessQueueRelease;
			holder.discardRuntime();
			waiter.discardRuntime();
		}
	});

	it("passes only the remaining budget to runContext after waiting in the tab.run queue", async () => {
		const holder = new FakeTab();
		const waiter = new FakeTab();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessBudgetStarted = started.resolve;
		globals.__inProcessBudgetRelease = release.promise;
		let now = 1_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const holding = runInProcessTab(holder, {
				code: "globalThis.__inProcessBudgetStarted(); await globalThis.__inProcessBudgetRelease;",
				timeoutMs: 5_000,
				session,
				snapshot,
				tabName: "first",
			});
			await started.promise;

			const queued = runInProcessTab(waiter, {
				code: "return 42;",
				timeoutMs: 2_000,
				session,
				snapshot,
				tabName: "second",
			});
			// While queued, runContext has not been published yet.
			await Promise.resolve();
			expect(waiter.contexts).toHaveLength(0);

			now += 600;
			release.resolve();
			expect((await queued).returnValue).toBe(42);
			await holding;
			expect(waiter.contexts).toHaveLength(1);
			expect(waiter.contexts[0]!.timeoutMs).toBe(1_400);
		} finally {
			clock.mockRestore();
			delete globals.__inProcessBudgetStarted;
			delete globals.__inProcessBudgetRelease;
			holder.discardRuntime();
			waiter.discardRuntime();
		}
	});

	it("navigates a Tern tab via action 'call' and tab reuse while another tab holds tab.run", async () => {
		let nextBlock = 10;
		let seq = 0;
		const blockState = new Map<number, { url: string; events: Array<Record<string, unknown>> }>();
		const daemon = await startFakeDaemon((op): FakeAnswer => {
			const block = typeof op.block === "number" ? op.block : undefined;
			switch (op.op) {
				case "open": {
					const id = ++nextBlock;
					blockState.set(id, {
						url: "about:blank",
						events: [{ seq: ++seq, type: "loaded", url: "about:blank" }],
					});
					return { ok: { block: id, url: "about:blank" } };
				}
				case "goto": {
					const state = block !== undefined ? blockState.get(block) : undefined;
					const url = typeof op.url === "string" ? op.url : "about:blank";
					if (state) {
						state.url = url;
						state.events.push({ seq: ++seq, type: "committed", url }, { seq: ++seq, type: "loaded", url });
					}
					return { ok: {} };
				}
				case "events": {
					const state = block !== undefined ? blockState.get(block) : undefined;
					const after = typeof op.after === "number" ? op.after : 0;
					const events = state ? state.events.filter(event => Number(event.seq) > after) : [];
					return { ok: { events, next: seq, dropped: 0 } };
				}
				case "state": {
					const state = block !== undefined ? blockState.get(block) : undefined;
					return {
						ok: {
							url: state?.url ?? "about:blank",
							title: "",
							loading: false,
							shown: true,
							width: 800,
							height: 600,
						},
					};
				}
				default:
					return { ok: {} };
			}
		});

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessTernStarted = started.resolve;
		globals.__inProcessTernRelease = release.promise;
		const fullSession: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};

		let holding: Promise<{ returnValue: unknown }> | undefined;
		try {
			const browser = await acquireBrowser(
				{ kind: "tern", socketPath: daemon.socketPath, pane: 3 },
				{ cwd: "/tmp" },
			);
			await acquireTab("e2e-holder", browser, { timeoutMs: 5_000 });
			await acquireTab("e2e-caller", browser, { timeoutMs: 5_000 });

			holding = runInTab("e2e-holder", {
				code: "globalThis.__inProcessTernStarted(); await globalThis.__inProcessTernRelease; return 'held';",
				timeoutMs: 5_000,
				session: fullSession,
			});
			await started.promise;

			// Direct helper call via the browser prelude navigates immediately without waiting for `e2e-holder`.
			const prelude = createBrowserPrelude(fullSession);
			await prelude.invoke(
				{
					action: "call",
					name: "e2e-caller",
					chain: [{ method: "goto", args: ["http://127.0.0.1:3921/ascii.html"] }],
				},
				{ session: fullSession, toolCallId: "e2e-goto" },
			);
			const urlResult = await prelude.invoke(
				{
					action: "call",
					name: "e2e-caller",
					chain: [{ method: "url", args: [] }],
				},
				{ session: fullSession, toolCallId: "e2e-url" },
			);
			expect(isRecord(urlResult.details) ? urlResult.details.value : undefined).toBe(
				"http://127.0.0.1:3921/ascii.html",
			);

			// Reusing the tab with a new URL also navigates directly instead of queuing behind `e2e-holder`.
			const reused = await acquireTab("e2e-caller", browser, {
				url: "http://127.0.0.1:3921/nerd.html",
				timeoutMs: 5_000,
			});
			expect(reused.tab.info.url).toBe("http://127.0.0.1:3921/nerd.html");

			release.resolve();
			expect((await holding).returnValue).toBe("held");
		} finally {
			release.resolve();
			await holding?.catch(() => undefined);
			delete globals.__inProcessTernStarted;
			delete globals.__inProcessTernRelease;
			await releaseTab("e2e-holder", { kill: false }).catch(() => undefined);
			await releaseTab("e2e-caller", { kill: false }).catch(() => undefined);
			await daemon.close();
		}
	});
});
