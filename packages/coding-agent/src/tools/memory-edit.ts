import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { noticeErrorText } from "../memory-backend/outbox";
import { cfgMemoryBackend } from "../memory-backend/settings";
import type { SupermemoryForgetResult } from "../supermemory/client";
import { isSupermemoryConfigured, loadSupermemoryConfig } from "../supermemory/config";

/** Why memory `id` was not forgotten, from a forget result's per-id `errors`; `undefined` when it was. */
function forgetFailure(id: string, result: SupermemoryForgetResult, location: string): string | undefined {
	if (result.matches.includes(id)) return undefined;
	const error = result.errors.find(item => item.id === id)?.error ?? "";
	if (/not found/i.test(error)) return `Memory ${id} was not found ${location}.`;
	if (/already forgotten/i.test(error)) return `Memory ${id} is already forgotten ${location}.`;
	return `Memory ${id} was not forgotten ${location}: ${noticeErrorText(error) || "no reason given"}.`;
}

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
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
	readonly summary = "Update, forget, or invalidate long-term memories";

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
	 * `forget`/`invalidate` → soft forget by id (hidden from search, kept server-side). Supermemory has
	 * no memory update, hard delete, importance, or forget reason: `update` stores the corrected text
	 * as a document first, so a failure never loses the fact, then forgets the old memory.
	 */
	async #editSupermemory(params: MemoryEditParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const state = this.session.getSupermemorySessionState?.();
		if (!state) {
			throw new Error("Supermemory backend is not initialised for this session.");
		}
		if (params.op === "update" && !params.content) {
			throw new Error(
				params.importance === undefined
					? "memory_edit update requires content."
					: "memory_edit update requires content: Supermemory memories have no importance.",
			);
		}
		const { namespace } = state;
		const location = `in namespace ${namespace}`;
		if (params.op === "update") {
			const document = await state.save(params.content ?? "", {
				source: "coding-agent-memory-edit",
				replaces: params.id,
			});
			const pending = "The new memory appears after Supermemory processes the document.";
			let failure: string | undefined;
			try {
				failure = forgetFailure(params.id, await state.forgetMemory(params.id, signal), location);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			if (failure) {
				throw new Error(
					`Stored the corrected text as document ${document.id} ${location}, but memory ${params.id} remains: it could not be forgotten. ${failure} ${pending}`,
				);
			}
			const ignored =
				params.importance === undefined ? "" : " Supermemory memories have no importance; it was ignored.";
			return {
				content: [
					{
						type: "text",
						text: `Memory ${params.id} replaced ${location}: the corrected text was stored as document ${document.id} and the old memory forgotten. ${pending}${ignored}`,
					},
				],
				details: { status: "updated", namespace, documentId: document.id },
			};
		}
		const failure = forgetFailure(params.id, await state.forgetMemory(params.id, signal), location);
		if (failure) throw new Error(failure);
		const status = params.op === "forget" ? "forgotten" : "invalidated";
		return {
			content: [{ type: "text", text: `Memory ${params.id} ${status} ${location}.` }],
			details: { status, namespace },
		};
	}
}
