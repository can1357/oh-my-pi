import { describe, expect, test } from "bun:test";
import { isCompliantSubject } from "./merge-pr";

describe("isCompliantSubject", () => {
	test("accepts conventional subjects, including scope and bang", () => {
		expect(isCompliantSubject("fix: added thing")).toBe(true);
		expect(isCompliantSubject("feat(catalog): added native meta provider")).toBe(true);
		expect(isCompliantSubject("refactor(tui)!: dropped legacy renderer")).toBe(true);
	});

	test("rejects prefix-only false positives", () => {
		expect(isCompliantSubject("fix: Add Thing.")).toBe(false); // uppercase + period
		expect(isCompliantSubject("fix: Added thing")).toBe(false); // uppercase description
		expect(isCompliantSubject("fix: added thing.")).toBe(false); // trailing period
		expect(isCompliantSubject(`fix: ${"a".repeat(70)}`)).toBe(false); // >72 chars total
	});

	test("rejects subjects without a conventional prefix", () => {
		expect(isCompliantSubject("added thing")).toBe(false);
		expect(isCompliantSubject("Fix: added thing")).toBe(false);
		expect(isCompliantSubject("fix:")).toBe(false);
	});

	test("selection skips earlier noncompliant commits", () => {
		const subjects = ["fix: Add Thing.", "WIP", "fix: added thing", "feat: also fine"];
		expect(subjects.find(isCompliantSubject)).toBe("fix: added thing");
	});
});
