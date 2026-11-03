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
 * Cleanup that survives a timeout is cleanup a timeout cannot interrupt: the shared, synchronous
 * `installMockRestores()` helper for spies, a synchronous `afterEach` that restores or puts back as
 * a direct statement, or `onTestFinished(<synchronous callback>)` registered before the test can
 * suspend. The rules credit only those shapes. They are an enforcement aid for new code, not a
 * proof: a shape they credit is safe by construction, and everything else is reported.
 *
 * The rules judge only what one file shows: writes and restores reached from a test body directly
 * or through a function declared in the same file, and hooks declared in the same file.
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
const HOOK_NAMES = new Set(["afterEach", "beforeEach", "afterAll", "beforeAll"]);
const TEST_MODULES = new Set(["bun:test", "vitest"]);
/** The shared synchronous restore helper every package's tests import. */
const RESTORE_HELPER_NAME = "installMockRestores";
const RESTORE_HELPER_MODULE = /(^|\/)helpers\/mock-restores(\.ts)?$/;
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

function stringValue(n: Node | undefined): string | undefined {
	const value = unwrap(n);
	return value?.type === "Literal" && typeof value.value === "string" ? value.value : undefined;
}

/** A written place: the identifier a member chain starts at, and the chain's dotted path. */
interface Place {
	root: Node;
	path: string;
}

/**
 * Dotted path of a member chain rooted at an identifier: `globalThis.fetch`, `process.stdout.isTTY`.
 * A computed key is read when it is a string literal or a `const` bound to one.
 */
function memberPath(context: RuleContext, value: Node | undefined): Place | undefined {
	const n = unwrap(value);
	if (!n) return undefined;
	if (n.type === "Identifier") return { root: n, path: n.name as string };
	if (n.type !== "MemberExpression") return undefined;
	const object = memberPath(context, node(n.object));
	if (!object) return undefined;
	const name = propertyName(n) ?? constantKey(context, node(n.property));
	return { root: object.root, path: `${object.path}${name === undefined ? "[]" : `.${name}`}` };
}

/** The name a computed key reads: `"fetch"`, or `key` declared as `const key = "fetch"`. */
function constantKey(context: RuleContext, key: Node | undefined): string | undefined {
	const k = unwrap(key);
	if (!k) return undefined;
	const literal = stringValue(k);
	if (literal !== undefined) return literal;
	return k.type === "Identifier" ? stringValue(declaredInit(context, k, true)) : undefined;
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

/** The function an identifier is bound to: a declaration or an immutable `const` initializer. */
function functionOf(context: RuleContext, id: Node): Node | undefined {
	const def = variableOf(context, id)?.defs[0];
	if (!def) return undefined;
	if (def.type === "FunctionName") return def.node;
	if (def.node.type === "FunctionDeclaration") return def.node;
	if (def.type !== "Variable" || def.parent?.kind !== "const") return undefined;
	const init = unwrap(node(def.node.init));
	return isFunction(init) ? init : undefined;
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
	/** Same-file function (or returned cleanup method) -> the calls that invoke it, resolved by binding. */
	helpers: Map<Node, Node[]>;
	/** `onTestFinished(...)` calls. */
	finishers: Node[];
	/** Flows of a node at depth 0, and the shared paths a node writes; filled on first use. */
	flowCache: Map<Node, Flow[]>;
	targetCache: Map<Node, string[]>;
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
	const declaredFunctions = new Set<Node>();
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
		if (isFunction(n) && (n.type === "FunctionDeclaration" || n.parent?.type === "VariableDeclarator"))
			declaredFunctions.add(n);
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
	// Each call is joined to the function its callee identifier is bound to, so a shadowing local
	// function is never mistaken for an outer one of the same name.
	for (const call of calls) {
		const callee = unwrap(node(call.callee));
		if (callee?.type !== "Identifier") continue;
		const fn = functionOf(context, callee);
		if (fn) helpers.set(fn, [...(helpers.get(fn) ?? []), call]);
	}
	// `function install() { ...; return { restore() { ... } }; }`: `patch.restore()` on
	// `const patch = install()` runs that method.
	const methods = new Map<Node, Map<string, Node>>();
	for (const fn of declaredFunctions) {
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
		const callee2 = init?.type === "CallExpression" ? unwrap(node(init.callee)) : undefined;
		const producer = callee2?.type === "Identifier" ? functionOf(context, callee2) : undefined;
		const method = producer ? methods.get(producer)?.get(key) : undefined;
		if (method) helpers.set(method, [...(helpers.get(method) ?? []), call]);
	}
	return {
		context,
		calls,
		assignments,
		registrations,
		helpers,
		finishers,
		flowCache: new Map(),
		targetCache: new Map(),
	};
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
	const cached = depth === 0 ? facts.flowCache.get(n) : undefined;
	if (cached) return cached;
	const found = walkFlows(facts, n, depth, via, calls);
	if (depth === 0) facts.flowCache.set(n, found);
	return found;
}

function walkFlows(facts: FileFacts, n: Node, depth: number, via: Node[], calls: Node[]): Flow[] {
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
function insideAwait(n: Node, fn: Node | undefined): boolean {
	for (let cur = n.parent; cur && cur !== fn; cur = cur.parent) if (cur.type === "AwaitExpression") return true;
	return false;
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

/** A cleanup call must itself be an expression statement, not part of another expression. */
function directCallStatement(n: Node): Node | undefined {
	const statement = n.parent;
	return statement?.type === "ExpressionStatement" && node(statement.expression) === n ? statement : undefined;
}

/**
 * Is `call` a direct top-level statement of the file or a describe callback body, with no
 * `return`/`throw`/`break`/`continue` before it in that callback?
 */
function isTopLevelStatement(facts: FileFacts, call: Node, scope: Node | undefined): boolean {
	const statement = directCallStatement(call);
	const list = statement?.parent;
	if (!statement || !list) return false;
	if (scope === undefined) return list.type === "Program";
	return node(scope.body) === list && !exitsBefore(facts, scope, statement);
}

/** The file scope and every `describe` that encloses `test`. */
function coveringScopes(facts: FileFacts, test: Node): (Node | undefined)[] {
	const scopes: (Node | undefined)[] = [undefined];
	for (let cur = enclosingFunction(test); cur; cur = enclosingFunction(cur))
		if (facts.registrations.get(cur)?.kind === "describe") scopes.push(cur);
	return scopes;
}

/** Does `scope` call the shared synchronous restore helper unconditionally at its top level? */
function callsRestoreHelper(facts: FileFacts, scope: Node | undefined): boolean {
	return facts.calls.some(call => {
		const callee = unwrap(node(call.callee));
		if (identName(callee) !== RESTORE_HELPER_NAME) return false;
		const def = variableOf(facts.context, callee!)?.defs[0];
		if (def?.type !== "ImportBinding") return false;
		const source = node((def.parent ?? def.node.parent)?.source);
		if (typeof source?.value !== "string" || !RESTORE_HELPER_MODULE.test(source.value)) return false;
		return enclosingFunction(call) === scope && isTopLevelStatement(facts, call, scope);
	});
}

/**
 * Does `statement`, a direct statement of `fn`'s body, do `work` with no exit before it? With
 * `branches`, an `if` with an `else` also counts when each branch (a block or a single statement)
 * does `work` as its own direct statement: `if (saved === undefined) delete x.y; else x.y = saved;`.
 * A missing `else`, an `else if`, a write nested deeper in a branch, or an exit before it gives nothing.
 */
function statementDoes(
	facts: FileFacts,
	fn: Node,
	statement: Node,
	work: (expression: Node) => boolean,
	branches: boolean,
): boolean {
	const direct = (s: Node): boolean => {
		const expression = s.type === "ExpressionStatement" ? node(s.expression) : undefined;
		return expression !== undefined && work(expression) && !exitsBefore(facts, fn, s);
	};
	if (direct(statement)) return true;
	if (!branches || statement.type !== "IfStatement") return false;
	return [node(statement.consequent), node(statement.alternate)].every(branch => {
		if (!branch) return false;
		return (branch.type === "BlockStatement" ? nodes(branch.body) : [branch]).some(direct);
	});
}

/**
 * Does a synchronous top-level `afterEach` of `scope` do `work` as a direct statement before any
 * exit? `branches` also credits an exhaustive `if/else` ({@link statementDoes}).
 */
function afterEachDoes(
	facts: FileFacts,
	scope: Node | undefined,
	work: (expression: Node) => boolean,
	branches = false,
): boolean {
	for (const call of facts.calls) {
		if (testApi(facts.context, node(call.callee)) !== "afterEach") continue;
		if (enclosingFunction(call) !== scope || !isTopLevelStatement(facts, call, scope)) continue;
		for (const hook of registered(facts, call)) {
			if (hook.async === true) continue;
			const body = node(hook.body);
			if (!body) continue;
			// `afterEach(() => vi.restoreAllMocks())`: the expression body is the whole hook.
			if (body.type !== "BlockStatement") {
				if (work(body)) return true;
				continue;
			}
			if (nodes(body.body).some(statement => statementDoes(facts, hook, statement, work, branches))) return true;
		}
	}
	return false;
}

/** Does `fn` itself (not a nested function) `return`/`throw`/`break`/`continue` anywhere before `at`? */
function exitsBefore(facts: FileFacts, fn: Node, at: Node): boolean {
	let found = false;
	walk(facts.context, fn, n => {
		if (
			!found &&
			enclosingFunction(n) === fn &&
			n.range[0] < at.range[0] &&
			(n.type === "ReturnStatement" ||
				n.type === "ThrowStatement" ||
				n.type === "BreakStatement" ||
				n.type === "ContinueStatement")
		)
			found = true;
	});
	return found;
}

/**
 * A call that looks like a mock restore by its method name. The rule reports such a call in a
 * test body by name, so a look-alike is judged too; only {@link realRestoreKind} earns credit.
 */
function restoreKind(call: Node): "restoreAll" | "mockRestore" | undefined {
	const callee = unwrap(node(call.callee));
	if (callee?.type !== "MemberExpression") return undefined;
	const name = propertyName(callee);
	if (name === "mockRestore") return "mockRestore";
	if (name === "restoreAllMocks") return "restoreAll";
	if (name === "restore" && identName(unwrap(node(callee.object))) === "mock") return "restoreAll";
	return undefined;
}

/**
 * A restore that provably reaches the test framework: `restoreAllMocks()` / `mock.restore()` on a
 * `vi`, `jest` or `mock` bound to the bun:test (or vitest) import or the test global, or
 * `mockRestore()` on a variable a recognised `spyOn(...)` installs.
 */
function realRestoreKind(facts: FileFacts, call: Node): "restoreAll" | "mockRestore" | undefined {
	const kind = restoreKind(call);
	if (kind === "mockRestore") return spyInstalls(facts, call).length > 0 ? kind : undefined;
	if (kind !== "restoreAll") return undefined;
	const receiver = unwrap(node(unwrap(node(call.callee))!.object));
	if (receiver?.type !== "Identifier") return undefined;
	const api = testApiName(facts.context, receiver);
	return api === "vi" || api === "jest" || api === "mock" ? kind : undefined;
}

/**
 * Is every spy this test installs restored by cleanup a timeout cannot skip: the shared helper, or a
 * synchronous top-level `afterEach` that calls the real restore API?
 */
function spiesCovered(facts: FileFacts, test: Node): boolean {
	return coveringScopes(facts, test).some(
		scope =>
			callsRestoreHelper(facts, scope) ||
			afterEachDoes(facts, scope, expression => {
				const call = unwrap(expression);
				return call?.type === "CallExpression" && realRestoreKind(facts, call) === "restoreAll";
			}),
	);
}

/** Does a synchronous top-level `afterEach` of a covering scope put `path` back? */
function hookPutsBack(facts: FileFacts, test: Node, path: string): boolean {
	return coveringScopes(facts, test).some(scope =>
		afterEachDoes(facts, scope, expression => sharedTargets(facts, expression).includes(path), true),
	);
}

/** `spyOn(...)`, `vi.spyOn(...)`, `jest.spyOn(...)`, also `const watch = vi.spyOn` and `const { spyOn: watch } = vi`. */
function isSpyOn(facts: FileFacts, call: Node): boolean {
	const callee = unwrap(node(call.callee));
	if (callee?.type === "MemberExpression") return propertyName(callee) === "spyOn";
	if (callee?.type !== "Identifier") return false;
	if (callee.name === "spyOn") return true;
	const def = variableOf(facts.context, callee)?.defs[0];
	if (def?.type !== "Variable" || def.parent?.kind !== "const") return false;
	// `const watch = vi.spyOn`
	const init = unwrapAwait(node(def.node.init));
	if (init?.type === "MemberExpression" && propertyName(init) === "spyOn") return true;
	// `const { spyOn: watch } = vi`
	return destructuredKey(def.node, callee.name as string) === "spyOn";
}

/** The object-pattern key a declarator binds to `name`: `spyOn` for `const { spyOn: watch } = vi`. */
function destructuredKey(declarator: Node, name: string): string | undefined {
	const pattern = unwrap(node(declarator.id));
	if (pattern?.type !== "ObjectPattern") return undefined;
	for (const property of nodes(pattern.properties)) {
		if (property.type !== "Property" || identName(property.value) !== name) continue;
		return keyName(property);
	}
	return undefined;
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

/** The functions a hook or `onTestFinished` call registers: inline, or same-file functions passed by name. */
function registered(facts: FileFacts, call: Node): Node[] {
	return nodes(call.arguments).flatMap(arg => {
		if (isFunction(arg)) return [arg];
		const id = unwrap(arg);
		const fn = id?.type === "Identifier" ? functionOf(facts.context, id) : undefined;
		return fn ? [fn] : [];
	});
}

/** The restore calls, recognised by method name, inside the callbacks `finisher` registers. */
function registeredRestores(facts: FileFacts, finisher: Node): Node[] {
	const found: Node[] = [];
	for (const callback of registered(facts, finisher))
		walk(facts.context, callback, n => {
			if (n.type === "CallExpression" && restoreKind(n)) found.push(n);
		});
	return found;
}

/**
 * A synchronous callback whose direct statement does `done` with no exit before it. `branches`
 * also credits an exhaustive `if/else` ({@link statementDoes}).
 */
function promptCallback(
	facts: FileFacts,
	finisher: Node,
	done: (expression: Node) => boolean,
	branches = false,
): boolean {
	return registered(facts, finisher).some(callback => {
		if (callback.async === true) return false;
		const body = node(callback.body);
		if (!body) return false;
		if (body.type !== "BlockStatement") return done(body);
		return nodes(body.body).some(statement => statementDoes(facts, callback, statement, done, branches));
	});
}

/**
 * A registration must itself be a direct statement in a block that contains the target after it,
 * with no `return`/`throw`/`break`/`continue` before it in its function.
 */
function registeredBefore(facts: FileFacts, finisher: Node, target: Node): boolean {
	const statement = directCallStatement(finisher);
	const list = statement?.parent;
	const fn = enclosingFunction(finisher);
	if (!statement || !list || fn !== enclosingFunction(target)) return false;
	if (fn && exitsBefore(facts, fn, statement)) return false;
	return statement.range[1] <= target.range[0] && list.range[0] <= target.range[0] && target.range[1] <= list.range[1];
}

/** Is `finisher` the direct statement right after an await-free install statement? */
function registeredNextTo(facts: FileFacts, finisher: Node, install: Node): boolean {
	const registration = directCallStatement(finisher);
	let installed: Node | undefined = install;
	while (
		installed?.parent &&
		installed.parent.type !== "ExpressionStatement" &&
		installed.parent.type !== "VariableDeclaration"
	) {
		if (isFunction(installed.parent)) return false;
		installed = installed.parent;
	}
	const statement = installed?.parent;
	const list = registration?.parent;
	if (!registration || !statement || !list || statement.parent !== list) return false;
	const fn = enclosingFunction(finisher);
	if (fn && exitsBefore(facts, fn, registration)) return false;
	let hasAwait = false;
	walk(facts.context, statement, n => {
		if (n.type === "AwaitExpression" && enclosingFunction(n) === enclosingFunction(install)) hasAwait = true;
	});
	if (hasAwait) return false;
	const statements = nodes(list.body);
	return statements.indexOf(registration) === statements.indexOf(statement) + 1;
}

/** Does a synchronous `onTestFinished` registered before the test can suspend restore `install`? */
function spyRegisteredPromptly(facts: FileFacts, install: Node): boolean {
	return facts.finishers.some(finisher => {
		if (!registeredBefore(facts, finisher, install) && !registeredNextTo(facts, finisher, install)) return false;
		return promptCallback(facts, finisher, expression => {
			const call = unwrap(expression);
			if (call?.type !== "CallExpression") return false;
			const kind = realRestoreKind(facts, call);
			if (kind === "restoreAll") return true;
			return kind === "mockRestore" && spyInstalls(facts, call).includes(install);
		});
	});
}

/** Does a synchronous `onTestFinished` registered before `write` put `path` back? */
function putBackRegisteredPromptly(facts: FileFacts, path: string, write: Node): boolean {
	return facts.finishers.some(
		finisher =>
			registeredBefore(facts, finisher, write) &&
			promptCallback(facts, finisher, expression => sharedTargets(facts, expression).includes(path), true),
	);
}

/** Is a put-back of `path` registered anywhere in `test`, however late or conditionally? */
function putBackRegisteredAnywhere(facts: FileFacts, test: Node, path: string): boolean {
	return facts.finishers.some(finisher => {
		if (!flows(facts, finisher).some(flow => flow.test === test)) return false;
		return registered(facts, finisher).some(callback => {
			let found = false;
			walk(facts.context, callback, n => {
				if (!found && sharedTargets(facts, n).includes(path)) found = true;
			});
			return found;
		});
	});
}

function callText(facts: FileFacts, call: Node): string {
	const text = facts.context.sourceCode.text.slice(call.range[0], call.range[1]);
	return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function judgeRestores(facts: FileFacts): void {
	for (const call of facts.calls) {
		const kind = restoreKind(call);
		if (!kind) continue;
		const installs = kind === "mockRestore" ? spyInstalls(facts, call) : [];
		for (const flow of flows(facts, call)) {
			let messageId: string | undefined;
			if (isAsyncTest(facts, flow)) {
				if (!suspendsBefore(facts, flow, call, installs[0])) continue;
				// `restoreAllMocks()` in an async body also removes a later test's mocks when the
				// abandoned body resumes, so a covering hook does not make it safe.
				if (kind === "restoreAll") messageId = "restoreAllInAsyncBody";
				else if (
					!spiesCovered(facts, flow.test) &&
					!installs.some(install => spyRegisteredPromptly(facts, install))
				)
					messageId = "restoreSkippedByTimeout";
			} else if (!spiesCovered(facts, flow.test) && !inFinally(call, flow.via[0] ?? flow.test))
				messageId = "restoreSkippedByThrow";
			if (messageId) {
				facts.context.report({ node: call, messageId, data: { call: callText(facts, call) } });
				break;
			}
		}
	}
	judgeLateRestores(facts);
}

/** Spies whose restore is registered where a timeout can skip the registration itself. */
function judgeLateRestores(facts: FileFacts): void {
	const reported = new Set<Node>();
	for (const finisher of facts.finishers) {
		for (const restore of registeredRestores(facts, finisher)) {
			const installs =
				restoreKind(restore) === "mockRestore"
					? spyInstalls(facts, restore)
					: facts.calls.filter(call => isSpyOn(facts, call));
			for (const install of installs) {
				if (reported.has(install)) continue;
				if (spyRegisteredPromptly(facts, install)) continue;
				for (const flow of flows(facts, install)) {
					if (!isAsyncTest(facts, flow) || spiesCovered(facts, flow.test)) continue;
					if (!flows(facts, finisher).some(f => f.test === flow.test)) continue;
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

/** The places an assignment target or destructuring pattern writes. */
function patternPlaces(context: RuleContext, target: Node | undefined): Place[] {
	const n = unwrap(target);
	if (!n) return [];
	if (n.type === "MemberExpression") return [memberPath(context, n) ?? []].flat();
	if (n.type === "ArrayPattern") return nodes(n.elements).flatMap(element => patternPlaces(context, element));
	if (n.type === "ObjectPattern")
		return nodes(n.properties).flatMap(p =>
			patternPlaces(context, node(p.type === "RestElement" ? p.argument : p.value)),
		);
	if (n.type === "AssignmentPattern") return patternPlaces(context, node(n.left));
	if (n.type === "RestElement") return patternPlaces(context, node(n.argument));
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
	const context = facts.context;
	if (n.type === "AssignmentExpression") return patternPlaces(context, node(n.left));
	if (n.type === "ForOfStatement" || n.type === "ForInStatement") return patternPlaces(context, node(n.left));
	if ((n.type === "UnaryExpression" && n.operator === "delete") || n.type === "UpdateExpression") {
		const target = unwrap(node(n.argument));
		return target?.type === "MemberExpression" ? [memberPath(context, target) ?? []].flat() : [];
	}
	if (n.type !== "CallExpression") return [];
	const builtin = builtinMethod(facts, node(n.callee));
	if (!builtin) return [];
	const { object, method } = builtin;
	const [owner, key, ...rest] = nodes(n.arguments);
	const ownerPath = memberPath(context, owner);
	if (!ownerPath) return [];
	const at = (suffix: string): Place => ({ root: ownerPath.root, path: `${ownerPath.path}${suffix}` });
	const keyed = (k: Node | undefined): string => {
		const name = constantKey(context, k);
		return name === undefined ? "[]" : `.${name}`;
	};
	if (method === "defineProperty" || (object === "Reflect" && (method === "set" || method === "deleteProperty")))
		return [at(keyed(key))];
	if (object !== "Object" || (method !== "assign" && method !== "defineProperties")) return [];
	// Each source object's keys: listed by an object literal, or unknown (`[]`) for anything else.
	return (method === "assign" ? [key, ...rest] : [key]).flatMap(source => {
		const literal = unwrap(source);
		if (literal?.type !== "ObjectExpression") return [at("[]")];
		return nodes(literal.properties).map(p =>
			at(p.type !== "Property" ? "[]" : p.computed === true ? keyed(node(p.key)) : `.${keyName(p) ?? ""}`),
		);
	});
}

/**
 * The places a place really names: through `const g = globalThis` and `const { process: p } = globalThis`
 * aliases, and through a same-file helper's parameter to what each caller passes.
 */
function resolvePlaces(facts: FileFacts, place: Place, depth = 0): Place[] {
	if (depth >= ALIAS_DEPTH) return [place];
	const rootName = place.root.name as string;
	const rest = place.path.slice(rootName.length);
	const def = variableOf(facts.context, place.root)?.defs[0];
	if (def?.type === "Variable" && def.parent?.kind === "const") {
		const key = destructuredKey(def.node, rootName);
		const source = memberPath(facts.context, unwrapAwait(node(def.node.init)));
		if (source && source.root !== place.root)
			return resolvePlaces(
				facts,
				{ root: source.root, path: `${source.path}${key === undefined ? "" : `.${key}`}${rest}` },
				depth + 1,
			);
	}
	if (def?.type === "Parameter") {
		const index = nodes(def.node.params).findIndex(param => identName(param) === rootName);
		if (index >= 0)
			return (facts.helpers.get(def.node) ?? []).flatMap(call => {
				const argument = memberPath(facts.context, nodes(call.arguments)[index]);
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
	return path.path;
}

/** The shared properties a write replaces; empty when it writes only test-local state. */
function sharedTargets(facts: FileFacts, n: Node): string[] {
	let found = facts.targetCache.get(n);
	if (!found) {
		found = writtenPlaces(facts, n)
			.flatMap(place => resolvePlaces(facts, place))
			.flatMap(place => sharedTarget(facts, place) ?? []);
		facts.targetCache.set(n, found);
	}
	return found;
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
	let read = memberPath(facts.context, saved);
	if (
		saved.type === "CallExpression" &&
		builtinMethod(facts, node(saved.callee))?.method === "getOwnPropertyDescriptor"
	) {
		const [owner, key] = nodes(saved.arguments);
		const ownerPath = memberPath(facts.context, owner);
		const name = constantKey(facts.context, key);
		read = ownerPath && { root: ownerPath.root, path: `${ownerPath.path}${name === undefined ? "[]" : `.${name}`}` };
	}
	return read !== undefined && resolvePlaces(facts, read).some(place => sharedTarget(facts, place) === path);
}

function judgePutBacks(facts: FileFacts): void {
	const writes: { node: Node; path: string; putsBack: boolean; replaced?: Node }[] = [];
	for (const write of [...facts.assignments, ...facts.calls])
		for (const path of sharedTargets(facts, write)) writes.push({ node: write, path, putsBack: false });
	writes.sort((a, b) => a.node.range[0] - b.node.range[0]);
	for (const write of writes) {
		const fn = enclosingFunction(write.node);
		if (!fn) continue;
		write.replaced = writes.find(
			other =>
				other.path === write.path &&
				enclosingFunction(other.node) === fn &&
				other.node.range[0] < write.node.range[0],
		)?.node;
		write.putsBack =
			write.replaced !== undefined || inFinally(write.node, fn) || restoresSaved(facts, write.node, write.path);
	}
	// What a registration has to precede is the write that replaces the value. A put-back the body
	// also runs is covered by the registration that already precedes that replacement.
	const replacement = new Map<string, Node>();
	for (const write of writes) {
		if (write.putsBack) continue;
		for (const flow of flows(facts, write.node)) {
			const key = `${flow.test.range[0]}|${write.path}`;
			const earlier = replacement.get(key);
			if (!earlier || write.node.range[0] < earlier.range[0]) replacement.set(key, write.node);
		}
	}
	const reported = new Set<string>();
	for (const write of writes) {
		if (!enclosingFunction(write.node) || reported.has(`node|${write.node.range[0]}`)) continue;
		for (const flow of flows(facts, write.node)) {
			if (!isAsyncTest(facts, flow)) continue;
			const key = `${flow.test.range[0]}|${write.path}`;
			if (reported.has(key)) break;
			if (hookPutsBack(facts, flow.test, write.path)) continue;
			const replaces = write.putsBack ? (replacement.get(key) ?? write.node) : write.node;
			if (putBackRegisteredPromptly(facts, write.path, replaces)) continue;
			let messageId: string | undefined;
			if (write.putsBack) {
				if (suspendsBefore(facts, flow, write.node, write.replaced)) messageId = "putBackSkippedByTimeout";
			} else if (putBackRegisteredAnywhere(facts, flow.test, write.path)) messageId = "putBackRegisteredLate";
			if (!messageId) continue;
			facts.context.report({ node: write.node, messageId, data: { target: write.path } });
			reported.add(key);
			reported.add(`node|${write.node.range[0]}`);
			break;
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
			"Restore mocks where a test timeout cannot skip the restore.",
			{
				restoreSkippedByTimeout:
					"A test that times out never reaches `{{call}}`, so the mock leaks into later tests. Call `installMockRestores()` at the top of this file or `describe`, or register the restore with `onTestFinished(...)` right after the spy.",
				restoreAllInAsyncBody:
					"`{{call}}` in an async test body runs late if the test times out, and then removes the mocks a later test installed. Call `installMockRestores()` at the top of this file or `describe` instead.",
				restoreSkippedByThrow:
					"A failing assertion before `{{call}}` skips it, so the mock leaks into later tests. Restore in `finally`, or call `installMockRestores()` at the top of this file or `describe`.",
				restoreRegisteredLate:
					"The test can time out after installing this spy but before it registers the `onTestFinished` that runs `{{call}}`, so the spy leaks into later tests. Register the restore in the statement right after the spy, or call `installMockRestores()` at the top of this file or `describe`.",
			},
			judgeRestores,
		),
		"put-back-on-test-finished": rule(
			"Put a replaced shared property back where a test timeout cannot skip the put-back.",
			{
				putBackSkippedByTimeout:
					"A test that times out never reaches this put-back of `{{target}}`, so the replacement leaks into later tests. Register it with `onTestFinished(() => ...)` before the write, or put it back in a synchronous `afterEach`.",
				putBackRegisteredLate:
					"The test can time out after this write to `{{target}}` but before it registers the `onTestFinished` that puts it back, so the replacement leaks into later tests. Register the put-back before the write.",
			},
			judgePutBacks,
		),
	},
};
