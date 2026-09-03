import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { create, type HelperOptions, SafeString } from "@oh-my-pi/pi-utils/template";
import fileOperations from "./fixtures/template/file-operations.md" with { type: "text" };
import frontmatter from "./fixtures/template/frontmatter.md" with { type: "text" };
import identifierTask from "./fixtures/template/identifier-task.md" with { type: "text" };
import sessionUser from "./fixtures/template/session-user.md" with { type: "text" };
import structuralTask from "./fixtures/template/structural-task.md" with { type: "text" };

const GOLDENS: { source: string; context: Record<string, unknown>; expected: string }[] = [
	{
		source: sessionUser,
		context: {
			user_context: "Keep API",
			changelog_targets: "packages/x",
			existing_changelog_entries: [
				{
					path: "CHANGELOG.md",
					sections: [
						{ name: "Added", items: ["A", "B"] },
						{ name: "Fixed", items: ["C"] },
					],
				},
			],
		},
		expected:
			"Generate conventional commit proposal for current staged changes.\n\nUser context:\nKeep API\n\nChangelog targets (must call propose_changelog for these files):\npackages/x\n\n## Existing Unreleased Changelog Entries\nMay include entries from list in propose_changelog `deletions` field for removal.\n### CHANGELOG.md\nAdded:\n- A\n- B\nFixed:\n- C\n\nUse git_* tools to inspect changes. Call analyze_files for deeper per-file summaries. Finish with propose_commit or split_commit.",
	},
	{
		source: frontmatter,
		context: {
			name: "reviewer",
			description: "Find bugs",
			spawns: ["scout"],
			model: "slow",
			thinkingLevel: "high",
			blocking: true,
			prewalk: false,
			autoloadSkills: ["react"],
			body: "Body",
		},
		expected:
			'---\n\nname: "reviewer"\ndescription: "Find bugs"\nspawns: ["scout"]\nmodel: "slow"\nthinking-level: "high"\nblocking: true\nautoloadSkills: ["react"]\n---\nBody',
	},
	{
		source: identifierTask,
		context: { filename: "src/a.ts", correct: "requestId", misspelled: "reqeustId", count: 2, affectedLines: [3, 8] },
		expected:
			"# Fix a misspelled identifier in `src/a.ts`\n\nA recent edit misspelled the identifier `requestId` as `reqeustId` in 2 places.\n\nAffected lines: 3, 8.\n\nReplace every occurrence of `reqeustId` with `requestId`. Do not change anything else.",
	},
	{
		source: fileOperations,
		context: { files: "read: a.ts\nmodified: b.ts" },
		expected: "<files>\nread: a.ts\nmodified: b.ts\n</files>",
	},
	{
		source: structuralTask,
		context: {
			filename: "src/a.ts",
			kind: "swap-lines",
			secondHead: "b();",
			firstHead: "a();",
			hunkCount: 2,
			fence: "```",
			language: "ts",
			hunks: [
				{ startLine: 4, newCode: "a();\nb();" },
				{ startLine: 0, newCode: "c();" },
			],
		},
		expected:
			"# Fix a bug in `src/a.ts`\n\nTwo adjacent statements are in the wrong order: `b();` belongs before `a();`. Swap the two statements.\n\nAfter the fix, the affected regions must read exactly:\n\nAround line 4:\n\n```ts\na();\nb();\n```\n\n```ts\nc();\n```\n\nMake exactly this change; do not modify anything else.",
	},
];

describe("real template goldens", () => {
	it("matches output captured from handlebars 4.7.9", () => {
		for (const fixture of GOLDENS) expect(prompt.render(fixture.source, fixture.context)).toBe(fixture.expected);
	});

	it("compiles every repository source template through the prompt seam", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const glob = new Bun.Glob("packages/*/src/**/*.md");
		let compiled = 0;
		for await (const relative of glob.scan(repoRoot)) {
			const source = await Bun.file(path.join(repoRoot, relative)).text();
			if (!source.includes("{{")) continue;
			prompt.compile(source);
			compiled++;
		}
		expect(compiled).toBeGreaterThan(100);
	});
});

describe("template semantics", () => {
	it("resolves dotted, bracket, this, parent, root, and iteration data paths", () => {
		const engine = create();
		const render = engine.compile(
			"{{user.name}}/{{user.[display name]}}/{{[literal.key]}}|{{#each groups}}{{@index}}:{{#each items}}{{../name}}/{{@root.title}}/{{@index}}/{{@last}}={{this}};{{/each}}{{/each}}",
		);
		expect(
			render({
				user: { name: "Ada", "display name": "A" },
				"literal.key": "L",
				title: "R",
				groups: [{ name: "G", items: [0, false, ""] }],
			}),
		).toBe("Ada/A/L|0:G/R/0/false=0;G/R/1/false=false;G/R/2/true=;");
	});

	it("uses handlebars falsy rules while each still visits falsy array entries", () => {
		const engine = create();
		const render = engine.compile(
			"{{#if zero}}bad{{else}}zero{{/if}}|{{#if empty}}bad{{else}}empty{{/if}}|{{#unless zero}}unless{{/unless}}|{{#each values}}[{{this}}]{{else}}none{{/each}}|{{#each object}}{{@key}}={{this}}/{{@last}};{{/each}}|{{#each missing}}bad{{else}}none{{/each}}",
		);
		expect(render({ zero: 0, empty: [], values: [0, false, ""], object: { a: 1, b: 2 } })).toBe(
			"zero|empty|unless|[0][false][]|a=1/false;b=2/true;|none",
		);
	});

	it("supports hash arguments and helper subexpressions", () => {
		const engine = create();
		engine.registerHelper("eq", (left, right) => left === right);
		engine.registerHelper("label", (value: unknown, options: HelperOptions) => `${options.hash.prefix}:${value}`);
		expect(engine.compile('{{label (eq left right) prefix="same"}}')({ left: 3, right: 3 })).toBe("same:true");
	});

	it("passes fn, inverse, and hash to block helpers", () => {
		const engine = create();
		engine.registerHelper("choose", function (this: unknown, value: unknown, options: HelperOptions) {
			return value === options.hash.expected ? options.fn(this) : options.inverse(this);
		});
		expect(engine.compile('{{#choose value expected="yes"}}Y{{else}}N{{/choose}}')({ value: "yes" })).toBe("Y");
	});

	it("escapes the exact entity set and honors triple-stache and SafeString", () => {
		const engine = create();
		engine.registerHelper("safe", value => new SafeString(value));
		const value = `&<>"'\`=`;
		expect(engine.compile("{{! short}}{{!-- long --}}{{value}}|{{{value}}}|{{safe value}}")({ value })).toBe(
			"&amp;&lt;&gt;&quot;&#x27;&#x60;&#x3D;|&<>\"'`=|&<>\"'`=",
		);
		expect(engine.compile("A\n{{!--\nlong\n--}}\nB")({})).toBe("A\nB");
	});

	it("prefers helpers over same-named properties and renders missing paths empty", () => {
		const engine = create();
		engine.registerHelper("name", () => "helper");
		expect(engine.compile("{{name}}/{{missing.path}}")({ name: "property" })).toBe("helper/");
	});
});
