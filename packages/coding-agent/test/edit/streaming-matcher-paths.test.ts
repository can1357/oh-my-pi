/**
 * `EditStreamingStrategy.matcherPaths` extracts the target file paths from a
 * (potentially partial) streamed edit payload, so TTSR's path-scoped match
 * context can be populated even when the path lives inside the wire payload
 * (a hashline section header, an apply_patch envelope marker) rather than as
 * a top-level `path` / `paths` argument.
 *
 * Regression: see https://github.com/can1357/oh-my-pi/issues/3646. Before the
 * fix, the path-scoped rule `tool:edit(*.ts)` did not match hashline edits
 * because `agent-session`'s argument scan only saw the top-level
 * `{ input: "<hashline payload>" }` and never inspected the section header.
 */
import { describe, expect, it } from "bun:test";
import { EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit/streaming";

describe("EDIT_MODE_STRATEGIES.matcherPaths", () => {
	describe("replace + patch (top-level path)", () => {
		it("returns the top-level path for the replace strategy", () => {
			expect(EDIT_MODE_STRATEGIES.replace.matcherPaths({ path: "src/foo.ts" })).toEqual(["src/foo.ts"]);
		});

		it("returns the top-level path for the patch strategy", () => {
			expect(EDIT_MODE_STRATEGIES.patch.matcherPaths({ path: "src/bar.ts" })).toEqual(["src/bar.ts"]);
		});

		it("returns undefined when no path is present", () => {
			expect(EDIT_MODE_STRATEGIES.replace.matcherPaths({})).toBeUndefined();
			expect(EDIT_MODE_STRATEGIES.patch.matcherPaths({})).toBeUndefined();
		});
	});

	describe("hashline (section-header path)", () => {
		it("extracts the path from a single section header", () => {
			const input = "[demo.ts#ABCD]\nPUT 1-1:\n+const x = 1;\n";
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input })).toEqual(["demo.ts"]);
		});

		it("extracts paths from multiple section headers in order, deduped", () => {
			const input = [
				"[src/a.ts#ABCD]",
				"PUT 1-1:",
				"+const a = 1;",
				"[src/b.ts#EF01]",
				"PUT 1-1:",
				"+const b = 2;",
				"[src/a.ts#1234]",
				"PUT 2-2:",
				"+const c = 3;",
				"",
			].join("\n");
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input })).toEqual(["src/a.ts", "src/b.ts", "src/a.ts"]);
		});

		it("tolerates a streaming partial payload (header complete, body still mid-typed)", () => {
			// `Patch.parse` would throw on this trailing op; `matcherPaths` must
			// still recover the path from the closed header line.
			const input = "[src/partial.ts#ABCD]\nSWAP 1.=";
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input })).toEqual(["src/partial.ts"]);
		});

		it("handles paths with spaces and recovers apply_patch-style header noise", () => {
			const input = [
				"[dir with spaces/file.ts#1A2B]",
				"PUT 1-1:",
				"+after",
				"[*** Update File: src/recovered.ts#1A2B]",
				"PUT 1-1:",
				"+after",
				"",
			].join("\n");
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input })).toEqual([
				"dir with spaces/file.ts",
				"src/recovered.ts",
			]);
		});

		it("returns undefined when input has no section header", () => {
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input: "" })).toBeUndefined();
			expect(EDIT_MODE_STRATEGIES.hashline.matcherPaths({ input: "PUT 1-1:\n+x" })).toBeUndefined();
		});
	});

	describe("apply_patch (envelope-marker path)", () => {
		it("extracts paths from Update / Add / Delete File markers", () => {
			const input = [
				"*** Begin Patch",
				"*** Update File: src/a.ts",
				"@@",
				"-foo",
				"+bar",
				"*** Add File: src/b.ts",
				"+new",
				"*** Delete File: src/c.ts",
				"*** End Patch",
				"",
			].join("\n");
			expect(EDIT_MODE_STRATEGIES.apply_patch.matcherPaths({ input })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		});

		it("recovers paths from a streaming partial envelope (no End Patch yet)", () => {
			const input = ["*** Begin Patch", "*** Update File: src/partial.ts", "@@", "+wip"].join("\n");
			expect(EDIT_MODE_STRATEGIES.apply_patch.matcherPaths({ input })).toEqual(["src/partial.ts"]);
		});

		it("returns undefined when the envelope carries no file markers yet", () => {
			expect(EDIT_MODE_STRATEGIES.apply_patch.matcherPaths({ input: "" })).toBeUndefined();
			expect(EDIT_MODE_STRATEGIES.apply_patch.matcherPaths({ input: "*** Begin Patch\n" })).toBeUndefined();
		});
	});
});

describe("EDIT_MODE_STRATEGIES.matcherEntries", () => {
	it("replace + patch return one (path, digest) entry from the top-level path", () => {
		expect(EDIT_MODE_STRATEGIES.replace.matcherEntries({ path: "src/foo.ts", new_string: "x = 1" })).toEqual([
			{ path: "src/foo.ts", digest: "x = 1" },
		]);
		expect(
			EDIT_MODE_STRATEGIES.patch.matcherEntries({ path: "src/bar.ts", edits: [{ op: "update", diff: "@@\n+y" }] }),
		).toEqual([{ path: "src/bar.ts", digest: "y" }]);
	});

	it("hashline splits multi-section payloads into one entry per file", () => {
		const input = [
			"[src/a.ts#ABCD]",
			"PUT 1-1:",
			"+const a = 1;",
			"[README.md#EF01]",
			"PUT 1-1:",
			"+# Heading",
			"[src/a.ts#1234]",
			"PUT 2-2:",
			"+const c = 3;",
			"",
		].join("\n");
		expect(EDIT_MODE_STRATEGIES.hashline.matcherEntries({ input })).toEqual([
			// Same-path sections are merged into one entry, preserving order.
			{ path: "src/a.ts", digest: "const a = 1;\nconst c = 3;" },
			{ path: "README.md", digest: "# Heading" },
		]);
	});

	it("apply_patch splits multi-hunk payloads into one entry per file", () => {
		const input = [
			"*** Begin Patch",
			"*** Update File: src/a.ts",
			"@@",
			"-foo",
			"+const a = 1;",
			"*** Update File: README.md",
			"@@",
			"-old",
			"+# Heading",
			"*** End Patch",
			"",
		].join("\n");
		const entries = EDIT_MODE_STRATEGIES.apply_patch.matcherEntries({ input });
		expect(entries).toEqual([
			{ path: "src/a.ts", digest: "const a = 1;" },
			{ path: "README.md", digest: "# Heading" },
		]);
	});

	it("returns undefined when no entries are recoverable yet", () => {
		expect(EDIT_MODE_STRATEGIES.hashline.matcherEntries({ input: "" })).toBeUndefined();
		expect(EDIT_MODE_STRATEGIES.apply_patch.matcherEntries({ input: "*** Begin Patch\n" })).toBeUndefined();
		expect(EDIT_MODE_STRATEGIES.replace.matcherEntries({})).toBeUndefined();
	});
});

/**
 * Integration: a hashline edit payload whose only path lives in the
 * `[demo.ts#TAG]` section header must trigger the bundled `ts-no-any` rule
 * — exactly the scenario the regression in #3646 was missing. The strategy
 * outputs feed `TtsrManager.checkSnapshot` the same way `AgentSession`'s
 * TTSR pipeline does after the fix.
 */
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

async function loadBundledTsNoAnyRule(): Promise<Rule> {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const load = provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>;
	const { items } = await load(ctx);
	const rule = items.find(r => r.name === "ts-no-any");
	if (!rule) throw new Error("bundled ts-no-any rule not registered");
	return rule;
}

describe("hashline edit + path-scoped TTSR (regression: #3646)", () => {
	const ANY = "any";
	// Snippet rendered at runtime to avoid tripping the rule on this test file itself.
	const VIOLATING_LINE = `export const value: ${ANY} = 1;`;
	const HASHLINE_PAYLOAD = `[demo.ts#ABCD]\nPUT 1-1:\n+${VIOLATING_LINE}\n`;

	async function makeManager(): Promise<TtsrManager> {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		const ok = manager.addRule(await loadBundledTsNoAnyRule());
		if (!ok) throw new Error("ts-no-any registered as no-op TTSR rule");
		return manager;
	}

	it("ts-no-any triggers when filePaths come from the hashline header", async () => {
		const manager = await makeManager();
		const args = { input: HASHLINE_PAYLOAD };

		const filePaths = EDIT_MODE_STRATEGIES.hashline.matcherPaths(args);
		const digest = EDIT_MODE_STRATEGIES.hashline.matcherDigest(args);
		expect(filePaths).toEqual(["demo.ts"]);
		expect(digest).toBe(VIOLATING_LINE);

		const matches = manager.checkSnapshot(digest as string, {
			source: "tool",
			toolName: "edit",
			filePaths: [...(filePaths as readonly string[])],
		});
		expect(matches.map(r => r.name)).toEqual(["ts-no-any"]);
	});

	it("ts-no-any does NOT trigger when filePaths are missing — the regression's pre-fix state", async () => {
		const manager = await makeManager();
		const args = { input: HASHLINE_PAYLOAD };
		const digest = EDIT_MODE_STRATEGIES.hashline.matcherDigest(args);

		const matches = manager.checkSnapshot(digest as string, {
			source: "tool",
			toolName: "edit",
			// filePaths intentionally omitted — pre-fix behavior.
		});
		expect(matches).toEqual([]);
	});

	it("multi-file hashline isolates a .md hunk's `: any` from a sibling .ts entry", async () => {
		// PR review (#3648): a multi-file payload that adds `: any` only to a
		// Markdown hunk MUST NOT trip the TS-only `tool:edit(*.ts)` rule. Per-file
		// matchers pair each path with its own digest.
		const manager = await makeManager();
		const input = [
			"[README.md#ABCD]",
			"PUT 1-1:",
			`+${VIOLATING_LINE}`,
			"[src/ok.ts#EF01]",
			"PUT 1-1:",
			"+export const ok = 1;",
			"",
		].join("\n");

		const entries = EDIT_MODE_STRATEGIES.hashline.matcherEntries({ input });
		expect(entries?.map(e => e.path)).toEqual(["README.md", "src/ok.ts"]);

		const allMatches: string[] = [];
		for (const entry of entries ?? []) {
			const matches = manager.checkSnapshot(entry.digest, {
				source: "tool",
				toolName: "edit",
				filePaths: [entry.path],
				streamKey: `toolcall:test#${entry.path}`,
			});
			allMatches.push(...matches.map(r => r.name));
		}
		expect(allMatches).toEqual([]);
	});

	it("multi-file hashline fires only on the .ts entry when the .ts entry carries `: any`", async () => {
		const manager = await makeManager();
		const input = [
			"[README.md#ABCD]",
			"PUT 1-1:",
			"+# Heading",
			"[src/bad.ts#EF01]",
			"PUT 1-1:",
			`+${VIOLATING_LINE}`,
			"",
		].join("\n");

		const entries = EDIT_MODE_STRATEGIES.hashline.matcherEntries({ input });
		const matchesByPath = new Map<string, string[]>();
		for (const entry of entries ?? []) {
			const matches = manager.checkSnapshot(entry.digest, {
				source: "tool",
				toolName: "edit",
				filePaths: [entry.path],
				streamKey: `toolcall:test2#${entry.path}`,
			});
			matchesByPath.set(
				entry.path,
				matches.map(r => r.name),
			);
		}
		expect(matchesByPath.get("README.md")).toEqual([]);
		expect(matchesByPath.get("src/bad.ts")).toEqual(["ts-no-any"]);
	});

	it("multi-file apply_patch isolates a .md hunk's `: any` from a sibling .ts hunk", async () => {
		const manager = await makeManager();
		const input = [
			"*** Begin Patch",
			"*** Update File: README.md",
			"@@",
			"-old",
			`+${VIOLATING_LINE}`,
			"*** Update File: src/ok.ts",
			"@@",
			"-old",
			"+export const ok = 1;",
			"*** End Patch",
			"",
		].join("\n");

		const entries = EDIT_MODE_STRATEGIES.apply_patch.matcherEntries({ input });
		const allMatches: string[] = [];
		for (const entry of entries ?? []) {
			const matches = manager.checkSnapshot(entry.digest, {
				source: "tool",
				toolName: "edit",
				filePaths: [entry.path],
				streamKey: `toolcall:test3#${entry.path}`,
			});
			allMatches.push(...matches.map(r => r.name));
		}
		expect(allMatches).toEqual([]);
	});
});
