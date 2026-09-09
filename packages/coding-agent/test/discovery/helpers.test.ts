import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadFilesFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { parseFrontmatter, removeSyncWithRetries } from "@oh-my-pi/pi-utils";

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

describe("loadFilesFromDir recursion", () => {
	let tempDir!: string;
	let ctx!: LoadContext;

	const write = (rel: string, content: string) => {
		const full = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	};

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loadfiles-recursion-"));
		ctx = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		// Top-level tool plus a Python-venv-style frontend asset nested below it,
		// mirroring the ~/.codex/tools/mineru/Lib/site-packages layout from #8552.
		write("my-tool.ts", "export default () => ({});\n");
		write(
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"window.matchMedia;\n",
		);
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	const names = (dir: string, recursive?: boolean) =>
		loadFilesFromDir<{ name: string }>(ctx, dir, "test", "user", {
			extensions: ["ts", "js"],
			recursive,
			transform: (_name, _content, filePath) => ({ name: path.relative(dir, filePath) }),
		}).then(r => r.items.map(i => i.name).sort());

	// Regression for #8552: the non-recursive default must NOT descend into the
	// venv subtree. The native glob defaults recursive=true, so before the fix
	// `*.{ts,js}` was rewritten to `**/*.{ts,js}` and imported the Svelte asset.
	test("default scan stays top-level and skips the venv subtree", async () => {
		expect(await names(tempDir)).toEqual(["my-tool.ts"]);
	});

	test("recursive:true still walks the whole subtree", async () => {
		expect(await names(tempDir, true)).toEqual([
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"my-tool.ts",
		]);
	});
});
