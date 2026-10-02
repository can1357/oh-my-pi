import type * as BabelParser from "@babel/parser";

// Static ESM `import` declarations are not valid inside vm.runInContext (script-mode parsing),
// and dynamic `import(...)` would otherwise resolve specifiers against the worker module's URL
// instead of the session cwd. We rewrite both forms so they route through the worker-injected
// `__omp_import__` helper, which resolves the specifier against the active session cwd. A real
// parser keeps imports embedded in string literals, template literals, or comments intact.

type BabelImportDeclaration = {
	type: "ImportDeclaration";
	start: number;
	end: number;
	source: { value: string };
	specifiers: ReadonlyArray<{
		type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
		local: { name: string };
		imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
	}>;
	attributes?: ReadonlyArray<{
		key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
		value: { value: string };
	}>;
};

type BabelBindingPattern = {
	type: string;
	start?: number;
	end?: number;
	name?: string;
	properties?: ReadonlyArray<unknown>;
	elements?: ReadonlyArray<unknown | null>;
	argument?: unknown;
	left?: unknown;
	value?: unknown;
};

type BabelVariableDeclaration = {
	type: "VariableDeclaration";
	kind: "const" | "let" | "var";
	start: number;
	end: number;
	declarations?: ReadonlyArray<{
		id: BabelBindingPattern & { start: number; end: number };
		init?: { start: number; end: number } | null;
	}>;
};

type BabelClassDeclaration = {
	type: "ClassDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

type BabelLexicalDecl = BabelVariableDeclaration | BabelClassDeclaration;
type BabelFunctionDeclaration = {
	type: "FunctionDeclaration";
	start: number;
	end: number;
	id: { start: number; end: number; name: string } | null;
};

/** Top-level declarations whose bindings must survive the cell (demoted and/or published). */
type BabelPublishableDecl = BabelLexicalDecl | BabelFunctionDeclaration;

type BabelExpressionStatement = {
	type: "ExpressionStatement";
	start: number;
	end: number;
	expression?: { type?: string };
	directive?: string;
};

type BabelAssignmentNode = BabelNode & {
	type: "AssignmentExpression" | "UpdateExpression";
	left?: unknown;
	argument?: unknown;
};

type BindingAssignmentEdit = {
	start: number;
	end: number;
	names: string[];
	children: BindingAssignmentEdit[];
};

type BabelProgramNode = BabelImportDeclaration | BabelLexicalDecl | BabelExpressionStatement | { type: string };
type BabelModuleSourceDeclaration = {
	type: "ImportDeclaration" | "ExportNamedDeclaration" | "ExportAllDeclaration";
	source?: { value: string; start: number; end: number } | null;
};

type BabelNode = { type: string; start: number; end: number; [key: string]: unknown };

// @babel/parser sits on the CLI launch graph (tools → eval backend → worker-core →
// runtime → this module) but only runs when an eval cell executes, so it is loaded
// lazily and memoized.
let babelParser: typeof BabelParser | undefined;

export async function loadBabelParser(): Promise<typeof BabelParser> {
	if (!babelParser) {
		babelParser = await import("@babel/parser");
	}
	return babelParser;
}

async function parseProgram(code: string): Promise<{ program: { body: ReadonlyArray<BabelProgramNode> } } | null> {
	const { parse } = await loadBabelParser();
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins: ["typescript"],
		}) as unknown as { program: { body: ReadonlyArray<BabelProgramNode> } };
	} catch {
		return null;
	}
}

// Callee substituted for dynamic `import(...)` calls. Functions handed to puppeteer
// (`tab.evaluate`, `page.evaluate`, `waitForFunction`, `$$eval`, ...) are serialized with
// `Function.prototype.toString()` and re-evaluated inside the browser page, where the
// worker-injected `__omp_import__` global does not exist. The swap therefore guards on the
// helper's presence and falls back to native dynamic import, so serialized code keeps
// working in foreign realms while in-worker code still resolves against the session cwd.
const DYNAMIC_IMPORT_CALLEE = '(typeof __omp_import__ === "function" ? __omp_import__ : (s, o) => import(s, o))';

function buildOmpImportCall(sourceLiteral: string, optionsLiteral: string | undefined): string {
	// Route every static import through the worker-injected `__omp_import__` helper so the
	// specifier resolves against the session cwd (and `with`-attribute imports keep working).
	return optionsLiteral ? `__omp_import__(${sourceLiteral}, ${optionsLiteral})` : `__omp_import__(${sourceLiteral})`;
}

// Walks every node in `root`, depth-first, invoking `visit` on each one. Skips Babel's
// non-AST bookkeeping fields so we don't recurse into source locations or comment arrays.
function walkNodes(root: unknown, visit: (node: BabelNode) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
			continue;
		}
		const node = current as Record<string, unknown>;
		if (typeof node.type === "string") visit(node as unknown as BabelNode);
		for (const key in node) {
			if (key === "loc" || key === "extra" || key === "range") continue;
			if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
			const value = node[key];
			if (value && typeof value === "object") stack.push(value);
		}
	}
}

function buildOptionsLiteral(node: BabelImportDeclaration): string | undefined {
	const attrs = node.attributes;
	if (!attrs || attrs.length === 0) return undefined;
	const pairs = attrs.map(attr => {
		const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
		return `${key}: ${JSON.stringify(attr.value.value)}`;
	});
	// Native dynamic import takes options as `{ with: { ... } }`. `__omp_import__` forwards the
	// options bag verbatim, so we wrap the attribute pairs accordingly.
	return `{ with: { ${pairs.join(", ")} } }`;
}

function rewriteImportNode(node: BabelImportDeclaration): string {
	const sourceLiteral = JSON.stringify(node.source.value);
	const optionsLiteral = buildOptionsLiteral(node);
	const importCall = buildOmpImportCall(sourceLiteral, optionsLiteral);

	let defaultName: string | undefined;
	let namespaceName: string | undefined;
	const namedPairs: Array<[string, string]> = [];
	for (const spec of node.specifiers) {
		if (spec.type === "ImportDefaultSpecifier") {
			defaultName = spec.local.name;
		} else if (spec.type === "ImportNamespaceSpecifier") {
			namespaceName = spec.local.name;
		} else if (spec.type === "ImportSpecifier" && spec.imported) {
			const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
			namedPairs.push([imported, spec.local.name]);
		}
	}

	if (namedPairs.length > 0) {
		const inner = namedPairs.map(([imp, loc]) => (imp === loc ? imp : `${imp}: ${loc}`)).join(", ");
		const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
		return `const { ${props} } = await ${importCall};`;
	}
	if (namespaceName && defaultName) {
		return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
	}
	if (namespaceName) return `const ${namespaceName} = await ${importCall};`;
	if (defaultName) return `const ${defaultName} = (await ${importCall}).default;`;
	return `await ${importCall};`;
}

function runtimeCallKind(node: BabelNode): "read" | undefined {
	if (node.type !== "CallExpression") return undefined;
	const callee = node.callee;
	if (!callee || typeof callee !== "object") return undefined;
	const calleeNode = callee as Record<string, unknown>;
	if (calleeNode.type !== "MemberExpression" || calleeNode.computed === true) return undefined;
	const object = calleeNode.object;
	const property = calleeNode.property;
	if (!object || typeof object !== "object" || !property || typeof property !== "object") return undefined;
	const objectNode = object as Record<string, unknown>;
	const propertyNode = property as Record<string, unknown>;
	return objectNode.type === "Identifier" &&
		objectNode.name === "tool" &&
		propertyNode.type === "Identifier" &&
		propertyNode.name === "read"
		? "read"
		: undefined;
}
function containsCallSiteUnsafeSyntax(value: unknown, root = true): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(item => containsCallSiteUnsafeSyntax(item, false));
	const node = value as Record<string, unknown>;
	const type = node.type;
	if (!root && typeof type === "string" && isExecutionBoundary(type)) return false;
	if (
		type === "CallExpression" &&
		typeof node.callee === "object" &&
		node.callee !== null &&
		(node.callee as Record<string, unknown>).type === "Identifier" &&
		(node.callee as Record<string, unknown>).name === "eval"
	) {
		return true;
	}
	if (type === "AwaitExpression" || type === "YieldExpression") return true;
	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		if (containsCallSiteUnsafeSyntax(node[key], false)) return true;
	}
	return false;
}

const CALL_SITE_HELPER = "__omp_with_call_site__";

function patternBindsCallSiteHelper(pattern: unknown): boolean {
	const names: string[] = [];
	collectBindingNames(pattern, names);
	return names.includes(CALL_SITE_HELPER);
}

function isCallSiteHelperIdentifier(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const node = value as Record<string, unknown>;
	return node.type === "Identifier" && node.name === CALL_SITE_HELPER;
}

// A bare textual mention of the helper (comment, string literal) must not suppress
// instrumentation — comments never reach the walker and string contents are not
// Identifier nodes. Only a real `__omp_with_call_site__(...)` call (already
// instrumented code, where wrapping again would double-count the site) or a real
// binding of the name (which would shadow the worker-injected helper, so fail
// closed) skips instrumentation.
export function containsCallSiteHelperSyntax(root: unknown): boolean {
	let found = false;
	walkNodes(root, node => {
		if (found) return;
		switch (node.type) {
			case "CallExpression":
				if (isCallSiteHelperIdentifier(node.callee)) found = true;
				break;
			case "VariableDeclarator":
				if (patternBindsCallSiteHelper(node.id)) found = true;
				break;
			case "FunctionDeclaration":
			case "FunctionExpression":
			case "ArrowFunctionExpression":
			case "ObjectMethod":
			case "ClassMethod":
			case "ClassPrivateMethod": {
				if (isCallSiteHelperIdentifier(node.id)) {
					found = true;
				} else if (Array.isArray(node.params)) {
					for (const param of node.params) {
						if (patternBindsCallSiteHelper(param)) {
							found = true;
							break;
						}
					}
				}
				break;
			}
			case "ClassDeclaration":
			case "ClassExpression":
			case "TSEnumDeclaration":
				if (isCallSiteHelperIdentifier(node.id)) found = true;
				break;
			case "ImportSpecifier":
			case "ImportDefaultSpecifier":
			case "ImportNamespaceSpecifier":
				if (isCallSiteHelperIdentifier(node.local)) found = true;
				break;
			case "CatchClause":
				if (patternBindsCallSiteHelper(node.param)) found = true;
				break;
			case "AssignmentExpression":
				if (patternBindsCallSiteHelper(node.left)) found = true;
				break;
			case "UpdateExpression":
				if (isCallSiteHelperIdentifier(node.argument)) found = true;
				break;
			case "ForInStatement":
			case "ForOfStatement": {
				const left = node.left;
				if (left && typeof left === "object" && "type" in left && left.type === "VariableDeclaration") {
					if ("declarations" in left && Array.isArray(left.declarations)) {
						for (const declaration of left.declarations) {
							if (
								declaration &&
								typeof declaration === "object" &&
								"id" in declaration &&
								patternBindsCallSiteHelper(declaration.id)
							) {
								found = true;
								break;
							}
						}
					}
				} else if (patternBindsCallSiteHelper(left)) {
					found = true;
				}
				break;
			}
			default:
				break;
		}
	});
	return found;
}

async function instrumentRuntimeCallSites(code: string): Promise<string> {
	if (!code.includes("tool")) return code;
	const ast = await parseProgram(code);
	if (!ast) return code;
	if (code.includes(CALL_SITE_HELPER) && containsCallSiteHelperSyntax(ast)) return code;
	const edits: Array<{ offset: number; text: string; closing: boolean }> = [];
	walkNodes(ast, node => {
		if (!runtimeCallKind(node)) return;
		if (containsCallSiteUnsafeSyntax(node)) return;
		edits.push({
			offset: node.start,
			text: `__omp_with_call_site__(${JSON.stringify(`js:${node.start}`)}, () => `,
			closing: false,
		});
		edits.push({ offset: node.end, text: ")", closing: true });
	});
	edits.sort((left, right) => right.offset - left.offset || Number(right.closing) - Number(left.closing));
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.offset) + edit.text + result.slice(edit.offset);
	}
	return result;
}

export async function rewriteImports(code: string): Promise<string> {
	if (!code.includes("import")) return code;

	const ast = await parseProgram(code);
	if (!ast) {
		// Parser bailed entirely — let the VM surface the real syntax error.
		return code;
	}

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	// Top-level static `import` declarations become `await __omp_import__(...)` calls.
	for (const node of ast.program.body) {
		if (node.type !== "ImportDeclaration") continue;
		const decl = node as unknown as BabelImportDeclaration;
		edits.push({ start: decl.start, end: decl.end, text: rewriteImportNode(decl) });
	}

	// Dynamic `import(...)` expressions (anywhere) get their callee swapped for `__omp_import__`
	// so the specifier resolves against the session cwd instead of the worker module's URL.
	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callee = call.callee;
		if (callee?.type !== "Import" || typeof callee.start !== "number" || typeof callee.end !== "number") return;
		edits.push({ start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE });
	});

	if (edits.length === 0) return code;

	// Splice from the back so earlier offsets stay valid.
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}
export async function collectModuleSourceSpecifiers(code: string): Promise<string[]> {
	const ast = await parseProgram(code);
	if (!ast) return [];
	const sources: string[] = [];
	for (const node of ast.program.body) {
		if (
			(node.type === "ImportDeclaration" ||
				node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration") &&
			typeof (node as BabelModuleSourceDeclaration).source?.value === "string"
		) {
			sources.push((node as BabelModuleSourceDeclaration).source!.value);
		}
	}
	return sources;
}

export async function rewriteModuleSourceSpecifiers(
	code: string,
	replacer: (source: string) => string,
): Promise<string> {
	const ast = await parseProgram(code);
	if (!ast) return code;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];

	for (const node of ast.program.body) {
		if (
			node.type !== "ImportDeclaration" &&
			node.type !== "ExportNamedDeclaration" &&
			node.type !== "ExportAllDeclaration"
		) {
			continue;
		}
		const source = (node as BabelModuleSourceDeclaration).source;
		if (!source || typeof source.value !== "string") continue;
		const next = replacer(source.value);
		if (next === source.value) continue;
		edits.push({ start: source.start, end: source.end, text: JSON.stringify(next) });
	}

	if (edits.length === 0) return code;
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

export async function rewriteDynamicImports(code: string, callee = "__omp_import__"): Promise<string> {
	if (!code.includes("import")) return code;
	const ast = await parseProgram(code);
	if (!ast) return code;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	walkNodes(ast, node => {
		if (node.type !== "CallExpression") return;
		const call = node as unknown as { callee?: { type?: string; start?: number; end?: number } };
		const callCallee = call.callee;
		if (callCallee?.type !== "Import" || typeof callCallee.start !== "number" || typeof callCallee.end !== "number") {
			return;
		}
		edits.push({ start: callCallee.start, end: callCallee.end, text: callee });
	});

	if (edits.length === 0) return code;
	edits.sort((a, b) => b.start - a.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	return result;
}

function collectBindingNames(pattern: unknown, names: string[]): void {
	if (!pattern || typeof pattern !== "object") return;
	const node = pattern as BabelBindingPattern & { parameter?: unknown };
	switch (node.type) {
		case "Identifier":
			if (typeof node.name === "string") names.push(node.name);
			return;
		case "ObjectPattern":
			for (const property of node.properties ?? []) collectBindingNames(property, names);
			return;
		case "ObjectProperty":
		case "Property":
			collectBindingNames(node.value, names);
			return;
		case "ArrayPattern":
			for (const element of node.elements ?? []) collectBindingNames(element, names);
			return;
		case "AssignmentPattern":
			collectBindingNames(node.left, names);
			return;
		case "RestElement":
			collectBindingNames(node.argument, names);
			return;
		case "TSParameterProperty":
			collectBindingNames(node.parameter, names);
			return;
		default:
			return;
	}
}

function getLexicalBindingNames(node: BabelPublishableDecl): string[] {
	const names: string[] = [];
	if (node.type === "VariableDeclaration") {
		for (const declaration of node.declarations ?? []) collectBindingNames(declaration.id, names);
	} else if (node.id) {
		names.push(node.id.name);
	}
	return names;
}

function renderGlobalVariableDeclaration(code: string, node: BabelVariableDeclaration): string {
	const statements: string[] = [];
	for (const declaration of node.declarations ?? []) {
		if (!declaration.init) continue;
		const target = code.slice(declaration.id.start, declaration.id.end);
		const value = code.slice(declaration.init.start, declaration.init.end);
		if (declaration.id.type === "Identifier" && typeof declaration.id.name === "string") {
			statements.push(`this[${JSON.stringify(declaration.id.name)}] = (${value});`);
		} else {
			statements.push(`(${target} = (${value}));`);
		}
	}
	return statements.join("\n");
}

function globalizeTopLevelDeclarations(
	code: string,
	ast: { program: { body: ReadonlyArray<BabelProgramNode> } },
	targets: ReadonlyArray<{ node: BabelPublishableDecl }>,
	bindingNames: readonly string[],
): string {
	const prelude = bindingNames.map(
		name => `if (!(${JSON.stringify(name)} in this)) this[${JSON.stringify(name)}] = undefined;`,
	);
	const functions: string[] = [];
	const edits: Array<{ start: number; end: number; replacement: string }> = [];
	for (const { node } of targets) {
		const segment = code.slice(node.start, node.end);
		if (node.type === "VariableDeclaration") {
			edits.push({ start: node.start, end: node.end, replacement: renderGlobalVariableDeclaration(code, node) });
			continue;
		}
		if (!node.id) continue;
		if (node.type === "FunctionDeclaration") {
			const idStart = node.id.start - node.start;
			const idEnd = node.id.end - node.start;
			const expression = segment.slice(0, idStart) + segment.slice(idEnd);
			functions.push(`this[${JSON.stringify(node.id.name)}] = (${expression});`);
			edits.push({ start: node.start, end: node.end, replacement: "" });
			continue;
		}
		edits.push({
			start: node.start,
			end: node.end,
			replacement: `this[${JSON.stringify(node.id.name)}] = (${segment});`,
		});
	}

	edits.sort((left, right) => right.start - left.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}

	let directiveEnd = 0;
	for (const node of ast.program.body) {
		if (node.type !== "ExpressionStatement" || typeof (node as BabelExpressionStatement).directive !== "string")
			break;
		directiveEnd = (node as BabelExpressionStatement).end;
	}
	const initialization = [...prelude, ...functions].join("\n");
	if (!initialization) return result;
	const separator = directiveEnd > 0 ? "\n" : "";
	return `${result.slice(0, directiveEnd)}${separator}${initialization}\n${result.slice(directiveEnd)}`;
}

function addBindingNames(pattern: unknown, names: Set<string>): void {
	const collected: string[] = [];
	collectBindingNames(pattern, collected);
	for (const name of collected) names.add(name);
}

function addDirectLexicalBindings(value: unknown, names: Set<string>): void {
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const node = item as Record<string, unknown>;
		if (node.type === "VariableDeclaration" && node.kind !== "var" && Array.isArray(node.declarations)) {
			for (const declaration of node.declarations) {
				if (declaration && typeof declaration === "object" && "id" in declaration) {
					addBindingNames(declaration.id, names);
				}
			}
		} else if (
			(node.type === "ClassDeclaration" || node.type === "FunctionDeclaration") &&
			node.id &&
			typeof node.id === "object"
		) {
			addBindingNames(node.id, names);
		}
	}
}

function withLexicalShadows(shadowed: ReadonlySet<string>, value: unknown): ReadonlySet<string> {
	const names = new Set(shadowed);
	addDirectLexicalBindings(value, names);
	return names;
}

function addFunctionScopedBindings(value: unknown, names: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) addFunctionScopedBindings(item, names);
		return;
	}
	const node = value as Record<string, unknown>;
	const type = node.type;
	if (typeof type !== "string") return;
	if (isExecutionBoundary(type)) {
		if (type === "FunctionDeclaration") addBindingNames(node.id, names);
		return;
	}
	if (type === "VariableDeclaration" && node.kind === "var" && Array.isArray(node.declarations)) {
		for (const declaration of node.declarations) {
			if (declaration && typeof declaration === "object" && "id" in declaration) {
				addBindingNames(declaration.id, names);
			}
		}
	}
	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		addFunctionScopedBindings(node[key], names);
	}
}

function collectBindingAssignmentEdits(
	value: unknown,
	tracked: ReadonlySet<string>,
	shadowed: ReadonlySet<string>,
	out: BindingAssignmentEdit[],
	parent?: BindingAssignmentEdit,
): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectBindingAssignmentEdits(item, tracked, shadowed, out, parent);
		return;
	}

	const node = value as Record<string, unknown>;
	const type = node.type;
	if (typeof type !== "string") return;

	if (isExecutionBoundary(type)) {
		const functionShadows = new Set(shadowed);
		if (Array.isArray(node.params)) {
			for (const param of node.params) addBindingNames(param, functionShadows);
		}
		if (type === "FunctionExpression") addBindingNames(node.id, functionShadows);
		addFunctionScopedBindings(node.body, functionShadows);
		collectBindingAssignmentEdits(node.body, tracked, functionShadows, out, parent);
		return;
	}
	if (type === "BlockStatement") {
		const blockShadows = withLexicalShadows(shadowed, node.body);
		collectBindingAssignmentEdits(node.body, tracked, blockShadows, out, parent);
		return;
	}
	if (type === "CatchClause") {
		const catchShadows = new Set(shadowed);
		addBindingNames(node.param, catchShadows);
		collectBindingAssignmentEdits(node.body, tracked, catchShadows, out, parent);
		return;
	}
	if (type === "ForStatement") {
		const loopShadows = new Set(shadowed);
		const init = node.init as Record<string, unknown> | undefined;
		if (init?.type === "VariableDeclaration" && init.kind !== "var" && Array.isArray(init.declarations)) {
			for (const declaration of init.declarations) {
				if (declaration && typeof declaration === "object" && "id" in declaration) {
					addBindingNames(declaration.id, loopShadows);
				}
			}
		}
		for (const key of ["init", "test", "update", "body"]) {
			collectBindingAssignmentEdits(node[key], tracked, loopShadows, out, parent);
		}
		return;
	}
	if (type === "ForInStatement" || type === "ForOfStatement") {
		const loopShadows = new Set(shadowed);
		const left = node.left as Record<string, unknown> | undefined;
		if (left?.type === "VariableDeclaration" && left.kind !== "var" && Array.isArray(left.declarations)) {
			for (const declaration of left.declarations) {
				if (declaration && typeof declaration === "object" && "id" in declaration) {
					addBindingNames(declaration.id, loopShadows);
				}
			}
		}
		for (const key of ["left", "right", "body"]) {
			collectBindingAssignmentEdits(node[key], tracked, loopShadows, out, parent);
		}
		return;
	}
	if (type === "SwitchStatement") {
		collectBindingAssignmentEdits(node.discriminant, tracked, shadowed, out, parent);
		const switchShadows = new Set(shadowed);
		if (Array.isArray(node.cases)) {
			for (const item of node.cases) {
				if (!item || typeof item !== "object") continue;
				const switchCase = item as Record<string, unknown>;
				addDirectLexicalBindings(switchCase.consequent, switchShadows);
			}
			for (const item of node.cases) {
				if (!item || typeof item !== "object") continue;
				const switchCase = item as Record<string, unknown>;
				collectBindingAssignmentEdits(switchCase.test, tracked, switchShadows, out, parent);
				collectBindingAssignmentEdits(switchCase.consequent, tracked, switchShadows, out, parent);
			}
		}
		return;
	}

	let currentParent = parent;
	if (type === "AssignmentExpression" || type === "UpdateExpression") {
		const assignment = node as unknown as BabelAssignmentNode;
		const assigned: string[] = [];
		collectBindingNames(type === "AssignmentExpression" ? assignment.left : assignment.argument, assigned);
		const names = [...new Set(assigned.filter(name => tracked.has(name) && !shadowed.has(name)))];
		if (names.length > 0) {
			const edit: BindingAssignmentEdit = {
				start: assignment.start,
				end: assignment.end,
				names,
				children: [],
			};
			if (parent) parent.children.push(edit);
			else out.push(edit);
			currentParent = edit;
		}
	}

	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		collectBindingAssignmentEdits(node[key], tracked, shadowed, out, currentParent);
	}
}

function uniqueInternalName(ast: unknown, base: string, used: Set<string>): string {
	if (used.size === 0) {
		walkNodes(ast, node => {
			if (node.type === "Identifier" && typeof node.name === "string") used.add(node.name);
		});
	}
	let name = base;
	let suffix = 2;
	while (used.has(name)) name = `${base}${suffix++}`;
	used.add(name);
	return name;
}

function renderBindingAssignmentEdit(
	code: string,
	edit: BindingAssignmentEdit,
	valueName: string,
	globalName: string,
): string {
	let expression = code.slice(edit.start, edit.end);
	const children = [...edit.children].sort((left, right) => right.start - left.start);
	for (const child of children) {
		const replacement = renderBindingAssignmentEdit(code, child, valueName, globalName);
		expression =
			expression.slice(0, child.start - edit.start) + replacement + expression.slice(child.end - edit.start);
	}
	const publications = edit.names.map(name => `${globalName}[${JSON.stringify(name)}] = ${name}`).join(", ");
	return `(${valueName} = (${expression}), ${publications}, ${valueName})`;
}

function instrumentBindingAssignments(
	code: string,
	ast: { program: { body: ReadonlyArray<BabelProgramNode> } },
	names: readonly string[],
): string {
	if (names.length === 0) return code;
	const edits: BindingAssignmentEdit[] = [];
	const tracked = new Set(names);
	for (const node of ast.program.body) {
		collectBindingAssignmentEdits(node, tracked, new Set(), edits);
	}
	if (edits.length === 0) return code;

	const used = new Set<string>();
	const valueName = uniqueInternalName(ast, "__omp_assignment_value__", used);
	const globalName = uniqueInternalName(ast, "__omp_assignment_global__", used);
	edits.sort((left, right) => right.start - left.start);
	let result = code;
	for (const assignment of edits) {
		const replacement = renderBindingAssignmentEdit(code, assignment, valueName, globalName);
		result = result.slice(0, assignment.start) + replacement + result.slice(assignment.end);
	}

	let directiveEnd = 0;
	for (const node of ast.program.body) {
		if (node.type !== "ExpressionStatement" || typeof (node as BabelExpressionStatement).directive !== "string")
			break;
		directiveEnd = (node as BabelExpressionStatement).end;
	}
	const declaration = `var ${valueName}, ${globalName} = this;`;
	const separator = directiveEnd > 0 ? "\n" : "";
	return `${result.slice(0, directiveEnd)}${separator}${declaration}\n${result.slice(directiveEnd)}`;
}

/**
 * Demote top-level `const`/`let`/`class` declarations to `var` so they persist on the
 * worker's globalThis across indirect `eval` calls. Indirect eval gives each call its own
 * lexical environment, so `const x = 1` in one cell would be invisible to the next.
 * `var` and function declarations are stored on the global object and survive across cells.
 *
 *   const x = 1;             -> var x = 1;
 *   let { a, b } = obj;      -> var { a, b } = obj;
 *   class Foo extends Bar {} -> var Foo = class extends Bar {};
 *
 * When the source must run inside the async wrapper (top-level `await`), local declarations
 * would die with the cell and published functions would keep closing over stale wrapper
 * variables. In that mode declarations become assignments on the wrapper's lexical `this`
 * (the worker global object), while function declarations are installed at wrapper entry to
 * preserve hoisting. Bare references — including references captured by persisted functions —
 * then resolve the same retained global binding that later cells update.
 *
 * Nested declarations (inside functions, blocks, classes) are left alone — they're
 * scoped to their enclosing function/block regardless of `var` vs `let`/`const`.
 */
async function demoteTopLevelLexicals(code: string, options: { publishGlobals?: boolean } = {}): Promise<string> {
	const publishGlobals = options.publishGlobals === true;
	const fastPath = publishGlobals ? /\b(?:const|let|class|var|function)\b/ : /\b(?:const|let|class)\b/;
	if (!fastPath.test(code)) return code;

	const ast = await parseProgram(code);
	if (!ast) {
		return code;
	}

	const targets: Array<{ node: BabelPublishableDecl; demote: boolean }> = [];
	for (const node of ast.program.body) {
		if (node.type === "VariableDeclaration") {
			const decl = node as unknown as BabelVariableDeclaration;
			if (decl.kind === "const" || decl.kind === "let") targets.push({ node: decl, demote: true });
			else if (publishGlobals) targets.push({ node: decl, demote: false });
		} else if (node.type === "ClassDeclaration") {
			const decl = node as unknown as BabelClassDeclaration;
			if (decl.id) targets.push({ node: decl, demote: true });
		} else if (publishGlobals && node.type === "FunctionDeclaration") {
			const decl = node as unknown as BabelFunctionDeclaration;
			if (decl.id) targets.push({ node: decl, demote: false });
		}
	}
	if (targets.length === 0) return code;

	const bindingNames = publishGlobals ? [...new Set(targets.flatMap(({ node }) => getLexicalBindingNames(node)))] : [];
	if (publishGlobals) {
		const globalized = globalizeTopLevelDeclarations(code, ast, targets, bindingNames);
		const globalizedAst = await parseProgram(globalized);
		return globalizedAst ? instrumentBindingAssignments(globalized, globalizedAst, bindingNames) : globalized;
	}

	targets.sort((a, b) => b.node.start - a.node.start);
	let result = code;
	for (const { node, demote } of targets) {
		const segment = result.slice(node.start, node.end);
		let replacement: string;
		if (!demote) {
			replacement = segment;
		} else if (node.type === "VariableDeclaration") {
			replacement = `var${segment.slice(node.kind.length)}`;
		} else {
			const id = node.id;
			if (!id) continue;
			const idEndInSegment = id.end - node.start;
			const tail = segment.slice(idEndInSegment);
			const hasTrailingSemi = segment.endsWith(";");
			replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
		}
		result = result.slice(0, node.start) + replacement + result.slice(node.end);
	}
	return result;
}

async function returnFinalExpression(code: string): Promise<{ source: string; returned: boolean }> {
	const ast = await parseProgram(code);
	const body = ast?.program.body;
	if (!body) return { source: code, returned: false };
	let lastIndex = body.length - 1;
	while (lastIndex >= 0 && body[lastIndex]?.type === "EmptyStatement") lastIndex--;
	const last = lastIndex >= 0 ? body[lastIndex] : undefined;
	if (last?.type === "ExpressionStatement") {
		const expression = last as BabelExpressionStatement;
		const prefix = code.slice(0, expression.start);
		const statement = code.slice(expression.start, expression.end);
		const suffix = code.slice(expression.end);
		const semicolonMatch = statement.match(/;\s*$/);
		const trimmedStatement = semicolonMatch ? statement.slice(0, semicolonMatch.index) : statement;
		return { source: `${prefix}__omp_set_final_expr__((${trimmedStatement}));${suffix}`, returned: true };
	}
	if (last?.type === "ReturnStatement") {
		// Top-level `return value;` is otherwise swallowed: it forces the cell into an async IIFE
		// wrapper that discards the returned value. Rewrite into `__omp_set_final_expr__((expr))`
		// so the runtime can surface the value to the caller just like a trailing expression.
		const ret = last as unknown as { start: number; end: number; argument?: { start: number; end: number } | null };
		if (!ret.argument) return { source: code, returned: false };
		const prefix = code.slice(0, ret.start);
		const suffix = code.slice(ret.end);
		const expr = code.slice(ret.argument.start, ret.argument.end);
		return { source: `${prefix}__omp_set_final_expr__((${expr}));${suffix}`, returned: true };
	}
	return { source: code, returned: false };
}

function isExecutionBoundary(type: string): boolean {
	return (
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "ObjectMethod" ||
		type === "ClassMethod" ||
		type === "ClassPrivateMethod" ||
		type === "PrivateMethod"
	);
}

function containsAsyncWrapperSyntax(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsAsyncWrapperSyntax(item)) return true;
		}
		return false;
	}

	const node = value as Record<string, unknown>;
	const type = node.type;
	if (type === "ReturnStatement" || type === "AwaitExpression") return true;
	if (type === "ForOfStatement" && node.await === true) return true;
	if (typeof type === "string" && isExecutionBoundary(type)) return false;

	for (const key in node) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
		if (containsAsyncWrapperSyntax(node[key])) return true;
	}
	return false;
}

async function requiresAsyncWrapper(code: string): Promise<boolean> {
	const ast = await parseProgram(code);
	if (!ast) return false;
	for (const node of ast.program.body) {
		if (containsAsyncWrapperSyntax(node)) return true;
	}
	return false;
}

/**
 * Strip TypeScript syntax (type annotations, type-only imports/exports, `interface`, `as`,
 * `satisfies`, generics in call expressions, etc.) before the import/lexical rewriters parse
 * the code. Bun's native transpiler preserves `import`/`export` declarations, so downstream
 * Babel rewrites still control module resolution.
 *
 * Eval cells use a cheap "looks like TS" heuristic to avoid transpiling ordinary JS. Known
 * TypeScript modules pass `force` because a file can contain TS-only module syntax such as
 * `import type` without any value-level type annotations.
 */
type TypeScriptStripLoader = "ts" | "tsx";

const TS_TRANSPILER = new Bun.Transpiler({ loader: "ts" });
const TSX_TRANSPILER = new Bun.Transpiler({ loader: "tsx" });

function stripTypeScript(code: string, options: { force?: boolean; loader?: TypeScriptStripLoader } = {}): string {
	if (!options.force && !LOOKS_LIKE_TS.test(code)) return code;
	try {
		const transpiler = options.loader === "tsx" ? TSX_TRANSPILER : TS_TRANSPILER;
		return transpiler.transformSync(code);
	} catch {
		// Transpiler failed (e.g. unrecoverable syntax). Hand the original source back so the
		// downstream rewriter / VM surfaces the real error to the user.
		return code;
	}
}
export function stripTypeScriptSyntax(
	code: string,
	options: { force?: boolean; loader?: TypeScriptStripLoader } = {},
): string {
	return stripTypeScript(code, options);
}

// Heuristic: obvious TS-only tokens, including type-only module syntax. Plain JS using `as`
// only inside strings won't match because we require a leading word boundary plus a
// colon/keyword neighbor.
const LOOKS_LIKE_TS =
	/(?:\bimport\s+type\b|\bexport\s+type\b|\b(?:import|export)\s*\{[^}\n]*\btype\s+\w|\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;

export async function wrapCode(
	code: string,
): Promise<{ source: string; asyncWrapped: boolean; finalExpressionReturned: boolean }> {
	const instrumented = await instrumentRuntimeCallSites(code);
	const finalExpression = await returnFinalExpression(instrumented);
	const stripped = stripTypeScript(finalExpression.source);
	const importsRewritten = await rewriteImports(stripped);
	const needsAsyncWrapper = await requiresAsyncWrapper(importsRewritten);
	const rewritten = {
		source: await demoteTopLevelLexicals(importsRewritten, { publishGlobals: needsAsyncWrapper }),
		returned: finalExpression.returned,
	};
	if (!needsAsyncWrapper) {
		return { source: rewritten.source, asyncWrapped: false, finalExpressionReturned: rewritten.returned };
	}
	return {
		source: `(async () => {\n${rewritten.source}\n})()`,
		asyncWrapped: true,
		finalExpressionReturned: rewritten.returned,
	};
}
