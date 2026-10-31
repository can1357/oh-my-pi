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

const FS_MODULES = new Set(["node:fs/promises", "fs/promises"]);

/**
 * `node:fs`'s `watch` is a notification channel, not a read: it answers
 * "something changed", never "nothing is there". Importing it is allowed; its
 * promise-based reads are what `FS_MODULES` keeps out.
 */

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

	it("reaches no `Bun` file API either", async () => {
		// The other door into the filesystem, and the one `Bun.file().stat()`
		// came through. `Bun.write` is a write and is allowed; a read is not.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const offences: string[] = [];
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			const source = await fs.readFile(path.join(root, file), "utf8");
			source.split("\n").forEach((line, index) => {
				const code = line.trimStart();
				if (code.startsWith("*") || code.startsWith("//")) return;
				if (/\bBun\s*\.\s*file\b/.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}

		expect(offences).toEqual([]);
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
