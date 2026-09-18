/**
 * Groq / semantic coprocessor path: search-driven grants → typed EvidencePacketV1.
 */

import { executeLeasedCompletion, type RlmWorkerMessage } from "./broker";
import {
	EVIDENCE_PACKET_V1_JSON_SCHEMA,
	EVIDENCE_WORKER_STATIC_SYSTEM,
	emptyEvidencePacket,
	evidencePacketByteSize,
	formatEvidencePacketForRoot,
	parseEvidencePacketV1,
	tryParseEvidencePacketJson,
	type EvidencePacketV1,
} from "./evidence-packet";
import type { RlmCompleter, RlmQueryArgs, RlmQueryResult } from "./query";
import { QUERY_SLICE } from "./query";
import { RlmRuntime } from "./runtime";
import { selectGrantsFromSearch, type RlmGrantSelectResult } from "./select-grants";
import type { RlmStore } from "./store";
import { assertWorkerMembrane } from "./worker-membrane";
import { formatViewExcerpts, resolveRlmView, viewCitations, type RlmGrant, type RlmView } from "./view";

export interface RlmEvidenceQueryResult extends RlmQueryResult {
	packet?: EvidencePacketV1;
	workerSkipped?: boolean;
	packetBytes?: number;
}

export interface RlmEvidenceCompleter extends RlmCompleter {
	(
		prompt: string,
		options?: {
			signal?: AbortSignal;
			deadlineAt?: number;
			purpose?: "rlm-evidence-packet";
			workerMessages?: readonly RlmWorkerMessage[];
			responseSchema?: Record<string, unknown>;
		},
	): Promise<{ text: string; tokens?: number; cost?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; provider?: string; model?: string; structured?: unknown } | string>;
}

function grantHandle(selection: RlmGrantSelectResult | undefined, fallback: string): string {
	return selection?.grants[0]?.handle ?? fallback;
}

function citationHandle(citation: string, fallback: string): string {
	const m = /^([^\[]+)/.exec(citation.trim());
	return m?.[1]?.trim() ?? fallback;
}
export interface EvidenceWorkerRequestInput {
	task: string;
	view: RlmView;
}

/**
 * Build evidence-worker provider payload from a resolved view only.
 * Intentionally cannot access {@link RlmStore} — grants must be resolved upstream.
 */
export function buildEvidenceWorkerRequest(input: EvidenceWorkerRequestInput): import("./broker").RlmWorkerContext {
	const { task, view } = input;
	const excerpts = formatViewExcerpts(view);
	const citations = viewCitations(view);
	const schemaBlock = JSON.stringify(EVIDENCE_PACKET_V1_JSON_SCHEMA, null, 2);
	const user =
		`Task:\n${task}\n\n` +
		`Granted excerpts (ONLY source of truth):\n${excerpts}\n\n` +
		`Return EvidencePacketV1 JSON matching schema. Citations: ${citations || view.id}`;
	const messages: RlmWorkerMessage[] = [
		{
			role: "system",
			content:
				`${EVIDENCE_WORKER_STATIC_SYSTEM}\n\n` +
				`Schema (EvidencePacketV1):\n${schemaBlock}\n\n` +
				`Rules:\n- status=sufficient only when claims fully answer the task\n- status=partial when more ranges needed\n- status=abstain when excerpts insufficient\n- every claim MUST include citations with handle + byte offsets\n- no summary field`,
		},
		{ role: "user", content: user },
	];
	const prompt = messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n");
	const context: import("./broker").RlmWorkerContext = {
		purpose: "rlm-evidence-packet",
		viewId: view.id,
		depth: 0,
		messages,
		prompt,
		citations,
		grantedBytes: view.grantedBytes,
	};
	assertWorkerMembrane(context, view);
	return context;
}

/** @deprecated Prefer {@link buildEvidenceWorkerRequest}. */
export function buildEvidenceWorkerContext(view: RlmView, task: string): import("./broker").RlmWorkerContext {
	return buildEvidenceWorkerRequest({ task, view });
}

/** Deterministic gate: single obvious extraction → packet without model call. */
export function tryDeterministicEvidencePacket(
	selection: RlmGrantSelectResult | undefined,
	question: string,
): EvidencePacketV1 | null {
	if (!selection || selection.empty || selection.hits.length === 0) return null;
	if (selection.hits.length !== 1) return null;
	const hit = selection.hits[0]!;
	const q = question.toLowerCase();
	const wantsExact =
		q.includes("exact") || q.includes("token") || q.includes("needle") || q.includes("root_cause") || q.includes("what is");
	if (!wantsExact) return null;

	const rootCause = /root_cause=([A-Za-z0-9_]+)/.exec(hit.text);
	if (rootCause) {
		return {
			status: "sufficient",
			claims: [
				{
					fact: rootCause[1]!,
					confidence: 1,
					citations: [{ handle: citationHandle(hit.citation, grantHandle(selection, hit.citation)), start: hit.index, end: hit.index + hit.text.length }],
				},
			],
			contradictions: [],
			missingEvidence: [],
			relevantRanges: [],
		};
	}

	const needle = /(NEEDLE_[A-Za-z0-9_]+)/.exec(hit.text);
	if (needle) {
		const token = needle[1]!;
		return {
			status: "sufficient",
			claims: [{ fact: token, confidence: 1, citations: [{ handle: citationHandle(hit.citation, grantHandle(selection, hit.citation)), start: hit.index, end: hit.index + token.length }] }],
			contradictions: [],
			missingEvidence: [],
			relevantRanges: [],
		};
	}

	const trimmed = hit.text.trim();
	if (trimmed.length > 0 && trimmed.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
		return {
			status: "sufficient",
			claims: [{ fact: trimmed, confidence: 0.95, citations: [{ handle: citationHandle(hit.citation, grantHandle(selection, hit.citation)), start: hit.index, end: hit.index + trimmed.length }] }],
			contradictions: [],
			missingEvidence: [],
			relevantRanges: [],
		};
	}
	return null;
}

export async function rlmEvidenceQuery(
	storeOrRuntime: RlmStore | RlmRuntime,
	args: RlmQueryArgs,
): Promise<RlmEvidenceQueryResult> {
	const runtime =
		storeOrRuntime instanceof RlmRuntime ? storeOrRuntime : RlmRuntime.fromStore(storeOrRuntime);
	const store = runtime.store;
	const handle = args.handle;
	const q = (args.question ?? "").trim();
	if (!q) {
		store.note("evidence-query", "empty question", true);
		return { text: "question is required (fail-open)", citation: handle, failOpen: true };
	}

	let grants: RlmGrant[];
	let selection: RlmGrantSelectResult | undefined;

	if (args.grants && args.grants.length > 0) {
		grants = [...args.grants];
	} else if (args.patterns !== undefined) {
		try {
			selection = selectGrantsFromSearch(store, handle, args.patterns, args.selectPolicy);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			store.note("evidence-query", msg, true);
			return { text: `${msg} (fail-open)`, citation: handle, failOpen: true, selection };
		}
		if (selection.empty || selection.grants.length === 0) {
			store.metrics.queries += 1;
			store.metrics.workerCallsAvoided += 1;
			const packet = emptyEvidencePacket("abstain");
			return {
				text: formatEvidencePacketForRoot(packet),
				citation: handle,
				failOpen: true,
				selection,
				grantedBytes: 0,
				packet,
				workerSkipped: true,
				packetBytes: evidencePacketByteSize(packet),
			};
		}
		store.metrics.grantsSelected += selection.grants.length;
		grants = selection.grants;
	} else {
		grants = [{ handle, start: args.start ?? 0, end: args.end }];
	}

	store.metrics.queries += 1;

	const deterministic = tryDeterministicEvidencePacket(selection, q);
	if (deterministic) {
		store.metrics.workerCallsAvoided += 1;
		let view;
		try {
			view = resolveRlmView(store, grants, { perGrantSlice: QUERY_SLICE });
		} catch {
			view = undefined;
		}
		return {
			text: formatEvidencePacketForRoot(deterministic),
			citation: view?.grants.map(g => g.citation).join("; ") ?? handle,
			selection,
			grantedBytes: view?.grantedBytes ?? selection?.grantedBytes,
			packet: deterministic,
			workerSkipped: true,
			packetBytes: evidencePacketByteSize(deterministic),
		};
	}

	let view;
	try {
		view = resolveRlmView(store, grants, { perGrantSlice: QUERY_SLICE });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		store.note("evidence-query", msg, true);
		return { text: `${msg} (fail-open)`, citation: handle, failOpen: true, selection };
	}

	const worker = buildEvidenceWorkerRequest({ task: q, view });
	let structuredFromWorker: unknown;
	const wrappedComplete: RlmCompleter | undefined = args.complete
		? async (prompt, opts) => {
				const result = await args.complete!(prompt, {
					...opts,
					purpose: "rlm-evidence-packet",
					workerMessages: worker.messages,
				});
				if (typeof result !== "string" && result.structured !== undefined) {
					structuredFromWorker = result.structured;
				}
				return result;
			}
		: undefined;

	const result = await executeLeasedCompletion(runtime, worker, wrappedComplete, "query");

	let packet: EvidencePacketV1 | undefined;
	try {
		if (structuredFromWorker !== undefined) {
			packet = parseEvidencePacketV1(structuredFromWorker);
		} else {
			packet = tryParseEvidencePacketJson(result.text);
		}
	} catch {
		packet = emptyEvidencePacket("partial");
		packet.missingEvidence.push("worker returned non-conforming EvidencePacket");
	}

	const text = packet ? formatEvidencePacketForRoot(packet) : result.text;
	return {
		text,
		citation: result.citation,
		failOpen: result.failOpen,
		tokens: result.tokens,
		cost: result.cost,
		overBudget: result.overBudget,
		context: result.context,
		leaseId: result.lease?.id,
		aborted: result.aborted,
		selection,
		grantedBytes: view.grantedBytes,
		packet,
		packetBytes: packet ? evidencePacketByteSize(packet) : undefined,
		workerSkipped: false,
	};
}
