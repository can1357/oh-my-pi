import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, CursorTodoSnapshot, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	McpArgsSchema,
	McpToolCallSchema,
	ReadTodosArgsSchema,
	ReadTodosResultSchema,
	ReadTodosSuccessSchema,
	ReadTodosToolCallSchema,
	type TodoItem,
	TodoItemSchema,
	type ToolCall,
	ToolCallCompletedUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	UpdateTodosArgsSchema,
	UpdateTodosErrorSchema,
	UpdateTodosResultSchema,
	UpdateTodosSuccessSchema,
	UpdateTodosToolCallSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/** One `todoSync` invocation, recorded verbatim. */
interface SyncCall {
	snapshot: CursorTodoSnapshot | null;
	toolCallId: string;
	error: string | null;
}

interface Harness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	state: BlockState;
	usageState: UsageState;
	/** Every settle, including refusals and server errors. */
	syncCalls: SyncCall[];
	/** Mirrored snapshots only — the subset that carries a list. */
	snapshots: CursorTodoSnapshot[];
	/** Call ids handed to `todoSync`, in order. */
	syncCallIds: string[];
	/** Results persisted for server-resolved blocks. */
	toolResults: ToolResultMessage[];
}

function newHarness(): Harness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const stream = new AssistantMessageEventStream();
	const syncCalls: SyncCall[] = [];
	const snapshots: CursorTodoSnapshot[] = [];
	const syncCallIds: string[] = [];
	const toolResults: ToolResultMessage[] = [];
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		onTodoSnapshot: (snapshot, toolCallId, error) => {
			syncCalls.push({ snapshot, toolCallId, error });
			if (snapshot) snapshots.push(snapshot);
			syncCallIds.push(toolCallId);
			// Stands in for the host's phase-grouped result: the provider must
			// persist it verbatim rather than synthesizing its own.
			return {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: error ?? "host result" }],
				isError: error !== null,
				timestamp: 0,
			};
		},
		onToolResult: result => {
			toolResults.push(result);
			return result;
		},
	};
	return {
		output,
		stream,
		state,
		usageState: { sawTokenDelta: false },
		syncCalls,
		snapshots,
		syncCallIds,
		toolResults,
	};
}

function start(h: Harness, toolCall: unknown, callId = "call-1"): void {
	processInteractionUpdate(
		{ message: { case: "toolCallStarted", value: { callId, toolCall } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function complete(h: Harness, toolCall: unknown): void {
	processInteractionUpdate(
		{ message: { case: "toolCallCompleted", value: { toolCall } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function todoBlocks(h: Harness): ToolCallState[] {
	return h.output.content.filter((c): c is ToolCallState => c.type === "toolCall" && c.name === "todo");
}

describe("cursor native todo bridge", () => {
	it("never marks a native todo block runnable by the shared tool loop", () => {
		// `ExecServerMessage` has no todo case: Cursor settles these server-side.
		// An unresolved block would make `agent-loop` execute a tool that has no
		// local counterpart and drive a spurious continuation turn.
		const h = newHarness();
		start(h, { updateTodosToolCall: { args: { todos: [{ content: "a", status: 1 }] } } });
		start(h, { readTodosToolCall: { args: {} } }, "call-2");

		const blocks = todoBlocks(h);
		expect(blocks).toHaveLength(2);
		for (const block of blocks) {
			expect(block[kCursorExecResolved]).toBe(true);
		}
	});

	it("takes the server success snapshot as truth over the requested args", () => {
		const h = newHarness();
		const args = { merge: true, todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		complete(h, {
			updateTodosToolCall: {
				args,
				result: {
					result: {
						case: "success",
						value: {
							wasMerge: true,
							todos: [
								{ content: "pre-existing", status: 3 },
								{ content: "requested", status: 2 },
							],
						},
					},
				},
			},
		});

		expect(h.snapshots).toEqual([
			{
				todos: [
					{ content: "pre-existing", status: "completed" },
					{ content: "requested", status: "in_progress" },
				],
				merged: true,
			},
		]);
		expect(todoBlocks(h)[0].arguments).toEqual({
			todos: [
				{ content: "pre-existing", status: "completed" },
				{ content: "requested", status: "in_progress" },
			],
			merged: true,
		});
	});

	it("maps TODO_STATUS_CANCELLED to abandoned instead of resurrecting the task", () => {
		const h = newHarness();
		start(h, { updateTodosToolCall: { args: { todos: [] } } });
		complete(h, {
			updateTodosToolCall: {
				args: { todos: [] },
				result: { result: { case: "success", value: { todos: [{ content: "dropped", status: 4 }] } } },
			},
		});

		expect(h.snapshots[0].todos).toEqual([{ content: "dropped", status: "abandoned" }]);
	});

	it("leaves local state untouched when the server reports an error", () => {
		const h = newHarness();
		const args = { todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		const before = todoBlocks(h)[0].arguments;
		complete(h, {
			updateTodosToolCall: { args, result: { result: { case: "error", value: { error: "quota exceeded" } } } },
		});

		expect(h.snapshots).toEqual([]);
		expect(todoBlocks(h)[0].arguments).toEqual(before);
	});

	it("leaves local state untouched when the completion carries no result", () => {
		const h = newHarness();
		const args = { todos: [{ content: "requested", status: 1 }] };
		start(h, { updateTodosToolCall: { args } });
		complete(h, { updateTodosToolCall: { args } });

		expect(h.snapshots).toEqual([]);
	});

	it("refreshes local state from a read_todos snapshot", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: { case: "success", value: { todos: [{ content: "remote", status: 2 }], totalCount: 1 } },
				},
			},
		});

		expect(h.snapshots).toEqual([{ todos: [{ content: "remote", status: "in_progress" }], merged: false }]);
	});

	it("refuses a status-filtered read_todos result, which is a subset and not the list", () => {
		// `ReadTodosArgs.status_filter` narrows the response; mirroring it would
		// delete every task the filter excluded.
		const h = newHarness();
		const args = { statusFilter: [2] };
		start(h, { readTodosToolCall: { args } });
		complete(h, {
			readTodosToolCall: {
				args,
				result: { result: { case: "success", value: { todos: [{ content: "only in progress", status: 2 }] } } },
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("refuses an id-filtered read_todos result", () => {
		const h = newHarness();
		const args = { idFilter: ["task-1"] };
		start(h, { readTodosToolCall: { args } });
		complete(h, {
			readTodosToolCall: {
				args,
				result: { result: { case: "success", value: { todos: [{ content: "one task", status: 1 }] } } },
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("refuses a read_todos result truncated below the server's own total_count", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: {
						case: "success",
						value: { todos: [{ content: "first of three", status: 2 }], totalCount: 3 },
					},
				},
			},
		});

		expect(h.snapshots).toEqual([]);
	});

	it("refuses an empty read_todos whose total_count is zero or unset", () => {
		// proto3 defaults an unset `total_count` to 0, so todos=[] + totalCount=0
		// is indistinguishable from a genuinely empty list. Mirroring it would
		// wipe every local task; update_todos remains the clear path.
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: {
						case: "success",
						value: { todos: [], totalCount: 0 },
					},
				},
			},
		});
		expect(h.snapshots).toEqual([]);

		// Positive control: the same empty snapshot via update_todos DOES sync —
		// clearing the list is an authoritative write, not an ambiguous read.
		const cleared = newHarness();
		start(cleared, { updateTodosToolCall: { args: { todos: [] } } });
		complete(cleared, {
			updateTodosToolCall: {
				args: { todos: [] },
				result: {
					result: {
						case: "success",
						value: { todos: [], totalCount: 0 },
					},
				},
			},
		});
		expect(cleared.snapshots).toEqual([{ todos: [], merged: false }]);
	});

	it("accepts a read_todos result whose row count matches total_count", () => {
		const h = newHarness();
		start(h, { readTodosToolCall: { args: {} } });
		complete(h, {
			readTodosToolCall: {
				args: {},
				result: {
					result: {
						case: "success",
						value: {
							todos: [
								{ content: "one", status: 3 },
								{ content: "two", status: 2 },
							],
							totalCount: 2,
						},
					},
				},
			},
		});

		expect(h.snapshots[0].todos).toEqual([
			{ content: "one", status: "completed" },
			{ content: "two", status: "in_progress" },
		]);
	});
});

/**
 * The fixtures above hand-shape `toolCall` with a flattened
 * `updateTodosToolCall` property. A decoded `agent.v1.ToolCall` does NOT look
 * like that: `tool` is a protobuf oneof, so the variant only ever arrives as
 * `tool: { case, value }`. These tests drive the bridge with messages that
 * round-trip through the actual wire encoding, which is the only shape
 * production ever sees.
 */
describe("cursor native todo bridge (wire-encoded protobuf)", () => {
	function wireUpdate(kind: "toolCallStarted" | "toolCallCompleted", toolCall?: ToolCall): unknown {
		// `toolCall` is optional on the wire: omitting it exercises a completion
		// frame that carries no result at all.
		const value =
			kind === "toolCallStarted"
				? create(ToolCallStartedUpdateSchema, { callId: "call-1", toolCall })
				: create(ToolCallCompletedUpdateSchema, { callId: "call-1", toolCall });
		const server = create(AgentServerMessageSchema, {
			message: {
				case: "interactionUpdate",
				value: create(InteractionUpdateSchema, { message: { case: kind, value } } as never),
			},
		});
		// handleServerMessage forwards `message.value` to processInteractionUpdate.
		return fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, server)).message.value;
	}

	function items(rows: [string, string, number][]) {
		return rows.map(([id, content, status]) => create(TodoItemSchema, { id, content, status }));
	}

	/** Rows carrying `TodoItem.dependencies` — the ids each row waits on. */
	function depItems(rows: [string, string, number, string[]][]) {
		return rows.map(([id, content, status, dependencies]) =>
			create(TodoItemSchema, { id, content, status, dependencies }),
		);
	}

	function successResult(todos: TodoItem[], totalCount: number, wasMerge = false) {
		return create(UpdateTodosResultSchema, {
			result: {
				case: "success",
				value: create(UpdateTodosSuccessSchema, { todos, totalCount, wasMerge }),
			},
		});
	}

	// `read_todos` settles on its own result message: no `was_merge`, and a
	// `total_count` that reports the full size even when rows are withheld.
	function readSuccessResult(todos: TodoItem[], totalCount: number) {
		return create(ReadTodosResultSchema, {
			result: { case: "success", value: create(ReadTodosSuccessSchema, { todos, totalCount }) },
		});
	}

	function updateCall(todos: TodoItem[], totalCount: number, wasMerge = false): ToolCall {
		return create(ToolCallSchema, {
			tool: {
				case: "updateTodosToolCall",
				value: create(UpdateTodosToolCallSchema, {
					args: create(UpdateTodosArgsSchema, { todos: [], merge: wasMerge }),
					result: successResult(todos, totalCount, wasMerge),
				}),
			},
		});
	}

	function readCall(
		todos: TodoItem[],
		totalCount: number,
		args: { statusFilter?: number[]; idFilter?: string[] } = {},
	): ToolCall {
		return create(ToolCallSchema, {
			tool: {
				case: "readTodosToolCall",
				value: create(ReadTodosToolCallSchema, {
					args: create(ReadTodosArgsSchema, args),
					result: readSuccessResult(todos, totalCount),
				}),
			},
		});
	}

	/** A completed `update_todos` the server rejected outright. */
	function errorCall(error: string): ToolCall {
		return create(ToolCallSchema, {
			tool: {
				case: "updateTodosToolCall",
				value: create(UpdateTodosToolCallSchema, {
					args: create(UpdateTodosArgsSchema, { todos: [], merge: false }),
					result: create(UpdateTodosResultSchema, {
						result: { case: "error", value: create(UpdateTodosErrorSchema, { error }) },
					}),
				}),
			},
		});
	}

	function drive(toolCall: ToolCall): Harness {
		const h = newHarness();
		processInteractionUpdate(
			wireUpdate("toolCallStarted", toolCall) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		processInteractionUpdate(
			wireUpdate("toolCallCompleted", toolCall) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		return h;
	}

	it("synthesizes a todo block from a wire-decoded update_todos oneof", () => {
		const h = drive(updateCall(items([["1", "done task", 3]]), 1));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(todoBlocks(h)[0][kCursorExecResolved]).toBe(true);
	});

	it("mirrors the server snapshot from a wire-decoded update_todos oneof", () => {
		const h = drive(
			updateCall(
				items([
					["1", "done task", 3],
					["2", "active task", 2],
				]),
				2,
				true,
			),
		);

		expect(h.snapshots).toEqual([
			{
				todos: [
					{ content: "done task", status: "completed" },
					{ content: "active task", status: "in_progress" },
				],
				merged: true,
			},
		]);
	});

	it("mirrors a complete wire-decoded read_todos oneof", () => {
		const h = drive(readCall(items([["1", "only task", 2]]), 1));

		expect(h.snapshots).toEqual([{ todos: [{ content: "only task", status: "in_progress" }], merged: false }]);
	});

	it("refuses a wire-decoded read_todos truncated below total_count", () => {
		const h = drive(readCall(items([["1", "only task", 2]]), 5));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("refuses an update_todos snapshot truncated below total_count", () => {
		// A partial or size-limited merge response is as incomplete as a filtered
		// read: mirroring it would delete every task the server omitted. The
		// refusal is not read-only.
		//
		// Positive control: the same row with an honest count does sync.
		expect(drive(updateCall(items([["1", "only task", 2]]), 1)).snapshots).toHaveLength(1);

		const h = drive(updateCall(items([["1", "only task", 2]]), 5));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("still mirrors an empty update_todos, the authoritative clear path", () => {
		// Unlike an empty read (ambiguous: proto3 defaults `total_count` to 0),
		// an empty update is an explicit "the list is now nothing" and must still
		// clear local state — the count guard above must not swallow it.
		const h = drive(updateCall([], 0));

		expect(h.snapshots).toEqual([{ todos: [], merged: false }]);
	});

	it("refuses an empty update_todos whose total_count is nonzero", () => {
		// The most destructive shape: an empty partial/size-limited merge response
		// that still reports rows. Accepting it as an authoritative clear would
		// delete every local task at once. Only a matching zero count is a clear.
		const h = drive(updateCall([], 3));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: todoBlocks(h)[0].id, error: null }]);
	});

	it("settles a completion frame that carries no toolCall at all", () => {
		// `ToolCallCompletedUpdate.tool_call` is optional. The started frame has
		// already marked the block `kCursorExecResolved`, so `agent-loop.ts` emits
		// no placeholder result for it — staying silent here would leave the call
		// unpaired and `buildSessionContext` would strip the whole interaction
		// from every rebuilt transcript.
		const h = newHarness();
		const toolCall = updateCall(items([["1", "step one", 2]]), 1);
		processInteractionUpdate(
			wireUpdate("toolCallStarted", toolCall) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		processInteractionUpdate(wireUpdate("toolCallCompleted") as never, h.output, h.stream, h.state, h.usageState);

		const callId = todoBlocks(h)[0].id;
		expect(todoBlocks(h)).toHaveLength(1);
		// Nothing to mirror: no snapshot and no server error.
		expect(h.snapshots).toEqual([]);
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: callId, error: null }]);
		// But it IS paired, so the block survives a rebuild.
		expect(h.toolResults.map(r => r.toolCallId)).toEqual([callId]);
		expect(h.toolResults[0]).toMatchObject({ role: "toolResult", toolName: "todo", isError: false });
	});

	it("refuses a snapshot carrying a row with empty content", () => {
		// `content` is a proto3 string: missing or default arrives as `""`. The
		// local list is keyed by content and `resolveTaskOrError` rejects a falsy
		// one before lookup, so the row would be unreachable to every
		// task-targeted `done`/`drop`/`rm`.
		//
		// Positive control: the same pair with real content syncs.
		expect(
			drive(
				updateCall(
					items([
						["1", "real task", 1],
						["2", "other task", 1],
					]),
					2,
				),
			).snapshots,
		).toHaveLength(1);

		const h = drive(
			updateCall(
				items([
					["1", "real task", 1],
					["2", "", 1],
				]),
				2,
			),
		);

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
		// Still settles as a benign no-op, like every other refusal.
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: todoBlocks(h)[0].id, error: null }]);
	});

	it("refuses a wire-decoded empty read_todos with total_count 0", () => {
		const h = drive(readCall([], 0));
		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
		// Still settles as a benign non-mirror, not a wipe and not a failure.
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: todoBlocks(h)[0].id, error: null }]);
	});

	it("refuses a snapshot whose rows collide on content", () => {
		// The wire model identifies rows by `id` and can represent two rows with
		// the same `content`, so the bridge must survive one. The local list is
		// keyed by content alone, so importing the pair would make every later
		// task-targeted `done`/`drop` resolve to the first row and strand the
		// second.
		//
		// Positive control: the same two rows with distinct content do sync, so
		// the refusal below is attributable to the collision.
		const distinct = drive(
			updateCall(
				items([
					["1", "task a", 1],
					["2", "task b", 1],
				]),
				2,
			),
		);
		expect(distinct.snapshots).toHaveLength(1);

		const h = drive(
			updateCall(
				items([
					["1", "same task", 1],
					["2", "same task", 3],
				]),
				2,
			),
		);
		const callId = todoBlocks(h)[0].id;

		expect(todoBlocks(h)).toHaveLength(1);
		// Nothing mutable reaches the host: no snapshot at all, so it cannot
		// mirror a list the local model is unable to key.
		expect(h.snapshots).toEqual([]);
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: callId, error: null }]);
		// Still settles: the call happened, only the mirror was declined. Without
		// a completion the card animates forever, and without a paired result the
		// block is stripped on rebuild. It reads as a benign no-op, not a failure.
		expect(h.toolResults.map(r => r.toolCallId)).toEqual([callId]);
		expect(h.toolResults[0]).toMatchObject({ role: "toolResult", toolName: "todo", isError: false });
	});

	it("settles a collided snapshot as a no-op when no host handler is registered", () => {
		// Without a host the provider builds the result itself: a declined mirror
		// must read as "not mirrored", never as an empty list, or a rebuilt
		// transcript would claim the server wiped every task. The server may have
		// accepted the update — claiming "No todo changes" would be false about that.
		const h = newHarness();
		h.state.onTodoSnapshot = undefined;
		const toolCall = updateCall(
			items([
				["1", "same task", 1],
				["2", "same task", 3],
			]),
			2,
		);
		for (const kind of ["toolCallStarted", "toolCallCompleted"] as const) {
			processInteractionUpdate(wireUpdate(kind, toolCall) as never, h.output, h.stream, h.state, h.usageState);
		}

		expect(h.toolResults[0]).toMatchObject({
			toolCallId: todoBlocks(h)[0].id,
			isError: false,
			content: [{ type: "text", text: "Todo snapshot not mirrored" }],
		});
	});

	it("refuses a snapshot whose rows carry unresolved dependencies", () => {
		// `TodoItem.dependencies` is a graph the local model cannot store: rows are
		// keyed by content and have no id, so an edge cannot be replayed or
		// re-evaluated when the blocker finishes. Importing the row anyway files it
		// as plain `pending`, and `nextActionableTask` then offers work the server
		// says is not ready.
		//
		// Positive control: the same two rows without the edge do sync, so the
		// refusal is attributable to the dependency and not to a decode failure.
		const rows: [string, string, number][] = [
			["1", "blocker task", 1],
			["2", "dependent task", 1],
		];
		expect(drive(updateCall(items(rows), 2)).snapshots).toHaveLength(1);

		const h = drive(
			updateCall(
				depItems([
					["1", "blocker task", 1, []],
					["2", "dependent task", 1, ["1"]],
				]),
				2,
			),
		);
		const callId = todoBlocks(h)[0].id;

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
		// Settles as a benign no-op under the streamed id, like every other refusal.
		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: callId, error: null }]);
		expect(h.toolResults[0]).toMatchObject({ toolCallId: callId, isError: false });
	});

	it("still mirrors when every dependency is already finished", () => {
		// A dependency on a completed row constrains nothing, so refusing it would
		// strand late-session snapshots — by then most edges point at done work.
		const h = drive(
			updateCall(
				depItems([
					["1", "blocker task", 3, []],
					["2", "dependent task", 1, ["1"]],
				]),
				2,
			),
		);

		expect(h.snapshots).toEqual([
			{
				todos: [
					{ content: "blocker task", status: "completed" },
					{ content: "dependent task", status: "pending" },
				],
				merged: false,
			},
		]);
	});

	it("refuses a wire-decoded read_todos narrowed by status_filter", () => {
		const rows: [string, string, number][] = [["1", "only task", 3]];
		// Positive control: the identical response without the filter does sync,
		// so the refusal below is attributable to the filter and not to the
		// bridge failing to decode the oneof at all.
		expect(drive(readCall(items(rows), 1)).snapshots).toHaveLength(1);

		const h = drive(readCall(items(rows), 1, { statusFilter: [3] }));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("leaves local state untouched when the wire result carries an error", () => {
		const h = drive(errorCall("boom"));

		expect(todoBlocks(h)).toHaveLength(1);
		expect(h.snapshots).toEqual([]);
	});

	it("syncs under the streamed call id so the visible block can resolve", () => {
		// The interactive transcript files the block under the streamed `callId`
		// and only clears it when `tool_execution_end.toolCallId` matches. A
		// freshly generated id leaves that card pending and animating forever.
		const h = drive(updateCall(items([["1", "task", 2]]), 1));

		expect(h.syncCallIds).toEqual([todoBlocks(h)[0].id]);
	});

	it("persists a paired result so the block survives a transcript rebuild", () => {
		// `buildSessionContext` strips any `toolCall` with no matching
		// `toolResult`, so an unpaired resolved block vanishes on reload.
		const h = drive(updateCall(items([["1", "task", 3]]), 1));

		expect(h.toolResults.map(r => r.toolCallId)).toEqual([todoBlocks(h)[0].id]);
		expect(h.toolResults[0]).toMatchObject({ role: "toolResult", toolName: "todo", isError: false });
	});

	it("still pairs a result when the snapshot is refused", () => {
		// The call happened and the block is rendered; only local state was left
		// alone. Without a result the block would be stripped on rebuild.
		const h = drive(readCall(items([["1", "task", 2]]), 5));

		expect(h.snapshots).toEqual([]);
		expect(h.toolResults.map(r => r.toolCallId)).toEqual([todoBlocks(h)[0].id]);
	});

	it("settles a refused read as a successful no-op under the streamed call id", () => {
		// The card leaves `pendingTools` only on a matching completion, so a
		// refusal that stayed silent would animate forever. Nothing changed
		// locally, so it settles as a success.
		const h = drive(readCall(items([["1", "task", 2]]), 5));
		const callId = todoBlocks(h)[0].id;

		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: callId, error: null }]);
		expect(h.toolResults[0]).toMatchObject({ toolCallId: callId, isError: false });
	});

	it("settles a server error as a failure carrying the server's text", () => {
		// Collapsing an `UpdateTodosError` into the benign no-op would replay the
		// failure as a success and hide it from the rebuilt transcript.
		const h = drive(errorCall("boom"));
		const callId = todoBlocks(h)[0].id;

		expect(h.syncCalls).toEqual([{ snapshot: null, toolCallId: callId, error: "boom" }]);
		expect(h.toolResults[0]).toMatchObject({
			toolCallId: callId,
			isError: true,
			content: [{ type: "text", text: "boom" }],
		});
	});

	it("persists the host's result verbatim instead of its own summary", () => {
		// Only the host knows the phase grouping the todo renderer replays from,
		// so a provider-synthesized summary would replay the list as `0 tasks`.
		const h = drive(updateCall(items([["1", "task", 3]]), 1));

		expect(h.toolResults[0]).toMatchObject({ content: [{ type: "text", text: "host result" }] });
	});

	it("falls back to a summary-only result when no host handler is registered", () => {
		// A host with no todo state registers no handler at all; the block still
		// needs a paired result or the rebuild strips it.
		const h = newHarness();
		h.state.onTodoSnapshot = undefined;
		const toolCall = updateCall(items([["1", "task", 3]]), 1);
		for (const kind of ["toolCallStarted", "toolCallCompleted"] as const) {
			processInteractionUpdate(wireUpdate(kind, toolCall) as never, h.output, h.stream, h.state, h.usageState);
		}

		expect(h.syncCalls).toEqual([]);
		expect(h.toolResults[0]).toMatchObject({
			toolCallId: todoBlocks(h)[0].id,
			isError: false,
			content: [{ type: "text", text: "1/1 tasks completed" }],
		});
	});

	it("falls back to the server's error text when no host handler is registered", () => {
		const h = newHarness();
		h.state.onTodoSnapshot = undefined;
		const toolCall = errorCall("boom");
		for (const kind of ["toolCallStarted", "toolCallCompleted"] as const) {
			processInteractionUpdate(wireUpdate(kind, toolCall) as never, h.output, h.stream, h.state, h.usageState);
		}

		expect(h.toolResults[0]).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "boom" }],
		});
	});

	it("settles the call as a failure when the host sync callback throws", () => {
		// The host callback persists to the session branch and can throw
		// synchronously (e.g. a disk failure). The exception must not skip the
		// paired result and `toolcall_end`: the block is already marked
		// resolved, so left unpaired it is stripped from every rebuilt
		// transcript and the live card never resolves.
		const h = newHarness();
		h.state.onTodoSnapshot = () => {
			throw new Error("session persistence failed");
		};
		const toolCall = updateCall(items([["1", "task", 3]]), 1);
		for (const kind of ["toolCallStarted", "toolCallCompleted"] as const) {
			processInteractionUpdate(wireUpdate(kind, toolCall) as never, h.output, h.stream, h.state, h.usageState);
		}

		expect(h.state.currentToolCall).toBeNull();
		expect(h.toolResults).toHaveLength(1);
		expect(h.toolResults[0]).toMatchObject({
			toolCallId: todoBlocks(h)[0].id,
			isError: true,
			content: [{ type: "text", text: "session persistence failed" }],
		});
	});

	it("recognizes an MCP call through the wire-encoded oneof, start and completion", () => {
		// Same wire-shape trap the native todo calls fell into: `ToolCall.tool` is
		// a protobuf oneof, so a decoded message exposes the variant as
		// `{ case, value }` and never as a flat `mcpToolCall` property. Reading
		// the flat one produced `undefined` on every real message while
		// hand-shaped fixtures kept passing. Encode/decode for real here, and
		// cover BOTH reads: the started frame that creates the block and the
		// completed frame that merges the decoded argument map into it.
		const h = newHarness();
		const mcpCall = (args: Record<string, Uint8Array>) =>
			create(ToolCallSchema, {
				tool: {
					case: "mcpToolCall",
					value: create(McpToolCallSchema, {
						args: create(McpArgsSchema, {
							// `name` and `toolName` differ on purpose: the block must be
							// named the same way `decodeMcpCall` names the paired result,
							// which prefers `toolName`.
							name: "fixture_report",
							toolName: "mcp__fixture_report",
							toolCallId: "call-mcp-wire",
							providerIdentifier: "pi-agent",
							args,
						}),
					}),
				},
			});
		processInteractionUpdate(
			wireUpdate("toolCallStarted", mcpCall({})) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		processInteractionUpdate(
			wireUpdate("toolCallCompleted", mcpCall({ query: new TextEncoder().encode('"weather"') })) as never,
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);

		const blocks = h.output.content.filter((block): block is ToolCallState => block.type === "toolCall");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ id: "call-mcp-wire", name: "mcp__fixture_report" });
		// The completion read is what merges the decoded args onto the block.
		expect(blocks[0].arguments).toMatchObject({ query: "weather" });
	});
});
