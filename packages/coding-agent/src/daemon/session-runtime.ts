import * as os from "node:os";
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { logger, type postmortem, setProjectDir, VERSION } from "@oh-my-pi/pi-utils";
import { createProjectDirScope, getActiveProfile, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { reset as resetCapabilities } from "../capability";
import { type Args, parseArgs } from "../cli/args";
import { applyExtensionFlags } from "../cli/extension-flags";
import { processFileArguments } from "../cli/file-processor";
import { buildInitialMessage } from "../cli/initial-message";
import { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelScope, type ScopedModel } from "../config/model-resolver";
import { bindSettingsToProjectContext, Settings } from "../config/settings";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	resolveActiveProjectRegistryPath,
} from "../discovery/helpers";
import { injectOmpExtensionCliRoots } from "../discovery/omp-extension-roots";
import type { ContextUsage, ExtensionUIContext } from "../extensibility/extensions/types";
import { buildSkillPromptMessage, parseSkillInvocation } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { buildSessionOptions, createSessionManager, normalizeContinueSessionArgs } from "../main";
import { InteractiveMode } from "../modes/interactive-mode";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "../modes/rpc/host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "../modes/rpc/host-uris";
import type { RpcCommand, RpcSessionState } from "../modes/rpc/rpc-types";
import { submitInteractiveInput } from "../modes/submit-interactive-input";
import { initTheme } from "../modes/theme/theme";
import { type AgentRegistry, createAgentRegistryScope } from "../registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import {
	type AgentSession,
	type AgentSessionEventListener,
	coreQueueMode,
	type QueueMode,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import type { TodoPhase } from "../tools/todo";
import { resolveStartupChangelogForDisplay } from "../utils/changelog";
import { calculateTokensPerSecond } from "../utils/token-rate";
import { DAEMON_PROTOCOL_MAJOR } from "./protocol";
import type { DaemonConnectionSnapshot } from "./status";
import { HostedTerminal, type HostedTerminalDescriptor } from "./terminal-bridge";

/** Narrow session surface owned by the daemon registry. */
export type DaemonSession = {
	readonly prompt: AgentSession["prompt"];
	readonly steer?: AgentSession["steer"];
	readonly followUp?: AgentSession["followUp"];
	readonly abort: AgentSession["abort"];
	readonly dispose: AgentSession["dispose"];
	readonly subscribe: AgentSession["subscribe"];
	readonly sessionId: string;
	readonly agent?: {
		state?: {
			messages?: readonly AgentMessage[];
			systemPrompt?: string[];
			tools?: readonly unknown[];
		};
		setTools?: (tools: readonly unknown[]) => void;
	};
	readonly sessionManager?: SessionManager;
	readonly state?: { messages?: readonly AgentMessage[] };
	readonly model?: Model;
	readonly thinkingLevel?: ThinkingLevel;
	readonly isStreaming?: boolean;
	readonly isCompacting?: boolean;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	readonly interruptMode?: "immediate" | "wait";
	readonly sessionFile?: string;
	readonly sessionName?: string;
	readonly autoCompactionEnabled?: boolean;
	readonly queuedMessageCount?: number;
	readonly systemPrompt?: string[];
	readonly getContextUsage?: () => ContextUsage | undefined;
	readonly setModel?: (model: Model) => Promise<void>;
	readonly getAvailableModels?: () => Model[];
	readonly cycleModel?: (
		direction?: "forward" | "backward",
	) => Promise<{ model: Model; thinkingLevel?: ThinkingLevel } | undefined>;
	readonly setThinkingLevel?: (level: ConfiguredThinkingLevel | undefined, persist?: boolean) => void;
	readonly cycleThinkingLevel?: () => ConfiguredThinkingLevel | undefined;
	readonly setSteeringMode?: (mode: QueueMode) => void;
	readonly setFollowUpMode?: (mode: QueueMode) => void;
	readonly setInterruptMode?: (mode: "immediate" | "wait") => void;
	readonly setTodoPhases?: (phases: TodoPhase[]) => void;
	readonly getTodoPhases?: () => TodoPhase[];
	readonly isFastModeEnabled?: AgentSession["isFastModeEnabled"];
	readonly isFastModeActive?: AgentSession["isFastModeActive"];
};

export type DaemonSessionSnapshot = {
	state: RpcSessionState;
	cwd: string;
	entries: unknown[];
	header?: unknown;
};

export type DaemonSessionRuntime = {
	readonly sessionId: string;
	readonly cwd: string;
	readonly session: DaemonSession;
	readonly protectedJobCount?: () => number;
	snapshot(): DaemonSessionSnapshot;
	command(command: unknown, attachmentId?: string): Promise<unknown>;
	dispose(reason?: postmortem.Reason): Promise<void>;
	subscribe(listener: AgentSessionEventListener): () => void;
};

export type DaemonSessionRuntimeFactory = (options: CreateAgentSessionRuntimeOptions) => Promise<DaemonSessionRuntime>;

export type DaemonSessionCreateOverrides = {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	argv?: string[];
	/** Terminal-identity env of the creating client (never the full env). */
	clientEnv?: Record<string, string>;
};

export type HostedServerControls = {
	getSnapshot(): DaemonConnectionSnapshot;
	sessions?(): Promise<string> | string;
	reconnect?(): Promise<void> | void;
	stop?():
		| Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>
		| { shutdown?: boolean; blockers?: string[] }
		| undefined;
};

export type CreateAgentSessionRuntimeOptions = {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	baseOptions?: CreateAgentSessionOptions;
	overrides?: DaemonSessionCreateOverrides;
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	serverControls?: HostedServerControls;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcCommand(value: unknown): value is RpcCommand {
	return isRecord(value) && typeof value.type === "string";
}
function isExtensionUIResponse(value: unknown): value is Record<string, unknown> & {
	type: "extension_ui_response";
	id: string;
} {
	return isRecord(value) && value.type === "extension_ui_response" && typeof value.id === "string";
}

function sessionState(
	session: DaemonSession,
	sessionId: string,
	cwd?: string,
	result?: CreateAgentSessionResult,
): RpcSessionState {
	const messages = session.state?.messages ?? session.agent?.state?.messages;
	const tools = session.agent?.state?.tools ?? [];
	const availableToolNames = tools.flatMap(tool =>
		isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
	);
	const mcpManager = result?.mcpManager;
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming ?? false,
		isCompacting: session.isCompacting ?? false,
		steeringMode: coreQueueMode(session.steeringMode ?? "all"),
		followUpMode: coreQueueMode(session.followUpMode ?? "all"),
		interruptMode: session.interruptMode ?? "immediate",
		sessionFile: session.sessionFile,
		// The state describes the underlying SESSION, not the registry record:
		// the registry id is a per-daemon transport handle (a random UUID that
		// dies with the daemon), while consumers like the resume hint need the
		// persisted session's own id — `--resume <registry-id>` can never match
		// a session file.
		sessionId: session.sessionId ?? sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled ?? true,
		messageCount: messages?.length ?? 0,
		queuedMessageCount: session.queuedMessageCount ?? 0,
		todoPhases: session.getTodoPhases?.() ?? [],
		fastModeEnabled: session.isFastModeEnabled?.() ?? false,
		fastModeActive: session.isFastModeActive?.() ?? false,
		tokensPerSecond: calculateTokensPerSecond(messages ?? [], session.isStreaming ?? false),
		systemPrompt: session.systemPrompt ?? session.agent?.state?.systemPrompt,
		contextUsage: session.getContextUsage?.(),
		cwd,
		lspServers: result?.lspServers?.map(server => ({
			name: server.name,
			status: server.status,
			fileTypes: server.fileTypes,
			...(server.error === undefined ? {} : { error: server.error }),
		})),
		mcpServers: mcpManager?.getAllServerNames().map(name => ({
			name,
			status: mcpManager.getConnectionStatus(name),
		})),
		availableToolNames,
	};
}

function sessionSnapshot(
	session: DaemonSession,
	cwd: string,
	requestedId: string,
	manager?: SessionManager,
): DaemonSessionSnapshot {
	return {
		state: sessionState(session, requestedId, cwd),
		cwd,
		entries: manager?.getEntries() ?? [],
		header: manager?.getHeader(),
	};
}

function commandImages(value: unknown): ImageContent[] | undefined {
	return Array.isArray(value) ? (value as ImageContent[]) : undefined;
}

function commandMessage(value: unknown): string {
	if (typeof value !== "string") throw new Error("session command message must be a string");
	return value;
}

type CliLaunchPreparation = {
	parsed: Args;
	sessionManager: SessionManager;
	createOptions: CreateAgentSessionOptions;
};

async function prepareCliLaunch(
	cwd: string,
	argv: string[],
	baseOptions?: CreateAgentSessionOptions,
	sessionId?: string,
): Promise<CliLaunchPreparation> {
	setProjectDir(cwd);
	const parsed = parseArgs(argv);
	normalizeContinueSessionArgs(parsed, argv);
	const home = os.homedir();
	if (!parsed.noExtensions) {
		const cliExtensions = [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
		if (cliExtensions.length > 0) injectOmpExtensionCliRoots(cliExtensions, home, cwd);
	}
	if (parsed.pluginDirs && parsed.pluginDirs.length > 0) {
		await injectPluginDirRoots(home, parsed.pluginDirs, cwd);
	}
	const activeSettings = await Settings.loadIsolated({
		cwd,
		configFiles: parsed.config,
	});
	bindSettingsToProjectContext(activeSettings);
	if (parsed.approvalMode) activeSettings.override("tools.approvalMode", parsed.approvalMode);
	else if (parsed.autoApprove) activeSettings.override("tools.approvalMode", "yolo");
	if (parsed.hideThinking) activeSettings.override("hideThinkingBlock", true);
	if (parsed.advisor) activeSettings.override("advisor.enabled", true);
	if (parsed.smol || parsed.slow || parsed.plan) {
		activeSettings.overrideModelRoles({
			smol: parsed.smol,
			slow: parsed.slow,
			plan: parsed.plan,
		});
	}
	if (parsed.noPty) Bun.env.PI_NO_PTY = "1";
	if (parsed.noTitle) Bun.env.PI_NO_TITLE = "1";

	const canShareShardResources = !parsed.apiKey;
	const sharedModelRegistry = canShareShardResources ? baseOptions?.modelRegistry : undefined;
	const sharedAuthStorage = canShareShardResources ? baseOptions?.authStorage : undefined;
	const authStorage = sharedModelRegistry?.authStorage ?? sharedAuthStorage ?? (await discoverAuthStorage());
	const modelRegistry = sharedModelRegistry ?? new ModelRegistry(authStorage);
	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? activeSettings.get("enabledModels");
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(
			modelPatterns,
			modelRegistry,
			getModelMatchPreferences(activeSettings),
			activeSettings,
		);
	}
	if (parsed.resume === true) throw new Error("Bare --resume must be resolved before daemon session creation");
	const resolvedManager =
		parsed.noSession && sessionId
			? SessionManager.inMemory(cwd, undefined, sessionId)
			: await createSessionManager(parsed, cwd, activeSettings);
	// An explicit session selector must never degrade into a fresh empty
	// session: interactive mode treats an undefined manager as a user
	// cancellation, but a hosted launch has nobody to cancel — surfacing the
	// error beats silently hosting the wrong (empty) transcript.
	if (resolvedManager === undefined && (typeof parsed.resume === "string" || parsed.fork || parsed.continue)) {
		throw new Error(
			`Session selection for ${JSON.stringify(argv)} was cancelled; refusing to host a new empty session`,
		);
	}
	const sessionManager = resolvedManager ?? SessionManager.create(cwd, parsed.sessionDir, undefined, sessionId);
	const createOptions = await buildSessionOptions(parsed, scopedModels, sessionManager, modelRegistry, activeSettings);
	createOptions.authStorage = authStorage;
	createOptions.modelRegistry = modelRegistry;
	createOptions.settings = activeSettings;
	createOptions.hasUI = true;
	if (canShareShardResources) createOptions.mcpManagerPool = baseOptions?.mcpManagerPool;
	if (parsed.apiKey) {
		if (!createOptions.model) throw new Error("--api-key requires an explicit model");
		authStorage.setRuntimeApiKey(createOptions.model.provider, parsed.apiKey);
	}
	return { parsed, sessionManager, createOptions };
}

/**
 * Construct the daemon-owned AgentSession using the same SDK factory used by
 * ACP. The factory option exists so tests and embedders can provide a narrow
 * runtime without starting the model/auth stack.
 */
async function createAgentSessionRuntimeInScope(
	options: CreateAgentSessionRuntimeOptions,
	registry: AgentRegistry,
): Promise<DaemonSessionRuntime> {
	const create = options.createSession ?? createAgentSession;
	const overrides = options.overrides;
	const cliLaunch =
		!options.sessionFile && overrides?.argv
			? await prepareCliLaunch(options.cwd, overrides.argv, options.baseOptions, options.sessionId)
			: undefined;
	const sessionManager =
		cliLaunch?.sessionManager ??
		(options.sessionFile
			? await SessionManager.open(options.sessionFile, options.sessionDir, undefined, { initialCwd: options.cwd })
			: SessionManager.create(options.cwd, options.sessionDir, undefined, options.sessionId));
	const modelPattern =
		!cliLaunch && (overrides?.provider || overrides?.model)
			? `${overrides.provider ?? ""}${overrides.provider && overrides.model ? "/" : ""}${overrides.model ?? "*"}`
			: undefined;
	const thinkingLevel =
		cliLaunch || overrides?.thinkingLevel === undefined
			? undefined
			: parseConfiguredThinkingLevel(overrides.thinkingLevel);
	if (!cliLaunch && overrides?.thinkingLevel !== undefined && thinkingLevel === undefined) {
		await sessionManager.close().catch(() => undefined);
		throw new Error(`Unknown daemon thinking level: ${overrides.thinkingLevel}`);
	}
	const createOptions: CreateAgentSessionOptions = cliLaunch?.createOptions ?? {
		...(options.baseOptions ?? {}),
		cwd: options.cwd,
		sessionManager,
		hasUI: true,
		...(modelPattern === undefined ? {} : { modelPattern }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
	if (createOptions.agentRegistry !== registry) {
		createOptions.agentRegistry = registry;
	}
	let result: CreateAgentSessionResult;
	try {
		result = await create(createOptions);
	} catch (error) {
		await sessionManager.close().catch(() => undefined);
		throw error;
	}
	bindSettingsToProjectContext(result.session.settings);
	const session = result.session as unknown as DaemonSession;
	const sessionId = options.sessionId ?? session.sessionId;
	if (overrides?.steeringMode) session.setSteeringMode?.(overrides.steeringMode);
	if (overrides?.followUpMode) session.setFollowUpMode?.(overrides.followUpMode);
	if (thinkingLevel !== undefined) session.setThinkingLevel?.(thinkingLevel, true);
	// Terminal-identity env of the creating client: extensions (e.g. herdr's
	// pane status) must see the attached client's terminal, never the daemon
	// process env, which belongs to whichever client spawned the daemon first.
	if (overrides?.clientEnv) result.session.extensionRunner?.setClientEnv(overrides.clientEnv);
	let initialMessage: string | undefined;
	let initialImages: ImageContent[] | undefined;
	let initialMessages: string[] = [];
	let skipStartupChangelog = false;
	if (cliLaunch && overrides?.argv) {
		const initialArgs = applyExtensionFlags(result.session.extensionRunner, overrides.argv) ?? cliLaunch.parsed;
		skipStartupChangelog = Boolean(initialArgs.continue || initialArgs.resume);
		if (initialArgs.unrecognizedFlags.length > 0) {
			await result.session.dispose();
			throw new Error(`Unrecognized flag: ${initialArgs.unrecognizedFlags[0]}`);
		}
		const processedFiles =
			initialArgs.fileArgs.length > 0
				? await processFileArguments(initialArgs.fileArgs, {
						autoResizeImages: result.session.settings.get("images.autoResize"),
					})
				: undefined;
		({ initialMessage, initialImages } = buildInitialMessage({
			parsed: initialArgs,
			fileText: processedFiles?.text,
			fileImages: processedFiles?.images,
		}));
		initialMessages = [...initialArgs.messages];
	}
	const listeners = new Set<AgentSessionEventListener>();
	const unsubscribeSession = session.subscribe(event => {
		for (const listener of listeners) listener(event);
	});
	const emitBridgeEvent = (event: unknown): void => {
		for (const listener of listeners) listener(event as never);
	};
	const getAvailableCommands = async () => buildAvailableSlashCommands(result.session);
	const tryRunSkillCommand = async (text: string, streamingBehavior?: "steer" | "followUp"): Promise<boolean> => {
		if (!result.session.skillsSettings?.enableSkillCommands) return false;
		const parsed = parseSkillInvocation(text);
		if (!parsed) return false;
		const skill = result.session.skills.find(candidate => candidate.name === parsed.name);
		if (!skill) return false;
		const built = await buildSkillPromptMessage(skill, parsed.args, "user");
		await result.session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			},
			{ streamingBehavior },
		);
		return true;
	};
	const emitAvailableCommands = async (): Promise<void> => {
		emitBridgeEvent({
			type: "available_commands_update",
			commands: await getAvailableCommands(),
		});
	};
	const reloadPluginState = async (): Promise<void> => {
		const cwd = result.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		result.session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommands();
	};
	const unsubscribeCommandMetadata = result.session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommands();
	});
	const hostToolBridge = new RpcHostToolBridge(frame => emitBridgeEvent(frame));
	const hostUriBridge = new RpcHostUriBridge(frame => emitBridgeEvent(frame));
	const pendingExtensionResponses = new Map<string, (response: Record<string, unknown>) => void>();
	const extensionDialog = (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const id = crypto.randomUUID();
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		pendingExtensionResponses.set(id, resolve);
		emitBridgeEvent({ type: "extension_ui_request", id, ...request });
		return promise;
	};
	const extensionUiContext = {
		timeoutStartsOnPresentation: true,
		select: async (title: string, options: Array<{ label: string } | string>) => {
			const labels = options.map(option => (typeof option === "string" ? option : option.label));
			const response = await extensionDialog({
				method: "select",
				title,
				options: labels,
			});
			return response.cancelled === true
				? undefined
				: typeof response.value === "string"
					? response.value
					: undefined;
		},
		confirm: async (title: string, message: string) => {
			const response = await extensionDialog({
				method: "confirm",
				title,
				message,
			});
			return response.cancelled !== true && response.confirmed === true;
		},
		input: async (title: string, placeholder?: string) => {
			const response = await extensionDialog({
				method: "input",
				title,
				placeholder,
			});
			return response.cancelled === true
				? undefined
				: typeof response.value === "string"
					? response.value
					: undefined;
		},
		notify: (message: string, notifyType?: "info" | "warning" | "error") =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType,
			}),
		onTerminalInput: () => () => undefined,
		setStatus: (statusKey: string, statusText: string | undefined) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey,
				statusText,
			}),
		setWorkingMessage: (statusText?: string) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: "working",
				statusText,
			}),
		setWidget: (widgetKey: string, content: string[] | string | undefined, widgetOptions?: { placement?: string }) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey,
				widgetLines: typeof content === "string" ? [content] : content,
				widgetPlacement: widgetOptions?.placement,
			}),
		setFooter: () => undefined,
		setHeader: () => undefined,
		setTitle: (title: string) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			}),
		custom: async () => undefined,
		setEditorText: (text: string) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			}),
		pasteToEditor: (text: string) =>
			emitBridgeEvent({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			}),
		getEditorText: () => "",
		editor: async (
			title: string,
			prefill?: string,
			_dialogOptions?: unknown,
			editorOptions?: { promptStyle?: boolean },
		) => {
			const response = await extensionDialog({
				method: "editor",
				title,
				prefill,
				promptStyle: editorOptions?.promptStyle,
			});
			return response.cancelled === true
				? undefined
				: typeof response.value === "string"
					? response.value
					: undefined;
		},
		addAutocompleteProvider: () => undefined,
		setEditorComponent: () => undefined,
		theme: {},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({
			success: false,
			error: "Theme changes are client-owned",
		}),
		getToolsExpanded: () => false,
		setToolsExpanded: () => undefined,
	} as unknown as ExtensionUIContext;
	result.setToolUIContext?.(extensionUiContext, true);
	let startupInputsSubmitted = false;
	let hosted:
		| {
				attachmentId: string;
				terminal: HostedTerminal;
				mode: InteractiveMode;
				task: Promise<void>;
		  }
		| undefined;

	const startHostedInteractive = async (attachmentId: string, descriptor: HostedTerminalDescriptor): Promise<void> => {
		if (hosted) throw new Error("An interactive terminal is already attached");
		// A reattach may come from a different terminal (pane/multiplexer);
		// refresh the per-session client identity for extensions.
		if (descriptor.clientEnv) result.session.extensionRunner?.setClientEnv(descriptor.clientEnv);
		const terminal = new HostedTerminal(descriptor);
		terminal.setOutput(data => emitBridgeEvent({ type: "terminal_output", data }));
		const sessionSettings = result.session.settings;
		await initTheme(
			true,
			sessionSettings.get("symbolPreset"),
			sessionSettings.get("colorBlindMode"),
			sessionSettings.get("theme.dark"),
			sessionSettings.get("theme.light"),
		);
		setProjectDir(result.session.sessionManager.getCwd());
		const startupChangelog = skipStartupChangelog
			? undefined
			: await resolveStartupChangelogForDisplay({
					mode: sessionSettings.get("startup.changelogMode"),
					currentVersion: VERSION,
				});
		const mode = new InteractiveMode(
			result.session,
			VERSION,
			startupChangelog,
			result.setToolUIContext,
			result.lspServers,
			result.mcpManager,
			result.eventBus,
			undefined,
			result.subagentEventBus,
			{
				terminal,
				onDetach: (reason, error) => {
					terminal.setOutput(undefined);
					emitBridgeEvent({
						type: "terminal_closed",
						reason,
						...(error === undefined ? {} : { error }),
					});
				},
			},
		);
		const fallbackServerSnapshot: DaemonConnectionSnapshot = {
			state: "connected",
			shard: {
				profile: getActiveProfile() ?? null,
			},
			serverVersion: VERSION,
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			sessionCount: 1,
		};
		const serverControls = options.serverControls ?? {
			getSnapshot: () => fallbackServerSnapshot,
			sessions: () => JSON.stringify([{ sessionId, cwd: options.cwd }]),
			reconnect: () => undefined,
		};
		const getSessionServerSnapshot = (): DaemonConnectionSnapshot => {
			const snapshot = serverControls.getSnapshot();
			return snapshot.state === "connected" ? { ...snapshot, sessionId } : snapshot;
		};
		const sessionServerControls: HostedServerControls = {
			...serverControls,
			getSnapshot: getSessionServerSnapshot,
		};
		(mode as InteractiveMode & { server: HostedServerControls }).server = sessionServerControls;
		mode.setDaemonSnapshot(sessionServerControls.getSnapshot());
		await mode.init({ clearInitialTerminalHistory: true });
		mode.setDaemonSnapshot(sessionServerControls.getSnapshot());
		mode.renderInitialMessages({
			preserveExistingChat: true,
			clearTerminalHistory: true,
		});
		const hostedRecord = {
			attachmentId,
			terminal,
			mode,
			task: Promise.resolve(),
		};
		hosted = hostedRecord;
		hostedRecord.task = (async () => {
			try {
				if (!startupInputsSubmitted) {
					startupInputsSubmitted = true;
					if (initialMessage !== undefined) {
						await result.session.prompt(initialMessage, {
							images: initialImages,
						});
					}
					for (const message of initialMessages) await result.session.prompt(message);
				}
				while (!mode.isShuttingDown) {
					const input = await mode.getUserInput();
					if (mode.isShuttingDown) break;
					await submitInteractiveInput(mode, result.session, input);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				mode.detachHosted("error", message);
			} finally {
				if (hosted === hostedRecord) hosted = undefined;
			}
		})();
	};

	return {
		sessionId,
		cwd: options.cwd,
		session,
		protectedJobCount: () => 0,
		snapshot: () => {
			const cwd = getProjectDir();
			const snapshot = sessionSnapshot(session, cwd, sessionId, sessionManager);
			snapshot.state = sessionState(session, sessionId, cwd, result);
			return snapshot;
		},
		command: async (command, attachmentId) => {
			if (isRpcHostToolResult(command)) {
				if (!hostToolBridge.handleResult(command)) throw new Error(`Unknown host tool result: ${command.id}`);
				return {};
			}
			if (isRpcHostToolUpdate(command)) {
				if (!hostToolBridge.handleUpdate(command)) throw new Error(`Unknown host tool update: ${command.id}`);
				return {};
			}
			if (isRpcHostUriResult(command)) {
				if (!hostUriBridge.handleResult(command)) throw new Error(`Unknown host URI result: ${command.id}`);
				return {};
			}
			if (isExtensionUIResponse(command)) {
				pendingExtensionResponses.get(command.id)?.(command);
				pendingExtensionResponses.delete(command.id);
				return {};
			}
			if (!isRpcCommand(command)) throw new Error("session command requires a typed RpcCommand");
			switch (command.type) {
				case "terminal_start": {
					if (!attachmentId) throw new Error("Interactive terminal command requires an attachment");
					let active = hosted;
					if (active && (active.attachmentId !== attachmentId || active.mode.isShuttingDown)) {
						// A terminal_start can land while a defunct hosted terminal
						// lingers: either the registry replaced the interactive
						// attachment (different id — its fire-and-forget terminal_detach
						// has not finished), or the SAME attachment reconnected after a
						// server-observed drop already put its hosted mode into
						// shutdown. Both used to leave the client on a permanently
						// blank screen (no-op or throw, and a failed terminal_start is
						// never retried). Hand over WITHOUT awaiting the old task: an
						// in-flight turn pins it for the turn's whole duration (the
						// session owns that work, not the terminal), and its
						// finally-guard only clears its own registration. A healthy
						// same-id host stays untouched so an unnoticed transport blip
						// resumes without resetting the TUI.
						active.mode.detachHosted();
						if (hosted === active) hosted = undefined;
						active = undefined;
					}
					if (!active) await startHostedInteractive(attachmentId, command.terminal);
					return {};
				}
				case "terminal_input":
					if (!hosted || hosted.attachmentId !== attachmentId)
						throw new Error("Interactive terminal is not attached");
					hosted.terminal.input(command.data);
					return {};
				case "terminal_resize":
					if (!hosted || hosted.attachmentId !== attachmentId)
						throw new Error("Interactive terminal is not attached");
					hosted.terminal.resize(command.size);
					return {};
				case "terminal_appearance":
					if (!hosted || hosted.attachmentId !== attachmentId)
						throw new Error("Interactive terminal is not attached");
					hosted.terminal.setAppearance(command.appearance);
					return {};
				case "terminal_detach": {
					const active = hosted;
					if (active && active.attachmentId === attachmentId) active.mode.detachHosted();
					return {};
				}
				case "prompt": {
					if (await tryRunSkillCommand(commandMessage(command.message), command.streamingBehavior))
						return { agentInvoked: true };
					return {
						agentInvoked: await session.prompt(commandMessage(command.message), {
							images: commandImages(command.images),
							streamingBehavior: command.streamingBehavior,
						}),
					};
				}
				case "steer":
					if (!session.steer) throw new Error("Steering is unavailable for this daemon session");
					await session.steer(commandMessage(command.message), commandImages(command.images));
					return {};
				case "follow_up":
					if (!session.followUp) throw new Error("Follow-up is unavailable for this daemon session");
					await session.followUp(commandMessage(command.message), commandImages(command.images));
					return {};
				case "abort":
					await session.abort();
					return {};
				case "abort_and_prompt":
					await session.abort();
					return {
						agentInvoked: await session.prompt(commandMessage(command.message), {
							images: commandImages(command.images),
						}),
					};
				case "get_state":
					return sessionState(session, sessionId, options.cwd, result);
				case "get_available_commands":
					return { commands: await getAvailableCommands() };
				case "execute_slash_command": {
					if (await tryRunSkillCommand(command.text)) return { agentInvoked: true };
					const slashResult = await executeAcpBuiltinSlashCommand(command.text, {
						session: result.session,
						sessionManager,
						settings: result.session.settings,
						cwd: result.session.sessionManager.getCwd(),
						output: text =>
							emitBridgeEvent({
								type: "notice",
								level: "info",
								message: text,
							}),
						refreshCommands: emitAvailableCommands,
						reloadPlugins: reloadPluginState,
						notifyTitleChanged: () =>
							emitBridgeEvent({
								type: "session_info_update",
								title: result.session.sessionName,
								sessionId: result.session.sessionId,
							}),
						notifyConfigChanged: () =>
							emitBridgeEvent({
								type: "config_update",
								model: result.session.model,
								thinkingLevel: result.session.thinkingLevel,
							}),
					});
					if (slashResult === false) {
						const parsed = parseSlashCommand(command.text);
						const tuiOnlyBuiltin = parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
						if (tuiOnlyBuiltin) {
							throw new Error(`/${tuiOnlyBuiltin.name} is not available in daemon mode`);
						}
						return { agentInvoked: await session.prompt(command.text) };
					}
					if ("prompt" in slashResult) return { agentInvoked: await session.prompt(slashResult.prompt) };
					return { agentInvoked: false };
				}
				case "set_model": {
					const model = session
						.getAvailableModels?.()
						.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId);
					if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
					if (!session.setModel) throw new Error("Model changes are unavailable for this daemon session");
					await session.setModel(model);
					return model;
				}
				case "cycle_model": {
					if (!session.cycleModel) throw new Error("Model cycling is unavailable for this daemon session");
					const result = await session.cycleModel(command.direction ?? "forward");
					return result ?? {};
				}
				case "set_thinking_level":
					if (!session.setThinkingLevel)
						throw new Error("Thinking-level changes are unavailable for this daemon session");
					session.setThinkingLevel(command.level, true);
					return {};
				case "cycle_thinking_level":
					if (!session.cycleThinkingLevel)
						throw new Error("Thinking-level cycling is unavailable for this daemon session");
					return { level: session.cycleThinkingLevel() };
				case "set_steering_mode":
					if (!session.setSteeringMode)
						throw new Error("Steering mode changes are unavailable for this daemon session");
					session.setSteeringMode(command.mode);
					return {};
				case "set_follow_up_mode":
					if (!session.setFollowUpMode)
						throw new Error("Follow-up mode changes are unavailable for this daemon session");
					session.setFollowUpMode(command.mode);
					return {};
				case "set_interrupt_mode":
					if (!session.setInterruptMode)
						throw new Error("Interrupt mode changes are unavailable for this daemon session");
					session.setInterruptMode(command.mode);
					return {};
				case "set_todos":
					if (!session.setTodoPhases) throw new Error("Todo updates are unavailable for this daemon session");
					session.setTodoPhases(command.phases);
					return { todoPhases: session.getTodoPhases?.() ?? command.phases };
				case "set_host_tools": {
					if (!result.session.refreshRpcHostTools)
						throw new Error("Host tools are unavailable for this daemon session");
					const hostTools = hostToolBridge.setTools(command.tools);
					await result.session.refreshRpcHostTools(hostTools);
					return { toolNames: hostToolBridge.getToolNames() };
				}
				case "set_host_uri_schemes":
					return { schemes: hostUriBridge.setSchemes(command.schemes) };
				case "get_available_models":
					return { models: result.session.getAvailableModels() };
				case "compact":
					return await result.session.compact(command.customInstructions);
				case "set_auto_compaction":
					result.session.setAutoCompactionEnabled(command.enabled);
					return {};
				case "set_auto_retry":
					result.session.setAutoRetryEnabled(command.enabled);
					return {};
				case "abort_retry":
					result.session.abortRetry();
					return {};
				case "bash":
					return await result.session.executeBash(command.command, chunk =>
						emitBridgeEvent({ type: "command_output", text: chunk }),
					);
				case "abort_bash":
					result.session.abortBash();
					return {};
				case "get_session_stats":
					return result.session.getSessionStats();
				case "export_html": {
					const path = await result.session.exportToHtml(command.outputPath);
					return { path };
				}
				case "new_session":
					return {
						cancelled: !(await result.session.newSession({
							parentSession: command.parentSession,
						})),
					};
				case "switch_session":
					return {
						cancelled: !(await result.session.switchSession(command.sessionPath)),
					};
				case "branch": {
					const branch = await result.session.branch(command.entryId);
					return { text: branch.selectedText, cancelled: branch.cancelled };
				}
				case "get_branch_messages":
					return { messages: result.session.getUserMessagesForBranching() };
				case "get_last_assistant_text":
					return { text: result.session.getLastAssistantText() ?? null };
				case "set_session_name": {
					const name = command.name.trim();
					if (!name) throw new Error("Session name cannot be empty");
					if (!(await result.session.setSessionName(name, "user")))
						throw new Error("Session name cannot be empty");
					return {};
				}
				case "handoff": {
					if (result.session.isStreaming) throw new Error("Cannot hand off while a response is in progress");
					const handoff = await result.session.handoff(command.customInstructions);
					return handoff ? { savedPath: handoff.savedPath } : null;
				}
				case "get_messages":
					return { messages: result.session.messages };
				case "set_subagent_subscription":
				case "get_subagents":
				case "get_subagent_messages":
				case "get_login_providers":
				case "login":
					throw new Error(`Unsupported daemon RpcCommand: ${command.type}`);
				default:
					throw new Error("Unsupported daemon RpcCommand");
			}
		},
		dispose: async reason => {
			logger.debug("Daemon runtime dispose started", { sessionId });
			const hostedTask = hosted?.task;
			hosted?.mode.detachHosted();
			await hostedTask;
			logger.debug("Daemon runtime hosted task settled", { sessionId });
			unsubscribeSession();
			unsubscribeCommandMetadata();
			for (const resolve of pendingExtensionResponses.values()) resolve({ cancelled: true });
			pendingExtensionResponses.clear();
			hostUriBridge.clear();
			hostToolBridge.rejectAllPending("Daemon session disposed");
			logger.debug("Daemon runtime session dispose started", { sessionId });
			await session.dispose({
				mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS,
				...(reason === undefined ? {} : { reason }),
			});
			logger.debug("Daemon runtime session dispose settled", { sessionId });
		},
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/**
 * Construct a daemon session inside a durable async working-directory scope.
 * Every externally initiated operation re-enters that scope, while `/cd`
 * updates only this session's context.
 */
export function createAgentSessionRuntime(options: CreateAgentSessionRuntimeOptions): Promise<DaemonSessionRuntime> {
	const projectDirScope = createProjectDirScope(options.cwd);
	const registryScope = createAgentRegistryScope();
	return registryScope.run(() =>
		projectDirScope.run(async () => {
			const runtime = await createAgentSessionRuntimeInScope(options, registryScope.registry);
			return {
				sessionId: runtime.sessionId,
				get cwd() {
					return projectDirScope.get();
				},
				session: runtime.session,
				...(runtime.protectedJobCount
					? {
							protectedJobCount: () =>
								registryScope.run(() => projectDirScope.run(() => runtime.protectedJobCount?.() ?? 0)),
						}
					: {}),
				snapshot: () => registryScope.run(() => projectDirScope.run(() => runtime.snapshot())),
				command: (command: unknown, attachmentId?: string) =>
					registryScope.run(() => projectDirScope.run(() => runtime.command(command, attachmentId))),
				dispose: () => registryScope.run(() => projectDirScope.run(() => runtime.dispose())),
				subscribe: (listener: AgentSessionEventListener) => {
					const unsubscribe = registryScope.run(() =>
						projectDirScope.run(() =>
							runtime.subscribe(event => registryScope.run(() => projectDirScope.run(() => listener(event)))),
						),
					);
					return () => registryScope.run(() => projectDirScope.run(unsubscribe));
				},
			};
		}),
	);
}
