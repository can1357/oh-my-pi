/**
 * Every place that can create a model request says who owns it.
 *
 * The walk covers the coding agent and every workspace package it depends on. A request is created
 * through:
 *
 * - a network global (`fetch`, `WebSocket`, `EventSource`), anywhere in those packages;
 * - the request API of the transport packages, `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-agent-core`
 *   ({@link TRANSPORT_PRIMITIVES}). Inside a transport package only its network sites are checked:
 *   each names the listed primitive it implements, so a new request function there cannot be left
 *   off the list;
 * - the request APIs defined in walked packages ({@link SOURCE_PRIMITIVES}), and every method of the
 *   Hindsight client;
 * - any function, class or member a `caller` declaration names (below), transitively.
 *
 * The test parses every source file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`),
 * resolves each name through the module graph (named, aliased, namespace and dynamic imports, named
 * and star re-exports through barrels, in any quote style), sees through type assertions and
 * parentheses, and finds every use: a call, a construction, or the thing handed on as a value. A
 * use it cannot resolve (a computed member of a request module's namespace, an unbound dynamic
 * import of one) is a site too. Each site must sit under a declaration:
 *
 *     // model-request: <owner> — <why>
 *
 * The owners, the only words the test accepts:
 *
 * - `session`: carries the owning session's disposal signal, or one derived from it, so it stops
 *   when the session begins disposing.
 * - `turn`: belongs to an admitted turn (a prompt, a tool call, the work a turn awaits) and carries
 *   that turn's signal. It may finish after `beginDispose()`; `dispose()` aborts the turn.
 * - `caller <name>[, <name>]`: carries a signal that `<name>` takes from its own parameters. The test
 *   traces the signal back to those parameters, and every use of `<name>` is then a site that must
 *   supply them. `<name>` encloses the site (a function, a class, whose constructions are its uses,
 *   a method: a private one is reached as `this.#name`, a public one through any `.name` in any
 *   file), or is the variable, field or property a handed-on function is stored in.
 * - `no-session`: runs where no session exists (a CLI command, a standalone helper).
 * - `outlives-disposal`: deliberately runs on after its session began disposing. The reason says
 *   why, so the next reader sees a decision rather than an omission.
 * - `extension`: handed to extension or plugin code, whose requests the extension boundary governs.
 * - `transport <primitive>[, <primitive>]`: implements a listed primitive; the request belongs to
 *   whoever calls that primitive.
 * - `none`: a network site that is not a model request (a web page, a registry, a local service).
 *
 * A `session`, `turn` or `caller` site must pass a cancellation where the request takes it: the
 * `signal` property of the options argument, or the signal argument, with a value that is not
 * `undefined`, written in the call or traced through local variables, spreads and parameters. An
 * `Agent` or a judge object is exempt: its owner aborts it, or each judgment takes its own signal.
 *
 * What the test cannot prove: that the signal passed is the right one (a fresh, unrelated
 * controller passes). The semantic disposal tests cover that for each family.
 *
 * To add a request that outlives disposal, write `// model-request: outlives-disposal — <why>` above
 * the line that creates it. A site with no declaration fails here, with its location.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parse } from "@babel/parser";

const PACKAGES_DIR = path.join(import.meta.dir, "../..");
const ROOT_PACKAGE = "@oh-my-pi/pi-coding-agent";
const SOURCE_GLOB = "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** Where a request takes its cancellation: argument `arg`, or its property `prop`. */
interface SignalPath {
	arg: number;
	prop?: string;
}

/** How a constructor takes its cancellation. */
type SignalSpec =
	| { kind: "paths"; paths: SignalPath[] }
	/** The last argument's `signal` (the Hindsight client's methods). */
	| { kind: "last-options" }
	/** Builds a requester: its owner aborts it (an `Agent`), or each request takes its own signal (a judge). */
	| { kind: "later" }
	/** Takes no cancellation at all (a connection prewarm, a socket). */
	| { kind: "none" }
	/** Not yet known: a `caller` whose signal the trace could not place. */
	| { kind: "unknown" };

const opt = (arg: number): SignalSpec => ({ kind: "paths", paths: [{ arg, prop: "signal" }] });
const pos = (arg: number): SignalSpec => ({ kind: "paths", paths: [{ arg }] });
const LATER: SignalSpec = { kind: "later" };
const NONE: SignalSpec = { kind: "none" };

/** The request API of the transport packages, and where each takes its cancellation. */
const TRANSPORT_PRIMITIVES: Readonly<Record<string, Readonly<Record<string, SignalSpec>>>> = {
	"@oh-my-pi/pi-ai": {
		stream: opt(2),
		complete: opt(2),
		streamSimple: opt(2),
		completeSimple: opt(2),
		embed: opt(2),
		rerank: opt(2),
		synthesizeSpeech: opt(2),
		transcribeAudio: opt(2),
		generateImage: opt(2),
		submitVideo: opt(2),
		pollVideo: opt(2),
		downloadVideo: opt(2),
		prewarmOpenAICodexResponses: opt(1),
		prewarmModelConnection: NONE,
		createNativeJudge: LATER,
		NativeJudge: LATER,
		chatTextBackend: LATER,
	},
	"@oh-my-pi/pi-agent-core": {
		Agent: LATER,
		agentLoop: pos(3),
		agentLoopDetailed: pos(3),
		agentLoopContinue: pos(2),
		agentLoopContinueDetailed: pos(2),
		instrumentedCompleteSimple: opt(2),
		streamProxy: opt(2),
		compact: pos(4),
		generateSummary: pos(4),
		generateHandoff: pos(4),
		generateHandoffFromContext: { kind: "paths", paths: [{ arg: 2, prop: "streamOptions.signal" }] },
		generateBranchSummary: opt(1),
		requestCompactionV2Streaming: pos(3),
		requestAnthropicNativeCompaction: pos(3),
		requestOpenAiRemoteCompaction: pos(4),
		requestRemoteCompaction: pos(2),
	},
};

/** Request APIs defined in walked packages, by `<package dir>/<file>`. */
const SOURCE_PRIMITIVES: Readonly<Record<string, Readonly<Record<string, SignalSpec>>>> = {
	"coding-agent/src/judgment/index.ts": { resolveJudge: opt(0), ChainJudge: opt(0) },
};

/** The Hindsight client: each public async method is a request, reached through a binding named `client`. */
const HINDSIGHT = {
	file: "coding-agent/src/hindsight/client.ts",
	className: "HindsightApi",
	factory: "createHindsightClient",
};

/** Network globals: every use is a request. */
const NETWORK_GLOBALS: Readonly<Record<string, SignalSpec>> = { fetch: opt(1), WebSocket: NONE, EventSource: NONE };
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

const OWNERS = new Set([
	"session",
	"turn",
	"caller",
	"no-session",
	"outlives-disposal",
	"extension",
	"transport",
	"none",
]);
const DECLARATION = /^\s*model-request:\s*([a-z-]+)(.*)$/;
const NAMED_OWNERS = new Set(["caller", "transport"]);

// ---------------------------------------------------------------------------------------------
// Syntax trees

// Babel's node type is wide; the walk reads only the fields it names.
interface Node {
	type: string;
	start?: number | null;
	loc?: { start: { line: number } } | null;
	leadingComments?: Array<{ value: string; start?: number | null }> | null;
	[key: string]: unknown;
}

interface Comment {
	value: string;
	start: number;
	loc: { start: { line: number } };
}

function isNode(value: unknown): value is Node {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

const child = (node: Node | undefined, key: string): Node | undefined => {
	const value = node?.[key];
	return isNode(value) ? value : undefined;
};
const children = (node: Node | undefined, key: string): Node[] => {
	const value = node?.[key];
	return Array.isArray(value) ? value.filter(isNode) : [];
};
const nameOf = (node: Node | undefined): string | undefined => {
	if (node?.type === "Identifier") return node.name as string;
	if (node?.type === "PrivateName") return `#${nameOf(child(node, "id"))}`;
	if (node?.type === "StringLiteral") return node.value as string;
	return undefined;
};

/** Visit every node with its ancestors, outermost first. */
function walk(node: Node, visit: (node: Node, ancestors: readonly Node[]) => void, ancestors: Node[] = []): void {
	visit(node, ancestors);
	ancestors.push(node);
	for (const key in node) {
		if (key === "loc" || key.endsWith("Comments")) continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) walk(item, visit, ancestors);
		} else if (isNode(value)) {
			walk(value, visit, ancestors);
		}
	}
	ancestors.pop();
}

/** Expression wrappers that change nothing at run time: `(x)`, `x as T`, `x!`, `x satisfies T`, `<T>x`. */
const TRANSPARENT = new Set([
	"ParenthesizedExpression",
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSNonNullExpression",
	"TSTypeAssertion",
	"TSInstantiationExpression",
]);

function unwrap(node: Node | undefined): Node | undefined {
	let current = node;
	while (current && TRANSPARENT.has(current.type)) current = child(current, "expression");
	return current;
}

/** Type-level nodes: names under them are types, not values. */
const TYPE_LEVEL =
	/^TS(TypeAnnotation|TypeQuery|TypeReference|InterfaceDeclaration|TypeAliasDeclaration|DeclareFunction|ModuleDeclaration|TypeParameter|IndexedAccessType|ImportType|ExpressionWithTypeArguments|QualifiedName|EnumDeclaration)/;

const isFunctionLike = (node: Node): boolean =>
	/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(
		node.type,
	);

// ---------------------------------------------------------------------------------------------
// Packages and files

interface PackageInfo {
	name: string;
	dir: string;
	exports: Record<string, unknown>;
	transport: boolean;
}

interface SourceFile {
	/** `<package dir>/<path in package>`, e.g. `coding-agent/src/sdk.ts`. */
	key: string;
	pkg: PackageInfo;
	text: string;
	ast: Node;
	comments: Comment[];
}

async function loadPackages(): Promise<Map<string, PackageInfo>> {
	const byName = new Map<string, PackageInfo & { deps: string[] }>();
	for await (const manifest of new Bun.Glob("*/package.json").scan({ cwd: PACKAGES_DIR })) {
		const json = (await Bun.file(path.join(PACKAGES_DIR, manifest)).json()) as {
			name: string;
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		byName.set(json.name, {
			name: json.name,
			dir: path.dirname(manifest),
			exports: json.exports ?? {},
			transport: json.name in TRANSPORT_PRIMITIVES,
			deps: Object.keys(json.dependencies ?? {}).filter(dep => dep.startsWith("@oh-my-pi/")),
		});
	}
	// The coding agent and every workspace package it depends on.
	const closure = new Map<string, PackageInfo>();
	const pending = [ROOT_PACKAGE];
	while (pending.length > 0) {
		const name = pending.pop()!;
		const pkg = byName.get(name);
		if (!pkg || closure.has(name)) continue;
		closure.set(name, pkg);
		pending.push(...pkg.deps);
	}
	return closure;
}

const parsed = new Map<string, SourceFile>();

async function loadFiles(packages: Map<string, PackageInfo>): Promise<Map<string, SourceFile>> {
	const files = new Map<string, SourceFile>();
	for (const pkg of packages.values()) {
		const cwd = path.join(PACKAGES_DIR, pkg.dir);
		for await (const rel of new Bun.Glob(SOURCE_GLOB).scan({ cwd })) {
			const key = `${pkg.dir}/${rel.replaceAll("\\", "/")}`;
			const text = await Bun.file(path.join(cwd, rel)).text();
			const ast = parse(text, {
				sourceType: "module",
				plugins: [
					"typescript",
					...(/\.[jt]sx$/.test(rel) ? (["jsx"] as const) : []),
					"decorators-legacy",
					"explicitResourceManagement",
					"importAttributes",
				],
			});
			const file: SourceFile = {
				key,
				pkg,
				text,
				ast: ast as unknown as Node,
				comments: ast.comments as unknown as Comment[],
			};
			files.set(key, file);
			parsed.set(key, file);
		}
	}
	return files;
}

/** A module a specifier names: a walked file, a transport package, or nothing the walk sees. */
type ModuleRef = { kind: "file"; key: string } | { kind: "transport"; pkg: string } | undefined;

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveFileKey(base: string, files: ReadonlyMap<string, SourceFile>): string | undefined {
	const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
	for (const candidate of [base, stripped]) {
		for (const ext of EXTENSIONS) if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
		for (const ext of EXTENSIONS.slice(1))
			if (files.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
	}
	return undefined;
}

function resolveModule(
	from: SourceFile,
	specifier: string,
	packages: ReadonlyMap<string, PackageInfo>,
	files: ReadonlyMap<string, SourceFile>,
): ModuleRef {
	if (specifier.startsWith(".")) {
		const key = resolveFileKey(path.posix.join(path.posix.dirname(from.key), specifier), files);
		return key ? { kind: "file", key } : undefined;
	}
	const match = /^(@oh-my-pi\/[^/]+)(?:\/(.*))?$/.exec(specifier);
	const pkg = match && packages.get(match[1]);
	if (!pkg) return undefined;
	if (pkg.transport) return { kind: "transport", pkg: pkg.name };
	const subpath = match[2] ? `./${match[2]}` : ".";
	for (const [pattern, target] of Object.entries(pkg.exports)) {
		const entry =
			typeof target === "string"
				? target
				: ((target as { import?: string; types?: string }).import ?? (target as { types?: string }).types);
		if (typeof entry !== "string") continue;
		let resolved: string | undefined;
		if (pattern === subpath) resolved = entry;
		else if (pattern.includes("*")) {
			const [prefix, suffix] = pattern.split("*");
			if (subpath.startsWith(prefix) && subpath.endsWith(suffix ?? "")) {
				resolved = entry.replace("*", subpath.slice(prefix.length, subpath.length - (suffix?.length ?? 0)));
			}
		}
		if (resolved === undefined) continue;
		const key = resolveFileKey(path.posix.join(pkg.dir, resolved), files);
		if (key) return { kind: "file", key };
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Constructors: the names whose uses are creation sites

interface Constructor {
	/** `pkg:<package>:<name>`, `fn:<file>:<name>`, `member:<file or *>:<name>`, `global:<name>`. */
	id: string;
	name: string;
	signal: SignalSpec;
	/** Where a `caller` declaration defined it, for problems. */
	origin?: string;
}

const byId = new Map<string, Constructor>();

function addConstructor(id: string, name: string, signal: SignalSpec, origin?: string): Constructor {
	const existing = byId.get(id);
	if (!existing) {
		const created = { id, name, signal, origin };
		byId.set(id, created);
		return created;
	}
	// Two sites inside one caller can each take its signal from a parameter: it must supply both.
	if (existing.signal.kind === "paths" && signal.kind === "paths") {
		for (const extra of signal.paths) {
			if (!existing.signal.paths.some(p => p.arg === extra.arg && p.prop === extra.prop))
				existing.signal.paths.push(extra);
		}
	} else if (existing.signal.kind === "unknown") {
		existing.signal = signal;
	}
	return existing;
}

/** What a binding in a file refers to. */
type Binding = { kind: "constructor"; id: string } | { kind: "namespace"; module: ModuleRef };

class Graph {
	readonly #files: ReadonlyMap<string, SourceFile>;
	readonly #packages: ReadonlyMap<string, PackageInfo>;

	constructor(files: ReadonlyMap<string, SourceFile>, packages: ReadonlyMap<string, PackageInfo>) {
		this.#files = files;
		this.#packages = packages;
	}

	module(from: SourceFile, specifier: string): ModuleRef {
		return resolveModule(from, specifier, this.#packages, this.#files);
	}

	/** The constructor `name` exported by `module` refers to, following re-exports and barrels. */
	exported(module: ModuleRef, name: string, seen = new Set<string>()): string | undefined {
		if (!module) return undefined;
		if (module.kind === "transport") {
			const id = `pkg:${module.pkg}:${name}`;
			return byId.has(id) ? id : undefined;
		}
		const visit = `${module.key}:${name}`;
		if (seen.has(visit)) return undefined;
		seen.add(visit);
		const file = this.#files.get(module.key);
		if (!file) return undefined;
		for (const statement of children(child(file.ast, "program"), "body")) {
			if (statement.type === "ExportNamedDeclaration") {
				if (statement.exportKind === "type") continue;
				const declaration = child(statement, "declaration");
				if (declaration) {
					const declared = declaredNames(declaration);
					if (declared.includes(name)) {
						const id = `fn:${file.key}:${name}`;
						return byId.has(id) ? id : undefined;
					}
					continue;
				}
				const source = child(statement, "source");
				for (const specifier of children(statement, "specifiers")) {
					if (nameOf(child(specifier, "exported")) !== name) continue;
					const local = nameOf(child(specifier, "local")) ?? name;
					if (source) return this.exported(this.module(file, source.value as string), local, seen);
					const binding = this.bindings(file).get(local);
					if (binding?.kind === "constructor") return binding.id;
					const id = `fn:${file.key}:${local}`;
					return byId.has(id) ? id : undefined;
				}
			}
			if (
				statement.type === "ExportAllDeclaration" &&
				statement.exportKind !== "type" &&
				!child(statement, "exported")
			) {
				const found = this.exported(this.module(file, child(statement, "source")?.value as string), name, seen);
				if (found) return found;
			}
			if (statement.type === "ExportDefaultDeclaration" && name === "default") {
				const declared = nameOf(child(child(statement, "declaration"), "id"));
				const id = declared && `fn:${file.key}:${declared}`;
				return id && byId.has(id) ? id : undefined;
			}
		}
		return undefined;
	}

	/** Whether `module` exports any constructor, directly or through barrels. */
	exportsAny(module: ModuleRef): boolean {
		if (!module) return false;
		if (module.kind === "transport") return true;
		for (const constructor of byId.values()) {
			const name = constructor.name.replace(/^#/, "");
			if (this.exported(module, name)) return true;
		}
		return false;
	}

	readonly #bindingCache = new Map<string, { version: number; map: Map<string, Binding> }>();
	version = 0;

	/** What each top-level name of `file` refers to, for the constructors known now. */
	bindings(file: SourceFile): Map<string, Binding> {
		const cached = this.#bindingCache.get(file.key);
		if (cached?.version === this.version) return cached.map;
		const map = new Map<string, Binding>();
		this.#bindingCache.set(file.key, { version: this.version, map });
		for (const statement of children(child(file.ast, "program"), "body")) {
			if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
			const module = this.module(file, child(statement, "source")?.value as string);
			for (const specifier of children(statement, "specifiers")) {
				const local = nameOf(child(specifier, "local"));
				if (!local || specifier.importKind === "type") continue;
				if (specifier.type === "ImportNamespaceSpecifier") {
					map.set(local, { kind: "namespace", module });
					continue;
				}
				const imported =
					specifier.type === "ImportDefaultSpecifier"
						? "default"
						: (nameOf(child(specifier, "imported")) ?? local);
				const id = this.exported(module, imported);
				if (id) map.set(local, { kind: "constructor", id });
			}
		}
		// Local definitions of constructors (a helper a `caller` names, a source primitive).
		for (const constructor of byId.values()) {
			if (constructor.id.startsWith(`fn:${file.key}:`) && !map.has(constructor.name)) {
				map.set(constructor.name, { kind: "constructor", id: constructor.id });
			}
		}
		// Dynamic imports and requires bound to a name.
		if (!DYNAMIC_IMPORT.test(file.text)) return map;
		walk(file.ast, node => {
			if (node.type !== "VariableDeclarator") return;
			const required = requiredModule(unwrap(child(node, "init")));
			if (required === undefined) return;
			const module = this.module(file, required);
			const id = child(node, "id");
			if (id?.type === "Identifier") map.set(id.name as string, { kind: "namespace", module });
			if (id?.type === "ObjectPattern") {
				for (const property of children(id, "properties")) {
					const key = nameOf(child(property, "key"));
					const local = nameOf(child(property, "value"));
					const found = key && this.exported(module, key);
					if (found && local) map.set(local, { kind: "constructor", id: found });
				}
			}
		});
		return map;
	}
}

/** Text that may hold a dynamic import or require, in any quote style. */
const DYNAMIC_IMPORT = /\b(import|require)\s*\(/;
/** Text that may reach a module's names without spelling them: a namespace import or a dynamic one. */
const INDIRECT_IMPORT = /\bimport\s*\*|\b(import|require)\s*\(/;

/** The specifier of `import("x")`, `await import("x")` or `require("x")`, if `node` is one. */
function requiredModule(node: Node | undefined): string | undefined {
	let current = node;
	if (current?.type === "AwaitExpression") current = unwrap(child(current, "argument"));
	if (current?.type !== "CallExpression" && current?.type !== "ImportExpression") return undefined;
	const callee = child(current, "callee");
	const isImport = current.type === "ImportExpression" || callee?.type === "Import";
	const isRequire = callee?.type === "Identifier" && callee.name === "require";
	if (!isImport && !isRequire) return undefined;
	const source = current.type === "ImportExpression" ? child(current, "source") : children(current, "arguments")[0];
	return source?.type === "StringLiteral" ? (source.value as string) : undefined;
}

/** Names a declaration statement introduces. */
function declaredNames(declaration: Node): string[] {
	if (declaration.type === "VariableDeclaration") {
		return children(declaration, "declarations").flatMap(d => {
			const id = child(d, "id");
			return id?.type === "Identifier" ? [id.name as string] : [];
		});
	}
	const id = nameOf(child(declaration, "id"));
	return id ? [id] : [];
}

// ---------------------------------------------------------------------------------------------
// Sites

interface Site {
	file: SourceFile;
	line: number;
	constructor: Constructor;
	use: "call" | "new" | "value" | "unresolved";
	/** The call or construction for a call/new use; the value expression otherwise. */
	node: Node;
	ancestors: readonly Node[];
	owner?: string;
	names?: string[];
	reason?: string;
	declarationStart?: number;
}

const STATEMENT_LEVEL = /Statement$|Declaration$|^Class(Private)?(Method|Property)$/;

/** The `model-request:` declaration nearest above the innermost node of `chain`, up to its statement. */
function declarationOf(chain: readonly Node[]): Pick<Site, "owner" | "names" | "reason" | "declarationStart"> {
	for (let index = chain.length - 1; index >= 0; index--) {
		const node = chain[index];
		for (const comment of node.leadingComments ?? []) {
			const match = DECLARATION.exec(comment.value);
			if (!match) continue;
			const owner = match[1];
			let rest = match[2];
			let names: string[] | undefined;
			if (NAMED_OWNERS.has(owner)) {
				const listed = /^\s*([\w#$.]+(?:\([\w$.]+\))?(?:\s*,\s*[\w#$.]+(?:\([\w$.]+\))?)*)/.exec(rest);
				names = listed ? listed[1].split(/\s*,\s*/) : [];
				rest = listed ? rest.slice(listed[0].length) : rest;
			}
			const reason = rest.replace(/^\s*[—-]\s*/, "").trim();
			return { owner, names, reason, declarationStart: comment.start ?? undefined };
		}
		// A statement is the last place a declaration may sit; an exported declaration's comment sits on the export,
		// and a statement that is the unbraced body of an `if` or a loop may carry its comment on that.
		const holder = chain[index - 1]?.type ?? "";
		const passThrough =
			/^Export(Named|Default)Declaration$/.test(holder) ||
			/^(IfStatement|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|LabeledStatement)$/.test(
				holder,
			);
		if (STATEMENT_LEVEL.test(node.type) && !passThrough) break;
	}
	return {};
}

/** Whether identifier `node` (parent last in `ancestors`) is a value use, not a declaration, key or type. */
function isValueUse(node: Node, ancestors: readonly Node[]): boolean {
	const parent = ancestors.at(-1);
	if (!parent) return false;
	// `#name`: a private member's name, not a binding.
	if (parent.type === "PrivateName") return false;
	if (ancestors.some(ancestor => TYPE_LEVEL.test(ancestor.type))) return false;
	if (/^(Import|Export)/.test(parent.type)) return false;
	// `{ key: name }` in a pattern declares `name`.
	if (parent.type === "ObjectProperty" && parent.value === node && ancestors.at(-2)?.type === "ObjectPattern")
		return false;
	if (parent.type === "VariableDeclarator" && parent.id === node) return false;
	if (/^(Function|Class|TSEnum)/.test(parent.type) && parent.id === node) return false;
	if (isFunctionLike(parent) && children(parent, "params").includes(node)) return false;
	if (/MemberExpression$/.test(parent.type) && parent.property === node && !parent.computed) return false;
	if (/^(Class|Object)(Private)?(Method|Property)$/.test(parent.type) && parent.key === node && !parent.computed) {
		if (parent.type !== "ObjectProperty" || parent.shorthand !== true) return false;
		// `{ name }` in a pattern declares `name`.
		return ancestors.at(-2)?.type !== "ObjectPattern";
	}
	if (parent.type === "AssignmentPattern" && parent.left === node) return false;
	if (parent.type === "RestElement" || parent.type === "ArrayPattern") return false;
	if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") {
		return false;
	}
	if (parent.type === "CatchClause") return false;
	return true;
}

/** Whether `name` is declared in a scope enclosing the innermost node of `ancestors` (so not a global). */
function locallyBound(name: string, ancestors: readonly Node[], file: SourceFile): boolean {
	const declares = (scope: Node): boolean => {
		let found = false;
		const patternBinds = (pattern: Node | undefined): void => {
			if (!pattern || found) return;
			if (pattern.type === "Identifier" && pattern.name === name) found = true;
			if (pattern.type === "AssignmentPattern") patternBinds(child(pattern, "left"));
			if (pattern.type === "RestElement") patternBinds(child(pattern, "argument"));
			if (pattern.type === "ObjectPattern") {
				for (const property of children(pattern, "properties")) {
					patternBinds(property.type === "RestElement" ? child(property, "argument") : child(property, "value"));
				}
			}
			if (pattern.type === "ArrayPattern")
				for (const element of children(pattern, "elements")) patternBinds(element);
		};
		if (isFunctionLike(scope)) for (const param of children(scope, "params")) patternBinds(param);
		const body = isFunctionLike(scope) ? child(scope, "body") : scope;
		if (!body) return found;
		walk(body, (node, nodeAncestors) => {
			if (found) return;
			// Declarations inside nested functions belong to those.
			if (nodeAncestors.slice(1).some(isFunctionLike) && body !== node) return;
			if (node.type === "VariableDeclarator") patternBinds(child(node, "id"));
			if (
				(node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
				nameOf(child(node, "id")) === name
			) {
				found = true;
			}
			if (
				node.type === "ImportSpecifier" ||
				node.type === "ImportDefaultSpecifier" ||
				node.type === "ImportNamespaceSpecifier"
			) {
				if (nameOf(child(node, "local")) === name) found = true;
			}
		});
		return found;
	};
	for (const ancestor of ancestors) if (isFunctionLike(ancestor) && declares(ancestor)) return true;
	return declares(child(file.ast, "program") ?? file.ast);
}

/** The expression a use stands for, through transparent wrappers, and its parent. */
function outerUse(node: Node, ancestors: readonly Node[]): { expr: Node; parent: Node | undefined; chain: Node[] } {
	let expr = node;
	let index = ancestors.length - 1;
	while (index >= 0 && TRANSPARENT.has(ancestors[index].type)) {
		expr = ancestors[index];
		index--;
	}
	return { expr, parent: ancestors[index], chain: ancestors.slice(0, index + 1) };
}

/**
 * The call `expr` is the callee of, also through a fallback: `(options.fetch ?? fetch)(url, init)`
 * and `(cond ? a : fetch)(…)` call `fetch` when the fallback is taken.
 */
function calledThroughFallback(expr: Node, chain: readonly Node[]): { call: Node; chain: Node[] } | undefined {
	let current = expr;
	let index = chain.length - 1;
	while (index >= 0) {
		const parent = chain[index];
		const fallback =
			(parent.type === "LogicalExpression" && /^(\?\?|\|\|)$/.test(parent.operator as string)) ||
			(parent.type === "ConditionalExpression" && parent.test !== current);
		if (!TRANSPARENT.has(parent.type) && !fallback) break;
		current = parent;
		index--;
	}
	const call = chain[index];
	if (current === expr || !call || !/^(Call|OptionalCall|New)Expression$/.test(call.type) || call.callee !== current) {
		return undefined;
	}
	return { call, chain: chain.slice(0, index) };
}

function makeSite(file: SourceFile, constructor: Constructor, node: Node, ancestors: readonly Node[]): Site {
	const { expr, parent, chain } = outerUse(node, ancestors);
	const isCall = /CallExpression$/.test(parent?.type ?? "") && parent?.callee === expr;
	const isNew = parent?.type === "NewExpression" && parent.callee === expr;
	if (!isCall && !isNew) {
		const through = calledThroughFallback(expr, chain);
		if (through) {
			return {
				file,
				line: through.call.loc?.start.line ?? 0,
				constructor,
				use: through.call.type === "NewExpression" ? "new" : "call",
				node: through.call,
				ancestors: through.chain,
				...declarationOf([...through.chain, through.call]),
			};
		}
	}
	const use: Site["use"] = isNew ? "new" : isCall ? "call" : "value";
	const target = use === "value" ? expr : (parent as Node);
	const declarationChain = use === "value" ? [...chain, expr] : chain;
	return {
		file,
		line: target.loc?.start.line ?? 0,
		constructor,
		use,
		node: target,
		ancestors: use === "value" ? chain : chain.slice(0, -1),
		...declarationOf(declarationChain),
	};
}

/** Every site of the known constructors in `file`. */
function sitesIn(file: SourceFile, graph: Graph, hindsightMethods: ReadonlySet<string>): Site[] {
	const sites: Site[] = [];
	const bindings = graph.bindings(file);
	const transportFile = file.pkg.transport;
	const privateMembers = new Map<string, Constructor>();
	const publicMembers = new Map<string, Constructor>();
	for (const constructor of byId.values()) {
		if (constructor.id.startsWith(`member:${file.key}:`)) privateMembers.set(constructor.name, constructor);
		if (constructor.id.startsWith("member:*:")) publicMembers.set(constructor.name, constructor);
	}
	walk(file.ast, (node, ancestors) => {
		const parent = ancestors.at(-1);
		// Network globals: in every package, transport ones included.
		if (node.type === "Identifier" && Object.hasOwn(NETWORK_GLOBALS, node.name as string)) {
			// `WebSocket.OPEN` reads a constant; only `fetch.call(…)`-style member uses send anything.
			const member = /MemberExpression$/.test(parent?.type ?? "") && parent?.object === node && !parent.computed;
			const invokes = member && /^(call|apply|bind)$/.test(nameOf(child(parent, "property")) ?? "");
			if (member && !invokes) return;
			if (isValueUse(node, ancestors) && !locallyBound(node.name as string, ancestors, file)) {
				sites.push(makeSite(file, byId.get(`global:${node.name}`)!, node, ancestors));
			}
			return;
		}
		if (
			/MemberExpression$/.test(node.type) &&
			GLOBAL_OBJECTS.has(nameOf(child(node, "object")) ?? "") &&
			!node.computed &&
			Object.hasOwn(NETWORK_GLOBALS, nameOf(child(node, "property")) ?? "") &&
			!ancestors.some(ancestor => TYPE_LEVEL.test(ancestor.type)) &&
			// `globalThis.fetch = wrapped`: replacing the global sends nothing.
			!(parent?.type === "AssignmentExpression" && parent.left === node)
		) {
			sites.push(makeSite(file, byId.get(`global:${nameOf(child(node, "property"))}`)!, node, ancestors));
			return;
		}
		// Inside a transport package only network sites are checked.
		if (transportFile) return;
		if (node.type === "Identifier" && isValueUse(node, ancestors)) {
			const binding = bindings.get(node.name as string);
			if (binding?.kind === "constructor") {
				sites.push(makeSite(file, byId.get(binding.id)!, node, ancestors));
			} else if (binding?.kind === "namespace") {
				// A namespace of a request module used other than as `ns.name`: computed access, handed on.
				const { parent: outer } = outerUse(node, ancestors);
				const member = /MemberExpression$/.test(outer?.type ?? "") && !outer?.computed;
				if (!member && graph.exportsAny(binding.module)) {
					const unresolved = addConstructor(`namespace:${file.key}:${node.name}`, `${node.name}[…]`, {
						kind: "unknown",
					});
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
				}
			}
			return;
		}
		if (/MemberExpression$/.test(node.type) && !node.computed) {
			const object = unwrap(child(node, "object"));
			const property = nameOf(child(node, "property"));
			if (!property) return;
			if (object?.type === "Identifier") {
				const binding = bindings.get(object.name as string);
				if (binding?.kind === "namespace") {
					const id = graph.exported(binding.module, property);
					if (id) sites.push(makeSite(file, byId.get(id)!, node, ancestors));
					return;
				}
			}
			const assigned = parent?.type === "AssignmentExpression" && parent.left === node;
			if (assigned) return;
			if (object?.type === "ThisExpression" && privateMembers.has(property)) {
				sites.push(makeSite(file, privateMembers.get(property)!, node, ancestors));
				return;
			}
			// A public member is matched by name in every file, so only calls of it count: `x.search(…)`, not a read of
			// `url.search` or a `typeof x.recall` test. Handing the method on as a value is outside the walk.
			const member = publicMembers.get(property);
			const { expr: memberUse, parent: memberParent } = outerUse(node, ancestors);
			if (member && /CallExpression$/.test(memberParent?.type ?? "") && memberParent?.callee === memberUse) {
				sites.push(makeSite(file, member, node, ancestors));
				return;
			}
			// Hindsight: `client.<method>(…)`, `state.client.<method>(…)`.
			const receiver = object?.type === "MemberExpression" ? nameOf(child(object, "property")) : nameOf(object);
			if (receiver === "client" && hindsightMethods.has(property) && file.key !== HINDSIGHT.file) {
				const id = `hindsight:${property}`;
				const constructor =
					byId.get(id) ?? addConstructor(id, `${HINDSIGHT.className}.${property}`, { kind: "last-options" });
				sites.push(makeSite(file, constructor, node, ancestors));
			}
			return;
		}
		// A dynamic import or require of a request module that is not bound to a name.
		if (node.type === "AwaitExpression") return;
		const required = requiredModule(node);
		if (required === undefined) return;
		const holder = parent?.type === "AwaitExpression" ? ancestors.at(-2) : parent;
		const bound =
			holder?.type === "VariableDeclarator" && /^(Identifier|ObjectPattern)$/.test(child(holder, "id")?.type ?? "");
		if (!bound && graph.exportsAny(graph.module(file, required))) {
			const unresolved = addConstructor(`import:${file.key}:${required}`, `import(${required})`, {
				kind: "unknown",
			});
			sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
		}
	});
	return sites;
}

// ---------------------------------------------------------------------------------------------
// Signals: what a site supplies, and where it comes from

const isUndefinedLiteral = (node: Node | undefined): boolean => {
	const value = unwrap(node);
	if (!value) return true;
	if (value.type === "Identifier" && value.name === "undefined") return true;
	if (value.type === "NullLiteral") return true;
	return value.type === "UnaryExpression" && value.operator === "void";
};

/** A value an expression stands for: `node` itself, or its property `prop`. */
interface Source {
	node: Node;
	prop?: string;
}

/**
 * The innermost declaration of local `name` above `ancestors`: a variable's initializer (with the
 * property it was destructured from, if any) or a parameter.
 */
function localDeclaration(
	name: string,
	ancestors: readonly Node[],
): { init?: Node; initProp?: string; param?: { fn: Node; index: number; prop?: string } } | undefined {
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const scope = ancestors[index];
		if (isFunctionLike(scope)) {
			const params = children(scope, "params");
			for (let i = 0; i < params.length; i++) {
				const param = params[i].type === "AssignmentPattern" ? child(params[i], "left") : params[i];
				if (param?.type === "Identifier" && param.name === name) return { param: { fn: scope, index: i } };
				const pattern = param?.type === "TSParameterProperty" ? child(param, "parameter") : param;
				if (pattern?.type === "ObjectPattern") {
					for (const property of children(pattern, "properties")) {
						if (property.type === "RestElement" && nameOf(child(property, "argument")) === name) {
							return { param: { fn: scope, index: i } };
						}
						const value = child(property, "value");
						const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
						if (nameOf(local) === name)
							return { param: { fn: scope, index: i, prop: nameOf(child(property, "key")) } };
					}
				}
			}
		}
		const body = isFunctionLike(scope) ? child(scope, "body") : scope.type === "Program" ? scope : undefined;
		if (!body) continue;
		let found: { init?: Node; initProp?: string } | undefined;
		walk(body, (node, nodeAncestors) => {
			if (found || node.type !== "VariableDeclarator") return;
			if (nodeAncestors.slice(1).some(isFunctionLike)) return;
			const id = child(node, "id");
			if (nameOf(id) === name) {
				found = { init: child(node, "init") };
				return;
			}
			if (id?.type !== "ObjectPattern") return;
			for (const property of children(id, "properties")) {
				if (property.type === "RestElement" && nameOf(child(property, "argument")) === name) {
					found = { init: child(node, "init") };
					return;
				}
				const value = child(property, "value");
				const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
				if (nameOf(local) === name) {
					found = { init: child(node, "init"), initProp: nameOf(child(property, "key")) };
					return;
				}
			}
		});
		if (found?.init) return found;
	}
	return undefined;
}

/**
 * Where `source` (an argument, or a property of one) comes from: the expressions that supply the
 * signal, `missing` when it is visibly absent or `undefined`.
 */
function supply(source: Source, ancestors: readonly Node[], depth = 0): { missing: string } | { sources: Source[] } {
	if (depth > 8) return { sources: [source] };
	const node = unwrap(source.node);
	if (!node) return { missing: "no argument" };
	if (!source.prop) {
		if (isUndefinedLiteral(node)) return { missing: "the signal is undefined" };
		return { sources: [{ node }] };
	}
	if (node.type === "ObjectExpression") {
		const [head, ...rest] = source.prop.split(".");
		const properties = children(node, "properties");
		for (let index = properties.length - 1; index >= 0; index--) {
			const property = properties[index];
			if (property.type === "SpreadElement") {
				const spread = supply({ node: child(property, "argument")!, prop: source.prop }, ancestors, depth + 1);
				if ("sources" in spread) return spread;
				continue;
			}
			if (property.computed || nameOf(child(property, "key")) !== head) continue;
			if (property.type === "ObjectMethod") return { sources: [{ node: property }] };
			const value = child(property, property.shorthand ? "key" : "value");
			return supply({ node: value!, prop: rest.join(".") || undefined }, ancestors, depth + 1);
		}
		return { missing: `the options carry no \`${source.prop}\`` };
	}
	if (node.type === "Identifier") {
		const declared = localDeclaration(node.name as string, ancestors);
		if (declared?.init && !declared.initProp) {
			return supply({ node: declared.init, prop: source.prop }, ancestors, depth + 1);
		}
		if (declared?.init && declared.initProp && !source.prop) {
			return supply({ node: declared.init, prop: declared.initProp }, ancestors, depth + 1);
		}
		return { sources: [{ node, prop: source.prop }] };
	}
	if (node.type === "ConditionalExpression") {
		const branches = [child(node, "consequent")!, child(node, "alternate")!].map(branch =>
			supply({ node: branch, prop: source.prop }, ancestors, depth + 1),
		);
		const missing = branches.find(branch => "missing" in branch);
		if (missing) return missing;
		return { sources: branches.flatMap(branch => ("sources" in branch ? branch.sources : [])) };
	}
	if (node.type === "LogicalExpression")
		return supply({ node: child(node, "left")!, prop: source.prop }, ancestors, depth + 1);
	return { sources: [{ node, prop: source.prop }] };
}

/** A call that sends the request: the site's own call, or one of a handed-on value it was stored in. */
interface RequestCall {
	node: Node;
	ancestors: readonly Node[];
}

/**
 * The calls through which a site sends its request: the call or construction itself; for a value
 * stored in a local binding (`const f = options.fetch ?? fetch`, a default `f = fetch`) or a private
 * member (`this.#fetch = …`), every call of that binding in its scope or of that member in its file.
 * `undefined` when the value goes where the walk cannot follow (an argument, a public field).
 */
function requestCalls(site: Site): RequestCall[] | undefined {
	if (site.use === "call" || site.use === "new") return [{ node: site.node, ancestors: site.ancestors }];
	if (site.use !== "value") return undefined;
	const stored = storedIn(site.node, site.ancestors);
	if (!stored?.name) return undefined;
	const isPrivate = stored.kind === "member" && stored.name.startsWith("#");
	if (stored.kind === "member" && !isPrivate) return undefined;
	const scope = isPrivate
		? site.ancestors.findLast(node => node.type === "ClassDeclaration" || node.type === "ClassExpression")
		: (site.ancestors.findLast(isFunctionLike) ?? child(site.file.ast, "program"));
	if (!scope) return undefined;
	const calls: RequestCall[] = [];
	walk(site.file.ast, (node, ancestors) => {
		if (!/^(Call|OptionalCall|New)Expression$/.test(node.type) || !ancestors.includes(scope)) return;
		let callee = unwrap(child(node, "callee"));
		// `(f ?? other)(…)` calls `f` too.
		while (callee?.type === "LogicalExpression") callee = unwrap(child(callee, "left"));
		const matches = isPrivate
			? callee?.type === "MemberExpression" &&
				unwrap(child(callee, "object"))?.type === "ThisExpression" &&
				nameOf(child(callee, "property")) === stored.name
			: callee?.type === "Identifier" && callee.name === stored.name;
		if (matches) calls.push({ node, ancestors: [...ancestors] });
	});
	return calls;
}

/** The value a `signal` path of a call or construction supplies. */
function supplyAt(site: RequestCall, path: SignalPath): { missing: string } | { sources: Source[] } {
	const args = children(site.node, "arguments");
	if (args.slice(0, path.arg + 1).some(arg => arg.type === "SpreadElement")) return { sources: [{ node: site.node }] };
	const arg = args[path.arg];
	if (!arg) return { missing: `argument ${path.arg + 1} is not passed` };
	return supply({ node: arg, prop: path.prop }, site.ancestors);
}

/** The signal paths a constructor needs at a site. */
function pathsFor(constructor: Constructor, site: Site): SignalPath[] | "exempt" | "none" | "unknown" {
	const spec = constructor.signal;
	if (spec.kind === "later") return "exempt";
	if (spec.kind === "none") return "none";
	if (spec.kind === "unknown") return "unknown";
	if (spec.kind === "last-options") {
		const count = children(site.node, "arguments").length;
		return [{ arg: Math.max(0, count - 1), prop: "signal" }];
	}
	return spec.paths;
}

/** A parameter of a caller a signal comes from. */
interface ParamRef {
	index: number;
	prop?: string;
}

/**
 * The parameters of `fn` (a function, method or class) that `source` comes from, through local
 * variables, `AbortSignal.any([...])`, conditionals and fields a constructor fills from parameters.
 */
function traceToParams(source: Source, fn: Node, ancestors: readonly Node[], depth = 0): ParamRef[] {
	if (depth > 8) return [];
	const node = unwrap(source.node);
	if (!node) return [];
	const params = fn.type === "ClassDeclaration" || fn.type === "ClassExpression" ? constructorOf(fn) : fn;
	const own = (name: string): ParamRef | undefined => {
		const declared = localDeclaration(name, ancestors);
		if (declared?.param && declared.param.fn === params) {
			const prop = [declared.param.prop, source.prop].filter(Boolean).join(".") || undefined;
			return { index: declared.param.index, prop };
		}
		return undefined;
	};
	switch (node.type) {
		case "Identifier": {
			const ref = own(node.name as string);
			if (ref) return [ref];
			const declared = localDeclaration(node.name as string, ancestors);
			if (!declared?.init) return [];
			const prop = [declared.initProp, source.prop].filter(Boolean).join(".") || undefined;
			return traceToParams({ node: declared.init, prop }, fn, ancestors, depth + 1);
		}
		case "MemberExpression":
		case "OptionalMemberExpression": {
			const object = unwrap(child(node, "object"));
			const property = nameOf(child(node, "property"));
			if (!property || node.computed) return [];
			const prop = [property, source.prop].filter(Boolean).join(".");
			if (object?.type === "Identifier") {
				const ref = own(object.name as string);
				if (ref) return [{ index: ref.index, prop: [ref.prop, prop].filter(Boolean).join(".") }];
				const declared = localDeclaration(object.name as string, ancestors);
				if (declared?.init) {
					const chained = [declared.initProp, prop].filter(Boolean).join(".");
					return traceToParams({ node: declared.init, prop: chained }, fn, ancestors, depth + 1);
				}
				return [];
			}
			// `this.#field.signal`: the constructor stored a parameter in the field.
			if (object?.type === "MemberExpression" && unwrap(child(object, "object"))?.type === "ThisExpression") {
				const field = nameOf(child(object, "property"));
				const klass = ancestors.findLast(a => a.type === "ClassDeclaration" || a.type === "ClassExpression");
				const ctor = klass && constructorOf(klass);
				if (!field || !ctor || (params !== ctor && fn !== klass)) return [];
				return fieldFromParam(ctor, field).map(ref => ({
					index: ref.index,
					prop: [ref.prop, prop].filter(Boolean).join("."),
				}));
			}
			return [];
		}
		case "CallExpression": {
			const callee = unwrap(child(node, "callee"));
			const isAny =
				callee?.type === "MemberExpression" &&
				nameOf(child(callee, "object")) === "AbortSignal" &&
				nameOf(child(callee, "property")) === "any";
			if (!isAny) return [];
			return children(children(node, "arguments")[0], "elements").flatMap(element =>
				traceToParams({ node: element }, fn, ancestors, depth + 1),
			);
		}
		case "ConditionalExpression":
			return [child(node, "consequent"), child(node, "alternate"), child(node, "test")].flatMap(branch =>
				branch ? traceToParams({ node: branch, prop: source.prop }, fn, ancestors, depth + 1) : [],
			);
		case "LogicalExpression":
			return [child(node, "left"), child(node, "right")].flatMap(branch =>
				branch ? traceToParams({ node: branch, prop: source.prop }, fn, ancestors, depth + 1) : [],
			);
		case "ArrayExpression":
			return children(node, "elements").flatMap(element =>
				traceToParams({ node: element }, fn, ancestors, depth + 1),
			);
		case "ObjectExpression": {
			if (!source.prop) return [];
			const [head, ...rest] = source.prop.split(".");
			const refs: ParamRef[] = [];
			for (const property of children(node, "properties")) {
				if (property.type === "SpreadElement") {
					refs.push(
						...traceToParams({ node: child(property, "argument")!, prop: source.prop }, fn, ancestors, depth + 1),
					);
				} else if (!property.computed && nameOf(child(property, "key")) === head) {
					const value = child(property, property.shorthand ? "key" : "value");
					if (value)
						refs.push(
							...traceToParams({ node: value, prop: rest.join(".") || undefined }, fn, ancestors, depth + 1),
						);
				}
			}
			return refs;
		}
		default:
			return [];
	}
}

function constructorOf(klass: Node): Node | undefined {
	return children(child(klass, "body"), "body").find(
		member => member.type === "ClassMethod" && member.kind === "constructor",
	);
}

/** The parameters a class constructor stores in `this.<field>` (`this.#deps = deps`, or a parameter property). */
function fieldFromParam(ctor: Node, field: string): ParamRef[] {
	const params = children(ctor, "params");
	const refs: ParamRef[] = [];
	params.forEach((param, index) => {
		if (
			param.type === "TSParameterProperty" &&
			nameOf(child(child(param, "parameter"), "left") ?? child(param, "parameter")) === field
		) {
			refs.push({ index });
		}
	});
	walk(child(ctor, "body")!, node => {
		if (node.type !== "AssignmentExpression") return;
		const left = child(node, "left");
		if (left?.type !== "MemberExpression" || nameOf(child(left, "property")) !== field) return;
		const right = unwrap(child(node, "right"));
		const index = params.findIndex(
			param => nameOf(param.type === "AssignmentPattern" ? child(param, "left") : param) === nameOf(right),
		);
		if (right?.type === "Identifier" && index >= 0) refs.push({ index });
	});
	return refs;
}

// ---------------------------------------------------------------------------------------------
// Callers: the names a `caller` declaration hands its requirement to

/** The function, class or member `name` that encloses the site, or that stores the handed-on value. */
function callerTarget(site: Site, name: string): { id: string; node?: Node; stored?: boolean } | undefined {
	const file = site.file;
	if (site.use === "value") {
		const stored = storedIn(site.node, site.ancestors);
		if (stored?.name === name) {
			if (stored.kind === "member") {
				const id = name.startsWith("#") ? `member:${file.key}:${name}` : `member:*:${name}`;
				return { id, stored: true };
			}
			return { id: `fn:${file.key}:${name}`, stored: true };
		}
	}
	for (let index = site.ancestors.length - 1; index >= 0; index--) {
		const node = site.ancestors[index];
		if (
			(node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
			nameOf(child(node, "id")) === name
		) {
			return { id: `fn:${file.key}:${name}`, node };
		}
		if (node.type === "VariableDeclarator" && nameOf(child(node, "id")) === name) {
			const init = unwrap(child(node, "init"));
			if (init && isFunctionLike(init)) return { id: `fn:${file.key}:${name}`, node: init };
		}
		if (/^(Class(Private)?Method|ObjectMethod)$/.test(node.type) && nameOf(child(node, "key")) === name) {
			const id = name.startsWith("#") ? `member:${file.key}:${name}` : `member:*:${name}`;
			return { id, node };
		}
		if (/^(Class(Private)?Property|ObjectProperty)$/.test(node.type) && nameOf(child(node, "key")) === name) {
			const value = unwrap(child(node, "value"));
			if (value && isFunctionLike(value)) {
				const id = name.startsWith("#") ? `member:${file.key}:${name}` : `member:*:${name}`;
				return { id, node: value };
			}
		}
	}
	return undefined;
}

/** Where a handed-on value lands: `const x = v`, `this.#x = v`, `#x = v`, `{ x: v }`, `{ x }`. */
function storedIn(node: Node, ancestors: readonly Node[]): { name: string; kind: "binding" | "member" } | undefined {
	let current = node;
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const parent = ancestors[index];
		if (
			TRANSPARENT.has(parent.type) ||
			parent.type === "LogicalExpression" ||
			parent.type === "ConditionalExpression"
		) {
			current = parent;
			continue;
		}
		if (parent.type === "AssignmentExpression" && parent.right === current) {
			const left = child(parent, "left");
			if (left?.type === "Identifier") return { name: left.name as string, kind: "binding" };
			if (/MemberExpression$/.test(left?.type ?? ""))
				return { name: nameOf(child(left, "property")) ?? "", kind: "member" };
		}
		if (parent.type === "VariableDeclarator" && parent.init === current) {
			return { name: nameOf(child(parent, "id")) ?? "", kind: "binding" };
		}
		if (/^Class(Private)?Property$/.test(parent.type) && parent.value === current) {
			return { name: nameOf(child(parent, "key")) ?? "", kind: "member" };
		}
		if (parent.type === "ObjectProperty" && (parent.value === current || parent.shorthand === true)) {
			return { name: nameOf(child(parent, "key")) ?? "", kind: "member" };
		}
		if (parent.type === "AssignmentPattern" && parent.right === current) {
			// `private readonly x = value` in a constructor's parameters stores a public member.
			const kind = ancestors[index - 1]?.type === "TSParameterProperty" ? "member" : "binding";
			return { name: nameOf(child(parent, "left")) ?? "", kind };
		}
		return undefined;
	}
	return undefined;
}

/**
 * Whether a value site is a property of an options object passed to a call the walk already checks
 * (`generateImage(model, request, { fetch: ctx.fetch ?? fetch, signal })`): that call's own signal
 * cancels it.
 */
function optionsOfCheckedCall(site: Site, checked: ReadonlySet<Node>): boolean {
	let current = site.node;
	for (let index = site.ancestors.length - 1; index >= 0; index--) {
		const parent = site.ancestors[index];
		if (
			TRANSPARENT.has(parent.type) ||
			/^(LogicalExpression|ConditionalExpression|ObjectProperty|ObjectExpression)$/.test(parent.type)
		) {
			current = parent;
			continue;
		}
		return (
			current.type === "ObjectExpression" &&
			/^(Call|OptionalCall|New)Expression$/.test(parent.type) &&
			children(parent, "arguments").includes(current) &&
			checked.has(parent)
		);
	}
	return false;
}

/** A `caller` entry: `name`, or `name(param.prop)` naming the parameter the signal enters through. */
function splitCaller(raw: string): { name: string; param?: string } {
	const match = /^([\w#$.]+)(?:\(([\w$.]+)\))?$/.exec(raw);
	return match ? { name: match[1], param: match[2] } : { name: raw };
}

/** The signal path `param` (`options.signal`, `signal`) names on function or class `fn`. */
function explicitPath(fn: Node, param: string): SignalPath | undefined {
	const [head, ...rest] = param.split(".");
	const target = fn.type === "ClassDeclaration" || fn.type === "ClassExpression" ? constructorOf(fn) : fn;
	const index = children(target, "params").findIndex(p => {
		const binding =
			p.type === "AssignmentPattern"
				? child(p, "left")
				: p.type === "TSParameterProperty"
					? child(p, "parameter")
					: p;
		return nameOf(binding) === head;
	});
	if (index < 0) return undefined;
	return rest.length > 0 ? { arg: index, prop: rest.join(".") } : { arg: index };
}

// ---------------------------------------------------------------------------------------------
// The check

async function hindsightMethods(files: ReadonlyMap<string, SourceFile>): Promise<Set<string>> {
	const methods = new Set<string>();
	const file = files.get(HINDSIGHT.file);
	if (!file) return methods;
	walk(file.ast, (node, ancestors) => {
		const owner = ancestors.at(-2);
		if (node.type !== "ClassMethod" || node.kind !== "method" || node.static || node.async !== true) return;
		if (owner?.type !== "ClassDeclaration" || nameOf(child(owner, "id")) !== HINDSIGHT.className) return;
		const name = nameOf(child(node, "key"));
		if (name) methods.add(name);
	});
	return methods;
}

/** Problems with how the Hindsight client is bound: the walk finds its requests by the name `client`. */
function hindsightBindings(files: ReadonlyMap<string, SourceFile>): string[] {
	const problems: string[] = [];
	for (const file of files.values()) {
		if (file.key === HINDSIGHT.file) continue;
		if (!file.text.includes(HINDSIGHT.className) && !file.text.includes(HINDSIGHT.factory)) continue;
		walk(file.ast, (node, ancestors) => {
			const parent = ancestors.at(-1);
			if (node.type === "TSTypeReference" && nameOf(child(node, "typeName")) === HINDSIGHT.className) {
				const holder = ancestors.at(-2);
				const bound = holder && (nameOf(holder) ?? nameOf(child(holder, "key")));
				if (parent?.type === "TSTypeAnnotation" && bound !== undefined && bound !== "client") {
					problems.push(
						`${file.key}:${node.loc?.start.line}: a Hindsight client bound as "${bound}"; name it "client"`,
					);
				}
			}
			if (/^(CallExpression|NewExpression)$/.test(node.type)) {
				const callee = nameOf(unwrap(child(node, "callee")));
				if (callee !== HINDSIGHT.factory && callee !== HINDSIGHT.className) return;
				const { parent: outer } = outerUse(node, ancestors);
				const target =
					outer?.type === "VariableDeclarator"
						? nameOf(child(outer, "id"))
						: outer?.type === "AssignmentExpression"
							? nameOf(child(child(outer, "left"), "property") ?? child(outer, "left"))
							: outer?.type === "ObjectProperty"
								? nameOf(child(outer, "key"))
								: undefined;
				if (target !== "client")
					problems.push(`${file.key}:${node.loc?.start.line}: a Hindsight client not stored as "client"`);
			}
		});
	}
	return problems;
}

describe("model request ownership", () => {
	it("every site that can create a model request declares who owns it", async () => {
		const packages = await loadPackages();
		const files = await loadFiles(packages);
		const graph = new Graph(files, packages);
		const problems: string[] = [];

		for (const [pkg, primitives] of Object.entries(TRANSPORT_PRIMITIVES)) {
			for (const [name, signal] of Object.entries(primitives)) addConstructor(`pkg:${pkg}:${name}`, name, signal);
		}
		for (const [file, primitives] of Object.entries(SOURCE_PRIMITIVES)) {
			for (const [name, signal] of Object.entries(primitives)) addConstructor(`fn:${file}:${name}`, name, signal);
		}
		for (const [name, signal] of Object.entries(NETWORK_GLOBALS)) addConstructor(`global:${name}`, name, signal);
		const methods = await hindsightMethods(files);
		expect([...methods]).toEqual(expect.arrayContaining(["recall", "retain", "retainBatch", "reflect"]));
		problems.push(...hindsightBindings(files));

		// Discover sites to a fixed point: each `caller` declaration adds a constructor whose uses are sites.
		const sites = new Map<string, Site>();
		const walkedIds = new Set<string>();
		for (let round = 0; ; round++) {
			const known = JSON.stringify([...byId.values()].map(constructor => [constructor.id, constructor.signal]));
			graph.version = round;
			// A file can hold a new site only if it spells a new constructor's name, or reaches modules
			// through a namespace or a dynamic import; the first round reads every file.
			const fresh = [...byId.values()].filter(constructor => !walkedIds.has(constructor.id));
			const names = [...new Set(fresh.map(constructor => constructor.name.replace(/^#/, "")))];
			for (const constructor of fresh) walkedIds.add(constructor.id);
			for (const file of files.values()) {
				if (round > 0 && !names.some(name => file.text.includes(name)) && !INDIRECT_IMPORT.test(file.text))
					continue;
				for (const site of sitesIn(file, graph, methods)) {
					const key = `${site.file.key}:${site.node.start}:${site.constructor.id}`;
					if (sites.has(key)) continue;
					sites.set(key, site);
					if (site.owner !== "caller") continue;
					for (const raw of site.names ?? []) {
						const { name } = splitCaller(raw);
						const target = callerTarget(site, name);
						if (!target) continue;
						addConstructor(target.id, name, { kind: "unknown" }, `${site.file.key}:${site.line}`);
					}
				}
			}
			// Requirements: trace each caller site's signal to the parameters of the name it hands it to.
			for (const site of sites.values()) {
				if (site.owner !== "caller") continue;
				for (const raw of site.names ?? []) {
					const { name, param } = splitCaller(raw);
					const target = callerTarget(site, name);
					if (!target) continue;
					const constructor = byId.get(target.id)!;
					if (target.stored) {
						if (constructor.signal.kind === "unknown") constructor.signal = site.constructor.signal;
						continue;
					}
					// `caller name(options.signal)`: the declaration says which parameter carries the signal in.
					if (param !== undefined) {
						const path = target.node && explicitPath(target.node, param);
						if (path) addConstructor(target.id, name, { kind: "paths", paths: [path] });
						continue;
					}
					const needed = pathsFor(site.constructor, site);
					if (!Array.isArray(needed)) continue;
					const refs: ParamRef[] = [];
					for (const call of requestCalls(site) ?? []) {
						for (const path of needed) {
							const supplied = supplyAt(call, path);
							if ("sources" in supplied) {
								for (const source of supplied.sources)
									refs.push(...traceToParams(source, target.node!, call.ancestors));
							}
						}
					}
					if (refs.length > 0) {
						addConstructor(target.id, name, {
							kind: "paths",
							paths: refs.map(ref => ({ arg: ref.index, ...(ref.prop ? { prop: ref.prop } : {}) })),
						});
					}
				}
			}
			const settled = JSON.stringify([...byId.values()].map(constructor => [constructor.id, constructor.signal]));
			if (settled === known && round > 0) break;
			if (round > 40) throw new Error("caller propagation did not settle");
		}

		// Check every site against its declaration and its constructor's final requirement.
		const siteNodes = new Set([...sites.values()].map(site => site.node));
		for (const site of sites.values()) {
			const where = `${site.file.key}:${site.line} (${site.use} of ${site.constructor.name})`;
			if (!site.owner) {
				problems.push(`${where}: no "// model-request: <owner> — <why>" declaration`);
				continue;
			}
			if (!OWNERS.has(site.owner)) {
				problems.push(`${where}: unknown owner "${site.owner}"`);
				continue;
			}
			if (!site.reason) problems.push(`${where}: the declaration gives no reason`);
			const network = site.constructor.id.startsWith("global:");
			// A model API (a listed primitive, the judge chain, the Hindsight client) is always a model request.
			const modelApi =
				/^(pkg:|hindsight:)/.test(site.constructor.id) ||
				site.constructor.id.startsWith("fn:coding-agent/src/judgment/");
			if (site.owner === "none" && modelApi) {
				problems.push(`${where}: "none" is for network sites that are not model requests; this is a model API`);
			}
			if (site.file.pkg.transport && network && site.owner !== "transport" && site.owner !== "none") {
				problems.push(`${where}: a transport package's network site is "transport <primitive>" or "none"`);
			}
			if (site.owner === "transport") {
				const listed = site.file.pkg.transport
					? Object.keys(TRANSPORT_PRIMITIVES[site.file.pkg.name] ?? {})
					: [
							...Object.values(TRANSPORT_PRIMITIVES).flatMap(Object.keys),
							...Object.values(SOURCE_PRIMITIVES).flatMap(Object.keys),
							HINDSIGHT.className,
						];
				const unlisted = (site.names ?? []).filter(name => !listed.includes(name));
				if ((site.names ?? []).length === 0 || unlisted.length > 0) {
					problems.push(
						`${where}: "transport" must name the listed primitive(s) it implements, got ${JSON.stringify(site.names)}`,
					);
				}
			}
			if (site.owner === "caller") {
				for (const raw of site.names ?? []) {
					const { name, param } = splitCaller(raw);
					const target = callerTarget(site, name);
					if (!target) {
						problems.push(`${where}: "caller ${name}" neither encloses the site nor stores it`);
						continue;
					}
					const constructor = byId.get(target.id);
					if (param !== undefined && !(target.node && explicitPath(target.node, param))) {
						problems.push(`${where}: "caller ${raw}": ${name} has no parameter "${param.split(".")[0]}"`);
					} else if (!target.stored && constructor?.signal.kind === "unknown") {
						problems.push(
							`${where}: "caller ${name}": the signal does not come from ${name}'s parameters; name the one it does, as "caller ${name}(<parameter>.signal)"`,
						);
					}
				}
			}
			if (site.use === "unresolved") continue;
			const needsSignal = site.owner === "session" || site.owner === "turn" || site.owner === "caller";
			if (!needsSignal) continue;
			const needed = pathsFor(site.constructor, site);
			if (needed === "exempt") continue;
			if (needed === "none") {
				problems.push(`${where}: takes no cancellation, so it cannot be "${site.owner}"-owned`);
				continue;
			}
			if (needed === "unknown") continue;
			const calls = requestCalls(site);
			if (site.use === "value" && calls === undefined) {
				const store = storedIn(site.node, site.ancestors)?.name;
				// Declared as `caller <store>`: the uses of the store are the sites.
				if (site.owner === "caller" && store && (site.names ?? []).some(raw => splitCaller(raw).name === store))
					continue;
				const outer = site.ancestors.at(-1);
				const handed = /^(Call|OptionalCall|New)Expression$/.test(outer?.type ?? "") && outer?.callee !== site.node;
				if (!handed && optionsOfCheckedCall(site, siteNodes)) continue;
				if (!handed) {
					problems.push(`${where}: stored where the walk cannot follow; declare "caller <store>"`);
				} else if (!siteNodes.has(outer as Node)) {
					// Handed on to a call the walk does not check: that call must carry a signal.
					const carries = children(outer, "arguments").some(arg => {
						const result = supply({ node: arg, prop: "signal" }, site.ancestors);
						return "sources" in result && unwrap(arg)?.type === "ObjectExpression";
					});
					if (!carries) problems.push(`${where}: handed to a call that passes no signal`);
				}
				continue;
			}
			if (site.use === "value" && calls?.length === 0 && site.owner !== "caller") {
				problems.push(`${where}: stored, then never called where the walk can see; name the store in "caller"`);
			}
			for (const call of calls ?? []) {
				for (const path of needed) {
					const supplied = supplyAt(call, path);
					if ("missing" in supplied) {
						const at = path.prop ? `argument ${path.arg + 1}'s \`${path.prop}\`` : `argument ${path.arg + 1}`;
						const line = call.node.loc?.start.line;
						problems.push(
							`${where}: a ${site.owner}-owned request${line === site.line ? "" : ` (called at line ${line})`} passes no cancellation at ${at}: ${supplied.missing}`,
						);
					}
				}
			}
		}

		// A declaration no site uses is stale: the request it described moved or went away.
		const used = new Set([...sites.values()].map(site => `${site.file.key}:${site.declarationStart}`));
		for (const file of files.values()) {
			if (!file.text.includes("model-request:")) continue;
			for (const comment of file.comments) {
				if (DECLARATION.test(comment.value) && !used.has(`${file.key}:${comment.start}`)) {
					problems.push(`${file.key}:${comment.loc.start.line}: declaration matches no creation site`);
				}
			}
		}

		const inventory = [...sites.values()];
		const byOwner = new Map<string, number>();
		for (const site of inventory) byOwner.set(site.owner ?? "?", (byOwner.get(site.owner ?? "?") ?? 0) + 1);
		console.log(
			`${inventory.length} model-request sites in ${packages.size} packages: ${[...byOwner].map(([owner, count]) => `${owner} ${count}`).join(", ")}`,
		);
		if (problems.length > 0) {
			const listing = inventory
				.map(s => `${s.owner ?? "?"}\t${s.file.key}:${s.line}\t${s.use} ${s.constructor.name}`)
				.sort()
				.join("\n");
			console.log(`Model request sites:\n${listing}`);
		}
		expect(problems).toEqual([]);
		// The walk found the primitives; an empty inventory would pass vacuously.
		expect(inventory.length).toBeGreaterThan(100);
		// Parsing every source file of every walked package takes seconds.
	}, 300_000);
});
