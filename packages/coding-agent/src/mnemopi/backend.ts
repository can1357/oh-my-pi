import { rm } from "node:fs/promises";
import * as path from "node:path";
import { type ApiKeyResolver, completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import type { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { MnemopiLlmCompleteOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import type * as MnemopiDiagnoseNs from "@oh-my-pi/pi-mnemopi/diagnose";
import type { DiagnosticSummary } from "@oh-my-pi/pi-mnemopi/diagnose";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { roleCandidatePool } from "../config/model-roles";
import { resolveRoleChain } from "../config/model-resolver";
import type {
	MemoryBackend,
	MemoryBackendSaveInput,
	MemoryBackendSearchItem,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../memory-backend/types";
import { memoryToolRefs } from "../memory-backend/tool-names";
import memoryConsolidationPrompt from "../prompts/system/memory-consolidation-system.md" with { type: "text" };
import memoryExtractionPrompt from "../prompts/system/memory-extraction-system.md" with { type: "text" };
import mnemopiInstructions from "../prompts/system/mnemopi-instructions.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { tinyModelClient } from "../tiny/title-client";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	loadMnemopiConfig,
	type MnemopiBackendConfig,
	type MnemopiProviderOptions,
	truncateApproxTokens,
} from "./config";
import {
	getMnemopiScopedBanks,
	getMnemopiScopedDbPaths,
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	requireMnemopi,
	requireMnemopiCore,
	setMnemopiSessionState,
} from "./state";

import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgMnemopiInjectionTokenLimit } from "./settings";

// `/diagnose` is the only user of this subpath; load it lazily alongside the
// loaders in ./state to keep mnemopi off the CLI startup module graph.
let mnemopiDiagnoseMod: typeof MnemopiDiagnoseNs | undefined;

async function loadMnemopiDiagnose(): Promise<typeof MnemopiDiagnoseNs> {
	if (!mnemopiDiagnoseMod) {
		mnemopiDiagnoseMod = await import("@oh-my-pi/pi-mnemopi/diagnose");
	}
	return mnemopiDiagnoseMod;
}

/** Prompt turns for one Mnemopi completion. */
export interface MemoryCompletionInput {
	prompt: string;
	systemPrompt?: string;
}

/** Maps a Mnemopi completion into instruction and input turns.
 *
 *  Extraction is the only task with its own instructions, and it always supplies
 *  the raw text, so the instructions become the system turn and the text becomes
 *  the user turn. Every other task keeps the prompt Mnemopi rendered. */
export function resolveMemoryCompletionInput(
	prompt: string,
	options?: MnemopiLlmCompleteOptions,
): MemoryCompletionInput {
	if (options?.task?.kind === "memory-extraction") {
		return { prompt: options.task.input, systemPrompt: memoryExtractionPrompt };
	}
	return { prompt };
}

async function installMnemopiState(session: AgentSession, config: MnemopiBackendConfig): Promise<MnemopiSessionState> {
	const state = new MnemopiSessionState({ sessionId: session.sessionId, config, session });
	const previous = setMnemopiSessionState(session, state);
	await previous?.dispose();
	try {
		state.attachSessionListeners();
		// Promote age-eligible working memory to episodic before the session's
		// first write can TTL-trim unconsolidated retain/learn rows (#10770).
		state.promoteEligibleWorkingMemory();
		return state;
	} catch (error) {
		setMnemopiSessionState(session, undefined);
		await state.dispose({ consolidate: false });
		throw error;
	}
}

export const mnemopiBackend: MemoryBackend = {
	id: "mnemopi",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings, agentDir, modelRegistry } = options;
		const sessionId = session.sessionId;
		if (!sessionId) return;

		if (options.taskDepth > 0) {
			const parent = getMnemopiSessionStateFromParent(options);
			if (!parent) return;
			const previous = setMnemopiSessionState(
				session,
				new MnemopiSessionState({
					sessionId,
					config: parent.config,
					session,
					aliasOf: parent,
					hasRecalledForFirstTurn: true,
				}),
			);
			await previous?.dispose();
			return;
		}

		try {
			const config = await loadMnemopiConfigWithProviders(settings, agentDir, modelRegistry, sessionId);
			await Promise.all([loadMnemopi(), loadMnemopiCore()]);
			await installMnemopiState(session, config);
		} catch (error) {
			logger.warn("Mnemopi: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		const state = getMnemopiSessionState(session);
		const primary = state?.aliasOf ?? state;
		const parts = [prompt.render(mnemopiInstructions, { toolRefs: memoryToolRefs(session?.getXdevToolEntries()) })];
		if (primary?.lastRecallSnippet) parts.push(primary.lastRecallSnippet);
		const rendered = parts.join("\n\n").trim();
		if (!rendered) return undefined;
		return truncateApproxTokens(rendered, cfgMnemopiInjectionTokenLimit.get(settings));
	},

	async beforeAgentStartPrompt(session, promptText, signal): Promise<MemoryPromptPreparation | undefined> {
		const state = getMnemopiSessionState(session);
		const preparation = await state?.beforeAgentStartPrompt(promptText, signal);
		if (!preparation) return undefined;
		if (preparation.context) {
			// Match the canonical memory block's budget while the recall is staged
			// separately from its static instructions. Commit still caches the full snippet.
			const instructions = prompt.render(mnemopiInstructions, {
				toolRefs: memoryToolRefs(session.getXdevToolEntries()),
			});
			const rendered = [instructions, preparation.context].join("\n\n").trim();
			preparation.context =
				truncateApproxTokens(rendered, cfgMnemopiInjectionTokenLimit.get(session.settings))
					.slice(instructions.length)
					.trim() || undefined;
		}
		return {
			context: preparation.context,
			commit: () => getMnemopiSessionState(session) === state && preparation.commit(),
		};
	},

	async clear(agentDir, _cwd, session): Promise<void> {
		const previous = session ? setMnemopiSessionState(session, undefined) : undefined;
		await previous?.dispose({ consolidate: false });
		const config = previous?.config ?? (session ? loadMnemopiConfig(session.settings, agentDir) : undefined);
		if (!config) return;
		await loadMnemopiCore();
		// Close the cached default Mnemopi instance so its SQLite handle doesn't
		// keep the DB files locked on Windows when removeDbFiles tries to delete.
		// Use the core module (already awaited via loadMnemopiCore above):
		// requireMnemopi() throws "module not loaded" when clear() runs before the
		// fire-and-forget start() has awaited loadMnemopi() (autolearn disabled, or
		// taskDepth > 0). resetMemoryForTests is re-exported identically from core.
		requireMnemopiCore().resetMemoryForTests();
		await Bun.sleep(0);
		await removeDbFiles(getMnemopiScopedDbPaths(config));
		if (!session?.sessionId || previous?.aliasOf || cfgMemoryBackend.get(session.settings) !== "mnemopi") return;
		try {
			await Promise.all([loadMnemopi(), loadMnemopiCore()]);
			await installMnemopiState(session, config);
		} catch (error) {
			logger.warn("Mnemopi: clear rehydrate failed; memory backend inert.", { error: String(error) });
		}
	},

	async enqueue(agentDir, _cwd, session): Promise<void> {
		try {
			let state = getMnemopiSessionState(session);
			if (!state && session?.sessionId) {
				const config = await loadMnemopiConfigWithProviders(
					session.settings,
					agentDir,
					session.modelRegistry,
					session.sessionId,
				);
				await Promise.all([loadMnemopi(), loadMnemopiCore()]);
				state = await installMnemopiState(session, config);
			}
			await state?.consolidate({ full: true, retain: true });
		} catch (error) {
			logger.warn("Mnemopi: enqueue failed.", { error: String(error) });
		}
	},

	async stats(agentDir, _cwd, session): Promise<string | undefined> {
		await Promise.all([loadMnemopi(), loadMnemopiCore()]);
		const { targets, owned } = createStatsTargets(agentDir, session);
		try {
			if (targets.length === 0) return undefined;
			return renderMnemopiStats(targets);
		} finally {
			for (const memory of owned) memory.close();
		}
	},

	async diagnose(agentDir, _cwd, session): Promise<string | undefined> {
		const state = getMnemopiSessionState(session);
		const config = state?.config ?? (session ? loadMnemopiConfig(session.settings, agentDir) : undefined);
		if (!config) return undefined;
		const [{ inspectDatabase }] = await Promise.all([loadMnemopiDiagnose(), loadMnemopiCore()]);
		const banks = getMnemopiScopedBanks(config);
		const dbPaths = getMnemopiScopedDbPaths(config);
		const summaries = dbPaths.map((dbPath, index) => ({
			bank: banks[index] ?? "unknown",
			summary: inspectDatabase({ dbPath, initialize: false }),
		}));
		return renderMnemopiDiagnostics(summaries);
	},

	async status({ agentDir, session }): Promise<MemoryBackendStatus> {
		const state = getMnemopiSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "mnemopi",
				active: false,
				writable: false,
				searchable: false,
				message: "Mnemopi backend is not initialised for this session.",
			};
		}

		const { targets, owned } = createStatsTargets(agentDir, session);
		try {
			if (targets.length === 0) {
				return {
					backend: "mnemopi",
					active: false,
					writable: false,
					searchable: false,
					message: "Mnemopi backend is configured but not initialised for this session.",
				};
			}
			return summarizeMnemopiStatus(targets, session);
		} finally {
			for (const memory of owned) memory.close();
		}
	},

	async search({ session }, query, options) {
		const state = getMnemopiSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "mnemopi",
				query,
				count: 0,
				items: [],
				message: "Mnemopi backend is not initialised for this session.",
			};
		}
		if (options?.signal?.aborted) {
			return { backend: "mnemopi", query, count: 0, items: [], message: "Search aborted." };
		}
		const limit = clampLimit(options?.limit);
		const results = (await primary.recallResultsScoped(query)).slice(0, limit);
		if (options?.signal?.aborted) {
			return { backend: "mnemopi", query, count: 0, items: [], message: "Search aborted." };
		}
		const items: MemoryBackendSearchItem[] = results.map(result => ({
			id: result.id,
			content: result.content,
			source: result.source ?? undefined,
			timestamp: result.timestamp ?? undefined,
			score: result.score,
		}));
		return { backend: "mnemopi", query, count: items.length, items };
	},

	async save({ cwd, session }, input: MemoryBackendSaveInput) {
		const state = getMnemopiSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "mnemopi",
				stored: 0,
				message: "Mnemopi backend is not initialised for this session.",
			};
		}
		const content = input.content.trim();
		if (!content) return { backend: "mnemopi", stored: 0, message: "Memory content is empty." };
		let id: string;
		try {
			id = primary.rememberScoped(content, {
				source: input.source || "coding-agent-memory-command",
				importance: normalizeImportance(input.importance),
				metadata: {
					session_id: primary.sessionId,
					cwd,
					context: input.context ?? null,
					operation: "memory.save",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "user",
				memoryType: "fact",
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { backend: "mnemopi", stored: 0, ids: [], message: `Mnemopi did not store the memory: ${reason}` };
		}
		return { backend: "mnemopi", stored: 1, ids: [id] };
	},

	async preCompactionContext(messages, _settings, session): Promise<string | undefined> {
		const state = getMnemopiSessionState(session);
		return await state?.recallForCompaction(messages);
	},
};

interface MnemopiStatsTarget {
	bank: string;
	memory: Mnemopi;
}

function createStatsTargets(
	agentDir: string,
	session: AgentSession | undefined,
): { targets: MnemopiStatsTarget[]; owned: Mnemopi[] } {
	const state = getMnemopiSessionState(session);
	if (state) {
		return {
			targets: dedupeStatsTargets([state.getScopedRetainTarget(), ...state.getScopedRecallTargets()]),
			owned: [],
		};
	}
	if (!session) return { targets: [], owned: [] };
	const config = loadMnemopiConfig(session.settings, agentDir);
	const targets = getMnemopiScopedBanks(config).map(bank => ({
		bank,
		memory: createStatsMemory(config, bank),
	}));
	return { targets, owned: targets.map(target => target.memory) };
}

function createStatsMemory(config: MnemopiBackendConfig, bank: string): Mnemopi {
	const providerOptions = config.providerOptions as Record<string, unknown>;
	const { Mnemopi } = requireMnemopi();
	return new Mnemopi({
		dbPath: resolveBankDbPath(config, bank),
		bank,
		sessionId: bank,
		authorId: "coding-agent",
		authorType: "agent",
		channelId: bank,
		...providerOptions,
		reconcile: false,
	} as ConstructorParameters<typeof Mnemopi>[0]);
}

function resolveBankDbPath(config: MnemopiBackendConfig, bank: string): string {
	const sharedBank = config.globalBank ?? config.baseBank ?? "default";
	if (bank === sharedBank) return config.dbPath;
	const { BankManager } = requireMnemopiCore();
	return new BankManager(path.dirname(config.dbPath)).getBankDbPath(bank);
}

function dedupeStatsTargets(targets: readonly MnemopiStatsTarget[]): MnemopiStatsTarget[] {
	const seen = new Set<string>();
	const unique: MnemopiStatsTarget[] = [];
	for (const target of targets) {
		if (seen.has(target.bank)) continue;
		seen.add(target.bank);
		unique.push(target);
	}
	return unique;
}

function renderMnemopiStats(targets: readonly MnemopiStatsTarget[]): string {
	const lines = [
		"# Mnemopi Memory Stats",
		"",
		"| Bank | Working | Episodic | Triples | Last memory | Database |",
		"|---|---:|---:|---:|---|---|",
	];
	for (const target of targets) {
		const stats = target.memory.getStats();
		lines.push(
			`| ${escapeMarkdownTableCell(target.bank)} | ${statCount(stats.beam.working_memory)} | ${statCount(
				stats.beam.episodic_memory,
			)} | ${stats.beam.triples.total} | ${escapeMarkdownTableCell(stats.last_memory ?? "never")} | ${escapeMarkdownTableCell(shortenPath(stats.database))} |`,
		);
	}
	return lines.join("\n");
}

function summarizeMnemopiStatus(
	targets: readonly MnemopiStatsTarget[],
	session: AgentSession | undefined,
): MemoryBackendStatus {
	let workingCount = 0;
	let episodicCount = 0;
	let tripleCount = 0;
	let lastMemory: string | undefined;
	let database: string | undefined;
	for (const target of targets) {
		const stats = target.memory.getStats();
		workingCount += statCount(stats.beam.working_memory);
		episodicCount += statCount(stats.beam.episodic_memory);
		tripleCount += stats.beam.triples.total;
		lastMemory ??= stats.last_memory ?? undefined;
		database ??= stats.database ? shortenPath(stats.database) : undefined;
	}
	const state = getMnemopiSessionState(session);
	const primary = state?.aliasOf ?? state;
	return {
		backend: "mnemopi",
		active: true,
		writable: true,
		searchable: true,
		scope: primary?.config.scoping,
		retainBank: primary?.getScopedRetainTarget().bank ?? targets[0]?.bank,
		recallBanks: primary?.getScopedRecallTargets().map(target => target.bank) ?? targets.map(target => target.bank),
		workingCount,
		episodicCount,
		tripleCount,
		lastMemory,
		lastRecall: Boolean(primary?.lastRecallSnippet),
		database,
	};
}

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit)) return 10;
	return Math.max(1, Math.min(50, Math.trunc(limit ?? 10)));
}

function normalizeImportance(value: number | undefined): number {
	if (!Number.isFinite(value)) return 0.75;
	return Math.max(0, Math.min(1, value ?? 0.75));
}

function renderMnemopiDiagnostics(entries: readonly { bank: string; summary: DiagnosticSummary }[]): string {
	const lines = [
		"# Mnemopi Memory Diagnostics",
		"",
		"| Bank | Passed | Failed | Integrity | Database |",
		"|---|---:|---:|---|---|",
	];
	for (const { bank, summary } of entries) {
		const integrity = summary.entries.find(entry => entry.check === "integrity_check")?.status ?? "unknown";
		lines.push(
			`| ${escapeMarkdownTableCell(bank)} | ${summary.checks_passed}/${summary.checks_total} | ${summary.checks_failed} | ${escapeMarkdownTableCell(integrity)} | ${escapeMarkdownTableCell(shortenPath(summary.database))} |`,
		);
	}
	const findings = entries.flatMap(({ bank, summary }) =>
		summary.key_findings.map(finding => `- ${bank}: ${finding}`),
	);
	lines.push("", "## Key Findings");
	lines.push(...(findings.length > 0 ? findings : ["- none"]));
	return lines.join("\n");
}

function statCount(value: unknown): number {
	if (typeof value !== "object" || value === null) return 0;
	const record = value as { total?: unknown; count?: unknown };
	if (typeof record.total === "number") return record.total;
	if (typeof record.count === "number") return record.count;
	return 0;
}

function escapeMarkdownTableCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function loadMnemopiConfigWithProviders(
	settings: MemoryBackendStartOptions["settings"],
	agentDir: string,
	modelRegistry: ModelRegistry,
	sessionId: string,
): Promise<MnemopiBackendConfig> {
	const config = loadMnemopiConfig(settings, agentDir);
	config.providerOptions = await resolveMnemopiProviderOptions(config, settings, modelRegistry, sessionId);
	return config;
}

/**
 * When mnemopi targets OpenRouter (its default embedding host) without a
 * user-pinned key, hand it the central {@link ApiKeyResolver} so requests pick
 * up AuthStorage credentials, force-refresh on 401, and rotate across sibling
 * keys. Returns undefined when the URL points elsewhere or when no OpenRouter
 * credential exists, preserving mnemopi's env-key fallback and its
 * "no key -> API embeddings unavailable" gating.
 */
async function openrouterKeyResolver(
	modelRegistry: ModelRegistry,
	sessionId: string,
	baseUrl: string | undefined,
): Promise<ApiKeyResolver | undefined> {
	if (baseUrl !== undefined && !hostMatchesUrl(baseUrl, "openrouter")) return undefined;
	const key = await modelRegistry.getApiKeyForProvider("openrouter", sessionId);
	if (key === undefined || key === "") return undefined;
	return modelRegistry.resolver("openrouter", { sessionId });
}

async function resolveMnemopiProviderOptions(
	config: MnemopiBackendConfig,
	settings: MemoryBackendStartOptions["settings"],
	modelRegistry: ModelRegistry,
	sessionId: string,
): Promise<MnemopiProviderOptions> {
	const base: MnemopiProviderOptions = {
		noEmbeddings: config.providerOptions.noEmbeddings,
		embeddingModel: config.providerOptions.embeddingModel,
		embeddingApiUrl: config.providerOptions.embeddingApiUrl,
		embeddingApiKey:
			config.providerOptions.embeddingApiKey ??
			(await openrouterKeyResolver(modelRegistry, sessionId, config.providerOptions.embeddingApiUrl)),
		llm: false,
	};

	if (config.llmMode === "none") return base;

	// An explicitly configured external Mnemopi endpoint remains authoritative;
	// role selection only supplies the normal managed-model path.
	if (config.llmMode === "remote") {
		return {
			...base,
			llm: {
				baseUrl: config.llmBaseUrl,
				apiKey:
					config.llmApiKey ??
					(config.llmBaseUrl === undefined
						? undefined
						: await openrouterKeyResolver(modelRegistry, sessionId, config.llmBaseUrl)),
				model: config.llmModel,
			},
		};
	}

	try {
		const candidates = resolveRoleChain("memory", settings, roleCandidatePool("memory", settings, modelRegistry));
		const primary = candidates[0]?.model;
		if (!primary) {
			logger.warn("Mnemopi: llmMode=smol but no memory model resolved; continuing without LLM.");
			return base;
		}

		const complete = async (prompt: string, opts?: MnemopiLlmCompleteOptions): Promise<string | null> => {
			const request = resolveMemoryCompletionInput(prompt, opts);
			const signal =
				typeof opts?.timeout === "number" && Number.isFinite(opts.timeout) && opts.timeout > 0
					? AbortSignal.timeout(opts.timeout)
					: undefined;

			for (const { model } of candidates) {
				if (signal?.aborted) return null;
				try {
					if (model.api === "local-inference") {
						const result = await tinyModelClient.complete(model.id, request.prompt, {
							maxTokens: opts?.maxTokens,
							systemPrompt: request.systemPrompt,
							signal,
						});
						if (result !== null) return result;
						if (signal?.aborted) return null;
						logger.warn("Mnemopi: local memory completion failed; trying the next configured fallback.", {
							provider: model.provider,
							model: model.id,
						});
						continue;
					}

					const hasApiKey = await modelRegistry.getApiKey(model, sessionId);
					if (!hasApiKey) {
						logger.warn("Mnemopi: memory completion model has no current API key; trying the next fallback.", {
							provider: model.provider,
							model: model.id,
						});
						continue;
					}
					const message = await retryTransientCompletion(
						() =>
							completeSimple(
								model,
								{
									...(request.systemPrompt ? { systemPrompt: [request.systemPrompt] } : {}),
									messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
								},
								{
									apiKey: modelRegistry.resolver(model, sessionId),
									sessionId,
									maxTokens: opts?.maxTokens,
									temperature: opts?.temperature,
									signal,
								},
							),
						{ provider: model.provider, signal },
					);
					if (message.stopReason === "aborted" || signal?.aborted) return null;
					if (message.stopReason === "error") {
						logger.warn("Mnemopi: memory completion model failed; trying the next configured fallback.", {
							provider: model.provider,
							model: model.id,
							error: message.errorMessage,
						});
						continue;
					}
					return message.content
						.filter(
							(block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
								block.type === "text",
						)
						.map(block => block.text)
						.join("\n")
						.trim();
				} catch (error) {
					if (signal?.aborted) return null;
					logger.warn("Mnemopi: memory completion model threw; trying the next configured fallback.", {
						provider: model.provider,
						model: model.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return null;
		};

		return {
			...base,
			llm:
				primary.api === "local-inference"
					? {
							complete,
							// No `extractionPrompt`: resolveMemoryCompletionInput supplies the
							// instructions as a system turn for every extraction call, so anything
							// rendered here would be built in code and then discarded.
							consolidationPrompt: memoryConsolidationPrompt,
						}
					: complete,
		};
	} catch (error) {
		logger.warn("Mnemopi: memory LLM resolution failed; continuing without LLM.", { error: String(error) });
		return base;
	}
}

function getMnemopiSessionStateFromParent(options: MemoryBackendStartOptions): MnemopiSessionState | undefined {
	const parent = options.parentMnemopiSessionState;
	return parent?.aliasOf ?? parent;
}

export function getMnemopiDbDirForTests(session: AgentSession): string | undefined {
	const state = getMnemopiSessionState(session);
	return state ? path.dirname(state.config.dbPath) : undefined;
}

/**
 * Best-effort removal of a SQLite DB file and its WAL/SHM sidecars.
 *
 * Windows keeps `-wal`/`-shm` busy briefly after the DB handle closes, so a
 * single `rm` races with EBUSY/EPERM. Retry a handful of times before giving
 * up; `force: true` already makes "missing" a non-error.
 */
async function removeDbFiles(dbPaths: readonly string[]): Promise<void> {
	for (const dbPath of dbPaths) {
		for (const suffix of ["", "-wal", "-shm"]) {
			await removeWithRetries(`${dbPath}${suffix}`).catch(error => {
				// `force: true` already makes ENOENT a non-error; anything else
				// after the full retry window means the DB is genuinely locked and
				// the user's "Memory cleared" message would be misleading. Log so
				// the failure is diagnosable without blocking the clear flow.
				const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
				if (code !== "ENOENT") {
					logger.warn("Mnemopi: failed to remove DB file after retries", { path: `${dbPath}${suffix}`, code });
				}
			});
		}
	}
}

const kRemoveRetries = 40;
const kRemoveRetryDelayMs = 25;
const kRetryableRemoveErrorCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetries(target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(target, { force: true });
			return;
		} catch (err) {
			const retryable =
				typeof err === "object" &&
				err !== null &&
				"code" in err &&
				typeof err.code === "string" &&
				kRetryableRemoveErrorCodes.has(err.code);
			if (!retryable || attempt >= kRemoveRetries) throw err;
			await Bun.sleep(kRemoveRetryDelayMs);
		}
	}
}
