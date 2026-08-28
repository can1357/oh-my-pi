import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	AuthCredentialSnapshotEntry,
	Context,
	Model,
	OAuthAccess,
	OAuthAccessResolution,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	getModelMatchPreferences,
	resolveAllowedModels,
	resolveCliModel,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import dryBalanceBenchPrompt from "../prompts/dry-balance-bench.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

const DEFAULT_SAMPLE_COUNT = 100;
const DEFAULT_CONCURRENCY = 32;
const BENCH_MAX_TOKENS = 512;
const BENCH_RENDER_INTERVAL_MS = 80;
const BENCH_ACCOUNT_WIDTH = 60;
const BENCH_ERROR_WIDTH = 110;
const BENCH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DRY_BALANCE_BENCH_PROMPT = dryBalanceBenchPrompt.trim();

export interface DryBalanceCommandArgs {
	model?: string;
	flags: {
		model?: string;
		count?: number;
		concurrency?: number;
		json?: boolean;
		bench?: boolean;
	};
}

export interface DryBalanceAuthOptions {
	baseUrl?: string;
	modelId?: string;
	signal?: AbortSignal;
}

export interface DryBalanceAuthStorage {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: DryBalanceAuthOptions,
	): Promise<OAuthAccess | undefined>;
	getOAuthAccesses?(provider: string, options?: DryBalanceAuthOptions): Promise<OAuthAccessResolution[]>;
	/**
	 * Force-refresh a single credential by id (step (b) of the auth-retry
	 * policy). The bench re-mints the failing account's token in place on a
	 * 401 rather than rotating accounts — it is measuring each account.
	 */
	forceRefreshCredentialById?(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry>;
}

export interface DryBalanceModelRegistry {
	authStorage: DryBalanceAuthStorage;
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
}

export interface DryBalanceRuntime {
	modelRegistry: DryBalanceModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface DryBalanceAccountStat {
	account: string;
	count: number;
	percent: number;
}

export interface DryBalanceFailureStat {
	reason: string;
	count: number;
	percent: number;
}

export interface DryBalanceBenchSuccessResult {
	ok: true;
	account: string;
	ttftMs: number;
	durationMs: number;
	outputTokens: number;
	tokensPerSecond: number;
}

export interface DryBalanceBenchFailureResult {
	ok: false;
	account?: string;
	error: string;
}

export type DryBalanceBenchResult = DryBalanceBenchSuccessResult | DryBalanceBenchFailureResult;

export interface DryBalanceBenchSummary {
	total: number;
	success: {
		total: number;
		averageTtftMs: number | null;
		averageTokensPerSecond: number | null;
	};
	failure: {
		total: number;
		reasons: DryBalanceFailureStat[];
	};
	results: DryBalanceBenchResult[];
}

export interface DryBalanceSummary {
	model: string;
	provider: string;
	samples: number;
	concurrency: number;
	success: {
		total: number;
		accounts: DryBalanceAccountStat[];
	};
	failure: {
		total: number;
		reasons: DryBalanceFailureStat[];
	};
	bench?: DryBalanceBenchSummary;
}

type DryBalanceStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface DryBalanceDependencies {
	createRuntime?: () => Promise<DryBalanceRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	streamSimple?: DryBalanceStreamSimple;
	now?: () => number;
	stdoutIsTTY?: boolean;
	stderrIsTTY?: boolean;
	stdoutColumns?: number;
	stderrColumns?: number;
}

type DryBalanceAttemptResult =
	| {
			ok: true;
			account: string;
	  }
	| {
			ok: false;
			reason: string;
	  };

type DryBalanceBenchProgressStatus =
	| { state: "waiting" }
	| { state: "running"; account: string }
	| { state: "success"; result: DryBalanceBenchSuccessResult }
	| { state: "failure"; result: DryBalanceBenchFailureResult };

interface DryBalanceBenchProgressSink {
	markRunning(index: number, account: string): void;
	complete(index: number, result: DryBalanceBenchResult): void;
	close(): void;
}

type DryBalanceBenchTarget =
	| {
			ok: true;
			account: string;
			accessToken: string;
			credentialId?: number;
	  }
	| {
			ok: false;
			account: string;
			error: string;
	  };

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) {
		throw new Error(`--${name} must be a positive integer`);
	}
	return resolved;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	const message = String(error);
	return message ? message : "Unknown error";
}

function extractAccount(access: {
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
}): string {
	const base =
		access.email ?? access.accountId ?? access.projectId ?? access.enterpriseUrl ?? "(unknown oauth account)";
	// Two subscriptions (orgs) can share one email — name the org so per-account
	// bench rows stay tellable apart.
	const org = access.orgName ?? access.orgId;
	return org ? `${base} (${org})` : base;
}

function getBenchTargetKey(access: {
	credentialId?: number;
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	accessToken?: string;
	orgId?: string;
}): string {
	const base =
		access.email ??
		access.accountId ??
		access.projectId ??
		access.enterpriseUrl ??
		(access.credentialId === undefined ? access.accessToken : `credential:${access.credentialId}`) ??
		"(unknown oauth account)";
	// Org-qualify: two org-scoped credentials under one email are two distinct
	// benchmark targets, not duplicates.
	return access.orgId ? `${base}|org:${access.orgId}` : base;
}

function sanitizeBenchText(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/\r?\n/g, " "), width);
}

function formatBenchIndex(index: number, total: number): string {
	return `#${String(index + 1).padStart(String(total).length, "0")}`;
}

function formatBenchAccount(account: string | undefined): string {
	return account ? sanitizeBenchText(account, BENCH_ACCOUNT_WIDTH) : chalk.dim("(no account)");
}

function formatBenchDuration(ms: number): string {
	return formatDuration(Math.max(0, Math.round(ms)));
}

function formatBenchTps(tokensPerSecond: number): string {
	return `${tokensPerSecond.toFixed(1)}/s`;
}

function isBenchSuccess(result: DryBalanceBenchResult): result is DryBalanceBenchSuccessResult {
	return result.ok;
}

function isBenchFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		default:
			return false;
	}
}

function resolveBenchMaxTokens(model: Model<Api>): number {
	return model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
		? Math.min(BENCH_MAX_TOKENS, model.maxTokens)
		: BENCH_MAX_TOKENS;
}

function normalizeBenchMs(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function renderBenchResultLine(index: number, total: number, result: DryBalanceBenchResult): string {
	const prefix = formatBenchIndex(index, total);
	if (result.ok) {
		return `${chalk.green("✓")} ${prefix} ${formatBenchAccount(result.account)} ${chalk.dim("TTFT")} ${formatBenchDuration(
			result.ttftMs,
		)} ${chalk.dim("TPS")} ${formatBenchTps(result.tokensPerSecond)}`;
	}
	return `${chalk.red("✗")} ${prefix} ${formatBenchAccount(result.account)} ${chalk.red(
		sanitizeBenchText(result.error, BENCH_ERROR_WIDTH),
	)}`;
}

function renderBenchStatusLine(
	status: DryBalanceBenchProgressStatus,
	index: number,
	total: number,
	frame: number,
): string {
	const prefix = formatBenchIndex(index, total);
	switch (status.state) {
		case "waiting":
			return `${chalk.dim("○")} ${prefix} ${chalk.dim("waiting")}`;
		case "running": {
			const spinner = BENCH_SPINNER_FRAMES[frame % BENCH_SPINNER_FRAMES.length] ?? "*";
			return `${chalk.yellow(spinner)} ${prefix} ${formatBenchAccount(status.account)} ${chalk.dim("sending request")}`;
		}
		case "success":
			return renderBenchResultLine(index, total, status.result);
		case "failure":
			return renderBenchResultLine(index, total, status.result);
	}
}

export function createBenchProgressSink(
	total: number,
	write: (text: string) => void,
	interactive: boolean,
	columns: number,
): DryBalanceBenchProgressSink {
	const statuses: DryBalanceBenchProgressStatus[] = Array.from({ length: total }, () => ({ state: "waiting" }));
	if (!interactive) {
		return {
			markRunning(index, account) {
				statuses[index] = { state: "running", account };
				write(`${renderBenchStatusLine(statuses[index], index, total, 0)}\n`);
			},
			complete(index, result) {
				statuses[index] = result.ok ? { state: "success", result } : { state: "failure", result };
				write(`${renderBenchResultLine(index, total, result)}\n`);
			},
			close() {},
		};
	}

	let frame = 0;
	let lineCount = 0;
	let timer: NodeJS.Timeout | undefined;
	const width = Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : 80;
	const render = (): void => {
		const lines = [
			chalk.bold("bench requests"),
			...statuses.map((status, index) => renderBenchStatusLine(status, index, total, frame)),
		];
		// Anchor every redraw at column 0 and terminate each row with CRLF: a
		// bare `\n` only returns to column 0 when the tty performs ONLCR
		// translation, which is off whenever the terminal is in raw mode — there
		// the old column-preserving cursor-up staircased each frame into
		// scrollback. Cap each line to the terminal width so a wrapped row never
		// desyncs the `\x1b[<n>A` cursor-up from the logical line count.
		const move = lineCount > 0 ? `\x1b[${lineCount}A` : "";
		const body = lines.map(line => `\x1b[2K${truncateToWidth(line, width)}`).join("\r\n");
		write(`${move}\r${body}\r\n`);
		lineCount = lines.length;
	};
	render();
	timer = setInterval(() => {
		frame += 1;
		render();
	}, BENCH_RENDER_INTERVAL_MS);
	timer.unref?.();
	return {
		markRunning(index, account) {
			statuses[index] = { state: "running", account };
			render();
		},
		complete(index, result) {
			statuses[index] = result.ok ? { state: "success", result } : { state: "failure", result };
			render();
		},
		close() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			render();
		},
	};
}

async function runBenchRequest(
	model: Model<Api>,
	sessionId: string,
	target: Extract<DryBalanceBenchTarget, { ok: true }>,
	authStorage: DryBalanceAuthStorage,
	streamFn: DryBalanceStreamSimple,
	now: () => number,
): Promise<DryBalanceBenchResult> {
	const { account, accessToken, credentialId } = target;
	const startedAt = now();
	let firstTokenAt: number | undefined;
	// Re-mint the cached token on a 401: a peer/broker may have rotated it out
	// from under our snapshot (Anthropic rotates refresh tokens on every use).
	// The bench measures one account, so the switch step intentionally declines.
	const apiKey: ApiKeyResolver = async ({ lastChance, error }) => {
		if (error === undefined) return accessToken;
		if (lastChance || credentialId === undefined || !authStorage.forceRefreshCredentialById) return undefined;
		const refreshed = await authStorage.forceRefreshCredentialById(credentialId);
		return refreshed.credential.type === "oauth" ? refreshed.credential.access : undefined;
	};
	try {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: DRY_BALANCE_BENCH_PROMPT,
					timestamp: Date.now(),
					attribution: "user",
				},
			],
		};
		const stream = streamFn(model, context, {
			apiKey,
			sessionId,
			maxTokens: resolveBenchMaxTokens(model),
			temperature: 0.2,
			disableReasoning: true,
			hideThinkingSummary: true,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (firstTokenAt === undefined && isBenchFirstTokenEvent(event)) {
				firstTokenAt = now();
			}
			if (event.type === "error") {
				return { ok: false, account, error: event.error.errorMessage ?? "request failed" };
			}
			if (event.type === "done") {
				message = event.message;
			}
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { ok: false, account, error: message.errorMessage ?? "request failed" };
		}
		const durationMs = normalizeBenchMs(message.duration ?? now() - startedAt);
		const ttftMs = normalizeBenchMs(
			message.ttft ?? (firstTokenAt === undefined ? durationMs : firstTokenAt - startedAt),
		);
		const outputTokens = Number.isFinite(message.usage.output) && message.usage.output > 0 ? message.usage.output : 0;
		const tokensPerSecond = durationMs > 0 ? (outputTokens * 1000) / durationMs : 0;
		return {
			ok: true,
			account,
			ttftMs,
			durationMs,
			outputTokens,
			tokensPerSecond,
		};
	} catch (error) {
		return { ok: false, account, error: getErrorMessage(error) };
	}
}

async function resolveBenchTargets(
	model: Model<Api>,
	authStorage: DryBalanceAuthStorage,
): Promise<DryBalanceBenchTarget[]> {
	const resolved = authStorage.getOAuthAccesses
		? await authStorage.getOAuthAccesses(model.provider, {
				baseUrl: model.baseUrl,
				modelId: model.id,
			})
		: await authStorage
				.getOAuthAccess(model.provider, undefined, {
					baseUrl: model.baseUrl,
					modelId: model.id,
				})
				.then(access => (access ? [{ ok: true as const, ...access }] : []));
	const targets: DryBalanceBenchTarget[] = [];
	const seen = new Set<string>();
	for (const entry of resolved) {
		const key = getBenchTargetKey(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		const account = extractAccount(entry);
		if (entry.ok) {
			targets.push({ ok: true, account, accessToken: entry.accessToken, credentialId: entry.credentialId });
		} else {
			targets.push({ ok: false, account, error: entry.error });
		}
	}
	return targets;
}

async function runBenchTargets(
	model: Model<Api>,
	targets: DryBalanceBenchTarget[],
	authStorage: DryBalanceAuthStorage,
	randomSessionId: () => string,
	progress: DryBalanceBenchProgressSink | undefined,
	streamFn: DryBalanceStreamSimple,
	now: () => number,
): Promise<DryBalanceBenchResult[]> {
	return Promise.all(
		targets.map(async (target, index) => {
			if (!target.ok) {
				const result: DryBalanceBenchFailureResult = {
					ok: false,
					account: target.account,
					error: target.error,
				};
				progress?.complete(index, result);
				return result;
			}
			progress?.markRunning(index, target.account);
			const result = await runBenchRequest(model, randomSessionId(), target, authStorage, streamFn, now);
			progress?.complete(index, result);
			return result;
		}),
	);
}

async function createDefaultRuntime(): Promise<DryBalanceRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

async function resolveDryBalanceModel(
	modelSelector: string | undefined,
	modelRegistry: DryBalanceModelRegistry,
	settings: Settings | undefined,
	randomSessionId: () => string,
): Promise<{ model: Model<Api>; warning?: string }> {
	const preferences = getModelMatchPreferences(settings);
	if (modelSelector) {
		const resolved = resolveCliModel({
			cliModel: modelSelector,
			modelRegistry,
			settings,
			preferences,
		});
		if (resolved.error) throw new Error(resolved.error);
		if (!resolved.model) throw new Error(`Model "${modelSelector}" not found`);
		return { model: resolved.model, warning: resolved.warning };
	}

	const allowedModels = await resolveAllowedModels(modelRegistry, settings, preferences);
	if (allowedModels.length === 0) {
		throw new Error(
			"No models available. Use --model to select a model or configure enabledModels/default model settings.",
		);
	}

	const defaultRoleSpec = resolveModelRoleValue(settings?.getModelRole("default"), allowedModels, {
		settings,
		matchPreferences: preferences,
	});
	if (defaultRoleSpec.model) {
		return { model: defaultRoleSpec.model, warning: defaultRoleSpec.warning };
	}

	for (const candidate of allowedModels) {
		const apiKey = await modelRegistry.getApiKey(candidate, randomSessionId());
		if (apiKey) return { model: candidate };
	}

	return {
		model: allowedModels[0],
		warning:
			"No allowed model had usable credentials during default resolution; dry-balance will report OAuth failures for the first allowed model.",
	};
}

async function runOneAttempt(
	model: Model<Api>,
	modelRegistry: DryBalanceModelRegistry,
	sessionId: string,
): Promise<DryBalanceAttemptResult> {
	try {
		// AuthStorage.getOAuthAccess shares the OAuth credential ranking, refresh,
		// usage-limit, broker, and session-sticky path used by getApiKey(), while
		// returning the selected account metadata instead of bearer bytes.
		const access = await modelRegistry.authStorage.getOAuthAccess(model.provider, sessionId, {
			baseUrl: model.baseUrl,
			modelId: model.id,
		});
		if (!access) return { ok: false, reason: "no OAuth access resolved" };
		return { ok: true, account: extractAccount(access) };
	} catch (error) {
		return { ok: false, reason: getErrorMessage(error) };
	}
}

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}

function sortedStats(
	map: Map<string, number>,
	samples: number,
): Array<{ label: string; count: number; percent: number }> {
	return [...map.entries()]
		.map(([label, count]) => ({ label, count, percent: (count / samples) * 100 }))
		.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function summarizeBenchResults(results: DryBalanceBenchResult[]): DryBalanceBenchSummary | undefined {
	if (results.length === 0) return undefined;
	const successes = results.filter(isBenchSuccess);
	const failureReasons = new Map<string, number>();
	for (const result of results) {
		if (!result.ok) {
			failureReasons.set(result.error, (failureReasons.get(result.error) ?? 0) + 1);
		}
	}
	const average = (values: number[]): number | null =>
		values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		total: results.length,
		success: {
			total: successes.length,
			averageTtftMs: average(successes.map(result => result.ttftMs)),
			averageTokensPerSecond: average(successes.map(result => result.tokensPerSecond)),
		},
		failure: {
			total: results.length - successes.length,
			reasons: sortedStats(failureReasons, results.length).map(stat => ({
				reason: stat.label,
				count: stat.count,
				percent: stat.percent,
			})),
		},
		results,
	};
}

function summarizeResults(
	model: Model<Api>,
	samples: number,
	concurrency: number,
	results: DryBalanceAttemptResult[],
): DryBalanceSummary {
	const accounts = new Map<string, number>();
	const reasons = new Map<string, number>();
	for (const result of results) {
		if (result.ok) {
			accounts.set(result.account, (accounts.get(result.account) ?? 0) + 1);
		} else {
			reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
		}
	}
	const accountStats: DryBalanceAccountStat[] = sortedStats(accounts, samples).map(stat => ({
		account: stat.label,
		count: stat.count,
		percent: stat.percent,
	}));
	const failureStats: DryBalanceFailureStat[] = sortedStats(reasons, samples).map(stat => ({
		reason: stat.label,
		count: stat.count,
		percent: stat.percent,
	}));
	const summary: DryBalanceSummary = {
		model: formatModelString(model),
		provider: model.provider,
		samples,
		concurrency,
		success: {
			total: results.filter(result => result.ok).length,
			accounts: accountStats,
		},
		failure: {
			total: results.filter(result => !result.ok).length,
			reasons: failureStats,
		},
	};
	return summary;
}

function formatRows(rows: Array<{ count: number; percent: number; label: string }>): string[] {
	if (rows.length === 0) return [`  ${chalk.dim("(none)")}`];
	const maxCountWidth = Math.max(...rows.map(row => row.count.toString().length));
	return rows.map(row => {
		const count = row.count.toString().padStart(maxCountWidth);
		const percent = `${row.percent.toFixed(1)}%`.padStart(6);
		return `  ${count}  ${percent}  ${row.label}`;
	});
}

export function formatDryBalanceText(summary: DryBalanceSummary): string {
	const accountRows = summary.success.accounts.map(row => ({
		count: row.count,
		percent: row.percent,
		label: row.account,
	}));
	const failureRows = summary.failure.reasons.map(row => ({
		count: row.count,
		percent: row.percent,
		label: row.reason,
	}));
	const lines = [
		chalk.bold("dry-balance"),
		`model: ${summary.model}`,
		`provider: ${summary.provider}`,
		`samples: ${summary.samples}`,
		`concurrency: ${summary.concurrency}`,
		"",
		`${chalk.green("success")} ${summary.success.total}`,
		...formatRows(accountRows),
		"",
		`${summary.failure.total > 0 ? chalk.red("failure") : chalk.dim("failure")} ${summary.failure.total}`,
		...formatRows(failureRows),
	];
	if (summary.bench) {
		const avgTtft =
			summary.bench.success.averageTtftMs === null ? "-" : formatBenchDuration(summary.bench.success.averageTtftMs);
		const avgTps =
			summary.bench.success.averageTokensPerSecond === null
				? "-"
				: formatBenchTps(summary.bench.success.averageTokensPerSecond);
		const benchFailureRows = summary.bench.failure.reasons.map(row => ({
			count: row.count,
			percent: row.percent,
			label: row.reason,
		}));
		lines.push(
			"",
			chalk.bold("bench"),
			`requests: ${summary.bench.total}`,
			`${chalk.green("success")} ${summary.bench.success.total}`,
			`avg TTFT: ${avgTtft}`,
			`avg TPS: ${avgTps}`,
			"",
			`${summary.bench.failure.total > 0 ? chalk.red("failure") : chalk.dim("failure")} ${summary.bench.failure.total}`,
			...formatRows(benchFailureRows),
		);
	}
	return `${lines.join("\n")}\n`;
}

export async function runDryBalanceCommand(
	command: DryBalanceCommandArgs,
	deps: DryBalanceDependencies = {},
): Promise<DryBalanceSummary> {
	const isBench = command.flags.bench === true;
	const samples = isBench ? 0 : normalizePositiveInteger("count", command.flags.count, DEFAULT_SAMPLE_COUNT);
	const concurrency = isBench
		? 0
		: Math.min(samples, normalizePositiveInteger("concurrency", command.flags.concurrency, DEFAULT_CONCURRENCY));
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const streamFn = deps.streamSimple ?? streamSimple;
	const now = deps.now ?? (() => performance.now());
	const runtime = await (deps.createRuntime ?? createDefaultRuntime)();
	let progress: DryBalanceBenchProgressSink | undefined;
	let progressClosed = false;
	const closeProgress = (): void => {
		if (progressClosed) return;
		progressClosed = true;
		progress?.close();
	};
	try {
		const modelSelector = command.flags.model ?? command.model;
		const { model, warning } = await resolveDryBalanceModel(
			modelSelector,
			runtime.modelRegistry,
			runtime.settings,
			randomSessionId,
		);
		if (warning) writeStderr(`${chalk.yellow(`Warning: ${warning}`)}\n`);
		let results: DryBalanceAttemptResult[];
		let benchResults: DryBalanceBenchResult[] | undefined;
		let summarySamples = samples;
		let summaryConcurrency = concurrency;
		if (isBench) {
			const targets = await resolveBenchTargets(model, runtime.modelRegistry.authStorage);
			if (targets.length === 0) throw new Error(`No OAuth accounts resolved for provider ${model.provider}`);
			summarySamples = targets.length;
			summaryConcurrency = targets.length;
			const progressWrite = command.flags.json ? writeStderr : writeStdout;
			const progressInteractive = command.flags.json
				? (deps.stderrIsTTY ?? process.stderr.isTTY === true)
				: (deps.stdoutIsTTY ?? process.stdout.isTTY === true);
			const progressColumns = command.flags.json
				? (deps.stderrColumns ?? process.stderr.columns ?? 80)
				: (deps.stdoutColumns ?? process.stdout.columns ?? 80);
			progress = createBenchProgressSink(targets.length, progressWrite, progressInteractive, progressColumns);
			benchResults = await runBenchTargets(
				model,
				targets,
				runtime.modelRegistry.authStorage,
				randomSessionId,
				progress,
				streamFn,
				now,
			);
			results = targets.map(target =>
				target.ok ? { ok: true, account: target.account } : { ok: false, reason: target.error },
			);
		} else {
			const sessionIds = Array.from({ length: samples }, () => randomSessionId());
			results = await mapConcurrent(sessionIds, concurrency, sessionId =>
				runOneAttempt(model, runtime.modelRegistry, sessionId),
			);
		}
		closeProgress();
		const summary = summarizeResults(model, summarySamples, summaryConcurrency, results);
		if (benchResults) {
			const benchSummary = summarizeBenchResults(benchResults);
			if (benchSummary) summary.bench = benchSummary;
		}
		if (command.flags.json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else {
			writeStdout(formatDryBalanceText(summary));
		}
		if (summary.failure.total > 0 || (summary.bench?.failure.total ?? 0) > 0) setExitCode(1);
		return summary;
	} finally {
		closeProgress();
		runtime.close?.();
	}
}
