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
	"describe-before-each-restore-does-not-cover": {
		body: `
describe("d", () => {
	beforeEach(() => mock.restore());
	it("t", async () => {
		const spy = spyOn(console, "log");
		await Promise.resolve();
		spy.mockRestore();
	});
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"restore-through-a-hook-that-calls-a-helper": {
		body: `
const spies: { mockRestore(): void }[] = [];
function restoreSpies() { for (const spy of spies.splice(0)) spy.mockRestore(); }
afterEach(() => restoreSpies());
it("t", async () => {
	spies.push(spyOn(console, "log"));
	await Promise.resolve();
	restoreSpies();
});`,
		expected: ["restore-mocks-in-hooks@5"],
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
	"put-back-registered-after-an-await-that-follows-the-write": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"put-back-registered-after-the-write-but-before-any-await": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	onTestFinished(() => { globalThis.fetch = original; });
	await Promise.resolve();
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"deleted-global-put-back-registered-after-an-await": {
		body: `
it("t", async () => {
	const saved = globalThis.__ompProbe;
	delete globalThis.__ompProbe;
	await Promise.resolve();
	onTestFinished(() => { globalThis.__ompProbe = saved; });
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"in-body-put-back-with-late-registration": {
		body: `
it("t", async () => {
	const original = process.title;
	process.title = "x";
	await Promise.resolve();
	onTestFinished(() => { process.title = original; });
	process.title = original;
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"put-back-registered-after-a-loop-that-awaits-before-the-write": {
		body: `
it("t", async () => {
	const original = Date.now;
	for (const at of [1, 2]) {
		await Promise.resolve();
		Date.now = () => at;
	}
	onTestFinished(() => { Date.now = original; });
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"put-back-registered-by-a-helper-after-its-await": {
		body: `
async function restoreFetchLater(original: typeof fetch) {
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
}
it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await restoreFetchLater(original);
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"put-back-registered-by-a-helper-before-the-write": {
		body: `
function restoreFetch(original: typeof fetch) {
	onTestFinished(() => { globalThis.fetch = original; });
}
it("t", async () => {
	const original = globalThis.fetch;
	restoreFetch(original);
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"put-back-registered-in-a-then-callback": {
		body: `
it("t", async () => {
	const original = Math.random;
	Math.random = () => 0;
	await Promise.resolve().then(() => onTestFinished(() => { Math.random = original; }));
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"put-back-with-object-assign-in-finally": {
		body: `
it("t", async () => {
	const saved = { fetch: globalThis.fetch };
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { Object.assign(globalThis, saved); }
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"object-assign-put-back-registered-with-on-test-finished": {
		body: `
it("t", async () => {
	const saved = { fetch: globalThis.fetch };
	onTestFinished(() => { Object.assign(globalThis, saved); });
	Object.assign(globalThis, { fetch: (async () => new Response("")) as unknown as typeof fetch });
	await Promise.resolve();
});`,
		expected: [],
	},
	"put-back-with-reflect-set-after-await": {
		body: `
it("t", async () => {
	const original = Reflect.get(process, "title");
	Reflect.set(process, "title", "x");
	await Promise.resolve();
	Reflect.set(process, "title", original);
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"put-back-with-reflect-delete-property-after-await": {
		body: `
it("t", async () => {
	Reflect.set(globalThis, "__ompProbe", 1);
	await Promise.resolve();
	Reflect.deleteProperty(globalThis, "__ompProbe");
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"put-back-of-destructured-globals-after-await": {
		body: `
it("t", async () => {
	const original = [Math.random, Date.now] as const;
	[Math.random, Date.now] = [() => 0, () => 0];
	await Promise.resolve();
	[Math.random, Date.now] = original;
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"spy-restore-registered-after-an-await": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@5"],
	},
	"spy-restore-registered-before-any-await": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	onTestFinished(() => spy.mockRestore());
	await Promise.resolve();
});`,
		expected: [],
	},
	"restore-all-registered-after-an-await-that-follows-a-spy": {
		body: `
it("t", async () => {
	spyOn(console, "log");
	await Promise.resolve();
	onTestFinished(() => vi.restoreAllMocks());
});`,
		expected: ["restore-mocks-in-hooks@5"],
	},
	"put-back-through-a-const-alias-of-globalThis": {
		body: `
it("t", async () => {
	const g = globalThis;
	const original = g.fetch;
	g.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	onTestFinished(() => { g.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"put-back-through-an-alias-of-an-imported-module": {
		body: `
it("t", async () => {
	const m = mod;
	const original = m.run;
	m.run = async () => {};
	await Promise.resolve();
	onTestFinished(() => { m.run = original; });
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"define-property-through-a-const-alias": {
		body: `
it("t", async () => {
	const define = Object.defineProperty;
	const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
	define(process, "platform", { value: "win32" });
	await Promise.resolve();
	onTestFinished(() => { Object.defineProperty(process, "platform", saved); });
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"spy-installed-through-an-aliased-spy-on": {
		body: `
const watch = vi.spyOn;
it("t", async () => {
	const spy = watch(console, "log");
	await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"update-expression-registered-after-an-await": {
		body: `
it("t", async () => {
	const original = process.exitCode;
	process.exitCode++;
	await Promise.resolve();
	onTestFinished(() => { process.exitCode = original; });
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"update-expression-registered-before-the-write": {
		body: `
it("t", async () => {
	const original = process.exitCode;
	onTestFinished(() => { process.exitCode = original; });
	process.exitCode++;
	await Promise.resolve();
});`,
		expected: [],
	},
	"for-of-assignment-target-registered-after-an-await": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	for (globalThis.fetch of [original]) {}
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"promise-returning-test-registers-in-a-then-callback": {
		body: `
it("t", () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	return Promise.resolve().then(() => {
		onTestFinished(() => { globalThis.fetch = original; });
	});
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"promise-returning-test-registers-before-returning": {
		body: `
it("t", () => {
	const original = globalThis.fetch;
	onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	return Promise.resolve();
});`,
		expected: [],
	},
	"namespace-imported-test-api": {
		body: `
import * as bt from "bun:test";
bt.it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	bt.onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"helper-writing-the-shared-object-it-is-given": {
		body: `
function install(target: typeof globalThis) {
	target.fetch = (async () => new Response("")) as unknown as typeof fetch;
}
it("t", async () => {
	const original = globalThis.fetch;
	install(globalThis);
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@5"],
	},
	"returned-cleanup-method-called-after-an-await": {
		body: `
function install() {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	return {
		restore() {
			globalThis.fetch = original;
		},
	};
}
it("t", async () => {
	const patch = install();
	try {
		await Promise.resolve();
	} finally {
		patch.restore();
	}
});`,
		expected: ["put-back-on-test-finished@9"],
	},
	"returned-cleanup-method-registered-with-on-test-finished": {
		body: `
function install() {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	return {
		restore() {
			globalThis.fetch = original;
		},
	};
}
it("t", async () => {
	const patch = install();
	onTestFinished(() => patch.restore());
	await Promise.resolve();
});`,
		expected: [],
	},
	"spy-assigned-to-a-let-registered-after-an-await": {
		body: `
it("t", async () => {
	let spy: { mockRestore(): void };
	spy = spyOn(console, "log");
	await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"awaited-spy-installation-registered-after-the-await": {
		body: `
it("t", async () => {
	const spy = await spyOn(console, "log");
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@5"],
	},
	"conditional-early-registration-does-not-cover-a-late-one": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	if (process.platform === "win32") onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"async-hook-that-awaits-before-its-put-back-does-not-cover": {
		body: `
const original = globalThis.fetch;
afterEach(async () => {
	await Promise.resolve();
	globalThis.fetch = original;
});
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	onTestFinished(() => { globalThis.fetch = original; });
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"async-hook-that-awaits-before-restoring-all-does-not-cover": {
		body: `
afterEach(async () => {
	await Promise.resolve();
	vi.restoreAllMocks();
});
it("t", async () => {
	const spy = spyOn(console, "log");
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@11"],
	},
	"helper-registered-finisher-is-not-structural": {
		body: `
function finish(original: typeof fetch) {
	onTestFinished(() => { globalThis.fetch = original; });
}
it("t", async () => {
	const original = globalThis.fetch;
	finish(original);
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"async-finisher-is-not-structural": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(async () => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"destructured-spy-alias-registered-late": {
		body: `
const { spyOn: watch } = vi;
it("t", async () => {
	const spy = watch(console, "log");
	await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"shared-helper-covers-an-in-body-restore": {
		body: `
import { installMockRestores } from "./helpers/mock-restores";
installMockRestores();
it("t", async () => {
	const spy = spyOn(console, "log");
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: [],
	},
	"conditionally-installed-helper-does-not-cover": {
		body: `
import { installMockRestores } from "./helpers/mock-restores";
if (process.env.CI) installMockRestores();
it("t", async () => {
	const spy = spyOn(console, "log");
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"hook-calling-an-async-helper-does-not-cover": {
		body: `
const original = globalThis.fetch;
async function cleanup() { await Promise.resolve(); globalThis.fetch = original; }
afterEach(() => cleanup());
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@9"],
	},
	"conditional-hook-restore-does-not-cover": {
		body: `
afterEach(() => { if (process.env.CI) vi.restoreAllMocks(); });
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@7"],
	},
	"hook-put-back-split-across-branches-does-not-cover": {
		body: `
const saved = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	if (saved) Object.defineProperty(process, "platform", saved);
	else Reflect.deleteProperty(process, "platform");
});
it("t", async () => {
	Object.defineProperty(process, "platform", { value: "win32" });
	try { await Promise.resolve(); } finally { if (saved) Object.defineProperty(process, "platform", saved); }
});`,
		expected: ["put-back-on-test-finished@11"],
	},
	"registration-on-the-opposite-branch-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	if (process.env.CI) {
		onTestFinished(() => { globalThis.fetch = original; });
	} else {
		globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
		await Promise.resolve();
		onTestFinished(() => { globalThis.fetch = original; });
	}
});`,
		expected: ["put-back-on-test-finished@9"],
	},
	"registration-on-the-same-branch-covers": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	if (process.env.CI) {
		onTestFinished(() => { globalThis.fetch = original; });
		globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
		await Promise.resolve();
	}
});`,
		expected: [],
	},
	"registration-in-a-loop-body-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	for (const _ of []) onTestFinished(() => { globalThis.fetch = original; });
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: ["put-back-on-test-finished@6"],
	},
	"a-shadowing-local-helper-is-not-the-outer-one": {
		body: `
const original = globalThis.fetch;
function cleanup() { globalThis.fetch = original; }
describe("d", () => {
	function cleanup() { return 1; }
	it("t", async () => {
		await Promise.resolve();
		cleanup();
	});
});`,
		expected: [],
	},
	"a-hook-calling-a-shadowing-local-helper-does-not-cover": {
		body: `
const original = globalThis.fetch;
function cleanup() { globalThis.fetch = original; }
afterEach(() => { function cleanup() {} cleanup(); });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	cleanup();
});`,
		expected: ["put-back-on-test-finished@5"],
	},
	"named-finisher-split-across-branches-does-not-cover": {
		body: `
it("t", async () => {
	const saved = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const restore = () => {
		if (saved) Object.defineProperty(process.stdout, "isTTY", saved);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	};
	onTestFinished(restore);
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	try { await Promise.resolve(); } finally { restore(); }
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"unknown-key-finisher-does-not-cover-fetch": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	const key = "other";
	onTestFinished(() => { globalThis[key] = undefined; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"constant-key-finisher-covers-fetch": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	const key = "fetch";
	onTestFinished(() => { globalThis[key] = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: [],
	},
	"redundant-late-finisher-after-an-early-finisher": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	onTestFinished(() => spy.mockRestore());
	await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: [],
	},
	"helper-call-inside-a-logical-expression-does-not-cover": {
		body: `
import { installMockRestores } from "./helpers/mock-restores";
process.env.CI && installMockRestores();
it("t", async () => {
	const spy = spyOn(console, "log");
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"hook-registered-inside-a-logical-expression-does-not-cover": {
		body: `
process.env.CI && afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@7"],
	},
	"expression-bodied-after-each-restore-covers": {
		body: `
afterEach(() => vi.restoreAllMocks());
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: [],
	},
	"put-back-finisher-inside-a-logical-expression-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	process.env.CI && onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"spy-finisher-inside-a-logical-expression-does-not-cover": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	process.env.CI && onTestFinished(() => spy.mockRestore());
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@5", "restore-mocks-in-hooks@8"],
	},
	"early-return-in-a-hook-before-its-restore-does-not-cover": {
		body: `
afterEach(() => {
	if (process.env.CI) return;
	vi.restoreAllMocks();
});
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@10"],
	},
	"hook-restore-before-an-early-return-covers": {
		body: `
afterEach(() => {
	vi.restoreAllMocks();
	if (process.env.CI) return;
	console.log("done");
});
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: [],
	},
	"early-return-in-a-finisher-before-its-put-back-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(() => {
		if (process.env.CI) return;
		globalThis.fetch = original;
	});
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: ["put-back-on-test-finished@10"],
	},
	"finisher-put-back-before-an-early-return-covers": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(() => {
		globalThis.fetch = original;
		if (process.env.CI) return;
		console.log("done");
	});
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: [],
	},
	"early-return-before-the-registration-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	if (!original) return;
	onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
	globalThis.fetch = original;
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"await-in-the-install-statement-does-not-cover": {
		body: `
let spy: { mockRestore(): void };
it("t", async () => {
	spy = spyOn(console, "log"), await Promise.resolve();
	onTestFinished(() => spy.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"after-all-put-back-does-not-cover-between-tests": {
		body: `
const original = globalThis.fetch;
afterAll(() => { globalThis.fetch = original; });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"before-each-put-back-does-not-cover-between-tests": {
		body: `
const original = globalThis.fetch;
beforeEach(() => { globalThis.fetch = original; });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"describe-after-each-restore-covers": {
		body: `
describe("d", () => {
	afterEach(() => vi.restoreAllMocks());
	it("t", async () => {
		const spy = spyOn(console, "log");
		await Promise.resolve();
		spy.mockRestore();
	});
});`,
		expected: [],
	},
	"reassigned-let-callback-does-not-cover": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	let cleanup = () => { spy.mockRestore(); };
	cleanup = () => {};
	onTestFinished(cleanup);
	await Promise.resolve();
	spy.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@10"],
	},
	"function-declaration-callback-covers": {
		body: `
it("t", async () => {
	const spy = spyOn(console, "log");
	onTestFinished(cleanup);
	await Promise.resolve();
	spy.mockRestore();
	function cleanup() { spy.mockRestore(); }
});`,
		expected: [],
	},
	"restore-all-look-alike-in-a-hook-does-not-cover": {
		body: `
const fake = { restoreAllMocks() {} };
afterEach(() => { fake.restoreAllMocks(); });
it("t", async () => {
	const spy = spyOn(console, "log");
	try { await Promise.resolve(); } finally { spy.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"restore-all-through-a-same-file-helper-in-an-async-body": {
		body: `
function resetMocks() { vi.restoreAllMocks(); }
it("t", async () => {
	spyOn(console, "log");
	await Promise.resolve();
	resetMocks();
});`,
		expected: ["restore-mocks-in-hooks@4"],
	},
	"restore-all-through-a-same-file-helper-in-a-covered-sync-body": {
		body: `
function resetMocks() { vi.restoreAllMocks(); }
afterEach(() => { vi.restoreAllMocks(); });
it("t", () => {
	spyOn(console, "log");
	resetMocks();
});`,
		expected: [],
	},
	"spy-variable-written-twice-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s = spyOn(Date, "now").mockReturnValue(12345);
	onTestFinished(() => s.mockRestore());
	s = spyOn(Math, "random").mockReturnValue(0.5);
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@10", "restore-mocks-in-hooks@5", "restore-mocks-in-hooks@7"],
	},
	"spy-variable-assigned-once-after-declaration-covers": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	s = spyOn(Date, "now").mockReturnValue(12345);
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"let-spy-never-reassigned-covers": {
		body: `
it("t", async () => {
	let s = spyOn(Date, "now").mockReturnValue(12345);
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"reassigned-function-declaration-finisher-does-not-cover": {
		body: `
it("t", async () => {
	function cleanup() { s.mockRestore(); }
	cleanup = () => {};
	const s = spyOn(Date, "now").mockReturnValue(12345);
	onTestFinished(cleanup);
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@10", "restore-mocks-in-hooks@7"],
	},
	"reassigned-function-declaration-hook-does-not-cover": {
		body: `
function cleanup() { vi.restoreAllMocks(); }
cleanup = () => {};
afterEach(cleanup);
it("t", async () => {
	const s = spyOn(Date, "now").mockReturnValue(12345);
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"function-declaration-hook-covers": {
		body: `
function cleanup() { vi.restoreAllMocks(); }
afterEach(cleanup);
it("t", async () => {
	const s = spyOn(Date, "now").mockReturnValue(12345);
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: [],
	},
	"var-spy-declared-in-a-loop-earns-no-individual-credit": {
		body: `
it("t", async () => {
	for (const key of ["log", "warn"] as const) {
		var s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	}
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@10", "restore-mocks-in-hooks@6"],
	},
	"outer-let-spy-assigned-in-a-loop-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	for (const key of ["log", "warn"] as const) {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	}
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@11", "restore-mocks-in-hooks@7"],
	},
	"outer-let-spy-assigned-in-a-foreach-callback-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	(["log", "warn"] as const).forEach(key => {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	});
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@11"],
	},
	"outer-let-spy-assigned-by-a-helper-called-twice-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	}
	install("log");
	install("warn");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@13", "restore-mocks-in-hooks@7"],
	},
	"outer-let-spy-assigned-by-a-helper-called-once-covers": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	function install() {
		s = spyOn(Date, "now").mockReturnValue(12);
		onTestFinished(() => s.mockRestore());
	}
	install();
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: [],
	},
	"helper-called-once-and-passed-to-foreach-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	}
	install("log");
	(["warn"] as const).forEach(install);
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@13", "restore-mocks-in-hooks@7"],
	},
	"per-iteration-const-spy-with-its-own-finisher-covers": {
		body: `
it("t", async () => {
	for (const key of ["log", "warn"] as const) {
		const s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		await Promise.resolve();
		s.mockRestore();
	}
});`,
		expected: [],
	},
	"named-iife-calling-itself-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	(function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		if (key === "log") install("warn");
	})("log");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@12", "restore-mocks-in-hooks@7"],
	},
	"named-iife-run-once-covers": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	(function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	})("log");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: [],
	},
	"iife-returning-itself-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	const again = (function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		return install;
	})("log");
	again("warn");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@13", "restore-mocks-in-hooks@7"],
	},
	"generator-iife-calling-itself-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	const iter = (function* install(key: "log" | "warn"): Generator<never, void> {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		if (key === "log") yield* install("warn");
	})("log");
	iter.next();
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@13", "restore-mocks-in-hooks@7"],
	},
	"generator-iife-run-once-covers": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	const iter = (function* install(key: "log" | "warn"): Generator<never, void> {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	})("log");
	iter.next();
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: [],
	},
	"iife-reading-arguments-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	(function (key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		void arguments;
	})("log");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@12", "restore-mocks-in-hooks@7"],
	},
	"named-test-callback-calling-itself-earns-no-individual-credit": {
		body: `
let s: { mockRestore(): void };
let runs = 0;
it("t", async function run() {
	s = spyOn(console, runs === 0 ? "log" : "warn").mockImplementation(() => {});
	onTestFinished(() => s.mockRestore());
	if (runs++ === 0) void run();
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@11", "restore-mocks-in-hooks@7"],
	},
	"named-test-callback-writing-an-outer-spy-once-covers": {
		body: `
let s: { mockRestore(): void };
it("t", async function run() {
	s = spyOn(console, "log").mockImplementation(() => {});
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"const-function-handing-out-its-own-name-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	let again: (key: "log" | "warn") => void = () => {};
	const install = function inner(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
		again = inner;
	};
	install("log");
	again("warn");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@15", "restore-mocks-in-hooks@8"],
	},
	"const-function-called-once-covers": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	const install = function inner(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	};
	install("log");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: [],
	},
	"exported-helper-earns-no-individual-credit": {
		body: `
let s: { mockRestore(): void };
export function install(key: "log" | "warn") {
	s = spyOn(console, key).mockImplementation(() => {});
	onTestFinished(() => s.mockRestore());
}
it("t", async () => {
	install("log");
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@12", "restore-mocks-in-hooks@6"],
	},
	"helper-reachable-through-eval-earns-no-individual-credit": {
		body: `
it("t", async () => {
	let s: { mockRestore(): void };
	function install(key: "log" | "warn") {
		s = spyOn(console, key).mockImplementation(() => {});
		onTestFinished(() => s.mockRestore());
	}
	install("log");
	eval('install("warn")');
	await Promise.resolve();
	s!.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@13", "restore-mocks-in-hooks@7"],
	},
	"inline-generator-finisher-does-not-cover": {
		body: `
it("t", async () => {
	const s = spyOn(console, "log").mockImplementation(() => {});
	onTestFinished(function* () { s.mockRestore(); });
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@5", "restore-mocks-in-hooks@8"],
	},
	"inline-function-expression-finisher-covers": {
		body: `
it("t", async () => {
	const s = spyOn(console, "log").mockImplementation(() => {});
	onTestFinished(function () { s.mockRestore(); });
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"named-generator-finisher-does-not-cover": {
		body: `
it("t", async () => {
	function* cleanup() { s.mockRestore(); }
	const s = spyOn(console, "log").mockImplementation(() => {});
	onTestFinished(cleanup);
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@6", "restore-mocks-in-hooks@9"],
	},
	"named-function-finisher-covers": {
		body: `
it("t", async () => {
	function cleanup() { s.mockRestore(); }
	const s = spyOn(console, "log").mockImplementation(() => {});
	onTestFinished(cleanup);
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"generator-after-each-does-not-cover": {
		body: `
afterEach(function* () { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log").mockImplementation(() => {});
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@7"],
	},
	"function-expression-after-each-covers": {
		body: `
afterEach(function () { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log").mockImplementation(() => {});
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: [],
	},
	"named-generator-after-each-does-not-cover": {
		body: `
function* cleanup() { vi.restoreAllMocks(); }
afterEach(cleanup);
it("t", async () => {
	const s = spyOn(console, "log").mockImplementation(() => {});
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"generator-put-back-finisher-does-not-cover": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(function* () { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@7"],
	},
	"function-expression-put-back-finisher-covers": {
		body: `
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(function () { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: [],
	},
	"generator-put-back-after-each-does-not-cover": {
		body: `
const original = globalThis.fetch;
afterEach(function* () { globalThis.fetch = original; });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"function-expression-put-back-after-each-covers": {
		body: `
const original = globalThis.fetch;
afterEach(function () { globalThis.fetch = original; });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: [],
	},
	"restore-hook-after-an-async-hook-in-its-scope-does-not-cover": {
		body: `
afterEach(async () => { await Promise.resolve(); });
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"restore-hook-before-an-async-hook-in-its-scope-covers": {
		body: `
afterEach(() => { vi.restoreAllMocks(); });
afterEach(async () => { await Promise.resolve(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: [],
	},
	"outer-restore-hook-after-an-inner-async-hook-does-not-cover": {
		body: `
afterEach(() => { vi.restoreAllMocks(); });
describe("d", () => {
	afterEach(async () => { await Promise.resolve(); });
	it("t", async () => {
		const s = spyOn(console, "log");
		try { await Promise.resolve(); } finally { s.mockRestore(); }
	});
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"inner-restore-hook-before-an-outer-async-hook-covers": {
		body: `
afterEach(async () => { await Promise.resolve(); });
describe("d", () => {
	afterEach(() => { vi.restoreAllMocks(); });
	it("t", async () => {
		const s = spyOn(console, "log");
		try { await Promise.resolve(); } finally { s.mockRestore(); }
	});
});`,
		expected: [],
	},
	"restore-hook-after-a-done-callback-hook-does-not-cover": {
		body: `
afterEach(done => { done(); });
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"restore-hook-after-a-hook-returning-a-call-does-not-cover": {
		body: `
afterEach(() => mod.cleanup());
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"restore-hook-after-a-block-hook-returning-a-call-does-not-cover": {
		body: `
afterEach(() => { return mod.cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"restore-hook-after-a-void-expression-hook-covers": {
		body: `
afterEach(() => void mod.cleanup());
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: [],
	},
	"restore-hook-after-a-generator-hook-covers": {
		body: `
afterEach(function* () {});
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: [],
	},
	"restore-hook-after-a-helper-registered-async-hook-does-not-cover": {
		body: `
function useCleanup() { afterEach(async () => { await Promise.resolve(); }); }
useCleanup();
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@9"],
	},
	"restore-hook-after-an-unresolved-named-hook-does-not-cover": {
		body: `
afterEach(mod.cleanup);
afterEach(() => { vi.restoreAllMocks(); });
it("t", async () => {
	const s = spyOn(console, "log");
	try { await Promise.resolve(); } finally { s.mockRestore(); }
});`,
		expected: ["restore-mocks-in-hooks@8"],
	},
	"finisher-restore-with-an-async-after-each-does-not-cover": {
		body: `
afterEach(async () => { await Promise.resolve(); });
it("t", async () => {
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@6", "restore-mocks-in-hooks@9"],
	},
	"shared-helper-covers-with-an-async-after-each": {
		body: `
import { installMockRestores } from "./helpers/mock-restores";
installMockRestores();
afterEach(async () => { await Promise.resolve(); });
it("t", async () => {
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"finisher-restore-after-an-async-finisher-does-not-cover": {
		body: `
it("t", async () => {
	onTestFinished(async () => { await Promise.resolve(); });
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: ["restore-mocks-in-hooks@6", "restore-mocks-in-hooks@9"],
	},
	"finisher-restore-before-an-async-finisher-covers": {
		body: `
it("t", async () => {
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
	onTestFinished(async () => { await Promise.resolve(); });
	await Promise.resolve();
	s.mockRestore();
});`,
		expected: [],
	},
	"sync-test-finisher-restore-with-an-async-after-each-does-not-cover": {
		body: `
afterEach(async () => { await Promise.resolve(); });
it("t", () => {
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
});`,
		expected: ["restore-mocks-in-hooks@6"],
	},
	"sync-test-finisher-restore-with-a-sync-after-each-covers": {
		body: `
afterEach(() => { mod.cleanup(); });
it("t", () => {
	const s = spyOn(console, "log");
	onTestFinished(() => s.mockRestore());
});`,
		expected: [],
	},
	"finisher-put-back-with-an-async-after-each-does-not-cover": {
		body: `
afterEach(async () => { await Promise.resolve(); });
it("t", async () => {
	const original = globalThis.fetch;
	onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"put-back-hook-before-an-async-hook-covers": {
		body: `
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
afterEach(async () => { await Promise.resolve(); });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	await Promise.resolve();
});`,
		expected: [],
	},
	"put-back-hook-after-an-async-hook-does-not-cover": {
		body: `
const original = globalThis.fetch;
afterEach(async () => { await Promise.resolve(); });
afterEach(() => { globalThis.fetch = original; });
it("t", async () => {
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { await Promise.resolve(); } finally { globalThis.fetch = original; }
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"sync-test-finisher-put-back-with-an-async-after-each-does-not-cover": {
		body: `
afterEach(async () => { await Promise.resolve(); });
it("t", () => {
	const original = globalThis.fetch;
	onTestFinished(() => { globalThis.fetch = original; });
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
});`,
		expected: ["put-back-on-test-finished@8"],
	},
	"sync-test-finally-put-back-with-an-async-after-each-covers": {
		body: `
afterEach(async () => { await Promise.resolve(); });
it("t", () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
	try { mod.run(); } finally { globalThis.fetch = original; }
});`,
		expected: [],
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
