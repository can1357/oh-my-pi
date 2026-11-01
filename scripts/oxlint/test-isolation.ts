/**
 * Oxlint JS plugin: bun:test cleanup that a timeout can skip.
 *
 * When a test times out, `bun test` abandons its body at the current `await`, runs the `afterEach`
 * hooks and moves on. Cleanup written later in that body never runs on time: a spy restored there
 * stays installed, and a global the body replaced and puts back in `finally` stays replaced. The
 * next test then fails for a reason that points nowhere near the slow test (a leaked
 * `performance.now` spy wrapped by the next one recurses into `RangeError: Maximum call stack size
 * exceeded`). If the body resumes later, its cleanup runs in the middle of another test.
 *
 * Cleanup that must survive a timeout belongs in a hook: `vi.restoreAllMocks()` in `afterEach`, or
 * `onTestFinished(...)` for a put-back. Both run after a timeout.
 *
 * The rules judge only what one file shows: a restore or put-back reached from a test body directly
 * or through a helper declared in the same file, and hooks declared in the same file.
 */

interface Node {
	type: string;
	parent?: Node;
	range: [number, number];
	[key: string]: unknown;
}

interface Variable {
	defs: { type: string; node: Node; parent?: Node | null }[];
}

interface Scope {
	set: Map<string, Variable>;
	upper: Scope | null;
}

interface RuleContext {
	sourceCode: { getScope(node: Node): Scope; visitorKeys: Record<string, readonly string[]>; text: string };
	report(descriptor: { node: Node; messageId: string; data?: Record<string, string> }): void;
}

const TEST_NAMES = new Set(["it", "test"]);
const DESCRIBE_NAMES = new Set(["describe"]);
const EACH_HOOK_NAMES = new Set(["afterEach", "beforeEach"]);
const HOOK_NAMES = new Set(["afterEach", "beforeEach", "afterAll", "beforeAll"]);
const TEST_MODULES = new Set(["bun:test", "vitest"]);
/** Objects shared by every test in the process; a replaced property on them outlives the test. */
const SHARED_GLOBALS = new Set([
	"globalThis",
	"global",
	"window",
	"self",
	"Bun",
	"process",
	"performance",
	"Date",
	"Math",
	"console",
	"crypto",
	"navigator",
	"Intl",
]);
const HELPER_DEPTH = 3;

const node = (value: unknown): Node | undefined =>
	typeof value === "object" && value !== null && typeof (value as Node).type === "string"
		? (value as Node)
		: undefined;
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.flatMap(v => node(v) ?? []) : []);
const identName = (value: unknown): string | undefined => {
	const n = node(value);
	return n?.type === "Identifier" ? (n.name as string) : undefined;
};
const isFunction = (n: Node | undefined): n is Node =>
	n?.type === "ArrowFunctionExpression" || n?.type === "FunctionExpression" || n?.type === "FunctionDeclaration";

/** Strip TypeScript-only wrappers, parentheses and optional chains. */
function unwrap(n: Node | undefined): Node | undefined {
	while (
		n &&
		(n.type === "TSAsExpression" ||
			n.type === "TSNonNullExpression" ||
			n.type === "TSSatisfiesExpression" ||
			n.type === "TSTypeAssertion" ||
			n.type === "ParenthesizedExpression" ||
			n.type === "ChainExpression")
	)
		n = node(n.expression);
	return n;
}

/** `it` in `it(...)`, `it.each(rows)(...)`, `test.skipIf(x)(...)`. */
function calleeRoot(callee: Node | undefined): Node | undefined {
	let n = unwrap(callee);
	while (n) {
		if (n.type === "Identifier") return n;
		if (n.type === "MemberExpression") n = unwrap(node(n.object));
		else if (n.type === "CallExpression") n = unwrap(node(n.callee));
		else return undefined;
	}
	return undefined;
}

function propertyName(member: Node): string | undefined {
	if (member.type !== "MemberExpression") return undefined;
	const property = node(member.property);
	if (!member.computed) return identName(property);
	return property?.type === "Literal" && typeof property.value === "string" ? property.value : undefined;
}

/** Dotted path of a member chain rooted at an identifier: `globalThis.fetch`, `process.stdout.isTTY`. */
function memberPath(value: Node | undefined): { root: Node; path: string } | undefined {
	const n = unwrap(value);
	if (!n) return undefined;
	if (n.type === "Identifier") return { root: n, path: n.name as string };
	if (n.type !== "MemberExpression") return undefined;
	const object = memberPath(node(n.object));
	if (!object) return undefined;
	const name = propertyName(n);
	return { root: object.root, path: `${object.path}${name === undefined ? "[]" : `.${name}`}` };
}

interface Registration {
	kind: "test" | "describe" | "hook";
	name: string;
	call: Node;
}

interface FileFacts {
	context: RuleContext;
	calls: Node[];
	assignments: Node[];
	registrations: Map<Node, Registration>;
	/** Same-file helper function -> the calls that invoke it by name. */
	helpers: Map<Node, Node[]>;
	helperNames: Map<Node, string>;
}

function walk(context: RuleContext, root: Node, visit: (n: Node) => void): void {
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const n = stack.pop()!;
		visit(n);
		for (const key of context.sourceCode.visitorKeys[n.type] ?? []) {
			const child = n[key];
			if (Array.isArray(child)) for (const c of nodes(child)) stack.push(c);
			else {
				const c = node(child);
				if (c) stack.push(c);
			}
		}
	}
}

/** The bun:test export an identifier names: imported, global, or an alias such as `cond ? it : it.skip`. */
function testApiName(context: RuleContext, id: Node): string | undefined {
	const name = id.name as string;
	let scope: Scope | null = context.sourceCode.getScope(id);
	while (scope && !scope.set.has(name)) scope = scope.upper;
	const def = scope?.set.get(name)?.defs[0];
	if (!def) return name;
	if (def.type === "ImportBinding") {
		const declaration = def.parent ?? def.node.parent;
		const source = node(declaration?.source);
		if (!source || !TEST_MODULES.has(source.value as string)) return undefined;
		return identName(def.node.imported) ?? name;
	}
	if (def.type === "Variable") {
		const init = unwrap(node(def.node.init));
		if (!init || isFunction(init)) return undefined;
		const text = context.sourceCode.text.slice(init.range[0], init.range[1]);
		for (const candidate of [...TEST_NAMES, ...DESCRIBE_NAMES])
			if (new RegExp(`(^|[^.\\w])${candidate}\\b`).test(text)) return candidate;
	}
	return undefined;
}

function collect(context: RuleContext, program: Node): FileFacts {
	const calls: Node[] = [];
	const assignments: Node[] = [];
	const registrations = new Map<Node, Registration>();
	const helpers = new Map<Node, Node[]>();
	const helperNames = new Map<Node, string>();
	const helpersByName = new Map<string, Node[]>();
	walk(context, program, n => {
		if (n.type === "CallExpression") calls.push(n);
		if (n.type === "AssignmentExpression" || (n.type === "UnaryExpression" && n.operator === "delete"))
			assignments.push(n);
		if (isFunction(n)) {
			const name =
				n.type === "FunctionDeclaration"
					? identName(n.id)
					: n.parent?.type === "VariableDeclarator"
						? identName(n.parent.id)
						: undefined;
			if (name) {
				helperNames.set(n, name);
				helpersByName.set(name, [...(helpersByName.get(name) ?? []), n]);
			}
		}
	});
	for (const call of calls) {
		const root = calleeRoot(node(call.callee));
		if (!root) continue;
		const api = testApiName(context, root);
		if (!api) continue;
		const kind = TEST_NAMES.has(api)
			? "test"
			: DESCRIBE_NAMES.has(api)
				? "describe"
				: HOOK_NAMES.has(api)
					? "hook"
					: undefined;
		if (!kind) continue;
		for (const arg of nodes(call.arguments)) if (isFunction(arg)) registrations.set(arg, { kind, name: api, call });
	}
	for (const call of calls) {
		const name = identName(unwrap(node(call.callee)));
		for (const fn of (name && helpersByName.get(name)) || []) helpers.set(fn, [...(helpers.get(fn) ?? []), call]);
	}
	return { context, calls, assignments, registrations, helpers, helperNames };
}

function enclosingFunction(n: Node): Node | undefined {
	let cur = n.parent;
	while (cur && !isFunction(cur)) cur = cur.parent;
	// The Program node's parent is null, not undefined: normalise so file-scope hooks compare equal.
	return cur ?? undefined;
}

interface Flow {
	test: Node;
	registration: Registration;
	/** The node in the test's own body through which the cleanup is reached. */
	at: Node;
	/** Same-file helpers between the test body and the cleanup, innermost first. */
	via: Node[];
}

/**
 * Tests whose body runs `n` in its own flow: directly, in `.then/.catch/.finally` callbacks or IIFEs
 * of that body, or through same-file helpers the body calls. Closures handed anywhere else (cleanup
 * lists, hooks) are not followed: the rule cannot know when they run.
 */
function flows(facts: FileFacts, n: Node, depth = 0, via: Node[] = []): Flow[] {
	let fn = enclosingFunction(n);
	let at = n;
	while (fn) {
		const registration = facts.registrations.get(fn);
		if (registration) return registration.kind === "test" ? [{ test: fn, registration, at, via }] : [];
		const parent = fn.parent;
		const callee = parent?.type === "CallExpression" ? unwrap(node(parent.callee)) : undefined;
		const inFlowCallback =
			parent?.type === "CallExpression" &&
			nodes(parent.arguments).includes(fn) &&
			callee !== undefined &&
			["then", "catch", "finally"].includes(propertyName(callee) ?? "");
		const iife = parent?.type === "CallExpression" && callee === fn;
		if (parent && (inFlowCallback || iife)) {
			at = parent;
			fn = enclosingFunction(parent);
			continue;
		}
		const callers = facts.helpers.get(fn);
		if (!callers || depth >= HELPER_DEPTH) return [];
		const helper = fn;
		return callers.flatMap(call => flows(facts, call, depth + 1, [...via, helper]));
	}
	return [];
}

function isAsyncTest(flow: Flow): boolean {
	if (flow.test.async) return true;
	const each = node(flow.registration.call.callee)?.type === "CallExpression";
	return !each && nodes(flow.test.params).length > 0;
}

/**
 * Can the test suspend while the mock is installed, before it reaches the cleanup? Only then can a
 * timeout strand the cleanup. `start` is the installation (a spy declaration or the replacing write)
 * when the rule can see it in the same function as the cleanup.
 */
function suspendsBefore(facts: FileFacts, flow: Flow, cleanup: Node, start?: Node): boolean {
	const suspends = (fn: Node, after: number, before: number): boolean => {
		let found = false;
		walk(facts.context, fn, n => {
			if (found || n.range[0] < after || n.range[0] >= before) return;
			if (
				(n.type === "AwaitExpression" || (n.type === "ForOfStatement" && n.await === true)) &&
				enclosingFunction(n) === fn
			)
				found = true;
		});
		return found;
	};
	const cleanupFn = enclosingFunction(cleanup);
	if (start && cleanupFn && enclosingFunction(start) === cleanupFn)
		return suspends(cleanupFn, start.range[1], cleanup.range[0]);
	if (suspends(flow.test, 0, flow.at.range[0])) return true;
	let inner = cleanup;
	for (const helper of flow.via) {
		if (helper.async && suspends(helper, 0, inner.range[0])) return true;
		inner = facts.helpers.get(helper)?.find(call => enclosingFunction(call) !== helper) ?? helper;
	}
	return flow.at.parent?.type === "AwaitExpression";
}

/** The declaration of the spy a `x.mockRestore()` call restores, when it is `const x = spyOn(...)`. */
function spyDeclaration(facts: FileFacts, call: Node): Node | undefined {
	const callee = unwrap(node(call.callee));
	const receiver = callee?.type === "MemberExpression" ? unwrap(node(callee.object)) : undefined;
	if (receiver?.type !== "Identifier") return undefined;
	const name = receiver.name as string;
	let scope: Scope | null = facts.context.sourceCode.getScope(receiver);
	while (scope && !scope.set.has(name)) scope = scope.upper;
	const declarator = scope?.set.get(name)?.defs[0]?.node;
	if (declarator?.type !== "VariableDeclarator") return undefined;
	const init = node(declarator.init);
	const text = init ? facts.context.sourceCode.text.slice(init.range[0], init.range[1]) : "";
	return /\bspyOn\s*\(/.test(text) ? declarator : undefined;
}

function inFinally(n: Node, boundary: Node): boolean {
	for (let cur: Node | undefined = n; cur?.parent && cur.parent !== boundary; cur = cur.parent)
		if (cur.parent.type === "TryStatement" && cur.parent.finalizer === cur) return true;
	return false;
}

function restoreKind(call: Node): "restoreAll" | "mockRestore" | undefined {
	const callee = unwrap(node(call.callee));
	if (callee?.type !== "MemberExpression") return undefined;
	const name = propertyName(callee);
	if (name === "mockRestore") return "mockRestore";
	if (name === "restoreAllMocks") return "restoreAll";
	if (name === "restore" && identName(unwrap(node(callee.object))) === "mock") return "restoreAll";
	return undefined;
}

/** `fn` plus every same-file helper it reaches through direct calls, a few levels deep. */
function reachable(facts: FileFacts, fn: Node): Set<Node> {
	const seen = new Set<Node>([fn]);
	let frontier = [fn];
	for (let depth = 0; depth < HELPER_DEPTH && frontier.length > 0; depth++) {
		const next: Node[] = [];
		for (const from of frontier)
			for (const [helper, callers] of facts.helpers)
				if (!seen.has(helper) && callers.some(call => enclosingFunction(call) === from)) {
					seen.add(helper);
					next.push(helper);
				}
		frontier = next;
	}
	return seen;
}

/**
 * Is the restore reached through `flow` also run by an each-test hook that covers the test? Either
 * the hook restores every mock, or it calls the same helper that holds this restore.
 */
function hookRestores(facts: FileFacts, flow: Flow): boolean {
	for (const hook of coveringHooks(facts, flow.test)) {
		const functions = reachable(facts, hook);
		if (flow.via[0] && functions.has(flow.via[0])) return true;
		for (const fn of functions) {
			let found = false;
			walk(facts.context, fn, n => {
				if (!found && n.type === "CallExpression" && restoreKind(n) === "restoreAll" && enclosingFunction(n) === fn)
					found = true;
			});
			if (found) return true;
		}
	}
	return false;
}

/** Each-test hooks registered in the file scope or in a `describe` that encloses `test`. */
function coveringHooks(facts: FileFacts, test: Node): Node[] {
	const scopes = new Set<Node | undefined>([undefined]);
	for (let cur = enclosingFunction(test); cur; cur = enclosingFunction(cur))
		if (facts.registrations.get(cur)?.kind === "describe") scopes.add(cur);
	const hooks: Node[] = [];
	for (const call of facts.calls) {
		const root = calleeRoot(node(call.callee));
		if (!root || !EACH_HOOK_NAMES.has(testApiName(facts.context, root) ?? "")) continue;
		if (!scopes.has(enclosingFunction(call))) continue;
		for (const arg of nodes(call.arguments)) {
			if (isFunction(arg)) hooks.push(arg);
			const name = identName(arg);
			if (name) for (const [helper, helperName] of facts.helperNames) if (helperName === name) hooks.push(helper);
		}
	}
	return hooks;
}

function judgeRestores(facts: FileFacts): void {
	for (const call of facts.calls) {
		const kind = restoreKind(call);
		if (!kind) continue;
		const text = facts.context.sourceCode.text.slice(call.range[0], call.range[1]);
		const callText = text.length > 40 ? `${text.slice(0, 37)}...` : text;
		for (const flow of flows(facts, call)) {
			const covered = hookRestores(facts, flow);
			let messageId: string | undefined;
			if (isAsyncTest(flow)) {
				if (!suspendsBefore(facts, flow, call, kind === "mockRestore" ? spyDeclaration(facts, call) : undefined))
					continue;
				if (kind === "restoreAll") messageId = "restoreAllInAsyncBody";
				else if (!covered) messageId = "restoreSkippedByTimeout";
			} else if (!covered && !inFinally(call, flow.via[0] ?? flow.test)) messageId = "restoreSkippedByThrow";
			if (messageId) {
				facts.context.report({ node: call, messageId, data: { call: callText } });
				break;
			}
		}
	}
}

/** The shared property a write targets, or undefined when it writes something test-local. */
function sharedTarget(facts: FileFacts, n: Node): string | undefined {
	let path: { root: Node; path: string } | undefined;
	if (n.type === "AssignmentExpression" && n.operator === "=") {
		const target = unwrap(node(n.left));
		if (target?.type === "MemberExpression") path = memberPath(target);
	} else if (n.type === "UnaryExpression" && n.operator === "delete") {
		const target = unwrap(node(n.argument));
		if (target?.type === "MemberExpression") path = memberPath(target);
	} else if (n.type === "CallExpression") {
		const callee = unwrap(node(n.callee));
		const object = callee?.type === "MemberExpression" ? identName(unwrap(node(callee.object))) : undefined;
		if (!callee || (object !== "Object" && object !== "Reflect") || propertyName(callee) !== "defineProperty")
			return undefined;
		const [owner, key] = nodes(n.arguments);
		const ownerPath = memberPath(owner);
		if (!ownerPath) return undefined;
		const keyName = key?.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
		path = { root: ownerPath.root, path: `${ownerPath.path}${keyName === undefined ? "[]" : `.${keyName}`}` };
	}
	if (!path) return undefined;
	const rootName = path.root.name as string;
	let scope: Scope | null = facts.context.sourceCode.getScope(path.root);
	while (scope && !scope.set.has(rootName)) scope = scope.upper;
	const def = scope?.set.get(rootName)?.defs[0];
	const shared = def ? def.type === "ImportBinding" : SHARED_GLOBALS.has(rootName);
	if (!shared) return undefined;
	// Environment variables are not judged by this rule.
	if (/^(process|Bun)\.env(\.|\[|$)/.test(path.path)) return undefined;
	return path.path;
}

/** Shared paths that covering each-test hooks or the flow's `onTestFinished` callbacks write. */
function finishedPutBacks(facts: FileFacts, flow: Flow): Set<string> {
	const covered = new Set<string>();
	const record = (fn: Node) => {
		for (const reached of reachable(facts, fn))
			walk(facts.context, reached, n => {
				const shared = sharedTarget(facts, n);
				if (shared) covered.add(shared);
			});
	};
	for (const hook of coveringHooks(facts, flow.test)) record(hook);
	const owners = new Set<Node>([flow.test, ...flow.via]);
	for (const call of facts.calls) {
		const root = calleeRoot(node(call.callee));
		if (!root || testApiName(facts.context, root) !== "onTestFinished") continue;
		const owner = enclosingFunction(call);
		if (!owner || !owners.has(owner)) continue;
		for (const arg of nodes(call.arguments)) {
			const name = identName(arg);
			if (name) {
				for (const [helper, helperName] of facts.helperNames) if (helperName === name) record(helper);
			} else record(arg);
		}
	}
	return covered;
}

function judgePutBacks(facts: FileFacts): void {
	const byFunction = new Map<Node, { node: Node; path: string }[]>();
	for (const write of [...facts.assignments, ...facts.calls]) {
		const path = sharedTarget(facts, write);
		const fn = path ? enclosingFunction(write) : undefined;
		if (path && fn) byFunction.set(fn, [...(byFunction.get(fn) ?? []), { node: write, path }]);
	}
	for (const [fn, writes] of byFunction) {
		for (const write of writes) {
			const replaced = writes.find(other => other.path === write.path && other.node.range[0] < write.node.range[0]);
			if (!replaced && !inFinally(write.node, fn)) continue;
			for (const flow of flows(facts, write.node)) {
				if (!isAsyncTest(flow) || !suspendsBefore(facts, flow, write.node, replaced?.node)) continue;
				if (finishedPutBacks(facts, flow).has(write.path)) continue;
				facts.context.report({
					node: write.node,
					messageId: "putBackSkippedByTimeout",
					data: { target: write.path },
				});
				break;
			}
		}
	}
}

function rule(description: string, messages: Record<string, string>, judge: (facts: FileFacts) => void) {
	return {
		meta: { type: "problem", docs: { description }, messages, schema: [] },
		create(context: RuleContext) {
			return {
				"Program:exit"(program: Node) {
					judge(collect(context, program));
				},
			};
		},
	};
}

export default {
	meta: { name: "omp-test" },
	rules: {
		"restore-mocks-in-hooks": rule(
			"Restore mocks in an afterEach hook, where a test timeout cannot skip it.",
			{
				restoreSkippedByTimeout:
					"A test that times out never reaches `{{call}}`, so the mock leaks into later tests. Cover this test with an `afterEach` that calls `vi.restoreAllMocks()`.",
				restoreAllInAsyncBody:
					"`{{call}}` in an async test body runs late if the test times out, and then removes the mocks a later test installed. Restore mocks in `afterEach` instead.",
				restoreSkippedByThrow:
					"A failing assertion before `{{call}}` skips it, so the mock leaks into later tests. Restore in `finally`, or cover this test with an `afterEach` that calls `vi.restoreAllMocks()`.",
			},
			judgeRestores,
		),
		"put-back-on-test-finished": rule(
			"Put a replaced shared property back in onTestFinished, where a test timeout cannot skip it.",
			{
				putBackSkippedByTimeout:
					"A test that times out never reaches this put-back of `{{target}}`, so the replacement leaks into later tests. Register the put-back with `onTestFinished(() => ...)`, which runs even after a timeout.",
			},
			judgePutBacks,
		),
	},
};
