import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The isolation path may not reach a filesystem API at all.
 *
 * Thirteen findings across six rounds were one mistake: a read that failed
 * became "nothing is there", and "nothing is there" authorised a delete. The
 * three-valued `Lookup` fixes a call site; keeping the unsafe call out of
 * reach is the stronger claim, and the one this pull request offers in place
 * of reviewing every new call site for ever.
 *
 * Three rounds of this check were written as lists of spellings and name
 * patterns, and a reviewer walked past each of them — an alias, a split line,
 * `import { file } from "bun"`, a helper one file away, a benign call sharing
 * a line with a read. So nothing here matches a line or a name: the module
 * graph is parsed, imports are resolved to specifiers, and the only thing a
 * module may do with the `Bun` global is not mention it.
 *
 * `isolation-lookup.ts` and `isolation-fs.ts` are the surface: the reads that
 * answer found | absent | unknown, and the writes that happen or raise.
 */
const ENTRY_POINTS = [
	"src/task/isolation-ownership.ts",
	"src/task/isolation-lease.ts",
	"src/task/isolation-runner.ts",
	"src/task/worktree.ts",
	"src/cli/worktree-cli.ts",
];

/** The two modules that may hold a filesystem import: the reads and the writes. */
const SURFACE = new Set(["src/task/isolation-lookup.ts", "src/task/isolation-fs.ts"]);

/**
 * Every way into the filesystem by import, including Bun's own module — which
 * exports `file` and `$`, and was not on the previous list.
 */
const FS_MODULES = new Set([
	"bun",
	"node:fs",
	"node:fs/promises",
	"fs",
	"fs/promises",
	"node:child_process",
	"child_process",
]);

/**
 * The boundary of this subsystem: modules the entry points already reach that
 * decide nothing about whether an isolation workspace may be deleted. The walk
 * stops here.
 *
 * Every other relative import is followed, so a helper extracted out of the
 * isolation path — under any name, in any directory — is still checked.
 */
const NOT_THIS_SUBSYSTEM = new Set([
	"src/config/registry.ts",
	"src/config/settings.ts",
	"src/registry/agent-registry.ts",
	"src/task/executor.ts",
	"src/task/settings.ts",
	"src/tools/index.ts",
	"src/utils/commit-message-generator.ts",
	"src/utils/late-cleanup.ts",
	"src/utils/release-hold.ts",
	"src/utils/repo-lock.ts",
]);

/**
 * Packages the isolation path may import, and nothing else. A read helper
 * added to a workspace package and called from here is invisible to a walk
 * that stops at package boundaries, so the boundary itself is pinned: a new
 * package here is a diff somebody defends.
 */
const ALLOWED_PACKAGES = new Set([
	"@oh-my-pi/pi-natives",
	"@oh-my-pi/pi-natives/vcs",
	"@oh-my-pi/pi-tui/tools/task",
	"@oh-my-pi/pi-tui/tools/tool-errors",
	"@oh-my-pi/pi-utils",
	"@oh-my-pi/pi-utils/chalk",
	"node:async_hooks",
	"node:os",
	"node:path",
	"node:timers/promises",
	"node:util",
]);

/**
 * Every named symbol this subsystem imports, from anywhere. Pinned, because a
 * helper that swallows an error is already a named export in this repository
 * — `directoryExists`, whose body is `catch { return false }` — and the walk
 * stops at the package boundary that holds it.
 */
const PINNED_SYMBOLS: string[] = [
	"@oh-my-pi/pi-natives:VcsCommitAuthor",
	"@oh-my-pi/pi-natives:VcsGitRepo",
	"@oh-my-pi/pi-tui/tools/task:NestedRepoPatch",
	"@oh-my-pi/pi-tui/tools/task:SingleResult",
	"@oh-my-pi/pi-utils:Snowflake",
	"@oh-my-pi/pi-utils:acquireFileLock",
	"@oh-my-pi/pi-utils:formatBytes",
	"@oh-my-pi/pi-utils:getWorktreeDir",
	"@oh-my-pi/pi-utils:getWorktreesDir",
	"@oh-my-pi/pi-utils:logger",
	"@oh-my-pi/pi-utils:prompt",
	"node:async_hooks:AsyncLocalStorage",
	"node:timers/promises:scheduler",
];

interface Graph {
	reachable: Set<string>;
	/** `file -> specifier` for every import of a filesystem module. */
	fsImports: string[];
	/** Non-relative specifiers imported anywhere in the subsystem. */
	packages: Set<string>;
}

/** Source with comments and string literals removed, so a mention is a real one. */
function code(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

async function walkIsolationGraph(root: string): Promise<Graph> {
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const reachable = new Set<string>();
	const fsImports: string[] = [];
	const packages = new Set<string>();
	const queue = [...ENTRY_POINTS];
	const resolve = async (from: string, specifier: string): Promise<string | undefined> => {
		if (!specifier.startsWith(".")) return undefined;
		const base = path.join(path.dirname(path.join(root, from)), specifier);
		// A `./helper.js` specifier is the TypeScript spelling of `helper.ts`,
		// and a real `.js` file is a module like any other: following only
		// `.ts` let a read sit one `.js` extension away.
		const withoutJs = base.replace(/\.js$/, "");
		for (const candidate of [`${withoutJs}.ts`, `${base}.ts`, path.join(base, "index.ts"), base, `${withoutJs}.js`]) {
			if (!candidate.endsWith(".ts") && !candidate.endsWith(".js")) continue;
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
		// Parsed, not matched: a split line, an aliased name and a dynamic
		// `import()` all arrive here as the same resolved specifier.
		for (const entry of transpiler.scan(source).imports) {
			const specifier = entry.path;
			if (!SURFACE.has(file) && FS_MODULES.has(specifier)) fsImports.push(`${file} -> ${specifier}`);
			if (!specifier.startsWith(".") && !SURFACE.has(file)) packages.add(specifier);
			const resolved = await resolve(file, specifier);
			if (resolved !== undefined && !NOT_THIS_SUBSYSTEM.has(resolved)) queue.push(resolved);
		}
	}
	return { reachable, fsImports, packages };
}

describe("the isolation path's filesystem surface", () => {
	it("imports no filesystem module anywhere it can reach", async () => {
		const root = path.resolve(import.meta.dir, "../..");

		const { fsImports } = await walkIsolationGraph(root);

		expect(fsImports.sort()).toEqual([]);
	});

	it("never mentions the `Bun` global outside the surface", async () => {
		// Not "no `Bun.file`", which three spellings walked past, and not a
		// per-line allowance, which `Bun.sleep(0); Bun.file(x)` defeated.
		// `hash` and `sleep` moved behind the surface so this can be absolute.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const offences: string[] = [];
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			const source = code(await fs.readFile(path.join(root, file), "utf8"));
			source.split("\n").forEach((line, index) => {
				if (/\bBun\b/.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}

		expect(offences.sort()).toEqual([]);
	});

	it("loads nothing through `require`, which an import graph cannot see", async () => {
		// `require('node:fs/promises')` is not an import and never appears in a
		// scan of them. This subsystem is ESM, so the rule is the module
		// system rather than the module: no `require` at all.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const offences: string[] = [];
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			const source = code(await fs.readFile(path.join(root, file), "utf8"));
			source.split("\n").forEach((line, index) => {
				if (/\b(require|createRequire)\s*\(/.test(line)) offences.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}

		expect(offences.sort()).toEqual([]);
	});

	it("takes a fixed set of named symbols from workspace packages", async () => {
		// The walk stops at package boundaries, so a read helper added to a
		// package and called from here is invisible to it — and one already
		// exists: `directoryExists`, whose body is `catch { return false }`.
		// The names are pinned, so importing it is a failing diff.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const named = new Set<string>();
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			// Comments removed but strings kept, so the specifier is readable,
			// and whole-file rather than per line, so a split import is one
			// match.
			const source = (await fs.readFile(path.join(root, file), "utf8"))
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
			for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
				const specifier = match[2] ?? "";
				if (specifier.startsWith(".")) continue;
				for (const name of (match[1] ?? "").split(",")) {
					const bare = name
						.replace(/\btype\b/, "")
						.split(" as ")[0]
						?.trim();
					if (bare) named.add(`${specifier}:${bare}`);
				}
			}
		}

		expect([...named].sort()).toEqual([...PINNED_SYMBOLS].sort());
	});

	it("loads nothing through a computed specifier, which a graph cannot resolve", async () => {
		// `await import(someExpression)` and `globalThis["B" + "un"]` are both
		// reads a parse of the graph cannot follow, so both are refused
		// outright rather than resolved.
		const root = path.resolve(import.meta.dir, "../..");
		const { reachable } = await walkIsolationGraph(root);
		const offences: string[] = [];
		for (const file of reachable) {
			if (SURFACE.has(file)) continue;
			const source = code(await fs.readFile(path.join(root, file), "utf8"));
			source.split("\n").forEach((line, index) => {
				if (/\bimport\s*\(\s*[^"'`)]/.test(line)) offences.push(`${file}:${index + 1}: computed import`);
				if (/\bglobalThis\s*\[/.test(line)) offences.push(`${file}:${index + 1}: computed global`);
			});
		}

		expect(offences.sort()).toEqual([]);
	});

	it("imports only from packages this subsystem is allowed to reach", async () => {
		// The walk stops at package boundaries, so the boundary is the claim:
		// every non-relative specifier in the whole reachable subsystem,
		// compared as a set rather than filtered by a name pattern.
		const root = path.resolve(import.meta.dir, "../..");

		const { packages } = await walkIsolationGraph(root);

		expect([...packages].filter(specifier => !ALLOWED_PACKAGES.has(specifier)).sort()).toEqual([]);
	});

	it("keeps three answers, with `unknown` carrying its reason", async () => {
		const source = await fs.readFile(path.resolve(import.meta.dir, "../../src/task/isolation-lookup.ts"), "utf8");

		expect(source).toContain('kind: "found"');
		expect(source).toContain('kind: "absent"');
		expect(source).toContain('kind: "unknown"');
		expect(source).toContain("isEnoent(error)");
	});
});
