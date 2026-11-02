/**
 * Reports, per test file, every place a timed-out test or hook body leaks into the NEXT test:
 * after an `await` that `afterEach` already passed, it touches something another test can see.
 *
 * This is the half of the test-isolation contract that `scripts/oxlint/test-isolation.ts` does NOT
 * cover: an INSTALL after an await (`vi.spyOn`, `mockSchedulerWaitWithClock`, fake timers), a GUARD
 * TOKEN that must be captured before the first await, and module/describe `let`/`var` or
 * `const x = new…/[]` shared bindings. That rule owns the complementary half (cleanup/put-backs a
 * timeout skips). Run both; see `packages/coding-agent/test/test-isolation.test.ts`.
 *
 * Reports, per file, every place where code after an await touches something another test can see,
 * unless an ownership check comes first in the same await-free run:
 *
 * - `shared`  a read or write of a suite-level binding: `let`/`var` at module or describe scope,
 *             or a `const` holding a constructed object (`new …`, `[]`, `{}`). Capture what a test
 *             needs into locals before its first await instead.
 * - `spy`     a spy, fake clock or stubbed global installed after an await, on a target that is
 *             not a local of the function.
 * - `global`  a write to `globalThis.*`, `process.env.*`, `Bun.env.*`, or `process.chdir()`.
 * - `helper`  a call to a file-level helper that itself touches shared state or installs spies.
 * - `late-after`  any of the above after the first await of an afterEach/afterAll hook; no check
 *             can make that safe, so it must happen before the hook's first await.
 *
 * A check is `<x>.assertLive()`, or `await <owner|cleanup>.add(…)` (`add` checks the same and the
 * await only yields to microtasks, which no test timeout can interrupt).
 *
 * Contexts: bodies of it/test (all variants), hooks, and every file-level helper function.
 * Nested callbacks are not scanned as part of the enclosing body.
 *
 * usage: bun scan-late-access.ts <root> <file>...   → lines "file:line kind detail", then TOTAL n
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as tsPlugin from "prettier/plugins/typescript";

type Node = { type: string; loc?: { start: { line: number } }; [k: string]: unknown };

const SPY_CALLEES = new Set([
	"vi.spyOn",
	"spyOn",
	"jest.spyOn",
	"vi.useFakeTimers",
	"vi.useRealTimers",
	"vi.setSystemTime",
	"setSystemTime",
	"vi.stubGlobal",
	"vi.stubEnv",
	"vi.unstubAllGlobals",
	"vi.unstubAllEnvs",
	"mockSchedulerWaitWithClock",
	"mock.module",
]);
const GLOBAL_CALLS = new Set(["process.chdir", "setProjectDir"]);
// beforeAll/afterAll run once per describe; their writes are describe-scoped and cannot reach another
// test, so only per-test setup (beforeEach) and teardown (afterEach) are scanned alongside bodies.
const HOOK_KIND: Record<string, "hook" | "late-hook"> = { beforeEach: "hook", afterEach: "late-hook" };

function isFunction(node: Node | undefined): boolean {
	return (
		!!node &&
		(node.type === "ArrowFunctionExpression" ||
			node.type === "FunctionExpression" ||
			node.type === "FunctionDeclaration")
	);
}

function memberText(node: Node | undefined): string {
	if (!node) return "?";
	if (node.type === "Identifier") return node.name as string;
	if (node.type === "ThisExpression") return "this";
	if (node.type === "MemberExpression") {
		const property = node.property as Node;
		return `${memberText(node.object as Node)}.${!node.computed && property.type === "Identifier" ? property.name : "[]"}`;
	}
	if (node.type === "CallExpression") return `${memberText(node.callee as Node)}()`;
	if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression")
		return memberText(node.expression as Node);
	return "?";
}

function rootIdentifier(node: Node | undefined): string | undefined {
	let current = node;
	while (current) {
		if (current.type === "Identifier") return current.name as string;
		if (current.type === "MemberExpression") current = current.object as Node;
		else if (current.type === "TSNonNullExpression" || current.type === "TSAsExpression")
			current = current.expression as Node;
		else if (current.type === "CallExpression") {
			const callee = current.callee as Node;
			current = callee.type === "MemberExpression" ? (callee.object as Node) : undefined;
		} else return undefined;
	}
	return undefined;
}

/** Child nodes in source order, which is evaluation order for everything a test body does here. */
function children(node: Node): Array<[string, Node]> {
	const out: Array<[string, Node]> = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "range" || key === "parent") continue;
		if (Array.isArray(value)) {
			for (const child of value)
				if (child && typeof child === "object" && "type" in child) out.push([key, child as Node]);
		} else if (value && typeof value === "object" && "type" in (value as object)) out.push([key, value as Node]);
	}
	const start = (entry: [string, Node]): number => (entry[1].range as [number, number] | undefined)?.[0] ?? 0;
	return out.sort((a, b) => start(a) - start(b));
}

function collectPattern(node: Node | undefined, out: Set<string>): void {
	if (!node) return;
	if (node.type === "Identifier") out.add(node.name as string);
	else if (node.type === "ObjectPattern")
		for (const p of node.properties as Node[]) collectPattern((p.value ?? p.argument) as Node, out);
	else if (node.type === "ArrayPattern") for (const e of node.elements as Node[]) collectPattern(e, out);
	else if (node.type === "RestElement") collectPattern(node.argument as Node, out);
	else if (node.type === "AssignmentPattern") collectPattern(node.left as Node, out);
	else if (node.type === "TSParameterProperty") collectPattern(node.parameter as Node, out);
}

/** Params and every declaration inside `fn`, without descending into nested functions' bodies. */
function functionLocals(fn: Node): Set<string> {
	const out = new Set<string>();
	for (const param of (fn.params as Node[]) ?? []) collectPattern(param, out);
	const visit = (node: Node): void => {
		if (node.type === "VariableDeclarator") collectPattern(node.id as Node, out);
		if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
			out.add((node.id as Node).name as string);
		if (node.type === "CatchClause" && node.param) collectPattern(node.param as Node, out);
		if (isFunction(node)) return;
		for (const [, child] of children(node)) visit(child);
	};
	if (fn.body) visit(fn.body as Node);
	return out;
}

function calleeName(call: Node): string {
	const callee = call.callee as Node;
	if (callee.type === "CallExpression") return `${calleeName(callee)}()`;
	return memberText(callee);
}

function isTestCall(name: string): boolean {
	return /^(it|test)(\.[a-zA-Z]+(\(\))?)*$/.test(name);
}
function isSuiteCall(name: string): boolean {
	return /^describe(\.[a-zA-Z]+(\(\))?)*$/.test(name);
}

export interface Site {
	line: number;
	kind: string;
	detail: string;
}

// Object literals are fixtures read in place; constructed objects and arrays hold state tests change.
const MUTABLE_INIT = new Set(["NewExpression", "ArrayExpression"]);
// Calls a late afterEach may still make: they reach no other test's state.
const SAFE_LATE_ROOTS = new Set([
	"AggregateError",
	"Error",
	"Promise",
	"Array",
	"Object",
	"JSON",
	"Math",
	"String",
	"Number",
]);

function analyze(program: Node): Site[] {
	const shared = new Set<string>();
	const helpers = new Map<string, Node>();
	const contexts: Array<{ fn: Node; kind: "test" | "hook" | "late-hook" | "helper" }> = [];

	// Suite scopes: the program and every describe callback, recursively.
	const suiteBodies: Node[][] = [program.body as Node[]];
	const findSuites = (node: Node): void => {
		if (node.type === "CallExpression") {
			const name = calleeName(node);
			for (const arg of node.arguments as Node[]) {
				if (isFunction(arg)) {
					if (isSuiteCall(name) && (arg.body as Node).type === "BlockStatement")
						suiteBodies.push(((arg.body as Node).body as Node[]) ?? []);
					if (isTestCall(name)) contexts.push({ fn: arg, kind: "test" });
					if (name in HOOK_KIND) contexts.push({ fn: arg, kind: HOOK_KIND[name]! });
				}
			}
		}
		for (const [, child] of children(node)) findSuites(child);
	};
	findSuites(program);

	for (const body of suiteBodies) {
		for (const statement of body) {
			const declaration =
				statement.type === "ExportNamedDeclaration"
					? ((statement.declaration as Node | undefined) ?? statement)
					: statement;
			if (declaration.type === "FunctionDeclaration" && declaration.id) {
				helpers.set((declaration.id as Node).name as string, declaration);
			} else if (declaration.type === "VariableDeclaration") {
				for (const declarator of declaration.declarations as Node[]) {
					const init = declarator.init as Node | undefined;
					const id = declarator.id as Node;
					if (init && isFunction(init) && id.type === "Identifier") {
						helpers.set(id.name as string, init);
						continue;
					}
					const unwrapped =
						init && (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression")
							? (init.expression as Node)
							: init;
					if (declaration.kind !== "const" || (unwrapped && MUTABLE_INIT.has(unwrapped.type))) {
						const names = new Set<string>();
						collectPattern(id, names);
						for (const name of names) shared.add(name);
					}
				}
			}
		}
	}
	for (const fn of helpers.values()) contexts.push({ fn, kind: "helper" });

	// Helpers that touch shared state or install spies anywhere in their own body (fixpoint).
	const touching = new Set<string>();
	const helperTouches = (fn: Node, locals: Set<string>): boolean => {
		let found = false;
		const visit = (node: Node, parent: Node | undefined, key: string): void => {
			if (found) return;
			if (node !== fn && isFunction(node)) return;
			if (node.type === "Identifier" && isValueReference(node, parent, key)) {
				const name = node.name as string;
				if (!locals.has(name) && (shared.has(name) || touching.has(name))) found = true;
			}
			if (node.type === "CallExpression" && SPY_CALLEES.has(calleeName(node))) found = true;
			for (const [childKey, child] of children(node)) visit(child, node, childKey);
		};
		visit(fn.body as Node, fn, "body");
		return found;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const [name, fn] of helpers) {
			if (touching.has(name)) continue;
			if (helperTouches(fn, functionLocals(fn))) {
				touching.add(name);
				changed = true;
			}
		}
	}

	const sites: Site[] = [];
	for (const { fn, kind } of contexts) {
		const locals = functionLocals(fn);
		// Guard tokens valid after an await: a local bound from `X.capture()` or `= cleanup`/`= owner`
		// BEFORE the first await, so a resumed body sees the run it started in, not the next test's.
		// A token captured after the first await names the wrong run, so it does not count.
		const liveTokens = new Set<string>();
		let awaited = false;
		let guarded = false;
		const late = kind === "late-hook";
		const report = (node: Node, what: string, detail: string): void => {
			sites.push({ line: node.loc?.start.line ?? 0, kind: late ? `late-after:${what}` : what, detail });
		};
		const bindsToken = (declarator: Node): void => {
			const id = declarator.id as Node;
			const init = declarator.init as Node | undefined;
			if (awaited || id.type !== "Identifier" || !init) return;
			const isCapture = init.type === "CallExpression" && calleeName(init).endsWith(".capture");
			const isCleanupAlias = init.type === "Identifier" && /^(cleanup|owner)$/.test(init.name as string);
			if (isCapture || isCleanupAlias) liveTokens.add(id.name as string);
		};
		const guardReceiverIsLive = (call: Node): boolean => {
			const callee = call.callee as Node;
			if (callee.type !== "MemberExpression") return false;
			const root = rootIdentifier(callee.object as Node);
			return !!root && liveTokens.has(root);
		};
		const visit = (node: Node, parent: Node | undefined, key: string): void => {
			if (node !== fn && isFunction(node)) return;
			if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) {
				for (const [childKey, child] of children(node)) visit(child, node, childKey);
				awaited = true;
				guarded = false;
				const argument = node.argument as Node | undefined;
				if (!late && argument?.type === "CallExpression") {
					const callee = argument.callee as Node;
					if (
						callee.type === "MemberExpression" &&
						(callee.property as Node).type === "Identifier" &&
						(callee.property as Node).name === "add" &&
						guardReceiverIsLive(argument)
					)
						guarded = true;
				}
				return;
			}
			if (node.type === "VariableDeclarator") bindsToken(node);
			if (node.type === "CallExpression") {
				const name = calleeName(node);
				if (name.endsWith(".assertLive") && !late && guardReceiverIsLive(node)) {
					guarded = true;
					return;
				}
				if (awaited && !guarded) {
					if (SPY_CALLEES.has(name)) {
						const target = rootIdentifier((node.arguments as Node[])[0]);
						if (name === "mockSchedulerWaitWithClock" || !target || !locals.has(target))
							report(node, "spy", `${name}(${target ?? ""})`);
					} else if (GLOBAL_CALLS.has(name)) report(node, "global", name);
					else if ((node.callee as Node).type === "Identifier" && touching.has(name) && !locals.has(name))
						report(node, "helper", name);
					else if (late) {
						const target = rootIdentifier(node.callee as Node);
						if (target && !locals.has(target) && !SAFE_LATE_ROOTS.has(target) && !shared.has(target))
							report(node, "call", name);
					}
				}
			}
			if (awaited && !guarded) {
				// A write through a shared binding reaches the next test; a plain read of one only
				// gives this dead body a stale value, so the two are reported apart.
				if (
					node.type === "AssignmentExpression" ||
					node.type === "UpdateExpression" ||
					(node.type === "UnaryExpression" && node.operator === "delete")
				) {
					const target = (node.type === "AssignmentExpression" ? node.left : node.argument) as Node;
					const text = memberText(target);
					const rootName = rootIdentifier(target);
					if (/^(globalThis|process\.env|Bun\.env)\b/.test(text)) report(node, "global", text);
					else if (rootName && !locals.has(rootName)) report(node, "shared-write", text);
				}
				if (node.type === "Identifier" && isValueReference(node, parent, key)) {
					const name = node.name as string;
					if (shared.has(name) && !locals.has(name)) report(node, "shared-read", name);
				}
			}
			for (const [childKey, child] of children(node)) visit(child, node, childKey);
		};
		visit(fn.body as Node, fn, "body");
	}
	const unique = new Map<string, Site>();
	for (const site of sites) unique.set(`${site.line}:${site.kind}:${site.detail}`, site);
	return [...unique.values()].sort((a, b) => a.line - b.line);
}

function isValueReference(node: Node, parent: Node | undefined, key: string): boolean {
	if (!parent) return true;
	if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
	if (
		(parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") &&
		key === "key" &&
		!parent.computed
	)
		return false;
	if (parent.type === "VariableDeclarator" && key === "id") return false;
	if (
		parent.type.startsWith("TS") &&
		!["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(parent.type)
	)
		return false;
	if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")
		return false;
	if (parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier") return false;
	return true;
}

export interface IsolationSite extends Site {
	file: string;
}

/** A post-await touch another test can see; a plain `shared-read` is a stale value, not a leak. */
export function isLeak(site: Site): boolean {
	return !site.kind.endsWith("shared-read");
}

/** Scan each file (relative to `root`) for post-await shared touches. */
export async function scanFiles(root: string, files: readonly string[]): Promise<IsolationSite[]> {
	const out: IsolationSite[] = [];
	for (const file of files) {
		const text = fs.readFileSync(path.join(root, file), "utf8");
		const program = (await tsPlugin.parsers.typescript.parse(text, { filepath: file } as never)) as unknown as Node;
		for (const site of analyze(program)) out.push({ ...site, file });
	}
	return out;
}

/**
 * The test files that install `mockSchedulerWaitWithClock` and so share the frozen scheduler clock:
 * the set the #14031 round-5 isolation sweep covers. `test/test-isolation.test.ts` asserts these stay
 * leak-free; extend the list as more files adopt the guard seam.
 */
export const GUARDED_TEST_FILES: readonly string[] = [
	"packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts",
	"packages/coding-agent/test/agent-session-empty-stop-guard.test.ts",
	"packages/coding-agent/test/agent-session-infinite-retry-cooldown.test.ts",
	"packages/coding-agent/test/agent-session-key-resolution-retry.test.ts",
	"packages/coding-agent/test/agent-session-prewalk.test.ts",
	"packages/coding-agent/test/agent-session-prompt-abort-race.test.ts",
	"packages/coding-agent/test/agent-session-retry-cap.test.ts",
	"packages/coding-agent/test/agent-session-retry-fallback.test.ts",
	"packages/coding-agent/test/agent-session-retry-recovery.test.ts",
	"packages/coding-agent/test/agent-session-snapcompact-auto-fallback.test.ts",
	"packages/coding-agent/test/agent-session-thinking-loop-retry.test.ts",
	"packages/coding-agent/test/agent-session-yield-empty-stop-suppression.test.ts",
	"packages/coding-agent/test/claude-auto-reset-integration.test.ts",
	"packages/coding-agent/test/codex-auto-reset-integration.test.ts",
	"packages/coding-agent/test/issue-986-compaction-auth-fallback.test.ts",
	"packages/coding-agent/test/model-registry-command-values.test.ts",
	"packages/coding-agent/test/sdk-subagent-auth-inheritance.test.ts",
	"packages/coding-agent/test/sdk-session-dispose-owner.test.ts",
	"packages/coding-agent/test/tools/gh-output.test.ts",
	"packages/coding-agent/test/helpers/mock-scheduler-clock.test.ts",
	"packages/coding-agent/test/helpers/test-cleanup.test.ts",
	"packages/coding-agent/test/helpers/test-lifetime.test.ts",
];

if (import.meta.main) {
	const root = process.argv[2] ?? ".";
	const files = process.argv.length > 3 ? process.argv.slice(3) : GUARDED_TEST_FILES;
	const sites = await scanFiles(root, files);
	const leaks = sites.filter(isLeak);
	for (const file of files) {
		const fileSites = sites.filter(site => site.file === file);
		console.log(`## ${file} ${fileSites.length}`);
		for (const site of fileSites) console.log(`${file}:${site.line} ${site.kind} ${site.detail}`);
	}
	console.log(`TOTAL ${sites.length} LEAKS ${leaks.length}`);
	if (leaks.length > 0) process.exit(1);
}
