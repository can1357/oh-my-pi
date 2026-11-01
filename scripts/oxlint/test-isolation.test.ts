import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

// oxlint's RuleTester refuses to run under Bun, so these tests lint fixture files with the real
// oxlint binary and the plugin exactly as `.oxlintrc.json` loads it.
const repoRoot = path.join(import.meta.dir, "../..");
const header = `import { afterEach, beforeEach, describe, it, mock, onTestFinished, spyOn, vi } from "bun:test";
import * as mod from "./mod";
`;

/** Fixture body (after the shared imports) and the diagnostics it must produce: `rule@line`. */
const cases: Record<string, { body: string; expected: string[] }> = {
	"restore-covered-by-file-hook": {
		body: `
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: [],
	},
	"restore-covered-by-describe-hook": {
		body: `
describe("d", () => {
	beforeEach(() => mock.restore());
	it("t", async () => {
		const spy = spyOn(console, "log");
		await Promise.resolve();
		spy.mockRestore();
	});
});`,
		expected: [],
	},
	"restore-covered-by-hook-calling-the-same-helper": {
		body: `
const spies: { mockRestore(): void }[] = [];
function restoreSpies() { for (const spy of spies.splice(0)) spy.mockRestore(); }
afterEach(() => restoreSpies());
it("t", async () => {
	spies.push(spyOn(console, "log"));
	await Promise.resolve();
	restoreSpies();
});`,
		expected: [],
	},
	"restore-in-finally-of-sync-test": {
		body: `
it("t", () => {
	const spy = spyOn(console, "log");
	try { console.log("x"); } finally { spy.mockRestore(); }
});`,
		expected: [],
	},
	"restore-with-no-suspension-while-installed": {
		body: `
it("t", async () => {
	await Promise.resolve();
	const spy = spyOn(console, "log");
	console.log("x");
	spy.mockRestore();
	await Promise.resolve();
});`,
		expected: [],
	},
	"restore-handed-to-a-cleanup-list": {
		body: `
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
it("t", async () => {
	const spy = spyOn(console, "log");
	cleanups.push(() => spy.mockRestore());
	await Promise.resolve();
});`,
		expected: [],
	},
	"restore-in-finally-of-async-test-without-hook": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"restore-under-sibling-describe-hook": {
		body: `
describe("a", () => { afterEach(() => { vi.restoreAllMocks(); }); });
describe("b", () => {
	it("t", async () => {
		const spy = spyOn(console, "log");
		await Promise.resolve();
		spy?.mockRestore();
	});
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"restore-all-in-async-body-under-hook": {
		body: `
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	spyOn(console, "log");
	try { await Promise.resolve(); } finally { vi.restoreAllMocks(); }
});`,
		expected: ["restore-mocks-in-hooks@7"],
	},
	"restore-in-same-file-helper": {
		body: `
async function withQuietLog(run: () => Promise<void>) {
	const spy = spyOn(console, "log");
	try { await run(); } finally { spy.mockRestore(); }
}
it("t", async () => { await withQuietLog(async () => {}); });`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"restore-after-assertions-in-sync-test": {
		body: `
it("t", () => {
	const spy = spyOn(console, "log");
	console.log("x");
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@7"],
	},
	"put-back-registered-with-on-test-finished": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: [],
	},
	"put-back-bracket-with-on-test-finished-backstop": {
		body: `
it("t", async () => {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	onTestFinished(() => { Object.defineProperty(process, "platform", original); });
	Object.defineProperty(process, "platform", { value: "win32" });
	try { await Promise.resolve(); } finally { Object.defineProperty(process, "platform", original); }
	await Promise.resolve();
});`,
		expected: [],
	},
	"put-back-covered-by-each-hook": {
		body: `
const original = process.title;
afterEach(() => { process.title = original; });
it("t", async () => {
	process.title = "x";
	try { await Promise.resolve(); } finally { process.title = original; }
});`,
		expected: [],
	},
	"put-back-without-suspension-while-replaced": {
		body: `
it("t", async () => {
	await Promise.resolve();
	const original = process.title;
	process.title = "x";
	try { void 0; } finally { process.title = original; }
});`,
		expected: [],
	},
	"put-back-of-test-local-object": {
		body: `
it("t", async () => {
	const state = { value: 1 };
	try { await Promise.resolve(); } finally { state.value = 0; }
});`,
		expected: [],
	},
	"put-back-of-environment-variable": {
		body: `
it("t", async () => {
	const saved = process.env.HOME;
	process.env.HOME = "/tmp";
	try { await Promise.resolve(); } finally { process.env.HOME = saved; }
});`,
		expected: [],
	},
	"put-back-of-global-function-in-finally": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"put-back-of-redefined-process-property": {
		body: `
it("t", async () => {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	try { await Promise.resolve(); } finally { Object.defineProperty(process, "platform", original); }
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"put-back-of-imported-module-method": {
		body: `
it("t", async () => {
	const original = mod.run;
	mod.run = async () => {};
	await Promise.resolve();
	mod.run = original;
});`,
		expected: ["put-back-on-test-finished@8"],
	},
};

interface Diagnostic {
	code: string;
	filename: string;
	labels: { span: { line: number } }[];
}

let dir = "";
const found = new Map<string, string[]>();

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-oxlint-test-isolation-"));
	await Bun.write(
		path.join(dir, ".oxlintrc.json"),
		JSON.stringify({
			jsPlugins: [path.join(repoRoot, "scripts/oxlint/test-isolation.ts")],
			categories: { correctness: "off" },
			rules: { "omp-test/restore-mocks-in-hooks": "error", "omp-test/put-back-on-test-finished": "error" },
		}),
	);
	for (const [name, { body }] of Object.entries(cases))
		await Bun.write(path.join(dir, `${name}.test.ts`), header + body);
	const oxlint = path.join(repoRoot, "node_modules/oxlint/bin/oxlint");
	const result = await $`${process.execPath} ${oxlint} -c .oxlintrc.json --format json .`.cwd(dir).quiet().nothrow();
	const report = JSON.parse(result.stdout.toString()) as { diagnostics: Diagnostic[] };
	for (const diagnostic of report.diagnostics) {
		const name = path.basename(diagnostic.filename, ".test.ts");
		const rule = diagnostic.code.replace(/^omp-test\((.*)\)$/, "$1");
		found.set(name, [...(found.get(name) ?? []), `${rule}@${diagnostic.labels[0]?.span.line}`]);
	}
}, 120_000);

afterAll(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("omp-test oxlint rules", () => {
	for (const [name, { expected }] of Object.entries(cases)) {
		it(name, () => {
			expect((found.get(name) ?? []).sort()).toEqual(expected);
		});
	}
});
