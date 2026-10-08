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
	it("ignores fields outside the canonical projection", () => {
		const manager = SessionManager.inMemory();
		const task: TodoItem = { content: "Fix review comments", status: "blocked" };
		const withExtras = commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ ...task, details: "touches 14 files", notes: ["see review thread"] }] },
		]);
		const canonical = commitAndIdentify(manager, [{ name: "Implementation", tasks: [{ ...task }] }]);

		expect(withExtras.fingerprint).toBe(canonical.fingerprint);
		// Same content, different edit: the pairing with the source entry is what
		// makes this a snapshot identity rather than a content hash.
		expect(withExtras.sourceEntryId).not.toBe(canonical.sourceEntryId);
	});

	it("honors a dismissal persisted from canonical phases when the live phases carry extra fields", () => {
		const manager = SessionManager.inMemory();
		const canonical: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];
		commitAndIdentify(manager, canonical);

		const dismissal = createTodoHudStateData(manager.getBranch(), canonical, "dismissed");
		expect(dismissal).toBeDefined();
		manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, dismissal);

		const withExtras: TodoPhase[] = [
			{
				name: "Implementation",
				tasks: [{ content: "Fix review comments", status: "completed", notes: ["pushed as a fixup"] }],
			},
		];
		expect(getTodoHudVisibility(manager.getBranch(), withExtras)).toBe("dismissed");
	});

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

	it("is sensitive to phase order, task order, and phase names", () => {
		const manager = SessionManager.inMemory();
		const first = commitAndIdentify(manager, [
			{
				name: "Implementation",
				tasks: [
					{ content: "Sweep call sites", status: "pending" },
					{ content: "Update tests", status: "pending" },
				],
			},
		]);
		const reorderedTasks = commitAndIdentify(manager, [
			{
				name: "Implementation",
				tasks: [
					{ content: "Update tests", status: "pending" },
					{ content: "Sweep call sites", status: "pending" },
				],
			},
		]);
		const renamedPhase = commitAndIdentify(manager, [
			{
				name: "Review",
				tasks: [
					{ content: "Sweep call sites", status: "pending" },
					{ content: "Update tests", status: "pending" },
				],
			},
		]);
		const phasesInOrder = commitAndIdentify(manager, [
			{ name: "Verification", tasks: [{ content: "Polish docs", status: "pending" }] },
			{ name: "Implementation", tasks: [{ content: "Sweep call sites", status: "pending" }] },
		]);
		const phasesSwapped = commitAndIdentify(manager, [
			{ name: "Implementation", tasks: [{ content: "Sweep call sites", status: "pending" }] },
			{ name: "Verification", tasks: [{ content: "Polish docs", status: "pending" }] },
		]);

		expect(first.fingerprint).not.toBe(reorderedTasks.fingerprint);
		expect(first.fingerprint).not.toBe(renamedPhase.fingerprint);
		expect(phasesInOrder.fingerprint).not.toBe(phasesSwapped.fingerprint);
	});

	it("admits only successful non-view todo results as canonical snapshots", () => {
		const manager = SessionManager.inMemory();
		const committed: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "in_progress" }] },
		];
		const committedIdentity = commitAndIdentify(manager, committed);
		const superseded: TodoPhase[] = [
			{ name: "Implementation", tasks: [{ content: "Fix review comments", status: "completed" }] },
		];

		// A pure `view`, a failed mutation, another tool's result, and a result
		// carrying no phases must all leave the durable snapshot — and the HUD
		// state bound to it — exactly where the last real edit put it.
		appendTodoResult(manager, "todo", { op: "view", phases: superseded });
		appendTodoResult(manager, "todo", { op: "done", phases: superseded }, true);
		appendTodoResult(manager, "task", { op: "done", phases: superseded });
		appendTodoResult(manager, "todo", { op: "done" });
		expect(getLatestTodoSnapshotIdentity(manager.getBranch())).toEqual(committedIdentity);
		expect(createTodoHudStateData(manager.getBranch(), committed, "dismissed")?.sourceEntryId).toBe(
			committedIdentity.sourceEntryId,
		);

		const appliedId = appendTodoResult(manager, "todo", { op: "done", phases: superseded });
		const identity = getLatestTodoSnapshotIdentity(manager.getBranch());
		expect(identity?.sourceEntryId).toBe(appliedId);
		expect(identity?.fingerprint).not.toBe(committedIdentity.fingerprint);
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
 * Property layer over the same contract. The example tests above pin named cases;
 * these pin the general rules a consumer actually relies on — a dismissal must
 * survive for its own plan, must never apply to a different plan, and must never
 * be moved by a result that is not a real mutation — over generated plans of
 * varying shape. `fc.string()` only yields printable ASCII, so `contentArb` mixes
 * in JSON-hostile and non-ASCII task text (`","status":"pending"`, quotes,
 * newlines, emoji, zero-width space, 240-char tails) from a fixed list.
 *
 * Seeded for CI determinism, so every run checks the same cases; fast-check
 * prints the seed plus the shrunk counterexample on failure.
 */
const PROPERTY_OPTIONS = { numRuns: 200, seed: 0x746f646f };

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "abandoned", "blocked"];
const EXTRA_TASK_CONTENT = "\u0000extra task";
const EXTRA_BLOCKER = "\u0000waiting";

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
		"x".repeat(240),
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

/** Copy a plan with one change that alters the canonical projection by construction. */
function projectChange(plan: readonly TodoPhase[], kind: number): TodoPhase[] {
	const next: TodoPhase[] = plan.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) }));
	const tasks = next[0]!.tasks;
	if (kind === 0) tasks[0]!.status = STATUSES[(STATUSES.indexOf(tasks[0]!.status) + 1) % STATUSES.length]!;
	else if (kind === 1) tasks.push({ content: EXTRA_TASK_CONTENT, status: "pending" });
	else if (kind === 2) next[0]!.name = `${next[0]!.name}!`;
	else if (kind === 3) tasks[0]!.content = `${tasks[0]!.content}!`;
	else tasks[0]!.blocker = EXTRA_BLOCKER;
	return next;
}

type PlanRows = { name: string; tasks: { content: string; status: string; blocker?: string }[] }[];

/** Copy a plan with one edit inside the projection: append a long tail, add leading
 * whitespace, flip letter case, set an empty blocker, or advance the status. */
function projectedEdit(plan: readonly TodoPhase[], phaseIdx: number, taskIdx: number, kind: number): TodoPhase[] {
	return plan.map((phase, p) => ({
		...phase,
		tasks: phase.tasks.map((task, t) => {
			if (p !== phaseIdx || t !== taskIdx) return { ...task };
			const edited: TodoItem = { ...task };
			if (kind === 0) edited.content = `${task.content}${"y".repeat(120)}`;
			else if (kind === 1) edited.content = ` ${task.content}`;
			else if (kind === 2) {
				const flipped =
					task.content === task.content.toUpperCase() ? task.content.toLowerCase() : task.content.toUpperCase();
				edited.content = flipped === task.content ? `${task.content}Qq` : flipped;
			} else if (kind === 3) edited.blocker = "";
			else edited.status = STATUSES[(STATUSES.indexOf(task.status) + 1) % STATUSES.length]!;
			return edited;
		}),
	}));
}

describe("todo snapshot identity properties", () => {
	it("identity is blind to renderer-only fields for any plan", () => {
		fc.assert(
			fc.property(planArb, plan => {
				const manager = SessionManager.inMemory();
				const base = commitAndIdentify(manager, plan);
				const rewritten = commitAndIdentify(manager, withRendererExtras(plan));
				return rewritten.fingerprint === base.fingerprint && rewritten.sourceEntryId !== base.sourceEntryId;
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("plans that differ in the projection never share a fingerprint", () => {
		fc.assert(
			fc.property(planArb, fc.integer({ min: 0, max: 4 }), (plan, kind) => {
				fc.pre(kind !== 4 || plan[0]!.tasks[0]!.blocker !== EXTRA_BLOCKER);
				const manager = SessionManager.inMemory();
				const base = commitAndIdentify(manager, plan);
				const changed = commitAndIdentify(manager, projectChange(plan, kind));
				return changed.fingerprint !== base.fingerprint;
			}),
			PROPERTY_OPTIONS,
		);
	});

	it("a persisted HUD choice survives for its own plan and never applies to another", () => {
		fc.assert(
			fc.property(
				planArb,
				fc.integer({ min: 0, max: 4 }),
				fc.constantFrom("dismissed" as const, "revealed" as const),
				(plan, kind, visibility) => {
					fc.pre(kind !== 4 || plan[0]!.tasks[0]!.blocker !== EXTRA_BLOCKER);
					const manager = SessionManager.inMemory();
					commitAndIdentify(manager, plan);
					const data = createTodoHudStateData(manager.getBranch(), plan, visibility);
					if (!data) return false;
					manager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, data);
					if (getTodoHudVisibility(manager.getBranch(), withRendererExtras(plan)) !== visibility) return false;
					return getTodoHudVisibility(manager.getBranch(), projectChange(plan, kind)) === undefined;
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

	it("any single edit inside the projection changes the fingerprint", () => {
		fc.assert(
			fc.property(
				planArb,
				fc.integer({ min: 0, max: 1_000_003 }),
				fc.integer({ min: 0, max: 1_000_003 }),
				fc.integer({ min: 0, max: 4 }),
				(plan, phasePick, taskPick, kind) => {
					const phaseIdx = phasePick % plan.length;
					const taskIdx = taskPick % plan[phaseIdx]!.tasks.length;
					const manager = SessionManager.inMemory();
					const base = commitAndIdentify(manager, plan);
					const edited = commitAndIdentify(manager, projectedEdit(plan, phaseIdx, taskIdx, kind));
					return edited.fingerprint !== base.fingerprint;
				},
			),
			PROPERTY_OPTIONS,
		);
	});

	it("a fingerprint reports the plan it was taken from", () => {
		fc.assert(
			fc.property(planArb, plan => {
				const manager = SessionManager.inMemory();
				const identity = commitAndIdentify(manager, plan);
				// The fingerprint is persisted into HUD state and recomputed from live
				// phases after resume. Changing its encoding silently invalidates
				// every saved dismissal on upgrade, so the persisted shape is pinned:
				// the JSON projection of the plan, same phases, tasks, and order,
				// nothing truncated, case-folded, trimmed, or collapsed.
				const rowsOf = (phases: PlanRows) =>
					phases.flatMap(phase =>
						phase.tasks.map(
							task =>
								`${phase.name}\u0000${task.content}\u0000${task.status}\u0000${JSON.stringify(task.blocker ?? null)}`,
						),
					);
				let decoded: PlanRows;
				try {
					decoded = JSON.parse(identity.fingerprint) as PlanRows;
				} catch {
					return false;
				}
				return Bun.deepEquals(rowsOf(decoded), rowsOf(plan));
			}),
			PROPERTY_OPTIONS,
		);
	});
});
