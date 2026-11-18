/**
 * Protocol handler for `btw://` URLs: the session's `/btw` side questions and
 * answers, which live in a sidecar outside the main transcript.
 *
 * URL forms:
 * - btw://          - lists recent topics, newest first
 * - btw://<id>      - every turn of one topic, with full answers
 *
 * Only the calling session's history is visible. A focused subagent reads its
 * own scoped topics; main reads the unscoped root. Neither falls through to
 * the other, so a subagent can never read its parent's side questions.
 */
import btwPromptDoc from "../prompts/internal-urls/btw.md" with { type: "text" };
import btwPromptReference from "../prompts/internal-urls/btw-reference.md" with { type: "text" };
import {
	type BtwHistoryRecord,
	type BtwHistoryTurn,
	BtwHistoryStore,
	getBtwLatestTurn,
	getBtwTurns,
} from "../session/btw-history";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

/** The listing shows a one-line preview; `btw://<id>` returns the full turns. */
const PREVIEW_CHARS = 600;

function formatTimestamp(ms: number): string {
	return new Date(ms).toISOString();
}

function formatTurn(turn: BtwHistoryTurn): string {
	const images = turn.images?.length ? `\nimages: ${turn.images.length}` : "";
	const error = turn.error ? `\nerror: ${turn.error}` : "";
	return [
		`question: ${turn.question}${images}`,
		`status: ${turn.status}${error}`,
		"answer:",
		turn.answer.trim() ? turn.answer : "(no answer recorded)",
	].join("\n");
}

function formatTopic(record: BtwHistoryRecord): string {
	const turns = getBtwTurns(record);
	const title = record.title === undefined ? "" : `title: ${record.title}\n`;
	return [
		`/btw topic btw://${record.id}`,
		`${title}question: ${record.question}`,
		`status: ${getBtwLatestTurn(record).status}`,
		`created: ${formatTimestamp(record.createdAt)}`,
		`updated: ${formatTimestamp(record.updatedAt)}`,
		`turns: ${turns.length}`,
		"",
		...turns.map((turn, index) => `--- turn ${index + 1} (${turn.status}) ---\n${formatTurn(turn)}`),
	].join("\n");
}

function previewAnswer(turn: BtwHistoryTurn): string {
	const answer = turn.answer.trim().replace(/\s+/g, " ");
	if (!answer) return "(no answer recorded)";
	return answer.length > PREVIEW_CHARS ? `${answer.slice(0, PREVIEW_CHARS)}…` : answer;
}

function formatListing(record: BtwHistoryRecord): string {
	const title = record.title === undefined ? "" : ` (${record.title})`;
	const turns = getBtwTurns(record);
	return [
		`btw://${record.id}${title}`,
		`question: ${record.question}`,
		`status: ${getBtwLatestTurn(record).status} | turns: ${turns.length} | updated: ${formatTimestamp(record.updatedAt)}`,
		`latest answer: ${previewAnswer(getBtwLatestTurn(record))}`,
	].join("\n");
}

function renderListing(records: readonly BtwHistoryRecord[]): string {
	if (records.length === 0) return "No /btw topics are stored for this session.";
	return [
		`/btw topics (${records.length}, newest first)`,
		"",
		records.map(formatListing).join("\n\n"),
		"",
		"Read `btw://<id>` for every turn of a topic with full answers; line selectors apply (`btw://<id>:50-80`).",
	].join("\n");
}

/** Artifacts dir and scope for this caller, or the reason the scheme cannot resolve. */
function resolveCaller(context?: ResolveContext): { artifactsDir: string; scope?: string } {
	const dir = context?.session?.getArtifactsDir?.() ?? context?.localProtocolOptions?.getArtifactsDir?.();
	if (!dir) throw new Error("btw:// history is unavailable: this session has no artifacts directory.");
	const depth = context?.session?.taskDepth ?? 0;
	if (depth === 0) return { artifactsDir: dir };
	const sessionId = context?.sessionId;
	if (!sessionId) throw new Error("btw:// history is unavailable: this subagent has no session id.");
	return { artifactsDir: dir, scope: sessionId };
}

async function openStore(context?: ResolveContext): Promise<BtwHistoryStore> {
	const { artifactsDir, scope } = resolveCaller(context);
	return BtwHistoryStore.open(artifactsDir, scope);
}

/** A `btw://<id>` path segment, rejecting sub-paths so a typo does not silently list instead. */
function requestedTopic(url: InternalUrl): string | undefined {
	const id = url.rawHost || url.hostname;
	if (!id) return undefined;
	if (url.pathname && url.pathname !== "/") {
		throw new Error("btw:// takes a topic id only; use line selectors to read part of an answer.");
	}
	return id;
}

export class BtwProtocolHandler implements ProtocolHandler {
	readonly scheme = "btw";
	/** Virtual: the rendered listing/topic is not a file on disk. */
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
	};

	promptDoc(): string {
		return btwPromptDoc.trim();
	}

	promptReference(): string {
		return btwPromptReference.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (url.search || url.hash) {
			throw new Error("btw:// takes no query or fragment; use line selectors to read part of an answer.");
		}
		const store = await openStore(context);
		const records = store.getRecords();
		const id = requestedTopic(url);
		const content =
			id === undefined
				? renderListing(records)
				: (() => {
						const record = records.find(candidate => candidate.id === id);
						if (record) return formatTopic(record);
						const known = records.length === 0 ? "none" : records.map(r => r.id).join(", ");
						throw new Error(`Unknown /btw topic: ${id}\nAvailable: ${known}`);
					})();
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	/** Topic ids for `btw://` autocomplete; current-session topics only. */
	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		try {
			return (await openStore(context)).getRecords().map(record => ({
				value: record.id,
				...(record.title === undefined ? {} : { label: record.title }),
				description: record.question.replace(/\s+/g, " ").slice(0, 80),
			}));
		} catch {
			// Completion is advisory: an unresolvable session (no artifacts, embedded host) just offers nothing.
			return [];
		}
	}
}
