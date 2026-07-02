import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("--project-skills", () => {
	it("parses as a boolean launch flag", () => {
		const result = parseArgs(["--project-skills"]);

		expect(result.projectSkills).toBe(true);
	});

	it("does not consume the following prompt or flag", () => {
		const result = parseArgs(["--project-skills", "--model", "opus", "explain"]);

		expect(result.projectSkills).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual(["explain"]);
	});
});
