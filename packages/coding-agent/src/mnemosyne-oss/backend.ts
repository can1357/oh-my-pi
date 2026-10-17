import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type {
	MemoryBackend,
	MemoryBackendSaveInput,
	MemoryBackendSearchItem,
	MemoryBackendSearchOptions,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../memory-backend/types";
import instructionsTemplate from "../prompts/memories/mnemosyne-oss-instructions.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { loadMnemosyneOssConfig } from "./config";
import {
	getMnemosyneOssOwner,
	getMnemosyneOssSessionState,
	MnemosyneOssSessionState,
	setMnemosyneOssSessionState,
} from "./state";

const INSTRUCTIONS = instructionsTemplate.trim();
const SHARED_CLEAR_REFUSAL =
	"Mnemosyne OSS clear refused: the active bank is shared; configure a non-default bank with mnemosyne-oss.ownership=omp before clearing.";

export const mnemosyneOssBackend: MemoryBackend = {
	id: "mnemosyne-oss",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings, agentDir } = options;
		if (!session.sessionId) return;
		const parent = options.parentMnemosyneOssSessionState;
		if (options.taskDepth > 0 && !parent) return;
		const config = parent?.config ?? loadMnemosyneOssConfig(settings, agentDir);
		if (config.diagnostic) {
			logger.warn("Mnemosyne OSS backend inert", { diagnostic: config.diagnostic });
			return;
		}
		const state = new MnemosyneOssSessionState({
			sessionId: session.sessionId,
			config,
			session,
			aliasOf: parent,
		});
		const previous = setMnemosyneOssSessionState(session, state);
		await previous?.dispose();
		if (!parent) {
			try {
				await state.probe();
			} catch (error) {
				setMnemosyneOssSessionState(session, undefined);
				await state.worker.shutdown();
				logger.warn("Mnemosyne OSS backend inert", { diagnostic: String(error) });
				return;
			}
		}
		state.attachSessionListeners();
	},

	async buildDeveloperInstructions(_agentDir, _cwd, _settings, session): Promise<string | undefined> {
		const owner = getMnemosyneOssOwner(session);
		if (!owner) return undefined;
		return [INSTRUCTIONS, owner.lastRecallSnippet].filter(Boolean).join("\n\n");
	},

	async beforeAgentStartPrompt(session, promptText, signal): Promise<MemoryPromptPreparation | undefined> {
		const state = getMnemosyneOssSessionState(session);
		const preparation = await state?.beforeAgentStartPrompt(promptText, signal);
		if (!state || !preparation) return undefined;
		// A backend switch or clear while recall ran replaced the state; its recall must not land.
		return {
			context: preparation.context,
			commit: () => getMnemosyneOssSessionState(session) === state && preparation.commit(),
		};
	},

	async preCompactionContext(
		messages: AgentMessage[],
		_settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined> {
		return await getMnemosyneOssSessionState(session)?.recallForCompaction(messages);
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		const state = getMnemosyneOssSessionState(session);
		if (!state || state.aliasOf) return;
		const config = state.config;
		if (
			config.ownership !== "omp" ||
			config.retainBank === "default" ||
			config.sharedBanks.includes(config.retainBank)
		) {
			throw new Error(SHARED_CLEAR_REFUSAL);
		}
		await state.clearAndRehydrate();
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = getMnemosyneOssSessionState(session);
		if (!state || state.aliasOf) return;
		await state.forceRetainCurrentSession();
		await state.sleep();
	},

	async status({ session }): Promise<MemoryBackendStatus> {
		const owner = getMnemosyneOssOwner(session);
		if (!owner) {
			return {
				backend: "mnemosyne-oss",
				active: false,
				writable: false,
				searchable: false,
				message: "Mnemosyne OSS backend is not initialised for this session.",
			};
		}
		try {
			const [status, capabilities] = await Promise.all([owner.status(), owner.capabilities()]);
			const healthy = status.banks.every(bank => bank.health === "ok");
			const workingCount = sumBankCount(status.banks, "working_count");
			const episodicCount = sumBankCount(status.banks, "episodic_count");
			const tripleCount = sumBankCount(status.banks, "triple_count");
			return {
				backend: "mnemosyne-oss",
				active: healthy,
				writable: healthy,
				searchable: healthy,
				scope: owner.config.scoping,
				retainBank: owner.config.retainBank,
				recallBanks: [...owner.config.recallBanks],
				ownership: owner.config.ownership,
				workingCount,
				episodicCount,
				tripleCount,
				databases: status.banks.map(bank => bank.database),
				sdkVersion: status.sdk_version,
				pythonVersion: status.python_version,
				embeddingMode: status.embedding_mode,
				consolidationMode: status.consolidation_mode,
				clearMode: capabilities.clear_mode,
				lastMemory: owner.lastWriteAt,
				lastRecall: !!owner.lastRecallAt,
				message: healthy ? undefined : "One or more Mnemosyne OSS banks reported an unhealthy status.",
			};
		} catch (error) {
			return {
				backend: "mnemosyne-oss",
				active: false,
				writable: false,
				searchable: false,
				message: String(error),
			};
		}
	},

	async search({ session }, query, options?: MemoryBackendSearchOptions) {
		const owner = getMnemosyneOssOwner(session);
		if (!owner) {
			return {
				backend: "mnemosyne-oss",
				query,
				count: 0,
				items: [],
				message: "Mnemosyne OSS backend is not initialised for this session.",
			};
		}
		if (options?.signal?.aborted) {
			return { backend: "mnemosyne-oss", query, count: 0, items: [], message: "Search aborted." };
		}
		const results = await owner.recall(query, options?.signal);
		if (options?.signal?.aborted) {
			return { backend: "mnemosyne-oss", query, count: 0, items: [], message: "Search aborted." };
		}
		const items: MemoryBackendSearchItem[] = results
			.slice(0, options?.limit === undefined ? undefined : Math.max(0, options.limit))
			.map(item => ({
				id: item.id,
				content: item.content,
				source: item.source,
				timestamp: item.timestamp,
				score: item.score,
				bank: item.bank,
			}));
		return { backend: "mnemosyne-oss", query, count: items.length, items };
	},

	async save({ session }, input: MemoryBackendSaveInput) {
		const owner = getMnemosyneOssOwner(session);
		if (!owner)
			return {
				backend: "mnemosyne-oss",
				stored: 0,
				message: "Mnemosyne OSS backend is not initialised for this session.",
			};
		const id = await owner.save(input);
		return { backend: "mnemosyne-oss", stored: 1, ids: [id] };
	},

	async stats(agentDir, cwd, session): Promise<string | undefined> {
		return await renderStatus(await this.status?.({ agentDir, cwd, session }));
	},

	async diagnose(_agentDir, _cwd, session): Promise<string | undefined> {
		const owner = getMnemosyneOssOwner(session);
		if (!owner) return undefined;
		try {
			const status = await owner.status();
			return [
				"Mnemosyne OSS diagnostics:",
				`SDK: ${status.sdk_version}`,
				`Python: ${status.python_version}`,
				`Embedding mode: ${status.embedding_mode}`,
				`Consolidation mode: ${status.consolidation_mode}`,
				`Data directory: ${owner.config.dataDir}`,
				`Retain bank: ${owner.config.retainBank}`,
				`Recall banks: ${owner.config.recallBanks.join(", ")}`,
				...status.banks.map(bank => `${bank.bank}: ${bank.health} (${bank.database})`),
			].join("\n");
		} catch (error) {
			return `Mnemosyne OSS diagnostics unavailable: ${String(error)}`;
		}
	},
};

function sumBankCount(
	banks: readonly { working_count?: number; episodic_count?: number; triple_count?: number }[],
	key: "working_count" | "episodic_count" | "triple_count",
): number | undefined {
	const values = banks.map(bank => bank[key]).filter((value): value is number => typeof value === "number");
	return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

async function renderStatus(status: MemoryBackendStatus | undefined): Promise<string | undefined> {
	if (!status) return undefined;
	const lines = [
		"Mnemosyne OSS status:",
		`Active: ${status.active ? "yes" : "no"}`,
		`Scope: ${status.scope ?? "unknown"}`,
		`Retain bank: ${status.retainBank ?? "unknown"}`,
		`Recall banks: ${status.recallBanks?.join(", ") ?? "unknown"}`,
		`Ownership: ${status.ownership ?? "unknown"}`,
		`SDK: ${status.sdkVersion ?? "unknown"}`,
		`Python: ${status.pythonVersion ?? "unknown"}`,
		`Embedding mode: ${status.embeddingMode ?? "unknown"}`,
		`Consolidation mode: ${status.consolidationMode ?? "unknown"}`,
		`Databases: ${status.databases?.join(", ") ?? "unknown"}`,
	];
	if (status.message) lines.push(`Message: ${status.message}`);
	return lines.join("\n");
}
