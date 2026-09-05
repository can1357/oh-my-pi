import { describe, expect, test } from "bun:test";
import { classifyTask, createTaskRoutingBenchmarkRecord, TaskRouteTracker } from "../src/task-router";

describe("adaptive task router", () => {
	test("classifies trivial edits as SIMPLE", () => {
		expect(classifyTask("Rename this variable.").complexity).toBe("SIMPLE");
		expect(classifyTask("Fix this typo.").complexity).toBe("SIMPLE");
		expect(classifyTask("Change this button label.").complexity).toBe("SIMPLE");
		expect(classifyTask("Update this constant.").complexity).toBe("SIMPLE");
	});

	test("classifies normal feature work as NORMAL", () => {
		expect(classifyTask("Add pagination to the users endpoint.").complexity).toBe("NORMAL");
		expect(classifyTask("Add a new settings page.").complexity).toBe("NORMAL");
		expect(classifyTask("Implement CSV export.").complexity).toBe("NORMAL");
	});

	test("classifies cross-cutting engineering as COMPLEX", () => {
		expect(classifyTask("Refactor authentication across the API and frontend.").complexity).toBe("COMPLEX");
		expect(classifyTask("Fix a race condition spanning multiple subsystems.", { relevantFileCount: 4 }).complexity).toBe("COMPLEX");
	});

	test("classifies architecture replacement plus migration as VERY_COMPLEX", () => {
		expect(classifyTask("Replace the authentication architecture and migrate existing sessions across multiple services.").complexity).toBe("VERY_COMPLEX");
		expect(classifyTask("Redesign the application's persistence layer across multiple services.").complexity).toBe("VERY_COMPLEX");
	});

	test("low-confidence simple-looking tasks use a safer workflow", () => {
		const result = classifyTask("Maybe change something in the project.", { knownUncertainty: true });
		expect(result.complexity).toBe("NORMAL");
		expect(result.workflow.plan).toBe(true);
	});

	test("repository hints can raise scope without scanning the repository", () => {
		const result = classifyTask("Update the authentication flow.", {
			relevantFileCount: 6,
			crossesSubsystems: true,
			subsystemCount: 4,
			hasTests: true,
		});
		expect(result.signals.likelyFiles).toBe(6);
		expect(result.signals.crossSubsystem).toBe(true);
		expect(result.complexity).toBe("COMPLEX");
	});

	test("escalates only after bounded evidence", () => {
		const tracker = new TaskRouteTracker(classifyTask("Add pagination to the users endpoint."));
		expect(tracker.current.complexity).toBe("NORMAL");
		expect(tracker.observe("test_failure", "first targeted test failure")).toBeUndefined();
		const escalation = tracker.observe("test_failure", "second targeted test failure");
		expect(escalation?.from).toBe("NORMAL");
		expect(escalation?.to).toBe("COMPLEX");
		expect(tracker.current.workflow.explore).toBe(true);
	});

	test("does not escalate repeatedly past the bounded policy", () => {
		const tracker = new TaskRouteTracker(classifyTask("Refactor authentication across the API and frontend."));
		tracker.observe("test_failure", "first failure");
		tracker.observe("test_failure", "second failure");
		expect(tracker.current.complexity).toBe("COMPLEX");
		tracker.observe("test_failure", "third failure");
		tracker.observe("test_failure", "fourth failure");
		expect(tracker.current.complexity).toBe("VERY_COMPLEX");
		tracker.observe("test_failure", "fifth failure");
		expect(tracker.current.complexity).toBe("VERY_COMPLEX");
		expect(tracker.telemetry.escalations.length).toBeLessThanOrEqual(2);
	});

	test("benchmark records are measurement-ready without fabricating metrics", () => {
		const tracker = new TaskRouteTracker(classifyTask("Implement CSV export."));
		const record = createTaskRoutingBenchmarkRecord(tracker.telemetry);
		expect(record.taskComplexity).toBe("NORMAL");
		expect(record.initialConfidence).toBe(tracker.initial.confidence);
		expect(record.finalComplexity).toBe("NORMAL");
		expect(record.tokens).toBeUndefined();
		expect(record.latencyMs).toBeUndefined();
	});
});
