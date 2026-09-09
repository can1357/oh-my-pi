import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

describe("parseFrontmatter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts unquoted skill descriptions containing colon-space without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
name: tool-prompt-optimization
description: Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.
enabled: true
---
Skill body`;

		const result = parseFrontmatter(content, { source: "bad-skill/SKILL.md" });

		expect(result.frontmatter).toEqual({
			name: "tool-prompt-optimization",
			description: "Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.",
			enabled: true,
		});
		expect(result.body).toBe("Skill body");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("still warns and falls back for unrecoverable malformed frontmatter", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parseFrontmatter(content, { source: "broken.md" });

		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		expect(result.body).toBe("Body content");
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("broken.md") }),
		);
	});

	it("reparses each fallback value so one malformed line can't corrupt its siblings", () => {
		// `scope: "text","thinking"` is not valid YAML, forcing the line-by-line
		// fallback. The sibling `condition` value must not inherit literal quotes,
		// and `enabled` must reparse to a boolean (issue #4796).
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
condition: "(?i)pre.existing"
scope: "text","thinking"
enabled: true
---
Body`;

		const result = parseFrontmatter(content, { source: "rule.md" });

		expect(result.frontmatter.condition).toBe("(?i)pre.existing");
		expect(result.frontmatter.enabled).toBe(true);
		// The unrecoverable line survives as its raw trimmed string.
		expect(result.frontmatter.scope).toBe('"text","thinking"');
		expect(result.body).toBe("Body");
		expect(warnSpy).toHaveBeenCalled();
	});
});
