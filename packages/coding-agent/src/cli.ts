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
import type * as WorkerThreads from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import type { CliConfig, CommandMetadata } from "@oh-my-pi/pi-utils/cli";
import type * as Postmortem from "@oh-my-pi/pi-utils/postmortem";
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	resolveProfileEnv,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";

import { materializeDatalessFiles } from "@oh-my-pi/pi-utils/dataless-files";
import { raiseInteractiveQos } from "@oh-my-pi/pi-utils/process-qos";
import {
	declareWorkerHostEntry,
	installWorkerInbox,
	isWorkerHostSelector,
	SHELL_PROCESS_SELECTOR,
} from "@oh-my-pi/pi-utils/worker-host";
import { installSqliteLockShim } from "@oh-my-pi/pi-natives/sqlite-locks";
import { isNativeShell, runNativeShell } from "./cli/native-shell";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import {
	AUTO_UPDATE_WORKER_ARG,
	COMPUTER_WORKER_ARG,
	JS_EVAL_STDIO_WORKER_ARG,
	PARENT_WATCHDOG_WORKER_ARG,
	SANDBOX_HOST_ARG,
	STATS_ACTIVITY_WORKER_ARG,
	SUBAGENT_WORKER_ARG,
	TRANSCRIPT_INDEX_WORKER_ARG,
} from "./cli/worker-selectors";
import { DAEMON_WORKER_ARG } from "./daemon/protocol";
import { MNEMOPI_EMBED_WORKER_ARG } from "./mnemopi/embed-protocol";
import type * as JsProcessEntry from "./eval/js/process-entry";
import type * as JsStdioTransport from "./eval/js/stdio-transport";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "./eval/js/worker-protocol";
import { startParentWatchdog } from "./subprocess/parent-watchdog";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

// On Windows `process.title` is the shared console title, not a process name
// (see `setProcessName`): every omp child would retitle the pane's tab.
if (process.platform !== "win32") {
	try {
		process.title = APP_NAME;
	} catch {}
}

// `Bun.build`-API compiled Windows executables report `import.meta.main ===
// false`: the standalone loader keys the entry module with native backslashes
// (`B:\~BUN\root\cli.js`) but registers the main path with forward slashes
// (`B:/~BUN/root/cli.js`), so Bun's internal match fails. `bun build --compile`
// CLI builds are unaffected. A compiled binary's entry module is by definition
// the process entry, so the define-folded PI_COMPILED marker stands in.
const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

/**
 * Worker inboxes must attach before this entry module reaches its first await,
 * so this branch uses Bun's synchronous CommonJS bridge. Ordinary CLI startup
 * never evaluates `node:worker_threads`.
 */
function getWorkerParentPort(): MessagePort | null {
	const workerThreads: typeof WorkerThreads = require("node:worker_threads");
	return workerThreads.parentPort;
}

/**
 * Launch flags that only switch off discovery or persistence. An argv made of
 * these still enters interactive mode, so the speculative first frame is
 * valid; anything else (subcommands, `-p`, model/session selectors) skips it.
 */
const PREPAINT_SAFE_FLAGS: Record<string, true> = {
	"--no-session": true,
	"--no-extensions": true,
	"--no-skills": true,
	"--no-rules": true,
	"--no-context-files": true,
	"--no-tools": true,
	"--no-judge": true,
	"--no-spotlight": true,
	"--offline": true,
	"--no-lsp": true,
	"--no-title": true,
	"--no-prewalk": true,
	"--no-pty": true,
	// `-e`/`--extension` only registers a local extension path; the extension
	// loads later, so the speculative first frame stays valid (issue #20158).
	// These take a value, so they are handled by `isPrepaintSafeArgv`.
};

/**
 * Flags in `PREPAINT_SAFE_FLAGS` whose single value follows as the next argv
 * token. `--extension=value` needs no special handling: it is one token that
 * matches the flag directly.
 */
const PREPAINT_SAFE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-e", "--extension"]);

/** True when every token in `argv` still yields a valid speculative first frame. */
export function isPrepaintSafeArgv(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (PREPAINT_SAFE_VALUE_FLAGS.has(arg)) {
			// The path value belongs to the flag; skip it. A missing value is
			// a usage error the regular parse reports later.
			index++;
			continue;
		}
		if (PREPAINT_SAFE_VALUE_FLAGS.has(arg.split("=", 1)[0]!)) continue;
		if (PREPAINT_SAFE_FLAGS[arg] !== true) return false;
	}
	return true;
}

/** Complete the OS-visible process-name setup after speculative first paint. */
async function setFullProcessName(): Promise<void> {
	// Latency boundary: bun:ffi/node:os are unnecessary before the first frame.
	const { setProcessName } = await import("@oh-my-pi/pi-utils/process-name");
	setProcessName(APP_NAME);
}

/** Install PI_PROXY handling before any command implementation can make a provider request. */
async function installNetworkBootstrap(): Promise<void> {
	// Latency boundary: proxy socket/error modules are unnecessary before the first frame.
	const { installGlobalProxyFetch } = await import("@oh-my-pi/pi-ai/utils/proxy");
	installGlobalProxyFetch();
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
 * Smoke-test entry. Exercises bundled workers and serves the stats dashboard once.
 *
 * Purpose: catch the silent worker-load and bundled-asset regressions that hit
 * compiled binaries and the npm CLI bundle. Version/help paths do not spawn
 * worker modules or serve dashboard assets on a fresh install, so this probe is
 * the minimal end-to-end test that proves those distribution-only paths work.
 * Wired into `scripts/install-tests/run-ci.sh` so binary / source-link /
 * tarball installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSpotlightWorker, smokeTestSyncWorker, startServer } = await import("@oh-my-pi/omp-stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	const { smokeTestSttWorker } = await import("./stt/asr-client");
	const { smokeTestTtsWorker } = await import("./tts/tts-client");
	const { smokeTestMnemopiEmbedWorker } = await import("./mnemopi/embed-client");
	const { smokeTestStatsActivityWorker } = await import("./stats/activity-client");
	const { smokeTestTranscriptIndexWorker } = await import("./session/transcript-index-client");
	const { smokeTestJsEvalWorker } = await import("./eval/js/context-manager");
	// Other smoke dependencies stay lazy so normal CLI startup does not load their worker clients.
	const { isolateDaemonForSmokeTest, smokeTestDaemon } = await import("./daemon/client");
	const { smokeTestSubagentWorker } = await import("./thread/subagent-worker");
	const { smokeTestSandboxHost } = await import("./sandbox/shell-client");
	// Every smoke that reaches the daemon must start this build's own, never the user's live one.
	const cleanupDaemon = await isolateDaemonForSmokeTest();
	try {
		await smokeTestSyncWorker();
		await smokeTestSpotlightWorker();
		await smokeTestStatsActivityWorker();
		await smokeTestTranscriptIndexWorker();

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
		await smokeTestDaemon();
		await smokeTestSubagentWorker();
		await smokeTestSandboxHost();
	} finally {
		await cleanupDaemon();
	}
	process.stdout.write("smoke-test: ok\n");
}

const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
const STATS_SPOTLIGHT_WORKER_ARG = "__omp_worker_stats_spotlight";
const TAB_WORKER_ARG = "__omp_worker_tab";
const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";
const STT_WORKER_ARG = "__omp_worker_stt";
const TTS_WORKER_ARG = "__omp_worker_tts";

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		await runTinyWorker();
		return true;
	}
	if (arg === STATS_SYNC_WORKER_ARG || arg === STATS_SPOTLIGHT_WORKER_ARG) {
		// The stats workers handle messages via `self.onmessage`, assigned during
		// this *async* dynamic import. Bun flushes the worker's initial message
		// buffer when the entry module's top-level evaluation finishes — before
		// this dispatch completes — so anything the parent posted right after
		// spawning (the smoke ping, the first parse or build request) would be dropped.
		// Park early events and replay them once the module's handler is live.
		// Worker-thread entries using `parentPort` need the same sync-prefix
		// buffering; the computer/tab/eval cases install that inbox below.
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		if (arg === STATS_SYNC_WORKER_ARG) await import("@oh-my-pi/omp-stats/sync-worker");
		else await import("@oh-my-pi/omp-stats/spotlight-worker");
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
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === COMPUTER_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		const { startComputerWorker } = await import("./tools/computer/worker-entry");
		startComputerWorker();
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return true;
	}
	if (arg === SUBAGENT_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./thread/subagent-worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG || arg === JS_EVAL_STDIO_WORKER_ARG) {
		// These selectors are the synchronous bootstrap boundary: keep the evaluator runtime and
		// postmortem/inspector graph out of ordinary startup without putting an await ahead of the
		// subprocess message handler.
		const startEvaluator = (transport: Parameters<typeof JsProcessEntry.startJsEvalProcess>[0]): void => {
			const { startJsEvalProcess }: typeof JsProcessEntry = require("./eval/js/process-entry");
			// The .js subpath is the package's unconditional export for synchronous loading.
			const { interceptUnhandledRejections }: typeof Postmortem = require("@oh-my-pi/pi-utils/postmortem.js");
			startJsEvalProcess(transport, interceptUnhandledRejections);
		};
		if (arg === JS_EVAL_PROCESS_ARG) {
			// The JS evaluator forwards user-controlled payloads (tool-call args,
			// display outputs); a non-serializable one must fail that cell, not
			// SIGKILL the kernel and erase the eval session's state.
			await runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(startEvaluator, {
				rethrowConnectedSendErrors: true,
			});
			return true;
		}
		// JS evaluator answering in structured-clone frames on stdout. With an IPC channel (the
		// unsandboxed Windows evaluator, or the child of the relay below) it is the evaluator and reads
		// messages over IPC. Without one (inside the sandbox, where IPC cannot cross) this process only
		// relays stdin frames to an evaluator child it starts with stdin closed, and never calls the
		// `start` callback, so the evaluator module graph loads only in the evaluator, still
		// synchronously ahead of its IPC message handler like the selector above.
		const { runStdioSubprocessWorker }: typeof JsStdioTransport = require("./eval/js/stdio-transport");
		await runStdioSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(startEvaluator);
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		const { runSttWorker } = await import("./stt/asr-worker");
		await runSttWorker();
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		const { runTtsWorker } = await import("./tts/tts-worker");
		await runTtsWorker();
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		const { startMnemopiEmbedWorker } = await import("./mnemopi/embed-worker");
		await startMnemopiEmbedWorker();
		return true;
	}
	if (arg === STATS_ACTIVITY_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./stats/activity-worker");
		return true;
	}
	if (arg === TRANSCRIPT_INDEX_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./session/transcript-index-worker");
		return true;
	}
	if (arg === PARENT_WATCHDOG_WORKER_ARG) {
		const parentPort = getWorkerParentPort();
		if (parentPort) installWorkerInbox(parentPort);
		await import("./subprocess/parent-watchdog-worker");
		return true;
	}
	if (arg === DAEMON_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonFromEnvironment } = await import("./daemon/server");
		await startDaemonFromEnvironment();
		return true;
	}
	if (arg === AUTO_UPDATE_WORKER_ARG) {
		// Selector boundary keeps the updater graph out of ordinary startup. The worker
		// downloads releases, so it needs the PI_PROXY handling ordinary commands get.
		await installNetworkBootstrap();
		const { runAutoUpdateWorker } = await import("./cli/auto-update");
		await runAutoUpdateWorker();
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
 * worker is idle, and hard-kills the process on parent `disconnect` or — via
 * the off-main-thread {@link startParentWatchdog} — parent exit.
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
	if (!ipcSend()) {
		// Intentional fall-through: shutdown() only resolves the promise;
		// the await + SIGKILL tail below is what actually exits.
		shutdown();
	}
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
	const initialParentPid = process.ppid;
	if (process.platform === "win32" && initialParentPid <= 0) {
		shutdown();
	} else if (initialParentPid > 0) {
		startParentWatchdog(initialParentPid);
	}
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
 * Hidden subcommand that boots the ONNX tiny-model worker for one model over
 * stdin/stdout; the daemon's `infer` units host it, shared by every omp
 * process on the machine. It exists so `onnxruntime-node` (loaded transitively by
 * `@huggingface/transformers`) never runs in an omp address space — its NAPI
 * finalizer segfaults Bun on Windows (issue #1606).
 */
async function runTinyWorker(): Promise<void> {
	const { startTinyWorkerFromEnvironment } = await import("./tiny/worker");
	await startTinyWorkerFromEnvironment();
}

/** Resolved top-level command name (never its arguments), for the unsettled-entry report. */
let runningCommand: string | undefined;

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	// `omp zsh|bash|sh [args...]`: the whole argv belongs to the shell (`--help`,
	// `--profile`, `-c` included), so it dispatches before profile bootstrap,
	// prepaint, network setup and the command table.
	if (isNativeShell(argv[0])) {
		await runNativeShell(argv);
	}
	// A shell process (a named service, a pty command): the argv after the
	// selector is its own, its command's flags included, so it dispatches
	// before anything reads flags out of it.
	if (argv[0] === SHELL_PROCESS_SELECTOR) {
		// Command boundary: only shell processes load the engine entry here.
		const { runShellProcess } = await import("./exec/shell-process-worker");
		await runShellProcess(argv.slice(1));
	}
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
			// Command boundary: shell/path setup is used only by --alias.
			const { installProfileAlias, resolveProfileAliasCommandFromProcess } = await import("./cli/profile-alias");
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

	const workerSelector = resolvedArgv[0];
	const isWorker = isWorkerHostSelector(workerSelector);
	// A worker thread re-entering the CLI still hosts nested workers, even
	// though Bun reports import.meta.main as false. SDK importers are not hosts.
	if (isProcessEntry || (!Bun.isMainThread && isWorker)) declareWorkerHostEntry();

	if (resolvedArgv[0] === SANDBOX_HOST_ARG) {
		// The sandbox host's stdout carries its JSONL protocol only. Rebind every JS-level
		// stdout writer to stderr before the host graph (and the native addon) loads; the host
		// writes protocol lines through its own `Bun.stdout` writer.
		process.stdout.write = process.stderr.write.bind(process.stderr);
		console.log = console.error;
		console.info = console.error;
		console.debug = console.error;
		console.trace = console.error;
		const { runSandboxHost } = await import("./sandbox/host");
		await runSandboxHost();
		return;
	}

	// Worker-thread entry dispatch must run before the first `await`: the
	// stats sync worker's buffering onmessage handler is installed in the
	// synchronous prefix of `runWorkerEntrypoint`, and Bun flushes the
	// worker's parked initial messages as soon as the entry module's
	// top-level evaluation finishes.
	if (isWorker) {
		// Invoke dispatch first so its inbox is installed before asynchronous
		// process-name setup yields; neither dependency belongs in prepaint.
		const [dispatched] = await Promise.all([runWorkerEntrypoint(workerSelector), setFullProcessName()]);
		if (!dispatched) {
			process.stderr.write(`Error: unknown worker selector: ${workerSelector}\n`);
			process.exitCode = 1;
		}
		return;
	}

	// The user waits on this process (startup, typing, redraws), not on its
	// workers: on macOS its main thread runs above the default class a busy
	// machine's builds compete in.
	if (isProcessEntry) raiseInteractiveQos();
	// Before anything is spawned: worker subprocesses, shells and tools
	// inherit the policy, so reads of cloud-only files download everywhere.
	if (isProcessEntry) materializeDatalessFiles();

	if (resolvedArgv[0] === "--license") {
		// Command boundary: bundled notices are read only when requested.
		const { formatLicenseOutput } = await import("./cli/license");
		process.stdout.write(formatLicenseOutput());
		return;
	}
	const helpOrVersion =
		resolvedArgv[0] === "--help" ||
		resolvedArgv[0] === "-h" ||
		resolvedArgv[0] === "--version" ||
		resolvedArgv[0] === "-v" ||
		resolvedArgv[0] === "help";
	// Before any store opens (the prepaint composer's cache included): SQLite's POSIX
	// locks would be released by any other close of the same file in this process
	// (issue #15586); OFD locks are not. Help and version open no store and load no addon.
	// A failed install is reported once the launch has a warning sink (`main.ts`,
	// `ensureSqliteLockShim`); this module stays free of pi-utils' env snapshot.
	if (isProcessEntry && !helpOrVersion) installSqliteLockShim();
	let stopStartupComposer: (() => void) | undefined;
	if (
		!process.env.PI_TIMING &&
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true &&
		isPrepaintSafeArgv(resolvedArgv)
	) {
		// Intentional exception to the static-import convention: this latency boundary
		// keeps the TUI graph out of worker, subcommand, help, and version launches.
		// Loading it statically would erase the measured cold-start improvement.
		const { beginStartupComposer, stopPendingStartupComposer } = await import("./modes/startup-composer");
		beginStartupComposer({ version: VERSION });
		stopStartupComposer = stopPendingStartupComposer;
	}

	// The speculative composer owns stdin before either loader yields, so input
	// typed during initialization stays buffered. Neither graph is needed to
	// produce that frame.
	await Promise.all([setFullProcessName(), helpOrVersion ? Promise.resolve() : installNetworkBootstrap()]);

	if (resolvedArgv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}

	try {
		// Help and version run no command that touches git; everything else loads the guard with the CLI.
		const guard = helpOrVersion ? undefined : import("./sandbox/ledger");
		const [{ run }, { commands, resolveCliArgv }, ledger] = await Promise.all([
			import("@oh-my-pi/pi-utils/cli"),
			import("./cli-commands"),
			guard,
		]);
		// Before any command runs git: host git refuses repositories whose metadata a sandboxed command created or replaced.
		ledger?.installSandboxRepoGuard();
		// --help and --version are handled by run() directly; --license returned above.
		// Everything else that isn't a known subcommand routes to "launch".
		const resolved = resolveCliArgv(resolvedArgv);
		if ("error" in resolved) {
			process.stderr.write(`error: ${resolved.error}\n`);
			process.exitCode = 1;
			return;
		}
		runningCommand = resolved.argv[0];
		await run({ bin: APP_NAME, version: VERSION, argv: resolved.argv, commands, metadataHelp: showHelp });
	} finally {
		stopStartupComposer?.();
	}
}

// Floating call instead of top-level await: TLA forces `--bytecode` (CJS
// lowering) builds to fail, and the entrypoint needs nothing after this.
// The catch mirrors what an unhandled TLA rejection produced: error dump to
// stderr, exit code 1. A settled entry leaves the exit code to the command. An
// entry still pending when the event loop drains (an await that can never
// settle) exits 1 with a diagnostic: TLA would have hung there, and a bare
// floating call exits 0 as if the command had succeeded.
// Guarded so importing `runCli` (profile CLI tests, SDK embedding) does not
// launch the agent as a side effect. Worker threads re-enter this module as
// their entry with `import.meta.main === false`, so the worker-host dispatch
// is admitted via `!Bun.isMainThread`.
if (isProcessEntry || !Bun.isMainThread) {
	const postmortem: typeof Postmortem = require("@oh-my-pi/pi-utils/postmortem.js");
	postmortem.installProcessHandlers();
	// A one-shot CLI run (`omp --help | head`, `omp --version | true`, `omp <sub> | grep -m1`)
	// whose stdout consumer closes before the write drains gets an EPIPE that Bun surfaces as
	// an unhandled rejection. Treat a vanished stdout peer as an ordinary Unix disconnect
	// (graceful exit) rather than the fatal path. Interactive launches register their own
	// terminal lifetime; help/version/subcommand launches never start one. See #10930. The
	// registration lives for the process — a one-shot entry exits right after runCli settles.
	postmortem.registerStdioDisconnectHandling();
	const entry = runCli(process.argv.slice(2));
	postmortem.reportUnsettledEntry(entry, () => runningCommand);
	entry.catch(async error => {
		// A config file that fails to load is a user error: one line naming the file and the setting, no stack.
		// Dynamic like the postmortem import below: the process entry stays light, and only a failed launch needs the config module.
		const { ConfigError } = await import("./config/config-file");
		if (error instanceof ConfigError) {
			process.stderr.write(`Error: ${error.message}\n`);
			// Exit explicitly: an RPC launch already holds a pending stdin read, so a bare exit code would
			// leave the process alive until stdin closes. Quit runs cleanup, then exits 1.
			await postmortem.quit(1);
			return;
		}
		// Failure boundary: inspector/postmortem is irrelevant to successful startup.
		const { fatal } = await import("@oh-my-pi/pi-utils/postmortem");
		fatal(error);
	});
}
