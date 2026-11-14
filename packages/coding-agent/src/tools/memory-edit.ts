import { type } from "@oh-my-pi/omptype";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { formatMemories } from "../hindsight/content";
import { noticeErrorText } from "../memory-backend/outbox";
import { cfgMemoryBackend } from "../memory-backend/settings";
import type { SupermemoryForgetResult } from "../supermemory/client";
import { isSupermemoryConfigured, loadSupermemoryConfig } from "../supermemory/config";

/**
 * Whether memory `id` is forgotten after a forget: `already` when an earlier forget did it (a
 * retried forget reached the desired state), otherwise `failure` says why it was not.
 */
function forgetOutcome(
	id: string,
	result: SupermemoryForgetResult,
	location: string,
): { already: boolean } | { failure: string } {
	if (result.matches.includes(id)) return { already: false };
	const error = result.errors.find(item => item.id === id)?.error ?? "";
	if (/already forgotten/i.test(error)) return { already: true };
	if (/not found/i.test(error)) return { failure: `Memory ${id} was not found ${location}.` };
	return { failure: `Memory ${id} was not forgotten ${location}: ${noticeErrorText(error) || "no reason given"}.` };
}

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate' | 'preview_forget'").describe("memory edit operation"),
	"id?": type("string").describe("memory id from recall output; required except for preview_forget"),
	"query?": type("string").describe("what to forget, in natural language; preview_forget only"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	get description(): string {
		return prompt.render(memoryEditDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
			supermemory: cfgMemoryBackend.get(this.session.settings) === "supermemory",
		});
	}
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate long-term memories; preview a forget by meaning";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend === "mnemopi") return new MemoryEditTool(session);
		if (backend === "supermemory" && isSupermemoryConfigured(loadSupermemoryConfig(session.settings))) {
			return new MemoryEditTool(session);
		}
		return null;
	}

	async execute(_id: string, params: MemoryEditParams, signal?: AbortSignal): Promise<AgentToolResult> {
		if (cfgMemoryBackend.get(this.session.settings) === "supermemory") return this.#editSupermemory(params, signal);
		if (params.op === "preview_forget") {
			throw new Error(
				"memory_edit preview_forget is only available with Supermemory. Use `recall` to find the memories, then `memory_edit` op `forget` with each id.",
			);
		}
		if (!params.id) throw new Error(`memory_edit ${params.op} requires id.`);
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}

	/**
	 * `forget`/`invalidate` → soft forget by id (hidden from search, kept server-side); an already
	 * forgotten memory counts as done. Supermemory has no memory update, hard delete, importance, or
	 * forget reason: `update` stores the corrected text as a document with instant processing first,
	 * then forgets the old memory; Supermemory forms the new memory from the document asynchronously.
	 * `preview_forget` only lists what a semantic forget would match; the model forgets reviewed ids.
	 */
	async #editSupermemory(params: MemoryEditParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const state = this.session.getSupermemorySessionState?.();
		if (!state) {
			throw new Error("Supermemory backend is not initialised for this session.");
		}
		const { namespace } = state;
		const location = `in namespace ${namespace}`;
		if (params.op === "preview_forget") {
			const query = params.query?.trim();
			if (!query) throw new Error("memory_edit preview_forget requires query.");
			const matches = await state.previewForget(query, signal);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No memories ${location} match; nothing changed.` }],
					details: { status: "previewed", namespace, matches },
					useless: true,
				};
			}
			const listed = formatMemories(
				matches.map(match => ({ text: sanitizeText(`${match.memory} (id: ${match.id})`) })),
			);
			return {
				content: [
					{
						type: "text",
						text: `Preview only, nothing was forgotten. ${matches.length} ${matches.length === 1 ? "memory" : "memories"} ${location} match:\n\n${listed}\n\nForget the ones you are sure about with \`memory_edit\` op \`forget\`, one call per id.`,
					},
				],
				details: { status: "previewed", namespace, matches },
			};
		}
		if (!params.id) throw new Error(`memory_edit ${params.op} requires id.`);
		if (params.op === "update" && !params.content) {
			throw new Error(
				params.importance === undefined
					? "memory_edit update requires content."
					: "memory_edit update requires content: Supermemory memories have no importance.",
			);
		}
		const { id } = params;
		if (params.op === "update") {
			const document = await state.save(
				params.content ?? "",
				{ source: "coding-agent-memory-edit", replaces: id },
				undefined,
				"instant",
			);
			const pending =
				"Supermemory forms the new memory from the document asynchronously (instant processing), so it may take a moment and may be worded differently.";
			let outcome: { already: boolean } | { failure: string };
			try {
				// No signal: the corrected document is stored, so finish the swap even if the call was
				// aborted; otherwise both the old and the new memory stay. Bounded by the client timeout.
				outcome = forgetOutcome(id, await state.forgetMemory(id), location);
			} catch (error) {
				outcome = { failure: error instanceof Error ? error.message : String(error) };
			}
			if ("failure" in outcome) {
				throw new Error(
					`Stored the corrected text as document ${document.id} ${location}, but memory ${id} could not be forgotten. ${outcome.failure} ${pending}`,
				);
			}
			const forgot = outcome.already ? `memory ${id} was already forgotten` : `forgot memory ${id}`;
			const ignored =
				params.importance === undefined ? "" : " Supermemory memories have no importance; it was ignored.";
			return {
				content: [
					{
						type: "text",
						text: `Stored the corrected text as document ${document.id} ${location} and ${forgot}. ${pending}${ignored}`,
					},
				],
				details: { status: "updated", namespace, documentId: document.id },
			};
		}
		const outcome = forgetOutcome(id, await state.forgetMemory(id, signal), location);
		if ("failure" in outcome) throw new Error(outcome.failure);
		const status = params.op === "forget" ? "forgotten" : "invalidated";
		const text = outcome.already
			? `Memory ${id} was already forgotten ${location}.`
			: `Memory ${id} ${status} ${location}.`;
		return {
			content: [{ type: "text", text }],
			details: { status, namespace },
		};
	}
}
