import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import {
	CONTEXT_NOTES_ENTRY_TYPE,
	getContextNotes,
	MAX_CONTEXT_NOTES_BYTES,
	type ContextNotesEntry,
} from "../session/context-notes";
import contextNotesDescription from "../prompts/tools/context-notes.md" with { type: "text" };
import newContextDescription from "../prompts/tools/new-context.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolError, throwIfAborted } from "./tool-errors";

const contextNotesSchema = type({
	"text?": type("string").describe("Entire replacement notebook text. Omit to read; use an empty string to clear."),
});

const newContextSchema = type({});

export type ContextNotesParams = typeof contextNotesSchema.infer;
export type NewContextParams = typeof newContextSchema.infer;

export interface ContextNotesToolDetails {
	entryId?: string;
	text: string;
	bytes?: number;
}

export interface NewContextToolDetails {
	requested: true;
}

type ExperimentalContextSessionManager = NonNullable<ToolSession["sessionManager"]>;

function resolveExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager | undefined {
	if (session.settings.get("compaction.experimentalContextManagement") !== true || session.isDisposed?.()) {
		return undefined;
	}
	const manager = session.sessionManager;
	const ownerId = session.getSessionId?.();
	if (!manager || !ownerId || manager.getSessionId() !== ownerId) return undefined;
	return manager;
}

/**
 * Resolves the live session journal only when experimental context management is enabled and
 * owned by this ToolSession. The identity comparison prevents advisor tools from writing the
 * parent agent's notebook or resolving its raw history.
 */
export function getExperimentalContextSession(session: ToolSession): ExperimentalContextSessionManager {
	const manager = resolveExperimentalContextSession(session);
	if (manager) return manager;
	if (session.settings.get("compaction.experimentalContextManagement") !== true) {
		throw new ToolError("Experimental context management is disabled.");
	}
	if (session.isDisposed?.()) {
		throw new ToolError("Experimental context management is unavailable because this session is disposed.");
	}
	throw new ToolError("Experimental context management is unavailable for this session.");
}

function createIfSupported<T extends ContextNotesTool | NewContextTool>(
	session: ToolSession,
	ToolClass: new (session: ToolSession) => T,
): T | null {
	return resolveExperimentalContextSession(session) ? new ToolClass(session) : null;
}

/** Reads or replaces the current branch's durable experimental notebook. */
export class ContextNotesTool implements AgentTool<typeof contextNotesSchema, ContextNotesToolDetails> {
	readonly name = "context_notes";
	readonly approval = (args: unknown): ToolApprovalDecision =>
		args !== null && typeof args === "object" && Object.hasOwn(args, "text") ? "write" : "read";
	readonly label = "Context Notes";
	readonly description = contextNotesDescription;
	readonly parameters = contextNotesSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Read or replace persistent experimental context notes";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ContextNotesTool | null {
		return createIfSupported(session, ContextNotesTool);
	}

	async execute(
		_id: string,
		params: ContextNotesParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ContextNotesToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ContextNotesToolDetails>> {
		const manager = getExperimentalContextSession(this.session);
		throwIfAborted(signal);
		if (params.text !== undefined && typeof params.text !== "string") {
			throw new ToolError("context_notes text must be a string.");
		}
		if (params.text === undefined) {
			const notes = getContextNotes(manager.getBranch());
			return {
				content: [{ type: "text", text: notes?.text ?? "No context notes are stored for this session branch." }],
				details: notes ? { entryId: notes.entryId, text: notes.text } : { entryId: undefined, text: "" },
			};
		}

		const bytes = Buffer.byteLength(params.text, "utf8");
		if (bytes > MAX_CONTEXT_NOTES_BYTES) {
			throw new ToolError(
				`Context notes are ${bytes} bytes; the limit is ${MAX_CONTEXT_NOTES_BYTES} UTF-8 bytes. Shorten the notebook and use history://current/full to recover raw detail.`,
			);
		}

		const ownerId = this.session.getSessionId?.();
		const branchLeafId = manager.getBranch().at(-1)?.id;
		await manager.ensureOnDisk();
		throwIfAborted(signal);
		const currentManager = getExperimentalContextSession(this.session);
		if (
			currentManager !== manager ||
			this.session.isDisposed?.() ||
			!ownerId ||
			this.session.getSessionId?.() !== ownerId ||
			manager.getSessionId() !== ownerId ||
			manager.getBranch().at(-1)?.id !== branchLeafId
		) {
			throw new ToolError("Experimental context notes were not saved because the session branch changed.");
		}

		const data: ContextNotesEntry = { version: 1, text: params.text };
		const entryId = manager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, data);
		await manager.flush();
		return {
			content: [{ type: "text", text: "Context notes saved." }],
			details: { entryId, text: params.text, bytes },
		};
	}
}

/** Requests a fresh context window; the owning lifecycle consumes this turn-local signal. */
export class NewContextTool implements AgentTool<typeof newContextSchema, NewContextToolDetails> {
	readonly name = "new_context";
	readonly approval = "write" as const;
	readonly label = "New Context";
	readonly description = newContextDescription;
	readonly parameters = newContextSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Request a fresh context window";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): NewContextTool | null {
		return createIfSupported(session, NewContextTool);
	}

	async execute(
		_id: string,
		_params: NewContextParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<NewContextToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<NewContextToolDetails>> {
		getExperimentalContextSession(this.session);
		throwIfAborted(signal);
		return {
			content: [{ type: "text", text: "New context window requested." }],
			details: { requested: true },
		};
	}
}
