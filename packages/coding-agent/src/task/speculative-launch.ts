/**
 * Speculative subagent launch for streamed batch `task` calls.
 *
 * While a `{ context, tasks[] }` call streams, {@link TaskLaunchSession} starts
 * each item's subagent as soon as that item's JSON object closes, instead of
 * waiting for the whole call. When the call finishes streaming:
 *
 * - invalid call (parse/validation error) → every launched run is aborted;
 * - launched items differ from the finished call → every launched run is aborted;
 * - otherwise the not-yet-launched remainder starts too.
 *
 * Dispatch then adopts the runs whose spawn params still match
 * ({@link TaskLaunchSession.adopt}); anything unadopted is aborted when the
 * agent loop discards the session (blocked call, changed arguments, aborted
 * turn). Launches require host authorization (`authorizeLaunch`), which denies
 * whenever approval is not auto-allow or extension lifecycle handlers could
 * veto the call.
 */
import {
	canonicalJson,
	type AgentToolCall,
	type SpeculativeOperationSink,
	type SpeculativeToolReference,
	type ToolSpeculationAssessmentContext,
	type ToolSpeculationStreamSession,
} from "@oh-my-pi/pi-agent-core";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { SpawnRun } from "./spawn-run";

/**
 * Incremental scanner over streamed batch-task argument JSON. Extracts the
 * top-level `context` string once it closes and every `tasks[]` element whose
 * object has closed; never parses the unfinished tail.
 */
export class BatchArgsScanner {
	#raw = "";
	#pos = 0;
	#depth = 0;
	#inString = false;
	#escaped = false;
	#stringStart = -1;
	/** At depth 1, the next string is a key (after `{` or `,`) rather than a value (after `:`). */
	#expectKey = false;
	#key: string | undefined;
	#inTasks = false;
	#itemStart = -1;
	#context: string | undefined;
	#items: Record<string, unknown>[] = [];
	#malformed = false;

	/** Shared `context`, once its string has closed. */
	get context(): string | undefined {
		return this.#context;
	}

	/** Closed `tasks[]` elements, in order. */
	get items(): readonly Record<string, unknown>[] {
		return this.#items;
	}

	/** Input left the batch shape (non-object items, non-array `tasks`, unparsable item). */
	get malformed(): boolean {
		return this.#malformed;
	}

	/** Scan the streamed buffer; a buffer that does not extend the previous one restarts the scan. */
	feed(raw: string): void {
		if (!raw.startsWith(this.#raw)) this.#reset();
		this.#raw = raw;
		for (let i = this.#pos; i < raw.length && !this.#malformed; i++) {
			const char = raw[i];
			if (this.#inString) {
				if (this.#escaped) this.#escaped = false;
				else if (char === "\\") this.#escaped = true;
				else if (char === '"') {
					this.#inString = false;
					this.#closeString(raw.slice(this.#stringStart, i + 1));
				}
				continue;
			}
			const atItemLevel = this.#inTasks && this.#depth === 2;
			switch (char) {
				case '"':
					if (atItemLevel) this.#malformed = true;
					this.#inString = true;
					this.#stringStart = i;
					break;
				case "{":
				case "[":
					if (this.#depth === 0 && char !== "{") this.#malformed = true;
					if (this.#depth === 1 && !this.#expectKey && this.#key === "tasks") {
						if (char === "[") this.#inTasks = true;
						else this.#malformed = true;
					}
					if (atItemLevel) {
						if (char === "{") this.#itemStart = i;
						else this.#malformed = true;
					}
					this.#depth++;
					if (this.#depth === 1) this.#expectKey = true;
					break;
				case "}":
				case "]":
					this.#depth--;
					if (this.#inTasks && this.#depth === 2 && char === "}")
						this.#closeItem(raw.slice(this.#itemStart, i + 1));
					else if (this.#inTasks && this.#depth === 1) this.#inTasks = false;
					break;
				case ":":
					if (this.#depth === 1) this.#expectKey = false;
					break;
				case ",":
					if (this.#depth === 1) this.#expectKey = true;
					break;
				case " ":
				case "\n":
				case "\r":
				case "\t":
					break;
				default:
					// Scalars are only legal as values nested inside an item or beside `tasks`.
					if (atItemLevel) this.#malformed = true;
			}
		}
		this.#pos = raw.length;
	}

	#closeString(literal: string): void {
		if (this.#depth !== 1) return;
		let value: unknown;
		try {
			value = JSON.parse(literal);
		} catch {
			this.#malformed = true;
			return;
		}
		if (this.#expectKey) this.#key = typeof value === "string" ? value : undefined;
		else if (this.#key === "context" && typeof value === "string") this.#context = value;
	}

	#closeItem(literal: string): void {
		try {
			this.#items.push(JSON.parse(literal) as Record<string, unknown>);
		} catch {
			this.#malformed = true;
		}
	}

	#reset(): void {
		this.#pos = 0;
		this.#depth = 0;
		this.#inString = false;
		this.#escaped = false;
		this.#stringStart = -1;
		this.#expectKey = false;
		this.#key = undefined;
		this.#inTasks = false;
		this.#itemStart = -1;
		this.#context = undefined;
		this.#items = [];
		this.#malformed = false;
	}
}

/** Task-tool operations a {@link TaskLaunchSession} drives. */
export interface TaskLauncher {
	/** Per-spawn params of a batch call (or streamed prefix), or undefined when it fails validation. */
	spawns(args: unknown): TaskParams[] | undefined;
	/** Preflight and start one spawn; undefined when it may not start early. */
	start(toolCallId: string, spawn: TaskParams, index: number, signal: AbortSignal): Promise<SpawnRun | undefined>;
}

export interface TaskLaunchSessionOptions {
	sink: SpeculativeOperationSink;
	tool: SpeculativeToolReference;
	launcher: TaskLauncher;
	/** Called once when the session stops owning launches (adopted or discarded). */
	onClose: () => void;
}

/** One streamed `task` call's speculative launches; see the module docs. */
export class TaskLaunchSession implements ToolSpeculationStreamSession {
	/** The task tool routes adoption through its own session map, not the tool context. */
	readonly contextIndependent = true;
	readonly #options: TaskLaunchSessionOptions;
	readonly #scanner = new BatchArgsScanner();
	/** Canonical spawn params per planned index, set synchronously so reconciliation covers in-flight launches. */
	readonly #planned = new Map<number, string>();
	readonly #runs = new Map<number, SpawnRun>();
	readonly #controller = new AbortController();
	#queue: Promise<void> = Promise.resolve();
	/** Launching stopped for good: authorization, preflight, or start refused an item. */
	#halted = false;
	#closed = false;

	constructor(options: TaskLaunchSessionOptions) {
		this.#options = options;
	}

	update(toolCall: AgentToolCall, partialJson?: string): void {
		if (this.#closed || this.#halted || partialJson === undefined) return;
		const scanner = this.#scanner;
		scanner.feed(partialJson);
		// Items are launchable only once `context` closed before them: every
		// spawn carries it, and a later `context` would change launched params.
		const context = scanner.context;
		if (scanner.malformed || context === undefined) return;
		const items = scanner.items;
		for (let index = this.#planned.size; index < items.length; index++) {
			const batch = { context, tasks: items.slice(0, index + 1) };
			const spawn = this.#options.launcher.spawns(batch)?.[index];
			if (!spawn) {
				this.#halted = true;
				return;
			}
			this.#schedule(toolCall, batch, spawn, index);
		}
	}

	/** The call finished streaming: abort on error or delta, else launch the remainder. */
	finalize(context: ToolSpeculationAssessmentContext): void {
		if (this.#closed) return;
		const spawns = this.#options.launcher.spawns(context.args);
		if (!spawns) {
			this.discard("finished task call is invalid");
			return;
		}
		if (!this.#matches(spawns)) {
			this.discard("finished task call differs from launched items");
			return;
		}
		if (this.#halted) return;
		for (let index = this.#planned.size; index < spawns.length; index++) {
			this.#schedule(context.toolCall, context.args, spawns[index], index);
		}
	}

	matchesFinalArgs(args: Readonly<Record<string, unknown>>): boolean {
		const spawns = this.#options.launcher.spawns(args);
		return spawns !== undefined && this.#matches(spawns);
	}

	/**
	 * Hand every launched run whose spawn params equal `spawns[index]` to the
	 * dispatching call and abort the rest. Closes the session.
	 */
	async adopt(spawns: readonly TaskParams[]): Promise<Map<number, SpawnRun>> {
		await this.#queue;
		const adopted = new Map<number, SpawnRun>();
		if (this.#closed) return adopted;
		this.#close();
		for (const [index, run] of this.#runs) {
			const spawn = spawns[index];
			if (spawn && canonicalJson(spawn) === this.#planned.get(index)) adopted.set(index, run);
			else run.discard("task call changed after speculative launch");
		}
		this.#runs.clear();
		return adopted;
	}

	/** Dispatch finished without adopting: nothing launched may keep running. */
	commit(): void {
		this.discard("task call committed without adopting speculative launches");
	}

	discard(reason: string): void {
		if (this.#closed) return;
		this.#close();
		for (const run of this.#runs.values()) run.discard(reason);
		this.#runs.clear();
	}

	#close(): void {
		this.#closed = true;
		this.#controller.abort();
		this.#options.onClose();
	}

	#matches(spawns: readonly TaskParams[]): boolean {
		for (const [index, planned] of this.#planned) {
			const spawn = spawns[index];
			if (!spawn || canonicalJson(spawn) !== planned) return false;
		}
		return true;
	}

	/** Plan `index` now; authorize and start it behind earlier launches so ids and permits stay in item order. */
	#schedule(toolCall: AgentToolCall, args: Readonly<Record<string, unknown>>, spawn: TaskParams, index: number): void {
		this.#planned.set(index, canonicalJson(spawn));
		this.#queue = this.#queue.then(() => this.#launch(toolCall, args, spawn, index));
	}

	async #launch(
		toolCall: AgentToolCall,
		args: Readonly<Record<string, unknown>>,
		spawn: TaskParams,
		index: number,
	): Promise<void> {
		if (this.#closed || this.#halted) return;
		const { sink, tool, launcher } = this.#options;
		const authorization = (await sink.authorizeLaunch?.({ tool, toolCall, args })) ?? { allowed: false };
		if (this.#closed) return;
		if (!authorization.allowed) {
			this.#halted = true;
			return;
		}
		let run: SpawnRun | undefined;
		try {
			run = await launcher.start(toolCall.id, spawn, index, this.#controller.signal);
		} catch {
			run = undefined;
		}
		if (!run) {
			this.#halted = true;
			return;
		}
		if (this.#closed) {
			run.discard("speculative task launch closed while starting");
			return;
		}
		this.#runs.set(index, run);
	}
}
