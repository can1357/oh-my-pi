import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The isolation path may not reach a filesystem API at all.
 *
 * Twelve findings across five rounds were one mistake: a read that failed
 * became "nothing is there", and "nothing is there" authorised a delete. The
 * three-valued `Lookup` fixes a call site; this keeps the unsafe call out of
 * reach, which is a different and stronger claim.
 *
 * It is asked of the **module graph**, not of the text: a scan for call
 * spellings is a lint rule for the shapes somebody happened to think of, and
 * an alias, a line break, a `Bun.file().stat()` or a helper extracted into a
 * sixth file walks straight past it. What a module imports is parsed here, and
 * the walk follows relative imports, so moving the read into a new file moves
 * the failure with it.
 *
 * `isolation-lookup.ts` is the one module allowed to import a filesystem API:
 * it is where an error becomes a value.
 */
const ENTRY_POINTS = [
	"src/task/isolation-ownership.ts",
	"src/task/isolation-lease.ts",
	"src/task/isolation-runner.ts",
	"src/task/worktree.ts",
	"src/cli/worktree-cli.ts",
];

/** The two modules that may hold a raw filesystem import: the reads and the writes. */
const SURFACE = new Set(["src/task/isolation-lookup.ts", "src/task/isolation-fs.ts"]);

/**
 * The boundary of this subsystem: modules the entry points already reach that
 * decide nothing about whether an isolation workspace may be deleted. The walk
 * stops here.
 *
 * Every other relative import is followed, so a helper extracted out of the
 * isolation path — under any name, in any directory — is still checked, and
 * exempting it means adding a line to this list, which is a visible diff and a
 * claim somebody has to defend.
 */
const NOT_THIS_SUBSYSTEM = new Set([
	"src/config/registry.ts",
	"src/config/settings.ts",
	"src/registry/agent-registry.ts",
	"src/task/executor.ts",
	"src/task/parallel.ts",
	"src/task/settings.ts",
	"src/tools/index.ts",
	"src/utils/commit-message-generator.ts",
	"src/utils/late-cleanup.ts",
	"src/utils/release-hold.ts",
	"src/utils/repo-lock.ts",
]);

/**
 * Every filesystem module, `node:fs` included.
 *
 * Allowing `node:fs` for `watch` was a bypass one identifier wide: it
 * re-exports the same `promises` object and every `*Sync` read. `watch` now
 * lives behind the surface, so nothing here needs it.
 */
const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises", "node:fs/promises/index"]);

interface Graph {
	/** Files reachable from the entry points by relative import. */
	reachable: Set<string>;
	/** Reachable files that import a filesystem module directly. */
	fsImporters: string[];
}

async function walkIsolationGraph(root: string): Promise<Graph> {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const reachable = new Set<string>();
	const fsImporters: string[] = [];
	const queue = [...ENTRY_POINTS];
	const resolve = async (from: string, specifier: string): Promise<string | undefined> => {
		if (!specifier.startsWith(".")) return undefined;
		const base = path.join(path.dirname(path.join(root, from)), specifier);
		// TypeScript only: a `.md` prompt imported `with { type: "text" }` is
		// data, not a module, and parsing it as code says nothing.
		for (const candidate of [`${base}.ts`, path.join(base, "index.ts"), base]) {
			if (!candidate.endsWith(".ts")) continue;
			if (await Bun.file(candidate).exists()) return path.relative(root, candidate);
		}
		return undefined;
	};
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || reachable.has(file)) continue;
		reachable.add(file);
		const source = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
		if (source === "") continue;
		const imports = transpiler.scan(source).imports.map(entry => entry.path);
		if (imports.some(specifier => FS_MODULES.has(specifier))) fsImporters.push(file);
		for (const specifier of imports) {
			const resolved = await resolve(file, specifier);
			if (resolved !== undefined && !NOT_THIS_SUBSYSTEM.has(resolved)) queue.push(resolved);
		}
	}
	return { reachable, fsImporters };
}

describe("the isolation path's filesystem surface", () => {
	it("reaches no filesystem API except through the lookup module", async () => {
		const root = path.resolve(import.meta.dir, "../..");

		const { fsImporters } = await walkIsolationGraph(root);

		expect(fsImporters.filter(file => !SURFACE.has(file)).sort()).toEqual([]);
	});

	it("names no `Bun` API that reads the filesystem, however it is spelled", async () => {
		// The other door in. Matching `Bun.file` by line let `const runtime =
		// Bun; runtime.file(…)` and `new Bun.Glob("*").scan(…)` through, so
		// the reference itself is what is checked: any mention of the `Bun`
		// global outside the allowed list below. Those are the ones that do
		// not read a path.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const ALLOWED = /\bBun\s*\.\s*(hash|sleep|nanoseconds|which|version|revision)\b/;
		const offences: string[] = [];
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			const source = await fs.readFile(path.join(root, file), "utf8");
			source.split("\n").forEach((line, index) => {
				const code = line.trimStart();
				if (code.startsWith("*") || code.startsWith("//")) return;
				if (!/\bBun\b/.test(line)) return;
				if (ALLOWED.test(line)) return;
				offences.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}

		expect(offences).toEqual([]);
	});

	it("imports a fixed set of symbols from the workspace packages", async () => {
		// The walk follows relative imports; it does not enter
		// `@oh-my-pi/pi-utils`, whose file APIs serve the whole repository and
		// are not isolation decisions. That leaves one route a reviewer found:
		// add a reading helper there and call it from here. So the symbols
		// these modules take from workspace packages are pinned, and a new one
		// has to be added to this list — which is a diff somebody defends,
		// not a silent import.
		const root = path.resolve(import.meta.dir, "../..");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const seen = new Set<string>();
		for (const file of ENTRY_POINTS) {
			const source = await fs.readFile(path.join(root, file), "utf8");
			for (const line of source.split("\n")) {
				const match = /^import\s+(?:type\s+)?\{?([^}]*)\}?\s+from\s+"(@oh-my-pi\/[^"]+)"/.exec(line.trim());
				if (match) for (const name of match[1].split(",")) seen.add(`${match[2]}:${name.trim()}`);
			}
			// Parsed as well as scanned, so a multiline import is counted.
			for (const entry of transpiler.scan(source).imports) {
				if (entry.path.startsWith("@oh-my-pi/")) seen.add(`package:${entry.path}`);
			}
		}

		// Pinned: three names that take a path and return one, and no reader.
		expect([...seen].filter(name => /lookup|read|stat|file|dir/i.test(name)).sort()).toEqual([
			"@oh-my-pi/pi-utils:acquireFileLock",
			"@oh-my-pi/pi-utils:getWorktreeDir",
			"@oh-my-pi/pi-utils:getWorktreesDir",
		]);
	});

	it("keeps three answers, with `unknown` carrying its reason", async () => {
		const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/task/isolation-lookup.ts"), "utf8");

		// A two-valued helper added here would put the subsystem back where it
		// started, with every caller inheriting the collapse.
		expect(source).toContain('kind: "found"');
		expect(source).toContain('kind: "absent"');
		expect(source).toContain('kind: "unknown"');
		expect(source).toContain("isEnoent(error)");
	});
});
