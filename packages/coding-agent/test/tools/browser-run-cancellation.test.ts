import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { postmortem } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";
import {
	bindRunFacade,
	isBrowserRunOwnedRejection,
	isBrowserRunRejection,
	markBrowserRunRejection,
	markHandled,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../../src/tools/run-scope";
import { ToolAbortError } from "../../src/tools/tool-errors";

const runScopeModuleUrl = new URL("../../src/tools/run-scope.ts", import.meta.url).href;

async function collectUnhandledRejections(action: () => void | Promise<void>): Promise<unknown[]> {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => reasons.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await action();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		await Promise.resolve();
		return reasons;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("browser run cancellation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the same promise while preserving awaited rejection", async () => {
		const rejection = new Error("browser run ended");
		const promise = Promise.reject(rejection);

		const handled = markHandled(promise);

		expect(handled).toBe(promise);
		await expect(handled).rejects.toBe(rejection);
	});

	it("resolves run-scoped wait when the run is not aborted", async () => {
		const controller = new AbortController();

		const wait = waitForRun(25, controller.signal);
		vi.advanceTimersByTime(25);

		await expect(wait).resolves.toBeUndefined();
	});

	it("rejects run-scoped wait when the run aborts mid-sleep", async () => {
		const controller = new AbortController();
		const wait = waitForRun(1000, controller.signal);

		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("resolves wait(predicate) with the first truthy value", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		let calls = 0;

		const wait = waitForRun(() => (++calls >= 3 ? "ready" : null), controller.signal, { interval: 10 });

		await expect(wait).resolves.toBe("ready");
		expect(calls).toBe(3);
	});

	it("fails wait(predicate) with a named timeout error instead of stalling", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForRun(() => false, controller.signal, { timeout: 50, interval: 10 });

		await expect(wait).rejects.toThrow("wait(predicate) timed out after 50ms");
	});

	it("rejects wait(predicate) when the run aborts mid-poll", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForRun(() => false, controller.signal, { timeout: 5000 });
		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("rejects wait() input that is neither milliseconds nor a predicate", async () => {
		const controller = new AbortController();

		await expect(waitForRun("soon" as never, controller.signal)).rejects.toThrow(
			"wait(...) expects milliseconds (number) or a predicate function to poll",
		);
	});

	it("does not emit unhandledRejection for an unawaited wait aborted by run teardown", async () => {
		const controller = new AbortController();

		const reasons = await collectUnhandledRejections(async () => {
			void waitForRun(1000, controller.signal);
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
		});

		expect(reasons).toEqual([]);
	});

	it("does not emit unhandledRejection when an unawaited facade method settles after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const reasons = await collectUnhandledRejections(async () => {
			void facade.readTitle();
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
			deferred.resolve("late title");
		});

		expect(reasons).toEqual([]);
	});

	it("scopes browser rejection markers to the owning run and direct reason", () => {
		const owner = {};
		const browserFailure = new Error("browser failed");
		markBrowserRunRejection(browserFailure, owner);

		expect(isBrowserRunRejection(browserFailure, owner)).toBe(true);
		expect(isBrowserRunRejection(browserFailure, {})).toBe(false);
		expect(isBrowserRunRejection(new Error("unrelated", { cause: browserFailure }), owner)).toBe(false);
	});

	it("keeps unrelated worker rejections outside the active browser run", () => {
		const owner = {};
		const workerFailure = new Error("transport failed");
		workerFailure.stack = "Error: transport failed\n    at tab-worker.ts:1:1";
		const evaluatedFailure = new Error("evaluated failure");
		evaluatedFailure.stack = "Error: evaluated failure\n    at browser-run-run-1.js:1:1";

		expect(isBrowserRunOwnedRejection(workerFailure, owner, "browser-run-run-1.js")).toBe(false);
		expect(isBrowserRunOwnedRejection(evaluatedFailure, owner, "browser-run-run-1.js")).toBe(true);
		expect(
			isBrowserRunOwnedRejection(markBrowserRunRejection(workerFailure, owner), owner, "browser-run-run-1.js"),
		).toBe(true);
	});

	it("keeps a later cause-wrapped rejection on the fatal path", async () => {
		vi.useRealTimers();
		const script = `
			import { markBrowserRunRejection } from ${JSON.stringify(runScopeModuleUrl)};

			const browserFailure = new Error("browser failure");
			markBrowserRunRejection(browserFailure, {});
			Promise.reject(new Error("unrelated fatal", { cause: browserFailure }));
			await Promise.resolve();
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("[Unhandled Rejection] Error: unrelated fatal");
	});

	it("preserves a browser rejection marker through native await", async () => {
		const owner = {};
		const browserFailure = new Error("browser failed");
		const facade = bindRunFacade(
			{
				fail(): Promise<never> {
					return Promise.reject(browserFailure);
				},
			},
			new AbortController().signal,
			owner,
		);

		let caught: unknown;
		try {
			await (async () => await facade.fail())();
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(browserFailure);
		expect(isBrowserRunRejection(caught, owner)).toBe(true);
	});

	it("reports user rethrows from native browser-promise combinators", async () => {
		vi.useRealTimers();
		for (const name of ["all", "race", "allSettled", "any"] as const) {
			const owner = {};
			const browserFailure = new Error(`${name} browser failure`);
			const floatingRejections: unknown[] = [];
			const facade = bindRunFacade(
				{
					fail(): Promise<never> {
						return Promise.reject(browserFailure);
					},
				},
				new AbortController().signal,
				owner,
				reason => floatingRejections.push(reason),
			);
			const originalCombinator = Promise[name];

			await withBrowserPromiseCombinatorTracking(
				owner,
				reason => floatingRejections.push(reason),
				async () => {
					// oxlint-disable unicorn/no-single-promise-in-promise-methods -- the combinators themselves are under test
					const combined =
						name === "all"
							? Promise.all([facade.fail()])
							: name === "race"
								? Promise.race([facade.fail()])
								: name === "allSettled"
									? Promise.allSettled([facade.fail()]).then(results => {
											const [first] = results;
											if (first?.status === "rejected") throw first.reason;
										})
									: Promise.any([facade.fail()]);
					void combined.catch(reason => {
						throw reason;
					});
					// oxlint-enable unicorn/no-single-promise-in-promise-methods
					await Bun.sleep(20);
				},
			);

			if (name === "any") {
				expect(floatingRejections).toHaveLength(1);
				expect(floatingRejections[0]).toBeInstanceOf(AggregateError);
				expect((floatingRejections[0] as AggregateError).errors).toEqual([browserFailure]);
			} else {
				expect(floatingRejections).toEqual([browserFailure]);
			}
			expect(Promise[name]).toBe(originalCombinator);
		}
	});

	it("preserves native await through a tracked browser-promise combinator", async () => {
		vi.useRealTimers();
		const owner = {};
		const browserFailure = new Error("browser failed");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail(): Promise<never> {
					return Promise.reject(browserFailure);
				},
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		let caught: unknown;
		await withBrowserPromiseCombinatorTracking(
			owner,
			reason => floatingRejections.push(reason),
			async () => {
				try {
					// oxlint-disable-next-line unicorn/no-single-promise-in-promise-methods -- the tracked combinator is under test
					await Promise.all([facade.fail()]);
				} catch (error) {
					caught = error;
				}
				await Bun.sleep(10);
			},
		);

		expect(caught).toBe(browserFailure);
		expect(floatingRejections).toEqual([]);
	});

	it("keeps a real worker alive after floating browser and continuation rejections", async () => {
		vi.useRealTimers();
		const workerPath = `/tmp/omp-browser-rejections-${process.pid}.ts`;
		await Bun.write(
			workerPath,
			`
				import {
					bindRunFacade,
					installBrowserWorkerRejectionGuard,
				} from ${JSON.stringify(runScopeModuleUrl)};

				const failures = [];
				const uninstall = installBrowserWorkerRejectionGuard(reason => {
					failures.push(reason instanceof Error ? reason.message : String(reason));
					return true;
				});
				const facade = bindRunFacade(
					{
						waitForResponse() {
							return Promise.reject(new Error("browser timeout"));
						},
						title() {
							return Promise.resolve("ready");
						},
					},
					new AbortController().signal,
					{},
				);
				void (async () => {
					await facade.waitForResponse();
				})();
				void facade.title().then(() => {
					throw new Error("continuation failed");
				});
				setTimeout(() => {
					uninstall();
					postMessage({ alive: true, failures });
				}, 50);
			`,
		);
		try {
			const script = `
				const worker = new Worker(${JSON.stringify(workerPath)}, { type: "module" });
				const done = Promise.withResolvers();
				worker.onmessage = event => done.resolve(event.data);
				worker.onerror = event => done.reject(new Error(event.message));
				try {
					const result = await Promise.race([
						done.promise,
						Bun.sleep(1000).then(() => {
							throw new Error("worker timed out");
						}),
					]);
					console.log(JSON.stringify(result));
				} finally {
					await worker.terminate();
				}
			`;
			const proc = Bun.spawn([process.execPath, "-e", script], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("browser timeout");
			expect(stdout).toContain("continuation failed");
		} finally {
			await fs.rm(workerPath, { force: true });
		}
	});

	it("does not mark errors thrown by user continuations", async () => {
		const owner = {};
		const continuationFailure = new Error("continuation failed");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				ok: async (): Promise<string> => "ok",
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		const root = facade.ok();
		expect(root).toBeInstanceOf(Promise);
		expect(Object.getPrototypeOf(root)).toBe(Promise.prototype);
		const continuation = root.then(() => {
			throw continuationFailure;
		});

		await expect(continuation).rejects.toBe(continuationFailure);
		expect(isBrowserRunRejection(continuationFailure, owner)).toBe(false);
		expect(floatingRejections).toEqual([]);
	});

	it("reports unhandled errors from then, catch, and finally continuations", async () => {
		vi.useRealTimers();
		const owner = {};
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail: async (): Promise<never> => {
					throw new Error("browser failure");
				},
				ok: async (): Promise<string> => "ok",
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		void facade.ok().then(() => {
			throw new Error("then failed");
		});
		void facade.fail().catch(() => {
			throw new Error("catch failed");
		});
		void facade.ok().finally(() => {
			throw new Error("finally failed");
		});
		await Bun.sleep(20);

		const messages = floatingRejections
			.map(reason => (reason instanceof Error ? reason.message : String(reason)))
			.sort();
		expect(messages).toEqual(["catch failed", "finally failed", "then failed"]);
	});

	it("reports a browser error rethrown by a user rejection continuation", async () => {
		vi.useRealTimers();
		const owner = {};
		const browserFailure = new Error("browser failure");
		const floatingRejections: unknown[] = [];
		const facade = bindRunFacade(
			{
				fail: (): Promise<never> => Promise.reject(browserFailure),
			},
			new AbortController().signal,
			owner,
			reason => floatingRejections.push(reason),
		);

		void facade.fail().catch(reason => {
			throw reason;
		});
		await Bun.sleep(20);

		expect(isBrowserRunRejection(browserFailure, owner)).toBe(true);
		expect(floatingRejections).toEqual([browserFailure]);
	});

	it("rejects awaited facade method calls that settle after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const pending = facade.readTitle();
		controller.abort(new Error("browser run ended"));
		deferred.resolve("late title");

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("aborts run-scoped wait() before a stale continuation can mutate the tab", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-run-cancellation-test" });
		const timeoutSignal = AbortSignal.timeout(20);
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, runAc.signal]);
		const state: { lateNavigation?: string; displays: string[] } = { displays: [] };
		const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
		const hooks: RuntimeHooks = {
			onText: chunk => state.displays.push(chunk),
			onDisplay: output => state.displays.push(JSON.stringify(output)),
			callTool: async () => undefined,
		};
		timeoutSignal.addEventListener("abort", () => reject(new Error("Browser code execution timed out after 20ms")), {
			once: true,
		});
		runtime.setRunScope({
			wait: (ms: number): Promise<unknown> => waitForRun(ms, signal),
			tab: bindRunFacade(
				{
					goto: async (url: string): Promise<void> => {
						state.lateNavigation = url;
					},
				},
				signal,
			),
		});

		const run = Promise.race([
			runtime.run(
				'try { await wait(60); } catch {} await tab.goto("https://late.example"); display("late display");',
				"browser-run-cancellation-test.js",
				hooks,
			),
			cancelRejection,
		]);
		vi.advanceTimersByTime(20);
		await expect(run).rejects.toThrow("Browser code execution timed out after 20ms");
		runAc.abort(new Error("Browser run ended"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();

		expect(state.lateNavigation).toBeUndefined();
		expect(state.displays).toEqual([]);
	});
});
