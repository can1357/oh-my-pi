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
import { sessionUrlRouter } from "../../internal-urls/context";
import type { InternalUrlRouter } from "../../internal-urls/router";
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
import type { RunResultOk, ScreenshotResult, SessionSnapshot } from "./tab-protocol";

/** What a tab facade may use while one run is active. */
export interface InProcessRunContext {
	/** The session the run belongs to. */
	session: SessionSnapshot;
	/** The calling session's URL router: a URL of a scheme it handles is refused as a file path. */
	router: InternalUrlRouter;
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
	/** The tab's JavaScript runtime (created once per tab). */
	ensureRuntime(session: SessionSnapshot): JsRuntime;
	/** Publish the active run to the facades. */
	setRunContext(context: InProcessRunContext): void;
	/** Forget finished run `context`; a later run's context stays (a run can end after its call gave up on it). */
	clearRunContext(context: InProcessRunContext): void;
	/** Dispose the tab's runtime, so a run that never settled stops holding this process's realm. */
	discardRuntime(): void;
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
 * Every in-process run executes in this process's one realm, where only one `JsRuntime` may run at a time: runs of
 * different tabs (`Promise.all` over tabs, parallel subagents) take turns here instead of failing. The tail settles
 * once the latest queued run has had its turn.
 */
let runQueueTail: Promise<void> = Promise.resolve();
/** Set inside a run: a run its code starts (through a tool call) cannot wait for its own turn to end. */
const insideRun = new AsyncLocalStorage<true>();

/** Queue for a turn: `ready` settles when every earlier run has finished; call `release` when this one has. */
function queueRunTurn(): { ready: Promise<void>; release: () => void } {
	if (insideRun.getStore()) return { ready: Promise.resolve(), release: () => {} };
	const previous = runQueueTail;
	const turn = Promise.withResolvers<void>();
	runQueueTail = previous.then(() => turn.promise);
	return { ready: previous, release: () => turn.resolve() };
}

/** Run `opts.code` against `tab`'s facades in this process. */
export async function runInProcessTab(tab: InProcessRunTab, opts: RunInProcessOptions): Promise<RunResultOk> {
	const deadline = Date.now() + opts.timeoutMs;
	const runAc = new AbortController();
	// A plain timer, not `AbortSignal.timeout`: under Bun that signal's timer may never fire while the run awaits a
	// promise that never settles (see `raceWithTimeout` in the tab supervisor), which would hold the tab busy.
	const timeoutAc = new AbortController();
	const timeoutTimer = setTimeout(() => timeoutAc.abort(), opts.timeoutMs);
	const timeoutSignal = timeoutAc.signal;
	const signal = AbortSignal.any(
		opts.signal ? [timeoutSignal, opts.signal, runAc.signal] : [timeoutSignal, runAc.signal],
	);
	const runEndedError = postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended"));
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const runId = crypto.randomUUID();
	const filename = `${tab.runLabel}-${runId}.js`;
	const activeRun: ActiveRun = { filename, floatingRejections: [] };
	activeRuns.set(filename, activeRun);
	const runContext: InProcessRunContext = {
		session: opts.snapshot,
		router: sessionUrlRouter(opts.session),
		output,
		screenshots,
		signal,
		timeoutMs: opts.timeoutMs,
		deadline,
	};
	tab.setRunContext(runContext);

	const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
	// If the synchronous setup below throws (same-realm ownership conflict)
	// while `signal` is already aborted, `Promise.race` never attaches a
	// handler to this promise; keep its armed rejection from surfacing as an
	// unhandled rejection — the postmortem-fatal path this run guards against.
	cancelRejection.catch(() => {});
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
	const onAbort = (): void => {
		if (timeoutSignal.aborted) {
			reject(new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`));
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

	const turn = queueRunTurn();
	try {
		// The wait for this run's turn counts against its budget; a cancel or timeout ends it.
		await Promise.race([turn.ready, cancelRejection]);
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
									timeout: resolvePredicateTimeout(opts.timeoutMs, waitOpts?.timeout),
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
		runAc.abort(runEndedError);
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
		turn.release();
		clearTimeout(timeoutTimer);
		runActive = false;
		uninstallRejectionInterceptor();
		signal.removeEventListener("abort", onAbort);
		runAc.abort(runEndedError);
		activeRuns.delete(filename);
		rememberRunFile(filename);
		tab.clearRunContext(runContext);
	}
}
