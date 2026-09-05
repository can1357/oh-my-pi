/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */
import * as fsSync from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { EventLoopKeepalive } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import {
	$env,
	directoryExists,
	getLogPath,
	getProjectDir,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@pk-nerdsaver-ai/pi-utils";
import chalk from "chalk";
import { reset as resetCapabilities } from "./capability";
import { type Args, reportUnrecognizedFlags } from "./cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { selectSession } from "./cli/session-picker";
import { applyStartupCwd } from "./cli/startup-cwd";
import { findConfigFile } from "./config";
import { ModelRegistry } from "./config/model-registry";
import {
	getModelMatchPreferences,
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	type ScopedModel,
} from "./config/model-resolver";
import { ModelsConfigFile } from "./config/models-config";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
} from "./discovery/helpers";
import { injectOmpExtensionCliRoots } from "./discovery/omp-extension-roots";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "./extensibility/plugins/marketplace-auto-update";
import type { MCPManager } from "./mcp";
import { InteractiveMode } from "./modes/interactive-mode";
import type { PrintModeOptions } from "./modes/print-mode";
import { CURRENT_SETUP_VERSION } from "./modes/setup-version";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	loadSessionExtensions,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";
import type { AuthStorage } from "./session/auth-storage";
import { resolveResumableSession, type SessionInfo } from "./session/session-listing";
import { SessionManager } from "./session/session-manager";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { shouldShowStartupSplash } from "./startup-splash";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "./system-prompt";
import { createPersistedSubagentReviverFactory } from "./task/persisted-revive";
import { initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "./thinking";
import type { LspStartupServerInfo } from "./tools";
import {
	getChangelogPath,
	getNewEntries,
	parseChangelog,
	readLastChangelogVersion,
	writeLastChangelogVersion,
} from "./utils/changelog";
import { EventBus } from "./utils/event-bus";
import {
	type ActiveEtherealWorkspace,
	createEtherealWorkspace,
	formatEtherealSummary,
	resolveWorkspaceOptions,
} from "./workspace";

type RunAcpMode = (createSession: AcpSessionFactory) => Promise<never>;
type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;
type RunInteractiveMode = typeof runInteractiveMode;
type RunRpcMode = (
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
) => Promise<never>;

export function writeStartupNotice(parsedArgs: Pick<Args, "mode">, text: string): void {
	(parsedArgs.mode === "json" ? process.stderr : process.stdout).write(text);
}

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return;
	}
	try {
		const response = await fetch("https://registry.npmjs.org/@pk-nerdsaver-ai/pi-coding-agent/latest");
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && Bun.semver.order(latestVersion, currentVersion) > 0) {
			return latestVersion;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

// Todo settings are caller-controlled in protocol modes. Do not host-default them:
// embedders need project-level opt-outs for reminder/prelude prompt injection.
const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"task.isolation.mode",
	"task.isolation.merge",
	"task.isolation.commits",
	"task.eager",
	"task.batch",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.disabledAgents",
	"task.agentModelOverrides",
	// Memory subsystems are off-by-default for RPC/ACP hosts; embedders that want
	// memory should opt in explicitly through their own settings layer.
	"memory.backend",
	"memories.enabled",
	// Advisor is interactive-session assistance. Protocol hosts opt in explicitly
	// instead of inheriting a user's globally-enabled local preference, and when
	// they do opt in they get the default tuning rather than the user's local tuning.
	"advisor.enabled",
	"advisor.subagents",
	"advisor.syncBacklog",
	"advisor.immuneTurns",
];

const RPC_BACKGROUND_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
];

function applyDefaultSettingOverrides(settingPaths: SettingPath[], targetSettings: Settings): void {
	for (const settingPath of settingPaths) {
		// #3207: the schema default only fills holes — explicitly configured
		// values (caller, project, --config overlay, or global) must survive
		// protocol-host startup.
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

const PIPED_STDIN_NOTICE_MS = 5_000;

async function readPipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY !== false) return undefined;
	// stdin is a pipe: a producer that never writes nor closes would block
	// startup forever with zero output. Say what we're blocked on after 1s.
	const notice = setTimeout(() => {
		process.stderr.write(`${chalk.dim("Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…")}\n`);
	}, PIPED_STDIN_NOTICE_MS);
	notice.unref?.();
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

type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export interface AcpSessionFactoryOptions {
	baseOptions: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "apiKey">;
	rawArgs: string[];
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
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
	return async cwd => {
		const nextSettings = await args.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, args.sessionDir);
		const agentId = `acp:${nextSessionManager.getSessionId()}`;
		const { session: nextSession } = await args.createSession({
			...args.baseOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage: args.authStorage,
			modelRegistry: args.modelRegistry,
			agentId,
			hasUI: false,
			enableMCP: false,
		});
		if (args.parsedArgs.apiKey && !args.baseOptions.model && nextSession.model) {
			args.authStorage.setRuntimeApiKey(nextSession.model.provider, args.parsedArgs.apiKey);
		}
		applyExtensionFlags(nextSession.extensionRunner, args.rawArgs);
		return nextSession;
	};
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	changelogMarkdown: string | undefined,
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
	initialMessage?: string,
	initialImages?: ImageContent[],
	titleSystemPrompt?: string,
	joinLink?: string,
	openBackgrounds?: boolean,
): Promise<void> {
	const mode = new InteractiveMode(
		session,
		version,
		changelogMarkdown,
		setExtensionUIContext,
		lspServers,
		mcpManager,
		eventBus,
		titleSystemPrompt,
	);

	// Cold-launch gate: the full setup wizard (every scene + the overlay and
	// their TUI/OAuth/search/theme deps) is heavy, yet the common case only needs
	// to know whether the stored setup version is current. Lazy-load the wizard
	// barrel only when setup is stale, forced, or the explicit startup splash
	// setting needs the shared setup splash renderer.
	const storedSetupVersion = settings.get("setupVersion");
	const setupWizard =
		forceSetupWizard || storedSetupVersion < CURRENT_SETUP_VERSION || showStartupSplash
			? await import("./modes/setup-wizard")
			: undefined;
	const setupScenes = setupWizard
		? await setupWizard.selectSetupScenes(storedSetupVersion, setupWizard.ALL_SCENES, mode, {
				resuming,
				isTTY: process.stdin.isTTY && process.stdout.isTTY,
				setupWizardEnabled: settings.get("startup.setupWizard"),
				force: forceSetupWizard,
			})
		: [];
	const playStartupSplash = showStartupSplash && setupScenes.length === 0;

	await mode.init({
		suppressWelcomeIntro: resuming || setupScenes.length > 0 || playStartupSplash,
		clearInitialTerminalHistory: true,
	});

	if (setupWizard && playStartupSplash) {
		await setupWizard.runStartupSplash(mode);
	}

	if (setupWizard && setupScenes.length > 0) {
		await setupWizard.runSetupWizard(mode, setupScenes);
	}

	versionCheckPromise
		.then(newVersion => {
			if (!settings.get("startup.checkUpdate")) {
				return;
			}
			if (newVersion) {
				mode.showNewVersionNotification(newVersion);
			}
		})
		.catch(() => {});

	// Cold-launch cleanup: the first paint already clears native history, and this
	// replay replaces the welcome/startup frame with the resumed/new transcript.
	// Every in-process session load also uses `clearTerminalHistory`; cold launch
	// follows the same clean-cutover path instead of preserving a previous run's
	// transcript above the fresh one.
	mode.renderInitialMessages({ preserveExistingChat: true, clearTerminalHistory: true });

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

	// `omp bg`: open the Agent Hub immediately after startup.
	if (openBackgrounds) {
		mode.showAgentHub();
	}

	if (initialMessage !== undefined) {
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(message);
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

async function promptForkSession(session: SessionInfo): Promise<SessionPromptResult> {
	if (!process.stdin.isTTY) {
		return "unavailable";
	}
	const message = `Session found in different project: ${session.cwd}. Fork into current directory? [y/N] `;
	pauseStartupWatchdog();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "y" || answer === "yes" ? "accepted" : "declined";
	} finally {
		rl.close();
		resumeStartupWatchdog();
	}
}

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
 * session-resolution flags (`--resume`/`--fork`/cross-project prompts) cannot
 * be satisfied. {@link runRootCommand} catches it and prints a clean stderr
 * message instead of letting it surface as `[Uncaught Exception]`
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

async function getChangelogForDisplay(parsed: Args): Promise<string | undefined> {
	if (parsed.continue || parsed.resume) {
		return undefined;
	}

	const lastVersion = await readLastChangelogVersion();
	if (lastVersion === VERSION) {
		// Steady state: user already saw the current version's changelog. Skip the file read + parse.
		return undefined;
	}

	const changelogPath = getChangelogPath();
	const entries = await parseChangelog(changelogPath);

	if (!lastVersion) {
		if (entries.length > 0) {
			await writeLastChangelogVersion(VERSION);
			return entries.map(e => e.content).join("\n\n");
		}
	} else {
		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			await writeLastChangelogVersion(VERSION);
			return newEntries.map(e => e.content).join("\n\n");
		}
	}

	return undefined;
}

/** Resolves CLI session flags into an existing, forked, in-memory, or cancelled session manager. */
export async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
	askToForkSession: SessionPrompt = promptForkSession,
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
			const normalizedCwd = normalizePathForComparison(cwd);
			const normalizedMatchCwd = normalizePathForComparison(match.session.cwd || cwd);
			if (normalizedCwd !== normalizedMatchCwd) {
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
				const forkPromptResult = await askToForkSession(match.session);
				if (forkPromptResult === "unavailable") {
					throw new SessionResolutionError(
						`Session "${sessionArg}" is in another project (${match.session.cwd}); run interactively to fork it into the current project.`,
					);
				}
				if (forkPromptResult === "declined") {
					// User declined the cross-project fork prompt. Caller distinguishes
					// this cancellation from the "default new session" undefined return
					// by checking `typeof parsed.resume === "string"`.
					return undefined;
				}
				return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
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
	// Check project-local first (.ompk/SYSTEM.md, .pi/SYSTEM.md legacy)
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

export async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): Promise<{ options: CreateAgentSessionOptions; titleSystemPrompt?: string }> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
		autoApprove: parsed.autoApprove ?? false,
	};
	if (parsed.maxTime !== undefined) {
		options.deadline = Date.now() + parsed.maxTime * 1000;
	}

	// Auto-discover SYSTEM.md if no CLI system prompt provided
	const systemPromptSource = parsed.systemPrompt ?? discoverSystemPromptFile();
	const resolvedSystemPrompt = await resolvePromptInput(systemPromptSource, "system prompt");
	const appendPromptSource = parsed.appendSystemPrompt ?? discoverAppendSystemPromptFile();
	const resolvedAppendPrompt = await resolvePromptInput(appendPromptSource, "append system prompt");
	const titleSystemPromptSource = discoverTitleSystemPromptFile();
	const titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	const modelMatchPreferences = getModelMatchPreferences(activeSettings);
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			preferences: modelMatchPreferences,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error) {
			if (!parsed.provider && !parsed.model.includes(":")) {
				// Model not found in built-in registry — defer resolution to after extensions load
				// (extensions may register additional providers/models via registerProvider)
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(1);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			activeSettings.overrideModelRoles({
				default: resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		const remembered = activeSettings.getModelRole("default");
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings: activeSettings,
					matchPreferences: modelMatchPreferences,
					modelRegistry,
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
				// Apply explicit thinking level from remembered role value
				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
				}
			}
		}
		if (!options.model) options.model = scopedModels[0].model;
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		!parsed.continue &&
		!parsed.resume
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	// Scoped models for Ctrl+P cycling - fill in default thinking levels when not explicit
	if (scopedModels.length > 0) {
		// `auto` is a session-level concept only; per-scoped-model (Ctrl+P) thinking
		// overrides stay concrete, so coerce the auto default to "unset" here.
		const defaultThinkingLevelSetting = parseConfiguredThinkingLevel(activeSettings.get("defaultThinkingLevel"));
		const defaultThinkingLevel =
			defaultThinkingLevelSetting === AUTO_THINKING ? undefined : defaultThinkingLevelSetting;
		options.scopedModels = scopedModels.map(scopedModel => ({
			model: scopedModel.model,
			thinkingLevel: scopedModel.explicitThinkingLevel
				? (scopedModel.thinkingLevel ?? defaultThinkingLevel)
				: defaultThinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	applyResolvedSystemPromptInputs(options, resolvedSystemPrompt, resolvedAppendPrompt);

	// Tools
	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}
	if (parsed.noIrc) {
		options.enableIrc = false;
	}

	if (parsed.noLsp) {
		options.enableLsp = false;
	}

	// Skills
	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.projectSkills) {
		activeSettings.override("skills.projectOnly", true);
		if (parsed.skills && parsed.skills.length > 0) {
			activeSettings.override("skills.includeSkills", parsed.skills as string[]);
		}
	} else if (parsed.skills && parsed.skills.length > 0) {
		// Override includeSkills for this session
		activeSettings.override("skills.includeSkills", parsed.skills as string[]);
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	// AGENTS.md
	if (parsed.noAgentMd) {
		options.disableAgentsMd = true;
	}

	// Additional extension paths from CLI
	const cliExtensionPaths = parsed.noExtensions ? [] : [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
	if (cliExtensionPaths.length > 0) {
		options.additionalExtensionPaths = cliExtensionPaths;
	}

	if (parsed.noExtensions) {
		options.disableExtensionDiscovery = true;
		options.additionalExtensionPaths = [];
	}

	return { options, titleSystemPrompt };
}

interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	runAcpMode?: RunAcpMode;
	settings?: Settings;
	runInteractiveMode?: RunInteractiveMode;
	forceSetupWizard?: boolean;
	/** Injectable `--resume` session picker so tests can drive cancel/select flows headlessly. */
	selectSession?: typeof selectSession;
}

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = {},
): Promise<void> {
	logger.startTiming();
	startStartupWatchdog();

	// Initialize theme early with defaults (CLI commands need symbols)
	// Will be re-initialized with user preferences later
	await logger.time("initTheme:initial", initTheme);

	const parsedArgs = parsed;
	await logger.time("applyStartupCwd", applyStartupCwd, parsedArgs);

	const notifs: (InteractiveModeNotify | null)[] = [];

	// Create AuthStorage and ModelRegistry upfront
	const authStorage = await logger.time("discoverAuthStorage", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistry = logger.time("modelRegistry:init", () => new ModelRegistry(authStorage));

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

	let cwd = getProjectDir();
	const settingsInstance =
		deps.settings ?? (await logger.time("settings:init", Settings.init, { cwd, configFiles: parsedArgs.config }));
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
	if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
		Bun.env.PI_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui" || parsedArgs.mode === "acp") {
		Bun.env.PI_NO_TITLE = "1";
	}
	const mode = parsedArgs.mode || "text";
	const isProtocolMode = mode === "rpc" || mode === "rpc-ui" || mode === "acp";
	const sourceCwd = cwd;
	let activeEtherealWorkspace: ActiveEtherealWorkspace | undefined;
	let cancelEtherealCleanup: (() => void) | undefined;
	const finishEtherealWorkspace = async (status: "completed" | "failed", announce: boolean): Promise<void> => {
		if (!activeEtherealWorkspace) return;
		setProjectDir(sourceCwd);
		cwd = getProjectDir();
		const result = await activeEtherealWorkspace.finish(status);
		cancelEtherealCleanup?.();
		cancelEtherealCleanup = undefined;
		if (announce) {
			writeStartupNotice(parsedArgs, formatEtherealSummary(result));
		}
	};
	try {
		const workspaceOptions = resolveWorkspaceOptions(parsedArgs, settingsInstance, sourceCwd);
		if (workspaceOptions.enabled) {
			if (parsedArgs.continue || parsedArgs.resume || parsedArgs.fork || isProtocolMode) {
				process.stderr.write(
					`${chalk.red("--ethereal does not support --continue, --resume, --fork, rpc, rpc-ui, or acp modes yet")}\n`,
				);
				process.exit(2);
				return;
			}
			activeEtherealWorkspace = await logger.time("createEtherealWorkspace", createEtherealWorkspace, {
				sourceCwd,
				rawArgs,
				options: workspaceOptions,
			});
			cancelEtherealCleanup = postmortem.register("ethereal-workspace", async () => {
				await finishEtherealWorkspace("failed", false);
			});
			setProjectDir(activeEtherealWorkspace.runCwd);
			parsedArgs.cwd = getProjectDir();
			cwd = getProjectDir();
			await settingsInstance.reloadForCwd(cwd);
			clearPluginRootsAndCaches();
			resetCapabilities();
		}

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

		// Register CLI-provided extension package paths (`--extension`, `--hook`) so
		// the `omp-plugins` discovery provider can surface their `skills/`, `hooks/`,
		// `tools/`, `commands/`, `rules`, `prompts/`, and `.mcp.json` sub-trees.
		// `--no-extensions` short-circuits both the factory load and the sub-discovery.
		if (!parsedArgs.noExtensions) {
			const cliExtensions = [...(parsedArgs.extensions ?? []), ...(parsedArgs.hooks ?? [])];
			if (cliExtensions.length > 0) {
				injectOmpExtensionCliRoots(cliExtensions, home, getProjectDir());
			}
		}
		// Protocol modes own stdin; treating it as prompt text would consume JSON-RPC frames before their transports start.
		const pipedInput = isProtocolMode ? undefined : await logger.time("readPipedInput", readPipedInput);
		const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
		const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;

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
		// thinking before the session is built — otherwise a passive hideThinkingBlock
		// setting makes the provider omit summaries and the flag prints nothing. An
		// explicit --hide-thinking below still wins.
		if (parsedArgs.printThoughts && !isProtocolMode && !isInteractive) {
			settingsInstance.override("hideThinkingBlock", false);
		}
		// Apply --hide-thinking CLI flag (ephemeral, not persisted)
		if (parsedArgs.hideThinking) {
			settingsInstance.override("hideThinkingBlock", true);
		}
		// Apply --advisor CLI flag (ephemeral, not persisted)
		if (parsedArgs.advisor) {
			settingsInstance.override("advisor.enabled", true);
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

		let scopedModels: ScopedModel[] = [];
		const modelPatterns = parsedArgs.models ?? settingsInstance.get("enabledModels");
		const modelMatchPreferences = getModelMatchPreferences(settingsInstance);
		if (modelPatterns && modelPatterns.length > 0) {
			scopedModels = await logger.time(
				"resolveModelScope",
				resolveModelScope,
				modelPatterns,
				modelRegistry,
				modelMatchPreferences,
			);
		}

		// Create session manager based on CLI flags. SessionResolutionError signals a
		// user-facing failure (unknown --resume/--fork id, non-interactive fork
		// prompt, --fork with --no-session): print + exit cleanly instead of letting
		// it surface as `[Uncaught Exception]` (see issue #2084).
		let sessionManager: SessionManager | undefined;
		try {
			sessionManager = await logger.time(
				"createSessionManager",
				createSessionManager,
				parsedArgs,
				cwd,
				settingsInstance,
			);
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

		// User declined the cross-project fork prompt — exit cleanly with a friendly
		// message rather than letting the decline bubble up as an uncaught exception
		// (see issue #1668).
		if (typeof parsedArgs.resume === "string" && !sessionManager) {
			writeStartupNotice(parsedArgs, `${chalk.dim("Resume cancelled: session is in another project.")}\n`);
			return;
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
			let startInAllScope = false;
			if (folderSessions.length === 0) {
				// Nothing in the current folder — fall back to a global scan so the
				// picker can still open in all-projects scope instead of dead-ending.
				preloadedAllSessions = await logger.time("SessionManager.listAll", SessionManager.listAll);
				if (preloadedAllSessions.length === 0) {
					writeStartupNotice(parsedArgs, `${chalk.dim("No sessions found")}\n`);
					return;
				}
				startInAllScope = true;
			}
			pauseStartupWatchdog();
			const selected = await logger.time("selectSession", deps.selectSession ?? selectSession, folderSessions, {
				allSessions: preloadedAllSessions,
				startInAllScope,
			});
			resumeStartupWatchdog();
			if (!selected) {
				writeStartupNotice(parsedArgs, `${chalk.dim("No session selected")}\n`);
				// Exit instead of returning: startup services (watchdog timers,
				// auth broker sockets) are already live, so a plain return leaves
				// the process hanging with no UI attached.
				process.exit(0);
			}
			// Resuming a session from another project: switch the process into that
			// project's directory and refresh cwd-derived caches before the session is
			// built, so settings discovery, plugins, and capabilities all scope to it.
			// Skip the chdir when the recorded project directory is gone: `setProjectDir`
			// would throw on the missing path. `SessionManager.open` then falls back to
			// the launch cwd, so the resumed session simply stays where the user is.
			if (
				selected.cwd &&
				normalizePathForComparison(selected.cwd) !== normalizePathForComparison(getProjectDir()) &&
				(await directoryExists(selected.cwd))
			) {
				// Let the original (launch-cwd) plugin-root preload settle first so its
				// late resolution can't clobber the re-warm we trigger below.
				await pluginPreloadPromise.catch(() => {});
				setProjectDir(selected.cwd);
				clearPluginRootsAndCaches();
				resetCapabilities();
				cwd = getProjectDir();
				// Re-scope project settings (.claude/settings.yml etc.) to the resumed
				// project in place so the session is built with its configuration.
				await settingsInstance.reloadForCwd(cwd);
			}
			sessionManager = await SessionManager.open(selected.path);
		}

		await pluginPreloadPromise;

		scheduleMarketplaceAutoUpdate({
			autoUpdate: settingsInstance.get("marketplace.autoUpdate"),
			resolveActiveProjectRegistryPath,
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});

		const { options: sessionOptions, titleSystemPrompt } = await logger.time(
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

		// OTEL: register the global OTLP trace exporter when an OTLP endpoint is
		// configured via env, then switch on the agent loop's telemetry so its
		// GenAI spans (invoke_agent / chat / execute_tool) are actually emitted.
		// Both are no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset. An empty config
		// is enough to enable telemetry — content capture is governed by the
		// standard OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT env var.
		await logger.time("initTelemetryExport", initTelemetryExport);
		if (isTelemetryExportEnabled()) {
			sessionOptions.telemetry = {};
		}

		// Handle CLI --api-key as runtime override (not persisted)
		if (parsedArgs.apiKey) {
			if (!sessionOptions.model && !sessionOptions.modelPattern) {
				process.stderr.write(
					`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
				);
				await finishEtherealWorkspace("failed", false);
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
			const eventBus = new EventBus();
			const extensionsResult = await loadSessionExtensions(sessionOptions, cwd, settingsInstance, eventBus);
			const extensionFlagSink: ExtensionFlagSink = {
				getFlags: () => ExtensionRunner.aggregateFlags(extensionsResult.extensions),
				setFlagValue: (name, value) => {
					extensionsResult.runtime.flagValues.set(name, value);
				},
			};
			const initialArgs = applyExtensionFlags(extensionFlagSink, rawArgs) ?? parsedArgs;
			// Fail fast on stale/typo flags (e.g. `omp --list-models`) now that we
			// know the real extension flag set. Without this check the unrecognized
			// token gets silently consumed and any following positional leaks as the
			// initial prompt — kicking off a real LLM session, MCP connection, and
			// tool calls (issue #2459). Exit code 2 matches the conventional
			// "command line usage error" convention.
			if (reportUnrecognizedFlags(initialArgs)) {
				await finishEtherealWorkspace("failed", false);
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
				resuming: Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
				quiet: settingsInstance.get("startup.quiet"),
				timing: Boolean($env.PI_TIMING),
				stdinIsTTY: process.stdin.isTTY,
				stdoutIsTTY: process.stdout.isTTY,
			});

			const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager } = await createSession({
				...sessionOptions,
				eventBus,
				preloadedExtensions: extensionsResult,
			});

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
				}),
				Math.trunc(Number(settingsInstance.get("task.agentIdleTtlMs") ?? 420_000) || 0),
			);
			if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
				authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
			}

			if (modelFallbackMessage) {
				notifs.push({ kind: "warn", message: modelFallbackMessage });
			}

			const modelRegistryError = modelRegistry.getError();
			if (modelRegistryError) {
				notifs.push({ kind: "error", message: modelRegistryError.message });
			}

			if (!isInteractive && !session.model) {
				if (modelFallbackMessage) {
					process.stderr.write(`${chalk.red(modelFallbackMessage)}\n`);
				} else {
					process.stderr.write(`${chalk.red("No models available.")}\n`);
				}
				process.stderr.write(`${chalk.yellow("\nSet an API key environment variable:")}\n`);
				process.stderr.write("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n");
				process.stderr.write(`${chalk.yellow(`\nOr create ${ModelsConfigFile.path()}`)}\n`);
				await finishEtherealWorkspace("failed", false);
				process.exit(1);
			}

			if (mode === "rpc" || mode === "rpc-ui") {
				// Branch-only protocol runner: keep RPC host code out of normal interactive startup.
				const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
				stopStartupWatchdog();
				await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined, eventBus);
			} else if (isInteractive) {
				const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);
				const changelogMarkdown = await logger.time(
					"main:getChangelogForDisplay",
					getChangelogForDisplay,
					parsedArgs,
				);

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

				stopStartupWatchdog();
				logger.endTiming();
				const runInteractiveModeImpl = deps.runInteractiveMode ?? runInteractiveMode;
				await runInteractiveModeImpl(
					session,
					VERSION,
					changelogMarkdown,
					notifs,
					versionCheckPromise,
					initialArgs.messages,
					setToolUIContext,
					lspServers,
					mcpManager,
					Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
					deps.forceSetupWizard === true,
					showStartupSplash,
					eventBus,
					initialMessage,
					initialImages,
					titleSystemPrompt,
					parsedArgs.join,
					parsedArgs.openBackgrounds,
				);
				await finishEtherealWorkspace("completed", true);
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
				});
				if ($env.PI_TIMING) {
					logger.printTimings();
				}
				await session.dispose();
				stopThemeWatcher();
				await finishEtherealWorkspace("completed", true);
				if (activeEtherealWorkspace) {
					setProjectDir(sourceCwd);
					cwd = getProjectDir();
				}
				await postmortem.quit(0);
			}
		}
	} catch (error) {
		if (activeEtherealWorkspace) {
			try {
				await finishEtherealWorkspace("failed", false);
			} catch (finishError) {
				const err = finishError instanceof Error ? finishError : new Error(String(finishError));
				logger.error("Ethereal workspace finalization failed", { err });
			}
		}
		throw error;
	} finally {
		cancelEtherealCleanup?.();
		if (activeEtherealWorkspace) {
			setProjectDir(sourceCwd);
		}
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
