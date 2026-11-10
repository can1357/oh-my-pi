import * as path from "node:path";
import type { MemoryWriteScope } from "../memory-backend/global-scope";
import { cleanOutboxText, MemoryOutbox, outboxEventId, sendFailure } from "../memory-backend/outbox";
import { type HindsightClientApi, HindsightError } from "./client";

const BATCH_SIZE = 16;

export interface RetainInput {
	content: string;
	context?: string;
	scope?: MemoryWriteScope;
}

/** A Hindsight outbox event (`<agentDir>/hindsight-outbox/<destination>/omp-retain-*.json`). */
export interface OutboxEvent {
	version: 1;
	/** Also the server `document_id`, so a resend replaces instead of duplicating. */
	id: string;
	scope: MemoryWriteScope;
	tags: string[];
	timestamp: string;
	content: string;
	context: string;
	sessionId: string;
}

export interface RetainCall {
	sessionId: string;
	toolCallId: string;
	/** Context for items without their own. */
	context: string;
	/** Tags of project-scoped items; global items are retained untagged. */
	tags: string[] | undefined;
}

export interface HindsightOutboxOptions {
	agentDir: string;
	apiUrl: string;
	bankId: string;
	client: HindsightClientApi;
	ensureBank: () => Promise<void>;
}

/** Tool-initiated retains for one bank; see {@link MemoryOutbox}. */
export function createHindsightOutbox(options: HindsightOutboxOptions): MemoryOutbox<OutboxEvent> {
	return new MemoryOutbox<OutboxEvent>({
		root: path.join(options.agentDir, "hindsight-outbox"),
		apiUrl: options.apiUrl,
		container: options.bankId,
		label: "Hindsight",
		batchSize: BATCH_SIZE,
		// Hindsight unions a request's item tags onto its document(s): one request per tag set, so
		// untagged global memories never share a request with project-tagged ones.
		groupKey: event => JSON.stringify(event.tags.toSorted()),
		prepare: options.ensureBank,
		isEvent: event =>
			(event.scope === "project" || event.scope === "global") &&
			Array.isArray(event.tags) &&
			event.tags.every(tag => typeof tag === "string") &&
			Number.isFinite(Date.parse(event.timestamp)) &&
			typeof event.content === "string" &&
			typeof event.context === "string" &&
			typeof event.sessionId === "string",
		send: async batch => {
			try {
				await options.client.retainBatch(
					options.bankId,
					batch.map(event => ({
						content: event.content,
						context: event.context,
						timestamp: new Date(event.timestamp),
						metadata: { session_id: event.sessionId },
						tags: event.tags.length > 0 ? event.tags : undefined,
						documentId: event.id,
						updateMode: "replace",
					})),
					{ async: true },
				);
				return "accepted";
			} catch (error) {
				return sendFailure(error, error instanceof HindsightError ? error.statusCode : undefined);
			}
		},
	});
}

/** One tool call's events, stripped of terminal controls, `apiToken`, and recognizable secrets. */
export function hindsightRetainEvents(call: RetainCall, items: RetainInput[], apiToken: string | null): OutboxEvent[] {
	if (!call.sessionId || !call.toolCallId) throw new Error("Hindsight retain requires a session and tool call id.");
	return items.map((item, index) => {
		const scope = item.scope ?? "project";
		const context = cleanOutboxText(item.context ?? call.context, apiToken);
		const content = cleanOutboxText(item.content, apiToken);
		return {
			version: 1,
			// Tool call ids are not guaranteed unique, so the persisted fields are part of the
			// identity: a reused id with new content is a new document, not a replacement.
			id: outboxEventId([call.sessionId, call.toolCallId, index, scope, context, content]),
			scope,
			tags: scope === "global" ? [] : (call.tags ?? []).map(tag => cleanOutboxText(tag, apiToken)),
			timestamp: new Date().toISOString(),
			content,
			context,
			sessionId: cleanOutboxText(call.sessionId, apiToken),
		};
	});
}
