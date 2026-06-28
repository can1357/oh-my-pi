import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ProviderPayload, ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages";
import { type CompactionEntry, EPHEMERAL_MODEL_CHANGE_ROLE, type SessionEntry } from "./session-entries";

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel?: string;
	/** Configured thinking selector (`"auto"` or a concrete level) from the latest change. */
	configuredThinkingLevel?: string;
	serviceTier?: ServiceTier;
	/** Model roles: { default: "provider/modelId", small: "provider/modelId", ... } */
	models: Record<string, string>;
	/** Names of TTSR rules that have been injected this session */
	injectedTtsrRules: string[];
	/** MCP tool names selected through discovery for this session branch. */
	selectedMCPToolNames: string[];
	/** Whether this branch contains an explicit persisted MCP selection entry. */
	hasPersistedMCPToolSelection: boolean;
	/** Active mode (e.g. "plan") or "none" if no special mode is active */
	mode: string;
	/** Mode-specific data from the last mode_change entry */
	modeData?: Record<string, unknown>;
	/**
	 * Array parallel to messages, indicating which assistant turns should
	 * have their prompt-cache misses suppressed/explained (because a model,
	 * compaction, or plan-mode transition directly preceded them).
	 * Only populated in transcript mode.
	 */
	cacheMissExplainedAt?: boolean[];
}

/** Lists session model strings to try when restoring, in fallback order. */
export function getRestorableSessionModels(
	models: Readonly<Record<string, string>>,
	lastModelChangeRole: string | undefined,
): string[] {
	const defaultModel = models.default;
	if (
		!lastModelChangeRole ||
		lastModelChangeRole === "default" ||
		lastModelChangeRole === EPHEMERAL_MODEL_CHANGE_ROLE
	) {
		return defaultModel ? [defaultModel] : [];
	}

	const roleModel = models[lastModelChangeRole];
	if (!roleModel) return defaultModel ? [defaultModel] : [];
	if (!defaultModel || roleModel === defaultModel) return [roleModel];
	return [roleModel, defaultModel];
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export interface BuildSessionContextOptions {
	/**
	 * Build the display transcript instead of the LLM context. By default this
	 * preserves every path entry with compactions inline; set
	 * `collapseCompactedHistory` for the live TUI surface to render only the
	 * latest compacted tail.
	 */
	transcript?: boolean;
	/** In transcript mode, elide entries replaced by the latest compaction. */
	collapseCompactedHistory?: boolean;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
	options?: BuildSessionContextOptions,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		};
	}

	// Walk from leaf to root, collecting path
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	// Extract settings and find compaction
	let thinkingLevel: string | undefined = "off";
	let configuredThinkingLevel: string | undefined;
	let serviceTier: ServiceTier | undefined;
	const models: Record<string, string> = {};
	let compaction: CompactionEntry | null = null;
	const injectedTtsrRulesSet = new Set<string>();
	let selectedMCPToolNames: string[] = [];
	let hasPersistedMCPToolSelection = false;
	let mode = "none";
	let modeData: Record<string, unknown> | undefined;
	// Track whether an explicit `model_change` with role="default" has been
	// seen on this path. Once a user (or the agent itself) records an
	// explicit default, later assistant-message inference must NOT overwrite
	// it: temporary fallbacks (retry fallback, context promotion) and
	// server-side model downgrades both produce assistant messages tagged
	// with the wrong model id, which previously clobbered the user's pick on
	// resume (issue #849).
	let hasExplicitDefaultModel = false;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel ?? "off";
			configuredThinkingLevel = entry.configured ?? entry.thinkingLevel ?? undefined;
		} else if (entry.type === "model_change") {
			// New format: { model: "provider/id", role?: string }
			if (entry.model) {
				const role = entry.role ?? "default";
				models[role] = entry.model;
				if (role === "default") {
					hasExplicitDefaultModel = true;
				}
			}
		} else if (entry.type === "service_tier_change") {
			serviceTier = entry.serviceTier ?? undefined;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// Legacy fallback: infer default model from assistant messages only
			// when no explicit `model_change` (role=default) entry has been
			// recorded yet. Newer sessions always record an explicit default
			// model_change at the start of the conversation, so this branch is
			// only used to keep pre-model_change sessions working.
			if (!hasExplicitDefaultModel) {
				models.default = `${entry.message.provider}/${entry.message.model}`;
			}
		} else if (entry.type === "compaction") {
			compaction = entry;
		} else if (entry.type === "ttsr_injection") {
			// Collect injected TTSR rule names
			for (const ruleName of entry.injectedRules) {
				injectedTtsrRulesSet.add(ruleName);
			}
		} else if (entry.type === "mcp_tool_selection") {
			selectedMCPToolNames = [...entry.selectedToolNames];
			hasPersistedMCPToolSelection = true;
		} else if (entry.type === "mode_change") {
			mode = entry.mode;
			modeData = entry.data;
		}
	}

	const injectedTtsrRules = Array.from(injectedTtsrRulesSet);

	// Build messages and collect corresponding entries
	// When there's a compaction, we need to:
	// 1. Emit summary first (entry = compaction)
	// 2. Emit kept messages (from firstKeptEntryId up to compaction)
	// 3. Emit messages after compaction
	const messages: AgentMessage[] = [];
	const cacheMissExplainedAt: boolean[] = [];
	let pendingReset = false;
	let currentMode = "none";
	let lastAssistantModel: string | undefined;

	const handleEntryResetTracking = (entry: SessionEntry) => {
		if (entry.type === "compaction") {
			pendingReset = true;
		} else if (entry.type === "model_change") {
			pendingReset = true;
		} else if (entry.type === "mode_change") {
			const isPlanTransition = (entry.mode === "plan") !== (currentMode === "plan");
			if (isPlanTransition) {
				pendingReset = true;
			}
			currentMode = entry.mode;
		}
	};

	const pushMessage = (msg: AgentMessage) => {
		messages.push(msg);
		if (!options?.transcript) return;
		if (msg.role === "assistant") {
			const currentModel = `${msg.provider}/${msg.model}`;
			const modelChanged = lastAssistantModel !== undefined && lastAssistantModel !== currentModel;
			lastAssistantModel = currentModel;
			cacheMissExplainedAt.push(pendingReset || modelChanged);
			pendingReset = false;
		} else {
			cacheMissExplainedAt.push(false);
		}
	};

	const appendMessage = (entry: SessionEntry) => {
		handleEntryResetTracking(entry);
		if (entry.type === "message") {
			pushMessage(entry.message);
		} else if (entry.type === "custom_message") {
			pushMessage(
				createCustomMessage(
					entry.customType,
					entry.content,
					entry.display,
					entry.details,
					entry.timestamp,
					entry.attribution,
				),
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			pushMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	};

	if (options?.transcript && !options.collapseCompactedHistory) {
		// Display transcript: every entry in chronological order. Compactions do
		// not erase prior history here — each renders inline (as a divider in the
		// TUI) at the point it fired, with any snapcompact frames re-attached so
		// the component can report them.
		for (const entry of path) {
			handleEntryResetTracking(entry);
			if (entry.type === "compaction") {
				const snapcompactArchive = snapcompact.getPreservedArchive(entry.preserveData);
				pushMessage(
					createCompactionSummaryMessage(
						entry.summary,
						entry.tokensBefore,
						entry.timestamp,
						entry.shortSummary,
						undefined,
						undefined,
						snapcompactArchive ? snapcompact.historyBlocks(snapcompactArchive) : undefined,
					),
				);
			} else {
				appendMessage(entry);
			}
		}
	} else if (compaction) {
		const providerPayload: ProviderPayload | undefined = (() => {
			const candidate = compaction.preserveData?.openaiRemoteCompaction;
			if (!candidate || typeof candidate !== "object") return undefined;
			const remote = candidate as { provider?: unknown; replacementHistory?: unknown };
			if (typeof remote.provider !== "string" || remote.provider.length === 0) return undefined;
			if (!Array.isArray(remote.replacementHistory)) return undefined;
			return {
				type: "openaiResponsesHistory",
				provider: remote.provider,
				items: remote.replacementHistory as Array<Record<string, unknown>>,
			};
		})();
		const remoteReplacementHistory = providerPayload?.items;

		if (options?.transcript) handleEntryResetTracking(compaction);
		// Emit summary first; re-attach any archived snapcompact frames so the
		// model can keep reading the archived history after every context rebuild.
		const snapcompactArchive = snapcompact.getPreservedArchive(compaction.preserveData);
		pushMessage(
			createCompactionSummaryMessage(
				compaction.summary,
				compaction.tokensBefore,
				compaction.timestamp,
				compaction.shortSummary,
				providerPayload,
				undefined,
				snapcompactArchive ? snapcompact.historyBlocks(snapcompactArchive) : undefined,
			),
		);

		// Find compaction index in path
		const compactionIdx = path.findIndex(e => e.type === "compaction" && e.id === compaction.id);

		// The remote replacement payload (OpenAI remote compaction) carries the
		// kept turns for the LLM context only; it is not rendered as visible
		// messages. The collapsed display transcript must still emit the kept
		// SessionEntry rows so a remotely-compacted session keeps its recent
		// turns visible instead of showing only the summary and post-compaction.
		if (!remoteReplacementHistory || options?.transcript) {
			// Emit kept messages (before compaction, starting from firstKeptEntryId)
			let foundFirstKept = false;
			for (let i = 0; i < compactionIdx; i++) {
				const entry = path[i];
				if (entry.id === compaction.firstKeptEntryId) {
					foundFirstKept = true;
				}
				if (foundFirstKept) {
					appendMessage(entry);
				}
			}
		}

		// Emit messages after compaction
		for (let i = compactionIdx + 1; i < path.length; i++) {
			const entry = path[i];
			appendMessage(entry);
		}
	} else {
		// No compaction - emit all messages, handle branch summaries and custom messages
		for (const entry of path) {
			appendMessage(entry);
		}
	}

	// Strip dangling tool_use blocks — a tool_use with no matching tool_result on the
	// resolved leaf→root path — from ANY assistant turn, not just the trailing one.
	// This happens whenever the leaf (or a branch point) lands such that an assistant
	// turn's tool results are off the selected path: its result children live on a
	// sibling branch, or it is the leaf itself (results are children below it). Left
	// in place, `transformMessages` fabricates one synthetic "aborted"/"No result
	// provided" result per dangling call, which render as phantom failed calls and
	// re-inject the failed batch into the model's
	// context — the rewind/restore loop.
	//
	// Stripping is necessary but not sufficient: a *modified* assistant turn that still
	// carries signed `thinking`/`redacted_thinking` is rejected by Anthropic — "thinking
	// blocks in the latest assistant message cannot be modified", and signed thinking
	// replayed out of its original turn shape can also fail signature validation (this
	// bites the handoff/branch-summary request). So when we rewrite a turn we also
	// neutralize its protected reasoning: drop `redactedThinking` (encrypted, no
	// plaintext to keep) and clear `thinking` signatures so the provider encoder
	// downgrades them to plain text (verified accepted by the live API), preserving the
	// visible reasoning while removing the immutability/invalid-signature hazard. Drop a
	// turn left with no content. (Live turns never qualify: their results are persisted
	// on the same path before any context rebuild.)
	const pairedToolResultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") pairedToolResultIds.add(message.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const hasDangling = message.content.some(
			block => block.type === "toolCall" && !pairedToolResultIds.has(block.id),
		);
		if (!hasDangling) continue;
		const normalized = message.content
			.filter(
				block =>
					!(block.type === "toolCall" && !pairedToolResultIds.has(block.id)) && block.type !== "redactedThinking",
			)
			.map(block =>
				block.type === "thinking" && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block,
			);
		if (normalized.length === 0) {
			messages.splice(i, 1);
			if (options?.transcript) {
				cacheMissExplainedAt.splice(i, 1);
			}
		} else {
			messages[i] = { ...message, content: normalized };
		}
	}

	return {
		messages,
		cacheMissExplainedAt: options?.transcript ? cacheMissExplainedAt : undefined,
		thinkingLevel,
		configuredThinkingLevel,
		serviceTier,
		models,
		injectedTtsrRules,
		selectedMCPToolNames,
		hasPersistedMCPToolSelection,
		mode,
		modeData,
	};
}
