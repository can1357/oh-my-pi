import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";
import { SupermemoryHttpError } from "../supermemory/client";
import { isSupermemoryConfigured, loadSupermemoryConfig } from "../supermemory/config";

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
	 * `update` → PATCH (new version, content redacted); `forget`/`invalidate` → DELETE, a soft forget
	 * that hides the memory from search and keeps it server-side. Supermemory has no hard delete or importance.
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
		const location = `in container ${state.containerTag}`;
		try {
			if (params.op === "update") {
				const newId = await state.updateMemory(params.id, params.content ?? "", signal);
				const version = newId ? `; new version id ${newId}` : "";
				const ignored =
					params.importance === undefined ? "" : " Supermemory memories have no importance; it was ignored.";
				return {
					content: [{ type: "text", text: `Memory ${params.id} updated ${location}${version}.${ignored}` }],
					details: { status: "updated", container: state.containerTag, newId },
				};
			}
			const reason =
				params.op === "forget"
					? undefined
					: params.replacement_id
						? `superseded by ${params.replacement_id}`
						: "invalidated";
			await state.forgetMemory(params.id, reason, signal);
			const status = params.op === "forget" ? "forgotten" : "invalidated";
			return {
				content: [{ type: "text", text: `Memory ${params.id} ${status} ${location}.` }],
				details: { status, container: state.containerTag },
			};
		} catch (error) {
			if (error instanceof SupermemoryHttpError && error.status === 404) {
				throw new Error(`Memory ${params.id} was not found ${location}.`);
			}
			if (error instanceof SupermemoryHttpError && error.status === 409) {
				throw new Error(`Memory ${params.id} is already forgotten ${location}.`);
			}
			throw error;
		}
	}
}
