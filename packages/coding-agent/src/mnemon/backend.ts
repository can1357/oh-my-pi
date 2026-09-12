import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type HindsightMessage, prepareRetentionTranscript } from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import type {
	MemoryBackend,
	MemoryBackendForgetResult,
	MemoryBackendLinkCandidate,
	MemoryBackendLinkInput,
	MemoryBackendLinkResult,
	MemoryBackendLinkType,
	MemoryBackendRelatedInput,
	MemoryBackendRelatedItem,
	MemoryBackendRelatedResult,
	MemoryBackendSaveInput,
	MemoryBackendSearchItem,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
} from "../memory-backend/types";
import mnemonCompactionTemplate from "../prompts/memories/mnemon-compaction.md" with { type: "text" };
import mnemonFirstTurnTemplate from "../prompts/memories/mnemon-first-turn.md" with { type: "text" };
import mnemonInstructionsTemplate from "../prompts/memories/mnemon-instructions.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { createMnemonCli, findMnemonCommand, type MnemonCli } from "./cli";
import {
	applyMnemonRecallQuality,
	focusMnemonQuery,
	formatMnemonSilentRecall,
	type MnemonRecallMode,
	type MnemonRecallRow,
	parseMnemonRecallPayload,
} from "./quality";

const SECRET_RE =
	/(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;

const INSIGHT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_TYPES = new Set<MemoryBackendLinkType>(["causal", "semantic", "temporal", "entity", "supersedes"]);
const CATEGORIES = new Set(["preference", "decision", "insight", "fact", "context"]);

function looksLikeSecret(value: string | undefined) {
	return Boolean(value && SECRET_RE.test(value));
}

function isUnsupportedSupersedesError(error: unknown) {
	const text = error instanceof Error ? error.message : String(error);
	return /invalid edge type ["']supersedes["']/i.test(text) || /valid:.*\bcausal\b.*\bentity\b/i.test(text);
}

function asRecord(value: unknown) {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function parseLinkCandidates(parsed: Record<string, unknown> | undefined): MemoryBackendLinkCandidate[] {
	const out: MemoryBackendLinkCandidate[] = [];
	const seen: Record<string, true> = {};
	const push = (raw: unknown, kind: MemoryBackendLinkCandidate["kind"], scoreKey: "similarity" | "hop") => {
		if (!Array.isArray(raw)) return;
		for (const entry of raw) {
			const row = asRecord(entry);
			const id = typeof row?.id === "string" ? row.id.trim() : "";
			if (!INSIGHT_ID_RE.test(id) || seen[id]) continue;
			seen[id] = true;
			const scoreRaw = row?.[scoreKey];
			out.push({
				id,
				kind,
				content: typeof row?.content === "string" ? row.content.slice(0, 220) : undefined,
				score: typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : undefined,
			});
			if (out.length >= 8) return;
		}
	};
	push(parsed?.causal_candidates, "causal", "hop");
	if (out.length < 8) push(parsed?.semantic_candidates, "semantic", "similarity");
	return out;
}

export interface MnemonBackendConfig {
	cliPath?: string;
	autoRecall: boolean;
	recallLimit: number;
	autoRetain: boolean;
	retainEveryNTurns: number;
}

interface MnemonSessionState {
	cli: MnemonCli;
	config: MnemonBackendConfig;
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	aliasOf?: MnemonSessionState;
	lastRetainedTurn: number;
	unsubscribe?: () => void;
	retainInFlight?: Promise<void>;
}

const sessionStates = new WeakMap<AgentSession, MnemonSessionState>();

export function getMnemonSessionState(session: AgentSession | undefined) {
	return session ? sessionStates.get(session) : undefined;
}

function setMnemonSessionState(session: AgentSession, state: MnemonSessionState | undefined) {
	const previous = sessionStates.get(session);
	if (previous && previous !== state) {
		previous.unsubscribe?.();
		previous.unsubscribe = undefined;
	}
	if (state) sessionStates.set(session, state);
	else sessionStates.delete(session);
	return previous;
}

export function disposeMnemonSessionState(session: AgentSession | undefined): void {
	if (!session) return;
	setMnemonSessionState(session, undefined);
}

export function resetMnemonConversationTracking(session: AgentSession | undefined) {
	const state = getMnemonSessionState(session);
	if (!state || state.aliasOf) return false;
	state.hasRecalledForFirstTurn = false;
	state.lastRecallSnippet = undefined;
	state.lastRetainedTurn = 0;
	return true;
}

export function loadMnemonConfig(settings: Settings): MnemonBackendConfig {
	return {
		cliPath: settings.get("mnemon.cliPath"),
		autoRecall: settings.get("mnemon.autoRecall") !== false,
		recallLimit: Math.max(1, Math.min(50, settings.get("mnemon.recallLimit") ?? 3)),
		autoRetain: settings.get("mnemon.autoRetain") !== false,
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemon.retainEveryNTurns") ?? 4)),
	};
}

/** Slice messages to the tail after the last retained user turn. */
function sliceUnretainedMessages(messages: HindsightMessage[], lastRetainedTurn: number): HindsightMessage[] {
	if (lastRetainedTurn <= 0) return messages;
	let userTurns = 0;
	for (let index = 0; index < messages.length; index++) {
		if (messages[index].role !== "user") continue;
		userTurns++;
		if (userTurns > lastRetainedTurn) return messages.slice(index);
	}
	return [];
}
/** Retain the unretained transcript tail as one `context` insight via `mnemon remember`. */
async function retainTranscriptTail(state: MnemonSessionState, session: AgentSession, force = false): Promise<void> {
	const flat = extractMessages(session.sessionManager);
	const userTurns = flat.filter(message => message.role === "user").length;
	if (!force && userTurns - state.lastRetainedTurn < state.config.retainEveryNTurns) return;
	const { transcript } = prepareRetentionTranscript(sliceUnretainedMessages(flat, state.lastRetainedTurn), true);
	if (!transcript) return;
	const args = ["remember", "--cat", "context", "--imp", "2", "--source", "agent", "--no-diff", "--", transcript];
	try {
		await state.cli.runText(args, { timeoutMs: 8_000 });
		state.lastRetainedTurn = userTurns;
	} catch (error) {
		logger.warn("Mnemon: auto-retain failed", { error: String(error) });
	}
}

async function recall(cli: MnemonCli, query: string, limit: number, mode: MnemonRecallMode, signal?: AbortSignal) {
	const num = Number(limit);
	const requested = Math.max(1, Math.min(50, Number.isFinite(num) ? Math.round(num) : 10));
	const payload = await cli.runJson(["recall", "--limit", String(Math.min(50, requested * 3)), "--", query], {
		signal,
		timeoutMs: 8_000,
		readonly: true,
	});
	const parsed = parseMnemonRecallPayload(payload);
	return applyMnemonRecallQuality(parsed.results, { limit: requested, mode });
}

function toSearchItems(rows: MnemonRecallRow[]): MemoryBackendSearchItem[] {
	return rows.map(row => ({
		id: typeof row.id === "string" ? row.id : undefined,
		content: String(row.content ?? ""),
		source: typeof row.category === "string" ? row.category : undefined,
		score: typeof row.score === "number" ? row.score : undefined,
	}));
}

function cliFor(session: AgentSession | undefined, settings?: Settings) {
	const state = getMnemonSessionState(session);
	const primary = state?.aliasOf ?? state;
	if (primary) return primary.cli;
	const configured = settings?.get("mnemon.cliPath") ?? session?.settings?.get("mnemon.cliPath");
	return createMnemonCli(findMnemonCommand(configured));
}

export function normalizeMnemonImportance(value: number | undefined) {
	if (!Number.isFinite(value)) return 3;
	const num = value as number;
	// Fractional 0-1 compatibility values (mnemopi confidence) scale onto 1-5;
	// an explicit integer 1 keeps its documented lowest-importance meaning.
	if (num > 0 && num < 1) return Math.max(1, Math.min(5, Math.round(num * 5)));
	return Math.max(1, Math.min(5, Math.round(num)));
}

async function readMnemonStatus(session: AgentSession | undefined): Promise<MemoryBackendStatus> {
	const cli = cliFor(session);
	try {
		const raw = await cli.runText(["status"], { timeoutMs: 5_000, readonly: true });
		const parsed = asRecord(JSON.parse(raw));
		const insights = typeof parsed?.total_insights === "number" ? parsed.total_insights : undefined;
		const edges = typeof parsed?.edge_count === "number" ? parsed.edge_count : undefined;
		return {
			backend: "mnemon",
			active: true,
			writable: true,
			searchable: true,
			scope: "global ~/.mnemon",
			workingCount: insights,
			tripleCount: edges,
			database: typeof parsed?.db_path === "string" ? parsed.db_path : undefined,
			message: `${insights ?? "?"} insights, ${edges ?? "?"} edges via ${cli.command}`,
		};
	} catch (error) {
		return {
			backend: "mnemon",
			active: false,
			writable: false,
			searchable: false,
			error: error instanceof Error ? error.message : String(error),
			message: "mnemon CLI unavailable. Install mnemon and keep it on PATH, or set mnemon.cliPath.",
		};
	}
}

export const mnemonBackend: MemoryBackend = {
	id: "mnemon",

	async start(options: MemoryBackendStartOptions) {
		const { session } = options;
		if (!session.sessionId) return;
		// Subagents do not auto-recall. search/save fall back to an ephemeral CLI.
		if (options.taskDepth > 0) return;
		try {
			const config = loadMnemonConfig(options.settings);
			const state: MnemonSessionState = {
				cli: createMnemonCli(findMnemonCommand(config.cliPath)),
				config,
				hasRecalledForFirstTurn: false,
				lastRetainedTurn: 0,
			};
			setMnemonSessionState(session, state);
			if (config.autoRetain) {
				state.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
					if (event.type === "agent_end") {
						state.retainInFlight = retainTranscriptTail(state, session).catch(error => {
							logger.warn("Mnemon: agent_end retention failed", { error: String(error) });
						});
					}
				});
			}
		} catch (error) {
			logger.warn("Mnemon: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, _settings, session) {
		const state = getMnemonSessionState(session);
		const primary = state?.aliasOf ?? state;
		const rendered = prompt
			.render(mnemonInstructionsTemplate, {
				recall_snippet: primary?.lastRecallSnippet,
			})
			.trim();
		return rendered || undefined;
	},

	async beforeAgentStartPrompt(session, promptText) {
		const state = getMnemonSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary?.config.autoRecall || primary.hasRecalledForFirstTurn) return undefined;
		const query = focusMnemonQuery(promptText);
		if (!query) return undefined;
		primary.hasRecalledForFirstTurn = true;
		try {
			const filtered = await recall(primary.cli, query, primary.config.recallLimit, "silent");
			if (filtered.results.length === 0) return undefined;
			const snippet = prompt
				.render(mnemonFirstTurnTemplate, {
					content: formatMnemonSilentRecall(filtered.results),
					dropped: filtered.dropped > 0 ? filtered.dropped : undefined,
				})
				.trim();
			primary.lastRecallSnippet = snippet;
			return snippet;
		} catch (error) {
			logger.debug("Mnemon: silent recall failed", { error: String(error) });
			return undefined;
		}
	},

	async clear() {
		throw new Error(
			"Refused: memory.backend=mnemon will not wipe ~/.mnemon. Use `mnemon forget <id>` or `mnemon gc`.",
		);
	},

	async enqueue(_agentDir, _cwd, session) {
		const state = getMnemonSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) return;
		// Force retention of the current transcript tail regardless of the turn cadence.
		await retainTranscriptTail(primary, session as AgentSession, true);
	},

	async status({ session }): Promise<MemoryBackendStatus> {
		return readMnemonStatus(session);
	},

	async search({ session, cwd: _cwd }, query, options) {
		const focused = focusMnemonQuery(query, 500);
		if (!focused) return { backend: "mnemon", query: "", count: 0, items: [], message: "Empty query." };
		if (options?.signal?.aborted) {
			return { backend: "mnemon", query: focused, count: 0, items: [], message: "Search aborted." };
		}
		try {
			const filtered = await recall(cliFor(session), focused, options?.limit ?? 10, "explicit", options?.signal);
			return {
				backend: "mnemon",
				query: focused,
				count: filtered.results.length,
				items: toSearchItems(filtered.results),
				message:
					filtered.dropped > 0 ? `omitted ${filtered.dropped} low-confidence or overflow memories` : undefined,
			};
		} catch (error) {
			return {
				backend: "mnemon",
				query: focused,
				count: 0,
				items: [],
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async save({ session }, input: MemoryBackendSaveInput) {
		const content = input.content.trim();
		if (!content) return { backend: "mnemon" as const, stored: 0, message: "Memory content is empty." };
		if ([content, input.context, input.source, input.entities, input.category].some(looksLikeSecret)) {
			return {
				backend: "mnemon" as const,
				stored: 0,
				message: "Refused: memory looks like a secret, token, or private key.",
			};
		}
		const category = input.category?.trim().toLowerCase();
		if (category && !CATEGORIES.has(category)) {
			return { backend: "mnemon" as const, stored: 0, message: `Invalid category ${input.category}.` };
		}
		const importance = normalizeMnemonImportance(input.importance);
		const context = input.context?.trim();
		const memoryContent = context ? `${content}\n\nContext: ${context}` : content;
		const args = [
			"remember",
			"--cat",
			category || "context",
			"--imp",
			String(importance),
			"--source",
			input.source || "agent",
		];
		const entities = input.entities?.trim();
		if (entities) args.push("--entities", entities);
		args.push("--", memoryContent);
		try {
			const output = await cliFor(session).runText(args, { timeoutMs: 8_000 });
			const parsed = asRecord(JSON.parse(output));
			const rawId = typeof parsed?.id === "string" ? parsed.id : undefined;
			const replacedId = typeof parsed?.replaced_id === "string" ? parsed.replaced_id : undefined;
			const action = typeof parsed?.action === "string" ? parsed.action : "added";
			const effectiveId = action === "skipped" ? (replacedId ?? rawId) : (rawId ?? replacedId);
			return {
				backend: "mnemon" as const,
				stored: action === "skipped" ? 0 : 1,
				ids: effectiveId ? [effectiveId] : [],
				message: action,
				candidates: parseLinkCandidates(parsed),
			};
		} catch (error) {
			return {
				backend: "mnemon" as const,
				stored: 0,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async link({ session }, input: MemoryBackendLinkInput): Promise<MemoryBackendLinkResult> {
		const id1 = input.id1.trim();
		const id2 = input.id2.trim();
		if (!INSIGHT_ID_RE.test(id1) || !INSIGHT_ID_RE.test(id2)) {
			return { backend: "mnemon", status: "rejected", message: "id1 and id2 must be insight UUIDs." };
		}
		if (id1 === id2) {
			return { backend: "mnemon", status: "rejected", message: "Refused: cannot link an insight to itself." };
		}
		if (!LINK_TYPES.has(input.type)) {
			return { backend: "mnemon", status: "rejected", message: `Invalid type ${input.type}.` };
		}
		if (!Number.isFinite(input.weight) || input.weight < 0 || input.weight > 1) {
			return { backend: "mnemon", status: "rejected", message: "weight must be 0–1." };
		}
		const run = async (type: MemoryBackendLinkType) =>
			asRecord(
				await cliFor(session).runJson(["link", id1, id2, "--type", type, "--weight", String(input.weight)], {
					timeoutMs: 8_000,
				}),
			);
		try {
			let usedType = input.type;
			let parsed: Record<string, unknown> | undefined;
			try {
				parsed = await run(input.type);
			} catch (error) {
				if (input.type !== "supersedes" || !isUnsupportedSupersedesError(error)) throw error;
				parsed = await run("causal");
				usedType = "causal";
			}
			const linked = parsed?.status === "linked";
			return {
				backend: "mnemon",
				status: linked ? "linked" : "rejected",
				id1: typeof parsed?.source_id === "string" ? parsed.source_id : id1,
				id2: typeof parsed?.target_id === "string" ? parsed.target_id : id2,
				type: usedType,
				weight: input.weight,
				message: linked
					? usedType === input.type
						? "linked"
						: "linked as causal; CLI rejected supersedes"
					: "mnemon link did not confirm",
			};
		} catch (error) {
			return {
				backend: "mnemon",
				status: "rejected",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async related({ session }, input: MemoryBackendRelatedInput): Promise<MemoryBackendRelatedResult> {
		const id = input.id.trim();
		if (!INSIGHT_ID_RE.test(id)) {
			return { backend: "mnemon", id, count: 0, items: [], message: "id must be an insight UUID." };
		}
		if (input.type && !LINK_TYPES.has(input.type)) {
			return { backend: "mnemon", id, count: 0, items: [], message: `Invalid type ${input.type}.` };
		}
		const depth = Number.isFinite(input.depth) ? Math.max(1, Math.min(4, Math.round(input.depth!))) : 2;
		try {
			const args = ["related", id, "--depth", String(depth)];
			if (input.type) args.push("--edge", input.type);
			const raw = await cliFor(session).runJson(args, { timeoutMs: 8_000, readonly: true });
			const rows = Array.isArray(raw) ? raw : [];
			const items: MemoryBackendRelatedItem[] = [];
			for (const entry of rows) {
				const row = asRecord(entry);
				const relatedId = typeof row?.id === "string" ? row.id : "";
				if (!INSIGHT_ID_RE.test(relatedId)) continue;
				items.push({
					id: relatedId,
					content: typeof row?.content === "string" ? row.content : "",
					category: typeof row?.category === "string" ? row.category : undefined,
					importance: typeof row?.importance === "number" ? row.importance : undefined,
					depth: typeof row?.depth === "number" ? row.depth : undefined,
					via: typeof row?.via_edge_type === "string" ? row.via_edge_type : undefined,
				});
			}
			return { backend: "mnemon", id, count: items.length, items };
		} catch (error) {
			return {
				backend: "mnemon",
				id,
				count: 0,
				items: [],
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async forget({ session }, rawId: string): Promise<MemoryBackendForgetResult> {
		const id = rawId.trim();
		if (!INSIGHT_ID_RE.test(id)) {
			return { backend: "mnemon", status: "rejected", message: "id must be an insight UUID." };
		}
		try {
			const parsed = asRecord(await cliFor(session).runJson(["forget", id], { timeoutMs: 8_000 }));
			return {
				backend: "mnemon",
				status: parsed?.status === "deleted" ? "deleted" : "rejected",
				id: typeof parsed?.id === "string" ? parsed.id : id,
				message:
					typeof parsed?.message === "string"
						? parsed.message
						: parsed?.status === "deleted"
							? "deleted"
							: "forget did not confirm",
			};
		} catch (error) {
			return {
				backend: "mnemon",
				status: "rejected",
				id,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},

	async stats(_agentDir, _cwd, session) {
		const status = await readMnemonStatus(session);
		if (!status.active) return `# mnemon\n\n${status.message ?? status.error ?? "unavailable"}`;
		return [
			"# mnemon",
			"",
			"- backend: mnemon (native CLI, not mnemopi)",
			`- insights: ${status.workingCount ?? "?"}`,
			`- edges: ${status.tripleCount ?? "?"}`,
			`- scope: ${status.scope}`,
			status.database ? `- db: ${status.database}` : "",
			"",
			"Typed graph (causal/semantic/temporal/entity/supersedes). Importance 1–5; 4+ is prune-immune.",
			"Do not point mnemopi.dbPath at this database.",
		]
			.filter(Boolean)
			.join("\n");
	},

	async diagnose(_agentDir, _cwd, session) {
		const state = getMnemonSessionState(session);
		const primary = state?.aliasOf ?? state;
		return [
			"# mnemon diagnose",
			"",
			primary ? `- CLI: ${primary.cli.command}` : "- CLI: ephemeral (session not started)",
			"- store: ~/.mnemon (never point mnemopi at this path; schemas differ)",
			"- require: mnemon on PATH. Homebrew 0.2.0 works; supersedes falls back to causal until the CLI admits the type",
			"- silent recall: high-score only; auto-retain stores raw transcript tails every N turns",
			"- /memory clear is refused: use forget or mnemon gc",
		].join("\n");
	},

	async preCompactionContext(messages) {
		const lastUser = [...messages].reverse().find(message => message.role === "user");
		const text =
			typeof lastUser?.content === "string"
				? lastUser.content
				: Array.isArray(lastUser?.content)
					? lastUser.content
							.map(block =>
								block && typeof block === "object" && "text" in block ? String(block.text ?? "") : "",
							)
							.join("\n")
					: "";
		const query = text.trim() ? focusMnemonQuery(text) : undefined;
		return prompt.render(mnemonCompactionTemplate, { query }).trim();
	},
};
