import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { calculateDepth } from "@pk-nerdsaver-ai/pi-coding-agent/discovery/helpers";
import { parseFrontmatter } from "@pk-nerdsaver-ai/pi-utils";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses simple key-value pairs", () => {
		const content = `---
name: test
enabled: true
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({ name: "test", enabled: true });
		expect(result.body).toBe("Body content");
	});

	test("parses YAML list syntax", () => {
		const content = `---
tags:
  - javascript
  - typescript
  - react
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			tags: ["javascript", "typescript", "react"],
		});
		expect(result.body).toBe("Body content");
	});

	test("parses multi-line string values", () => {
		const content = `---
description: |
  This is a multi-line
  description block
  with several lines
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			description: "This is a multi-line\ndescription block\nwith several lines\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("parses nested objects", () => {
		const content = `---
config:
  server:
    port: 3000
    host: localhost
  database:
    name: mydb
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			config: {
				server: { port: 3000, host: "localhost" },
				database: { name: "mydb" },
			},
		});
		expect(result.body).toBe("Body content");
	});

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles invalid YAML in frontmatter", () => {
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parse(content);
		// Simple fallback parser extracts key:value pairs it can parse
		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		// Body is still extracted even with invalid YAML
		expect(result.body).toBe("Body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});
});

describe("calculateDepth", () => {
	const repo = path.resolve(path.join("repo-root"));
	const pkg = path.join(repo, "packages", "app");

	test("zero for the cwd itself", () => {
		expect(calculateDepth(pkg, pkg)).toBe(0);
	});

	test("positive for ancestors, counted per level", () => {
		expect(calculateDepth(pkg, path.join(repo, "packages"))).toBe(1);
		expect(calculateDepth(pkg, repo)).toBe(2);
	});

	test("negative for directories below the cwd", () => {
		expect(calculateDepth(repo, pkg)).toBe(-2);
	});

	test("trailing separators do not change the result", () => {
		expect(calculateDepth(pkg + path.sep, repo + path.sep)).toBe(2);
	});

	test("mixed separators match native-separator results", () => {
		// Identity on POSIX (no backslashes to replace); on Windows this is the
		// forward-slash spelling that previously produced garbage depths.
		expect(calculateDepth(pkg.replaceAll("\\", "/"), repo)).toBe(2);
		expect(calculateDepth(pkg, repo.replaceAll("\\", "/"))).toBe(2);
	});

	test("sibling directories net out ups and downs", () => {
		const sibling = path.join(repo, "packages", "other", "deep");
		// From pkg (…/packages/app) to sibling (…/packages/other/deep):
		// old formula = segment-count difference = -1.
		expect(calculateDepth(pkg, sibling)).toBe(-1);
	});
});
