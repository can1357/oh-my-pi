/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ImageContent, supportsXhigh } from "@mariozechner/pi-ai";
import chalk from "chalk";
import { type Args, parseArgs, printHelp } from "./cli/args";
import { processFileArguments } from "./cli/file-processor";
import { listModels } from "./cli/list-models";
import { parsePluginArgs, printPluginHelp, runPluginCommand } from "./cli/plugin-cli";
import { selectSession } from "./cli/session-picker";
import { parseUpdateArgs, printUpdateHelp, runUpdateCommand } from "./cli/update-cli";
import { findConfigFile, getModelsPath, VERSION } from "./config";
import type { AgentSession } from "./core/agent-session";
import { exportFromFile } from "./core/export-html/index";
import type { ExtensionUIContext } from "./core/index";
import type { ModelRegistry } from "./core/model-registry";
import { parseModelPattern, resolveModelScope, type ScopedModel } from "./core/model-resolver";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage, discoverModels } from "./core/sdk";
import { SessionManager } from "./core/session-manager";
import { SettingsManager } from "./core/settings-manager";
import { resolvePromptInput } from "./core/system-prompt";
import { printTimings, time } from "./core/timings";
import { runMigrations, showDeprecationWarnings } from "./migrations";
import { InteractiveMode, installTerminalCrashHandlers, runPrintMode, runRpcMode } from "./modes/index";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme";
import { getChangelogPath, getNewEntries, parseChangelog } from "./utils/changelog";
import { ensureTool } from "./utils/tools-manager";

async function checkForNewVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest");
		if (!response.ok) return undefined;

		const data = (await response.json()) as { version?: string };
		const latestVersion = data.version;

		if (latestVersion && latestVersion !== currentVersion) {
			return latestVersion;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	changelogMarkdown: string | undefined,
	modelFallbackMessage: string | undefined,
	modelsJsonError: string | undefined,
	migratedProviders: string[],
	versionCheckPromise: Promise<string | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: Array<{ name: string; status: "ready" | "error"; fileTypes: string[] }> | undefined,
	initialMessage?: string,
	initialImages?: ImageContent[],
	fdPath: string | undefined = undefined,
): Promise<void> {
	const mode = new InteractiveMode(session, version, changelogMarkdown, setExtensionUIContext, lspServers, fdPath);

	await mode.init();

	versionCheckPromise.then((newVersion) => {
		if (newVersion) {
			mode.showNewVersionNotification(newVersion);
		}
	});

	mode.renderInitialMessages();

	if (migratedProviders.length > 0) {
		mode.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
	}

	if (modelsJsonError) {
		mode.showError(`models.json error: ${modelsJsonError}`);
	}

	if (modelFallbackMessage) {
		mode.showWarning(modelFallbackMessage);
	}

	if (initialMessage) {
		try {
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		try {
			await session.prompt(message);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	while (true) {
		const { text, images } = await mode.getUserInput();
		try {
			await session.prompt(text, { images });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return {};
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });

	let initialMessage: string;
	if (parsed.messages.length > 0) {
		initialMessage = text + parsed.messages[0];
		parsed.messages.shift();
	} else {
		initialMessage = text;
	}

	return {
		initialMessage,
		initialImages: images.length > 0 ? images : undefined,
	};
}

function getChangelogForDisplay(parsed: Args, settingsManager: SettingsManager): string | undefined {
	if (parsed.continue || parsed.resume) {
		return undefined;
	}

	const lastVersion = settingsManager.getLastChangelogVersion();
	const changelogPath = getChangelogPath();
	const entries = parseChangelog(changelogPath);

	if (!lastVersion) {
		if (entries.length > 0) {
			settingsManager.setLastChangelogVersion(VERSION);
			return entries.map((e) => e.content).join("\n\n");
		}
	} else {
		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			settingsManager.setLastChangelogVersion(VERSION);
			return newEntries.map((e) => e.content).join("\n\n");
		}
	}

	return undefined;
}

async function createSessionManager(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (parsed.session) {
		return await SessionManager.open(parsed.session, parsed.sessionDir);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

async function maybeAutoChdir(parsed: Args): Promise<void> {
	if (parsed.allowHome || parsed.cwd) {
		return;
	}

	const home = homedir();
	if (!home) {
		return;
	}

	const normalizePath = (value: string) => {
		const resolved = resolve(value);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};

	const cwd = normalizePath(process.cwd());
	const normalizedHome = normalizePath(home);
	if (cwd !== normalizedHome) {
		return;
	}

	const isDirectory = async (path: string) => {
		try {
			const stat = await Bun.file(path).stat();
			return stat.isDirectory();
		} catch {
			return false;
		}
	};

	const candidates = [join(home, "tmp"), "/tmp", "/var/tmp"];
	for (const candidate of candidates) {
		try {
			if (!(await isDirectory(candidate))) {
				continue;
			}
			process.chdir(candidate);
			return;
		} catch {
			// Try next candidate.
		}
	}

	try {
		const fallback = tmpdir();
		if (fallback && normalizePath(fallback) !== cwd && (await isDirectory(fallback))) {
			process.chdir(fallback);
		}
	} catch {
		// Ignore fallback errors.
	}
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

async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): Promise<CreateAgentSessionOptions> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? process.cwd(),
	};

	// Auto-discover SYSTEM.md if no CLI system prompt provided
	const systemPromptSource = parsed.systemPrompt ?? discoverSystemPromptFile();
	const resolvedSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
	const resolvedAppendPrompt = resolvePromptInput(parsed.appendSystemPrompt, "append system prompt");

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}

	// Model from CLI (--model) - uses same fuzzy matching as --models
	if (parsed.model) {
		const available = modelRegistry.getAvailable();
		const { model, warning } = parseModelPattern(parsed.model, available);
		if (warning) {
			console.warn(chalk.yellow(`Warning: ${warning}`));
		}
		if (!model) {
			console.error(chalk.red(`Model "${parsed.model}" not found`));
			process.exit(1);
		}
		options.model = model;
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		options.model = scopedModels[0].model;
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
	}

	// Scoped models for Ctrl+P cycling
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels;
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	if (resolvedSystemPrompt && resolvedAppendPrompt) {
		options.systemPrompt = `${resolvedSystemPrompt}\n\n${resolvedAppendPrompt}`;
	} else if (resolvedSystemPrompt) {
		options.systemPrompt = resolvedSystemPrompt;
	} else if (resolvedAppendPrompt) {
		options.systemPrompt = (defaultPrompt) => `${defaultPrompt}\n\n${resolvedAppendPrompt}`;
	}

	// Tools
	if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	// Skills
	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.skills && parsed.skills.length > 0) {
		// Override includeSkills in settingsManager for this session
		settingsManager.applyOverrides({
			skills: {
				...settingsManager.getSkillsSettings(),
				includeSkills: parsed.skills,
			},
		});
	}

	// Additional extension paths from CLI
	const cliExtensionPaths = [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
	if (cliExtensionPaths.length > 0) {
		options.additionalExtensionPaths = cliExtensionPaths;
	}

	return options;
}

export async function main(args: string[]) {
	time("start");

	// Initialize theme early with defaults (CLI commands need symbols)
	// Will be re-initialized with user preferences later
	initTheme();

	// Handle plugin subcommand before regular parsing
	const pluginCmd = parsePluginArgs(args);
	if (pluginCmd) {
		if (args.includes("--help") || args.includes("-h")) {
			printPluginHelp();
			return;
		}
		await runPluginCommand(pluginCmd);
		return;
	}

	// Handle update subcommand
	const updateCmd = parseUpdateArgs(args);
	if (updateCmd) {
		if (args.includes("--help") || args.includes("-h")) {
			printUpdateHelp();
			return;
		}
		await runUpdateCommand(updateCmd);
		return;
	}

	const parsed = parseArgs(args);
	time("parseArgs");
	await maybeAutoChdir(parsed);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = await runMigrations(process.cwd());

	// Create AuthStorage and ModelRegistry upfront
	const authStorage = await discoverAuthStorage();
	const modelRegistry = await discoverModels(authStorage);
	time("discoverModels");

	if (parsed.version) {
		console.log(VERSION);
		return;
	}

	if (parsed.help) {
		printHelp();
		return;
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		return;
	}

	if (parsed.export) {
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const result = await exportFromFile(parsed.export, outputPath);
			console.log(`Exported to: ${result}`);
			return;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	const cwd = process.cwd();
	const settingsManager = SettingsManager.create(cwd);
	time("SettingsManager.create");
	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
	time("prepareInitialMessage");
	const isInteractive = !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";

	// Initialize discovery system with settings for provider persistence
	const { initializeWithSettings } = await import("./discovery");
	initializeWithSettings(settingsManager);
	time("initializeWithSettings");

	// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
	const smolModel = parsed.smol ?? process.env.OMP_SMOL_MODEL;
	const slowModel = parsed.slow ?? process.env.OMP_SLOW_MODEL;
	if (smolModel || slowModel) {
		const roleOverrides: Record<string, string> = {};
		if (smolModel) roleOverrides.smol = smolModel;
		if (slowModel) roleOverrides.slow = slowModel;
		settingsManager.applyOverrides({ modelRoles: roleOverrides });
	}

	initTheme(settingsManager.getTheme(), isInteractive, settingsManager.getSymbolPreset());
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (isInteractive && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
		time("resolveModelScope");
	}

	// Create session manager based on CLI flags
	let sessionManager = await createSessionManager(parsed, cwd);
	time("createSessionManager");

	// Handle --resume: show session picker
	if (parsed.resume) {
		const sessions = SessionManager.list(cwd, parsed.sessionDir);
		time("SessionManager.list");
		if (sessions.length === 0) {
			console.log(chalk.dim("No sessions found"));
			return;
		}
		const selectedPath = await selectSession(sessions);
		time("selectSession");
		if (!selectedPath) {
			console.log(chalk.dim("No session selected"));
			return;
		}
		sessionManager = await SessionManager.open(selectedPath);
	}

	const sessionOptions = await buildSessionOptions(
		parsed,
		scopedModels,
		sessionManager,
		modelRegistry,
		settingsManager,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.settingsManager = settingsManager;
	sessionOptions.hasUI = isInteractive;

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			console.error(chalk.red("--api-key requires a model to be specified via --provider/--model or -m/--models"));
			process.exit(1);
		}
		authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
	}

	time("buildSessionOptions");
	const { session, extensionsResult, modelFallbackMessage, lspServers } = await createAgentSession(sessionOptions);
	time("createAgentSession");

	// Re-parse CLI args with extension flags and apply values
	if (session.extensionRunner) {
		const extFlags = session.extensionRunner.getFlags();
		if (extFlags.size > 0) {
			const flagDefs = new Map<string, { type: "boolean" | "string" }>();
			for (const [name, flag] of extFlags) {
				flagDefs.set(name, { type: flag.type });
			}
			const reparsed = parseArgs(args, flagDefs);
			for (const [name, value] of reparsed.unknownFlags) {
				session.extensionRunner.setFlagValue(name, value);
			}
		}
	}
	time("applyExtensionFlags");

	if (!isInteractive && !session.model) {
		console.error(chalk.red("No models available."));
		console.error(chalk.yellow("\nSet an API key environment variable:"));
		console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
		console.error(chalk.yellow(`\nOr create ${getModelsPath()}`));
		process.exit(1);
	}

	// Clamp thinking level to model capabilities (for CLI override case)
	if (session.model && parsed.thinking) {
		let effectiveThinking = parsed.thinking;
		if (!session.model.reasoning) {
			effectiveThinking = "off";
		} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
			effectiveThinking = "high";
		}
		if (effectiveThinking !== session.thinkingLevel) {
			session.setThinkingLevel(effectiveThinking);
		}
	}

	if (mode === "rpc") {
		await runRpcMode(session);
	} else if (isInteractive) {
		const versionCheckPromise = checkForNewVersion(VERSION).catch(() => undefined);
		const changelogMarkdown = getChangelogForDisplay(parsed, settingsManager);

		if (scopedModels.length > 0) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel !== "off" ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const fdPath = await ensureTool("fd");
		time("ensureTool(fd)");

		installTerminalCrashHandlers();
		printTimings();
		await runInteractiveMode(
			session,
			VERSION,
			changelogMarkdown,
			modelFallbackMessage,
			modelRegistry.getError(),
			migratedProviders,
			versionCheckPromise,
			parsed.messages,
			extensionsResult.setUIContext,
			lspServers,
			initialMessage,
			initialImages,
			fdPath,
		);
	} else {
		await runPrintMode(session, mode, parsed.messages, initialMessage, initialImages);
		stopThemeWatcher();
		if (process.stdout.writableLength > 0) {
			await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
		}
		process.exit(0);
	}
}
