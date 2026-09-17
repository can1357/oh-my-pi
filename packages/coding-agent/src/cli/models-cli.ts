/**
 * `omp models` — list, search, and refresh available models.
 *
 * Subcommands:
 * - `ls` (default): list every available model grouped by provider.
 * - `find <substring>`: list models whose provider, id, or name contains the substring.
 * - `refresh`: force an online catalog re-fetch (ignoring the model cache TTL),
 *   then list. This is the supported replacement for `rm -rf ~/.omp/models.db`
 *   when a provider ships a new model that the 24h cache has not picked up yet.
 *
 * `ls`/`find` use the cache when fresh (`online-if-uncached`); only `refresh`
 * forces the network (`online`).
 */
import type { Api, Effort, Model } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import * as readline from "node:readline/promises";
import type { ConfigError } from "../config/config-file";
import { ModelRegistry } from "../config/model-registry";
import {
	addCustomOpenAIProvider,
	probeOpenAIEndpoint,
	sanitizeBaseUrl,
	validateBaseUrl,
	validateProviderId,
} from "../config/models-config-writer";
import { Settings } from "../config/settings";
import { discoverAndLoadExtensions, ExtensionRunner, emitSessionShutdownEvent } from "../extensibility/extensions";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";
export type ModelsAction = "ls" | "find" | "refresh" | "add";

export interface ModelsCommandArgs {
	action: ModelsAction;
	/** Search substring for `find`, or optional filter for `ls`. */
	pattern?: string;
	flags: {
		json?: boolean;
		/** CLI `-e <path>` extension paths to load before listing (issue #905). */
		extensions?: string[];
		/** Skip extension discovery; only load explicit `extensions`. */
		noExtensions?: boolean;
		/** Extra `config.yml` overlays to apply for this invocation. */
		config?: string[];
		provider?: string;
		baseUrl?: string;
		apiKey?: string;
		auth?: string;
		api?: string;
		model?: string;
		modelName?: string;
		contextWindow?: number;
		discovery?: boolean;
		disableStrictTools?: boolean;
		test?: boolean;
		configPath?: string;
	};
}

/**
 * Known action keywords. Any other first token (e.g. `openai-codex`) is treated
 * as a provider/substring filter for the default `ls` view, so every provider
 * name doubles as an `omp models <provider>` shortcut.
 */
const KNOWN_ACTIONS: Record<string, ModelsAction> = {
	ls: "ls",
	list: "ls",
	find: "find",
	refresh: "refresh",
	add: "add",
};

/** Resolve the two positional args into an action + filter (provider names fall through to `ls`). */
export function resolveModelsArgs(
	first: string | undefined,
	second: string | undefined,
): { action: ModelsAction; pattern: string | undefined } {
	const known = first === undefined ? undefined : KNOWN_ACTIONS[first];
	if (known) {
		return { action: known, pattern: second };
	}
	return { action: "ls", pattern: first };
}

interface ModelJson {
	provider: string;
	id: string;
	selector: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	/** Supported thinking efforts when the model thinks, otherwise null. */
	thinking: readonly Effort[] | null;
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
}

interface ModelsJson {
	models: ModelJson[];
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function writeModelsConfigError(error: Error): void {
	writeLine(chalk.yellow("Warning: models.yml validation failed — custom providers disabled"));
	for (const line of error.message.split("\n")) {
		writeLine(`  ${line}`);
	}
	writeLine();
}

function formatLimit(n: number | null): string {
	return n === null ? "-" : formatNumber(n);
}

function byProviderThenId(left: Model<Api>, right: Model<Api>): number {
	const providerCmp = left.provider.localeCompare(right.provider);
	if (providerCmp !== 0) return providerCmp;
	return left.id.localeCompare(right.id);
}

function toModelJson(model: Model<Api>): ModelJson {
	return {
		provider: model.provider,
		id: model.id,
		selector: `${model.provider}/${model.id}`,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		thinking: model.thinking ? getSupportedEfforts(model) : null,
		input: model.input,
		cost: model.cost,
	};
}

type ColumnAlign = "left" | "right";

interface BoxColumn {
	header: string;
	align?: ColumnAlign;
}

/** Right- or left-pad a plain (ANSI-free) cell to `width` display columns. */
function padCell(text: string, width: number, align: ColumnAlign = "left"): string {
	const space = width - Bun.stringWidth(text);
	if (space <= 0) return text;
	const fill = " ".repeat(space);
	return align === "right" ? fill + text : text + fill;
}

/**
 * Render `rows` as a box-drawing table. Cells must be plain text (no ANSI); the
 * header row is bolded and the borders dimmed (both no-ops on non-TTY output).
 */
function boxTable(columns: BoxColumn[], rows: string[][]): string[] {
	const widths = columns.map((column, index) =>
		Math.max(Bun.stringWidth(column.header), ...rows.map(row => Bun.stringWidth(row[index] ?? ""))),
	);
	const bar = chalk.dim("│");
	const segments = widths.map(width => "─".repeat(width + 2));
	const renderRow = (cells: string[], bold: boolean): string => {
		const padded = columns.map((column, index) => {
			const cell = padCell(cells[index] ?? "", widths[index]!, column.align);
			return bold ? chalk.bold(cell) : cell;
		});
		return `${bar} ${padded.join(` ${bar} `)} ${bar}`;
	};
	const lines = [chalk.dim(`┌${segments.join("┬")}┐`)];
	lines.push(
		renderRow(
			columns.map(column => column.header),
			true,
		),
	);
	lines.push(chalk.dim(`├${segments.join("┼")}┤`));
	for (const row of rows) {
		lines.push(renderRow(row, false));
	}
	lines.push(chalk.dim(`└${segments.join("┴")}┘`));
	return lines;
}

/**
 * The two registry reads the listing performs. Structural so the renderer can be
 * exercised without booting a full {@link ModelRegistry}.
 */
export interface ModelsListingSource {
	getAvailable(): Model<Api>[];
	getError(): ConfigError | undefined;
}

/** `omp models ls`/`find`: provider-grouped listing (one box table per provider). */
export function renderProviderModels(
	source: ModelsListingSource,
	action: ModelsAction,
	pattern: string | undefined,
	json: boolean,
): void {
	const available = source.getAvailable();
	const needle = pattern?.toLowerCase();
	let filtered = available;

	if (needle) {
		let exactFound = false;
		if (action !== "find") {
			const exact = available.filter(m => m.provider.toLowerCase() === needle);
			if (exact.length > 0) {
				filtered = exact;
				exactFound = true;
			}
		}
		if (!exactFound) {
			filtered = available.filter(
				model =>
					model.id.toLowerCase().includes(needle) ||
					model.provider.toLowerCase().includes(needle) ||
					`${model.provider}/${model.id}`.toLowerCase().includes(needle) ||
					model.name.toLowerCase().includes(needle),
			);
		}
	}

	const configError = source.getError();

	if (json) {
		if (configError) {
			process.stderr.write(
				`Warning: models.yml validation failed — custom providers disabled\n${configError.message}\n`,
			);
		}
		const output: ModelsJson = { models: filtered.slice().sort(byProviderThenId).map(toModelJson) };
		writeLine(JSON.stringify(output));
		return;
	}

	if (configError) {
		writeModelsConfigError(configError);
	}

	if (available.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}
	if (filtered.length === 0) {
		writeLine(`No models matching "${pattern}"`);
		return;
	}

	// One section per provider: bold heading + a box table of that provider's models.
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of filtered.slice().sort(byProviderThenId)) {
		let group = byProvider.get(model.provider);
		if (!group) {
			group = [];
			byProvider.set(model.provider, group);
		}
		group.push(model);
	}

	let firstProvider = true;
	for (const [provider, models] of byProvider) {
		if (!firstProvider) writeLine();
		firstProvider = false;
		writeLine(`${chalk.bold.cyan(provider)} ${chalk.dim(`(${models.length})`)}`);
		const rows = models.map(model => [
			model.id,
			formatLimit(model.contextWindow),
			formatLimit(model.maxTokens),
			model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
			// Wire truth, not the declared `input`: the transport drops image parts for
			// models the catalog marks text-only (`compat.stripImageInput`, #9697).
			sendsImageInputOnWire(model) ? "yes" : "no",
		]);
		for (const line of boxTable(
			[
				{ header: "model" },
				{ header: "context", align: "right" },
				{ header: "max-out", align: "right" },
				{ header: "thinking" },
				{ header: "images" },
			],
			rows,
		)) {
			writeLine(line);
		}
	}
}

/**
 * Options for {@link runModelsListing}: render the catalog from a caller-supplied
 * registry. Loads extensions (CLI `-e` paths and configured `settings.extensions`)
 * and discovers their providers before rendering so extension-contributed models
 * appear (issue #905). The caller is responsible for refreshing built-in providers.
 */
export interface RunModelsListingOptions {
	modelRegistry: ModelRegistry;
	cwd: string;
	action?: ModelsAction;
	pattern?: string;
	json?: boolean;
	/** CLI-supplied extension paths (e.g. from `-e <path>`). */
	additionalExtensionPaths?: string[];
	/** Extension paths configured under `extensions:` in user settings. */
	settingsExtensions?: string[];
	/** Disabled extension ids from settings (`disabledExtensions`). */
	disabledExtensionIds?: string[];
	/** When true, exclude ambient factories and resolve only `additionalExtensionPaths`. */
	disableExtensionDiscovery?: boolean;
}

export async function runModelsListing(options: RunModelsListingOptions): Promise<void> {
	const {
		modelRegistry,
		cwd,
		action = "ls",
		pattern,
		json = false,
		additionalExtensionPaths = [],
		settingsExtensions = [],
		disabledExtensionIds = [],
		disableExtensionDiscovery = false,
	} = options;

	const eventBus = new EventBus();
	const configuredPaths = disableExtensionDiscovery
		? additionalExtensionPaths
		: [...additionalExtensionPaths, ...settingsExtensions];
	const extensionsResult = await discoverAndLoadExtensions(
		configuredPaths,
		cwd,
		eventBus,
		disableExtensionDiscovery ? undefined : disabledExtensionIds,
		{ ambient: !disableExtensionDiscovery, includeAmbientHooks: false },
	);
	const extensionRunner =
		extensionsResult.extensions.length > 0
			? new ExtensionRunner(
					extensionsResult.extensions,
					extensionsResult.runtime,
					cwd,
					SessionManager.inMemory(cwd),
					modelRegistry,
				)
			: undefined;

	try {
		for (const { path: extPath, error } of extensionsResult.errors) {
			process.stderr.write(`Failed to load extension: ${extPath}: ${error}\n`);
		}

		// Mirror sdk.ts: drain pending provider registrations into the registry.
		const activeSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeSources);
		for (const sourceId of new Set(activeSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config, sourceId);
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
		// Discover runtime (extension) provider catalogs now that they are registered.
		await modelRegistry.refreshRuntimeProviders(action === "refresh" ? "online" : "online-if-uncached");

		renderProviderModels(modelRegistry, action, pattern, json);
	} finally {
		await emitSessionShutdownEvent(extensionRunner);
	}
}

/**
 * Entry point for the standalone `omp models` command: bootstraps auth storage,
 * settings, and the model registry, force/cache-refreshes built-in providers per
 * the chosen action, then delegates to {@link runModelsListing}.
 */
export async function runModelsCommand(command: ModelsCommandArgs): Promise<void> {
	const { action, pattern } = command;
	const json = command.flags.json ?? false;

	if (action === "add") {
		await handleAddModelAction(command);
		return;
	}

	if (action === "find" && (!pattern || pattern.trim().length === 0)) {
		process.stderr.write("`omp models find` requires a search substring, e.g. `omp models find minimax`\n");
		process.exitCode = 1;
		return;
	}

	const cwd = getProjectDir();
	const authStorage = await discoverAuthStorage();
	try {
		const settings = await Settings.init({ cwd, configFiles: command.flags.config });
		const modelRegistry = new ModelRegistry(authStorage);

		if (action === "refresh" && !json && process.stderr.isTTY) {
			process.stderr.write("Refreshing models from all providers…\n");
		}
		await modelRegistry.refresh(
			action === "refresh" ? "online" : "online-if-uncached",
			action === "refresh" ? { refreshCommandCredentials: true } : undefined,
		);

		const cliExtensionPaths = command.flags.extensions ?? [];
		await runModelsListing({
			modelRegistry,
			cwd,
			action,
			pattern,
			json,
			additionalExtensionPaths: cliExtensionPaths,
			settingsExtensions: settings.get("extensions") ?? [],
			disabledExtensionIds: settings.get("disabledExtensions") ?? [],
			disableExtensionDiscovery: Boolean(command.flags.noExtensions),
		});
	} finally {
		authStorage.close();
	}
}
/**
 * Handle `omp models add` action: add custom OpenAI-compatible provider and model
 * either script-driven via CLI flags or interactively via terminal readline prompt.
 */
export async function handleAddModelAction(command: ModelsCommandArgs): Promise<void> {
	const flags = command.flags;
	const json = flags.json ?? false;

	const provider = flags.provider?.trim() || command.pattern?.trim();
	const baseUrl = flags.baseUrl?.trim();
	const hasFlagParams = Boolean(provider || baseUrl || flags.model || flags.discovery || flags.apiKey);

	if (hasFlagParams) {
		if (!provider) {
			const msg = "Missing required parameter: provider identifier (use --provider <id> or specify as argument)";
			if (json) {
				process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${msg}\n`));
			}
			process.exitCode = 1;
			return;
		}

		const providerError = validateProviderId(provider);
		if (providerError) {
			if (json) {
				process.stdout.write(JSON.stringify({ error: providerError }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${providerError}\n`));
			}
			process.exitCode = 1;
			return;
		}

		if (!baseUrl) {
			const msg = "Missing required flag: --base-url <url>";
			if (json) {
				process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${msg}\n`));
			}
			process.exitCode = 1;
			return;
		}

		const urlError = validateBaseUrl(baseUrl);
		if (urlError) {
			if (json) {
				process.stdout.write(JSON.stringify({ error: urlError }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${urlError}\n`));
			}
			process.exitCode = 1;
			return;
		}

		if (!flags.model && !flags.discovery) {
			const msg = "Specify either --model <id> for a manual model definition or --discovery for automatic discovery";
			if (json) {
				process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${msg}\n`));
			}
			process.exitCode = 1;
			return;
		}

		const authMode = (flags.auth as "apiKey" | "none" | undefined) ?? (flags.apiKey ? "apiKey" : "none");
		if (authMode === "apiKey" && !flags.apiKey) {
			const msg = "API key is required when auth mode is apiKey. Provide --api-key <key>";
			if (json) {
				process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${msg}\n`));
			}
			process.exitCode = 1;
			return;
		}

		const api = (flags.api as "openai-completions" | "openai-responses" | undefined) ?? "openai-completions";

		if (flags.test) {
			if (!json && process.stderr.isTTY) {
				process.stderr.write(`Testing connection to ${baseUrl}... `);
			}
			const probeResult = await probeOpenAIEndpoint(baseUrl, flags.apiKey);
			if (!probeResult.ok) {
				const msg = `Connection check failed: ${probeResult.error}`;
				if (json) {
					process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
				} else {
					process.stderr.write(chalk.red(`\nError: ${msg}\n`));
				}
				process.exitCode = 1;
				return;
			}
			if (!json && process.stderr.isTTY) {
				process.stderr.write(chalk.green(`OK (${probeResult.models.length} models detected)\n`));
			}
		}

		try {
			const addResult = await addCustomOpenAIProvider(
				{
					provider,
					baseUrl,
					apiKey: flags.apiKey,
					auth: authMode,
					api,
					discovery: flags.discovery,
					disableStrictTools: flags.disableStrictTools ?? true,
					model: flags.model
						? {
								id: flags.model,
								name: flags.modelName || flags.model,
								contextWindow: flags.contextWindow,
							}
						: undefined,
				},
				flags.configPath,
			);
			if (json) {
				process.stdout.write(JSON.stringify(addResult, null, 2) + "\n");
			} else {
				process.stdout.write(chalk.green(`✓ Added custom provider "${addResult.provider}" to ${addResult.filePath}\n`));
				if (addResult.modelId) {
					process.stdout.write(`  Model: ${addResult.provider}/${addResult.modelId} (supportsTools: true)\n`);
					process.stdout.write(`  Switch in session: /model ${addResult.provider}/${addResult.modelId}\n`);
				} else {
					process.stdout.write(`  Auto-discovery enabled: ${addResult.provider}/*\n`);
					process.stdout.write(`  List models: omp models ${addResult.provider}\n`);
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (json) {
				process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
			} else {
				process.stderr.write(chalk.red(`Error: ${msg}\n`));
			}
			process.exitCode = 1;
		}
		return;
	}

	if (!process.stdin.isTTY) {
		const msg = "Missing required parameters. Usage: omp models add --provider <id> --base-url <url> (--model <id> | --discovery)";
		if (json) {
			process.stdout.write(JSON.stringify({ error: msg }, null, 2) + "\n");
		} else {
			process.stderr.write(chalk.red(`Error: ${msg}\n`));
		}
		process.exitCode = 1;
		return;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		process.stdout.write(chalk.bold("\nAdd Custom OpenAI Provider\n\n"));

		let inputProvider = "";
		while (!inputProvider) {
			const answer = (await rl.question("Provider identifier (e.g. my-vllm, deepseek-local): ")).trim();
			const err = validateProviderId(answer);
			if (err) {
				process.stdout.write(chalk.red(`  ${err}\n`));
			} else {
				inputProvider = answer;
			}
		}

		let inputBaseUrl = "";
		while (!inputBaseUrl) {
			const answer = (await rl.question("Endpoint Base URL [http://localhost:8000/v1]: ")).trim() || "http://localhost:8000/v1";
			const err = validateBaseUrl(answer);
			if (err) {
				process.stdout.write(chalk.red(`  ${err}\n`));
			} else {
				inputBaseUrl = sanitizeBaseUrl(answer);
			}
		}

		const authAnswer = (await rl.question("Authentication mode (none/apiKey) [none]: ")).trim().toLowerCase();
		const authMode: "apiKey" | "none" = authAnswer === "apikey" ? "apiKey" : "none";

		let apiKey: string | undefined;
		if (authMode === "apiKey") {
			apiKey = (await rl.question("API Key: ")).trim();
		}

		const modeAnswer = (await rl.question("Model mode (discovery/manual) [discovery]: ")).trim().toLowerCase();
		const isDiscovery = modeAnswer !== "manual";

		let manualModel: { id: string; name?: string; contextWindow?: number } | undefined;
		if (!isDiscovery) {
			let modelId = "";
			while (!modelId) {
				modelId = (await rl.question("Model identifier (e.g. llama-3-8b): ")).trim();
				if (!modelId) process.stdout.write(chalk.red("  Model ID cannot be empty\n"));
			}
			const modelName = (await rl.question(`Display name [${modelId}]: `)).trim() || modelId;
			const ctxWinAnswer = (await rl.question("Context window tokens [128000]: ")).trim();
			const contextWindow = ctxWinAnswer ? Number.parseInt(ctxWinAnswer, 10) || 128000 : 128000;
			manualModel = { id: modelId, name: modelName, contextWindow };
		}

		process.stdout.write(`\nTesting connection to ${inputBaseUrl}... `);
		const probe = await probeOpenAIEndpoint(inputBaseUrl, apiKey);
		if (probe.ok) {
			process.stdout.write(chalk.green(`OK (${probe.models.length} models detected)\n`));
			if (probe.models.length > 0) {
				process.stdout.write(chalk.dim(`Detected: ${probe.models.slice(0, 5).join(", ")}${probe.models.length > 5 ? "..." : ""}\n`));
			}
		} else {
			process.stdout.write(chalk.yellow(`Warning: ${probe.error}\n`));
			const proceed = (await rl.question("Save anyway? (y/N): ")).trim().toLowerCase();
			if (proceed !== "y" && proceed !== "yes") {
				process.stdout.write("Aborted.\n");
				return;
			}
		}
		const addResult = await addCustomOpenAIProvider(
			{
				provider: inputProvider,
				baseUrl: inputBaseUrl,
				apiKey,
				auth: authMode,
				api: "openai-completions",
				discovery: isDiscovery,
				disableStrictTools: true,
				model: manualModel,
			},
			flags.configPath,
		);

		process.stdout.write(chalk.green(`\n✓ Added custom provider "${addResult.provider}" to ${addResult.filePath}\n`));
		if (addResult.modelId) {
			process.stdout.write(`  Model: ${addResult.provider}/${addResult.modelId} (supportsTools: true)\n`);
			process.stdout.write(`  Switch in session: /model ${addResult.provider}/${addResult.modelId}\n`);
		} else {
			process.stdout.write(`  Auto-discovery enabled: ${addResult.provider}/*\n`);
			process.stdout.write(`  List models: omp models ${addResult.provider}\n`);
		}
	} finally {
		rl.close();
	}
}
