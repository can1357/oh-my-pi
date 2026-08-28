/**
 * Typed session lifecycle event bus for the Memory Guardian.
 *
 * This is the guardian's own vocabulary of session events, plus the cheap
 * lexical extractors that turn a raw prompt into something retrievable.
 *
 * Two deliberate design choices are worth calling out:
 *
 *   - **`emit` is fire-and-forget and synchronous.** The guardian listens on
 *     the agent's hot path, so emitting must never make the caller wait and
 *     must never let a listener's rejection escape into the turn. Each
 *     listener's promise is therefore caught and logged rather than awaited.
 *     A caller that needs to know when listeners finished should not be using
 *     a bus.
 *   - **Extraction is lexical, not semantic.** Every extractor here is a
 *     regular expression with a hard result cap. It runs before retrieval, on
 *     every prompt, so it is bounded by construction: 20 files, 20 symbols,
 *     10 errors, 10 task names, 10 commands, and error strings truncated to
 *     200 characters. Cheap and approximate on the hot path beats accurate and
 *     unbounded.
 *
 * Naming note: the event names here are hyphenated (`"session-start"`) and are
 * distinct from the underscored `MemoryLifecycleEvent` vocabulary used by
 * `session-integration/`. The two layers are intentionally not unified — this
 * bus models *agent session* events, that one models *memory participant*
 * events, and collapsing them would couple the guardian to the participant
 * protocol.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

export interface SessionStartEvent {
	type: "session-start";
	sessionId: string;
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	timestamp: string;
	objective?: string;
}

export interface UserPromptEvent {
	type: "user-prompt";
	sessionId: string;
	prompt: string;
	promptId: string;
	timestamp: string;
	entities: ExtractedEntities;
	intent: QueryIntent;
}

export interface BeforeModelEvent {
	type: "before-model";
	sessionId: string;
	messages: AgentMessage[];
	turnNumber: number;
	timestamp: string;
}

export interface PlanEvent {
	type: "plan-commit";
	sessionId: string;
	plan: string;
	planId: string;
	timestamp: string;
}

export interface ToolCallEvent {
	type: "tool-call";
	sessionId: string;
	toolName: string;
	args: unknown;
	toolCallId: string;
	timestamp: string;
}

export interface ToolResultEvent {
	type: "tool-result";
	sessionId: string;
	toolName: string;
	args: unknown;
	result: ToolResultMessage;
	toolCallId: string;
	timestamp: string;
	isError: boolean;
}

export interface CompactionEvent {
	type: "compaction";
	sessionId: string;
	trigger: "token-limit" | "manual" | "checkpoint";
	tokensBefore: number;
	summary: string;
	timestamp: string;
}

export interface ResumeEvent {
	type: "resume";
	sessionId: string;
	parentSessionId: string;
	checkpointId?: string;
	timestamp: string;
}

export interface IdleEvent {
	type: "idle";
	sessionId: string;
	idleDurationMs: number;
	timestamp: string;
}

export interface SessionStopEvent {
	type: "session-stop";
	sessionId: string;
	reason: "user-quit" | "error" | "completed" | "timeout";
	timestamp: string;
}

export type SessionEvent =
	| SessionStartEvent
	| UserPromptEvent
	| BeforeModelEvent
	| PlanEvent
	| ToolCallEvent
	| ToolResultEvent
	| CompactionEvent
	| ResumeEvent
	| IdleEvent
	| SessionStopEvent;

export interface ExtractedEntities {
	files: string[];
	symbols: string[];
	errors: string[];
	taskNames: string[];
	commands: string[];
}

export type QueryIntent =
	| "architecture"
	| "debugging"
	| "implementation"
	| "testing"
	| "configuration"
	| "history"
	| "preference"
	| "procedure"
	| "unknown";

export type SessionEventListener = (event: SessionEvent) => Promise<void>;

/** Result caps. Extraction runs on every prompt, so it is bounded by construction. */
const MAX_FILES = 20;
const MAX_SYMBOLS = 20;
const MAX_ERRORS = 10;
const MAX_TASK_NAMES = 10;
const MAX_COMMANDS = 10;
const MAX_ERROR_LENGTH = 200;

/**
 * Typed event bus for session lifecycle events.
 *
 * Listeners are keyed by event type, so emitting an event only touches the
 * handlers that asked for it.
 */
export class SessionEventBus {
	readonly #listeners = new Map<SessionEvent["type"], Set<SessionEventListener>>();

	/**
	 * Deliver an event to its listeners without waiting for them.
	 *
	 * Fire-and-forget on purpose: this runs on the agent's hot path, so a slow
	 * or failing listener must not be able to delay or break the turn that
	 * emitted the event. Rejections are logged, never rethrown.
	 */
	emit<T extends SessionEvent>(event: T): void {
		const listeners = this.#listeners.get(event.type);
		if (!listeners) return;
		for (const listener of listeners) {
			listener(event).catch(err => console.error(`Event listener error for ${event.type}:`, err));
		}
	}

	/** Subscribe to one event type. Returns an unsubscribe handle. */
	on<T extends SessionEvent["type"]>(
		type: T,
		listener: (event: Extract<SessionEvent, { type: T }>) => Promise<void>,
	): () => void {
		const listeners = this.#listeners.get(type) ?? new Set<SessionEventListener>();
		listeners.add(listener as SessionEventListener);
		this.#listeners.set(type, listeners);

		return () => {
			listeners.delete(listener as SessionEventListener);
			if (listeners.size === 0) this.#listeners.delete(type);
		};
	}

	/** Subscribe for exactly one delivery, then unsubscribe. */
	once<T extends SessionEvent["type"]>(
		type: T,
		listener: (event: Extract<SessionEvent, { type: T }>) => Promise<void>,
	): () => void {
		const cleanup = this.on(type, async event => {
			await listener(event);
			cleanup();
		});
		return cleanup;
	}

	removeAllListeners(type?: SessionEvent["type"]): void {
		if (type) {
			this.#listeners.delete(type);
		} else {
			this.#listeners.clear();
		}
	}

	listenerCount(type: SessionEvent["type"]): number {
		return this.#listeners.get(type)?.size ?? 0;
	}
}

/** Run every extractor over a prompt. Purely lexical; never throws. */
export function extractEntitiesFromPrompt(prompt: string): ExtractedEntities {
	return {
		files: extractFiles(prompt),
		symbols: extractSymbols(prompt),
		errors: extractErrors(prompt),
		taskNames: extractTaskNames(prompt),
		commands: extractCommands(prompt),
	};
}

/**
 * Guess what the user is trying to do, by keyword.
 *
 * Order matters: the checks run most-specific first, so a prompt containing
 * both "design" and "add" classifies as architecture rather than
 * implementation. Falls back to `"unknown"`, which callers should treat as
 * "retrieve broadly" rather than "retrieve nothing".
 */
export function classifyIntent(prompt: string): QueryIntent {
	const lower = prompt.toLowerCase();

	if (lower.includes("architect") || lower.includes("design") || lower.includes("structure")) return "architecture";
	if (lower.includes("debug") || lower.includes("error") || lower.includes("fail") || lower.includes("crash"))
		return "debugging";
	if (lower.includes("implement") || lower.includes("write") || lower.includes("create") || lower.includes("add"))
		return "implementation";
	if (lower.includes("test") || lower.includes("spec") || lower.includes("verify")) return "testing";
	if (lower.includes("config") || lower.includes("setup") || lower.includes("setting")) return "configuration";
	if (lower.includes("history") || lower.includes("previous") || lower.includes("before") || lower.includes("why"))
		return "history";
	if (lower.includes("prefer") || lower.includes("like") || lower.includes("style")) return "preference";
	if (lower.includes("procedure") || lower.includes("how to") || lower.includes("steps")) return "procedure";

	return "unknown";
}

// Patterns are hoisted to module scope so each is named and independently
// reviewable. All are used with `matchAll`/`match`, neither of which leaves
// `lastIndex` mutated on the original, so sharing them across calls is safe.
const FILE_BARE = /\b[A-Za-z0-9_/-]+\.[a-z]{1,5}\b/g;
const FILE_QUOTED = /["']([A-Za-z0-9_/-]+\.[a-z]{1,5})["']/g;
const VERSION_NUMBER = /^\d+(\.\d+)+$/;
const SYMBOL_PATTERN = /\b[A-Z]?[a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+|[A-Z]+[a-z]+\b/g;
const ERROR_PREFIX = /Error:.*$/gm;
const EXCEPTION_PREFIX = /Exception:.*$/gm;
const FAILED_TO = /Failed to.*$/gm;
const CANNOT_VERB = /Cannot (find|read|write|connect).*$/gm;
const PERMISSION_DENIED = /Permission denied.*$/gm;
const TASK_PHRASE = /task[:\s]+([^.]+)/gi;
const IMPLEMENT_PHRASE = /implement[:\s]+([^.]+)/gi;
const FIX_PHRASE = /fix[:\s]+([^.]+)/gi;
const REFACTOR_PHRASE = /refactor[:\s]+([^.]+)/gi;
const TOOL_COMMAND = /\b(bun|npm|yarn|pnpm|git|cargo|go|python|pip|docker|kubectl|make|bazel)\s+[a-z-]+/gi;
const OMP_COMMAND = /omp\s+\w+/gi;

const FILE_PATTERNS = [FILE_BARE, FILE_QUOTED];
const ERROR_PATTERNS = [ERROR_PREFIX, EXCEPTION_PREFIX, FAILED_TO, CANNOT_VERB, PERMISSION_DENIED];
const TASK_PATTERNS = [TASK_PHRASE, IMPLEMENT_PHRASE, FIX_PHRASE, REFACTOR_PHRASE];
const CMD_PATTERNS = [TOOL_COMMAND, OMP_COMMAND];

function extractFiles(text: string): string[] {
	const files = new Set<string>();
	for (const pattern of FILE_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const file = match[1] ?? match[0];
			// "1.2.3" looks exactly like a filename to the pattern above.
			if (file.includes(".") && !VERSION_NUMBER.test(file)) {
				files.add(file);
			}
		}
	}
	return Array.from(files).slice(0, MAX_FILES);
}

function extractSymbols(text: string): string[] {
	// camelCase, PascalCase and snake_case identifiers.
	const symbols = text.match(SYMBOL_PATTERN) ?? [];
	return Array.from(new Set(symbols)).slice(0, MAX_SYMBOLS);
}

function extractErrors(text: string): string[] {
	const errors = new Set<string>();
	for (const pattern of ERROR_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			errors.add(match[0].slice(0, MAX_ERROR_LENGTH));
		}
	}
	return Array.from(errors).slice(0, MAX_ERRORS);
}

function extractTaskNames(text: string): string[] {
	const tasks = new Set<string>();
	for (const pattern of TASK_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const name = match[1]?.trim();
			if (name) tasks.add(name);
		}
	}
	return Array.from(tasks).slice(0, MAX_TASK_NAMES);
}

function extractCommands(text: string): string[] {
	const commands = new Set<string>();
	for (const pattern of CMD_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			commands.add(match[0]);
		}
	}
	return Array.from(commands).slice(0, MAX_COMMANDS);
}
