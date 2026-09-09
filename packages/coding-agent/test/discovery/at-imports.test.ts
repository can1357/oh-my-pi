import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { expandAtImports, MAX_AT_IMPORT_DEPTH } from "@oh-my-pi/pi-coding-agent/discovery/at-imports";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Behavior contract for the @-import expander used by every AGENTS.md /
 * CLAUDE.md / GEMINI.md loader. Each test names one externally-observable
 * promise — relative-resolution, code-block opacity, cycle/depth caps, etc.
 */
describe("expandAtImports", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-at-import-"));
	});

	afterEach(async () => {
		clearFsCache();
		await removeWithRetries(tmp);
	});

	const writeFile = async (relPath: string, content: string): Promise<string> => {
		const abs = path.join(tmp, relPath);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
		return abs;
	};

	test("inlines the entire referenced file when the line is just @path", async () => {
		// User's reported case from issue #2111 — CLAUDE.md with body `@AGENTS.md`.
		const agents = await writeFile("AGENTS.md", "ALWAYS use uppercase letters.");
		const claude = await writeFile("CLAUDE.md", "@AGENTS.md\n");

		const expanded = await expandAtImports(await fs.readFile(claude, "utf8"), claude);

		expect(expanded.trim()).toBe("ALWAYS use uppercase letters.");
		// Sanity: the actual file path resolved was the sibling, not anything else.
		expect(await fs.readFile(agents, "utf8")).toBe("ALWAYS use uppercase letters.");
	});

	test("resolves relative paths against the importing file's directory, not cwd", async () => {
		// Importing file lives in a subdir; the @-import must look for the
		// target alongside the importer, not in process.cwd().
		await writeFile("rules/no-push.md", "NEVER push.");
		const agentsPath = await writeFile("rules/AGENTS.md", "Rule: @./no-push.md\n");

		const expanded = await expandAtImports("Rule: @./no-push.md\n", agentsPath);

		expect(expanded).toContain("Rule: NEVER push.");
		expect(expanded).not.toContain("@./no-push.md");
	});

	test("resolves ~/path against the home override", async () => {
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-at-home-"));
		try {
			await fs.writeFile(path.join(fakeHome, "prefs.md"), "use 2 spaces");
			const expanded = await expandAtImports("See @~/prefs.md.\n", path.join(tmp, "AGENTS.md"), {
				home: fakeHome,
			});
			expect(expanded).toContain("See use 2 spaces");
		} finally {
			await removeWithRetries(fakeHome);
		}
	});

	test("nests imports recursively", async () => {
		await writeFile("c.md", "LEAF.");
		await writeFile("b.md", "B then @c.md\n");
		const a = await writeFile("a.md", "A then @b.md\n");

		const expanded = await expandAtImports(await fs.readFile(a, "utf8"), a);

		expect(expanded).toContain("A then B then LEAF.");
	});

	test("caps recursion at MAX_AT_IMPORT_DEPTH hops", async () => {
		// Build a chain longer than the depth cap. At depth=MAX, expand()
		// short-circuits before resolving the file's own @-imports, so the
		// content at that depth is included verbatim and the import token
		// inside it (`@step${MAX+1}.md`) survives unexpanded.
		const total = MAX_AT_IMPORT_DEPTH + 2;
		for (let i = 0; i < total; i++) {
			const body = i === total - 1 ? "TERMINAL" : `step-${i} -> @step${i + 1}.md`;
			await writeFile(`step${i}.md`, `${body}\n`);
		}
		const entry = path.join(tmp, "step0.md");
		const expanded = await expandAtImports(await fs.readFile(entry, "utf8"), entry);
		expect(expanded).toContain(`@step${MAX_AT_IMPORT_DEPTH + 1}.md`);
		expect(expanded).not.toContain("TERMINAL");
	});

	test("breaks cycles silently", async () => {
		// `@` must follow whitespace or start-of-line to count as an import,
		// so the loop bodies use a space before each reference.
		const a = await writeFile("loop-a.md", "A: @loop-b.md\n");
		await writeFile("loop-b.md", "B: @loop-a.md\n");

		const expanded = await expandAtImports(await fs.readFile(a, "utf8"), a);

		// The second hop sees the original importer in `visited` and bails,
		// leaving its literal @-token but emitting all earlier text.
		expect(expanded).toContain("A: B:");
		expect(expanded).toContain("@loop-a.md");
	});

	test("leaves the original token untouched when the file is missing", async () => {
		const source = path.join(tmp, "AGENTS.md");
		const expanded = await expandAtImports("See @./does-not-exist.md\n", source);
		expect(expanded).toContain("@./does-not-exist.md");
	});

	test("does not expand inside fenced code blocks", async () => {
		await writeFile("guide.md", "INLINED");
		const source = path.join(tmp, "AGENTS.md");
		const input = ["Run this:", "```bash", "echo @./guide.md", "```", "Also see @./guide.md."].join("\n");

		const expanded = await expandAtImports(input, source);

		// Inside the fence the @-token is preserved verbatim.
		expect(expanded).toContain("echo @./guide.md");
		// Outside the fence it expands.
		expect(expanded).toContain("Also see INLINED");
	});

	test("does not expand inside inline code spans", async () => {
		await writeFile("guide.md", "INLINED");
		const source = path.join(tmp, "AGENTS.md");
		const input = "Install via `npm i @./guide.md` and also @./guide.md.\n";

		const expanded = await expandAtImports(input, source);

		expect(expanded).toContain("`npm i @./guide.md`");
		expect(expanded).toContain("also INLINED");
	});

	test("ignores @ embedded mid-token like emails and SSH URLs", async () => {
		// Guard against false positives that would otherwise spam debug logs
		// or worse, leak filesystem reads triggered by user-supplied text.
		await writeFile("guide.md", "INLINED");
		const source = path.join(tmp, "AGENTS.md");
		const input = "Ping me at me@example.com or use git@github.com:foo/bar.git for clones.\n";

		const expanded = await expandAtImports(input, source);

		expect(expanded).toBe(input);
	});

	test("strips trailing sentence punctuation from the path", async () => {
		// The trailing comma/period is sentence grammar, not part of the filename.
		await writeFile("guide.md", "INLINED");
		const source = path.join(tmp, "AGENTS.md");
		const input = "See @./guide.md, and then continue.\n";

		const expanded = await expandAtImports(input, source);

		expect(expanded).toContain("See INLINED, and then continue.");
	});
});
