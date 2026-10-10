import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	createTodoHudStateData,
	getLatestTodoSnapshotIdentity,
	getTodoHudVisibility,
	TODO_HUD_STATE_CUSTOM_TYPE,
	type TodoSnapshotIdentity,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoItem, TodoPhase, TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";

/** Commit a canonical todo edit and return the identity of the snapshot it produced. */
function commitAndIdentify(manager: SessionManager, phases: readonly TodoPhase[]): TodoSnapshotIdentity {
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	const identity = getLatestTodoSnapshotIdentity(manager.getBranch());
	if (!identity) throw new Error("Expected the todo edit to land as a canonical snapshot");
	return identity;
}

/** Append a `todo`-shaped tool result so the canonical-admission rules can be probed. */
function appendTodoResult(manager: SessionManager, toolName: string, details: unknown, isError = false): string {
	return manager.appendMessage({
		role: "toolResult",
		toolCallId: `${toolName}-call-${manager.getBranch().length}`,
		toolName,
		content: [],
		isError,
		timestamp: Date.now(),
		details,
	});
}

describe("todo snapshot identity", () => {
	it("treats a blocker note as part of the identity, but not its presence as a field", () => {
		const manager = SessionManager.inMemory();
		const noNote = commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "blocked" }] },
		]);
		const explicitUndefined = commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "blocked", blocker: undefined }] },
		]);
		const withNote = commitAndIdentify(manager, [
			{
				name: "Implementation",
				tasks: [{ content: "Fix review comments", status: "blocked", blocker: "waiting on ReviewFixer" }],
			},
		]);
		const changedNote = commitAndIdentify(manager, [
			{
				name: "Implementation",
				tasks: [{ content: "Fix review comments", status: "blocked", blocker: "waiting on sign-off" }],
			},
		]);

		expect(noNote.fingerprint).toBe(explicitUndefined.fingerprint);
		expect(noNote.fingerprint).not.toBe(withNote.fingerprint);
		expect(withNote.fingerprint).not.toBe(changedNote.fingerprint);
	});

	it("admits a successful todo result as the latest canonical snapshot", () => {
		const manager = SessionManager.inMemory();
		const committed = commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "in_progress" }] },
		]);

		const appliedId = appendTodoResult(manager, "todo", {
			op: "done",
			phases: [{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] }],
		});
		const identity = getLatestTodoSnapshotIdentity(manager.getBranch());
		expect(identity?.sourceEntryId).toBe(appliedId);
		expect(identity?.fingerprint).not.toBe(committed.fingerprint);
	});

	it("refuses HUD state for phases that are not the latest durable snapshot", () => {
		const manager = SessionManager.inMemory();
		const stale: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];
		commitAndIdentify(manager, stale);
		commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "abandoned" }] },
		]);

		expect(createTodoHudStateData(manager.getBranch(), stale, "dismissed")).toBeUndefined();
		expect(getTodoHudVisibility(manager.getBranch(), stale)).toBeUndefined();
	});

	it("ignores todo entries with a missing payload instead of throwing during the scan", () => {
		const manager = SessionManager.inMemory();
		const plan: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "pending" }] },
		];
		const identity = commitAndIdentify(manager, plan);

		// The scan runs on every resume, and a session file can hold entries an
		// older build wrote without a payload: a todo edit with no data, a `todo`
		// tool result with no details, HUD state with no data. Each must read as
		// "no snapshot here", never as a crash.
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, undefined);
		appendTodoResult(manager, "todo", undefined);
		manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, undefined);

		expect(getLatestTodoSnapshotIdentity(manager.getBranch())).toEqual(identity);
		expect(getTodoHudVisibility(manager.getBranch(), plan)).toBeUndefined();
	});

	it("refuses a dismissal whose stored fingerprint predates the current formula", () => {
		const manager = SessionManager.inMemory();
		const plan: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];
		const identity = commitAndIdentify(manager, plan);

		// HUD state persisted by an older build carries that build's fingerprint for
		// the same source entry. The fingerprint is what makes a dismissal
		// snapshot-specific, so a stale one must leave the HUD visible.
		manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, {
			sourceEntryId: identity.sourceEntryId,
			fingerprint: "pre-fingerprint-formula",
			visibility: "dismissed",
		});
		expect(getTodoHudVisibility(manager.getBranch(), plan)).toBeUndefined();

		manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, { ...identity, visibility: "dismissed" });
		expect(getTodoHudVisibility(manager.getBranch(), plan)).toBe("dismissed");
	});

	it("refuses HUD state whose visibility is not a recognized value", () => {
		const manager = SessionManager.inMemory();
		const plan: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];
		const identity = commitAndIdentify(manager, plan);

		// An unrecognized persisted value (newer build, hand-edited file) is neither
		// a dismissal nor a reveal.
		manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, { ...identity, visibility: "hidden" });
		expect(getTodoHudVisibility(manager.getBranch(), plan)).toBeUndefined();
	});

	it("honors HUD state persisted under the literal session key", () => {
		const manager = SessionManager.inMemory();
		const plan: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];
		const identity = commitAndIdentify(manager, plan);

		// `todo_hud_state` is a persisted key: session files written by earlier
		// builds carry it verbatim, so the reader must keep honoring it.
		manager.appendCustomEntry("todo_hud_state", { ...identity, visibility: "dismissed" });
		expect(getTodoHudVisibility(manager.getBranch(), plan)).toBe("dismissed");
	});
});

/**
 * Property layer over the same contract. Rules that must hold for any plan live here
 * rather than as examples above: a dismissal must survive for its own plan, must never
 * apply to a different plan, must never be moved by a result that is not a real
 * mutation, and the fingerprint must react to every edit inside the projection —
 * including reordering tasks or phases. `fc.string()` only yields printable ASCII, so
 * `contentArb` mixes in JSON-hostile and non-ASCII task text (`","status":"pending"`,
 * quotes, newlines, emoji, zero-width space, NUL, 240-char tails) from a fixed list.
 *
 * Seeded for CI determinism, so every run checks the same cases; fast-check prints the
 * seed plus the shrunk counterexample on failure.
 */
const PROPERTY_OPTIONS = { numRuns: 200, seed: 0x746f646f };

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "abandoned", "blocked"];
/** Task content the `add a task` mutator inserts; the leading NUL keeps it distinct from generated content. */
const ADDED_TASK_CONTENT = "\u0000extra task";
/** Long tail the content mutator appends; long enough that a prefix-only fingerprint cannot hide it. */
const LONG_TAIL = "y".repeat(400);
/** Long task body the generator can produce. */
const LONG_TASK_TEXT = "x".repeat(240);

const contentArb = fc.oneof(
	fc.string(),
	fc.string({ minLength: 80, maxLength: 300 }),
	fc.constantFrom(
		"",
		" ",
		"Fix review comments",
		'",status":"pending"',
		'Implementation", "tasks": [{"content": "Ghost"}]',
		"a\\b",
		"a\nb",
		"日本",
		"\u200b",
		"🚀",
		LONG_TASK_TEXT,
		"null",
		"[]",
	),
);
const phaseNameArb = fc.oneof(
	fc.string({ minLength: 1, maxLength: 12 }),
	fc.constantFrom("Implementation", "implementation", "Verification", "日本", " "),
);
const taskArb = fc.record({
	content: contentArb,
	status: fc.constantFrom(...STATUSES),
	blocker: fc.option(fc.string({ minLength: 1, maxLength: 24 }), { nil: undefined }),
	details: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
	notes: fc.option(fc.array(fc.string({ maxLength: 12 }), { maxLength: 2 }), { nil: undefined }),
});
const phaseArb = fc.record({ name: phaseNameArb, tasks: fc.array(taskArb, { minLength: 1, maxLength: 4 }) });
const planArb = fc.array(phaseArb, { minLength: 1, maxLength: 3 });

/** Copy a plan with renderer-only fields rewritten; the projection must ignore them. */
function withRendererExtras(plan: readonly TodoPhase[]): TodoPhase[] {
	return plan.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task => ({ ...task, details: "renderer only", notes: ["see review thread"] })),
	}));
}

/**
 * Edits inside the canonical projection, applied to the phase and task picked by
 * `phasePick`/`taskPick`. Each changes the projection by construction, so a fingerprint
 * that survives one is ignoring part of the projection. The label names the part and is
 * reported when a mutator fails. `changeArb` samples this list's length, so adding a
 * mutator extends coverage with no second number to keep in sync.
 */
type ProjectionMutator = { label: string; apply: (phase: TodoPhase, task: TodoItem) => void };
const PROJECTION_MUTATORS: ProjectionMutator[] = [
	{
		label: "advance the status",
		apply: (_phase, task) => {
			task.status = STATUSES[(STATUSES.indexOf(task.status) + 1) % STATUSES.length]!;
		},
	},
	{
		label: "append a long tail to the task content",
		apply: (_phase, task) => {
			task.content += LONG_TAIL;
		},
	},
	{
		label: "add leading whitespace to the task content",
		apply: (_phase, task) => {
			task.content = ` ${task.content}`;
		},
	},
	{
		label: "flip the letter case of the task content",
		apply: (_phase, task) => {
			const flipped =
				task.content === task.content.toUpperCase() ? task.content.toLowerCase() : task.content.toUpperCase();
			task.content = flipped === task.content ? `${task.content}Qq` : flipped;
		},
	},
	{
		label: "set an empty blocker note (empty against absent)",
		apply: (_phase, task) => {
			task.blocker = "";
		},
	},
	{
		label: "rename the phase",
		apply: phase => {
			phase.name = `${phase.name}!`;
		},
	},
	{
		label: "add a task",
		apply: phase => {
			phase.tasks.push({ content: ADDED_TASK_CONTENT, status: "pending" });
		},
	},
];

function projectChange(
	plan: readonly TodoPhase[],
	phasePick: number,
	taskPick: number,
	mutator: ProjectionMutator,
): TodoPhase[] {
	const next: TodoPhase[] = plan.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) }));
	const phase = next[phasePick % next.length]!;
	mutator.apply(phase, phase.tasks[taskPick % phase.tasks.length]!);
	return next;
}

// The label rides in the generated value so fast-check prints which mutator failed.
const changeArb = fc.integer({ min: 0, max: PROJECTION_MUTATORS.length - 1 }).chain(index =>
	fc.record({
		phasePick: fc.nat(),
		taskPick: fc.nat(),
		mutator: fc.constant(PROJECTION_MUTATORS[index]!),
	}),
);

describe("todo snapshot identity properties", () => {
	it("identity is blind to renderer-only fields for any plan", () => {
		fc.assert(
			fc.property(planArb, plan => {
				const manager = SessionManager.inMemory();
				const base = commitAndIdentify(manager, plan);
				const rewritten = commitAndIdentify(manager, withRendererExtras(plan));
				return rewritten.fingerprint === base.fingerprint;
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("plans that differ in the projection never share a fingerprint", () => {
		fc.assert(
			fc.property(planArb, changeArb, (plan, { phasePick, taskPick, mutator }) => {
				const manager = SessionManager.inMemory();
				const base = commitAndIdentify(manager, plan);
				const changed = commitAndIdentify(manager, projectChange(plan, phasePick, taskPick, mutator));
				return changed.fingerprint !== base.fingerprint;
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("reordering tasks within a phase, or phases within a plan, changes the fingerprint", () => {
		fc.assert(
			fc.property(contentArb, phaseNameArb, (content, name) => {
				// The NUL tail makes the two tasks distinct by construction, so a
				// reversal is always a real reorder and never a no-op.
				const left: TodoItem = { content, status: "pending" };
				const right: TodoItem = { content: `${content}${ADDED_TASK_CONTENT}`, status: "pending" };
				const manager = SessionManager.inMemory();

				const ordered = commitAndIdentify(manager, [{ name, tasks: [left, right] }]);
				const reversedTasks = commitAndIdentify(manager, [{ name, tasks: [right, left] }]);
				if (reversedTasks.fingerprint === ordered.fingerprint) return false;

				const phases = commitAndIdentify(manager, [
					{ name, tasks: [left] },
					{ name, tasks: [right] },
				]);
				const reversedPhases = commitAndIdentify(manager, [
					{ name, tasks: [right] },
					{ name, tasks: [left] },
				]);
				return reversedPhases.fingerprint !== phases.fingerprint;
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("a persisted HUD choice survives for its own plan and never applies to another", () => {
		fc.assert(
			fc.property(
				planArb,
				changeArb,
				fc.constantFrom("dismissed" as const, "revealed" as const),
				(plan, { phasePick, taskPick, mutator }, visibility) => {
					const manager = SessionManager.inMemory();
					commitAndIdentify(manager, plan);
					const data = createTodoHudStateData(manager.getBranch(), plan, visibility);
					if (!data) return false;
					manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, data);
					if (getTodoHudVisibility(manager.getBranch(), withRendererExtras(plan)) !== visibility) return false;
					return (
						getTodoHudVisibility(manager.getBranch(), projectChange(plan, phasePick, taskPick, mutator)) ===
						undefined
					);
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("no non-canonical tool result can move the durable snapshot", () => {
		fc.assert(
			fc.property(planArb, planArb, fc.integer({ min: 0, max: 4 }), (committed, noise, kind) => {
				const manager = SessionManager.inMemory();
				const base = commitAndIdentify(manager, committed);
				const details =
					kind === 0
						? { op: "view", phases: noise }
						: kind === 1
							? { op: "done", phases: noise }
							: kind === 2
								? { op: "done" }
								: kind === 3
									? { op: "done", phases: "not a plan" }
									: { op: "done", phases: noise };
				appendTodoResult(manager, kind === 4 ? "task" : "todo", details, kind === 1);
				const after = getLatestTodoSnapshotIdentity(manager.getBranch());
				return (
					after !== undefined &&
					after.sourceEntryId === base.sourceEntryId &&
					after.fingerprint === base.fingerprint
				);
			}),
			PROPERTY_OPTIONS,
		);
	});
});
