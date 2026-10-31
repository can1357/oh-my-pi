/**
 * Every place that can create a model request says who owns it.
 *
 * The walk covers the coding agent and every workspace package it depends on: every source file in
 * them except tests, dependencies and build output, so scripts, benchmarks and examples count too.
 * A request is created through:
 *
 * - a network global (`fetch`, `WebSocket`, `EventSource`), anywhere in those packages, also as
 *   `globalThis["fetch"]`, `globalThis["fet" + "ch"]`, `Reflect.get(globalThis, …)` or destructured
 *   from the global object;
 * - a connection of a Node network module (`node:https` `request`/`get`, `http2.connect`,
 *   `net`/`tls` `connect`/`createConnection`) or `Bun.connect`, anywhere in those packages;
 * - a worker thread (`new Worker`, also from `node:worker_threads`): it has globals of its own, so
 *   the request hold of `@oh-my-pi/pi-ai` does not reach what it sends;
 * - a call of pi-ai's `gatedFetch` (the fetch a transport sends through, which refuses a held send
 *   until the response settles), anywhere in those packages; its result is checked like a `fetch`
 *   value;
 * - code generated at run time (`eval`, `new Function`, `fn.constructor(…)`), whose requests the
 *   walk cannot see;
 * - the request API of the transport packages, `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-agent-core`
 *   ({@link TRANSPORT_PRIMITIVES}), plus every provider entry point a transport package exports
 *   (`stream<Provider>`), found rather than listed. Inside a transport package's `src/` only its
 *   network sites are checked: each names the primitive it implements;
 * - the request APIs defined in walked packages ({@link SOURCE_PRIMITIVES}), and every method of the
 *   Hindsight client, also as `client["method"]`;
 * - any function, class or member a `caller` declaration names (below), transitively.
 *
 * The walk parses every source file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`,
 * `.es6`, `.es`), resolves each name through the module graph (named, aliased, namespace and dynamic
 * imports, named and star re-exports through barrels, in any quote style), sees through type
 * assertions and parentheses, and finds every use: a call, a construction, or the thing handed on as
 * a value. A use it cannot resolve (a computed member of a request module's namespace or of a
 * Hindsight client, an unbound dynamic import of one, a dynamic import whose specifier is computed,
 * a global read under a key it cannot resolve, a relative import of a file it does not parse that
 * is not data) is a site too, so it needs a declaration of its own. Each site must sit under a
 * declaration:
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
 * `undefined` on any path the walk can see. The value is traced through local variables,
 * destructuring, spreads (a later spread that sets the property wins), conditionals (every branch
 * must carry one), fallbacks and parameters. Options built by a helper call are accepted only when
 * the helper's arguments visibly carry the signal, so a cancellation deleted behind a helper fails.
 * An `Agent` or a judge object is exempt: its owner aborts it, or each judgment takes its own signal.
 *
 * What the walk cannot prove: that the signal passed is the right one (a fresh, unrelated
 * controller passes), or what code reached through a computed key at run time does. The semantic
 * disposal tests cover the first for each family; the second is inventoried as unresolved.
 * `model-request-ownership-selftest.test.ts` runs this walk over a fixture tree, once per form it
 * must reject.
 *
 * To add a request that outlives disposal, write `// model-request: outlives-disposal — <why>` above
 * the line that creates it. A site with no declaration fails here, with its location.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";

/** The `packages/` directory the current run walks; set by {@link checkModelRequestOwnership}. */
let PACKAGES_DIR = "";
const ROOT_PACKAGE = "@oh-my-pi/pi-coding-agent";
/** Every source file in a package; {@link isProductFile} drops tests, dependencies and build output. */
const SOURCE_GLOB_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "es6", "es"] as const;
const SOURCE_GLOB = `**/*.{${SOURCE_GLOB_EXTENSIONS.join(",")}}`;
const SOURCE_EXTENSION = new RegExp(`^\\.(${SOURCE_GLOB_EXTENSIONS.join("|")})$`);
/** Files Bun loads as data rather than code: importing one runs nothing. */
const DATA_FILE = /\.(json|jsonc|json5|toml|ya?ml|txt|md|html?|css|svg|png|jpe?g|gif|webp|ico|wasm|node|wav|mp3)$/i;

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

/**
 * Network globals: every use is a request. A `Worker` is a thread with globals of its own, which
 * the request hold does not reach; `eval` and `Function` run code the walk cannot see. A socket or
 * worker takes no signal; generated code has no signal position at all.
 */
const NETWORK_GLOBALS: Readonly<Record<string, SignalSpec>> = {
	fetch: opt(1),
	WebSocket: NONE,
	EventSource: NONE,
	Worker: NONE,
	eval: { kind: "unknown" },
	Function: { kind: "unknown" },
};
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
/**
 * pi-ai's gated fetch: `gatedFetch(fetchImpl)` returns the fetch a transport sends through, so each
 * call of it is a network site like a `fetch` value, its result's calls checked for a signal.
 */
const GATE = { pkg: "@oh-my-pi/pi-ai", file: "ai/src/request-hold.ts", name: "gatedFetch" };

/**
 * Members of `Bun` known to open no outbound connection. `Bun.connect` and `Bun.fetch` are sites like
 * their Node and global kin; any other member (`Bun.SQL`, `Bun.redis`, `Bun.s3`, a member added
 * later) is a site to declare, so the list fails closed. Child processes (`spawn`, `$`) are not
 * counted, like `node:child_process`: the request hold does not reach them, which the pull request
 * declares. `serve` and `listen` accept inbound connections only.
 */
const BUN_SAFE_MEMBERS: ReadonlySet<string> = new Set([
	"file",
	"env",
	"write",
	"hash",
	"sleep",
	"sleepSync",
	"nanoseconds",
	"stringWidth",
	"spawn",
	"spawnSync",
	"$",
	"deepEquals",
	"Glob",
	"SHA1",
	"SHA256",
	"sha",
	"CryptoHasher",
	"Image",
	"randomUUIDv7",
	"stripANSI",
	"wrapAnsi",
	"serve",
	"listen",
	"resolveSync",
	"gc",
	"argv",
	"main",
	"color",
	"JSONL",
	"JSON5",
	"TOML",
	"YAML",
	"semver",
	"which",
	"build",
	"isMainThread",
	"version",
	"revision",
	"stdin",
	"stdout",
	"stderr",
	"plugin",
	"inspect",
	"gzipSync",
	"gunzipSync",
	"zstdCompress",
	"zstdCompressSync",
	"zstdDecompress",
	"zstdDecompressSync",
	"Archive",
	"Transpiler",
	"fileURLToPath",
	"pathToFileURL",
	"escapeHTML",
	"peek",
	"password",
	"enableANSIColors",
	"embeddedFiles",
]);

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
			if (!isProductFile(rel)) continue;
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

/**
 * Directories that hold no shipped or runnable package code of their own: dependencies, tests,
 * build output, and `export-assets` (the HTML export viewer bundled from `src/export/html`).
 */
const NON_PRODUCT_DIRS = new Set([
	"node_modules",
	"test",
	"tests",
	"__tests__",
	"dist",
	"build",
	"coverage",
	"target",
	"export-assets",
]);

/**
 * Whether a package file is code the package runs: everything except dependencies, tests, build
 * output and type declarations. Scripts, bins and generated loaders are included.
 */
function isProductFile(rel: string): boolean {
	const parts = rel.replaceAll("\\", "/").split("/");
	if (parts.some(part => NON_PRODUCT_DIRS.has(part))) return false;
	const name = parts.at(-1) ?? "";
	return !/\.d\.[cm]?ts$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
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
type Binding =
	| { kind: "constructor"; id: string }
	| { kind: "namespace"; module: ModuleRef }
	/** A Node network module (`node:http2`, `https`, …): its `request`/`connect`/… are network sites. */
	| { kind: "builtin"; module: string };

/**
 * Node modules that open network connections or threads. Every member of one is a site unless it is
 * listed in {@link NODE_SAFE_MEMBERS} as opening nothing (a constant, a type check, an inbound server,
 * a helper), so a member the list does not know (`new net.Socket()`, `dgram.createSocket`) fails closed.
 * A `worker_threads` `Worker` has globals of its own, which the request hold does not reach.
 */
const NODE_NETWORK_MODULE = /^(?:node:)?(http|https|http2|net|tls|dgram|worker_threads)$/;
const NODE_SAFE_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
	http: new Set([
		"STATUS_CODES",
		"METHODS",
		"Agent",
		"globalAgent",
		"createServer",
		"Server",
		"maxHeaderSize",
		"validateHeaderName",
		"validateHeaderValue",
		"IncomingMessage",
		"ServerResponse",
		"OutgoingMessage",
	]),
	https: new Set(["Agent", "globalAgent", "createServer", "Server"]),
	http2: new Set([
		"constants",
		"createServer",
		"createSecureServer",
		"getDefaultSettings",
		"getPackedSettings",
		"getUnpackedSettings",
		"sensitiveHeaders",
		"Http2ServerRequest",
		"Http2ServerResponse",
	]),
	net: new Set([
		"isIP",
		"isIPv4",
		"isIPv6",
		"createServer",
		"Server",
		"BlockList",
		"SocketAddress",
		"getDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamily",
	]),
	tls: new Set([
		"createServer",
		"Server",
		"createSecureContext",
		"SecureContext",
		"checkServerIdentity",
		"getCiphers",
		"rootCertificates",
		"getCACertificates",
		"setDefaultCACertificates",
		"DEFAULT_CIPHERS",
		"DEFAULT_ECDH_CURVE",
		"DEFAULT_MIN_VERSION",
		"DEFAULT_MAX_VERSION",
		"CLIENT_RENEG_LIMIT",
		"CLIENT_RENEG_WINDOW",
	]),
	dgram: new Set([]),
	worker_threads: new Set([
		"parentPort",
		"isMainThread",
		"workerData",
		"threadId",
		"MessageChannel",
		"MessagePort",
		"BroadcastChannel",
		"receiveMessageOnPort",
		"markAsUntransferable",
		"isMarkedAsUntransferable",
		"moveMessagePortToContext",
		"resourceLimits",
		"SHARE_ENV",
		"setEnvironmentData",
		"getEnvironmentData",
		"postMessageToThread",
	]),
};

/** Whether `member` of network module `module` can open something: anything not known to open nothing. */
function isNetworkMember(module: string, member: string): boolean {
	return member !== "default" && !NODE_SAFE_MEMBERS[module]?.has(member);
}

/** The constructor of network module member `module.member`, registered on first use; a socket takes no signal. */
function networkConstructor(module: string, member: string): string {
	const id = `net:${module}.${member}`;
	addConstructor(id, `${module}.${member}`, NONE);
	return id;
}

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

	/** Local names in `file` for pi-ai's {@link GATE}: imported from it or from the package, or its own declaration. */
	gateLocals(file: SourceFile): Set<string> {
		const locals = new Set<string>();
		if (file.key === GATE.file) locals.add(GATE.name);
		for (const statement of children(child(file.ast, "program"), "body")) {
			if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
			const source = child(statement, "source")?.value;
			if (typeof source !== "string") continue;
			const module = this.module(file, source);
			const fromGate =
				(module?.kind === "transport" && module.pkg === GATE.pkg) ||
				(module?.kind === "file" && module.key === GATE.file);
			if (!fromGate) continue;
			for (const specifier of children(statement, "specifiers")) {
				if (specifier.type === "ImportSpecifier" && nameOf(child(specifier, "imported")) === GATE.name) {
					const local = nameOf(child(specifier, "local"));
					if (local) locals.add(local);
				}
			}
		}
		return locals;
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
			const specifierText = child(statement, "source")?.value as string;
			const builtin = NODE_NETWORK_MODULE.exec(specifierText)?.[1];
			if (builtin) {
				for (const specifier of children(statement, "specifiers")) {
					const local = nameOf(child(specifier, "local"));
					if (!local || specifier.importKind === "type") continue;
					if (specifier.type !== "ImportSpecifier") {
						map.set(local, { kind: "builtin", module: builtin });
						continue;
					}
					const imported = nameOf(child(specifier, "imported")) ?? local;
					if (isNetworkMember(builtin, imported)) {
						map.set(local, { kind: "constructor", id: networkConstructor(builtin, imported) });
					}
				}
				continue;
			}
			const module = this.module(file, specifierText);
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
			const id = child(node, "id");
			const builtin = NODE_NETWORK_MODULE.exec(required)?.[1];
			if (builtin) {
				if (id?.type === "Identifier") map.set(id.name as string, { kind: "builtin", module: builtin });
				for (const property of id?.type === "ObjectPattern" ? children(id, "properties") : []) {
					const key = nameOf(child(property, "key"));
					const local = nameOf(child(property, "value"));
					if (key && local && isNetworkMember(builtin, key)) {
						map.set(local, { kind: "constructor", id: networkConstructor(builtin, key) });
					}
				}
				return;
			}
			const module = this.module(file, required);
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

/** Whether `node` is the operand of `typeof` (a presence check, which reaches nothing). */
function isTypeofOperand(node: Node, ancestors: readonly Node[]): boolean {
	const { parent } = outerUse(node, ancestors);
	return parent?.type === "UnaryExpression" && parent.operator === "typeof";
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
	// `const { fetch: send } = globalThis` (or of an alias of it): the local name stands for the global.
	const globalAliases = globalAliasesIn(file, sites);
	const gates = graph.gateLocals(file);
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
				return;
			}
		}
		if (node.type === "Identifier" && globalAliases.has(node.name as string) && isValueUse(node, ancestors)) {
			sites.push(makeSite(file, byId.get(`global:${globalAliases.get(node.name as string)}`)!, node, ancestors));
			return;
		}
		if (node.type === "Identifier" && Object.hasOwn(NETWORK_GLOBALS, node.name as string)) return;
		// A member of the global object (or a local alias of it): `globalThis.fetch`, `g["fetch"]`, `g[key]`.
		if (
			/MemberExpression$/.test(node.type) &&
			!ancestors.some(ancestor => TYPE_LEVEL.test(ancestor.type)) &&
			// `globalThis.fetch = wrapped`, `delete globalThis[key]`: replacing or removing the global sends nothing.
			!(parent?.type === "AssignmentExpression" && parent.left === node) &&
			!(parent?.type === "UnaryExpression" && parent.operator === "delete") &&
			isGlobalObject(child(node, "object"), ancestors, file)
		) {
			const key = node.computed
				? resolveString(child(node, "property"), ancestors)
				: nameOf(child(node, "property"));
			if (typeof key === "string" && Object.hasOwn(NETWORK_GLOBALS, key)) {
				sites.push(makeSite(file, byId.get(`global:${key}`)!, node, ancestors));
				return;
			}
			if (key === undefined) {
				const unresolved = addConstructor(`global:${file.key}:[…]`, "globalThis[…]", { kind: "unknown" });
				sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
				return;
			}
		}
		// The global object handed to a call: `Reflect.get(globalThis, "fetch")`,
		// `Object.getOwnPropertyDescriptor(globalThis, "fetch").value`, `Object.values(globalThis)`. The call
		// can read any member, so it is a site unless the key after the object names something other than a
		// network global: `Reflect.get(globalThis, "Bun")` reads no network global.
		if (node.type === "CallExpression" || node.type === "NewExpression") {
			const args = children(node, "arguments");
			const at = args.findIndex(argument => isGlobalObject(argument, ancestors, file));
			if (at !== -1) {
				const key = resolveString(args[at + 1], ancestors);
				if (typeof key === "string" && Object.hasOwn(NETWORK_GLOBALS, key)) {
					sites.push(makeSite(file, byId.get(`global:${key}`)!, node, ancestors));
					return;
				}
				if (typeof key !== "string") {
					const unresolved = addConstructor(`global:${file.key}:[…]`, "globalThis[…]", { kind: "unknown" });
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
					return;
				}
			}
		}
		// Node network modules (every member not known to open nothing: `https.request`, `http2.connect`,
		// `new net.Socket()`, …), `process.getBuiltinModule` of one, and Bun's members other than those
		// known to open nothing: network sites in every package, like the globals.
		if (node.type === "Identifier" && isValueUse(node, ancestors)) {
			const binding = bindings.get(node.name as string);
			if (binding?.kind === "constructor" && binding.id.startsWith("net:")) {
				sites.push(makeSite(file, byId.get(binding.id)!, node, ancestors));
				return;
			}
			// `Bun` handed on whole (`const b = Bun`, `const { fetch } = Bun`, `f(Bun)`): any member can be reached.
			if (node.name === "Bun" && !locallyBound("Bun", ancestors, file) && !isTypeofOperand(node, ancestors)) {
				const { expr, parent: outer } = outerUse(node, ancestors);
				const memberObject = /MemberExpression$/.test(outer?.type ?? "") && outer?.object === expr;
				// `"sleepSync" in Bun` tests for a member; it reaches nothing.
				const presence = outer?.type === "BinaryExpression" && outer.operator === "in" && outer.right === expr;
				if (!memberObject && !presence) {
					const unresolved = addConstructor(`net:bun:${file.key}:value`, "Bun", { kind: "unknown" });
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
					return;
				}
			}
		}
		if (/MemberExpression$/.test(node.type) && !ancestors.some(ancestor => TYPE_LEVEL.test(ancestor.type))) {
			const object = unwrap(child(node, "object"));
			const property = memberName(node);
			const binding = object?.type === "Identifier" ? bindings.get(object.name as string) : undefined;
			if (binding?.kind === "builtin") {
				if (property && isNetworkMember(binding.module, property)) {
					sites.push(makeSite(file, byId.get(networkConstructor(binding.module, property))!, node, ancestors));
					return;
				}
				if (property === undefined) {
					const unresolved = addConstructor(`net:${file.key}:[…]`, `${binding.module}[…]`, { kind: "unknown" });
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
					return;
				}
			}
			// `requestHold.gatedFetch(…)` through a namespace import of pi-ai or of its request-hold module.
			if (
				binding?.kind === "namespace" &&
				property === GATE.name &&
				((binding.module?.kind === "transport" && binding.module.pkg === GATE.pkg) ||
					(binding.module?.kind === "file" && binding.module.key === GATE.file))
			) {
				sites.push(makeSite(file, byId.get(`net:${GATE.name}`)!, node, ancestors));
				return;
			}
			if (nameOf(object) === "Bun" && !locallyBound("Bun", ancestors, file)) {
				if (property === "connect" || property === "fetch") {
					sites.push(makeSite(file, byId.get(`net:bun.${property}`)!, node, ancestors));
					return;
				}
				if (property === undefined || !BUN_SAFE_MEMBERS.has(property)) {
					const id = `net:bun.${property ?? `${file.key}:[…]`}`;
					const unresolved = addConstructor(id, `Bun.${property ?? "[…]"}`, { kind: "unknown" });
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
					return;
				}
			}
		}
		// `process.getBuiltinModule("node:https")`: a network module reached without an import.
		if (node.type === "CallExpression") {
			const callee = unwrap(child(node, "callee"));
			if (
				callee?.type === "MemberExpression" &&
				nameOf(child(callee, "object")) === "process" &&
				memberName(callee) === "getBuiltinModule"
			) {
				const spec = resolveString(children(node, "arguments")[0], ancestors);
				const module = typeof spec === "string" ? NODE_NETWORK_MODULE.exec(spec)?.[1] : undefined;
				if (spec === undefined || module) {
					const id = `net:${file.key}:getBuiltinModule(${typeof spec === "string" ? spec : "…"})`;
					const unresolved = addConstructor(
						id,
						`process.getBuiltinModule(${typeof spec === "string" ? spec : "…"})`,
						{
							kind: "unknown",
						},
					);
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
					return;
				}
			}
		}
		// `gatedFetch(options.fetch)`: the transport's send, a network site in every package.
		if (node.type === "CallExpression") {
			const callee = unwrap(child(node, "callee"));
			if (callee?.type === "Identifier" && gates.has(callee.name as string)) {
				sites.push(makeSite(file, byId.get(`net:${GATE.name}`)!, node, ancestors));
				return;
			}
		}
		// `fn.constructor(…)`: the constructor of a function is `Function`, which runs code it is given.
		if (
			/MemberExpression$/.test(node.type) &&
			!node.computed &&
			nameOf(child(node, "property")) === "constructor" &&
			/^(Call|OptionalCall|New)Expression$/.test(parent?.type ?? "") &&
			parent?.callee === node
		) {
			sites.push(makeSite(file, byId.get("global:Function")!, node, ancestors));
			return;
		}
		// A relative import of a file the walk does not parse (`./x.coffee`): code it cannot see.
		const unparsed = unparsedImport(node, file, graph);
		if (unparsed) {
			const unresolved = addConstructor(`import:${file.key}:${unparsed}`, `import(${unparsed})`, {
				kind: "unknown",
			});
			sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
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
		if (/MemberExpression$/.test(node.type)) {
			const object = unwrap(child(node, "object"));
			const property = memberName(node);
			if (!property) {
				// `client[name](…)`: a Hindsight method chosen at run time.
				const receiver = object?.type === "MemberExpression" ? memberName(object) : nameOf(object);
				if (node.computed && receiver === "client" && file.key !== HINDSIGHT.file) {
					const unresolved = addConstructor(`computed:${file.key}:client`, "client[…]", { kind: "unknown" });
					sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
				}
				return;
			}
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
			const receiver = object?.type === "MemberExpression" ? memberName(object) : nameOf(object);
			if (receiver === "client" && hindsightMethods.has(property) && file.key !== HINDSIGHT.file) {
				const id = `hindsight:${property}`;
				const constructor =
					byId.get(id) ?? addConstructor(id, `${HINDSIGHT.className}.${property}`, { kind: "last-options" });
				sites.push(makeSite(file, constructor, node, ancestors));
			}
			return;
		}
		// A dynamic import or require of a request module that is not bound to a name, or of a module
		// named at run time, which the walk cannot resolve at all.
		if (node.type === "AwaitExpression") return;
		const computed = computedImport(node);
		if (computed) {
			const unresolved = addConstructor(`import:${file.key}:*`, "import(<computed>)", { kind: "unknown" });
			sites.push({ ...makeSite(file, unresolved, node, ancestors), use: "unresolved" });
			return;
		}
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

/**
 * The specifier of a relative import, export-from, `import()` or `require()` of a file the walk
 * cannot parse: one whose extension is neither a source extension it parses nor data (`./x.coffee`;
 * `require` runs an unknown extension as JavaScript), or a bare file with no extension (`./payload`)
 * that no source file shadows. Type-only imports and imports with a `type` attribute load nothing
 * that runs. A source file outside the walk (a test helper a script imports) is excluded by the same
 * rule that excludes tests, not reported here.
 */
function unparsedImport(node: Node, file: SourceFile, graph: Graph): string | undefined {
	let specifier: string | undefined;
	if (/^(ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration)$/.test(node.type)) {
		if (node.importKind === "type" || node.exportKind === "type") return undefined;
		const attributes = [...children(node, "attributes"), ...children(node, "assertions")];
		if (attributes.some(attribute => nameOf(child(attribute, "key")) === "type")) return undefined;
		const source = child(node, "source");
		specifier = source?.type === "StringLiteral" ? (source.value as string) : undefined;
	} else if (node.type === "CallExpression" || node.type === "ImportExpression") {
		const options = unwrap(
			node.type === "ImportExpression" ? child(node, "options") : children(node, "arguments")[1],
		);
		const attributes = children(options, "properties").find(property =>
			/^(with|assert)$/.test(nameOf(child(property, "key")) ?? ""),
		);
		const typed = children(unwrap(child(attributes, "value")), "properties").some(
			property => nameOf(child(property, "key")) === "type",
		);
		if (typed) return undefined;
		specifier = requiredModule(node);
	}
	if (!specifier?.startsWith(".") || DATA_FILE.test(specifier)) return undefined;
	if (graph.module(file, specifier) !== undefined) return undefined;
	const extension = path.posix.extname(specifier);
	if (SOURCE_EXTENSION.test(extension)) return undefined;
	if (extension === "") {
		// `./x` resolves to `./x.ts`, `./x/index.ts`, … before a bare `./x`: only a bare file nothing shadows runs.
		const target = path.join(PACKAGES_DIR, path.posix.dirname(file.key), specifier);
		if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return undefined;
		if (SOURCE_GLOB_EXTENSIONS.some(ext => fs.existsSync(`${target}.${ext}`))) return undefined;
	}
	return specifier;
}

/** A member's name: `x.name`, `x.#name` or `x["name"]`; undefined for a key computed at run time. */
function memberName(node: Node): string | undefined {
	const property = child(node, "property");
	if (!node.computed) return nameOf(property);
	if (property?.type === "StringLiteral") return property.value as string;
	if (property?.type === "TemplateLiteral" && children(property, "expressions").length === 0) {
		return (children(property, "quasis")[0]?.value as { cooked?: string } | undefined)?.cooked;
	}
	return undefined;
}

/**
 * Whether `node` is the global object: `globalThis` (or `window`, `self`, `global`) not shadowed by a
 * local, or a local that holds it, resolved by scope (`const g = globalThis`, transitively, or a
 * later `g = globalThis`). A local of the same name elsewhere in the file (a page function's `const
 * page = window`) is another variable.
 */
function isGlobalObject(node: Node | undefined, ancestors: readonly Node[], file: SourceFile, depth = 0): boolean {
	const value = unwrap(node);
	if (value?.type !== "Identifier") return false;
	const name = value.name as string;
	if (GLOBAL_OBJECTS.has(name) && !locallyBound(name, ancestors, file)) return true;
	if (depth > 4 || !mayAliasGlobalObject(file)) return false;
	const declared = localDeclaration(name, ancestors);
	if (!declared || declared.param || declared.initProp) return false;
	const values = [declared.init, ...assignmentsTo(name, declared.scope)];
	return values.some(held => held !== undefined && isGlobalObject(held, ancestors, file, depth + 1));
}

/** Per file, whether any local may hold the global object at all (a cheap text test before resolving by scope). */
const aliasesGlobalObject = new WeakMap<SourceFile, boolean>();

function mayAliasGlobalObject(file: SourceFile): boolean {
	let aliases = aliasesGlobalObject.get(file);
	if (aliases === undefined) {
		aliases = /=\s*\(?\s*(globalThis|window|self|global)\b/.test(file.text);
		aliasesGlobalObject.set(file, aliases);
	}
	return aliases;
}

/**
 * Local names a file destructures from the global object for a network global: `const { fetch: send }
 * = globalThis`, `const { ["fetch"]: send } = g`. A destructured key the walk cannot resolve is an
 * unresolved site, pushed onto `sites`.
 */
function globalAliasesIn(file: SourceFile, sites: Site[]): Map<string, string> {
	const aliases = new Map<string, string>();
	walk(file.ast, (node, ancestors) => {
		if (node.type !== "VariableDeclarator" || child(node, "id")?.type !== "ObjectPattern") return;
		if (!isGlobalObject(child(node, "init"), ancestors, file)) return;
		for (const property of children(child(node, "id"), "properties")) {
			if (property.type === "RestElement") continue;
			const key = property.computed
				? resolveString(child(property, "key"), ancestors)
				: nameOf(child(property, "key"));
			const value = child(property, "value");
			const local = nameOf(value?.type === "AssignmentPattern" ? child(value, "left") : value);
			if (key === undefined) {
				const unresolved = addConstructor(`global:${file.key}:[…]`, "globalThis[…]", { kind: "unknown" });
				sites.push({
					...makeSite(file, unresolved, property, [...ancestors, node, child(node, "id")!]),
					use: "unresolved",
				});
				continue;
			}
			if (typeof key === "string" && local && Object.hasOwn(NETWORK_GLOBALS, key)) aliases.set(local, key);
		}
	});
	return aliases;
}

/** Whether `node` is `import(x)` or `require(x)` whose specifier is not a plain string. */
function computedImport(node: Node): boolean {
	if (node.type !== "CallExpression" && node.type !== "ImportExpression") return false;
	const callee = child(node, "callee");
	const isImport = node.type === "ImportExpression" || callee?.type === "Import";
	const isRequire = callee?.type === "Identifier" && callee.name === "require";
	if (!isImport && !isRequire) return false;
	const source = node.type === "ImportExpression" ? child(node, "source") : children(node, "arguments")[0];
	if (!source || source.type === "StringLiteral") return false;
	return !(source.type === "TemplateLiteral" && children(source, "expressions").length === 0);
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

/** A local binding found above a node: where it is declared, and what initially gives it a value. */
interface LocalBinding {
	/** The function or program whose body (or parameter list) declares it. */
	scope: Node;
	/** A variable's initializer, if it has one. */
	init?: Node;
	/** The property of `init` it was destructured from: `const { signal } = options`. */
	initProp?: string;
	/** A parameter: the function, its index, and the property destructured from it. */
	param?: { fn: Node; index: number; prop?: string };
}

/**
 * The innermost declaration of local `name` above `ancestors`: a variable (with its initializer and
 * the property it was destructured from, if any) or a parameter.
 */
function localDeclaration(name: string, ancestors: readonly Node[]): LocalBinding | undefined {
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const scope = ancestors[index];
		if (isFunctionLike(scope)) {
			const params = children(scope, "params");
			for (let i = 0; i < params.length; i++) {
				const param = params[i].type === "AssignmentPattern" ? child(params[i], "left") : params[i];
				if (param?.type === "Identifier" && param.name === name) return { scope, param: { fn: scope, index: i } };
				const pattern = param?.type === "TSParameterProperty" ? child(param, "parameter") : param;
				if (pattern?.type === "ObjectPattern") {
					for (const property of children(pattern, "properties")) {
						if (property.type === "RestElement" && nameOf(child(property, "argument")) === name) {
							return { scope, param: { fn: scope, index: i } };
						}
						const value = child(property, "value");
						const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
						if (nameOf(local) === name) {
							return { scope, param: { fn: scope, index: i, prop: propertyKey(property, ancestors) } };
						}
					}
				}
			}
		}
		const body = isFunctionLike(scope) ? child(scope, "body") : scope.type === "Program" ? scope : undefined;
		if (!body) continue;
		let found: LocalBinding | undefined;
		walk(body, (node, nodeAncestors) => {
			if (found || node.type !== "VariableDeclarator") return;
			if (nodeAncestors.slice(1).some(isFunctionLike)) return;
			const id = child(node, "id");
			if (nameOf(id) === name) {
				found = { scope, init: child(node, "init") };
				return;
			}
			if (id?.type !== "ObjectPattern") return;
			for (const property of children(id, "properties")) {
				if (property.type === "RestElement" && nameOf(child(property, "argument")) === name) {
					found = { scope, init: child(node, "init") };
					return;
				}
				const value = child(property, "value");
				const local = value?.type === "AssignmentPattern" ? child(value, "left") : value;
				if (nameOf(local) === name) {
					found = { scope, init: child(node, "init"), initProp: propertyKey(property, ancestors) };
					return;
				}
			}
		});
		if (found) return found;
	}
	return undefined;
}

/** A property's key: `name`, `"name"`, or a computed key the walk can resolve to a string. */
function propertyKey(property: Node, ancestors: readonly Node[]): string | undefined {
	const key = child(property, "key");
	if (!property.computed) return nameOf(key);
	const resolved = resolveString(key, ancestors);
	return typeof resolved === "string" ? resolved : undefined;
}

/** A value known not to be a string (a symbol), as opposed to one the walk cannot resolve. */
const NOT_A_STRING = Symbol("not a string");

/**
 * The string `node` evaluates to: a literal, a template or `+` concatenation of resolvable parts, or
 * a local constant holding one. {@link NOT_A_STRING} for a symbol or number; undefined when the walk
 * cannot tell.
 */
function resolveString(
	node: Node | undefined,
	ancestors: readonly Node[],
	depth = 0,
): string | typeof NOT_A_STRING | undefined {
	const value = unwrap(node);
	if (!value || depth > 8) return undefined;
	if (value.type === "StringLiteral") return value.value as string;
	if (value.type === "NumericLiteral") return NOT_A_STRING;
	if (value.type === "TemplateLiteral") {
		// `${a}${b}`: every expression must resolve to a string.
		const quasis = children(value, "quasis");
		let text = "";
		for (const [index, quasi] of quasis.entries()) {
			const cooked = (quasi.value as { cooked?: string } | undefined)?.cooked;
			if (cooked === undefined) return undefined;
			text += cooked;
			const expression = children(value, "expressions")[index];
			if (!expression) continue;
			const part = resolveString(expression, ancestors, depth + 1);
			if (typeof part !== "string") return undefined;
			text += part;
		}
		return text;
	}
	if (value.type === "BinaryExpression" && value.operator === "+") {
		const left = resolveString(child(value, "left"), ancestors, depth + 1);
		const right = resolveString(child(value, "right"), ancestors, depth + 1);
		return typeof left === "string" && typeof right === "string" ? left + right : undefined;
	}
	if (value.type === "CallExpression") {
		const callee = unwrap(child(value, "callee"));
		const symbol =
			nameOf(callee) === "Symbol" ||
			(callee?.type === "MemberExpression" && nameOf(child(callee, "object")) === "Symbol");
		return symbol ? NOT_A_STRING : undefined;
	}
	if (value.type === "MemberExpression" && nameOf(child(value, "object")) === "Symbol") return NOT_A_STRING;
	if (value.type === "Identifier") {
		const declared = localDeclaration(value.name as string, ancestors);
		if (!declared?.init || declared.initProp || assignmentsTo(value.name as string, declared.scope).length > 0) {
			return undefined;
		}
		return resolveString(declared.init, ancestors, depth + 1);
	}
	return undefined;
}

/** Every value assigned to local `name` in `scope` after its declaration: `name = v`, `name ??= v`. */
function assignmentsTo(name: string, scope: Node): Node[] {
	const values: Node[] = [];
	walk(scope, node => {
		if (node.type !== "AssignmentExpression") return;
		const left = unwrap(child(node, "left"));
		if (left?.type !== "Identifier" || left.name !== name) return;
		const right = child(node, "right");
		if (right) values.push(right);
	});
	return values;
}

/**
 * What `scope` does to property `prop` of local `name`: each value assigned to it (`name.prop = v`,
 * `name["prop"] = v`), and whether it is deleted or written under a key the walk cannot resolve.
 */
function mutationsOf(name: string, prop: string, scope: Node): { values: Node[]; erased?: string } {
	const values: Node[] = [];
	let erased: string | undefined;
	walk(scope, (node, ancestors) => {
		const target =
			node.type === "AssignmentExpression"
				? unwrap(child(node, "left"))
				: node.type === "UnaryExpression" && node.operator === "delete"
					? unwrap(child(node, "argument"))
					: undefined;
		if (!target || !/MemberExpression$/.test(target.type)) return;
		if (nameOf(unwrap(child(target, "object"))) !== name) return;
		const key = target.computed
			? resolveString(child(target, "property"), ancestors)
			: nameOf(child(target, "property"));
		if (key === NOT_A_STRING || (key !== undefined && key !== prop)) return;
		if (key === undefined) {
			erased ??= `\`${name}\` is written under a key the walk cannot resolve, which may replace its \`${prop}\``;
			return;
		}
		if (node.type === "UnaryExpression") {
			erased ??= `\`${name}.${prop}\` is deleted`;
			return;
		}
		const right = child(node, "right");
		if (right) values.push(right);
	});
	return { values, erased };
}

const LOOP = /^(For|ForIn|ForOf|While|DoWhile)Statement$/;
const PATTERN = /^(ObjectPattern|ArrayPattern|ObjectProperty|AssignmentPattern|RestElement)$/;

/** Whether `expr` (its ancestors `chain`) is written: an assignment, update or deletion target, also inside a pattern. */
function isWriteTarget(expr: Node, chain: readonly Node[]): boolean {
	let current = expr;
	for (let index = chain.length - 1; index >= 0; index--) {
		const holder = chain[index];
		if (holder.type === "AssignmentExpression") return holder.left === current;
		if (holder.type === "UpdateExpression") return true;
		if (holder.type === "UnaryExpression") return holder.operator === "delete";
		if (/^For(In|Of)Statement$/.test(holder.type)) return holder.left === current;
		if (!PATTERN.test(holder.type) || (holder.type === "AssignmentPattern" && holder.left !== current)) return false;
		current = holder;
	}
	return false;
}

/**
 * The first reference to local `name` in `scope`, other than `use`, that may change what it holds or
 * hand it where the walk cannot follow before `use` reads it; undefined when there is none. A
 * container the walk traces a signal through must stay where the walk sees it, so this is a list of
 * what is allowed, and everything else is refused whatever its shape: an alias, an argument to any
 * call it cannot read (`Object.assign`, `Reflect.set`, a method, an import), a method called on it, a
 * write inside its `head` property. Allowed: a read of a property; a write of a property other than
 * `head` (with `head` set), since a write of `head` itself is traced as a value; a copy (`{ ...name }`,
 * `[...name]`); a test of its truthiness or identity; a write of the whole binding (traced as a
 * value); an argument to a local function whose parameter in turn passes this check; a reference on a
 * path that leaves the function before `use` (a block ending in `return` or `throw`); and any
 * reference after `use` that no enclosing loop or hoisted function can run first. `head` undefined:
 * the whole container is what is passed (an argument array), so any write through it is refused.
 */
function escapeOf(
	name: string,
	scope: Node,
	scopeAncestors: readonly Node[],
	use: Node,
	head: string | undefined,
	depth = 0,
): string | undefined {
	let found: string | undefined;
	const useStart = (use.start as number | undefined) ?? 0;
	const useEnd = (use.end as number | undefined) ?? Number.POSITIVE_INFINITY;
	const contains = (holder: Node): boolean => (holder.start as number) <= useStart && useEnd <= (holder.end as number);
	walk(
		scope,
		(node, ancestors) => {
			if (found || node === use || node.type !== "Identifier" || node.name !== name) return;
			if (!isValueUse(node, ancestors)) return;
			// A binding of the same name in a nested scope is another variable.
			if (localDeclaration(name, ancestors)?.scope !== scope) return;
			const below = ancestors.slice(ancestors.indexOf(scope) + 1);
			// A closure created after `use` cannot run before it; a hoisted function declaration, or a loop
			// around both, can.
			const runsFirst =
				below.some(holder => holder.type === "FunctionDeclaration") ||
				below.some(holder => LOOP.test(holder.type) && contains(holder));
			if ((node.start as number) >= useEnd && !runsFirst) return;
			// A path that leaves the function first never reaches `use`: a `return` or `throw` around the
			// reference, or a block that ends in one.
			const exits = below.some((holder, index) => {
				if (contains(holder) || below.slice(0, index).some(isFunctionLike)) return false;
				if (holder.type === "ReturnStatement" || holder.type === "ThrowStatement") return true;
				if (holder.type !== "BlockStatement") return false;
				const last = children(holder, "body").at(-1);
				return last?.type === "ReturnStatement" || last?.type === "ThrowStatement";
			});
			if (exits) return;
			visit(node, ancestors);
		},
		[...scopeAncestors],
	);
	return found;

	function visit(node: Node, ancestors: readonly Node[]): void {
		const line = node.loc?.start.line ?? 0;
		const { expr, parent, chain } = outerUse(node, ancestors);
		// Reads of its truthiness or identity, which reach nothing it holds: `typeof name`, `!name`,
		// `name === x`, `if (name)`, `name ? a : b`, and `name && x` (whose value is `name` only when falsy).
		if (parent?.type === "UnaryExpression" && /^(typeof|!|void)$/.test(parent.operator as string)) return;
		if (parent?.type === "BinaryExpression" && /^(===|!==|==|!=|instanceof|in)$/.test(parent.operator as string))
			return;
		if (/^(If|While|DoWhile)Statement$/.test(parent?.type ?? "") && parent?.test === expr) return;
		if (parent?.type === "ConditionalExpression" && parent.test === expr) return;
		if (parent?.type === "LogicalExpression" && parent.operator === "&&" && parent.left === expr) return;
		// `name = other`: a write of the whole binding, traced as a value (`assignmentsTo`).
		if (isWriteTarget(expr, chain)) return;
		if (parent?.type === "SpreadElement" && /^(Object|Array)Expression$/.test(chain.at(-2)?.type ?? "")) return;
		if (/MemberExpression$/.test(parent?.type ?? "") && parent?.object === expr) {
			const key = parent.computed ? resolveString(child(parent, "property"), ancestors) : memberName(parent);
			const { expr: member, parent: memberParent, chain: memberChain } = outerUse(parent, chain.slice(0, -1));
			if (
				memberParent &&
				/^(Call|OptionalCall|New)Expression$/.test(memberParent.type) &&
				memberParent.callee === member
			) {
				found = `a method is called on \`${name}\` (line ${line}), which may change what it holds`;
				return;
			}
			// Whether the chain from this read on (`name.k`, `name.k.x`, …) ends in a write.
			let top = member;
			let topChain = memberChain;
			let nested = false;
			while (topChain.at(-1) && /MemberExpression$/.test(topChain.at(-1)!.type) && topChain.at(-1)!.object === top) {
				nested = true;
				({ expr: top, chain: topChain } = outerUse(topChain.at(-1)!, topChain.slice(0, -1)));
			}
			if (!isWriteTarget(top, topChain)) return;
			if (head !== undefined && typeof key === "string" && key !== head) return;
			if (head !== undefined && key === head && !nested) return;
			found = `\`${name}\` is written through (line ${line}) before the request`;
			return;
		}
		// An argument to a local function: allowed when its parameter passes this check in turn.
		if (parent && /^(Call|OptionalCall)Expression$/.test(parent.type) && parent.callee !== expr && depth < 4) {
			const callee = unwrap(child(parent, "callee"));
			const fn =
				callee?.type === "Identifier" ? resolveLocalFunction(callee.name as string, chain.slice(0, -1)) : undefined;
			const index = children(parent, "arguments").indexOf(expr);
			const param = fn && index !== -1 ? children(fn, "params")[index] : undefined;
			const paramNode = param?.type === "AssignmentPattern" ? child(param, "left") : param;
			if (
				paramNode?.type === "ObjectPattern" &&
				!children(paramNode, "properties").some(p => p.type === "RestElement")
			)
				return;
			const fnAncestors = fn ? ancestorsOf(fn, chain) : undefined;
			if (fn && fnAncestors && paramNode?.type === "Identifier") {
				const paramName = paramNode.name as string;
				const inner = escapeOf(paramName, fn, fnAncestors, fn, head, depth + 1);
				const written = head !== undefined ? mutationsOf(paramName, head, fn) : { values: [] as Node[] };
				if (!inner && !written.erased && written.values.length === 0) return;
			}
		}
		const what =
			parent && /^(Call|OptionalCall|New)Expression$/.test(parent.type)
				? "handed to a call"
				: parent?.type === "VariableDeclarator" || parent?.type === "AssignmentExpression"
					? "aliased"
					: "handed on";
		found = `\`${name}\` is ${what} (line ${line}) before the request, so the walk cannot tell what it holds; build the options at the call`;
	}
}

/** The ancestors of `scope`, itself one of `ancestors`. */
function scopeAncestors(scope: Node, ancestors: readonly Node[]): readonly Node[] {
	const index = ancestors.indexOf(scope);
	return index === -1 ? [] : ancestors.slice(0, index);
}

/**
 * What a traced value supplies. `sources` names the expressions the signal comes from; `opaque` when
 * the walk could not look inside (a parameter, a property read), which it trusts only where the
 * options are passed directly. `missing` says why there is none: `explicit` for a visible
 * `undefined`, `absent` for an object that simply has no such property (an earlier one may supply it).
 */
type Supply = { sources: Source[]; opaque?: true } | { missing: string; explicit?: true; absent?: true };

/** A helper being traced: its parameters stand for the arguments of the call that reached it. */
interface Substitution {
	fn: Node;
	args: readonly Node[];
	ancestors: readonly Node[];
	outer?: Substitution;
}

/** `a.b` joined with `c` into `a.b.c`, skipping empty parts. */
const joinProp = (...parts: Array<string | undefined>): string | undefined =>
	parts.filter(part => part !== undefined && part !== "").join(".") || undefined;

/**
 * The combined supply of several values a binding or a helper may yield: any visibly missing one is
 * missing; all absent is absent; otherwise every source, opaque if any is.
 */
function combine(supplies: readonly Supply[], what: string): Supply {
	const explicit = supplies.find(entry => "missing" in entry && entry.explicit);
	if (explicit) return explicit;
	const supplied = supplies.filter((entry): entry is Extract<Supply, { sources: Source[] }> => "sources" in entry);
	if (supplied.length === 0) return { missing: `${what} carries none`, absent: true };
	return {
		sources: supplied.flatMap(entry => entry.sources),
		...(supplied.some(entry => entry.opaque) ? { opaque: true as const } : {}),
	};
}

/** The function a local name refers to in scope: a function declaration or a constant holding one. */
function resolveLocalFunction(name: string, ancestors: readonly Node[]): Node | undefined {
	const declared = localDeclaration(name, ancestors);
	if (declared && !declared.param) {
		const init = unwrap(declared.init);
		if (init && isFunctionLike(init) && !declared.initProp && assignmentsTo(name, declared.scope).length === 0) {
			return init;
		}
		if (declared.init) return undefined;
	}
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const scope = ancestors[index];
		const body = isFunctionLike(scope) ? child(scope, "body") : scope.type === "Program" ? scope : undefined;
		if (!body) continue;
		let found: Node | undefined;
		walk(body, (node, nodeAncestors) => {
			if (found || node.type !== "FunctionDeclaration" || nameOf(child(node, "id")) !== name) return;
			if (nodeAncestors.slice(1).some(isFunctionLike)) return;
			found = node;
		});
		if (found) return found;
	}
	return undefined;
}

/** The ancestors of `target` from the root of the tree `ancestors` belongs to. */
function ancestorsOf(target: Node, ancestors: readonly Node[]): readonly Node[] | undefined {
	const root = ancestors[0];
	if (!root) return undefined;
	let found: readonly Node[] | undefined;
	walk(root, (node, nodeAncestors) => {
		if (!found && node === target) found = [...nodeAncestors];
	});
	return found;
}

/** What a function returns: each `return` expression (not those of nested functions), or an arrow's body. */
function returnsOf(fn: Node, fnAncestors: readonly Node[]): Array<{ node: Node | undefined; ancestors: Node[] }> {
	const body = child(fn, "body");
	if (!body) return [];
	if (body.type !== "BlockStatement") return [{ node: body, ancestors: [...fnAncestors, fn] }];
	const returns: Array<{ node: Node | undefined; ancestors: Node[] }> = [];
	walk(
		body,
		(node, nodeAncestors) => {
			if (node.type !== "ReturnStatement") return;
			if (nodeAncestors.slice(fnAncestors.length + 2).some(isFunctionLike)) return;
			returns.push({ node: child(node, "argument"), ancestors: [...nodeAncestors, node] });
		},
		[...fnAncestors, fn],
	);
	return returns;
}

/**
 * Trace the value(s) a local function returns, its parameters standing for `args`. Every return
 * must carry the signal: a branch that returns an object without it (`return {}`) fails, since that
 * branch is a request without one.
 */
function supplyFromFunction(
	fn: Node,
	args: readonly Node[],
	callAncestors: readonly Node[],
	prop: string | undefined,
	depth: number,
	subst: Substitution | undefined,
	inOptions: boolean,
): Supply {
	const fnAncestors = ancestorsOf(fn, callAncestors);
	if (!fnAncestors) return { sources: [{ node: fn, prop }], opaque: true };
	const inner: Substitution = { fn, args, ancestors: callAncestors, outer: subst };
	const returns = returnsOf(fn, fnAncestors);
	if (returns.length === 0) return { missing: "the helper returns nothing", explicit: true };
	const supplies = returns.map(entry =>
		entry.node
			? supply({ node: entry.node, prop }, entry.ancestors, depth + 1, inner, inOptions)
			: { missing: "the helper returns nothing", explicit: true as const },
	);
	const lacking = supplies.find(entry => "missing" in entry);
	if (lacking && "missing" in lacking) {
		return { missing: `a return of the helper passes none: ${lacking.missing}`, explicit: true };
	}
	return combine(supplies, "the helper's result");
}

/**
 * Where `source` (an argument, or a property of one) comes from: the expressions that supply the
 * signal, `missing` when it is visibly absent or `undefined` on any path the walk can see.
 *
 * - A local binding is traced through its initializer and every later assignment, and a property of
 *   it through every later write of that property; a deletion or a write under an unresolvable key
 *   fails.
 * - A property read (`options.signal`) is traced into the object it reads from.
 * - An object literal's later property wins, a computed key included; a getter is traced into what
 *   it returns; a key the walk cannot resolve after the signal fails.
 * - A call to a local function is traced into what it returns, its parameters standing for the
 *   call's arguments. Options built by any other helper (`inOptions`) are accepted only when the
 *   helper's arguments visibly carry the signal.
 * - A parameter, `this`, or an import is trusted (`opaque`): a caller declaration carries the
 *   requirement out to whoever supplies it.
 */
function supply(source: Source, ancestors: readonly Node[], depth = 0, subst?: Substitution, inOptions = true): Supply {
	if (depth > 12) return { sources: [source], opaque: true };
	const node = unwrap(source.node);
	if (!node) return { missing: "no argument", explicit: true };
	if (node.type === "ConditionalExpression") {
		const branches = [child(node, "consequent")!, child(node, "alternate")!].map(branch =>
			supply({ node: branch, prop: source.prop }, ancestors, depth + 1, subst, inOptions),
		);
		const missing = branches.find(branch => "missing" in branch);
		if (missing)
			return { missing: `a branch passes none: ${(missing as { missing: string }).missing}`, explicit: true };
		return combine(branches, "a conditional");
	}
	if (node.type === "LogicalExpression") {
		const left = supply({ node: child(node, "left")!, prop: source.prop }, ancestors, depth + 1, subst, inOptions);
		// `a ?? b`, `a || b`: when the left side is visibly missing, the right side is what is passed.
		// `a && b`: a truthy left yields the right side.
		if (node.operator === "&&" || "missing" in left) {
			return supply({ node: child(node, "right")!, prop: source.prop }, ancestors, depth + 1, subst, inOptions);
		}
		return left;
	}
	if (node.type === "SequenceExpression") {
		const last = children(node, "expressions").at(-1);
		return supply({ node: last!, prop: source.prop }, ancestors, depth + 1, subst, inOptions);
	}
	if (node.type === "Identifier" && node.name !== "undefined") {
		const name = node.name as string;
		const declared = localDeclaration(name, ancestors);
		// Options the walk looks into must stay where it sees them: refuse a container that is handed on,
		// aliased or written through before the request reads it (`escapeOf`).
		const key = source.prop?.split(".")[0];
		const container = inOptions && key !== undefined && !declared?.initProp && !declared?.param?.prop;
		if (declared?.param && subst && declared.param.fn === subst.fn) {
			// A helper's parameter: the caller's argument at that position, unless the helper changes it.
			if (container) {
				const escaped = escapeOf(name, declared.scope, scopeAncestors(declared.scope, ancestors), node, key);
				if (escaped) return { missing: `in the helper, ${escaped}`, explicit: true };
				const written = mutationsOf(name, key, declared.scope);
				if (written.erased) return { missing: `in the helper, ${written.erased}`, explicit: true };
				if (written.values.length > 0) {
					return { missing: `the helper writes \`${name}.${key}\` before the request`, explicit: true };
				}
			}
			const arg = subst.args[declared.param.index];
			const prop = joinProp(declared.param.prop, source.prop);
			if (!arg)
				return { missing: `the helper's parameter ${declared.param.index + 1} is not passed`, explicit: true };
			if (arg.type === "SpreadElement") return { missing: "the helper's arguments are spread", explicit: true };
			return supply({ node: arg, prop }, subst.ancestors, depth + 1, subst.outer, inOptions);
		}
		if (!declared) {
			return source.prop ? { sources: [{ node, prop: source.prop }], opaque: true } : { sources: [{ node }] };
		}
		if (container) {
			const escaped = escapeOf(name, declared.scope, scopeAncestors(declared.scope, ancestors), node, key);
			if (escaped) return { missing: escaped, explicit: true };
		}
		const candidates: Supply[] = [];
		if (declared.param) {
			candidates.push(
				source.prop ? { sources: [{ node, prop: source.prop }], opaque: true } : { sources: [{ node }] },
			);
		} else if (declared.init) {
			const prop = declared.initProp ? joinProp(declared.initProp, source.prop) : source.prop;
			candidates.push(supply({ node: declared.init, prop }, ancestors, depth + 1, subst, inOptions));
		} else {
			candidates.push({ missing: `\`${name}\` is declared with no value`, absent: true });
		}
		for (const assigned of assignmentsTo(name, declared.scope)) {
			candidates.push(supply({ node: assigned, prop: source.prop }, ancestors, depth + 1, subst, inOptions));
		}
		if (source.prop) {
			const [head, ...rest] = source.prop.split(".");
			const mutated = mutationsOf(name, head, declared.scope);
			if (mutated.erased) return { missing: mutated.erased, explicit: true };
			for (const value of mutated.values) {
				candidates.push(
					supply({ node: value, prop: joinProp(...rest) }, ancestors, depth + 1, subst, rest.length > 0),
				);
			}
		}
		return combine(candidates, `\`${name}\``);
	}
	if (/MemberExpression$/.test(node.type)) {
		const object = unwrap(child(node, "object"));
		const key = node.computed ? resolveString(child(node, "property"), ancestors) : nameOf(child(node, "property"));
		if (typeof key === "string" && object?.type === "Identifier") {
			// At a signal position (`controller.signal`), the object read from is no options object: a
			// constructed or helper-built one is traced, not refused.
			const traced = supply(
				{ node: object, prop: joinProp(key, source.prop) },
				ancestors,
				depth + 1,
				subst,
				source.prop ? inOptions : false,
			);
			// A signal read off an object the walk cannot see into (`owner.signal`, a parameter) is the signal
			// passed; only a visible object that lacks it, or holds `undefined`, makes it missing.
			if (!source.prop && "sources" in traced && traced.opaque) return { sources: [{ node }] };
			return traced;
		}
		return source.prop ? { sources: [{ node, prop: source.prop }], opaque: true } : { sources: [{ node }] };
	}
	if (/^(Call|OptionalCall)Expression$/.test(node.type)) {
		const callee = unwrap(child(node, "callee"));
		const local = callee?.type === "Identifier" ? resolveLocalFunction(callee.name as string, ancestors) : undefined;
		const args = children(node, "arguments");
		if (local) return supplyFromFunction(local, args, ancestors, source.prop, depth, subst, inOptions);
		if (inOptions && source.prop) {
			// Options built by a helper the walk cannot read (a method, an import, `Object.assign`): whatever
			// its arguments hold, the helper decides what it returns, so the signal must be restated at the
			// call, after the helper's result: `{ ...helper(…), signal }`.
			const helper = callee?.type === "MemberExpression" ? memberName(callee) : nameOf(callee);
			return {
				missing: `the options come from \`${helper ?? "a call"}(…)\`, which the walk cannot read; restate \`${source.prop}\` at the call: \`{ ...${helper ?? "helper"}(…), ${source.prop.split(".")[0]} }\``,
				explicit: true,
			};
		}
		return { sources: [{ node, prop: source.prop }], opaque: true };
	}
	if (!source.prop) {
		if (isUndefinedLiteral(node)) return { missing: "the signal is undefined", explicit: true };
		return { sources: [{ node }] };
	}
	if (node.type === "ObjectExpression") {
		const [head, ...rest] = source.prop.split(".");
		const properties = children(node, "properties");
		for (let index = properties.length - 1; index >= 0; index--) {
			const property = properties[index];
			if (property.type === "SpreadElement") {
				// A later spread wins: one that carries the property (even as `undefined`) decides it.
				const spread = supply(
					{ node: child(property, "argument")!, prop: source.prop },
					ancestors,
					depth + 1,
					subst,
					inOptions,
				);
				if ("missing" in spread && spread.absent) continue;
				return spread;
			}
			const key = property.computed
				? resolveString(child(property, "key"), ancestors)
				: nameOf(child(property, "key"));
			if (key === undefined) {
				return {
					missing: `a later key the walk cannot resolve may replace \`${head}\``,
					explicit: true,
				};
			}
			if (key !== head) continue;
			if (property.type === "ObjectMethod") {
				if (property.kind !== "get") {
					return {
						missing: `\`${head}\` is ${property.kind === "set" ? "a setter with no getter" : "a method"}`,
						explicit: true,
					};
				}
				const getterAncestors = ancestorsOf(property, ancestors) ?? ancestors;
				return supplyFromFunction(property, [], getterAncestors, joinProp(...rest), depth, subst, rest.length > 0);
			}
			const value = child(property, property.shorthand ? "key" : "value");
			return supply({ node: value!, prop: joinProp(...rest) }, ancestors, depth + 1, subst, rest.length > 0);
		}
		return { missing: `the options carry no \`${source.prop}\``, absent: true };
	}
	if (node.type === "NewExpression" && inOptions) {
		return {
			missing: `the options are constructed by \`new ${nameOf(unwrap(child(node, "callee"))) ?? "…"}(…)\`; pass them as an object`,
			explicit: true,
		};
	}
	return { sources: [{ node, prop: source.prop }], opaque: true };
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

/**
 * A call's arguments with each spread of a visible array (`f(...[a, b])`, `f(...args)` where
 * `const args = [a, b]`) expanded in place; undefined when a spread hides what is passed.
 */
function expandArguments(args: readonly Node[], ancestors: readonly Node[]): Node[] | undefined {
	const expanded: Node[] = [];
	for (const arg of args) {
		if (arg.type !== "SpreadElement") {
			expanded.push(arg);
			continue;
		}
		let target = unwrap(child(arg, "argument"));
		if (target?.type === "Identifier") {
			const declared = localDeclaration(target.name as string, ancestors);
			if (!declared?.init || declared.initProp || declared.param) return undefined;
			if (assignmentsTo(target.name as string, declared.scope).length > 0) return undefined;
			// `args[1] = {}`, `args.push(…)`, `mutate(args)`: the array must hold what it was built with.
			if (
				escapeOf(
					target.name as string,
					declared.scope,
					scopeAncestors(declared.scope, ancestors),
					target,
					undefined,
				)
			) {
				return undefined;
			}
			target = unwrap(declared.init);
		}
		if (target?.type !== "ArrayExpression") return undefined;
		for (const element of children(target, "elements")) {
			if (element.type === "SpreadElement") return undefined;
			expanded.push(element);
		}
	}
	return expanded;
}

/** The value a `signal` path of a call or construction supplies. */
function supplyAt(site: RequestCall, path: SignalPath): Supply {
	const args = expandArguments(children(site.node, "arguments"), site.ancestors);
	if (!args) {
		return {
			missing: "its arguments are spread from a value the walk cannot see; pass them directly",
			explicit: true,
		};
	}
	const arg = args[path.arg];
	if (!arg) return { missing: `argument ${path.arg + 1} is not passed`, explicit: true };
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

/** Names and header values that carry a credential: `apiKey`, `accessToken`, `"authorization"`, `Bearer …`. */
const CREDENTIAL_NAME =
	/^(api_?key|apikey|access_?token|refresh_?token|id_?token|auth_?token|session_?token|bearer_?token|bearer|authorization|credentials?|secret|client_?secret|password|cookie|token)$/i;
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|x-goog-api-key)$/i;

/**
 * Whether a site is a send the request hold's fetch backstop does not see: a Node network module, a
 * `Bun` member, a WebSocket or EventSource. (`fetch` and `gatedFetch` go through the hold.)
 */
function unbackstopped(site: Site): boolean {
	const id = site.constructor.id;
	if (id === `net:${GATE.name}`) return false;
	return id.startsWith("net:") || id === "global:WebSocket" || id === "global:EventSource";
}

/** The function (or file) a site's request is made in. */
function enclosingScope(site: Site): Node {
	return site.ancestors.findLast(isFunctionLike) ?? child(site.file.ast, "program") ?? site.file.ast;
}

/** The first credential the code around a site handles (a name or a header), with its line; undefined when none. */
function credentialNear(site: Site): string | undefined {
	let found: string | undefined;
	walk(enclosingScope(site), node => {
		if (found) return;
		const line = node.loc?.start.line ?? 0;
		if (node.type === "Identifier" && CREDENTIAL_NAME.test(node.name as string))
			found = `\`${node.name}\`, line ${line}`;
		if (node.type === "StringLiteral" || node.type === "TemplateElement") {
			const text = String(
				node.type === "StringLiteral" ? node.value : ((node.value as { raw?: string })?.raw ?? ""),
			);
			if (CREDENTIAL_HEADER.test(text) || /\bBearer\s/.test(text)) found = `"${text.slice(0, 32)}", line ${line}`;
		}
	});
	return found;
}

/** Calls that ask the request hold right before a send: pi-ai's `admitSend`, pi-utils' `admitNetworkSend`, a bound admission. */
const HOLD_ADMISSION = /^(#?admitSend|admitNetworkSend|admitProviderRequest|admit)$/;

/** Whether the function a site is in asks the request hold before the site. */
function gatedBefore(site: Site): boolean {
	const start = (site.node.start as number | undefined) ?? 0;
	let gated = false;
	walk(enclosingScope(site), node => {
		if (gated || !/^(Call|OptionalCall)Expression$/.test(node.type) || ((node.start as number) ?? 0) >= start) return;
		const callee = unwrap(child(node, "callee"));
		const name = callee?.type === "MemberExpression" ? memberName(callee) : nameOf(callee);
		if (name && HOLD_ADMISSION.test(name)) gated = true;
	});
	return gated;
}

/**
 * Whether a socket a site opens (`new WebSocket(…)`, `Reflect.construct(WebSocket, …)`) is stored in
 * a local binding that an abort listener on a signal closes, in the same function:
 * `signal.addEventListener("abort", () => socket.close(…))`.
 */
function closedOnAbort(site: Site): boolean {
	let opened = site.node;
	let ancestors = site.ancestors;
	const parent = ancestors.at(-1);
	if (site.use === "value" && parent?.type === "CallExpression" && children(parent, "arguments")[0] === site.node) {
		const callee = unwrap(child(parent, "callee"));
		if (callee?.type !== "MemberExpression" || nameOf(child(callee, "object")) !== "Reflect") return false;
		if (memberName(callee) !== "construct") return false;
		opened = parent;
		ancestors = ancestors.slice(0, -1);
	}
	const socket = storedIn(opened, ancestors);
	const scope = ancestors.findLast(isFunctionLike);
	if (!socket || socket.kind !== "binding" || !scope) return false;
	let closed = false;
	walk(scope, node => {
		if (closed || node.type !== "CallExpression") return;
		const callee = unwrap(child(node, "callee"));
		if (callee?.type !== "MemberExpression" || memberName(callee) !== "addEventListener") return;
		const target = unwrap(child(callee, "object"));
		const [event, listener] = children(node, "arguments");
		if (event?.type !== "StringLiteral" || event.value !== "abort" || !listener) return;
		if (!/signal$/i.test((target?.type === "MemberExpression" ? memberName(target) : nameOf(target)) ?? "")) return;
		walk(listener, inner => {
			if (inner.type !== "CallExpression") return;
			const close = unwrap(child(inner, "callee"));
			if (
				close?.type === "MemberExpression" &&
				/^(close|destroy|abort|terminate)$/.test(memberName(close) ?? "") &&
				nameOf(child(close, "object")) === socket.name
			) {
				closed = true;
			}
		});
	});
	return closed;
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

/**
 * The provider entry points the transport packages export: every exported name `stream<Provider>`
 * (declared there, or re-exported, as `register-builtins` re-exports `streamAnthropic`). Each takes
 * `(model, context, options)`, the signal in `options`.
 */
function providerEntryPoints(files: ReadonlyMap<string, SourceFile>): Array<[string, string]> {
	const found = new Map<string, [string, string]>();
	for (const file of files.values()) {
		if (!file.pkg.transport || !/\bstream[A-Z]/.test(file.text)) continue;
		for (const statement of children(child(file.ast, "program"), "body")) {
			if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
			const declaration = child(statement, "declaration");
			const names = declaration
				? declaredNames(declaration)
				: children(statement, "specifiers").map(specifier => nameOf(child(specifier, "exported")) ?? "");
			for (const name of names) {
				if (/^stream[A-Z]\w*$/.test(name)) found.set(`${file.pkg.name}:${name}`, [file.pkg.name, name]);
			}
		}
	}
	return [...found.values()];
}

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

/**
 * Problems with how the Hindsight client is bound: the walk finds its requests by the name `client`,
 * so a client stored under another name, or a method destructured off it, would hide a request.
 */
function hindsightBindings(files: ReadonlyMap<string, SourceFile>, methods: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	for (const file of files.values()) {
		if (file.key === HINDSIGHT.file) continue;
		if (/\}\s*=\s*[\w$.?]*\bclient\b/.test(file.text)) {
			walk(file.ast, node => {
				if (node.type !== "VariableDeclarator" || child(node, "id")?.type !== "ObjectPattern") return;
				const init = unwrap(child(node, "init"));
				const receiver = /MemberExpression$/.test(init?.type ?? "") ? memberName(init!) : nameOf(init);
				if (receiver !== "client") return;
				const taken = children(child(node, "id"), "properties").some(property => {
					if (property.type === "RestElement" || property.computed) return true;
					return methods.has(nameOf(child(property, "key")) ?? "");
				});
				if (taken) {
					problems.push(
						`${file.key}:${node.loc?.start.line}: a Hindsight client's methods destructured off "client"; call them on it`,
					);
				}
			});
		}
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

/** What {@link checkModelRequestOwnership} found. */
export interface OwnershipReport {
	/** Every site found, declared or not. */
	sites: Array<{ owner?: string; file: string; line: number; use: string; name: string }>;
	/** Each way the tree breaks the rules; empty when it passes. */
	problems: string[];
	/** How many packages the walk covered. */
	packageCount: number;
}

/**
 * Walk the packages under `packagesDir` (the coding agent and every workspace package it depends
 * on) and check every site that can create a model request against the rules above.
 */
export async function checkModelRequestOwnership(packagesDir: string): Promise<OwnershipReport> {
	PACKAGES_DIR = packagesDir;
	byId.clear();
	parsed.clear();
	const packages = await loadPackages();
	const files = await loadFiles(packages);
	const graph = new Graph(files, packages);
	const problems: string[] = [];

	for (const [pkg, primitives] of Object.entries(TRANSPORT_PRIMITIVES)) {
		for (const [name, signal] of Object.entries(primitives)) addConstructor(`pkg:${pkg}:${name}`, name, signal);
	}
	// Each provider's own entry point (`streamOpenAIResponses`, `streamAnthropic`, …) sends a request
	// without going through `stream()`; every one a transport package exports is a primitive, found
	// rather than listed, so a new provider is covered the day it is added.
	for (const [pkg, name] of providerEntryPoints(files)) addConstructor(`pkg:${pkg}:${name}`, name, opt(2));
	for (const [file, primitives] of Object.entries(SOURCE_PRIMITIVES)) {
		for (const [name, signal] of Object.entries(primitives)) addConstructor(`fn:${file}:${name}`, name, signal);
	}
	for (const [name, signal] of Object.entries(NETWORK_GLOBALS)) addConstructor(`global:${name}`, name, signal);
	addConstructor("net:bun.connect", "Bun.connect", NONE);
	addConstructor("net:bun.fetch", "Bun.fetch", opt(1));
	addConstructor(`net:${GATE.name}`, GATE.name, opt(1));
	const methods = await hindsightMethods(files);
	if (files.has(HINDSIGHT.file) && !["recall", "retain", "retainBatch", "reflect"].every(name => methods.has(name))) {
		problems.push(`${HINDSIGHT.file}: the Hindsight client's request methods were not found`);
	}
	problems.push(...hindsightBindings(files, methods));

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
			if (round > 0 && !names.some(name => file.text.includes(name)) && !INDIRECT_IMPORT.test(file.text)) continue;
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
		const network = site.constructor.id.startsWith("global:") || site.constructor.id.startsWith("net:");
		// A model API (a listed primitive, the judge chain, the Hindsight client) is always a model request.
		const modelApi =
			/^(pkg:|hindsight:)/.test(site.constructor.id) ||
			site.constructor.id.startsWith("fn:coding-agent/src/judgment/");
		if (site.owner === "none" && modelApi) {
			problems.push(`${where}: "none" is for network sites that are not model requests; this is a model API`);
		}
		// A transport package's library code implements requests for others; its scripts are standalone tools.
		const transportLibrary = site.file.pkg.transport && site.file.key.startsWith(`${site.file.pkg.dir}/src/`);
		if (transportLibrary && network && site.owner !== "transport" && site.owner !== "none") {
			problems.push(`${where}: a transport package's network site is "transport <primitive>" or "none"`);
		}
		if (site.owner === "transport") {
			// Listed or discovered primitives (provider entry points included): of this transport package, or any.
			const primitives = [...byId.keys()].filter(id => id.startsWith("pkg:") || id.startsWith("fn:"));
			const listed = site.file.pkg.transport
				? primitives.filter(id => id.startsWith(`pkg:${site.file.pkg.name}:`)).map(id => id.split(":").at(-1) ?? "")
				: [
						...primitives.filter(id => id.startsWith("pkg:")).map(id => id.split(":").at(-1) ?? ""),
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
		// A credential on a transport the hold's fetch backstop does not see must ask the hold itself, whatever
		// the declaration says: a declaration is checked against the code, not taken at its word. Exempt only
		// lifetimes that are decisions in themselves: outside any session, outliving disposal on purpose, or
		// governed by the extension boundary.
		if (unbackstopped(site) && !["no-session", "outlives-disposal", "extension"].includes(site.owner)) {
			const credential = credentialNear(site);
			if (credential && !gatedBefore(site)) {
				problems.push(
					`${where}: this send carries a credential (${credential}) on a transport the request hold's fetch backstop does not see, and nothing asks the hold first; call \`admitSend\` (pi-ai) or \`admitNetworkSend\` (pi-utils) before it, or declare its lifetime ("no-session", "outlives-disposal") — "${site.owner}" does not cover it`,
				);
			}
		}
		if (site.use === "unresolved") continue;
		const needsSignal = site.owner === "session" || site.owner === "turn" || site.owner === "caller";
		if (needsSignal && (site.constructor.id === "global:eval" || site.constructor.id === "global:Function")) {
			problems.push(
				`${where}: generated code takes no cancellation, so it cannot be "${site.owner}"-owned; declare what the code is for`,
			);
			continue;
		}
		if (!needsSignal) continue;
		const needed = pathsFor(site.constructor, site);
		if (needed === "exempt") continue;
		if (needed === "none") {
			// A socket takes no signal; it is owned when an abort listener on a signal closes it.
			if (!closedOnAbort(site)) {
				problems.push(
					`${where}: takes no cancellation, so it cannot be "${site.owner}"-owned unless an abort listener on its signal closes it`,
				);
			}
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
	return {
		sites: inventory.map(s => ({
			owner: s.owner,
			file: s.file.key,
			line: s.line,
			use: s.use,
			name: s.constructor.name,
		})),
		problems,
		packageCount: packages.size,
	};
}
