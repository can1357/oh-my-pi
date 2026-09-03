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
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAndLoadExtensions, ExtensionRunner, emitSessionShutdownEvent } from "../extensibility/extensions";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";

export type ModelsAction = "ls" | "find" | "refresh";

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

/** `omp models ls`/`find`: provider-grouped listing (one box table per provider). */
function renderProviderModels(
	modelRegistry: ModelRegistry,
	action: ModelsAction,
	pattern: string | undefined,
	json: boolean,
): void {
	const available = modelRegistry.getAvailable();
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

	const configError = modelRegistry.getError();

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
			model.input.includes("image") ? "yes" : "no",
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
		await modelRegistry.refresh(action === "refresh" ? "online" : "online-if-uncached");

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
