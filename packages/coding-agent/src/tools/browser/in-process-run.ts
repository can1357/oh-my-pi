/**
 * Runs `tab.run` code in-process for backends without a tab worker (cmux,
 * Tern): their tabs are thin RPC facades, so user code executes in a
 * `JsRuntime` of this process with the backend's `tab`/`page`/`browser`
 * facades in scope. Guest promise rejections are attributed to the run whose
 * guest file appears in their stack.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import { ToolError } from "../tool-errors";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { callSessionTool } from "../../eval/js/tool-bridge";
import type { ToolSession } from "../index";
import {
	bindRunFacade,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { cloneSafe, RunOutput } from "./run-output";
import { materializeTabCallArgs, type ParsedTabCall, parseTabCall, type TabCallStep } from "./tab-call";
import type { RunResultOk, ScreenshotResult, SessionSnapshot } from "./tab-protocol";

/** What a tab facade may use while one run is active. */
export interface InProcessRunContext {
	/** The session the run belongs to. */
	session: SessionSnapshot;
	/** Displays the run produces. */
	output: RunOutput;
	/** Screenshots the run saved. */
	screenshots: ScreenshotResult[];
	/** Aborts when the run ends, times out or is cancelled. */
	signal: AbortSignal;
	/** The run's budget. */
	timeoutMs: number;
	/** The run's absolute deadline in milliseconds since the epoch. */
	deadline: number;
}

/** A backend tab whose `run` code executes in this process. */
export interface InProcessRunTab {
	/** Guest file-name prefix naming the backend in stacks (`cmux-run`, `tern-run`). */
	readonly runLabel: string;
	/** The `page` facade in scope. */
	readonly page: object;
	/** The `browser` facade in scope. */
	readonly browser: object;
	/** Fatal renderer failure requiring close/reopen, when the backend tracks one. */
	readonly rendererFailure?: Error;
	/** The tab's JavaScript runtime (created once per tab). */
	ensureRuntime(session: SessionSnapshot): JsRuntime;
	/** Publish the active run to the facades. */
	setRunContext(context: InProcessRunContext): void;
	/** Forget finished run `context`; a later run's context stays (a run can end after its call gave up on it). */
	clearRunContext(context: InProcessRunContext): void;
	/** Dispose the tab's runtime, so a run that never settled stops holding this process's realm. */
	discardRuntime(): void;
}

/** Inputs of {@link callInProcessTab}. */
export interface CallInProcessOptions {
	/** Allowlisted tab helper or handle call chain (`action: "call"`). */
	chain: readonly TabCallStep[];
	/** The call's budget. */
	timeoutMs: number;
	/** Cancels the call. */
	signal?: AbortSignal;
	/** Session facts for the facades. */
	snapshot: SessionSnapshot;
}

/** Inputs of {@link runInProcessTab}. */
export interface RunInProcessOptions {
	/** The run's JavaScript body. */
	code: string;
	/** The run's budget. */
	timeoutMs: number;
	/** Cancels the run. */
	signal?: AbortSignal;
	/** The calling tool session (host tool calls). */
	session: ToolSession;
	/** Session facts for the facades. */
	snapshot: SessionSnapshot;
	/** Managed tab name, used in diagnostics when a run times out waiting for the shared JS realm. */
	tabName?: string;
}

interface ActiveRun {
	filename: string;
	floatingRejections: unknown[];
}

const RECENT_RUN_FILES_MAX = 256;
const activeRuns = new Map<string, ActiveRun>();
const recentRunFiles = new Set<string>();

function consumeRunRejection(reason: unknown): boolean {
	// In-process runs execute guest JS in the shared main-process realm
	// (TTS/STT/MCP and other subsystems live here too), so — like the eval
	// inline fallback — only a guest-file stack frame can safely attribute a
	// rejection. A stackless or non-run-stack reason is indistinguishable from a
	// subsystem failure and keeps the default fatal path; worker isolation is
	// the long-term fix.
	const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
	if (!stack) return false;

	let owner: ActiveRun | undefined;
	let ownerIndex = -1;
	for (const run of activeRuns.values()) {
		const index = stack.lastIndexOf(run.filename);
		if (index > ownerIndex) {
			ownerIndex = index;
			owner = run;
		}
	}
	if (owner) {
		owner.floatingRejections.push(reason);
		return true;
	}

	let recent: string | undefined;
	let recentIndex = -1;
	for (const filename of recentRunFiles) {
		const index = stack.lastIndexOf(filename);
		if (index > recentIndex) {
			recentIndex = index;
			recent = filename;
		}
	}
	if (!recent) return false;
	logger.warn("Unhandled rejection from a finished in-process browser run (missing await?)", {
		filename: recent,
		error: reason,
	});
	return true;
}

function rememberRunFile(filename: string): void {
	recentRunFiles.delete(filename);
	recentRunFiles.add(filename);
	if (recentRunFiles.size <= RECENT_RUN_FILES_MAX) return;
	const oldest = recentRunFiles.values().next().value;
	if (oldest !== undefined) recentRunFiles.delete(oldest);
}

postmortem.interceptUnhandledRejections(consumeRunRejection);

/**
 * Every in-process `tab.run` executes in this process's one realm, where only one `JsRuntime` may run at a time:
 * runs of different tabs (`Promise.all` over tabs, parallel subagents) take turns here instead of failing. Direct
 * helper calls (`callInProcessTab`) bypass `JsRuntime` and therefore never enter this queue.
 */
let runQueueTail: Promise<void> = Promise.resolve();
/** Set inside a run: a run its code starts (through a tool call) cannot wait for its own turn to end. */
const insideRun = new AsyncLocalStorage<true>();

interface ActiveRunHolder {
	tabName?: string;
	agentId?: string;
	startedAt: number;
}

/** The `tab.run` currently holding this process's shared `JsRuntime` realm, if any. */
let activeRunHolder: ActiveRunHolder | undefined;

/** Queue for a turn: `ready` settles when every earlier run has finished; call `release` when this one has. */
function queueRunTurn(): { ready: Promise<void>; release: () => void } {
	if (insideRun.getStore()) return { ready: Promise.resolve(), release: () => {} };
	const previous = runQueueTail;
	const turn = Promise.withResolvers<void>();
	runQueueTail = previous.then(() => turn.promise);
	return { ready: previous, release: () => turn.resolve() };
}

function formatQueueTimeoutMessage(
	tabName: string | undefined,
	timeoutMs: number,
	holder: ActiveRunHolder | undefined,
): string {
	const base = `Browser code execution timed out after ${timeoutMs}ms`;
	if (!holder) {
		return `${base} before starting while waiting for another in-process tab.run() to finish`;
	}
	const target = tabName ? ` on tab ${JSON.stringify(tabName)}` : "";
	const blockerTab = holder.tabName ? `tab ${JSON.stringify(holder.tabName)}` : "another tab";
	const blockerAgent = holder.agentId ? `, agent ${JSON.stringify(holder.agentId)}` : "";
	const elapsedSeconds = Math.max(0, Math.round((Date.now() - holder.startedAt) / 1000));
	return (
		`${base} before starting${target}: waited for an in-process tab.run() on ${blockerTab}` +
		` (running ${elapsedSeconds}s${blockerAgent}) to finish. ` +
		`Direct tab helper calls (tab.goto, tab.click, tab.evaluate, ...) do not wait on this queue.`
	);
}

interface InProcessBudget {
	deadline: number;
	signal: AbortSignal;
	cancelRejection: Promise<never>;
	endRun: () => void;
	dispose: () => void;
}

function createInProcessBudget(
	timeoutMs: number,
	outerSignal: AbortSignal | undefined,
	timeoutError: () => ToolError,
): InProcessBudget {
	const deadline = Date.now() + timeoutMs;
	const runAc = new AbortController();
	// A plain timer, not `AbortSignal.timeout`: under Bun that signal's timer may never fire while the run awaits a
	// promise that never settles (see `raceWithTimeout` in the tab supervisor), which would hold the tab busy.
	const timeoutAc = new AbortController();
	const timeoutTimer = setTimeout(() => timeoutAc.abort(), timeoutMs);
	const timeoutSignal = timeoutAc.signal;
	const signal = AbortSignal.any(
		outerSignal ? [timeoutSignal, outerSignal, runAc.signal] : [timeoutSignal, runAc.signal],
	);
	const runEndedError = postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended"));
	const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
	// If setup throws while `signal` is already aborted, `Promise.race` never attaches a handler to this promise;
	// keep its armed rejection from surfacing as an unhandled rejection — the postmortem-fatal path this guards.
	cancelRejection.catch(() => {});
	const onAbort = (): void => {
		if (timeoutSignal.aborted) {
			reject(timeoutError());
		} else {
			reject(
				signal.reason instanceof ToolAbortError
					? signal.reason
					: new ToolAbortError(undefined, { cause: signal.reason }),
			);
		}
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	const endRun = (): void => {
		runAc.abort(runEndedError);
	};
	return {
		deadline,
		signal,
		cancelRejection,
		endRun,
		dispose: () => {
			clearTimeout(timeoutTimer);
			signal.removeEventListener("abort", onAbort);
			endRun();
		},
	};
}

async function invokeMethod(target: object, method: string, args: unknown[], targetLabel: string): Promise<unknown> {
	const fn = Reflect.get(target, method, target);
	if (typeof fn !== "function") {
		throw new TypeError(`${targetLabel}.${method} is not a function`);
	}
	return await Reflect.apply(fn, target, args);
}

async function executeTabCall(runTab: InProcessRunTab, parsed: ParsedTabCall, signal: AbortSignal): Promise<unknown> {
	switch (parsed.kind) {
		case "value":
			return await invokeMethod(runTab, parsed.step.method, materializeTabCallArgs(parsed.step), "tab");
		case "presence":
			return (await invokeMethod(runTab, parsed.step.method, materializeTabCallArgs(parsed.step), "tab")) !== null;
		case "handle": {
			const handle = await invokeMethod(runTab, parsed.handle.method, materializeTabCallArgs(parsed.handle), "tab");
			if (!handle || typeof handle !== "object") {
				throw new TypeError(`tab.${parsed.handle.method}() did not return a handle`);
			}
			const boundHandle = bindRunFacade(handle, signal);
			return await invokeMethod(
				boundHandle,
				parsed.step.method,
				materializeTabCallArgs(parsed.step, !parsed.isFrame),
				`tab.${parsed.handle.method}()`,
			);
		}
	}
}

/**
 * Invoke an allowlisted helper call chain (`action: "call"`) directly on `tab`, without `JsRuntime` or the
 * process-wide `tab.run` queue. Concurrent helper calls on different tabs run in parallel even while another tab
 * holds the shared JS realm.
 */
export async function callInProcessTab(tab: InProcessRunTab, opts: CallInProcessOptions): Promise<RunResultOk> {
	const parsed = parseTabCall(opts.chain);
	if (tab.rendererFailure) throw tab.rendererFailure;
	const budget = createInProcessBudget(
		opts.timeoutMs,
		opts.signal,
		() => new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`),
	);
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const runContext: InProcessRunContext = {
		session: opts.snapshot,
		output,
		screenshots,
		signal: budget.signal,
		timeoutMs: opts.timeoutMs,
		deadline: budget.deadline,
	};
	tab.setRunContext(runContext);
	try {
		throwIfAborted(budget.signal);
		const runTab = bindRunFacade(tab, budget.signal);
		const executing = executeTabCall(runTab, parsed, budget.signal);
		// If `cancelRejection` wins (timeout or tab close), a later backend rejection must not escape unhandled.
		executing.catch(() => undefined);
		const returnValue = await Promise.race([executing, budget.cancelRejection]);
		return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
	} finally {
		budget.dispose();
		tab.clearRunContext(runContext);
	}
}

/** Run `opts.code` against `tab`'s facades in this process. */
export async function runInProcessTab(tab: InProcessRunTab, opts: RunInProcessOptions): Promise<RunResultOk> {
	let started = false;
	const budget = createInProcessBudget(
		opts.timeoutMs,
		opts.signal,
		() =>
			new ToolError(
				started
					? `Browser code execution timed out after ${opts.timeoutMs}ms`
					: formatQueueTimeoutMessage(opts.tabName, opts.timeoutMs, activeRunHolder),
			),
	);
	const { signal, cancelRejection } = budget;
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const runId = crypto.randomUUID();
	const filename = `${tab.runLabel}-${runId}.js`;
	const activeRun: ActiveRun = { filename, floatingRejections: [] };
	activeRuns.set(filename, activeRun);
	let runContext: InProcessRunContext | undefined;

	const rejectionOwner = {};
	const { promise: floatingFailure, reject: rejectFloatingFailure } = Promise.withResolvers<never>();
	floatingFailure.catch(() => {});
	let runActive = true;
	let hasFloatingFailure = false;
	const recordFloatingFailure = (reason: unknown): void => {
		if (hasFloatingFailure || postmortem.isExpectedCleanupError(reason)) return;
		const message = reason instanceof Error ? reason.message : String(reason);
		if (!runActive) {
			logger.warn("Unhandled rejection after browser run ended", { runId, error: message });
			return;
		}
		hasFloatingFailure = true;
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		rejectFloatingFailure(error);
	};
	const uninstallRejectionInterceptor = postmortem.interceptUnhandledRejections(reason => {
		if (!isBrowserRunOwnedRejection(reason, rejectionOwner, filename)) return false;
		recordFloatingFailure(reason);
		return true;
	});

	const turn = queueRunTurn();
	let holder: ActiveRunHolder | undefined;
	let prevHolder: ActiveRunHolder | undefined;
	try {
		// The wait for this run's turn counts against its budget; a cancel or timeout ends it.
		await Promise.race([turn.ready, cancelRejection]);
		started = true;
		holder = {
			tabName: opts.tabName,
			agentId: opts.session.getAgentId?.() ?? undefined,
			startedAt: Date.now(),
		};
		prevHolder = activeRunHolder;
		activeRunHolder = holder;
		const remainingMs = Math.max(1, budget.deadline - Date.now());
		runContext = {
			session: opts.snapshot,
			output,
			screenshots,
			signal,
			timeoutMs: remainingMs,
			deadline: budget.deadline,
		};
		tab.setRunContext(runContext);

		const runtime = tab.ensureRuntime(opts.snapshot);
		// setCwd is non-exclusive; setRunScope/run still assert same-realm ownership.
		// Keep both inside try so a concurrent in-process eval/browser run surfaces as
		// a rejected promise the supervisor can report, never an unhandled rejection.
		runtime.setCwd(opts.snapshot.cwd);
		const runTab = bindRunFacade(tab, signal, rejectionOwner, recordFloatingFailure);
		runtime.setRunScope({
			page: bindRunFacade(tab.page, signal, rejectionOwner, recordFloatingFailure),
			browser: bindRunFacade(tab.browser, signal, rejectionOwner, recordFloatingFailure),
			tab: runTab,
			assert: (cond: unknown, text?: string): void => {
				if (!cond) throw new ToolError(text ?? "Assertion failed");
			},
			wait: (msOrPredicate: number | (() => unknown), waitOpts?: WaitPredicateOptions): Promise<unknown> =>
				observeBrowserRunPromise(
					waitForRun(
						msOrPredicate,
						signal,
						typeof msOrPredicate === "number"
							? waitOpts
							: {
									timeout: resolvePredicateTimeout(remainingMs, waitOpts?.timeout),
									interval: waitOpts?.interval,
								},
					).catch(error => {
						throw markBrowserRunRejection(error, rejectionOwner);
					}),
					rejectionOwner,
					recordFloatingFailure,
				),
		});

		const hooks: RuntimeHooks = {
			onText: chunk => {
				throwIfAborted(signal);
				output.pushText(chunk);
				logger.debug(chunk.replace(/\n$/, ""));
			},
			onDisplay: displayed => {
				throwIfAborted(signal);
				output.pushDisplay(displayed);
			},
			callTool: (name, args) => {
				throwIfAborted(signal);
				return callSessionTool(name, args, { session: opts.session, signal });
			},
		};
		// Like the inline worker fallback, in-process runs execute user JS here: awaited
		// backend/tool calls observe this abort signal, but a synchronous infinite loop
		// cannot be interrupted.
		let returnValue: unknown;
		let runError: unknown;
		let runFailed = false;
		let runSettled = false;
		try {
			returnValue = await withBrowserPromiseCombinatorTracking(rejectionOwner, recordFloatingFailure, async () => {
				const running = insideRun.run(true, () =>
					runtime.run(opts.code, filename, hooks, { runId, cwd: opts.snapshot.cwd }),
				);
				running.then(
					() => {
						runSettled = true;
					},
					() => {
						runSettled = true;
					},
				);
				return await Promise.race([running, cancelRejection, floatingFailure]);
			});
		} catch (error) {
			runFailed = true;
			runError = error;
		}
		// Code still running past its cancel or timeout holds the realm: drop its runtime so other tabs can run.
		if (!runSettled) tab.discardRuntime();
		budget.endRun();
		// Let rejection callbacks run while this run can still own guest-created promises.
		await Bun.sleep(0);
		if (hasFloatingFailure && !runFailed) await floatingFailure;
		if (runFailed) {
			for (const reason of activeRun.floatingRejections) {
				logger.warn("Unhandled rejection accompanied a failed in-process browser run", { filename, error: reason });
			}
			throw runError;
		}
		if (activeRun.floatingRejections.length > 0) {
			const messages = activeRun.floatingRejections.map(reason =>
				reason instanceof Error ? reason.message : String(reason),
			);
			throw new ToolError(`Unhandled rejection (missing await?): ${messages.join("\n[unhandled rejection] ")}`, {
				rejections: activeRun.floatingRejections,
			});
		}
		return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
	} finally {
		if (holder && activeRunHolder === holder) activeRunHolder = prevHolder;
		turn.release();
		runActive = false;
		uninstallRejectionInterceptor();
		budget.dispose();
		activeRuns.delete(filename);
		rememberRunFile(filename);
		if (runContext) tab.clearRunContext(runContext);
	}
}
