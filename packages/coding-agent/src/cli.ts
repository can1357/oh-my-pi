#!/usr/bin/env bun
// Strip macOS malloc-stack-logging vars in the parent entrypoint, before any
// subprocess/worker spawn. libmalloc reads MallocStackLogging /
// MallocStackLoggingNoCompact during malloc bootstrap (pre-main) in every child
// and warns when they're present but set to "off"; a child cannot suppress its
// own warning, so the only fix is to keep them out of the inherited env here.
// (They must be unset, not set — presence is the trigger.)
try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {}

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { parentPort } from "node:worker_threads";
import type { CliConfig, CommandMetadata } from "@oh-my-pi/pi-utils/cli";
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	resolveProfileEnv,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { fatal, interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";
import { setProcessName } from "@oh-my-pi/pi-utils/process-name";
import { declareWorkerHostEntry, installWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { BLOB_BROKER_WORKER_ARG } from "./blob-broker/protocol";
import { installProfileAlias, resolveProfileAliasCommandFromProcess } from "./cli/profile-alias";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import { startJsEvalProcess } from "./eval/js/process-entry";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "./eval/js/worker-protocol";
import { DAEMON_BROKER_WORKER_ARG } from "./launch/protocol";
import { TERMINAL_OUTPUT_WORKER_ARG } from "./launch/terminal-output-worker-protocol";
import { LSP_MUX_WORKER_ARG } from "./lsp/mux/protocol";
import { STATS_ACTIVITY_WORKER_ARG } from "./stats/activity-protocol";
import rootLicense from "./tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import thirdPartyNotices from "./tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { COMPUTER_WORKER_ARG } from "./tools/computer/protocol";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

setProcessName(APP_NAME);

// `Bun.build`-API compiled Windows executables report `import.meta.main ===
// false`: the standalone loader keys the entry module with native backslashes
// (`B:\~BUN\root\cli.js`) but registers the main path with forward slashes
// (`B:/~BUN/root/cli.js`), so Bun's internal match fails. `bun build --compile`
// CLI builds are unaffected. A compiled binary's entry module is by definition
// the process entry, so the define-folded PI_COMPILED marker stands in.
const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

function formatLicenseOutput(): string {
	return `OMP License and Third-Party Notices\n\n${rootLicense.trimEnd()}\n\n${thirdPartyNotices.trimEnd()}\n`;
}

// Worker-host entry declaration (Worker threads and worker subprocesses
// re-enter `Bun.main` with a hidden argv selector instead of loading separate
// worker entrypoints) happens inside `runCli` after profile bootstrap:
// `@oh-my-pi/pi-utils/env` eagerly loads `.env` from the agent directory at
// import time, so it must not be imported before `setProfile` runs.

async function showHelp(config: CliConfig<CommandMetadata>): Promise<void> {
	// Root help historically loads the selected profile's environment. The
	// lazily loaded help module imports it statically after profile bootstrap.
	const [{ renderRootHelp }, { getExtraHelpText }] = await Promise.all([
		import("@oh-my-pi/pi-utils/cli"),
		import("./cli/help-extra"),
	]);
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}
/**
 * Smoke-test entry. Spawns bundled workers, serves the stats dashboard once,
 * pings everything, then exits.
 *
 * Purpose: catch the silent worker-load and bundled-asset regressions that hit
 * compiled binaries and the npm CLI bundle. Version/help paths do not spawn
 * worker modules or serve dashboard assets on a fresh install, so this probe is
 * the minimal end-to-end test that proves those distribution-only paths work.
 * Wired into `scripts/install-tests/run-ci.sh` so binary / source-link /
 * tarball installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker, startServer } = await import("@oh-my-pi/omp-stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	const { smokeTestSttWorker } = await import("./stt/asr-client");
	const { smokeTestTtsWorker } = await import("./tts/tts-client");
	const { smokeTestMnemopiEmbedWorker } = await import("./mnemopi/embed-client");
	const { smokeTestStatsActivityWorker } = await import("./stats/activity-client");
	const { smokeTestJsEvalWorker } = await import("./eval/js/context-manager");
	// Other smoke dependencies stay lazy so normal CLI startup does not load their worker clients.
	const { smokeTestDaemonBroker } = await import("./launch/client");
	const { smokeTestLspMux } = await import("./lsp/mux/daemon");
	const { smokeTestBlobBroker } = await import("./blob-broker/daemon");
	const { smokeTestTerminalOutputWorker } = await import("./launch/terminal-output-worker-client");
	await smokeTestSyncWorker();
	await smokeTestStatsActivityWorker();

	const statsServer = await startServer(0);
	try {
		const response = await fetch(`http://127.0.0.1:${statsServer.port}/`);
		if (!response.ok) throw new Error(`stats dashboard smoke failed: HTTP ${response.status}`);
		const html = await response.text();
		if (!html.includes('<div id="root"></div>') || !html.includes("index.js")) {
			throw new Error("stats dashboard smoke failed: dashboard HTML was not served");
		}
	} finally {
		statsServer.stop();
	}

	await smokeTestTinyTitleWorker();
	await smokeTestSttWorker();
	await smokeTestJsEvalWorker();
	const { smokeTestComputerWorker } = await import("./tools/computer/supervisor");
	await smokeTestComputerWorker();
	await smokeTestTtsWorker();
	await smokeTestMnemopiEmbedWorker();
	await smokeTestDaemonBroker();
	await smokeTestLspMux();
	await smokeTestBlobBroker();
	await smokeTestTerminalOutputWorker();
	process.stdout.write("smoke-test: ok\n");
}

const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";
const STT_WORKER_ARG = "__omp_worker_stt";
const TTS_WORKER_ARG = "__omp_worker_tts";
const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		await runTinyWorker();
		return true;
	}
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned during
		// this *async* dynamic import. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// Worker-thread entries using `parentPort` need the same sync-prefix
		// buffering; the computer/tab/eval cases install that inbox below.
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		await import("@oh-my-pi/omp-stats/sync-worker");
		const handler = scope.onmessage;
		if (handler && handler !== buffer) {
			for (const event of pending) handler.call(scope, event);
		}
		return true;
	}
	// Bun flushes messages the parent posted before spawn once this entry's
	// top-level evaluation completes. Install a buffering inbox synchronously
	// before binding the selected worker's real handler so the parent's
	// synchronous `init` survives. The dynamically imported tab/eval modules
	// consume the same inbox after their module evaluation begins.
	if (arg === TAB_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === COMPUTER_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		const { startComputerWorker } = await import("./tools/computer/worker-entry");
		startComputerWorker();
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG) {
		// The bootstrap-safe interceptor seam is linked statically so this selector
		// cannot load profile-scoped environment state after dispatch has begun.
		// The JS evaluator forwards user-controlled payloads (tool-call args,
		// display outputs); a non-serializable one must fail that cell, not
		// SIGKILL the kernel and erase the eval session's state.
		await runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(
			transport => startJsEvalProcess(transport, interceptUnhandledRejections),
			{ rethrowConnectedSendErrors: true },
		);
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		const { startSttWorker } = await import("./stt/asr-worker");
		await runIpcSubprocessWorker(startSttWorker);
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		const { startTtsWorker } = await import("./tts/tts-worker");
		await runIpcSubprocessWorker(startTtsWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		const { startMnemopiEmbedWorker } = await import("./mnemopi/embed-worker");
		await runIpcSubprocessWorker(startMnemopiEmbedWorker);
		return true;
	}
	if (arg === STATS_ACTIVITY_WORKER_ARG) {
		const { startStatsActivityWorker } = await import("./stats/activity-worker");
		await runIpcSubprocessWorker(startStatsActivityWorker);
		return true;
	}
	if (arg === TERMINAL_OUTPUT_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		// This selector is the isolation boundary; a static import would evaluate xterm in normal CLI startup.
		await import("./launch/terminal-output-worker");
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonBrokerFromEnvironment } = await import("./launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	if (arg === LSP_MUX_WORKER_ARG) {
		const { startLspMuxFromEnvironment } = await import("./lsp/mux/server");
		await startLspMuxFromEnvironment();
		return true;
	}
	if (arg === BLOB_BROKER_WORKER_ARG) {
		const { startBlobBrokerFromEnvironment } = await import("./blob-broker/server");
		await startBlobBrokerFromEnvironment();
		return true;
	}
	return false;
}

/**
 * Boot a subprocess-isolated transformers.js worker over the parent's IPC
 * channel and block until the parent disconnects. The tiny-model, STT, and TTS
 * workers each run `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) in a child address space because its NAPI
 * finalizer segfaults Bun on shutdown (issue #1606); the parent `SIGKILL`s the
 * child so that finalizer never runs in either process. This wires `process`
 * IPC to the worker's typed transport, keeps the event loop alive while the
 * worker is idle, and hard-kills the process on parent `disconnect`.
 */
async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: {
		/**
		 * Rethrow send failures while the IPC channel is still connected instead
		 * of shutting down. A connected-channel failure means this particular
		 * message could not be serialized (e.g. a JS eval cell passed a function
		 * into tool args, a DataCloneError under advanced serialization) — the
		 * caller must see that error, exactly as Worker `postMessage` would
		 * deliver it, rather than losing the whole worker and its state.
		 * Channel-gone failures still shut down.
		 */
		rethrowConnectedSendErrors?: boolean;
	},
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	// `process.send` only exists when spawned with an IPC channel; the parent
	// always spawns us that way. If it's missing, the parent vanished and
	// there's no one to talk to.
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical with
	// the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

/**
 * Hidden subcommand that boots the ONNX tiny-model worker for one model: a
 * detached process owning that model's socket (`OMP_TINY_WORKER_SOCKET`),
 * shared by every omp process on the machine and exiting on its own when
 * idle. It exists so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) never runs in an omp address space — its NAPI
 * finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyWorkerFromEnvironment } = await import("./tiny/worker");
	await startTinyWorkerFromEnvironment();
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	let resolvedArgv = argv;
	try {
		const extracted = extractProfileFlags(resolvedArgv);
		resolvedArgv = extracted.argv;
		if (extracted.profile !== undefined) {
			setProfile(extracted.profile);
		} else {
			// No explicit --profile: activate any OMP_PROFILE/PI_PROFILE inherited
			// from the environment. Module-load resolution deliberately swallows an
			// invalid value to avoid an uncaught throw before this try/catch is in
			// scope (see `readProfileFromEnvSafe` in dirs.ts), and callers may set
			// OMP_PROFILE after importing this module (profile aliases/tests). Surfacing
			// validation here turns `OMP_PROFILE=.. omp --version` into a clean error;
			// calling setProfile keeps every later path helper on the env-selected
			// profile instead of the default agent directory.
			setProfile(resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
		}
		if (extracted.aliasName !== undefined) {
			const profile = extracted.profile ?? getActiveProfile();
			if (!profile) {
				throw new Error("--alias requires --profile <name> or OMP_PROFILE");
			}
			const result = await installProfileAlias({
				profile,
				aliasName: extracted.aliasName,
				command: resolveProfileAliasCommandFromProcess(),
			});
			process.stdout.write(
				`Created ${result.aliasName} for profile ${result.profile} in ${result.configPath}\n` +
					`Restart your shell or run: ${result.reloadedWith}\n` +
					`Then use: ${result.aliasName} update, ${result.aliasName} --version, or ${result.aliasName}\n`,
			);
			return;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
		return;
	}

	// Worker-thread entry dispatch must run before the first `await`: the
	// stats sync worker's buffering onmessage handler is installed in the
	// synchronous prefix of `runWorkerEntrypoint`, and Bun flushes the
	// worker's parked initial messages as soon as the entry module's
	// top-level evaluation finishes.
	if (isWorkerHostSelector(resolvedArgv[0])) {
		const dispatched = await runWorkerEntrypoint(resolvedArgv[0]);
		if (!dispatched) {
			process.stderr.write(`Error: unknown worker selector: ${resolvedArgv[0]}\n`);
			process.exitCode = 1;
		}
		return;
	}

	// Declare this module as the worker-host entry now that the active profile
	// is resolved. The worker-host module is side-effect-free; importing
	// `@oh-my-pi/pi-utils/env` here would snapshot the wrong agent `.env`.
	// Gated on `isProcessEntry`: only the real CLI process entry is a valid
	// worker host. Worker-thread re-entry already returned above at the
	// `__omp_worker_` dispatch, and importers (`runCli` in profile-CLI tests,
	// SDK embedding) have `import.meta.main === false` — declaring there would
	// poison `workerHostEntry()` for the whole test process, forcing eval/stats/
	// browser workers onto the same-realm inline fallback.
	if (isProcessEntry) declareWorkerHostEntry();

	// `PI_PROXY` must reach the bare global `fetch` before any provider call:
	// OAuth refresh/login and usage probes never pass through
	// `wrapFetchForProxy`, so without this they bypass the proxy and fail
	// wherever the provider blocks the caller's region. Dynamically imported
	// like every other dependency in this entry module: a static `pi-ai` import
	// would load the provider graph before profile bootstrap and on paths
	// (`--version`, worker selectors) that never touch the network.
	const { installGlobalProxyFetch } = await import("@oh-my-pi/pi-ai/utils/proxy");
	installGlobalProxyFetch();

	if (resolvedArgv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	if (resolvedArgv[0] === "--license") {
		process.stdout.write(formatLicenseOutput());
		return;
	}
	let stopStartupComposer: (() => void) | undefined;
	if (
		!process.env.PI_TIMING &&
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true &&
		(resolvedArgv.length === 0 || (resolvedArgv.length === 1 && resolvedArgv[0] === "--no-session"))
	) {
		// Intentional exception to the static-import convention: this latency boundary
		// keeps the TUI graph out of worker, subcommand, help, and version launches.
		// Loading it statically would erase the measured cold-start improvement.
		const { beginStartupComposer, stopPendingStartupComposer } = await import("./modes/startup-composer");
		beginStartupComposer({ version: VERSION });
		stopStartupComposer = stopPendingStartupComposer;
	}

	try {
		const [{ run }, { commands, resolveCliArgv }] = await Promise.all([
			import("@oh-my-pi/pi-utils/cli"),
			import("./cli-commands"),
		]);
		// --help and --version are handled by run() directly; --license returned above.
		// Everything else that isn't a known subcommand routes to "launch".
		const resolved = resolveCliArgv(resolvedArgv);
		if ("error" in resolved) {
			process.stderr.write(`error: ${resolved.error}\n`);
			process.exitCode = 1;
			return;
		}
		await run({ bin: APP_NAME, version: VERSION, argv: resolved.argv, commands, metadataHelp: showHelp });
	} finally {
		stopStartupComposer?.();
	}
}

// Floating call instead of top-level await: TLA forces `--bytecode` (CJS
// lowering) builds to fail, and the entrypoint needs nothing after this.
// The catch mirrors what an unhandled TLA rejection produced: error dump to
// stderr, exit code 1. Success paths resolve without touching the exit code.
// Guarded so importing `runCli` (profile CLI tests, SDK embedding) does not
// launch the agent as a side effect. Worker threads re-enter this module as
// their entry with `import.meta.main === false`, so the worker-host dispatch
// is admitted via `!Bun.isMainThread`.
if (isProcessEntry || !Bun.isMainThread) {
	runCli(process.argv.slice(2)).catch(fatal);
}
