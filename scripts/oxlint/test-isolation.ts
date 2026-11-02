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
 * `onTestFinished(...)` for a put-back. Both run after a timeout. An `onTestFinished` callback runs
 * only if the body registered it, though: a registration that follows an `await` after the
 * replacement is skipped by the same timeout. A hook that awaits before its cleanup can time out
 * there too.
 *
 * The rules judge only what one file shows: a restore or put-back reached from a test body directly,
 * through a helper declared in the same file, or through a cleanup method on an object such a
 * helper returns; and hooks declared in the same file.
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
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const HELPER_DEPTH = 3;
/** How many `const` aliases or helper parameters a written place is followed through. */
const ALIAS_DEPTH = 4;

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

/** {@link unwrap}, then `await` too: `await spyOn(...)` installs the spy before it suspends. */
function unwrapAwait(n: Node | undefined): Node | undefined {
	let cur = unwrap(n);
	while (cur?.type === "AwaitExpression") cur = unwrap(node(cur.argument));
	return cur;
}

function propertyName(member: Node): string | undefined {
	if (member.type !== "MemberExpression") return undefined;
	const property = node(member.property);
	if (!member.computed) return identName(property);
	return property?.type === "Literal" && typeof property.value === "string" ? property.value : undefined;
}

/** The key of an object-literal property: `restore() {}`, `restore: () => {}`, `"restore": ...`. */
function keyName(property: Node): string | undefined {
	const key = node(property.key);
	if (!property.computed && key?.type === "Identifier") return key.name as string;
	return key?.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** A written place: the identifier a member chain starts at, and the chain's dotted path. */
interface Place {
	root: Node;
	path: string;
}

/** Dotted path of a member chain rooted at an identifier: `globalThis.fetch`, `process.stdout.isTTY`. */
function memberPath(value: Node | undefined): Place | undefined {
	const n = unwrap(value);
	if (!n) return undefined;
	if (n.type === "Identifier") return { root: n, path: n.name as string };
	if (n.type !== "MemberExpression") return undefined;
	const object = memberPath(node(n.object));
	if (!object) return undefined;
	const name = propertyName(n);
	return { root: object.root, path: `${object.path}${name === undefined ? "[]" : `.${name}`}` };
}

/** The variable an identifier names. */
function variableOf(context: RuleContext, id: Node): Variable | undefined {
	const name = id.name as string;
	let scope: Scope | null = context.sourceCode.getScope(id);
	while (scope && !scope.set.has(name)) scope = scope.upper;
	return scope?.set.get(name);
}

/** What a variable was declared with (`const x = <init>`), `await` stripped. */
function declaredInit(context: RuleContext, id: Node, constOnly: boolean): Node | undefined {
	const def = variableOf(context, id)?.defs[0];
	if (def?.type !== "Variable" || (constOnly && def.parent?.kind !== "const")) return undefined;
	return unwrapAwait(node(def.node.init));
}

interface Registration {
	kind: "test" | "describe" | "hook";
	name: string;
	call: Node;
}

interface FileFacts {
	context: RuleContext;
	calls: Node[];
	/** Assignments, `delete`, `++`/`--`, and `for (x.y of ...)` targets. */
	assignments: Node[];
	registrations: Map<Node, Registration>;
	/** Same-file helper function (or returned cleanup method) -> the calls that invoke it. */
	helpers: Map<Node, Node[]>;
	helperNames: Map<Node, string>;
	/** `onTestFinished(...)` calls. */
	finishers: Node[];
	/** Shared paths a function writes, itself or through same-file helpers; filled on first use. */
	written: Map<Node, Set<string>>;
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
	const def = variableOf(context, id)?.defs[0];
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

/**
 * The bun:test export a call's callee names: `it(...)`, `it.each(rows)(...)`, `test.skipIf(x)(...)`,
 * and `t.it(...)` or `t.onTestFinished(...)` through `import * as t from "bun:test"`.
 */
function testApi(context: RuleContext, callee: Node | undefined): string | undefined {
	let n = unwrap(callee);
	let member: string | undefined;
	while (n && n.type !== "Identifier") {
		if (n.type === "MemberExpression") {
			const object = unwrap(node(n.object));
			if (object?.type === "Identifier") member = propertyName(n);
			n = object;
		} else if (n.type === "CallExpression") n = unwrap(node(n.callee));
		else return undefined;
	}
	if (!n) return undefined;
	const def = variableOf(context, n)?.defs[0];
	if (def?.type === "ImportBinding" && def.node.type === "ImportNamespaceSpecifier") {
		const source = node((def.parent ?? def.node.parent)?.source);
		return source && TEST_MODULES.has(source.value as string) ? member : undefined;
	}
	return testApiName(context, n);
}

function collect(context: RuleContext, program: Node): FileFacts {
	const calls: Node[] = [];
	const assignments: Node[] = [];
	const registrations = new Map<Node, Registration>();
	const helpers = new Map<Node, Node[]>();
	const helperNames = new Map<Node, string>();
	const helpersByName = new Map<string, Node[]>();
	const finishers: Node[] = [];
	walk(context, program, n => {
		if (n.type === "CallExpression") calls.push(n);
		if (
			n.type === "AssignmentExpression" ||
			n.type === "UpdateExpression" ||
			(n.type === "UnaryExpression" && n.operator === "delete") ||
			((n.type === "ForOfStatement" || n.type === "ForInStatement") && node(n.left)?.type !== "VariableDeclaration")
		)
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
		const api = testApi(context, node(call.callee));
		if (!api) continue;
		if (api === "onTestFinished") finishers.push(call);
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
	// `function install() { ...; return { restore() { ... } }; }`: `patch.restore()` on
	// `const patch = install()` runs that method.
	const methods = new Map<Node, Map<string, Node>>();
	for (const fn of helperNames.keys()) {
		const returned: Node[] = [];
		const body = unwrap(node(fn.body));
		if (body?.type === "ObjectExpression") returned.push(body);
		else if (body)
			walk(context, body, n => {
				if (n.type === "ReturnStatement" && enclosingFunction(n) === fn) {
					const value = unwrap(node(n.argument));
					if (value?.type === "ObjectExpression") returned.push(value);
				}
			});
		for (const object of returned)
			for (const property of nodes(object.properties)) {
				const key = property.type === "Property" ? keyName(property) : undefined;
				const value = node(property.value);
				if (key && isFunction(value)) methods.set(fn, (methods.get(fn) ?? new Map<string, Node>()).set(key, value));
			}
	}
	for (const call of calls) {
		const callee = unwrap(node(call.callee));
		const receiver = callee?.type === "MemberExpression" ? unwrap(node(callee.object)) : undefined;
		const key = callee ? propertyName(callee) : undefined;
		if (receiver?.type !== "Identifier" || !key) continue;
		const init = declaredInit(context, receiver, false);
		const helperName = init?.type === "CallExpression" ? identName(unwrap(node(init.callee))) : undefined;
		for (const fn of (helperName && helpersByName.get(helperName)) || []) {
			const method = methods.get(fn)?.get(key);
			if (method) helpers.set(method, [...(helpers.get(method) ?? []), call]);
		}
	}
	return { context, calls, assignments, registrations, helpers, helperNames, finishers, written: new Map() };
}

function enclosingFunction(n: Node): Node | undefined {
	let cur = n.parent;
	while (cur && !isFunction(cur)) cur = cur.parent;
	// The Program node's parent is null, not undefined: normalise so file-scope hooks compare equal.
	return cur ?? undefined;
}

/** Is `fn` a `.then/.catch/.finally` callback? It runs only after the code that chained it moved on. */
function isFlowCallback(fn: Node): boolean {
	const parent = fn.parent;
	if (parent?.type !== "CallExpression" || !nodes(parent.arguments).includes(fn)) return false;
	const callee = unwrap(node(parent.callee));
	return callee !== undefined && ["then", "catch", "finally"].includes(propertyName(callee) ?? "");
}

interface Flow {
	test: Node;
	registration: Registration;
	/** The node in the test's own body through which the target is reached. */
	at: Node;
	/** Same-file helpers between the test body and the target, innermost first. */
	via: Node[];
	/** For each helper in `via`, the call that enters it. */
	calls: Node[];
}

/**
 * Tests whose body runs `n` in its own flow: directly, in `.then/.catch/.finally` callbacks or IIFEs
 * of that body, or through same-file helpers the body calls. Closures handed anywhere else (cleanup
 * lists, hooks) are not followed: the rule cannot know when they run.
 */
function flows(facts: FileFacts, n: Node, depth = 0, via: Node[] = [], calls: Node[] = []): Flow[] {
	let fn = enclosingFunction(n);
	let at = n;
	while (fn) {
		const registration = facts.registrations.get(fn);
		if (registration) return registration.kind === "test" ? [{ test: fn, registration, at, via, calls }] : [];
		const parent = fn.parent;
		const iife = parent?.type === "CallExpression" && unwrap(node(parent.callee)) === fn;
		if (parent && (isFlowCallback(fn) || iife)) {
			at = parent;
			fn = enclosingFunction(parent);
			continue;
		}
		const callers = facts.helpers.get(fn);
		if (!callers || depth >= HELPER_DEPTH) return [];
		const helper = fn;
		return callers.flatMap(call => flows(facts, call, depth + 1, [...via, helper], [...calls, call]));
	}
	return [];
}

/** Does `fn` return a value? A test that returns a promise is awaited like an `async` one. */
function returnsValue(facts: FileFacts, fn: Node): boolean {
	const body = node(fn.body);
	if (!body) return false;
	if (body.type !== "BlockStatement") return true;
	let found = false;
	walk(facts.context, body, n => {
		if (!found && n.type === "ReturnStatement" && node(n.argument) && enclosingFunction(n) === fn) found = true;
	});
	return found;
}

function isAsyncTest(facts: FileFacts, flow: Flow): boolean {
	if (flow.test.async) return true;
	const each = node(flow.registration.call.callee)?.type === "CallExpression";
	if (!each && nodes(flow.test.params).length > 0) return true;
	return returnsValue(facts, flow.test);
}

/** Does `fn` itself (not a function nested in it) suspend at a node starting in `[after, before)`? */
function awaitsIn(facts: FileFacts, fn: Node, after: number, before: number): boolean {
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
}

/** Is `n` the operand of an `await` in `fn`? The function then suspends right after `n` runs. */
function insideAwait(n: Node, fn: Node): boolean {
	for (let cur = n.parent; cur && cur !== fn; cur = cur.parent) if (cur.type === "AwaitExpression") return true;
	return false;
}

/**
 * Can the test suspend while the mock is installed, before it reaches the cleanup? Only then can a
 * timeout strand the cleanup. `start` is the installation (a spy installation or the replacing write)
 * when the rule can see it in the same function as the cleanup.
 */
function suspendsBefore(facts: FileFacts, flow: Flow, cleanup: Node, start?: Node): boolean {
	const cleanupFn = enclosingFunction(cleanup);
	if (start && cleanupFn && enclosingFunction(start) === cleanupFn)
		return insideAwait(start, cleanupFn) || awaitsIn(facts, cleanupFn, start.range[1], cleanup.range[0]);
	// A `.then/.catch/.finally` callback runs only once the promise it is chained on settles.
	if (chain(flow, cleanup).some(({ fn }) => fn !== flow.test && isFlowCallback(fn))) return true;
	if (awaitsIn(facts, flow.test, 0, flow.at.range[0])) return true;
	for (const [i, helper] of flow.via.entries())
		if (helper.async && awaitsIn(facts, helper, 0, (flow.calls[i - 1] ?? cleanup).range[0])) return true;
	return flow.at.parent?.type === "AwaitExpression";
}

/** The functions `n` runs in through `flow`, innermost first, each with the node of its own body that runs `n`. */
function chain(flow: Flow, n: Node): { fn: Node; pos: Node }[] {
	const levels: { fn: Node; pos: Node }[] = [];
	for (const [i, owner] of [...flow.via, flow.test].entries()) {
		let pos = flow.calls[i - 1] ?? n;
		for (let fn = enclosingFunction(pos); fn && fn !== owner; fn = enclosingFunction(fn)) {
			levels.push({ fn, pos });
			pos = fn;
		}
		levels.push({ fn: owner, pos });
	}
	return levels;
}

/**
 * Can the test suspend after `first` runs and before `then` runs? Both run in one test, reached
 * through `firstFlow` and `thenFlow`. A timeout at that suspension skips `then`.
 */
function suspendsBetween(facts: FileFacts, firstFlow: Flow, first: Node, thenFlow: Flow, then: Node): boolean {
	const a = chain(firstFlow, first);
	const b = chain(thenFlow, then);
	const i = a.findIndex(level => b.some(other => other.fn === level.fn));
	const j = i < 0 ? -1 : b.findIndex(level => level.fn === a[i]!.fn);
	if (j < 0) return true;
	const fn = a[i]!.fn;
	const from = a[i]!.pos;
	const to = b[j]!.pos;
	// `then` waits for a suspension inside the function that holds it: past an `await` there, or in a
	// `.then` callback.
	const delayed = b
		.slice(0, j)
		.some(
			({ fn: inner, pos }) =>
				isFlowCallback(inner) || (inner.async === true && awaitsIn(facts, inner, inner.range[0], pos.range[0])),
		);
	if (from === to) return false;
	if (to.range[0] < from.range[0]) {
		// Registered before `first`: late only when its function was not awaited and is still suspended.
		let awaited = false;
		for (let cur = to.parent; cur && cur !== fn; cur = cur.parent) if (cur.type === "AwaitExpression") awaited = true;
		return delayed && !awaited;
	}
	if (delayed) return true;
	let after = from.range[1];
	// Ancestors that end before `then` starts: the ones that do not hold `then` too.
	for (let cur = from.parent; cur && cur !== fn && cur.range[1] <= to.range[0]; cur = cur.parent) {
		// `first` runs inside an `await` or a `for await` that `then` follows: the test suspends there.
		if (cur.type === "AwaitExpression" || (cur.type === "ForOfStatement" && cur.await === true)) return true;
		// A later iteration of a loop that `then` follows runs the loop's whole body again.
		if (LOOPS.has(cur.type)) after = cur.range[0];
	}
	return awaitsIn(facts, fn, after, to.range[0]);
}

/**
 * Does `registration` run on only some paths of its function, on a branch that does not also hold
 * `write`? `if (cond) onTestFinished(...)` before the write does not cover a write it may not see.
 */
function conditionalTo(registration: Node, write: Node): boolean {
	const fn = enclosingFunction(registration);
	for (let child = registration, cur = registration.parent; cur && cur !== fn; child = cur, cur = cur.parent) {
		// A branch that also holds the write runs with it.
		if (cur.range[0] <= write.range[0] && write.range[1] <= cur.range[1]) return false;
		if (
			((cur.type === "IfStatement" || cur.type === "ConditionalExpression") && child !== cur.test) ||
			(cur.type === "LogicalExpression" && child === cur.right) ||
			(cur.type === "SwitchCase" && child !== cur.test) ||
			(LOOPS.has(cur.type) && child === cur.body) ||
			cur.type === "CatchClause"
		)
			return true;
	}
	return false;
}

/** `spyOn(...)`, `vi.spyOn(...)`, `jest.spyOn(...)`, also through `const watch = vi.spyOn`. */
function isSpyOn(facts: FileFacts, call: Node): boolean {
	let callee = unwrap(node(call.callee));
	if (callee?.type === "Identifier" && callee.name !== "spyOn")
		callee = declaredInit(facts.context, callee, true) ?? callee;
	const name = callee?.type === "MemberExpression" ? propertyName(callee) : identName(callee);
	return name === "spyOn";
}

/** The `spyOn(...)` call an expression starts with: `spyOn(o, "m").mockImplementation(...)`. */
function spyCallIn(facts: FileFacts, expression: Node | undefined): Node | undefined {
	let cur = unwrapAwait(expression);
	while (cur) {
		if (cur.type === "CallExpression") {
			if (isSpyOn(facts, cur)) return cur;
			cur = unwrap(node(cur.callee));
		} else if (cur.type === "MemberExpression") cur = unwrap(node(cur.object));
		else return undefined;
	}
	return undefined;
}

/**
 * The `spyOn(...)` calls that install the spy a `x.mockRestore()` call restores: `const x = spyOn(...)`,
 * `const x = await spyOn(...)`, or `let x; x = spyOn(...)`.
 */
function spyInstalls(facts: FileFacts, call: Node): Node[] {
	const callee = unwrap(node(call.callee));
	const receiver = callee?.type === "MemberExpression" ? unwrap(node(callee.object)) : undefined;
	if (receiver?.type !== "Identifier") return [];
	const variable = variableOf(facts.context, receiver);
	const def = variable?.defs[0];
	if (def?.type !== "Variable") return [];
	const installs = [spyCallIn(facts, node(def.node.init)) ?? []].flat();
	for (const write of facts.assignments) {
		if (write.type !== "AssignmentExpression") continue;
		const left = unwrap(node(write.left));
		if (left?.type !== "Identifier" || variableOf(facts.context, left) !== variable) continue;
		const install = spyCallIn(facts, node(write.right));
		if (install) installs.push(install);
	}
	return installs;
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

/** The functions a hook or `onTestFinished` call registers: inline, or same-file helpers passed by name. */
function registered(facts: FileFacts, call: Node): Node[] {
	const fns: Node[] = [];
	for (const arg of nodes(call.arguments)) {
		if (isFunction(arg)) fns.push(arg);
		const name = identName(arg);
		if (name) for (const [helper, helperName] of facts.helperNames) if (helperName === name) fns.push(helper);
	}
	return fns;
}

/**
 * Does `hook` reach `n` (in `reached`, itself or a helper it calls) before it can suspend? An async
 * hook that awaits first can time out there and skip `n`.
 */
function reachesPromptly(facts: FileFacts, hook: Node, reached: Node, n: Node): boolean {
	const entry =
		reached === hook ? n : (facts.helpers.get(reached) ?? []).find(call => enclosingFunction(call) === hook);
	return !awaitsIn(facts, hook, hook.range[0], entry ? entry.range[0] : hook.range[1]);
}

/** Does `fn`, or a same-file helper it calls, call `restoreAllMocks()` or `mock.restore()` before it can suspend? */
function restoresAll(facts: FileFacts, fn: Node): boolean {
	for (const reached of reachable(facts, fn)) {
		let found = false;
		walk(facts.context, reached, n => {
			if (
				!found &&
				n.type === "CallExpression" &&
				restoreKind(n) === "restoreAll" &&
				enclosingFunction(n) === reached &&
				reachesPromptly(facts, fn, reached, n)
			)
				found = true;
		});
		if (found) return true;
	}
	return false;
}

/**
 * Is the restore reached through `flow` also run by an each-test hook that covers the test? Either
 * the hook restores every mock, or it calls the same helper that holds this restore.
 */
function hookRestores(facts: FileFacts, flow: Flow): boolean {
	return coveringHooks(facts, flow.test).some(
		hook => (flow.via[0] !== undefined && reachable(facts, hook).has(flow.via[0])) || restoresAll(facts, hook),
	);
}

/** Each-test hooks registered in the file scope or in a `describe` that encloses `test`. */
function coveringHooks(facts: FileFacts, test: Node): Node[] {
	const scopes = new Set<Node | undefined>([undefined]);
	for (let cur = enclosingFunction(test); cur; cur = enclosingFunction(cur))
		if (facts.registrations.get(cur)?.kind === "describe") scopes.add(cur);
	const hooks: Node[] = [];
	for (const call of facts.calls) {
		if (!EACH_HOOK_NAMES.has(testApi(facts.context, node(call.callee)) ?? "")) continue;
		if (scopes.has(enclosingFunction(call))) hooks.push(...registered(facts, call));
	}
	return hooks;
}

function callText(facts: FileFacts, call: Node): string {
	const text = facts.context.sourceCode.text.slice(call.range[0], call.range[1]);
	return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function judgeRestores(facts: FileFacts): void {
	for (const call of facts.calls) {
		const kind = restoreKind(call);
		if (!kind) continue;
		for (const flow of flows(facts, call)) {
			const covered = hookRestores(facts, flow);
			let messageId: string | undefined;
			if (isAsyncTest(facts, flow)) {
				const install = kind === "mockRestore" ? spyInstalls(facts, call)[0] : undefined;
				if (!suspendsBefore(facts, flow, call, install)) continue;
				if (kind === "restoreAll") messageId = "restoreAllInAsyncBody";
				else if (!covered) messageId = "restoreSkippedByTimeout";
			} else if (!covered && !inFinally(call, flow.via[0] ?? flow.test)) messageId = "restoreSkippedByThrow";
			if (messageId) {
				facts.context.report({ node: call, messageId, data: { call: callText(facts, call) } });
				break;
			}
		}
	}
	judgeLateRestores(facts);
}

/** Spies installed before an `await` that precedes the `onTestFinished` registering their restore. */
function judgeLateRestores(facts: FileFacts): void {
	const reported = new Set<Node>();
	for (const finisher of facts.finishers) {
		const restores: Node[] = [];
		for (const callback of registered(facts, finisher))
			for (const reached of reachable(facts, callback))
				walk(facts.context, reached, n => {
					if (n.type === "CallExpression" && restoreKind(n)) restores.push(n);
				});
		for (const restore of restores) {
			const installs =
				restoreKind(restore) === "mockRestore"
					? spyInstalls(facts, restore)
					: facts.calls.filter(call => isSpyOn(facts, call));
			for (const install of installs) {
				if (reported.has(install)) continue;
				for (const flow of flows(facts, install)) {
					if (!isAsyncTest(facts, flow) || coveringHooks(facts, flow.test).some(hook => restoresAll(facts, hook)))
						continue;
					const registrations = flows(facts, finisher).filter(f => f.test === flow.test);
					if (registrations.length === 0) continue;
					if (
						registrations.some(
							f => !suspendsBetween(facts, flow, install, f, finisher) && !conditionalTo(finisher, install),
						)
					)
						continue;
					facts.context.report({
						node: install,
						messageId: "restoreRegisteredLate",
						data: { call: callText(facts, restore) },
					});
					reported.add(install);
					break;
				}
			}
		}
	}
}

/** `.key` for a string-literal or plain-identifier key, `[]` for a key the rule cannot read. */
function keySuffix(key: Node | undefined, computed: boolean): string {
	const k = unwrap(key);
	if (!computed && k?.type === "Identifier") return `.${k.name as string}`;
	return k?.type === "Literal" && typeof k.value === "string" ? `.${k.value}` : "[]";
}

/** The places an assignment target or destructuring pattern writes. */
function patternPlaces(target: Node | undefined): Place[] {
	const n = unwrap(target);
	if (!n) return [];
	if (n.type === "MemberExpression") return [memberPath(n) ?? []].flat();
	if (n.type === "ArrayPattern") return nodes(n.elements).flatMap(patternPlaces);
	if (n.type === "ObjectPattern")
		return nodes(n.properties).flatMap(p => patternPlaces(node(p.type === "RestElement" ? p.argument : p.value)));
	if (n.type === "AssignmentPattern") return patternPlaces(node(n.left));
	if (n.type === "RestElement") return patternPlaces(node(n.argument));
	return [];
}

/** `Object.x(...)` or `Reflect.x(...)`, also through `const define = Object.defineProperty`. */
function builtinMethod(facts: FileFacts, callee: Node | undefined): { object: string; method: string } | undefined {
	let c = unwrap(callee);
	if (c?.type === "Identifier") c = declaredInit(facts.context, c, true);
	if (c?.type !== "MemberExpression") return undefined;
	const object = identName(unwrap(node(c.object)));
	const method = propertyName(c);
	if ((object !== "Object" && object !== "Reflect") || !method) return undefined;
	return { object, method };
}

/**
 * The places a write replaces: an assignment, `delete`, `++`/`--`, a `for (x.y of ...)` target,
 * `Object.defineProperty/defineProperties`, `Object.assign`, or `Reflect.set/defineProperty/deleteProperty`.
 */
function writtenPlaces(facts: FileFacts, n: Node): Place[] {
	if (n.type === "AssignmentExpression") return patternPlaces(node(n.left));
	if (n.type === "ForOfStatement" || n.type === "ForInStatement") return patternPlaces(node(n.left));
	if ((n.type === "UnaryExpression" && n.operator === "delete") || n.type === "UpdateExpression") {
		const target = unwrap(node(n.argument));
		return target?.type === "MemberExpression" ? [memberPath(target) ?? []].flat() : [];
	}
	if (n.type !== "CallExpression") return [];
	const builtin = builtinMethod(facts, node(n.callee));
	if (!builtin) return [];
	const { object, method } = builtin;
	const [owner, key, ...rest] = nodes(n.arguments);
	const ownerPath = memberPath(owner);
	if (!ownerPath) return [];
	const at = (suffix: string): Place => ({ root: ownerPath.root, path: `${ownerPath.path}${suffix}` });
	if (method === "defineProperty" || (object === "Reflect" && (method === "set" || method === "deleteProperty")))
		return [at(keySuffix(key, true))];
	if (object !== "Object" || (method !== "assign" && method !== "defineProperties")) return [];
	// Each source object's keys: listed by an object literal, or unknown (`[]`) for anything else.
	return (method === "assign" ? [key, ...rest] : [key]).flatMap(source => {
		const literal = unwrap(source);
		if (literal?.type !== "ObjectExpression") return [at("[]")];
		return nodes(literal.properties).map(p =>
			at(p.type === "Property" ? keySuffix(node(p.key), p.computed === true) : "[]"),
		);
	});
}

/**
 * The places a place really names: through `const g = globalThis` aliases, and through a same-file
 * helper's parameter to what each caller passes (`install(globalThis)` for `install(target)`).
 */
function resolvePlaces(facts: FileFacts, place: Place, depth = 0): Place[] {
	if (depth >= ALIAS_DEPTH) return [place];
	const rootName = place.root.name as string;
	const rest = place.path.slice(rootName.length);
	const aliased = memberPath(declaredInit(facts.context, place.root, true));
	if (aliased && aliased.root !== place.root)
		return resolvePlaces(facts, { root: aliased.root, path: `${aliased.path}${rest}` }, depth + 1);
	const def = variableOf(facts.context, place.root)?.defs[0];
	if (def?.type === "Parameter") {
		const index = nodes(def.node.params).findIndex(param => identName(param) === rootName);
		if (index >= 0)
			return (facts.helpers.get(def.node) ?? []).flatMap(call => {
				const argument = memberPath(nodes(call.arguments)[index]);
				return argument
					? resolvePlaces(facts, { root: argument.root, path: `${argument.path}${rest}` }, depth + 1)
					: [];
			});
	}
	return [place];
}

/** The shared property a written place names, or undefined when it is test-local. */
function sharedTarget(facts: FileFacts, path: Place): string | undefined {
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

/** The shared properties a write replaces; empty when it writes only test-local state. */
function sharedTargets(facts: FileFacts, n: Node): string[] {
	return writtenPlaces(facts, n)
		.flatMap(place => resolvePlaces(facts, place))
		.flatMap(place => sharedTarget(facts, place) ?? []);
}

/**
 * Does `write` put back a value saved from the same place: `const original = x.y; ... x.y = original`,
 * or `Object.defineProperty(o, "k", saved)` with `saved = Object.getOwnPropertyDescriptor(o, "k")`?
 */
function restoresSaved(facts: FileFacts, write: Node, path: string): boolean {
	let value: Node | undefined;
	if (write.type === "AssignmentExpression") value = unwrap(node(write.right));
	else if (write.type === "CallExpression" && builtinMethod(facts, node(write.callee))?.method === "defineProperty")
		value = unwrap(nodes(write.arguments)[2]);
	if (value?.type !== "Identifier") return false;
	const saved = declaredInit(facts.context, value, true);
	if (!saved) return false;
	let read = memberPath(saved);
	if (
		saved.type === "CallExpression" &&
		builtinMethod(facts, node(saved.callee))?.method === "getOwnPropertyDescriptor"
	) {
		const [owner, key] = nodes(saved.arguments);
		const ownerPath = memberPath(owner);
		read = ownerPath && { root: ownerPath.root, path: `${ownerPath.path}${keySuffix(key, true)}` };
	}
	return read !== undefined && resolvePlaces(facts, read).some(place => sharedTarget(facts, place) === path);
}

/** Shared paths `fn` writes, itself or through the same-file helpers it calls. */
function written(facts: FileFacts, fn: Node): Set<string> {
	let paths = facts.written.get(fn);
	if (!paths) {
		const found = new Set<string>();
		for (const reached of reachable(facts, fn))
			walk(facts.context, reached, n => {
				for (const path of sharedTargets(facts, n)) found.add(path);
			});
		facts.written.set(fn, found);
		paths = found;
	}
	return paths;
}

/** Does a write of `paths` put `path` back? A write to an unknown key of the same object does. */
function putsBack(paths: Set<string>, path: string): boolean {
	return paths.has(path) || paths.has(path.replace(/(\.[^.[\]]+|\[\])$/, "[]"));
}

/** Does `hook`, itself or through a same-file helper it calls, put `path` back before it can suspend? */
function hookPutsBack(facts: FileFacts, hook: Node, path: string): boolean {
	for (const reached of reachable(facts, hook)) {
		let found = false;
		walk(facts.context, reached, n => {
			if (found || enclosingFunction(n) !== reached) return;
			if (putsBack(new Set(sharedTargets(facts, n)), path) && reachesPromptly(facts, hook, reached, n)) found = true;
		});
		if (found) return true;
	}
	return false;
}

/** `onTestFinished` registrations in `flow`'s test whose callback puts `path` back. */
function finishedPutBacks(facts: FileFacts, flow: Flow, path: string): { call: Node; flow: Flow }[] {
	const found: { call: Node; flow: Flow }[] = [];
	for (const call of facts.finishers) {
		if (!registered(facts, call).some(fn => putsBack(written(facts, fn), path))) continue;
		for (const f of flows(facts, call)) if (f.test === flow.test) found.push({ call, flow: f });
	}
	return found;
}

function judgePutBacks(facts: FileFacts): void {
	const byFunction = new Map<Node, { node: Node; path: string }[]>();
	for (const write of [...facts.assignments, ...facts.calls]) {
		const fn = enclosingFunction(write);
		if (!fn) continue;
		for (const path of sharedTargets(facts, write))
			byFunction.set(fn, [...(byFunction.get(fn) ?? []), { node: write, path }]);
	}
	const reported = new Set<Node>();
	for (const [fn, writes] of byFunction) {
		for (const write of writes) {
			if (reported.has(write.node)) continue;
			const replaced = writes.find(other => other.path === write.path && other.node.range[0] < write.node.range[0]);
			const putBack =
				replaced !== undefined || inFinally(write.node, fn) || restoresSaved(facts, write.node, write.path);
			for (const flow of flows(facts, write.node)) {
				if (!isAsyncTest(facts, flow)) continue;
				if (coveringHooks(facts, flow.test).some(hook => hookPutsBack(facts, hook, write.path))) continue;
				const registrations = finishedPutBacks(facts, flow, write.path);
				let messageId: string | undefined;
				if (putBack) {
					// A registered put-back covers this one; whether it was registered in time is judged at
					// the replacement.
					if (registrations.length === 0 && suspendsBefore(facts, flow, write.node, replaced?.node))
						messageId = "putBackSkippedByTimeout";
				} else {
					const late = registrations.filter(r => suspendsBetween(facts, flow, write.node, r.flow, r.call));
					// A registration on a branch the write may not share does not cover it either.
					if (late.length > 0 && registrations.every(r => late.includes(r) || conditionalTo(r.call, write.node)))
						messageId = "putBackRegisteredLate";
				}
				if (messageId) {
					facts.context.report({ node: write.node, messageId, data: { target: write.path } });
					reported.add(write.node);
					break;
				}
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
				restoreRegisteredLate:
					"The test can time out after installing this spy but before it registers the `onTestFinished` that runs `{{call}}`, so the spy leaks into later tests. Register the restore before the first `await` after the spy, or restore in `afterEach`.",
			},
			judgeRestores,
		),
		"put-back-on-test-finished": rule(
			"Put a replaced shared property back in onTestFinished, where a test timeout cannot skip it.",
			{
				putBackSkippedByTimeout:
					"A test that times out never reaches this put-back of `{{target}}`, so the replacement leaks into later tests. Register the put-back with `onTestFinished(() => ...)`, which runs even after a timeout.",
				putBackRegisteredLate:
					"The test can time out after this write to `{{target}}` but before it registers the `onTestFinished` that puts it back, so the replacement leaks into later tests. Register the put-back before the write, or at least before the first `await` after it.",
			},
			judgePutBacks,
		),
	},
};
