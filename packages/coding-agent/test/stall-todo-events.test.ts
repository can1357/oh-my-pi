import { describe, expect, it } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TodoTracker, type TodoTrackerHost } from "../src/session/todo-tracker";

describe("canonical todo change events", () => {
	it("captures close/reopen/removal independently of persistence and exposes defensive snapshots", () => {
		const tracker = new TodoTracker({} as TodoTrackerHost);
		const events: TodoPhase[][] = [];
		const unsubscribe = tracker.onChange(phases => {
			events.push(phases);
		});
		tracker.setPhases([{ name: "Work", tasks: [{ content: "deliver", status: "pending" }] }]);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "deliver", status: "completed" }] }]);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "deliver", status: "blocked", blocker: "permission" }] }]);
		tracker.setPhases([]);
		expect(
			events.map<TodoPhase["tasks"][number]["status"] | "removed">(
				phases => phases[0]?.tasks[0]?.status ?? "removed",
			),
		).toEqual(["pending", "completed", "blocked", "removed"]);
		tracker.setPhases([{ name: "Work", tasks: [{ content: "deliver", status: "pending" }] }]);
		events.at(-1)![0].tasks[0].content = "mutated observer copy";
		expect(tracker.phases[0].tasks[0].content).toBe("deliver");
		unsubscribe();
		tracker.setPhases([]);
		expect(events.length).toBe(5);
	});

	it("does not emit unchanged snapshots and isolates throwing observers", () => {
		const tracker = new TodoTracker({} as TodoTrackerHost);
		let received = 0;
		tracker.onChange(() => {
			throw new Error("observer failure");
		});
		tracker.onChange(() => {
			received++;
		});
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "deliver", status: "pending" }] }];
		tracker.setPhases(phases);
		tracker.setPhases(structuredClone(phases));
		expect(received).toBe(1);
		expect(tracker.phases).toEqual(phases);
	});

	it("emits metadata-only changes but not repeated identical snapshots while subscribed", () => {
		const tracker = new TodoTracker({} as TodoTrackerHost);
		const initial: TodoPhase[] = [
			{
				name: "Work",
				tasks: [{ content: "deliver", status: "pending", details: "first details", notes: ["first note"] }],
			},
		];
		const changedDetails = structuredClone(initial);
		changedDetails[0].tasks[0].details = "updated details";
		const changedNotes = structuredClone(changedDetails);
		changedNotes[0].tasks[0].notes = ["updated note", "second note"];
		const reorderedNotes = structuredClone(changedNotes);
		reorderedNotes[0].tasks[0].notes = ["second note", "updated note"];
		const removedMetadata = structuredClone(reorderedNotes);
		delete removedMetadata[0].tasks[0].details;
		delete removedMetadata[0].tasks[0].notes;
		const events: TodoPhase[][] = [];
		tracker.onChange(phases => events.push(phases));

		for (const phases of [initial, changedDetails, changedNotes, reorderedNotes, removedMetadata]) {
			tracker.setPhases(phases);
			expect(tracker.phases).toEqual(phases);
			tracker.setPhases(structuredClone(phases));
		}

		expect(events).toEqual([initial, changedDetails, changedNotes, reorderedNotes, removedMetadata]);
	});

	it("projects only declared task fields while preserving report metadata", () => {
		const tracker = new TodoTracker({} as TodoTrackerHost);
		const task = {
			content: "deliver",
			status: "blocked" as const,
			blocker: "permission",
			details: "request access",
			notes: ["approval requested"],
			callerMetadata: "not a declared todo field",
		};
		const phases = [{ name: "Work", tasks: [task] }];
		const expected: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: "deliver",
						status: "blocked",
						blocker: "permission",
						details: "request access",
						notes: ["approval requested"],
					},
				],
			},
		];
		const events: TodoPhase[][] = [];
		tracker.onChange(snapshot => events.push(snapshot));
		tracker.setPhases(phases);
		task.callerMetadata = "changed undeclared metadata";
		tracker.setPhases(phases);

		expect(tracker.phases).toEqual(expected);
		expect(tracker.clonePhases(phases)).toEqual(expected);
		expect(events).toEqual([expected]);
		expect(Object.keys(tracker.phases[0].tasks[0]).sort()).toEqual([
			"blocker",
			"content",
			"details",
			"notes",
			"status",
		]);
	});

	it("isolates input, getter, clone, and observer notes from canonical state and each other", () => {
		const tracker = new TodoTracker({} as TodoTrackerHost);
		const canonical: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{
						content: "deliver",
						status: "blocked",
						blocker: "permission",
						details: "request access",
						notes: ["approval requested"],
					},
				],
			},
		];
		const input = structuredClone(canonical);
		const observed: TodoPhase[][] = [];
		tracker.onChange(phases => {
			phases[0].tasks[0].notes!.push("mutated first observer");
			phases[0].tasks[0].details = "mutated first observer";
		});
		tracker.onChange(phases => observed.push(phases));
		tracker.setPhases(input);
		input[0].tasks[0].notes!.push("mutated input");
		const snapshot = tracker.phases;
		snapshot[0].tasks[0].notes![0] = "mutated getter";
		const clone = tracker.clonePhases(canonical);
		clone[0].tasks[0].notes!.push("mutated explicit clone");

		expect(observed).toEqual([canonical]);
		expect(tracker.phases).toEqual(canonical);
		observed[0][0].tasks[0].notes!.push("mutated second observer");
		expect(tracker.phases).toEqual(canonical);
		tracker.setPhases(structuredClone(canonical));
		expect(observed.length).toBe(1);
		expect(tracker.phases).toEqual(canonical);
	});
});
