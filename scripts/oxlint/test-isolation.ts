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
 * `installMockRestores()` helper for spies and `installEnvRestores([...])` for environment variables,
 * a synchronous `afterEach` that restores or puts back as a direct statement, or
 * `onTestFinished(<synchronous callback>)` registered before the test can suspend. Synchronous
 * means a plain function: an `async` callback stops at its first `await`, and a generator callback
 * never runs its body, because Bun does not iterate what it returns. A put-back is credited only
 * when it restores a value saved from the same place (`x.y = saved` with `const saved = x.y`,
 * `Object.defineProperty` with the saved descriptor), deletes it, or splits those across both
 * branches of an `if/else`. A callback passed by name counts only through a function declaration
 * or `const` the file writes once, and `x.mockRestore()` restores a known spy only when one write
 * stores it in `x` and that write runs once per test (not in a loop, an array-iteration callback, a
 * helper called more than once, or a function that can reach itself again by name, `arguments` or
 * an export): a callback runs what a binding holds when it is called, not what it held when
 * registered.
 *
 * Cleanup does not make a late write safe. Every write an async body can run after an `await` is
 * reported, the first install as much as a put-back, whenever the file has cleanup for that place:
 * an abandoned body runs the write during a later test, after that cleanup has run, and leaves the
 * value behind. Only `testLifetime().assertLive()` before the write, or a write the body reaches
 * before its first `await`, earns silence. A place with no cleanup at all is left alone.
 *
 * A hook or `onTestFinished` cleanup also has to run at all. Bun 1.4.4 runs a test's `afterEach`
 * hooks innermost scope first, each scope in registration order, then its `onTestFinished`
 * callbacks in registration order, and once one of them times out it skips every later one. So a
 * cleanup counts only when no hook or callback that can suspend (`async`, a `done` parameter, or a
 * returned promise) runs before it; `installMockRestores()` and `installEnvRestores()` still count,
 * because their next `beforeEach` and their `afterAll` restore whatever Bun skipped. A hook or
 * callback that throws makes Bun skip the later ones the same way (measured for a synchronous
 * `afterEach` and for an `onTestFinished` callback), but the rules do not count a hook that can
 * throw as one that blocks: such a hook fails its own test, so the leak arrives with a red test, and
 * almost any hook can throw. The rules credit only those shapes. They are an enforcement aid for
 * new code, not a proof: a shape they credit is safe by construction, and every cleanup written in
 * another shape is reported (a spy or write with no cleanup at all is neither credited nor
 * reported).
 *
 * The rules judge only what one file shows: writes and restores reached from a test body directly
 * or through a function declared in the same file, and hooks declared in the same file. A hook
 * another file's helper registers is not seen.
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
/** The shared synchronous restore helpers every package's tests import. */
const RESTORE_HELPER_NAME = "installMockRestores";
const ENV_RESTORE_HELPER_NAME = "installEnvRestores";
const LIFETIME_HELPER_NAME = "testLifetime";
const RESTORE_HELPER_MODULE = /(^|\/)helpers\/mock-restores(\.ts)?$/;
/** An environment variable a write names: `process.env.HOME`, `Bun.env.HOME`. */
const ENV_PATH = /^(?:process|Bun)\.env\.(.+)$/;
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

/** The identifiers an assignment target binds: `x`, `[x, y]`, `{ a: x }`, `x = fallback`, `...x`. */
function patternIdentifiers(target: Node | undefined): Node[] {
	const n = unwrap(target);
	if (!n) return [];
	if (n.type === "Identifier") return [n];
	if (n.type === "ArrayPattern") return nodes(n.elements).flatMap(element => patternIdentifiers(element));
	if (n.type === "ObjectPattern")
		return nodes(n.properties).flatMap(p =>
			patternIdentifiers(node(p.type === "RestElement" ? p.argument : p.value)),
		);
	if (n.type === "AssignmentPattern") return patternIdentifiers(node(n.left));
	if (n.type === "RestElement") return patternIdentifiers(node(n.argument));
	return [];
}

/**
 * The nodes that store a value in `variable`: its declarator with an initializer or its function
 * declaration, then each assignment and `++`/`--`. Undefined when the rule cannot see every write:
 * a redeclaration, a parameter or import, or a loop that assigns the binding on every pass.
 */
function bindingWrites(facts: FileFacts, variable: Variable): Node[] | undefined {
	if (variable.defs.length !== 1) return undefined;
	const def = variable.defs[0]!;
	const writes: Node[] = [];
	if (def.type === "FunctionName") writes.push(def.node);
	else if (def.type === "Variable") {
		const declaration = def.parent;
		const loop = declaration?.parent;
		// `for (var x of xs)` shares one binding across passes; `let`/`const` get a fresh one per pass.
		if (
			declaration?.kind === "var" &&
			(loop?.type === "ForOfStatement" || loop?.type === "ForInStatement") &&
			node(loop.left) === declaration
		)
			return undefined;
		if (node(def.node.init)) writes.push(def.node);
	} else return undefined;
	for (const write of facts.assignments) {
		const loop = write.type === "ForOfStatement" || write.type === "ForInStatement";
		const target =
			write.type === "AssignmentExpression" || loop
				? node(write.left)
				: write.type === "UpdateExpression"
					? node(write.argument)
					: undefined;
		for (const id of patternIdentifiers(target)) {
			if (variableOf(facts.context, id) !== variable) continue;
			if (loop) return undefined;
			writes.push(write);
		}
	}
	return writes;
}

/** The node whose evaluation creates a fresh instance of the binding `def` declares. */
function bindingScope(def: Variable["defs"][number]): Node | undefined {
	const declaration = def.type === "Variable" ? def.parent : def.node;
	let holder = declaration?.parent ?? undefined;
	if (holder?.type === "ExportNamedDeclaration") holder = holder.parent ?? undefined;
	if (def.type === "Variable" && declaration?.kind === "var") {
		// `var` belongs to the whole enclosing function, or the file.
		let cur: Node | undefined = declaration;
		while (cur && !isFunction(cur) && cur.type !== "Program") cur = cur.parent ?? undefined;
		return cur;
	}
	return holder;
}

/** Array methods that call their callback once per element. */
const ITERATION_METHODS = new Set([
	"every",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"flatMap",
	"forEach",
	"map",
	"reduce",
	"reduceRight",
	"some",
]);

/**
 * Can `fn` run again through a path the walk cannot see? True when its own name (a declaration, a
 * named function expression, or the `const` it initialises) is used anywhere except `ownCall`
 * (recursion, or the body handing itself out to be called later), when `arguments` appears inside
 * it (`arguments.callee` is the running function), when the file uses `eval` (a direct `eval` can
 * call any function in scope by a name that appears only inside a string), or when it is exported
 * for other files to call.
 */
function mayRunAgain(facts: FileFacts, fn: Node, ownCall?: Node): boolean {
	const declarator = fn.parent?.type === "VariableDeclarator" && node(fn.parent.init) === fn ? fn.parent : undefined;
	const holder = declarator ? declarator.parent?.parent : fn.parent;
	if (holder?.type === "ExportNamedDeclaration" || holder?.type === "ExportDefaultDeclaration") return true;
	const ownName = node(fn.id);
	const declaredName = declarator ? node(declarator.id) : undefined;
	const names = new Set(
		[identName(ownName), identName(declaredName)].filter((name): name is string => name !== undefined),
	);
	const declaredVariable = declaredName?.type === "Identifier" ? variableOf(facts.context, declaredName) : undefined;
	for (const id of facts.references) {
		const name = id.name as string;
		if (name === "eval") return true;
		if (name === "arguments") {
			if (fn.range[0] <= id.range[0] && id.range[1] <= fn.range[1]) return true;
			continue;
		}
		if (!names.has(name) || id === ownName || id === declaredName || id === ownCall) continue;
		const variable = variableOf(facts.context, id);
		if (!variable) continue;
		if (variable === declaredVariable) return true;
		if (variable.defs.some(def => def.type === "FunctionName" && def.node === fn)) return true;
	}
	return false;
}

/**
 * The one call that runs a same-file function: it has exactly one call site, by name, and the
 * function cannot run again any other way ({@link mayRunAgain}: passing it to `forEach`, storing
 * it, recursion or an export could run it again).
 */
function soleCaller(facts: FileFacts, fn: Node): Node | undefined {
	const callers = facts.helpers.get(fn);
	if (callers?.length !== 1) return undefined;
	const caller = callers[0]!;
	const callee = unwrap(node(caller.callee));
	if (callee?.type !== "Identifier") return undefined;
	return mayRunAgain(facts, fn, callee) ? undefined : caller;
}

/**
 * Does `write` run at most once per test for each instance of the binding created at `scope`?
 * Walking out from the write: a loop body, test or update repeats it (a `for` initializer or a
 * `for-of`/`for-in` iterable does not); an array-iteration callback repeats it; another function
 * runs it only when it is an IIFE or a test or hook callback (once per test) that cannot run again
 * ({@link mayRunAgain}), or a same-file function with a sole call site; the walk then continues
 * from that call. Anything else counts as repeating.
 */
function runsOncePerBinding(facts: FileFacts, write: Node, scope: Node, depth = 0): boolean {
	let child = write;
	for (let cur = write.parent; cur; child = cur, cur = cur.parent) {
		if (cur === scope) return true;
		if (cur.type === "WhileStatement" || cur.type === "DoWhileStatement") return false;
		if (cur.type === "ForStatement" && node(cur.init) !== child) return false;
		if ((cur.type === "ForOfStatement" || cur.type === "ForInStatement") && node(cur.right) !== child) return false;
		if (!isFunction(cur)) continue;
		const parent = cur.parent;
		if (parent?.type === "CallExpression" && nodes(parent.arguments).includes(cur)) {
			const callee = unwrap(node(parent.callee));
			if (callee && ITERATION_METHODS.has(propertyName(callee) ?? "")) return false;
		}
		let caller: Node | undefined;
		if (parent?.type === "CallExpression" && unwrap(node(parent.callee)) === cur)
			caller = mayRunAgain(facts, cur) ? undefined : parent;
		else if (facts.registrations.has(cur))
			caller = mayRunAgain(facts, cur) ? undefined : facts.registrations.get(cur)!.call;
		else caller = depth < HELPER_DEPTH ? soleCaller(facts, cur) : undefined;
		return caller !== undefined && runsOncePerBinding(facts, caller, scope, depth + 1);
	}
	return false;
}

/**
 * Does the file store exactly one value in each instance of `variable`: one write, run at most once
 * per test for that instance? A callback captures the binding, not the value it held when registered,
 * so a binding written twice, or by a write that repeats, holds only the last value when it runs.
 */
function writtenOnce(facts: FileFacts, variable: Variable): boolean {
	const writes = bindingWrites(facts, variable);
	if (writes?.length !== 1) return false;
	const scope = bindingScope(variable.defs[0]!);
	return scope !== undefined && runsOncePerBinding(facts, writes[0]!, scope);
}

/**
 * The function a name passed to a hook or `onTestFinished` is certain to run: a function declaration
 * or `const` binding the file writes once. A callback registered by name runs whatever the binding
 * holds when it is called, not what it held when registered.
 */
function creditedFunctionOf(facts: FileFacts, id: Node): Node | undefined {
	const fn = functionOf(facts.context, id);
	const variable = fn && variableOf(facts.context, id);
	return variable && writtenOnce(facts, variable) ? fn : undefined;
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
	/** Identifiers that may name a binding (not member property names or object keys). */
	references: Node[];
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
	const references: Node[] = [];
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
		if (n.type === "Identifier") {
			const parent = n.parent;
			const memberName = parent?.type === "MemberExpression" && parent.property === n && parent.computed !== true;
			const objectKey =
				parent?.type === "Property" && parent.key === n && parent.computed !== true && parent.shorthand !== true;
			if (!memberName && !objectKey) references.push(n);
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
		references,
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
	// `await helper()` by itself is not a suspension before the helper's own statements: the call
	// runs them synchronously, up to the helper's first `await`, which the loop above covers.
	return false;
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

/** Is `id` bound to `name` imported from the shared `helpers/mock-restores` module? */
function isRestoreHelper(facts: FileFacts, id: Node | undefined, name: string): boolean {
	if (identName(id) !== name) return false;
	const def = variableOf(facts.context, id!)?.defs[0];
	if (def?.type !== "ImportBinding") return false;
	const source = node((def.parent ?? def.node.parent)?.source);
	return typeof source?.value === "string" && RESTORE_HELPER_MODULE.test(source.value);
}

/** The scope an `afterEach` or `beforeEach` call registers into: the file, a `describe` callback, or `"unknown"`. */
function hookScope(facts: FileFacts, call: Node): Node | undefined | "unknown" {
	const fn = enclosingFunction(call);
	if (!fn) return undefined;
	return facts.registrations.get(fn)?.kind === "describe" ? fn : "unknown";
}

/** Is the scope `inner` nested in the scope `outer` (the file when `undefined`)? */
function scopeInside(inner: Node | undefined, outer: Node | undefined): boolean {
	if (inner === undefined || inner === outer) return false;
	return outer === undefined || (outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1]);
}

/** An expression a callback can return that is certainly not a promise Bun would wait for. */
function returnsNoPromise(facts: FileFacts, expression: Node | undefined): boolean {
	const value = unwrap(expression);
	if (!value) return true;
	if (value.type === "UnaryExpression" && value.operator === "void") return true;
	if (value.type === "Literal") return true;
	if (value.type === "Identifier" && value.name === "undefined") return true;
	return value.type === "CallExpression" && realRestoreKind(facts, value) !== undefined;
}

/**
 * Can the callback a hook or `onTestFinished` call registers keep Bun waiting past its budget? Bun
 * 1.4.4 waits for an `async` callback, one that takes a `done` parameter, and one that returns a
 * promise; when such a callback times out, Bun skips every later `afterEach` hook and every
 * `onTestFinished` callback of the test (measured). A generator's body never runs, so it cannot. A
 * callback the file cannot resolve to one function counts as one that can.
 */
function callbackCanSuspend(facts: FileFacts, call: Node): boolean {
	const arg = nodes(call.arguments)[0];
	const id = unwrap(arg);
	const fn = isFunction(arg) ? arg : id?.type === "Identifier" ? creditedFunctionOf(facts, id) : undefined;
	if (!fn) return true;
	if (fn.generator === true) return false;
	if (fn.async === true || nodes(fn.params).length > 0) return true;
	const body = node(fn.body);
	if (!body) return false;
	if (body.type !== "BlockStatement") return !returnsNoPromise(facts, body);
	let returns = false;
	walk(facts.context, body, n => {
		if (
			!returns &&
			n.type === "ReturnStatement" &&
			enclosingFunction(n) === fn &&
			!returnsNoPromise(facts, node(n.argument))
		)
			returns = true;
	});
	return returns;
}

/** Is `onTestFinished` call `finisher` one of `test`'s: registered by its body, or by a `beforeEach`/`afterEach` hook that applies to it? */
function finisherApplies(facts: FileFacts, finisher: Node, test: Node): boolean {
	if (flows(facts, finisher).some(flow => flow.test === test)) return true;
	const fn = enclosingFunction(finisher);
	const hook = fn && facts.registrations.get(fn);
	if (hook?.kind !== "hook" || (hook.name !== "beforeEach" && hook.name !== "afterEach")) return false;
	const scope = hookScope(facts, hook.call);
	return scope === "unknown" || coveringScopes(facts, test).includes(scope);
}

/**
 * A hook or `onTestFinished` callback that Bun runs before `cleanup` for `test` and that can suspend
 * ({@link callbackCanSuspend}), or undefined. `cleanup` is the `afterEach` call whose hook does the
 * cleanup, or the `onTestFinished` call that registers it. Bun 1.4.4 runs a test's `afterEach` hooks
 * innermost scope first, each scope in registration order, then its `onTestFinished` callbacks in
 * registration order. A hook the file registers anywhere but in a scope's body (a helper, another
 * hook) counts as running before every cleanup.
 */
function suspendingHookBefore(facts: FileFacts, test: Node, cleanup: Node): Node | undefined {
	const scopes = coveringScopes(facts, test);
	const finisher = facts.finishers.includes(cleanup);
	const own = finisher ? undefined : hookScope(facts, cleanup);
	for (const call of facts.calls) {
		if (call === cleanup || testApi(facts.context, node(call.callee)) !== "afterEach") continue;
		const scope = hookScope(facts, call);
		if (scope !== "unknown") {
			if (!scopes.includes(scope)) continue;
			// For a hook cleanup, an outer scope's hooks and its own scope's later hooks run after it.
			if (
				!finisher &&
				own !== "unknown" &&
				(scope === own ? call.range[0] > cleanup.range[0] : !scopeInside(scope, own))
			)
				continue;
		}
		if (callbackCanSuspend(facts, call)) return call;
	}
	if (!finisher) return undefined;
	const fn = enclosingFunction(cleanup);
	for (const other of facts.finishers) {
		if (other === cleanup || !finisherApplies(facts, other, test)) continue;
		// Registered after `cleanup` in the same function: Bun runs it after `cleanup`'s callback.
		if (enclosingFunction(other) === fn && other.range[0] > cleanup.range[1]) continue;
		if (callbackCanSuspend(facts, other)) return other;
	}
	return undefined;
}

/** Where a credited cleanup would have counted but a hook that can suspend runs before it. */
interface HookBlock {
	hook?: Node;
}

function hookText(facts: FileFacts, hook: Node): string {
	const callee = unwrap(node(hook.callee));
	const name = (callee?.type === "MemberExpression" ? propertyName(callee) : identName(callee)) ?? "hook";
	const line = facts.context.sourceCode.text.slice(0, hook.range[0]).split("\n").length;
	return `${name}(...) at line ${line}`;
}

/** Does `scope` call the shared synchronous restore helper unconditionally at its top level? */
function callsRestoreHelper(facts: FileFacts, scope: Node | undefined): boolean {
	return facts.calls.some(
		call =>
			isRestoreHelper(facts, unwrap(node(call.callee)), RESTORE_HELPER_NAME) &&
			enclosingFunction(call) === scope &&
			isTopLevelStatement(facts, call, scope),
	);
}

/**
 * Does a covering scope of `test` own the environment variable `path` names through
 * `installEnvRestores(["NAME", ...])`, called unconditionally at its top level with a literal list?
 */
function envOwnerPutsBack(facts: FileFacts, test: Node, path: string): boolean {
	const name = ENV_PATH.exec(path)?.[1];
	if (name === undefined) return false;
	return coveringScopes(facts, test).some(scope =>
		facts.calls.some(call => {
			if (!isRestoreHelper(facts, unwrap(node(call.callee)), ENV_RESTORE_HELPER_NAME)) return false;
			if (enclosingFunction(call) !== scope || !isTopLevelStatement(facts, call, scope)) return false;
			const list = unwrap(nodes(call.arguments)[0]);
			return list?.type === "ArrayExpression" && nodes(list.elements).some(e => stringValue(e) === name);
		}),
	);
}

/**
 * Is `write` guarded by `life.assertLive()`, with `const life = testLifetime()` from the shared
 * helper module: a direct statement before it in a block that contains it, in the same function,
 * with no `await` between them? A body that resumes after its test ended throws there instead.
 * That function must be the test or hook callback itself, and it must create the lifetime before
 * its first `await`: a lifetime created later by a body that already outlived its test belongs to
 * the test running then, and a helper cannot tell how late its caller called it.
 */
function guardedByLifetime(facts: FileFacts, write: Node): boolean {
	const fn = enclosingFunction(write);
	const host = fn?.parent;
	if (!fn || host?.type !== "CallExpression" || testApi(facts.context, node(host.callee)) === undefined) return false;
	return facts.calls.some(call => {
		const callee = unwrap(node(call.callee));
		if (callee?.type !== "MemberExpression" || propertyName(callee) !== "assertLive") return false;
		const receiver = unwrap(node(callee.object));
		if (receiver?.type !== "Identifier") return false;
		const init = declaredInit(facts.context, receiver, true);
		if (init?.type !== "CallExpression" || !isRestoreHelper(facts, unwrap(node(init.callee)), LIFETIME_HELPER_NAME))
			return false;
		if (enclosingFunction(init) !== fn || awaitsIn(facts, fn, fn.range[0], init.range[0])) return false;
		const statement = directCallStatement(call);
		const list = statement?.parent;
		if (!statement || !list || enclosingFunction(call) !== fn) return false;
		if (statement.range[1] > write.range[0] || list.range[0] > write.range[0] || write.range[1] > list.range[1])
			return false;
		return !awaitsIn(facts, fn, statement.range[1], write.range[0]);
	});
}

/**
 * Is a write a test reaches through same-file helpers guarded where the test calls them? A
 * `life.assertLive()` before that call stops a body that outlived its test before it enters the
 * helper, which is the only place the test can guard. It counts only while no helper in the chain
 * suspends between the call and the write: after such an `await` the test can end with the helper
 * still inside, and the guard at the call has already passed.
 */
function guardedAtCall(facts: FileFacts, flow: Flow, write: Node): boolean {
	if (flow.via.length === 0) return false;
	for (const [i, helper] of flow.via.entries())
		if (helper.async && awaitsIn(facts, helper, 0, (flow.calls[i - 1] ?? write).range[0])) return false;
	return guardedByLifetime(facts, flow.at);
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
 * Does a synchronous top-level `afterEach` of `scope` do `work` as a direct statement before any exit,
 * with no hook that can suspend running before it for `test` ({@link suspendingHookBefore})? A hook
 * that would count but has one before it is recorded in `block`. `branches` also credits an
 * exhaustive `if/else` ({@link statementDoes}).
 */
function afterEachDoes(
	facts: FileFacts,
	test: Node,
	scope: Node | undefined,
	work: (expression: Node) => boolean,
	block: HookBlock,
	branches = false,
): boolean {
	for (const call of facts.calls) {
		if (testApi(facts.context, node(call.callee)) !== "afterEach") continue;
		if (enclosingFunction(call) !== scope || !isTopLevelStatement(facts, call, scope)) continue;
		const does = creditedCallbacks(facts, call).some(hook => {
			const body = node(hook.body);
			if (!body) return false;
			// `afterEach(() => vi.restoreAllMocks())`: the expression body is the whole hook.
			if (body.type !== "BlockStatement") return work(body);
			return nodes(body.body).some(statement => statementDoes(facts, hook, statement, work, branches));
		});
		if (!does) continue;
		const before = suspendingHookBefore(facts, test, call);
		if (!before) return true;
		block.hook ??= before;
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
	if (kind === "mockRestore") return creditedSpyInstall(facts, call) ? kind : undefined;
	if (kind !== "restoreAll") return undefined;
	const receiver = unwrap(node(unwrap(node(call.callee))!.object));
	if (receiver?.type !== "Identifier") return undefined;
	const api = testApiName(facts.context, receiver);
	return api === "vi" || api === "jest" || api === "mock" ? kind : undefined;
}

/**
 * Is every spy this test installs restored by cleanup a timeout cannot skip: the shared helper (its
 * next `beforeEach` and its `afterAll` restore even when Bun skips the rest), or a synchronous
 * top-level `afterEach` that calls the real restore API before any hook that can suspend runs?
 */
function spiesCovered(facts: FileFacts, test: Node, block: HookBlock = {}): boolean {
	return coveringScopes(facts, test).some(
		scope =>
			callsRestoreHelper(facts, scope) ||
			afterEachDoes(
				facts,
				test,
				scope,
				expression => {
					const call = unwrap(expression);
					return call?.type === "CallExpression" && realRestoreKind(facts, call) === "restoreAll";
				},
				block,
			),
	);
}

/**
 * Does `expression` put `path` back: restore a value saved from that same place ({@link restoresSaved}),
 * or `delete` / `Reflect.deleteProperty` it? Writing any other value is not a put-back.
 */
function putsBackSaved(facts: FileFacts, expression: Node, path: string): boolean {
	if (!sharedTargets(facts, expression).includes(path)) return false;
	if (expression.type === "UnaryExpression" && expression.operator === "delete") return true;
	if (expression.type === "CallExpression") {
		const builtin = builtinMethod(facts, node(expression.callee));
		if (builtin?.object === "Reflect" && builtin.method === "deleteProperty") return true;
	}
	return restoresSaved(facts, expression, path);
}

/**
 * Does a synchronous top-level `afterEach` of a covering scope put `path` back ({@link putsBackSaved})
 * before any hook that can suspend?
 */
function hookPutsBack(facts: FileFacts, test: Node, path: string, block: HookBlock = {}): boolean {
	return coveringScopes(facts, test).some(scope =>
		afterEachDoes(facts, test, scope, expression => putsBackSaved(facts, expression, path), block, true),
	);
}

/** Does a synchronous top-level `afterEach` of a covering scope write `path` at all (any value)? */
function hookWrites(facts: FileFacts, test: Node, path: string): boolean {
	return coveringScopes(facts, test).some(scope =>
		afterEachDoes(facts, test, scope, expression => sharedTargets(facts, expression).includes(path), {}, true),
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

/** The variable `x` of an `x.mockRestore()` call, and its declaration. */
function restoredSpyVariable(facts: FileFacts, call: Node): { variable: Variable; declarator: Node } | undefined {
	const callee = unwrap(node(call.callee));
	const receiver = callee?.type === "MemberExpression" ? unwrap(node(callee.object)) : undefined;
	if (receiver?.type !== "Identifier") return undefined;
	const variable = variableOf(facts.context, receiver);
	const def = variable?.defs[0];
	return variable && def?.type === "Variable" ? { variable, declarator: def.node } : undefined;
}

/**
 * Every `spyOn(...)` call stored in the variable of a `x.mockRestore()` call: `const x = spyOn(...)`,
 * `const x = await spyOn(...)`, `let x; x = spyOn(...)`, and each later `x = spyOn(...)`.
 */
function spyInstalls(facts: FileFacts, call: Node): Node[] {
	const spy = restoredSpyVariable(facts, call);
	if (!spy) return [];
	const installs = [spyCallIn(facts, node(spy.declarator.init)) ?? []].flat();
	for (const write of facts.assignments) {
		if (write.type !== "AssignmentExpression") continue;
		const left = unwrap(node(write.left));
		if (left?.type !== "Identifier" || variableOf(facts.context, left) !== spy.variable) continue;
		const install = spyCallIn(facts, node(write.right));
		if (install) installs.push(install);
	}
	return installs;
}

/**
 * The one spy a `x.mockRestore()` call is certain to restore: the file stores one `spyOn(...)` in
 * each instance of `x`, by one write that runs at most once per test ({@link writtenOnce}):
 * `const x = spyOn(...)`, `let x = spyOn(...)` never reassigned, `let x; x = spyOn(...)`, or a
 * per-iteration `const` in a loop body. Not `var` or an outer `let` written inside a loop, nor an
 * outer binding written by a helper called more than once.
 */
function creditedSpyInstall(facts: FileFacts, call: Node): Node | undefined {
	const spy = restoredSpyVariable(facts, call);
	if (!spy || !writtenOnce(facts, spy.variable)) return undefined;
	const installs = spyInstalls(facts, call);
	return installs.length === 1 ? installs[0] : undefined;
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

/**
 * Does calling `fn` run its whole body before returning? Not for `async` functions, which stop at
 * their first `await`, nor for generators: calling one only creates an iterator, and Bun never
 * iterates what a hook or `onTestFinished` callback returns, so the body never runs.
 */
function runsBodyWhenCalled(fn: Node): boolean {
	return fn.async !== true && fn.generator !== true;
}

/**
 * The functions a hook or `onTestFinished` call is certain to run to the end: inline, or a
 * never-reassigned name, and neither `async` nor a generator ({@link runsBodyWhenCalled}).
 */
function creditedCallbacks(facts: FileFacts, call: Node): Node[] {
	return nodes(call.arguments).flatMap(arg => {
		const id = unwrap(arg);
		const fn = isFunction(arg) ? arg : id?.type === "Identifier" ? creditedFunctionOf(facts, id) : undefined;
		return fn && runsBodyWhenCalled(fn) ? [fn] : [];
	});
}

/** The restore calls, recognised by method name, inside the callbacks `finisher` registers, with their callback. */
function registeredRestores(facts: FileFacts, finisher: Node): { restore: Node; callback: Node }[] {
	const found: { restore: Node; callback: Node }[] = [];
	for (const callback of registered(facts, finisher))
		walk(facts.context, callback, n => {
			if (n.type === "CallExpression" && restoreKind(n)) found.push({ restore: n, callback });
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
	return creditedCallbacks(facts, finisher).some(callback => {
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

/**
 * Does a synchronous `onTestFinished` registered before the test can suspend restore `install` for
 * `test`, with no hook or earlier callback that can suspend running before it ({@link suspendingHookBefore})?
 * A registration that would count but has one before it is recorded in `block`.
 */
function spyRegisteredPromptly(facts: FileFacts, install: Node, test: Node, block: HookBlock = {}): boolean {
	return facts.finishers.some(finisher => {
		if (!registeredBefore(facts, finisher, install) && !registeredNextTo(facts, finisher, install)) return false;
		const restores = promptCallback(facts, finisher, expression => {
			const call = unwrap(expression);
			if (call?.type !== "CallExpression") return false;
			const kind = realRestoreKind(facts, call);
			if (kind === "restoreAll") return true;
			return kind === "mockRestore" && creditedSpyInstall(facts, call) === install;
		});
		return restores && unblocked(facts, test, finisher, block);
	});
}

/**
 * Does a synchronous `onTestFinished` registered before `write` put `path` back ({@link putsBackSaved}),
 * with no hook that can suspend before it?
 */
function putBackRegisteredPromptly(
	facts: FileFacts,
	path: string,
	write: Node,
	test: Node,
	block: HookBlock = {},
): boolean {
	return facts.finishers.some(
		finisher =>
			registeredBefore(facts, finisher, write) &&
			promptCallback(facts, finisher, expression => putsBackSaved(facts, expression, path), true) &&
			unblocked(facts, test, finisher, block),
	);
}

/** Does a synchronous `onTestFinished` registered before `write` write `path` at all (any value)? */
function writeRegisteredPromptly(facts: FileFacts, path: string, write: Node): boolean {
	return facts.finishers.some(
		finisher =>
			registeredBefore(facts, finisher, write) &&
			promptCallback(facts, finisher, expression => sharedTargets(facts, expression).includes(path), true),
	);
}

/**
 * Does any cleanup of `test` write `path`, however the rules judge it: a callback of an `afterEach`
 * of a covering scope, or of an `onTestFinished` the test registers, `async` and generator
 * callbacks included. Such cleanup names the place as one the test is expected to leave as it
 * found it, which is what makes a write the body reaches after an `await` a leak into a later test.
 */
function cleanupWrites(facts: FileFacts, test: Node, path: string): boolean {
	const writesPath = (callback: Node): boolean => {
		let found = false;
		walk(facts.context, callback, n => {
			if (!found && sharedTargets(facts, n).includes(path)) found = true;
		});
		return found;
	};
	const scopes = coveringScopes(facts, test);
	for (const call of facts.calls) {
		if (testApi(facts.context, node(call.callee)) !== "afterEach") continue;
		if (!scopes.includes(enclosingFunction(call))) continue;
		if (registered(facts, call).some(writesPath)) return true;
	}
	return facts.finishers.some(
		finisher => finisherApplies(facts, finisher, test) && registered(facts, finisher).some(writesPath),
	);
}

/** Does no hook that can suspend run before `cleanup` for `test`? Records the first one in `block`. */
function unblocked(facts: FileFacts, test: Node, cleanup: Node, block: HookBlock): boolean {
	const before = suspendingHookBefore(facts, test, cleanup);
	if (before) block.hook ??= before;
	return before === undefined;
}

/**
 * Is a put-back of `path` registered anywhere in `test`, however late or conditionally? `"generator"`
 * when the only such registrations are generator callbacks, whose bodies never run.
 */
function putBackRegisteredAnywhere(facts: FileFacts, test: Node, path: string): "registered" | "generator" | undefined {
	let found: "registered" | "generator" | undefined;
	for (const finisher of facts.finishers) {
		if (!flows(facts, finisher).some(flow => flow.test === test)) continue;
		for (const callback of registered(facts, finisher)) {
			let writes = false;
			walk(facts.context, callback, n => {
				if (!writes && sharedTargets(facts, n).includes(path)) writes = true;
			});
			if (!writes) continue;
			if (callback.generator !== true) return "registered";
			found = "generator";
		}
	}
	return found;
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
			const block: HookBlock = {};
			if (isAsyncTest(facts, flow)) {
				if (!suspendsBefore(facts, flow, call, installs[0])) continue;
				// `restoreAllMocks()` in an async body also removes a later test's mocks when the
				// abandoned body resumes, so a covering hook does not make it safe.
				if (kind === "restoreAll") messageId = "restoreAllInAsyncBody";
				else if (
					!spiesCovered(facts, flow.test, block) &&
					!installs.some(install => spyRegisteredPromptly(facts, install, flow.test, block))
				)
					messageId = block.hook ? "restoreSkippedByHook" : "restoreSkippedByTimeout";
			} else if (!spiesCovered(facts, flow.test) && !inFinally(call, flow.via[0] ?? flow.test))
				messageId = "restoreSkippedByThrow";
			if (messageId) {
				facts.context.report({
					node: call,
					messageId,
					data: { call: callText(facts, call), hook: block.hook ? hookText(facts, block.hook) : "" },
				});
				break;
			}
		}
	}
	judgeLateRestores(facts);
}

/** Is there a restore of `install` in `test`'s own flow (not in a registered callback)? {@link judgeRestores} judges those. */
function restoredInBody(facts: FileFacts, install: Node, test: Node): boolean {
	return facts.calls.some(call => {
		const kind = restoreKind(call);
		if (!kind || (kind === "mockRestore" && !spyInstalls(facts, call).includes(install))) return false;
		return flows(facts, call).some(flow => flow.test === test);
	});
}

/**
 * Spies whose restore is not certain to undo them: registered where a timeout can skip the
 * registration, registered only in a generator callback (which never runs), registered in time but
 * through a variable that also holds another spy when the callback runs, or registered where a hook
 * or earlier callback that can suspend runs first (Bun then skips the callback).
 */
function judgeLateRestores(facts: FileFacts): void {
	const reported = new Set<Node>();
	for (const finisher of facts.finishers) {
		for (const { restore, callback } of registeredRestores(facts, finisher)) {
			const individual = restoreKind(restore) === "mockRestore";
			const installs = individual ? spyInstalls(facts, restore) : facts.calls.filter(call => isSpyOn(facts, call));
			for (const install of installs) {
				if (reported.has(install)) continue;
				for (const flow of flows(facts, install)) {
					if (!flows(facts, finisher).some(f => f.test === flow.test)) continue;
					const block: HookBlock = {};
					if (spiesCovered(facts, flow.test, block)) continue;
					let messageId: string | undefined;
					if (isAsyncTest(facts, flow)) {
						const prompt: HookBlock = {};
						if (spyRegisteredPromptly(facts, install, flow.test, prompt)) continue;
						const inTime =
							registeredBefore(facts, finisher, install) || registeredNextTo(facts, finisher, install);
						const rewritten =
							individual &&
							inTime &&
							runsBodyWhenCalled(callback) &&
							creditedSpyInstall(facts, restore) !== install;
						messageId =
							callback.generator === true
								? "restoreInGenerator"
								: prompt.hook
									? "restoreSkippedByHook"
									: rewritten
										? "restoreBindingRewritten"
										: "restoreRegisteredLate";
						block.hook = prompt.hook;
					} else {
						// A synchronous body cannot time out before it registers the restore; only a hook or
						// earlier callback that can suspend can strand it.
						if (callback.generator === true || restoredInBody(facts, install, flow.test)) continue;
						const hooked: HookBlock = {};
						if (unblocked(facts, flow.test, finisher, hooked)) continue;
						messageId = "restoreSkippedByHook";
						block.hook = hooked.hook;
					}
					facts.context.report({
						node: install,
						messageId,
						data: { call: callText(facts, restore), hook: block.hook ? hookText(facts, block.hook) : "" },
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
 * The values the file stores in a `let`/`var` binding: its initializer and the right side of each
 * plain `x = value`. Undefined when a store is anything else (`+=`, `++`, a destructuring or loop
 * target) or the binding is not a single variable declaration.
 */
function storedValues(facts: FileFacts, variable: Variable): Node[] | undefined {
	if (variable.defs.length !== 1 || variable.defs[0]!.type !== "Variable") return undefined;
	const def = variable.defs[0]!;
	const values: Node[] = [];
	const init = unwrapAwait(node(def.node.init));
	if (init) values.push(init);
	for (const write of facts.assignments) {
		const target =
			write.type === "AssignmentExpression" || write.type === "ForOfStatement" || write.type === "ForInStatement"
				? node(write.left)
				: write.type === "UpdateExpression"
					? node(write.argument)
					: undefined;
		const ids = patternIdentifiers(target).filter(id => variableOf(facts.context, id) === variable);
		if (ids.length === 0) continue;
		const left = unwrap(target);
		if (write.type !== "AssignmentExpression" || write.operator !== "=" || left?.type !== "Identifier")
			return undefined;
		const value = unwrapAwait(node(write.right));
		if (!value) return undefined;
		values.push(value);
	}
	return values;
}

/**
 * Does `write` put back a value saved from the same place: `const original = x.y; ... x.y = original`
 * (also `Reflect.set(x, "y", original)`), or `Object.defineProperty(o, "k", saved)` with
 * `saved = Object.getOwnPropertyDescriptor(o, "k")`? A `let` counts when every value the file stores
 * in it is such a read of that place (`let original; beforeEach(() => { original = x.y; })`).
 */
function restoresSaved(facts: FileFacts, write: Node, path: string): boolean {
	let value: Node | undefined;
	if (write.type === "AssignmentExpression" && write.operator === "=") value = unwrap(node(write.right));
	else if (write.type === "CallExpression") {
		const builtin = builtinMethod(facts, node(write.callee));
		if (builtin?.method === "defineProperty" || (builtin?.object === "Reflect" && builtin.method === "set"))
			value = unwrap(nodes(write.arguments)[2]);
	}
	if (value?.type !== "Identifier") return false;
	const readsPath = (saved: Node): boolean => {
		let read = memberPath(facts.context, saved);
		if (
			saved.type === "CallExpression" &&
			builtinMethod(facts, node(saved.callee))?.method === "getOwnPropertyDescriptor"
		) {
			const [owner, key] = nodes(saved.arguments);
			const ownerPath = memberPath(facts.context, owner);
			const name = constantKey(facts.context, key);
			read = ownerPath && {
				root: ownerPath.root,
				path: `${ownerPath.path}${name === undefined ? "[]" : `.${name}`}`,
			};
		}
		return read !== undefined && resolvePlaces(facts, read).some(place => sharedTarget(facts, place) === path);
	};
	const saved = declaredInit(facts.context, value, true);
	if (saved) return readsPath(saved);
	const variable = variableOf(facts.context, value);
	const values = variable && storedValues(facts, variable);
	return values !== undefined && values.length > 0 && values.every(v => readsPath(unwrap(v) ?? v));
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
			const key = `${flow.test.range[0]}|${write.path}`;
			if (reported.has(key)) break;
			const block: HookBlock = {};
			let messageId: string | undefined;
			if (isAsyncTest(facts, flow)) {
				const replaces = write.putsBack ? (replacement.get(key) ?? write.node) : write.node;
				const covered =
					hookPutsBack(facts, flow.test, write.path, block) ||
					envOwnerPutsBack(facts, flow.test, write.path) ||
					putBackRegisteredPromptly(facts, write.path, replaces, flow.test, block);
				const late =
					suspendsBefore(facts, flow, write.node, write.replaced) &&
					!guardedByLifetime(facts, write.node) &&
					!guardedAtCall(facts, flow, write.node);
				if (covered) {
					// Cleanup that outlives the test does not make a late write safe: when the test times
					// out, the abandoned body runs this write during a later test, after that cleanup has
					// run, and replaces that test's value. A first install is as late as a put-back.
					if (late)
						// A later write of another value is a second install, not a put-back.
						messageId =
							write.putsBack && putsBackSaved(facts, write.node, write.path)
								? "putBackRunsLate"
								: "writeRunsLate";
				} else if (write.putsBack) {
					if (suspendsBefore(facts, flow, write.node, write.replaced))
						messageId = block.hook ? "putBackSkippedByHook" : "putBackSkippedByTimeout";
				} else if (block.hook) messageId = "putBackSkippedByHook";
				else if (hookWrites(facts, flow.test, write.path) || writeRegisteredPromptly(facts, write.path, replaces))
					messageId = "putBackWritesUnsavedValue";
				else {
					const registeredAs = putBackRegisteredAnywhere(facts, flow.test, write.path);
					if (registeredAs === "registered") messageId = "putBackRegisteredLate";
					else if (registeredAs === "generator") messageId = "putBackInGenerator";
					// Cleanup the rules do not credit (an async hook, a late callback) still runs while the
					// abandoned body is suspended, so this write lands in a later test with nothing left to
					// undo it.
					else if (late && cleanupWrites(facts, flow.test, write.path)) messageId = "writeRunsLate";
				}
			} else {
				if (hookPutsBack(facts, flow.test, write.path, block) || envOwnerPutsBack(facts, flow.test, write.path))
					continue;
				// A synchronous body cannot time out, so it reaches its own put-back and its registrations;
				// only a hook or earlier callback that can suspend can strand a registered put-back.
				const inBody = writes.some(
					other =>
						other.path === write.path &&
						other.putsBack &&
						flows(facts, other.node).some(f => f.test === flow.test),
				);
				if (write.putsBack || inBody || finisherPutsBack(facts, flow.test, write.path, block)) continue;
				if (block.hook) messageId = "putBackSkippedByHook";
			}
			if (!messageId) continue;
			facts.context.report({
				node: write.node,
				messageId,
				data: { target: write.path, hook: block.hook ? hookText(facts, block.hook) : "" },
			});
			reported.add(key);
			reported.add(`node|${write.node.range[0]}`);
			break;
		}
	}
	judgeCleanupWrites(facts, writes, reported);
}

/**
 * Does `write` store a value that evidently was not saved from anywhere: a literal, a template, an
 * object, array or function expression, or `undefined`? A value of unknown origin (a parameter, a
 * member of another object) is not reported here; it still earns no put-back credit.
 */
function writesFreshValue(facts: FileFacts, write: Node): boolean {
	let value: Node | undefined;
	if (write.type === "AssignmentExpression") value = unwrap(node(write.right));
	else if (write.type === "CallExpression") {
		const builtin = builtinMethod(facts, node(write.callee));
		if (builtin?.method === "defineProperty" || (builtin?.object === "Reflect" && builtin.method === "set"))
			value = unwrap(nodes(write.arguments)[2]);
	}
	if (!value) return false;
	if (value.type === "Identifier") return value.name === "undefined";
	return (
		value.type === "Literal" ||
		value.type === "TemplateLiteral" ||
		value.type === "ObjectExpression" ||
		value.type === "ArrayExpression" ||
		isFunction(value)
	);
}

/**
 * A write in an `onTestFinished` callback or an `afterEach` hook that stores a fresh value
 * ({@link writesFreshValue}) in a place the test body writes installs that value instead of putting
 * the original back. It runs after the put-backs registered before it, so the value outlives the test.
 */
function judgeCleanupWrites(facts: FileFacts, writes: { node: Node; path: string }[], reported: Set<string>): void {
	const written = new Map<Node, Set<string>>();
	for (const write of writes)
		for (const flow of flows(facts, write.node))
			written.set(flow.test, (written.get(flow.test) ?? new Set()).add(write.path));
	const judge = (callback: Node, tests: Node[]): void => {
		const paths = new Set(tests.flatMap(test => [...(written.get(test) ?? [])]));
		walk(facts.context, callback, n => {
			if (reported.has(`node|${n.range[0]}`) || !writesFreshValue(facts, n)) return;
			const path = sharedTargets(facts, n).find(target => paths.has(target));
			if (!path) return;
			facts.context.report({ node: n, messageId: "cleanupWritesUnsavedValue", data: { target: path } });
			reported.add(`node|${n.range[0]}`);
		});
	};
	for (const finisher of facts.finishers) {
		const tests = flows(facts, finisher).map(flow => flow.test);
		if (tests.length > 0) for (const callback of registered(facts, finisher)) judge(callback, tests);
	}
	for (const call of facts.calls) {
		if (testApi(facts.context, node(call.callee)) !== "afterEach") continue;
		const scope = enclosingFunction(call);
		const tests = [...written.keys()].filter(test => coveringScopes(facts, test).includes(scope));
		if (tests.length > 0) for (const callback of registered(facts, call)) judge(callback, tests);
	}
}

/** Does a synchronous `onTestFinished` of `test` put `path` back, with no hook that can suspend before it? */
function finisherPutsBack(facts: FileFacts, test: Node, path: string, block: HookBlock): boolean {
	return facts.finishers.some(
		finisher =>
			finisherApplies(facts, finisher, test) &&
			promptCallback(facts, finisher, expression => sharedTargets(facts, expression).includes(path)) &&
			unblocked(facts, test, finisher, block),
	);
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
				restoreInGenerator:
					"This spy's restore `{{call}}` is in a generator callback. Bun calls it but never iterates the generator it returns, so the restore never runs and the spy leaks into later tests. Use a plain function, or call `installMockRestores()` at the top of this file or `describe`.",
				restoreBindingRewritten:
					"`{{call}}` restores whatever its variable holds when the callback runs, and this file can store another spy in that variable first (a second write, or one in a loop or in a function that can run again), so this spy may never be restored. Give each spy its own `const`, or call `installMockRestores()` at the top of this file or `describe`.",
				restoreSkippedByHook:
					"This mock is restored (`{{call}}`) only by cleanup that runs after `{{hook}}`, which can suspend. If that hook times out, Bun skips every later `afterEach` hook and every `onTestFinished` callback of the test, so the mock leaks into later tests. Call `installMockRestores()` at the top of this file or `describe`, or restore in a synchronous `afterEach` that runs before every hook that can suspend.",
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
				putBackRunsLate:
					"This put-back of `{{target}}` runs after an `await`. If the test times out, the abandoned body runs it during a later test and overwrites that test's value. Leave the put-back to the `onTestFinished`, `afterEach` or `installEnvRestores()` that already covers `{{target}}`, or create `const life = testLifetime()` before the test's first `await` and call `life.assertLive()` right before it.",
				writeRunsLate:
					"This write to `{{target}}` runs after an `await`. If the test times out, the abandoned body runs it during a later test and replaces that test's value, after the cleanup for `{{target}}` has already run. Write it before the test's first `await`, or create `const life = testLifetime()` before that `await` and call `life.assertLive()` right before this write.",
				putBackWritesUnsavedValue:
					"The cleanup registered for this write to `{{target}}` writes a value that was not saved from `{{target}}`, so it does not put the original back. Save it first (`const saved = {{target}}`) and restore that, or `delete` it.",
				cleanupWritesUnsavedValue:
					"This cleanup writes `{{target}}` with a value that was not saved from `{{target}}`, so it installs that value after the put-backs that ran before it, and it outlives the test. Restore a saved value (`const saved = {{target}}`) or `delete` it.",
				putBackInGenerator:
					"The put-back of `{{target}}` is in a generator callback. Bun calls it but never iterates the generator it returns, so the put-back never runs and the replacement leaks into later tests. Use a plain function.",
				putBackSkippedByHook:
					"The put-back of `{{target}}` runs after `{{hook}}`, which can suspend. If that hook times out, Bun skips every later `afterEach` hook and every `onTestFinished` callback of the test, so the replacement leaks into later tests. Put it back in a synchronous `afterEach` that runs before every hook that can suspend: in the innermost scope, registered before the scope's other hooks.",
			},
			judgePutBacks,
		),
	},
};
