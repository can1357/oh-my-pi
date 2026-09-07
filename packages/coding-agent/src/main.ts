/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */
import * as fsSync from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { EventLoopKeepalive, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import {
	$env,
	directoryIsMissing,
	getLogPath,
	getProjectDir,
	isBunTestRuntime,
	logger,
	normalizePathForComparison,
	postmortem,
	setInteractiveHost,
	setProjectDir,
	VERSION,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { reset as resetCapabilities } from "./capability";
import { type Args, reportUnrecognizedFlags, validateToolNames } from "./cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { selectSession } from "./cli/session-picker";
import { applyStartupCwd } from "./cli/startup-cwd";
import { getLatestRelease } from "./cli/update-cli";
import { findConfigFile } from "./config";
import { ModelRegistry } from "./config/model-registry";
import {
	DEFAULT_PREWALK_TARGET,
	expandRoleAlias,
	formatModelSelectorValue,
	getModelMatchPreferences,
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	type ScopedModel,
} from "./config/model-resolver";
import { ModelsConfigFile } from "./config/models-config";
import { serviceTierSettingToTier } from "./config/service-tier";
import { getDefault, type SettingPath, Settings, type SettingValue, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
} from "./discovery/helpers";
import { injectOmpExtensionCliRoots } from "./discovery/omp-extension-roots";
import { formatExtensionLoadNotifications } from "./extensibility/extensions/load-errors";
import { loadExtensions } from "./extensibility/extensions/loader";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "./extensibility/plugins/marketplace-auto-update";
import { registerDaemonProjectPresence } from "./launch/presence";
import { discoverStartupLspServers } from "./lsp/servers";
import type { MCPManager } from "./mcp";
import { InteractiveMode } from "./modes/interactive-mode";
import type { PrintModeOptions } from "./modes/print-mode";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { CURRENT_SETUP_VERSION } from "./modes/setup-version";
import type * as SetupWizardModule from "./modes/setup-wizard";
import type { SetupScene } from "./modes/setup-wizard";
import {
	applyStartupComposerPreferences,
	type ComposerLease,
	setStartupComposerLspServers,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "./modes/startup-composer";
import { ensureTheme, initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { createWarpEventBridgeExtension } from "./modes/warp-events";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	loadSessionExtensions,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";
import { describeAuthBrokerStartupError } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { describePendingToolCalls } from "./session/exit-diagnostics";
import {
	createForeignSessionStore,
	foreignSessionInfoToSessionInfo,
	foreignSessionSourceName,
	persistForeignSession,
} from "./session/foreign-session-import";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./session/foreign-session-store";
import { resolveResumableSession, type SessionInfo } from "./session/session-listing";
import { SessionManager } from "./session/session-manager";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { shouldShowStartupSplash } from "./startup-splash";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "./system-prompt";
import { createPersistedSubagentReviverFactory } from "./task/persisted-revive";
import { createTelemetryExportConfig, initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import { concreteThinkingLevel, parseConfiguredThinkingLevel } from "./thinking";
import type { LspStartupServerInfo } from "./tools";
import { getChangelogPath, resolveStartupChangelogForDisplay, type StartupChangelogSelection } from "./utils/changelog";
import { EventBus } from "./utils/event-bus";

type RunAcpMode = (createSession: AcpSessionFactory) => Promise<never>;
type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;
type RunRpcMode = (
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	subagentEventBus?: EventBus,
	input?: ReadableStream<Uint8Array>,
) => Promise<never>;

export function writeStartupNotice(parsedArgs: Pick<Args, "mode">, text: string): void {
	(parsedArgs.mode === "json" ? process.stderr : process.stdout).write(text);
}

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return;
	}
	try {
		const channel = settings.get("update.channel");
		const release = await getLatestRelease({ timeoutMs: 5_000, channel });
		return Bun.semver.order(release.version, currentVersion) > 0 ? release.version : undefined;
	} catch {
		return undefined;
	}
}

// Todo settings are caller-controlled in protocol modes. Do not host-default them:
// embedders need project-level opt-outs for reminder/prelude prompt injection.
const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"task.isolation.enabled",
	"isolation.backend",
	"worktree.clone",
	"worktree.cleanSource",
	"task.isolation.apply",
	"task.isolation.merge",
	"task.isolation.commits",
	"task.eager",
	"task.batch",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.disabledAgents",
	"task.agentModelOverrides",
	"task.agentPrewalk",
	"task.agentAdvisor",
	// Memory subsystems are off-by-default for RPC/ACP hosts; embedders that want
	// memory should opt in explicitly through their own settings layer.
	"memory.backend",
	"memories.enabled",
	// Advisor is interactive-session assistance. Protocol hosts opt in explicitly
	// instead of inheriting a user's globally-enabled local preference, and when
	// they do opt in they get the default tuning rather than the user's local tuning.
	"advisor.enabled",
	"advisor.syncBacklog",
	"advisor.immuneTurns",
	"tier.advisor",
];

const RPC_BACKGROUND_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
	"eval.autoBackground.enabled",
	"eval.autoBackground.thresholdMs",
];

// Protocol-mode hosts opt into a small set of paths whose host-default we
// re-apply at startup so embedders inherit OMP's neutral defaults instead of
// the local user's globally-persisted preferences for interactive use. The
// guard preserves any explicit configuration — caller `Settings.isolated`
// overrides, project `.claude/settings.yml`, `--config` overlays, or global
// `config.yml` — so the host default only kicks in when nothing is set. Without
// it the override clobbers every caller/host choice (#2598, #3207).
function applyDefaultSettingOverrides(settingPaths: SettingPath[], targetSettings: Settings): void {
	for (const settingPath of settingPaths) {
		if (targetSettings.isConfigured(settingPath)) continue;
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

function applyRpcDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
	applyDefaultSettingOverrides(RPC_BACKGROUND_DEFAULTED_SETTING_PATHS, targetSettings);
}

function applyAcpDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
}

/** Reads a non-TTY stdin stream as prompt text. */
export async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY === true) return undefined;
	// stdin is a pipe: a producer that never writes nor closes would block
	// startup forever with zero output. Say what we're blocked on after 1s.
	const notice = isBunTestRuntime()
		? undefined
		: setTimeout(() => {
				process.stderr.write(
					`${chalk.dim("Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…")}\n`,
				);
			}, 1000);
	notice?.unref?.();
	try {
		const text = await Bun.stdin.text();
		if (text.trim().length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	} finally {
		clearTimeout(notice);
	}
}

// ---------------------------------------------------------------------------
// Startup watchdog
// ---------------------------------------------------------------------------
// Speculative-hang reporter: until startup hands off to a mode runner, print a
// stderr line every 10s naming the deepest in-flight startup phase. Turns
// zero-output indefinite hangs (stuck discovery read, network wait, stdin
// pipe) into self-diagnosing reports instead of "it just hangs" (see the
// PI_DEBUG_STARTUP markers for the synchronous-hang counterpart).

const STARTUP_WATCHDOG_INTERVAL_MS = 10_000;
let startupWatchdogTimer: NodeJS.Timeout | undefined;
let startupWatchdogActive = false;
let startupWatchdogStartedAt = 0;

function armStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	if (startupWatchdogTimer) return;
	startupWatchdogTimer = setInterval(() => {
		const elapsed = Math.round((Date.now() - startupWatchdogStartedAt) / 1000);
		const phase = logger.openSpanPath().join(" > ") || "module load / pre-phase work";
		process.stderr.write(
			`${chalk.yellow(`Still starting after ${elapsed}s`)}${chalk.dim(` — phase: ${phase}`)}\n` +
				`${chalk.dim(`  logs: ${getLogPath()} · re-run with PI_DEBUG_STARTUP=1 for streaming phase markers`)}\n`,
		);
	}, STARTUP_WATCHDOG_INTERVAL_MS);
	startupWatchdogTimer.unref?.();
}

function disarmStartupWatchdog(): void {
	if (!startupWatchdogTimer) return;
	clearInterval(startupWatchdogTimer);
	startupWatchdogTimer = undefined;
}

/** Begin watching startup (idempotent). */
function startStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	startupWatchdogActive = true;
	startupWatchdogStartedAt = Date.now();
	armStartupWatchdog();
}

/** Permanently stop watching: a mode runner now owns the terminal. */
function stopStartupWatchdog(): void {
	startupWatchdogActive = false;
	disarmStartupWatchdog();
}

/** Pause while an interactive prompt legitimately waits on the user. */
function pauseStartupWatchdog(): void {
	disarmStartupWatchdog();
}

/** Resume after an interactive prompt, if startup is still being watched. */
function resumeStartupWatchdog(): void {
	if (isBunTestRuntime()) return;
	if (startupWatchdogActive) armStartupWatchdog();
}

export interface InteractiveModeNotify {
	kind: "warn" | "error" | "info";
	message: string;
}

export function buildModelScopeNotification(
	scopedModelsForDisplay: readonly Pick<ScopedModel, "model" | "thinkingLevel" | "explicitThinkingLevel">[],
	startupQuiet: boolean,
): InteractiveModeNotify | null {
	if (startupQuiet || scopedModelsForDisplay.length === 0) {
		return null;
	}
	const modelList = scopedModelsForDisplay
		.map(scopedModel => {
			const thinkingStr =
				scopedModel.explicitThinkingLevel && scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
			return `${scopedModel.model.id}${thinkingStr}`;
		})
		.join(", ");
	return { kind: "info", message: `Model scope: ${modelList} (Ctrl+P to cycle)` };
}
export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		"markPendingSubmissionStarted" | "finishPendingSubmission" | "showError" | "checkShutdownRequested"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage" | "isStreaming">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		using _keepalive = new EventLoopKeepalive();
		// Honor the submission's queue intent, defaulting to followUp. Reading
		// `session.isStreaming` to decide queue-vs-fresh is NOT atomic with the
		// eventual `agent.prompt()` call inside `session.prompt()`: a background turn
		// (queued-message drain, idle compaction, goal/loop continuation timer) can
		// flip the agent busy in the gap, and a bare prompt() would then throw
		// AgentBusyError straight to an error toast even though the UI shows no
		// "Working…". Passing a behavior unconditionally is a no-op when the session
		// is genuinely idle (a fresh turn runs and the option is ignored) and queues
		// the message instead of erroring when a turn is already underway. Normal
		// user Enter carries "steer" (interrupt, matching the streaming-branch Enter);
		// background/continuation submits omit it and fall back to "followUp". The
		// synthetic branch below opts out by design.
		const streamingBehavior = input.streamingBehavior ?? ("followUp" as const);
		// Continue shortcuts submit an already-started synthetic developer prompt with
		// no optimistic user message.
		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		if (input.customType) {
			const message = {
				customType: input.customType,
				content: input.text,
				display: input.display ?? false,
				attribution: "agent" as const,
			};
			await session.promptCustomMessage(message, { streamingBehavior });
		} else if (input.synthetic) {
			// Synthetic continue shortcuts are hidden developer prompts. The streaming
			// queue (#queueUserMessage) only carries user-attributed messages, so we do
			// NOT pass streamingBehavior here: queueing would silently demote the
			// developer directive to a visible user message. A synthetic submit while
			// streaming keeps its prior behavior (rejected as busy) rather than changing
			// its role.
			await session.prompt(input.text, {
				synthetic: true,
				expandPromptTemplates: false,
				userInitiated: input.userInitiated,
			});
		} else {
			await session.prompt(input.text, { images: input.images, streamingBehavior });
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}

interface AcpSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

type AcpSessionFactory = (cwd: string, options?: { interactivePrompts?: boolean }) => Promise<AcpSessionHandle>;

export interface AcpSessionFactoryOptions {
	baseOptions: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "apiKey" | "trustedExtensions" | "tools">;
	rawArgs: string[];
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

async function loadTrustedSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "additionalExtensionPaths">,
	cwd: string,
	eventBus: EventBus,
) {
	const paths = options.additionalExtensionPaths ?? [];
	for (const trustedPath of paths) {
		let stat: fsSync.Stats;
		try {
			stat = fsSync.statSync(trustedPath);
		} catch {
			throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
		}
		if (!stat.isFile()) {
			throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
		}
	}
	return loadExtensions(paths, cwd, eventBus);
}

/**
 * Build the per-`session/new` factory used by ACP mode.
 *
 * MCP servers in ACP sessions are owned exclusively by the ACP client, which
 * supplies them through `session/new.mcpServers` and re-applies them via
 * {@link AcpAgent#configureMcpServers}. We therefore force `enableMCP: false`
 * on every session created here so {@link createAgentSession} skips the on-disk
 * `.mcp.json` discovery path — otherwise host MCP tools land in the session's
 * tool registry and shadow the client-supplied servers (issue #1234).
 */
export function createAcpSessionFactory(args: AcpSessionFactoryOptions): AcpSessionFactory {
	return async (cwd, factoryOptions) => {
		const nextSettings = await args.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, args.sessionDir);
		const agentId = `acp:${nextSessionManager.getSessionId()}`;
		// `baseOptions.titleSystemPrompt` is resolved from the launch cwd; an ACP
		// host can open `session/new` for any client-supplied workspace, so
		// re-discover `TITLE_SYSTEM.md` against THIS session's `cwd` to keep the
		// replan-driven title refresh consistent with the target project's
		// policy (PR #3736 follow-up).
		const titleSystemPromptSource = discoverTitleSystemPromptFile(cwd);
		const titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		const eventBus = new EventBus();
		const trustedExtensions =
			args.parsedArgs.trustedExtensions && args.parsedArgs.trustedExtensions.length > 0
				? await loadTrustedSessionExtensions(args.baseOptions, cwd, eventBus)
				: undefined;
		if (trustedExtensions && trustedExtensions.errors.length > 0) {
			throw new Error(
				`Trusted extension failed to load: ${trustedExtensions.errors.map(item => item.error).join("; ")}`,
			);
		}
		const { session: nextSession, setToolUIContext } = await args.createSession({
			...args.baseOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage: args.authStorage,
			modelRegistry: args.modelRegistry,
			agentId,
			// ACP defers the `ask` capability and reserve-policy confirmation until
			// client capabilities are known, without enabling other UI-only behavior.
			interactivePrompts: factoryOptions?.interactivePrompts,
			deferUsageReserveConfirmation: true,
			enableMCP: false,
			titleSystemPrompt,
			eventBus,
			preloadedExtensions: trustedExtensions,
		});
		if (args.parsedArgs.apiKey && !args.baseOptions.model && nextSession.model) {
			args.authStorage.setRuntimeApiKey(nextSession.model.provider, args.parsedArgs.apiKey);
		}
		const runner = nextSession.extensionRunner;
		const reparsedArgs = applyExtensionFlags(
			runner
				? {
						getFlags: () => runner.getFlags(),
						setFlagValue: (name, value) => {
							runner.setFlagValue(name, value);
						},
					}
				: undefined,
			args.rawArgs,
		);
		const requestedTools = reparsedArgs?.tools ?? args.parsedArgs.tools;
		if (requestedTools) {
			try {
				validateToolNames(requestedTools, nextSession.getAllToolNames());
			} catch (error) {
				await nextSession.dispose();
				throw error;
			}
		}
		return { session: nextSession, setToolUIContext };
	};
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	startupChangelog: StartupChangelogSelection | undefined,
	notifs: (InteractiveModeNotify | null)[],
	versionCheckPromise: Promise<string | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: LspStartupServerInfo[] | undefined,
	mcpManager: MCPManager | undefined,
	resuming: boolean,
	forceSetupWizard: boolean,
	showStartupSplash: boolean,
	eventBus?: EventBus,
	subagentEventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
	joinLink?: string,
	startBackgroundModelDiscovery?: () => Promise<void>,
	startupLease?: ComposerLease,
): Promise<void> {
	let mode: InteractiveMode;
	try {
		mode = new InteractiveMode(
			session,
			version,
			startupChangelog,
			setExtensionUIContext,
			lspServers,
			mcpManager,
			eventBus,
			startupLease?.composer,
			subagentEventBus,
		);
		startupLease?.adopt();
	} catch (error) {
		startupLease?.dispose();
		throw error;
	}

	let setupWizard: typeof SetupWizardModule | undefined;
	let setupScenes: SetupScene[] = [];
	let playStartupSplash = false;
	try {
		// Cold-launch gate: the full setup wizard (every scene + the overlay and
		// their TUI/OAuth/search/theme deps) is heavy, yet the common case only needs
		// to know whether the stored setup version is current. Lazy-load the wizard
		// barrel only when setup is stale, forced, or the explicit startup splash
		// setting needs the shared setup splash renderer.
		const storedSetupVersion = settings.get("setupVersion");
		setupWizard =
			forceSetupWizard || storedSetupVersion < CURRENT_SETUP_VERSION || showStartupSplash
				? await import("./modes/setup-wizard")
				: undefined;
		setupScenes = setupWizard
			? await setupWizard.selectSetupScenes(storedSetupVersion, setupWizard.ALL_SCENES, mode, {
					resuming,
					isTTY: process.stdin.isTTY && process.stdout.isTTY,
					setupWizardEnabled: settings.get("startup.setupWizard"),
					force: forceSetupWizard,
				})
			: [];
		playStartupSplash = showStartupSplash && setupScenes.length === 0;

		await logger.time("InteractiveMode.init", () =>
			mode.init({
				suppressWelcomeIntro: resuming || setupScenes.length > 0 || playStartupSplash,
				clearInitialTerminalHistory: true,
				recentSessions: startupLease?.recentSessions,
			}),
		);
		void startBackgroundModelDiscovery?.();
	} catch (error) {
		mode.stop();
		throw error;
	}

	if (setupWizard && playStartupSplash) {
		await setupWizard.runStartupSplash(mode);
	}

	if (setupWizard && setupScenes.length > 0) {
		await setupWizard.runSetupWizard(mode, setupScenes);
	}

	// Consume failures immediately, but defer any banner until the transcript is stable.
	const checkedVersionPromise = versionCheckPromise.catch(() => undefined);

	// `init` already cleared native history before painting the startup frame.
	// Replaying resumed transcript rows and repainting the viewport is enough;
	// another clear would only archive the startup frame. In-process session
	// replacements still request `clearTerminalHistory` at their own callsites.
	await logger.time("InteractiveMode.renderInitialMessages", () =>
		mode.renderInitialMessages({ preserveExistingChat: true }),
	);
	// A resolved version check must not insert its banner into a partial transcript.
	checkedVersionPromise.then(newVersion => {
		if (!settings.get("startup.checkUpdate")) {
			return;
		}
		if (newVersion) {
			mode.showNewVersionNotification(newVersion);
		}
	});

	for (const notify of notifs) {
		if (!notify) {
			continue;
		}
		if (notify.kind === "warn") {
			mode.showWarning(notify.message);
		} else if (notify.kind === "error") {
			mode.showError(notify.message);
		} else if (notify.kind === "info") {
			mode.showStatus(notify.message);
		}
	}

	// `omp join <link>`: dispatch through the same builtin path as a typed
	// `/join` so collab guards and error rendering stay in one place.
	if (joinLink !== undefined) {
		await executeBuiltinSlashCommand(`/join ${joinLink}`, { ctx: mode });
	}

	if (initialMessage !== undefined) {
		session.maybeStartTitleGeneration(initialMessage);
		try {
			using _keepalive = new EventLoopKeepalive();
			// `steer` covers the race where the user submits a prompt of their own
			// before this dispatch runs (the composer accepts input as soon as the
			// first turn starts): the CLI message queues into that turn instead of
			// dying with AgentBusyError.
			await session.prompt(initialMessage, { images: initialImages, streamingBehavior: "steer" });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		session.maybeStartTitleGeneration(message);
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(message, { streamingBehavior: "steer" });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	while (true) {
		const input = await mode.getUserInput();
		await submitInteractiveInput(mode, session, input);
	}
}

type SessionPromptResult = "accepted" | "declined" | "unavailable";

type SessionPrompt = (session: SessionInfo) => Promise<SessionPromptResult>;

async function promptMoveSession(session: SessionInfo): Promise<SessionPromptResult> {
	if (!process.stdin.isTTY) {
		return "unavailable";
	}
	const message = `Session's directory no longer exists (${session.cwd}). Move (re-root) it into the current directory? [Y/n] `;
	pauseStartupWatchdog();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes" ? "accepted" : "declined";
	} finally {
		rl.close();
		resumeStartupWatchdog();
	}
}

/**
 * Friendly CLI failure raised by {@link createSessionManager} when the user's
 * session-resolution flags (`--resume`/`--fork`/missing-directory move prompts)
 * cannot be satisfied. {@link runRootCommand} catches it and prints a clean
 * stderr message instead of letting it surface as `[Uncaught Exception]`
 * (see issue #2084).
 */
export class SessionResolutionError extends Error {
	readonly hint?: string;
	constructor(message: string, hint?: string) {
		super(message);
		this.name = "SessionResolutionError";
		this.hint = hint;
	}
}

function resolveForeignSessionSource(
	parsed: Pick<Args, "continue" | "fork" | "fromClaude" | "fromCodex" | "noSession" | "resume">,
): ForeignSessionSource | undefined {
	if (parsed.fromClaude && parsed.fromCodex) {
		throw new SessionResolutionError("--from-claude and --from-codex cannot be used together");
	}
	const source = parsed.fromClaude ? "claude" : parsed.fromCodex ? "codex" : undefined;
	if (!source) return undefined;
	if (parsed.noSession) {
		throw new SessionResolutionError(`--from-${source} requires session persistence`);
	}
	if (parsed.continue || parsed.resume || parsed.fork) {
		throw new SessionResolutionError(`--from-${source} cannot be combined with --continue, --resume, or --fork`);
	}
	return source;
}

function isForeignSessionImport(parsed: Pick<Args, "fromClaude" | "fromCodex">): boolean {
	return parsed.fromClaude === true || parsed.fromCodex === true;
}

type MissingCwdMoveResult =
	| { status: "not-needed" }
	| { status: "declined" }
	| { status: "moved"; manager: SessionManager };

async function moveMissingCwdSessionIfNeeded(
	sessionArg: string,
	session: SessionInfo,
	cwd: string,
	sessionDir: string | undefined,
	askToMoveSession: SessionPrompt,
): Promise<MissingCwdMoveResult> {
	const sourceCwd = session.cwd;
	if (!sourceCwd || fsSync.existsSync(sourceCwd)) {
		return { status: "not-needed" };
	}

	const movePromptResult = await askToMoveSession(session);
	if (movePromptResult === "unavailable") {
		throw new SessionResolutionError(
			`Session "${sessionArg}" belongs to a directory that no longer exists (${sourceCwd}); run interactively to move it into the current project.`,
		);
	}
	if (movePromptResult === "declined") {
		return { status: "declined" };
	}

	// Open anchored at the (now-missing) recorded cwd: `open` otherwise falls back
	// to the launch cwd, which would make the `moveTo` below a no-op whenever the
	// move target equals the current project dir. moveTo never chdirs, so the
	// stale cwd is only a relocation source, not a directory we enter.
	const manager = await SessionManager.open(session.path, sessionDir, undefined, { initialCwd: sourceCwd });
	await manager.moveTo(cwd, sessionDir);
	return { status: "moved", manager };
}

type ResumedProjectResult = { cwd: string; chdirFailed?: string };

async function switchToResumedProject(
	resumedCwd: string | undefined,
	activeSettings: Settings,
	pluginPreloadPromise: Promise<unknown>,
	sessionManager: SessionManager,
): Promise<ResumedProjectResult> {
	const launchCwd = getProjectDir();
	if (
		!resumedCwd ||
		normalizePathForComparison(resumedCwd) === normalizePathForComparison(launchCwd) ||
		(await directoryIsMissing(resumedCwd))
	) {
		return { cwd: launchCwd };
	}

	// Let the launch-cwd preload settle before clearing and re-warming its caches.
	await pluginPreloadPromise.catch(() => {});
	try {
		setProjectDir(resumedCwd);
	} catch (error) {
		logger.warn("Could not switch to resumed project directory", { cwd: resumedCwd, error: String(error) });
		sessionManager.setCwdWithoutRelocation(launchCwd);
		return { cwd: launchCwd, chdirFailed: resumedCwd };
	}
	clearPluginRootsAndCaches();
	resetCapabilities();
	const cwd = getProjectDir();
	// clearPluginRootsAndCaches only kicks off an unawaited re-warm; await a fresh
	// destination preload so sync consumers (plugin-provided LSP/DAP config) never
	// read the launch project's stale/empty roots during session creation.
	try {
		await preloadPluginRoots(os.homedir(), cwd);
		await activeSettings.reloadForCwd(cwd);
		if (normalizePathForComparison(sessionManager.getCwd()) !== normalizePathForComparison(cwd)) {
			sessionManager.adoptRecordedCwd();
		}
	} catch (error) {
		// The process cwd is already committed to the target. If rescoping the
		// cwd-derived state fails, undo the whole transition instead of building
		// the session with target-scoped cwd and launch-scoped settings.
		logger.warn("Could not rescope to resumed project directory", { cwd, error: String(error) });
		try {
			setProjectDir(launchCwd);
			sessionManager.setCwdWithoutRelocation(launchCwd);
			clearPluginRootsAndCaches();
			await preloadPluginRoots(os.homedir(), launchCwd);
			// Settings.#cwd was already assigned the destination; re-scope it
			// back so path-derived values and project saves target the launch
			// project, not the failed resume target.
			await activeSettings.reloadForCwd(launchCwd);
		} catch (rollbackError) {
			throw new SessionResolutionError(
				`Could not switch to resumed project ${resumedCwd} (${error instanceof Error ? error.message : String(error)}); failed to restore launch directory ${launchCwd}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		return { cwd: launchCwd, chdirFailed: resumedCwd };
	}
	return { cwd };
}

function notifyResumeCwdFallback(parsedArgs: Args, resumedProject: ResumedProjectResult, cwd: string): void {
	if (!resumedProject.chdirFailed) return;
	writeStartupNotice(
		parsedArgs,
		`${chalk.yellow(`Could not switch to resumed project ${resumedProject.chdirFailed}; staying in ${cwd}.`)}\n`,
	);
}

/**
 * Resolve the effective model allow-list from an explicit `--models` scope or,
 * failing that, the active project's `enabledModels`. A totally collapsed scope
 * gets one cache-aware discovery pass before session construction: otherwise an
 * all-discovery `--models` launch can select an unrelated static model before the
 * later background rebuild activates the requested scope. The pass only helps
 * providers already known to be discoverable (models.yml `discovery:`, runtime
 * managers); a scope naming only extension-supplied models stays empty here
 * because those providers register during `createAgentSession` — that case is
 * covered by deferring to the SDK's `modelPattern` resolution in
 * {@link buildSessionOptions}. Re-run after a resume switches projects so the
 * destination project's settings-derived scope wins over the launch directory's.
 */
export async function resolveScopedModels(
	parsed: Args,
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "getDiscoverableProviders" | "refresh">,
	activeSettings: Settings,
): Promise<ScopedModel[]> {
	const modelPatterns = parsed.models ?? activeSettings.get("enabledModels");
	if (!modelPatterns || modelPatterns.length === 0) {
		return [];
	}
	const preferences = getModelMatchPreferences(activeSettings);
	const scopedModels = await resolveModelScope(modelPatterns, modelRegistry, preferences, activeSettings);
	if (scopedModels.length > 0 || modelRegistry.getDiscoverableProviders().length === 0) {
		return scopedModels;
	}
	await modelRegistry.refresh("online-if-uncached");
	return await resolveModelScope(modelPatterns, modelRegistry, preferences, activeSettings);
}

/**
 * Map resolver scope entries to the session's Ctrl+P cycle shape, filling in the
 * configured default thinking level for entries without an explicit `:level`
 * suffix. `auto` is session-level only, so it is coerced to a concrete default here.
 */
export function toSessionScopedModels(
	scopedModels: readonly ScopedModel[],
	activeSettings: Settings,
): Array<{ model: Model; thinkingLevel?: ThinkingLevel }> {
	if (scopedModels.length === 0) return [];
	const defaultThinkingLevel = concreteThinkingLevel(
		parseConfiguredThinkingLevel(activeSettings.get("defaultThinkingLevel")),
	);
	return scopedModels.map(scopedModel => ({
		model: scopedModel.model,
		thinkingLevel: scopedModel.explicitThinkingLevel
			? (scopedModel.thinkingLevel ?? defaultThinkingLevel)
			: defaultThinkingLevel,
	}));
}

/** Whether two scope lists reference the same set of models (order-independent). */
function sameScopedModelSet(a: ReadonlyArray<{ model: Model }>, b: ReadonlyArray<{ model: Model }>): boolean {
	if (a.length !== b.length) return false;
	const keys = new Set(a.map(entry => `${entry.model.provider}/${entry.model.id}`));
	return b.every(entry => keys.has(`${entry.model.provider}/${entry.model.id}`));
}

/** Minimal session surface the post-discovery scope rebuild mutates. */
export interface ScopedModelSink {
	readonly isDisposed: boolean;
	readonly scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void;
}

/**
 * Startup resolves the `--models`/`enabledModels` scope from the model registry
 * before background provider discovery runs — `createSession` fires
 * `refreshInBackground()` only after the session is built — so a scoped selector
 * whose model first materializes through runtime discovery (e.g.
 * `opencode-go/ox-alpha-free` on a fresh launch with no cache row) is absent from
 * the frozen scoped `/models` list even though it is in `enabledModels`, invokable
 * via `--model`, and listed by `omp models find`. Once the initial refresh settles,
 * re-resolve the scope and, when the set changed, push the fuller list into the
 * session so the scoped picker and Ctrl+P cycle include it. A scope that resolved
 * to zero models may become active here when the startup discovery pass returned
 * no models but the background pass succeeded. Fire-and-forget — never blocks the
 * prompt on background discovery latency. Issue #9220.
 */
export async function rebuildScopedModelsAfterDiscovery(
	session: ScopedModelSink,
	parsed: Args,
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "awaitBackgroundRefresh">,
	activeSettings: Settings,
): Promise<void> {
	const patterns = parsed.models ?? activeSettings.get("enabledModels");
	if (!patterns || patterns.length === 0) return;
	await modelRegistry.awaitBackgroundRefresh();
	if (session.isDisposed) return;
	const rebuilt = await resolveModelScope(
		patterns,
		modelRegistry,
		getModelMatchPreferences(activeSettings),
		activeSettings,
	);
	const mapped = toSessionScopedModels(rebuilt, activeSettings);
	if (mapped.length === 0 || sameScopedModelSet(session.scopedModels, mapped)) return;
	session.setScopedModels(mapped);
}

async function getChangelogForDisplay(
	parsed: Args,
	mode: SettingValue<"startup.changelogMode">,
): Promise<StartupChangelogSelection | undefined> {
	if (parsed.continue || parsed.resume || isForeignSessionImport(parsed)) {
		return undefined;
	}

	return resolveStartupChangelogForDisplay({
		mode,
		currentVersion: VERSION,
		changelogPath: getChangelogPath(),
	});
}

const SESSION_ID_ARG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeContinueSessionArgs(parsed: Args, rawArgs?: readonly string[]): void {
	if (!parsed.continue || parsed.resume || parsed.fork) return;

	let message: string | undefined;
	if (parsed.unrecognizedFlags.length === 0 && parsed.messages.length === 1) {
		message = parsed.messages[0]?.trim();
	} else if (rawArgs) {
		const continueIndex = rawArgs.findIndex(arg => arg === "--continue" || arg === "-c");
		message = rawArgs[continueIndex + 1]?.trim();
	}
	if (!message || !SESSION_ID_ARG_RE.test(message)) return;

	const messageIndex = parsed.messages.indexOf(message);
	if (messageIndex === -1) return;
	parsed.resume = message;
	parsed.continue = false;
	parsed.messages.splice(messageIndex, 1);
}

/** Resolves CLI session flags into an existing, forked, in-memory, or cancelled session manager. */
export async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
	askToMoveSession: SessionPrompt = promptMoveSession,
): Promise<SessionManager | undefined> {
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new SessionResolutionError("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		if (forkSource.includes("/") || forkSource.includes("\\") || forkSource.endsWith(".jsonl")) {
			return await SessionManager.forkFrom(forkSource, cwd, parsed.sessionDir);
		}
		const match = await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!match) {
			throw new SessionResolutionError(
				`Session "${forkSource}" not found.`,
				"Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.",
			);
		}
		return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	normalizeContinueSessionArgs(parsed);

	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			return await SessionManager.open(sessionArg, parsed.sessionDir);
		}
		const match = await resolveResumableSession(sessionArg, cwd, parsed.sessionDir);
		if (!match) {
			throw new SessionResolutionError(
				`Session "${sessionArg}" not found.`,
				"Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.",
			);
		}
		if (match.scope === "local") {
			const moveResult = await moveMissingCwdSessionIfNeeded(
				sessionArg,
				match.session,
				cwd,
				parsed.sessionDir,
				askToMoveSession,
			);
			if (moveResult.status === "moved") {
				return moveResult.manager;
			}
			if (moveResult.status === "declined") {
				return undefined;
			}
		}
		if (match.scope === "global") {
			const moveResult = await moveMissingCwdSessionIfNeeded(
				sessionArg,
				match.session,
				cwd,
				parsed.sessionDir,
				askToMoveSession,
			);
			if (moveResult.status === "moved") {
				return moveResult.manager;
			}
			if (moveResult.status === "declined") {
				return undefined;
			}
		}
		return await SessionManager.open(match.session.path, parsed.sessionDir);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Auto-resume: behave like --continue if the setting is enabled and a prior
	// session exists. When a prior session is resumed, mark parsed.continue so
	// buildSessionOptions restores the session's model/thinking instead of
	// overriding them with CLI defaults.
	if (activeSettings.get("autoResume")) {
		const manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

/** Discover SYSTEM.md file if no CLI system prompt was provided */
function discoverSystemPromptFile(): string | undefined {
	// Check project-local first (.omp/SYSTEM.md, .pi/SYSTEM.md legacy)
	const projectPath = findConfigFile("SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	// If not found, check SYSTEM.md file in the global directory.
	const globalPath = findConfigFile("SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Discover APPEND_SYSTEM.md file if no CLI append system prompt was provided */
function discoverAppendSystemPromptFile(): string | undefined {
	const projectPath = findConfigFile("APPEND_SYSTEM.md", { user: false });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("APPEND_SYSTEM.md", { user: true });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Apply resolved CLI/discovered prompt files without bypassing system prompt templates. */
export function applyResolvedSystemPromptInputs(
	options: CreateAgentSessionOptions,
	resolvedSystemPrompt: string | undefined,
	resolvedAppendPrompt: string | undefined,
): void {
	if (resolvedSystemPrompt) {
		options.customSystemPrompt = resolvedSystemPrompt;
	}
	if (resolvedAppendPrompt) {
		options.appendSystemPrompt = resolvedAppendPrompt;
	}
}

/** Builds startup session options from parsed CLI flags, scoped models, and resolved session lineage. */
export async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): Promise<CreateAgentSessionOptions> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
		autoApprove: parsed.autoApprove ?? false,
	};
	const restoringSession = Boolean(parsed.continue || parsed.resume || isForeignSessionImport(parsed));
	if (parsed.serviceTier !== undefined) {
		options.openAIServiceTier = serviceTierSettingToTier(parsed.serviceTier) ?? null;
	}
	const cliDirs = parsed.addDir ?? [];
	const settingsDirs = activeSettings.get("workspace.additionalDirectories");
	if (cliDirs.length > 0 || settingsDirs.length > 0) {
		options.additionalDirectories = [...new Set([...cliDirs, ...settingsDirs])];
	}
	if (parsed.maxTime !== undefined) {
		options.deadline = Date.now() + parsed.maxTime * 1000;
	}

	// Auto-discover SYSTEM.md if no CLI system prompt provided
	const systemPromptSource = parsed.systemPrompt ?? discoverSystemPromptFile();
	const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();
	const titleSystemPromptSource = discoverTitleSystemPromptFile();
	const [resolvedSystemPrompt, resolvedAppendPrompt, titleSystemPrompt] = await Promise.all([
		resolvePromptInput(systemPromptSource, "system prompt"),
		resolvePromptInput(appendPromptSource, "append system prompt"),
		resolvePromptInput(titleSystemPromptSource, "title system prompt"),
	]);

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}
	if (parsed.providerPromptCacheKey) {
		options.providerPromptCacheKey = parsed.providerPromptCacheKey;
		options.providerPromptCacheKeySource = "explicit";
	} else {
		const header = sessionManager?.getHeader();
		const scopedModelOverride = scopedModels.length > 0 && !restoringSession;
		const forkCacheShapeChanged =
			scopedModelOverride ||
			parsed.model !== undefined ||
			parsed.thinking !== undefined ||
			parsed.systemPrompt !== undefined ||
			parsed.appendSystemPrompt !== undefined ||
			parsed.tools !== undefined ||
			parsed.noTools === true;
		if (!forkCacheShapeChanged && header?.providerPromptCacheKey) {
			options.providerPromptCacheKey = header.providerPromptCacheKey;
			options.providerPromptCacheKeySource = "fork";
		}
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	const modelMatchPreferences = getModelMatchPreferences(activeSettings);
	// True when a configured `default` role was deliberately left unresolved for
	// createAgentSession's post-extension re-resolution (issue #6694); the
	// scoped thinking-level seed below must be deferred along with the model.
	let deferredDefaultRole = false;
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			availableModels: modelRegistry.getAvailable(),
			settings: activeSettings,
			preferences: modelMatchPreferences,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		const matchedAfterMissingRolePattern = (resolved.configuredPatternIndex ?? 0) > 0;
		if (matchedAfterMissingRolePattern) {
			// Extensions may register an earlier configured role candidate.
			options.modelPattern = parsed.model;
		} else if (resolved.error) {
			if (!parsed.provider && ((resolved.configuredPatterns?.length ?? 0) > 0 || !parsed.model.includes(":"))) {
				// Model not found in built-in registry — defer resolution to after extensions load
				// (extensions may register additional providers/models via registerProvider)
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(1);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			options.rebindModelAfterDiscovery = true;
			// The recorded role must carry the effort the session actually starts
			// at, or the first cycle back into `default` overrides it.
			activeSettings.overrideModelRoles({
				default: formatModelSelectorValue(
					resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
					parsed.thinking ?? resolved.thinkingLevel,
				),
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	} else if (scopedModels.length > 0 && !restoringSession) {
		const remembered = activeSettings.getModelRole("default");
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings: activeSettings,
					matchPreferences: modelMatchPreferences,
				},
			);
			const rememberedResolvedModel = rememberedSpec.model;
			const rememberedModel = rememberedResolvedModel
				? scopedModels.find(
						scopedModel =>
							scopedModel.model.provider === rememberedResolvedModel.provider &&
							scopedModel.model.id === rememberedResolvedModel.id,
					)
				: scopedModels.find(scopedModel => scopedModel.model.id.toLowerCase() === remembered.toLowerCase());
			if (rememberedModel) {
				options.model = rememberedModel.model;
				options.rebindModelAfterDiscovery = true;
				// Apply explicit thinking level from remembered role value
				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
				}
			}
		}
		// A configured `default` role that doesn't resolve within the startup
		// scope is deferred, NOT silently pinned to `scopedModels[0]`: the scope
		// is resolved before extensions register their providers, so a role naming
		// an extension-registered model (listed in `enabledModels`) would drop out
		// here and the session would run on an unrelated in-scope provider without
		// any error. Leaving `options.model` unset lets createAgentSession's
		// post-extension default-role resolution reclaim it against the fully
		// registered, still enabledModels-scoped catalog (issue #6694).
		// Defer ONLY for a settings-derived scope: createAgentSession re-resolves
		// against `settings.enabledModels` and never sees CLI `--models`, so
		// deferring under an explicit CLI scope would let the saved default
		// escape it — keep pinning the first scoped model there.
		deferredDefaultRole = !options.model && Boolean(remembered) && !((parsed.models?.length ?? 0) > 0);
		if (!options.model && !deferredDefaultRole) {
			options.model = scopedModels[0].model;
			options.rebindModelAfterDiscovery = true;
		}
	} else if ((parsed.models?.length ?? 0) > 0 && !restoringSession) {
		// A CLI `--models` scope that resolved to zero models at startup: its
		// selectors name only models supplied by extension providers (or discovery)
		// that register during createAgentSession, so nothing matched the
		// pre-session catalog and `getDiscoverableProviders()` did not yet list the
		// provider for resolveScopedModels' pre-refresh. Defer the choice to the
		// SDK's post-extension resolution — the same `modelPattern` path a deferred
		// `--model` uses — so the initial model is picked from the requested scope
		// instead of an unrelated fallback. The fire-and-forget rebuild then
		// activates the scoped list once discovery settles (issue #9220).
		options.modelPattern = parsed.models;
	}

	if (parsed.noPrewalk && (parsed.prewalk || parsed.prewalkInto !== undefined)) {
		throw new Error("--no-prewalk cannot be combined with --prewalk or --prewalk-into");
	}
	const explicitPrewalk = parsed.prewalk === true || parsed.prewalkInto !== undefined;
	const prewalkEnabled = parsed.noPrewalk
		? false
		: explicitPrewalk
			? true
			: !restoringSession && activeSettings.get("prewalk.enabled");
	if (prewalkEnabled) {
		const rolePattern = expandRoleAlias(parsed.prewalkInto ?? DEFAULT_PREWALK_TARGET, activeSettings);
		const resolved = resolveCliModel({ cliModel: rolePattern, modelRegistry, preferences: modelMatchPreferences });
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		// Prewalk is an optional optimization (off by default): switch to a fast
		// model at the first edit. If its hand-off target can't be resolved or has
		// no configured auth, warn and leave prewalk unarmed rather than aborting
		// startup and locking the user out of the app (issue #6064).
		if (resolved.error || !resolved.model) {
			const target = parsed.prewalkInto ?? DEFAULT_PREWALK_TARGET;
			process.stderr.write(
				`${chalk.yellow(`Warning: prewalk disabled — ${resolved.error ?? `model "${target}" not found`}`)}\n`,
			);
		} else if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			process.stderr.write(
				`${chalk.yellow(`Warning: prewalk disabled — no API key for ${resolved.model.provider}/${resolved.model.id}`)}\n`,
			);
		} else {
			options.prewalk = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}

	if (parsed.planYoloInto !== undefined && !parsed.planYolo) {
		throw new Error("--plan-yolo-into requires --plan-yolo");
	}
	if (parsed.planYolo) {
		const rolePattern = expandRoleAlias(parsed.planYoloInto ?? "@smol", activeSettings);
		const resolved = resolveCliModel({ cliModel: rolePattern, modelRegistry, preferences: modelMatchPreferences });
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error || !resolved.model) {
			throw new Error(resolved.error ?? `Model "${parsed.planYoloInto ?? "@smol"}" not found`);
		}
		if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
		}
		options.planYolo = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		// A deferred default role resolves its own model (and any explicit
		// thinking suffix) after extensions register; seeding the fallback
		// scoped model's level here would override it in createAgentSession.
		!deferredDefaultRole &&
		!restoringSession
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	// Scoped models for Ctrl+P cycling — fill in default thinking levels when not explicit.
	if (scopedModels.length > 0) {
		options.scopedModels = toSessionScopedModels(scopedModels, activeSettings);
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	applyResolvedSystemPromptInputs(options, resolvedSystemPrompt, resolvedAppendPrompt);
	// Replan-driven title refresh resolves the override from this same field on
	// `AgentSession`, so threading it through `CreateAgentSessionOptions` keeps
	// both first-input titling (`input-controller.ts`) and replan refresh
	// (`AgentSession.#refreshTitleAfterReplan`) on one source of truth.
	if (titleSystemPrompt) {
		options.titleSystemPrompt = titleSystemPrompt;
	}

	// Tools
	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	if (parsed.noLsp) {
		options.enableLsp = false;
	}

	// Skills
	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.skills && parsed.skills.length > 0) {
		// Override includeSkills for this session
		activeSettings.override("skills.includeSkills", parsed.skills as string[]);
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	// Trusted extension paths are an exact allowlist for extension modules.
	if (parsed.trustedExtensions && parsed.trustedExtensions.length > 0) {
		const trustedPaths = parsed.trustedExtensions.map(trustedPath => {
			let resolvedPath: string;
			let stat: fsSync.Stats;
			try {
				resolvedPath = fsSync.realpathSync.native(trustedPath);
				stat = fsSync.statSync(resolvedPath);
			} catch {
				throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
			}
			if (!stat.isFile()) {
				throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
			}
			return resolvedPath;
		});
		options.disableExtensionDiscovery = true;
		options.additionalExtensionPaths = trustedPaths;
	} else {
		// Additional extension paths from CLI
		const cliExtensionPaths = [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
		if (cliExtensionPaths.length > 0) {
			options.additionalExtensionPaths = cliExtensionPaths;
		}

		if (parsed.noExtensions) {
			options.disableExtensionDiscovery = true;
		}
	}

	return options;
}

interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	selectSession?: typeof selectSession;
	runAcpMode?: RunAcpMode;
	createForeignSessionStore?: (source: ForeignSessionSource) => ForeignSessionStore;
	settings?: Settings;
	forceSetupWizard?: boolean;
}
const DEFAULT_RUN_ROOT_DEPENDENCIES: RunRootCommandDependencies = {};

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = DEFAULT_RUN_ROOT_DEPENDENCIES,
): Promise<void> {
	logger.startTiming();
	startStartupWatchdog();
	try {
		// Non-prepaint commands still need a default theme; an existing Composer
		// already initialized its cached theme synchronously for the first frame.
		await logger.time("initTheme:initial", ensureTheme);

		const parsedArgs = parsed;
		try {
			await logger.time("applyStartupCwd", applyStartupCwd, parsedArgs);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}

		const notifs: (InteractiveModeNotify | null)[] = [];

		if (parsedArgs.version) {
			writeStartupNotice(parsedArgs, `${VERSION}\n`);
			process.exit(0);
		}

		if (parsedArgs.export) {
			let result: string;
			try {
				const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
				const { exportFromFile } = await import("./export/html");
				result = await exportFromFile(parsedArgs.export, outputPath);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : "Failed to export session";
				process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
				process.exit(1);
			}
			writeStartupNotice(parsedArgs, `Exported to: ${result}\n`);
			process.exit(0);
		}

		if ((parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") && parsedArgs.fileArgs.length > 0) {
			process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
			process.exit(1);
		}
		const mode = parsedArgs.mode || "text";
		// RPC owns stdin. Claim its singleton stream before plugin/extension discovery can load an in-process consumer.
		const rpcInput = mode === "rpc" || mode === "rpc-ui" ? claimRpcInput() : undefined;

		// Kick off plugin-root preload in parallel with the remaining startup work.
		// Awaited later (before extension/skill discovery in createAgentSession needs it).
		const home = os.homedir();
		const pluginPreloadPromise =
			parsedArgs.pluginDirs && parsedArgs.pluginDirs.length > 0
				? logger.time("injectPluginDirRoots", injectPluginDirRoots, home, parsedArgs.pluginDirs, getProjectDir())
				: logger.time("preloadPluginRoots", preloadPluginRoots, home, getProjectDir());
		// Mark the promise as handled so a synchronous failure does not surface as an unhandled-rejection
		// warning before we reach the await site below.
		pluginPreloadPromise.catch(() => {});

		// Trusted files load as exact module paths, never as package roots whose
		// sibling hooks/tools/commands/MCP content could be discovered implicitly.
		if (!parsedArgs.trustedExtensions?.length) {
			// Register CLI-provided extension package paths (`--extension`, `--hook`) so
			// the `omp-plugins` discovery provider can surface their `skills/`, `hooks/`,
			// `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json` sub-trees.
			// Explicit roots remain authorized under `--no-extensions`; only ambient
			// extension discovery is disabled.
			const cliExtensions = [...(parsedArgs.extensions ?? []), ...(parsedArgs.hooks ?? [])];
			injectOmpExtensionCliRoots(cliExtensions, home, getProjectDir(), {
				mode: parsedArgs.noExtensions ? "explicit-only" : "merge",
				replace: true,
			});
		}

		let cwd = getProjectDir();
		// Classify the host before opening auth or settings storage so every
		// session-critical database connection picks the right busy timeout.
		// See getDbBusyTimeoutMs().
		const isProtocolMode = mode === "rpc" || mode === "rpc-ui" || mode === "acp";
		// Protocol modes own stdin; treating it as prompt text would consume JSON-RPC frames before their transports start.
		const pipedInput = isProtocolMode ? undefined : await logger.time("readPipedInput", readPipedInput);
		const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
		const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;
		// Only the interactive host renders a focusable Agent Hub / subagent session
		// tree; declare it so headless subagent optimizations (e.g. skipping replan
		// title refresh) can tell a focusable process from a print/RPC/eval one.
		setInteractiveHost(isInteractive);
		if (!isInteractive) {
			stopPendingStartupComposer();
		}
		// Auth and settings are independent; start both before awaiting either.
		// A configured-but-unreachable auth broker still receives the actionable
		// startup error below, while its cache/config I/O overlaps settings I/O.
		const authStoragePromise = logger.time("discoverAuthStorage", deps.discoverAuthStorage ?? discoverAuthStorage);
		authStoragePromise.catch(() => {});
		const settingsPromise = deps.settings
			? Promise.resolve(deps.settings)
			: logger.time("settings:init", Settings.init, { cwd, configFiles: parsedArgs.config });
		settingsPromise.catch(() => {});
		let authStorage: AuthStorage;
		try {
			authStorage = await authStoragePromise;
		} catch (error) {
			const message = await describeAuthBrokerStartupError(error);
			if (message === null) throw error;
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(1);
		}

		const settingsInstance = await settingsPromise;
		if (parsedArgs.approvalMode) {
			// Runtime override (not persisted): every settings.get("tools.approvalMode") downstream
			// sees this value. The wrapper still honours --auto-approve / --yolo on top of it.
			settingsInstance.override("tools.approvalMode", parsedArgs.approvalMode);
		} else if (parsedArgs.autoApprove) {
			// --auto-approve / --yolo without an explicit --approval-mode: reflect in settings so
			// setup-time checks (e.g. #wrapToolForAcpPermission) also see the yolo intent.
			settingsInstance.override("tools.approvalMode", "yolo");
		}
		if (parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") {
			applyRpcDefaultSettingOverrides(settingsInstance);
		} else if (parsedArgs.mode === "acp") {
			applyAcpDefaultSettingOverrides(settingsInstance);
		}

		// The registry composes policy-dependent metadata synchronously, including
		// extended-context window caps, so it must receive the finalized settings.
		const modelRegistry = logger.time(
			"modelRegistry:init",
			() => new ModelRegistry(authStorage, undefined, { settings: settingsInstance }),
		);
		if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
			Bun.env.PI_NO_PTY = "1";
		}
		if (
			parsedArgs.noTitle ||
			parsedArgs.mode === "rpc" ||
			parsedArgs.mode === "rpc-ui" ||
			parsedArgs.mode === "acp"
		) {
			Bun.env.PI_NO_TITLE = "1";
		}

		// Initialize discovery system with settings for provider persistence
		logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

		// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
		const smolModel = parsedArgs.smol ?? $env.PI_SMOL_MODEL;
		const slowModel = parsedArgs.slow ?? $env.PI_SLOW_MODEL;
		const planModel = parsedArgs.plan ?? $env.PI_PLAN_MODEL;
		if (smolModel || slowModel || planModel) {
			settingsInstance.overrideModelRoles({
				smol: smolModel,
				slow: slowModel,
				plan: planModel,
			});
		}

		// --print-thoughts (single-shot print mode) must surface reasoning, so un-hide
		// thinking before the session is built — otherwise a passive omitThinking
		// setting makes the provider omit summaries and the flag prints nothing. An
		// explicit --hide-thinking block display option still wins for output display.
		if (parsedArgs.printThoughts && !isProtocolMode && !isInteractive) {
			settingsInstance.override("omitThinking", false);
		}
		// Apply --hide-thinking CLI flag (ephemeral, not persisted)
		if (parsedArgs.hideThinking) {
			settingsInstance.override("hideThinkingBlock", true);
		}
		// Apply --advisor CLI flag (ephemeral, not persisted)
		if (parsedArgs.advisor) {
			settingsInstance.override("advisor.enabled", true);
		}
		// Apply --external-thinking CLI flag (ephemeral, not persisted)
		if (parsedArgs.externalThinking) {
			settingsInstance.override("externalThinking", true);
		}

		await logger.time(
			"initTheme:final",
			initTheme,
			isInteractive,
			settingsInstance.get("symbolPreset"),
			settingsInstance.get("colorBlindMode"),
			settingsInstance.get("theme.dark"),
			settingsInstance.get("theme.light"),
		);

		applyStartupComposerPreferences({
			quiet: settingsInstance.get("startup.quiet"),
			composerShape: settingsInstance.get("composer.shape") ?? "band",
			showHardwareCursor: settingsInstance.get("showHardwareCursor"),
			maxInlineImages: settingsInstance.get("tui.maxInlineImages"),
			resizeScrollback: settingsInstance.get("tui.resizeScrollback"),
			imeSafeCursor: settingsInstance.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settingsInstance.get("autocompleteMaxVisible"),
			spellingTypoDetection: settingsInstance.get("spelling.typoDetection"),
			spellingAutocomplete: settingsInstance.get("spelling.autocomplete"),
			spellingAutocorrect: settingsInstance.get("spelling.autocorrect"),
			theme: {
				symbolPreset: settingsInstance.get("symbolPreset"),
				colorBlindMode: settingsInstance.get("colorBlindMode"),
				darkTheme: settingsInstance.get("theme.dark"),
				lightTheme: settingsInstance.get("theme.light"),
			},
		});
		setStartupComposerLspServers(discoverStartupLspServers(cwd, "connecting"));

		let scopedModels = await logger.time(
			"resolveModelScope",
			resolveScopedModels,
			parsedArgs,
			modelRegistry,
			settingsInstance,
		);

		// Resolve an explicit `--continue <id>` before extension flags are loaded.
		// Reading the token immediately after `--continue` distinguishes the session
		// id from UUID-shaped values owned by later extension flags.
		normalizeContinueSessionArgs(parsedArgs, rawArgs);

		// Resolve native resume/fork flags or import one foreign transcript into a
		// fresh persisted OMP session before constructing the AgentSession.
		let sessionManager: SessionManager | undefined;
		let foreignSource: ForeignSessionSource | undefined;
		try {
			foreignSource = resolveForeignSessionSource(parsedArgs);
			if (foreignSource) {
				if (isProtocolMode) {
					throw new SessionResolutionError(`--from-${foreignSource} is not supported in ${mode} mode`);
				}
				const sourceName = foreignSessionSourceName(foreignSource);
				const store = (deps.createForeignSessionStore ?? createForeignSessionStore)(foreignSource);
				let foreignSessions: ForeignSessionInfo[];
				try {
					foreignSessions = await logger.time(`list${sourceName}Sessions`, () => store.list());
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new SessionResolutionError(`Failed to list ${sourceName} sessions: ${message}`);
				}
				if (foreignSessions.length === 0) {
					writeStartupNotice(parsedArgs, `${chalk.dim(`No ${sourceName} sessions found`)}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
				const choices = foreignSessions.map(foreignSessionInfoToSessionInfo);
				pauseStartupWatchdog();
				let selected: SessionInfo | null;
				try {
					selected = await logger.time(
						`select${sourceName}Session`,
						deps.selectSession ?? selectSession,
						choices,
						{
							title: `Import ${sourceName} Session`,
							scopeLabel: false,
							showCwd: true,
							allowDelete: false,
							allowGlobalScope: false,
							historySearch: false,
						},
					);
				} finally {
					resumeStartupWatchdog();
				}
				if (!selected) {
					writeStartupNotice(parsedArgs, `${chalk.dim(`No ${sourceName} session selected`)}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
				const foreignSession = foreignSessions.find(
					session => session.id === selected.id && session.path === selected.path,
				);
				if (!foreignSession) {
					throw new SessionResolutionError(`Selected ${sourceName} session is no longer available`);
				}
				try {
					sessionManager = await logger.time(
						`import${sourceName}Session`,
						persistForeignSession,
						store,
						foreignSession,
						{ fallbackCwd: cwd, sessionDir: parsedArgs.sessionDir },
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new SessionResolutionError(`Failed to import ${sourceName} session: ${message}`);
				}
			} else {
				sessionManager = await logger.time(
					"createSessionManager",
					createSessionManager,
					parsedArgs,
					cwd,
					settingsInstance,
				);
			}
		} catch (error: unknown) {
			if (error instanceof SessionResolutionError) {
				process.stderr.write(`${chalk.red(`Error: ${error.message}`)}\n`);
				if (error.hint) {
					process.stderr.write(`${chalk.dim(error.hint)}\n`);
				}
				process.exit(1);
			}
			throw error;
		}

		if ((typeof parsedArgs.resume === "string" || foreignSource) && sessionManager) {
			const previousCwd = cwd;
			const recordedCwd = sessionManager.getRecordedCwd() ?? sessionManager.getCwd();
			const resumedProject = await switchToResumedProject(
				recordedCwd,
				settingsInstance,
				pluginPreloadPromise,
				sessionManager,
			);
			cwd = resumedProject.cwd;
			notifyResumeCwdFallback(parsedArgs, resumedProject, cwd);
			if (cwd !== previousCwd) {
				// applyStartupCwd persists an explicit --cwd in parsedArgs; once resume
				// switches projects, keep session construction on the destination too.
				parsedArgs.cwd = cwd;
				// Destination project may scope a different `enabledModels`; re-resolve
				// so the model UI and session options reflect it (explicit `--models`
				// stays fixed inside resolveScopedModels).
				scopedModels = await resolveScopedModels(parsedArgs, modelRegistry, settingsInstance);
			}
		}

		// User declined the missing-directory move prompt — exit cleanly instead of
		// letting the cancellation fall through to a new session.
		if (typeof parsedArgs.resume === "string" && !sessionManager) {
			writeStartupNotice(parsedArgs, `${chalk.dim("Resume cancelled: session was not moved.")}\n`);
			stopStartupWatchdog();
			process.exit(0);
		}

		// Handle --resume (no value): show session picker
		if (parsedArgs.resume === true && !parsedArgs.fork) {
			const folderSessions = await logger.time(
				"SessionManager.list",
				SessionManager.list,
				cwd,
				parsedArgs.sessionDir,
			);
			let preloadedAllSessions: SessionInfo[] | undefined;
			if (folderSessions.length === 0) {
				// Probe globally so we can exit fast when the user has no sessions at
				// all, but never auto-switch the picker into all-projects scope — that
				// silently surfaced other projects' history when the cwd was empty
				// (issue #3099). The preloaded list also makes the user's Tab switch
				// instant on the way in.
				preloadedAllSessions = await logger.time("SessionManager.listAll", SessionManager.listAll);
				if (preloadedAllSessions.length === 0) {
					writeStartupNotice(parsedArgs, `${chalk.dim("No sessions found")}\n`);
					stopStartupWatchdog();
					process.exit(0);
				}
			}
			pauseStartupWatchdog();
			const selected = await logger.time("selectSession", deps.selectSession ?? selectSession, folderSessions, {
				allSessions: preloadedAllSessions,
			});
			resumeStartupWatchdog();
			if (!selected) {
				writeStartupNotice(parsedArgs, `${chalk.dim("No session selected")}\n`);
				// Quit instead of returning: startup already armed long-lived handles
				// (theme watcher + SIGWINCH/macOS appearance listeners via initTheme,
				// settings save timer, model registry) that keep the event loop alive,
				// so a bare return hangs the process after the picker leaves the alt
				// screen. No session was built here, so there is nothing to flush. The
				// in-session `/resume` picker (selector-controller.ts) takes a different
				// onCancel that just closes the overlay — only this startup path exits.
				stopStartupWatchdog();
				process.exit(0);
			}
			sessionManager = await SessionManager.open(selected.path);
			const previousCwd = cwd;
			const recordedCwd = selected.cwd || sessionManager.getRecordedCwd() || sessionManager.getCwd();
			const resumedProject = await switchToResumedProject(
				recordedCwd,
				settingsInstance,
				pluginPreloadPromise,
				sessionManager,
			);
			cwd = resumedProject.cwd;
			notifyResumeCwdFallback(parsedArgs, resumedProject, cwd);
			if (cwd !== previousCwd) {
				parsedArgs.cwd = cwd;
				scopedModels = await resolveScopedModels(parsedArgs, modelRegistry, settingsInstance);
			}
		}

		if (sessionManager && (parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || foreignSource)) {
			const pendingToolWarning = describePendingToolCalls(sessionManager.getBranch());
			if (pendingToolWarning) {
				logger.warn("Resumed session has pending tool calls", {
					sessionId: sessionManager.getSessionId(),
					sessionFile: sessionManager.getSessionFile(),
				});
				if (isInteractive) {
					notifs.push({ kind: "warn", message: pendingToolWarning });
				} else {
					process.stderr.write(`${chalk.yellow(`${pendingToolWarning}\n`)}`);
				}
			}
		}
		await pluginPreloadPromise;
		if (deps === DEFAULT_RUN_ROOT_DEPENDENCIES) {
			await logger.time("registerDaemonProjectPresence", registerDaemonProjectPresence, cwd);
		}

		scheduleMarketplaceAutoUpdate({
			autoUpdate: settingsInstance.get("marketplace.autoUpdate"),
			resolveActiveProjectRegistryPath,
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const sessionOptions = await logger.time(
			"buildSessionOptions",
			buildSessionOptions,
			parsedArgs,
			scopedModels,
			sessionManager,
			modelRegistry,
			settingsInstance,
		);
		sessionOptions.authStorage = authStorage;
		sessionOptions.modelRegistry = modelRegistry;
		sessionOptions.hasUI = isInteractive || mode === "rpc-ui";
		sessionOptions.settings = settingsInstance;

		// OTEL: register global OTLP exporters when an endpoint is configured via
		// env, then switch on the agent loop's telemetry hooks so traces, run-level
		// metrics, and structured logs have source events to export. Content capture
		// remains governed by OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT.
		await logger.time("initTelemetryExport", initTelemetryExport);
		if (isTelemetryExportEnabled()) {
			sessionOptions.telemetry = createTelemetryExportConfig(sessionOptions.telemetry);
		}

		// Handle CLI --api-key as runtime override (not persisted)
		if (parsedArgs.apiKey) {
			if (!sessionOptions.model && !sessionOptions.modelPattern) {
				process.stderr.write(
					`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
				);
				process.exit(1);
			}
			if (sessionOptions.model) {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsedArgs.apiKey);
			}
		}

		const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
		const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
			const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
			// Kick off background model discovery only after createAgentSession finishes its parallel
			// discovery arms; running these concurrently contends for the event loop and stretches
			// every parallel arm by ~30ms.
			modelRegistry.refreshInBackground();
			return result;
		};

		if (mode === "acp") {
			const createAcpSession = createAcpSessionFactory({
				baseOptions: sessionOptions,
				settings: settingsInstance,
				sessionDir: parsedArgs.sessionDir,
				authStorage,
				modelRegistry,
				parsedArgs,
				rawArgs,
				createSession,
			});
			// Branch-only protocol runner: keep ACP server code out of normal interactive startup.
			const runAcpMode = deps.runAcpMode ?? (await import("./modes/acp/acp-mode")).runAcpMode;
			stopStartupWatchdog();
			await runAcpMode(createAcpSession);
		} else {
			// Resolve extension-registered CLI flags before creating the session so a
			// bad `@file` fails fast WITHOUT leaving a junk session/breadcrumb
			// (createAgentSession writes the terminal breadcrumb eagerly). Loading the
			// extensions here also makes `@file` classification extension-aware — e.g. a
			// string-flag value such as `--target @notes.md` is the flag's value, not a
			// file — and the same result is handed to createAgentSession via
			// `preloadedExtensions` so the discovery work is not repeated.
			if (isInteractive && !parsedArgs.trustedExtensions?.length) {
				sessionOptions.extensions = [...(sessionOptions.extensions ?? []), createWarpEventBridgeExtension()];
			}

			const eventBus = new EventBus();
			const subagentEventBus = new EventBus();
			const extensionsResult = parsedArgs.trustedExtensions?.length
				? await loadTrustedSessionExtensions(sessionOptions, cwd, eventBus)
				: await loadSessionExtensions(sessionOptions, cwd, settingsInstance, eventBus);
			const extensionFlagSink: ExtensionFlagSink = {
				getFlags: () => ExtensionRunner.aggregateFlags(extensionsResult.extensions),
				setFlagValue: (name, value) => {
					extensionsResult.runtime.flagValues.set(name, value);
				},
			};
			const initialArgs = applyExtensionFlags(extensionFlagSink, rawArgs) ?? parsedArgs;
			normalizeContinueSessionArgs(initialArgs, rawArgs);
			if ((parsedArgs.trustedExtensions?.length ?? 0) > 0 && extensionsResult.errors.length > 0) {
				throw new Error(
					`Trusted extension failed to load: ${extensionsResult.errors.map(item => item.error).join("; ")}`,
				);
			}
			for (const message of formatExtensionLoadNotifications(extensionsResult.errors)) {
				if (isInteractive) {
					notifs.push({ kind: "warn", message });
				} else {
					process.stderr.write(`${chalk.yellow(`${message}\n`)}`);
				}
			}
			// Fail fast on stale/typo flags (e.g. `omp --list-models`) now that we
			// know the real extension flag set. Without this check the unrecognized
			// token gets silently consumed and any following positional leaks as the
			// initial prompt — kicking off a real LLM session, MCP connection, and
			// tool calls (issue #2459). Exit code 2 matches the conventional
			// "command line usage error" convention.
			if (reportUnrecognizedFlags(initialArgs)) {
				process.exit(2);
			}
			const processedFiles =
				initialArgs.fileArgs.length > 0
					? await logger.time("processFileArguments", () =>
							processFileArguments(initialArgs.fileArgs, {
								autoResizeImages: settingsInstance.get("images.autoResize"),
							}),
						)
					: undefined;
			const { initialMessage, initialImages } = buildInitialMessage({
				parsed: initialArgs,
				fileText: processedFiles?.text,
				fileImages: processedFiles?.images,
				stdinContent: pipedInput,
			});

			const showStartupSplash = shouldShowStartupSplash({
				configured: settingsInstance.get("startup.showSplash"),
				isInteractive,
				resuming: Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || foreignSource),
				quiet: settingsInstance.get("startup.quiet"),
				timing: Boolean($env.PI_TIMING),
				stdinIsTTY: process.stdin.isTTY,
				stdoutIsTTY: process.stdout.isTTY,
			});

			// Startup changelog is only consumed by interactive mode below; kick the
			// CHANGELOG.md parse off now so it overlaps session creation instead of
			// serializing after it.
			const startupChangelogPromise = isInteractive
				? logger.time(
						"main:getChangelogForDisplay",
						getChangelogForDisplay,
						parsedArgs,
						settingsInstance.get("startup.changelogMode"),
					)
				: undefined;

			const {
				session,
				setToolUIContext,
				modelFallbackMessage,
				lspServers,
				mcpManager,
				startBackgroundModelDiscovery,
			} = await createSession({
				...sessionOptions,
				eventBus,
				subagentEventBus,
				preloadedExtensions: extensionsResult,
			});

			try {
				validateToolNames(initialArgs.tools, session.getAllToolNames());
			} catch (error) {
				await session.dispose();
				throw error;
			}

			// Cold-revive support: a `parked` subagent ref restored from disk (Agent Hub
			// scan, collab mirror, resumed process) has a sessionFile but no in-memory
			// reviver, so `ensureLive` (IRC sends, hub focus) would refuse it. Install a
			// factory — bound to THIS top-level session — that rebuilds the subagent from
			// its persisted JSONL (see persisted-revive.ts). Scoped to the non-ACP
			// bootstrap: ACP keeps several concurrent top-level sessions and a single
			// process-global factory must not be clobbered by the most recent one.
			AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session,
					authStorage,
					modelRegistry,
					settings: settingsInstance,
					enableLsp: sessionOptions.enableLsp ?? true,
					eventBus,
					subagentEventBus,
				}),
				Math.trunc(Number(settingsInstance.get("task.agentIdleTtlMs") ?? 420_000) || 0),
			);
			if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
				authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
			}

			// Runtime provider discovery (opencode-go, models.yml `discovery:`, proxies)
			// populates the registry AFTER the scope was snapshotted at startup; re-resolve
			// once it settles so newly-discovered configured models join the scoped
			// /models list and Ctrl+P cycle, including scopes that initially resolved
			// empty (issue #9220). Fire-and-forget: the prompt must never block on the
			// background pass.
			const configuredScope = parsedArgs.models ?? settingsInstance.get("enabledModels");
			if (isInteractive && configuredScope.length > 0) {
				void rebuildScopedModelsAfterDiscovery(session, parsedArgs, modelRegistry, settingsInstance).catch(error =>
					logger.warn("Scoped model rebuild after discovery failed", { error: String(error) }),
				);
			}

			if (modelFallbackMessage) {
				notifs.push({ kind: "warn", message: modelFallbackMessage });
			}

			const modelRegistryError = modelRegistry.getError();
			if (modelRegistryError) {
				notifs.push({ kind: "error", message: modelRegistryError.message });
			}

			if (!isInteractive && !session.model) {
				if (modelRegistryError) {
					process.stderr.write(`${chalk.red(modelRegistryError.message)}\n\n`);
				}
				if (modelFallbackMessage) {
					process.stderr.write(`${chalk.red(modelFallbackMessage)}\n`);
				} else {
					process.stderr.write(`${chalk.red("No models available.")}\n`);
				}
				process.stderr.write(`${chalk.yellow("\nSet an API key environment variable:")}\n`);
				process.stderr.write("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n");
				process.stderr.write(`${chalk.yellow(`\nOr create ${ModelsConfigFile.path()}`)}\n`);
				process.exit(1);
			}

			if (mode === "rpc" || mode === "rpc-ui") {
				// Branch-only protocol runner: keep RPC host code out of normal interactive startup.
				const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
				stopStartupWatchdog();
				await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined, subagentEventBus, rpcInput);
			} else if (isInteractive) {
				const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);
				const startupChangelog = await startupChangelogPromise;

				const modelScopeNotification = buildModelScopeNotification(
					scopedModels,
					settingsInstance.get("startup.quiet"),
				);
				if (modelScopeNotification) {
					// Routed through the TUI (not stdout): the startup capture owns the
					// terminal in raw mode here, and the TUI's first clearScrollback paint
					// would wipe a pre-TUI line anyway.
					notifs.push(modelScopeNotification);
				}

				if ($env.PI_TIMING) {
					logger.printTimings();
					if (logger.shouldExitAfterTimings()) {
						process.exit(0);
					}
				}
				const startupLease = takeStartupComposerLease();
				try {
					stopStartupWatchdog();
					logger.endTiming();
					await runInteractiveMode(
						session,
						VERSION,
						startupChangelog,
						notifs,
						versionCheckPromise,
						initialArgs.messages,
						setToolUIContext,
						lspServers,
						mcpManager,
						Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || foreignSource),
						deps.forceSetupWizard === true,
						showStartupSplash,
						eventBus,
						subagentEventBus,
						initialMessage,
						initialImages,
						parsedArgs.join,
						startBackgroundModelDiscovery,
						startupLease,
					);
				} finally {
					startupLease?.dispose();
				}
			} else {
				// Branch-only single-shot runner: keep print-mode code out of normal interactive startup.
				stopStartupWatchdog();
				const runPrintMode: RunPrintMode = (await import("./modes/print-mode")).runPrintMode;
				await runPrintMode(session, {
					mode,
					messages: initialArgs.messages,
					initialMessage,
					initialImages,
					printThoughts: initialArgs.printThoughts,
					planYolo: parsedArgs.planYolo,
				});
				if ($env.PI_TIMING) {
					logger.printTimings();
				}
				await session.dispose();
				stopThemeWatcher();
				await postmortem.quit(0);
			}
		}
	} catch (error) {
		stopPendingStartupComposer();
		stopStartupWatchdog();
		throw error;
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
