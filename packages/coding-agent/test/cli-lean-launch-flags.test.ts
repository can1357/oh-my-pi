import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { VALUELESS_FLAGS } from "../src/cli/flag-tables";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

describe("lean-launch CLI flags", () => {
	describe("--skills-off", () => {
		it("parses --skills-off as an exact alias of --no-skills", () => {
			const withSkillsOff = parseArgs(["--skills-off"]);
			const withNoSkills = parseArgs(["--no-skills"]);

			expect(withSkillsOff.noSkills).toBe(true);
			expect(withNoSkills.noSkills).toBe(true);
			expect(withSkillsOff).toEqual(withNoSkills);
			expect("skillsOff" in withSkillsOff).toBe(false);
		});

		it("does not consume a following --profile value", () => {
			const result = parseArgs(["--skills-off", "--profile", "work"]);

			expect(result.noSkills).toBe(true);
			expect(result.profile).toBe("work");
			expect(result.messages).toEqual([]);

			const bootstrap = extractProfileFlags(["--skills-off", "--profile", "work"]);
			expect(bootstrap).toEqual({
				argv: ["--skills-off"],
				profile: "work",
				aliasName: undefined,
			});
		});

		it("is included in VALUELESS_FLAGS", () => {
			expect(VALUELESS_FLAGS.has("--skills-off")).toBe(true);
		});

		it("is not treated as an unrecognized flag", () => {
			const result = parseArgs(["--skills-off"]);
			expect(result.unrecognizedFlags).toEqual([]);
		});
	});

	describe("--agentmd-off", () => {
		it("parses --agentmd-off and sets noAgentMd to true", () => {
			const result = parseArgs(["--agentmd-off"]);

			expect(result.noAgentMd).toBe(true);
		});

		it("defaults noAgentMd to undefined when flag is omitted", () => {
			const result = parseArgs([]);

			expect(result.noAgentMd).toBeUndefined();
		});

		it("does not consume a following --profile value", () => {
			const result = parseArgs(["--agentmd-off", "--profile", "work"]);

			expect(result.noAgentMd).toBe(true);
			expect(result.profile).toBe("work");
			expect(result.messages).toEqual([]);

			const bootstrap = extractProfileFlags(["--agentmd-off", "--profile", "work"]);
			expect(bootstrap).toEqual({
				argv: ["--agentmd-off"],
				profile: "work",
				aliasName: undefined,
			});
		});

		it("is included in VALUELESS_FLAGS", () => {
			expect(VALUELESS_FLAGS.has("--agentmd-off")).toBe(true);
		});

		it("is not treated as an unrecognized flag", () => {
			const result = parseArgs(["--agentmd-off"]);
			expect(result.unrecognizedFlags).toEqual([]);
		});
	});

	describe("combined lean-launch flags", () => {
		it("parses both flags alongside other CLI options and positionals", () => {
			const result = parseArgs(["--skills-off", "--agentmd-off", "--model", "opus", "fix the bug"]);

			expect(result.noSkills).toBe(true);
			expect(result.noAgentMd).toBe(true);
			expect(result.model).toBe("opus");
			expect(result.messages).toEqual(["fix the bug"]);
			expect(result.unrecognizedFlags).toEqual([]);
		});

		it("preserves profile extraction when both lean-launch flags precede --profile", () => {
			const bootstrap = extractProfileFlags(["--skills-off", "--agentmd-off", "--profile", "work"]);

			expect(bootstrap).toEqual({
				argv: ["--skills-off", "--agentmd-off"],
				profile: "work",
				aliasName: undefined,
			});

			const result = parseArgs(bootstrap.argv);
			expect(result.noSkills).toBe(true);
			expect(result.noAgentMd).toBe(true);
		});
	});
});
