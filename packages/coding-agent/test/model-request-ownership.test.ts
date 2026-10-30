/**
 * Every place in `src/` that creates a model request says who owns it.
 *
 * A model request is a request to a model provider (inference, a judge, embeddings, speech, image,
 * video, a connection or WebSocket prewarm) or to the Hindsight memory service. Requests are created
 * through the request primitives of `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-agent-core`, the session judge
 * chain (`resolveJudge`, `ChainJudge`) and the Hindsight client (`HindsightApi`, reached as `client`).
 * This test walks the syntax tree of every source file and finds each use of one of them: a call, a
 * construction, or the function handed on as a value. Each use must sit under a declaration:
 *
 *     // model-request: <owner> — <why>
 *
 * The owners, the only words the test accepts:
 *
 * - `session`: carries the owning session's disposal signal, or one derived from it, so it stops
 *   when the session begins disposing.
 * - `turn`: belongs to an admitted turn (a prompt, a tool call, the work a turn awaits) and carries
 *   that turn's signal. It may finish after `beginDispose()`; `dispose()` aborts the turn.
 * - `caller <name>[, <name>]`: carries a signal that `<name>` takes from its own caller. Every use of
 *   `<name>` is then a creation site too, with a declaration of its own, so the walk follows the
 *   signal out to whoever owns it. `<name>` encloses the site (a function; a class, whose
 *   constructions are its uses; a class member: a private one is reached as `this.#name`, a public
 *   one through any instance, so every `.name` use in any file counts), or is the variable or field
 *   a handed-on function is stored in.
 * - `no-session`: runs where no session exists (a CLI command, a standalone helper), so there is no
 *   disposal to outlive.
 * - `outlives-disposal`: deliberately runs on after its session began disposing. The reason says
 *   why, so the next reader sees a decision rather than an omission.
 * - `extension`: handed to extension or plugin code, whose requests the extension boundary governs.
 * - `transport`: implements a provider's transport; the request belongs to whoever called it.
 *
 * A `session`, `turn` or `caller` site that calls or constructs a primitive must pass a cancellation:
 * its arguments name a signal (an identifier or property whose name ends in `signal`), directly or
 * through a variable declared with one or a parameter typed with one. An `Agent` is the exception:
 * its owner aborts it rather than passing a signal in.
 *
 * To add a request that outlives disposal, write `// model-request: outlives-disposal — <why>` above
 * the line that creates it. A creation site with no declaration fails here, with its location.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parse } from "@babel/parser";

const SRC = path.join(import.meta.dir, "../src");

/** Request primitives exported by the provider packages, by module (any subpath of it). */
const PACKAGE_PRIMITIVES: ReadonlyArray<{ prefix: string; module: RegExp; names: readonly string[] }> = [
	{
		prefix: "@oh-my-pi/pi-ai",
		module: /^@oh-my-pi\/pi-ai(\/.*)?$/,
		names: [
			"stream",
			"complete",
			"streamSimple",
			"completeSimple",
			"embed",
			"rerank",
			"synthesizeSpeech",
			"transcribeAudio",
			"generateImage",
			"submitVideo",
			"pollVideo",
			"downloadVideo",
			"createNativeJudge",
			"NativeJudge",
			"chatTextBackend",
			"prewarmOpenAICodexResponses",
			"prewarmModelConnection",
		],
	},
	{
		prefix: "@oh-my-pi/pi-agent-core",
		module: /^@oh-my-pi\/pi-agent-core(\/.*)?$/,
		names: [
			"Agent",
			"agentLoop",
			"agentLoopContinue",
			"agentLoopDetailed",
			"agentLoopContinueDetailed",
			"instrumentedCompleteSimple",
			"streamProxy",
			"compact",
			"generateSummary",
			"generateBranchSummary",
			"generateHandoff",
			"generateHandoffFromContext",
			"requestCompactionV2Streaming",
			"requestAnthropicNativeCompaction",
			"requestOpenAiRemoteCompaction",
			"requestRemoteCompaction",
		],
	},
];

/** Request primitives defined in `src/`, by the file (relative to `src/`) that defines them. */
const SOURCE_PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
	"judgment/index.ts": ["resolveJudge", "ChainJudge"],
};

/** Constructions whose owner aborts them, so they take no signal argument. */
const ABORTED_BY_OWNER = new Set(["Agent"]);

const OWNERS = new Set(["session", "turn", "caller", "no-session", "outlives-disposal", "extension", "transport"]);
const DECLARATION = /^\s*model-request:\s*([a-z-]+)(.*)$/;

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

const child = (node: Node, key: string): Node | undefined => {
	const value = node[key];
	return isNode(value) ? value : undefined;
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

interface SourceFile {
	rel: string;
	text: string;
	ast: Node;
	comments: Comment[];
}

const texts = new Map<string, string>();
const parsed = new Map<string, SourceFile>();

async function textOf(rel: string): Promise<string> {
	let text = texts.get(rel);
	if (text === undefined) {
		text = await Bun.file(path.join(SRC, rel)).text();
		texts.set(rel, text);
	}
	return text;
}

async function load(rel: string): Promise<SourceFile> {
	const cached = parsed.get(rel);
	if (cached) return cached;
	const text = await textOf(rel);
	const ast = parse(text, {
		sourceType: "module",
		plugins: ["typescript", "decorators-legacy", "explicitResourceManagement", "importAttributes"],
	});
	const file: SourceFile = { rel, text, ast: ast as unknown as Node, comments: ast.comments as unknown as Comment[] };
	parsed.set(rel, file);
	return file;
}

/** The `src/`-relative file a relative import specifier in `fromRel` names, if it is one of `known`. */
function resolveRelative(fromRel: string, specifier: string, known: ReadonlySet<string>): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.posix.join(path.posix.dirname(fromRel), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (known.has(candidate)) return candidate;
	return undefined;
}

/** A name whose uses are creation sites. */
interface Constructor {
	name: string;
	/** Defining module: a package specifier pattern, or the `src/`-relative file that declares it. */
	module: RegExp | string;
	/** Reached as `this.name` inside its file rather than by an identifier. */
	member?: boolean;
}

interface Site {
	rel: string;
	line: number;
	name: string;
	use: "call" | "new" | "value";
	owner?: string;
	reason?: string;
	callers?: string[];
	signalPassed: boolean;
	declarationStart?: number;
	/** Functions, classes and members enclosing the site, by kind. */
	enclosing: Map<string, "binding" | "member">;
	/** For a handed-on function: the variable or private field it is stored in. */
	storedIn?: { name: string; member: boolean };
}

const STATEMENT_LEVEL = /Statement$|Declaration$|^Class(Private)?(Method|Property)$/;

/** The `model-request:` declaration nearest above the innermost node of `chain`, up to its statement. */
function declarationOf(chain: readonly Node[]): Pick<Site, "owner" | "reason" | "callers" | "declarationStart"> {
	for (let index = chain.length - 1; index >= 0; index--) {
		const node = chain[index];
		for (const comment of node.leadingComments ?? []) {
			const match = DECLARATION.exec(comment.value);
			if (!match) continue;
			const owner = match[1];
			const reason = match[2].replace(/^\s*[—-]?\s*/, "").trim();
			const callers =
				owner === "caller" ? (/^[\w#$]+(\s*,\s*[\w#$]+)*/.exec(reason)?.[0] ?? "").split(/\s*,\s*/) : undefined;
			return { owner, reason, callers, declarationStart: comment.start ?? undefined };
		}
		// A statement is the last place a declaration may sit; an exported declaration's comment sits on the export.
		if (STATEMENT_LEVEL.test(node.type) && !/^Export(Named|Default)Declaration$/.test(chain[index - 1]?.type ?? "")) {
			break;
		}
	}
	return {};
}

/**
 * Whether `args` name a cancellation: an identifier or property whose name ends in `signal`. A
 * variable the arguments use (`stream(model, context, options)`, `{ streamOptions }`) counts when
 * the enclosing functions declare it with a value that names one, or as a parameter whose type
 * has a `signal` member.
 */
function passesSignal(args: readonly Node[], ancestors: readonly Node[]): boolean {
	const names = (node: Node | undefined): boolean => {
		let found = false;
		if (node) {
			walk(node, inner => {
				if ((inner.type === "Identifier" || inner.type === "PrivateName") && /signal$/i.test(nameOf(inner) ?? "")) {
					found = true;
				}
			});
		}
		return found;
	};
	if (args.some(names)) return true;
	const used = new Set<string>();
	for (const arg of args) {
		walk(arg, node => {
			if (node.type === "Identifier") used.add(node.name as string);
		});
	}
	const scopes = ancestors.filter(node => /Function|Method/.test(node.type));
	let declared = false;
	for (const scope of scopes) {
		for (const param of (scope.params as Node[]) ?? []) {
			const binding = param.type === "AssignmentPattern" ? child(param, "left") : param;
			if (binding && used.has(nameOf(binding) ?? "") && names(child(binding, "typeAnnotation"))) declared = true;
		}
		walk(scope, node => {
			if (node.type !== "VariableDeclarator" || !used.has(nameOf(child(node, "id")) ?? "")) return;
			if (names(child(node, "init"))) declared = true;
		});
	}
	return declared;
}

function enclosingNames(ancestors: readonly Node[]): Map<string, "binding" | "member"> {
	const names = new Map<string, "binding" | "member">();
	for (const node of ancestors) {
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "ClassDeclaration" ||
			node.type === "VariableDeclarator"
		) {
			const id = nameOf(child(node, "id"));
			if (id) names.set(id, "binding");
		}
		if (/^Class(Private)?(Method|Property)$/.test(node.type)) {
			const key = nameOf(child(node, "key"));
			if (key) names.set(key, "member");
		}
	}
	return names;
}

/** Where a handed-on function lands: `this.#field = fn`, `const name = fn`, `#field = fn`. */
function storedIn(node: Node, ancestors: readonly Node[]): Site["storedIn"] {
	let current = node;
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const parent = ancestors[index];
		if (
			/^(LogicalExpression|ConditionalExpression|TSAsExpression|TSSatisfiesExpression|ParenthesizedExpression)$/.test(
				parent.type,
			)
		) {
			current = parent;
			continue;
		}
		if (parent.type === "AssignmentExpression" && parent.right === current) {
			const left = child(parent, "left");
			if (left?.type === "Identifier") return { name: nameOf(left) ?? "", member: false };
			if (left?.type === "MemberExpression" && child(left, "object")?.type === "ThisExpression") {
				return { name: nameOf(child(left, "property")) ?? "", member: true };
			}
		}
		if (parent.type === "VariableDeclarator" && parent.init === current) {
			return { name: nameOf(child(parent, "id")) ?? "", member: false };
		}
		if (/^Class(Private)?Property$/.test(parent.type) && parent.value === current) {
			return { name: nameOf(child(parent, "key")) ?? "", member: true };
		}
		return undefined;
	}
	return undefined;
}

/** Binding names in `file` that refer to `constructors`, namespace aliases of their modules, and re-exports. */
function bindingsOf(file: SourceFile, constructors: readonly Constructor[], known: ReadonlySet<string>) {
	const named = new Map<string, Constructor>();
	const namespaces = new Map<string, Constructor[]>();
	const reexports: Site[] = [];
	const matching = (specifier: string): Constructor[] =>
		constructors.filter(c =>
			c.member
				? false
				: typeof c.module === "string"
					? resolveRelative(file.rel, specifier, known) === c.module
					: c.module.test(specifier),
		);
	for (const statement of (child(file.ast, "program")?.body as Node[]) ?? []) {
		const source = child(statement, "source");
		if (!source || typeof source.value !== "string") continue;
		const candidates = matching(source.value);
		if (candidates.length === 0) continue;
		if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
			for (const specifier of statement.specifiers as Node[]) {
				const local = nameOf(child(specifier, "local"));
				if (!local || specifier.importKind === "type") continue;
				if (specifier.type === "ImportNamespaceSpecifier") {
					namespaces.set(local, candidates);
					continue;
				}
				const imported = nameOf(child(specifier, "imported")) ?? "default";
				const constructor = candidates.find(c => c.name === imported);
				if (constructor) named.set(local, constructor);
			}
		}
		if (statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type") {
			for (const specifier of (statement.specifiers as Node[]) ?? []) {
				const constructor = candidates.find(c => c.name === nameOf(child(specifier, "local")));
				if (!constructor) continue;
				reexports.push({
					rel: file.rel,
					line: statement.loc?.start.line ?? 0,
					name: constructor.name,
					use: "value",
					signalPassed: false,
					enclosing: new Map(),
					...declarationOf([statement]),
				});
			}
		}
	}
	// Destructured dynamic imports: `const { name } = await import("module")`.
	walk(file.ast, node => {
		if (node.type !== "VariableDeclarator" || child(node, "id")?.type !== "ObjectPattern") return;
		let init = child(node, "init");
		if (init?.type === "AwaitExpression") init = child(init, "argument");
		if (init?.type !== "CallExpression" || child(init, "callee")?.type !== "Import") return;
		const source = (init.arguments as Node[])[0];
		if (source?.type !== "StringLiteral") return;
		const candidates = matching(source.value as string);
		for (const property of (child(node, "id")?.properties as Node[]) ?? []) {
			const constructor = candidates.find(c => c.name === nameOf(child(property, "key")));
			const local = nameOf(child(property, "value"));
			if (constructor && local) named.set(local, constructor);
		}
	});
	return { named, namespaces, reexports };
}

/** Whether identifier `node` under `ancestors` is a use of a binding, not a declaration, key or type. */
function isUse(node: Node, ancestors: readonly Node[]): boolean {
	const parent = ancestors.at(-1);
	if (!parent || /^(Import|Export)/.test(parent.type) || parent.type.startsWith("TS")) return false;
	// A destructuring binding (`const { name } = …`) declares the name.
	if (parent.type === "ObjectProperty" && ancestors.at(-2)?.type === "ObjectPattern") return false;
	if (
		(parent.type === "VariableDeclarator" || parent.type.startsWith("Function") || parent.type.startsWith("Class")) &&
		parent.id === node
	) {
		return false;
	}
	if (/MemberExpression$/.test(parent.type) && parent.property === node && !parent.computed) return false;
	if (/^(Class|Object)(Private)?(Method|Property)$/.test(parent.type) && parent.key === node && !parent.computed) {
		return parent.type === "ObjectProperty" && parent.shorthand === true;
	}
	return true;
}

async function sourceFiles(): Promise<string[]> {
	const out: string[] = [];
	for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: SRC })) out.push(rel.replaceAll("\\", "/"));
	return out.sort();
}

/**
 * A cheap superset test of which files can use one of `constructors`, so only those are parsed: the
 * name appears as a word, and the file is the one defining it or imports its module.
 */
function candidateFilter(
	constructors: readonly Constructor[],
	known: ReadonlySet<string>,
): (rel: string, text: string) => boolean {
	const tests = constructors.map(c => {
		const word = new RegExp(`(^|[^\\w$])${c.name.replace(/[$#]/g, "\\$&")}\\b`);
		const module = c.module;
		// A public member is reached through any instance, from any file: `.name` anywhere.
		if (c.member && !c.name.startsWith("#")) return (_rel: string, text: string) => text.includes(`.${c.name}`);
		if (typeof module !== "string") {
			const prefix = PACKAGE_PRIMITIVES.find(p => p.module === module)?.prefix ?? "";
			return (rel: string, text: string) => text.includes(prefix) && word.test(text);
		}
		return (rel: string, text: string) =>
			word.test(text) &&
			(rel === module ||
				[...text.matchAll(/(?:from|import\()\s*"(\.[^"]*)"/g)].some(
					([, specifier]) => resolveRelative(rel, specifier, known) === module,
				));
	});
	return (rel, text) => tests.some(test => test(rel, text));
}

/** Every creation site of `constructors` in `rels`. */
async function findSites(rels: readonly string[], constructors: readonly Constructor[]): Promise<Site[]> {
	const known = new Set(rels);
	const sites: Site[] = [];
	const mayUse = candidateFilter(constructors, known);
	for (const rel of rels) {
		const text = await textOf(rel);
		if (!mayUse(rel, text)) continue;
		const file = await load(rel);
		const { named, namespaces, reexports } = bindingsOf(file, constructors, known);
		sites.push(...reexports);
		// A private member is reached as `this.#name` in its own file; a public one through any
		// instance, so every `<anything>.name` is a use (a superset of the instances that matter).
		const privateMembers = constructors.filter(c => c.member && c.name.startsWith("#") && c.module === rel);
		const publicMembers = constructors.filter(c => c.member && !c.name.startsWith("#"));
		const members = [...privateMembers, ...publicMembers];
		for (const local of constructors) {
			if (!local.member && local.module === rel && !named.has(local.name)) named.set(local.name, local);
		}
		if (named.size === 0 && namespaces.size === 0 && members.length === 0) continue;
		walk(file.ast, (node, ancestors) => {
			const parent = ancestors.at(-1);
			let constructor: Constructor | undefined;
			if (node.type === "Identifier" && named.has(node.name as string) && isUse(node, ancestors)) {
				constructor = named.get(node.name as string);
			} else if (/MemberExpression$/.test(node.type)) {
				const object = child(node, "object");
				const property = nameOf(child(node, "property"));
				if (object?.type === "Identifier" && namespaces.has(object.name as string)) {
					constructor = namespaces.get(object.name as string)?.find(c => c.name === property);
				}
				constructor ??= (object?.type === "ThisExpression" ? members : publicMembers).find(
					c => c.name === property,
				);
				// Storing into the member (`this.#fn = …`) is not a use of it.
				if (parent?.type === "AssignmentExpression" && parent.left === node) constructor = undefined;
			}
			if (!constructor) return;
			const isCallee = /CallExpression$/.test(parent?.type ?? "") && parent?.callee === node;
			const isNew = parent?.type === "NewExpression" && parent.callee === node;
			const use: Site["use"] = isNew ? "new" : isCallee ? "call" : "value";
			const target = use === "value" ? node : (parent as Node);
			const chain = use === "value" ? [...ancestors, node] : ancestors;
			sites.push({
				rel,
				line: target.loc?.start.line ?? 0,
				name: constructor.name,
				use,
				signalPassed: use !== "value" && passesSignal((target.arguments as Node[]) ?? [], ancestors),
				enclosing: enclosingNames(ancestors),
				storedIn: use === "value" ? storedIn(node, ancestors) : undefined,
				...declarationOf(chain),
			});
		});
	}
	return sites;
}

/** The constructors a `caller` declaration names: each use of them is a creation site in turn. */
function callerConstructors(site: Site, problems: string[]): Constructor[] {
	const out: Constructor[] = [];
	for (const name of site.callers ?? []) {
		const kind =
			site.storedIn?.name === name ? (site.storedIn.member ? "member" : "binding") : site.enclosing.get(name);
		if (!kind) {
			problems.push(`${site.rel}:${site.line}: "caller ${name}" neither encloses the site nor stores it`);
			continue;
		}
		out.push({ name, module: site.rel, member: kind === "member" });
	}
	return out;
}

/** The Hindsight client, whose every public method is a request to the Hindsight memory service. */
const HINDSIGHT_CLIENT = { file: "hindsight/client.ts", className: "HindsightApi", factory: "createHindsightClient" };

/** The request methods of the Hindsight client: its public async methods. */
async function hindsightMethods(): Promise<Set<string>> {
	const methods = new Set<string>();
	walk((await load(HINDSIGHT_CLIENT.file)).ast, (node, ancestors) => {
		const owner = ancestors.at(-2);
		if (node.type !== "ClassMethod" || node.kind !== "method" || node.static || node.async !== true) return;
		if (owner?.type !== "ClassDeclaration" || nameOf(child(owner, "id")) !== HINDSIGHT_CLIENT.className) return;
		const name = nameOf(child(node, "key"));
		if (name) methods.add(name);
	});
	return methods;
}

/**
 * Every Hindsight request: a call of a client method on a binding named `client` (`client.recall(…)`,
 * `state.client.retain(…)`). The walk cannot see types, so it also holds every binding of the client
 * to that name: a parameter, variable or field typed `HindsightApi`, and every value the factory makes.
 */
async function findHindsightSites(
	rels: readonly string[],
	methods: ReadonlySet<string>,
	problems: string[],
): Promise<Site[]> {
	const sites: Site[] = [];
	for (const rel of rels) {
		if (rel === HINDSIGHT_CLIENT.file) continue;
		const text = await textOf(rel);
		const callsMethod = [...methods].some(method => text.includes(`client.${method}(`));
		if (!callsMethod && !text.includes(HINDSIGHT_CLIENT.className) && !text.includes(HINDSIGHT_CLIENT.factory))
			continue;
		const file = await load(rel);
		walk(file.ast, (node, ancestors) => {
			const parent = ancestors.at(-1);
			if (node.type === "TSTypeReference" && nameOf(child(node, "typeName")) === HINDSIGHT_CLIENT.className) {
				// `client: HindsightApi` on a parameter, variable or property: annotation → type → holder.
				const holder = ancestors.at(-2);
				const bound = holder && (nameOf(holder) ?? nameOf(child(holder, "key")));
				if (parent?.type === "TSTypeAnnotation" && bound !== undefined && bound !== "client") {
					problems.push(
						`${rel}:${node.loc?.start.line}: a Hindsight client bound as "${bound}"; name it "client"`,
					);
				}
			}
			if (node.type === "CallExpression" && nameOf(child(node, "callee")) === HINDSIGHT_CLIENT.factory) {
				const target =
					parent?.type === "VariableDeclarator"
						? nameOf(child(parent, "id"))
						: parent?.type === "AssignmentExpression"
							? nameOf(child(child(parent, "left") ?? parent, "property"))
							: undefined;
				if (target !== "client") {
					problems.push(`${rel}:${node.loc?.start.line}: a Hindsight client not stored as "client"`);
				}
			}
			if (node.type !== "CallExpression") return;
			const callee = child(node, "callee");
			if (callee?.type !== "MemberExpression") return;
			const method = nameOf(child(callee, "property"));
			const receiver = child(callee, "object");
			const receiverName =
				receiver?.type === "MemberExpression" ? nameOf(child(receiver, "property")) : nameOf(receiver);
			if (!method || !methods.has(method) || receiverName !== "client") return;
			sites.push({
				rel,
				line: node.loc?.start.line ?? 0,
				name: `${HINDSIGHT_CLIENT.className}.${method}`,
				use: "call",
				signalPassed: passesSignal((node.arguments as Node[]) ?? [], ancestors),
				enclosing: enclosingNames(ancestors),
				...declarationOf([...ancestors, node]),
			});
		});
	}
	return sites;
}

describe("model request ownership", () => {
	it("every creation site declares who owns its request", async () => {
		const rels = await sourceFiles();
		const problems: string[] = [];
		const seen = new Set<string>();
		const inventory: Site[] = [];
		let frontier: Constructor[] = [
			...PACKAGE_PRIMITIVES.flatMap(({ module, names }) => names.map(name => ({ name, module }))),
			...Object.entries(SOURCE_PRIMITIVES).flatMap(([file, names]) => names.map(name => ({ name, module: file }))),
		];
		const expanded = new Set<string>();
		const methods = await hindsightMethods();
		expect([...methods]).toEqual(expect.arrayContaining(["recall", "retain", "retainBatch", "reflect"]));
		let hindsight: Site[] | undefined = await findHindsightSites(rels, methods, problems);
		while (frontier.length > 0 || hindsight) {
			const next: Constructor[] = [];
			const found = [...(hindsight ?? []), ...(frontier.length > 0 ? await findSites(rels, frontier) : [])];
			hindsight = undefined;
			for (const site of found) {
				const key = `${site.rel}:${site.line}:${site.name}:${site.use}`;
				if (seen.has(key)) continue;
				seen.add(key);
				inventory.push(site);
				const where = `${site.rel}:${site.line} (${site.use} of ${site.name})`;
				if (!site.owner) {
					problems.push(`${where}: no "// model-request: <owner> — <why>" declaration`);
					continue;
				}
				if (!OWNERS.has(site.owner)) {
					problems.push(`${where}: unknown owner "${site.owner}"`);
					continue;
				}
				const why = site.owner === "caller" ? site.reason?.replace(/^[\w#$]+(\s*,\s*[\w#$]+)*/, "") : site.reason;
				if (!why?.replace(/^[\s—-]+/, "")) problems.push(`${where}: the declaration gives no reason`);
				const needsSignal =
					(site.owner === "session" || site.owner === "turn" || site.owner === "caller") &&
					site.use !== "value" &&
					!ABORTED_BY_OWNER.has(site.name);
				if (needsSignal && !site.signalPassed)
					problems.push(`${where}: a ${site.owner}-owned request passes no signal`);
				if (site.owner !== "caller") continue;
				for (const constructor of callerConstructors(site, problems)) {
					const id = `${constructor.module}:${constructor.name}`;
					if (expanded.has(id)) continue;
					expanded.add(id);
					next.push(constructor);
				}
			}
			frontier = next;
		}

		// A declaration no creation site uses is stale: the request it described moved or went away.
		const used = new Set(inventory.map(site => `${site.rel}:${site.declarationStart}`));
		for (const rel of rels) {
			const text = await textOf(rel);
			if (!text.includes("model-request:")) continue;
			for (const comment of (await load(rel)).comments) {
				if (DECLARATION.test(comment.value) && !used.has(`${rel}:${comment.start}`)) {
					problems.push(`${rel}:${comment.loc.start.line}: declaration matches no creation site`);
				}
			}
		}

		const byOwner = new Map<string, number>();
		for (const site of inventory) byOwner.set(site.owner ?? "?", (byOwner.get(site.owner ?? "?") ?? 0) + 1);
		console.log(
			`${inventory.length} model-request creation sites: ${[...byOwner].map(([owner, count]) => `${owner} ${count}`).join(", ")}`,
		);
		if (problems.length > 0) {
			const listing = inventory.map(s => `${s.owner ?? "?"}\t${s.rel}:${s.line}\t${s.use} ${s.name}`).join("\n");
			console.log(`Model request creation sites:\n${listing}`);
		}
		expect(problems).toEqual([]);
		// The walk found the primitives; an empty inventory would pass vacuously.
		expect(inventory.length).toBeGreaterThan(40);
		// Parsing every source file takes seconds.
	}, 120_000);
});
