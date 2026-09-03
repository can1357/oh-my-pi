// oxlint-disable-next-line typescript/triple-slash-reference -- legacy virtual module declarations.
/// <reference path="./legacy-pi-virtual-modules.d.ts" />

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import type { ParseResult, ParserPlugin } from "@babel/parser";
import { parse as parseBabel } from "@babel/parser";
import {
	getDbBusyTimeoutMs,
	getLegacyPiExtensionCacheDbPath,
	isCompiledBinary,
	logger,
	stripWindowsExtendedLengthPathPrefix,
} from "@oh-my-pi/pi-utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";

const IS_COMPILED_BINARY = isCompiledBinary();

// === Bundled host modules (issue #3423) ===
//
// Bun 1.3.14 stopped exposing `--compile` extras through any filesystem-style
// API: `fs.existsSync`, `Bun.file().exists()`, `Bun.resolveSync`, and even
// `import("/$bunfs/...")` / `import("file:///$bunfs/...")` all fail for the
// embedded entries. Bun.plugin `onResolve` also no longer fires for transitive
// imports inside runtime-loaded extensions.
//
// Compiled builds retain lazy loaders for host packages and serve requested
// surfaces through `omp-legacy-pi-bundled:<key>` synthetic modules.
// `scripts/legacy-pi-virtual-module.ts` derives literal dynamic-import edges
// from current package exports inside a Bun build plugin: no generated source
// or duplicate key list exists on disk. Deferring each host module evaluation
// avoids cycles with an extension-loading command that is itself in the
// retained package graph.
const BUNDLED_VIRTUAL_SCHEME = "omp-legacy-pi-bundled:";
const BUNDLED_VIRTUAL_NAMESPACE = "omp-legacy-pi-bundled";
const BUNDLED_MODULES_GLOBAL = "__ompLegacyPiBundledModules";
const TYPEBOX_BUNDLED_MODULE_KEY = "typebox";

type BundledModule = Readonly<Record<string, unknown>>;
type BundledModules = Readonly<Record<string, BundledModule>>;
type BundledModuleLoaders = Readonly<Record<string, () => Promise<BundledModule>>>;

interface LegacyPiResolveResult {
	path: string;
	namespace?: string;
}

interface BundledVirtualResolveResult {
	path: string;
	namespace: typeof BUNDLED_VIRTUAL_NAMESPACE;
}

interface ExtensionSpecifierReference {
	readonly kind: "import" | "require";
	readonly specifier: string;
	readonly start: number;
	readonly end: number;
}

function parseExtensionSource(source: string, importerPath: string): ParseResult {
	const extension = path.extname(importerPath).toLowerCase();
	const plugins: ParserPlugin[] = ["decorators-legacy", "explicitResourceManagement"];
	if (extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".tsx") {
		plugins.push("typescript");
	}
	if (extension === ".jsx" || extension === ".tsx") {
		plugins.push("jsx");
	}

	try {
		return parseBabel(source, {
			sourceType: "unambiguous",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins,
		});
	} catch (error) {
		throw new Error(
			`Failed to parse extension source for dependency rewriting: ${importerPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

const REQUIRE_BINDING = 1 << 0;
const OBJECT_BINDING = 1 << 1;
const EXPORTS_BINDING = 1 << 2;
const MODULE_BINDING = 1 << 3;

interface StructuralAstNode {
	readonly type: string;
	readonly [key: string]: unknown;
}

interface BindingScope {
	readonly parent: BindingScope | null;
	readonly ownsVarBindings: boolean;
	bindings: number;
}

interface ScopedAstNode {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope;
	readonly order: number;
}

interface ScopeWalkItem {
	readonly node: StructuralAstNode;
	readonly scope: BindingScope | null;
	readonly parent: StructuralAstNode | null;
	readonly parentKey: string | null;
}

function asAstNode(value: unknown): StructuralAstNode | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as { readonly type?: unknown };
	return typeof candidate.type === "string" ? (candidate as StructuralAstNode) : null;
}

function nodeArray(node: StructuralAstNode, key: string): readonly unknown[] | null {
	const value = node[key];
	return Array.isArray(value) ? value : null;
}

function nodeArgument(node: StructuralAstNode | null, index: number): StructuralAstNode | null {
	if (!node) return null;
	const values = nodeArray(node, "arguments");
	return values ? asAstNode(values[index]) : null;
}

function isIdentifier(node: StructuralAstNode | null, name: string): boolean {
	return node?.type === "Identifier" && node.name === name;
}

function trackedBinding(name: unknown): number {
	switch (name) {
		case "require":
			return REQUIRE_BINDING;
		case "Object":
			return OBJECT_BINDING;
		case "exports":
			return EXPORTS_BINDING;
		case "module":
			return MODULE_BINDING;
		default:
			return 0;
	}
}

function addPatternBindings(scope: BindingScope, pattern: unknown): void {
	const stack: unknown[] = [pattern];
	while (stack.length > 0) {
		const node = asAstNode(stack.pop());
		if (!node) continue;
		switch (node.type) {
			case "Identifier":
				scope.bindings |= trackedBinding(node.name);
				break;
			case "AssignmentPattern":
				stack.push(node.left);
				break;
			case "RestElement":
				stack.push(node.argument);
				break;
			case "ArrayPattern": {
				const elements = nodeArray(node, "elements");
				if (elements) stack.push(...elements);
				break;
			}
			case "ObjectPattern": {
				const properties = nodeArray(node, "properties");
				if (!properties) break;
				for (const value of properties) {
					const property = asAstNode(value);
					if (!property) continue;
					stack.push(property.type === "RestElement" ? property.argument : property.value);
				}
				break;
			}
			case "TSParameterProperty":
				stack.push(node.parameter);
				break;
		}
	}
}

function isFunctionScopeNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ObjectMethod":
		case "ClassMethod":
		case "ClassPrivateMethod":
		case "TSDeclareFunction":
		case "TSDeclareMethod":
		case "DeclareFunction":
			return true;
		default:
			return false;
	}
}

function isFunctionDeclarationNode(node: StructuralAstNode): boolean {
	return node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction" || node.type === "DeclareFunction";
}

function isClassScopeNode(node: StructuralAstNode): boolean {
	return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function scopeKind(node: StructuralAstNode, parent: StructuralAstNode | null, parentKey: string | null): 0 | 1 | 2 {
	if (
		node.type === "Program" ||
		isFunctionScopeNode(node) ||
		node.type === "StaticBlock" ||
		node.type === "TSModuleBlock"
	) {
		return 2;
	}
	if (
		isClassScopeNode(node) ||
		node.type === "CatchClause" ||
		node.type === "ForStatement" ||
		node.type === "ForInStatement" ||
		node.type === "ForOfStatement" ||
		node.type === "SwitchStatement"
	) {
		return 1;
	}
	if (node.type === "BlockStatement" && !(parent && isFunctionScopeNode(parent) && parentKey === "body")) {
		return 1;
	}
	return 0;
}

function nearestVarScope(scope: BindingScope): BindingScope {
	let current = scope;
	while (!current.ownsVarBindings && current.parent) current = current.parent;
	return current;
}

function registerOuterDeclaration(node: StructuralAstNode, scope: BindingScope | null): void {
	if (!scope) return;
	if (
		(isFunctionDeclarationNode(node) && node.type !== "TSDeclareFunction" && node.type !== "DeclareFunction") ||
		(node.type === "ClassDeclaration" && node.declare !== true)
	) {
		addPatternBindings(scope, node.id);
	}
}

function registerScopeBindings(node: StructuralAstNode, scope: BindingScope): void {
	if (isFunctionScopeNode(node)) {
		addPatternBindings(scope, node.id);
		const parameters = nodeArray(node, "params");
		if (parameters) {
			for (const parameter of parameters) addPatternBindings(scope, parameter);
		}
	}
	if (isClassScopeNode(node)) addPatternBindings(scope, node.id);
	if (node.type === "CatchClause") addPatternBindings(scope, node.param);

	if (node.type === "ImportDeclaration") {
		const specifiers = nodeArray(node, "specifiers");
		if (specifiers) {
			for (const value of specifiers) {
				const specifier = asAstNode(value);
				if (specifier) addPatternBindings(scope, specifier.local);
			}
		}
	} else if (node.type === "TSImportEqualsDeclaration") {
		addPatternBindings(scope, node.id);
	} else if (node.type === "VariableDeclaration") {
		const target = node.kind === "var" ? nearestVarScope(scope) : scope;
		const declarations = nodeArray(node, "declarations");
		if (declarations) {
			for (const value of declarations) {
				const declaration = asAstNode(value);
				if (declaration) addPatternBindings(target, declaration.id);
			}
		}
	}
}

function isAstMetadataKey(key: string): boolean {
	switch (key) {
		case "loc":
		case "extra":
		case "range":
		case "comments":
		case "tokens":
		case "errors":
		case "leadingComments":
		case "trailingComments":
		case "innerComments":
		case "parent":
		case "parentPath":
		case "scope":
		case "hub":
			return true;
		default:
			return false;
	}
}

function scopeForChild(
	node: StructuralAstNode,
	key: string,
	outerScope: BindingScope | null,
	nodeScope: BindingScope,
): BindingScope {
	if (node.type === "SwitchStatement" && key === "discriminant") {
		return outerScope ?? nodeScope;
	}
	if (isFunctionScopeNode(node) && (key === "key" || key === "decorators")) {
		return outerScope ?? nodeScope;
	}
	if (isClassScopeNode(node) && key === "decorators") {
		return outerScope ?? nodeScope;
	}
	return nodeScope;
}

/**
 * Builds only the lexical information needed by legacy extension rewriting.
 * Scope frames are fully populated before selected nodes are returned, so
 * hoisted and TDZ bindings behave independently of textual declaration order.
 */
function collectScopedAstNodes(root: unknown, select: (node: StructuralAstNode) => boolean): ScopedAstNode[] {
	const rootNode = asAstNode(root);
	if (!rootNode) return [];

	const selected: ScopedAstNode[] = [];
	const stack: ScopeWalkItem[] = [{ node: rootNode, scope: null, parent: null, parentKey: null }];
	const seen = new WeakSet<object>();
	let order = 0;
	while (stack.length > 0) {
		const item = stack.pop();
		if (!item || seen.has(item.node)) continue;
		seen.add(item.node);

		registerOuterDeclaration(item.node, item.scope);
		const kind = scopeKind(item.node, item.parent, item.parentKey);
		const activeScope: BindingScope | null =
			kind === 0
				? item.scope
				: {
						parent: item.scope,
						ownsVarBindings: kind === 2,
						bindings: 0,
					};
		if (activeScope) {
			registerScopeBindings(item.node, activeScope);
			if (select(item.node)) selected.push({ node: item.node, scope: activeScope, order });
		}
		order++;

		for (const key in item.node) {
			if (isAstMetadataKey(key)) continue;
			const childScope = activeScope ? scopeForChild(item.node, key, item.scope, activeScope) : null;
			const value = item.node[key];
			if (Array.isArray(value)) {
				for (const element of value) {
					const child = asAstNode(element);
					if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
				}
			} else {
				const child = asAstNode(value);
				if (child) stack.push({ node: child, scope: childScope, parent: item.node, parentKey: key });
			}
		}
	}

	selected.sort((left, right) => {
		const leftStart = typeof left.node.start === "number" ? left.node.start : Number.MAX_SAFE_INTEGER;
		const rightStart = typeof right.node.start === "number" ? right.node.start : Number.MAX_SAFE_INTEGER;
		return leftStart - rightStart || left.order - right.order;
	});
	return selected;
}

function scopeHasBinding(scope: BindingScope, binding: number): boolean {
	let current: BindingScope | null = scope;
	while (current) {
		if ((current.bindings & binding) !== 0) return true;
		current = current.parent;
	}
	return false;
}

function isSpecifierReferenceNode(node: StructuralAstNode): boolean {
	switch (node.type) {
		case "ImportDeclaration":
		case "ExportNamedDeclaration":
		case "ExportAllDeclaration":
		case "ImportExpression":
		case "TSImportEqualsDeclaration":
		case "CallExpression":
			return true;
		default:
			return false;
	}
}

function isUncomputedMember(node: StructuralAstNode | null, objectName: string, propertyName: string): boolean {
	if (node?.type !== "MemberExpression" || node.computed === true) return false;
	return isIdentifier(asAstNode(node.object), objectName) && isIdentifier(asAstNode(node.property), propertyName);
}

function isUnshadowedExportsTarget(node: StructuralAstNode | null, scope: BindingScope): boolean {
	return (
		(isIdentifier(node, "exports") && !scopeHasBinding(scope, EXPORTS_BINDING)) ||
		(isUncomputedMember(node, "module", "exports") && !scopeHasBinding(scope, MODULE_BINDING))
	);
}

function isGlobalRequireCall(node: StructuralAstNode | null, scope: BindingScope): boolean {
	return (
		node?.type === "CallExpression" &&
		isIdentifier(asAstNode(node.callee), "require") &&
		!scopeHasBinding(scope, REQUIRE_BINDING)
	);
}

/**
 * Whether `node` is a `createRequire(...)` factory call imported from
 * `node:module` (or its `module` alias).
 */
function isCreateRequireInvocation(
	node: StructuralAstNode | null,
	createRequireBindings: ReadonlySet<string>,
	moduleNamespaceBindings: ReadonlySet<string>,
): boolean {
	if (node?.type !== "CallExpression") return false;
	const callee = asAstNode(node.callee);
	if (callee?.type === "Identifier" && typeof callee.name === "string") {
		return createRequireBindings.has(callee.name);
	}
	if (callee?.type !== "MemberExpression" || staticMemberPropertyName(callee) !== "createRequire") return false;
	const object = asAstNode(callee.object);
	return object?.type === "Identifier" && typeof object.name === "string" && moduleNamespaceBindings.has(object.name);
}

function staticMemberPropertyName(node: StructuralAstNode): string | null {
	const property = asAstNode(node.property);
	if (node.computed !== true && property?.type === "Identifier" && typeof property.name === "string") {
		return property.name;
	}
	if (node.computed === true && property?.type === "StringLiteral" && typeof property.value === "string") {
		return property.value;
	}
	return null;
}

function staticObjectPropertyName(node: StructuralAstNode): string | null {
	if (node.computed === true) return null;
	const key = asAstNode(node.key);
	if (key?.type === "Identifier" && typeof key.name === "string") return key.name;
	return key?.type === "StringLiteral" && typeof key.value === "string" ? key.value : null;
}

function collectExtensionSpecifierReferences(
	source: string,
	importerPath: string,
	ast: ParseResult = parseExtensionSource(source, importerPath),
): ExtensionSpecifierReference[] {
	const references: ExtensionSpecifierReference[] = [];
	const record = (kind: ExtensionSpecifierReference["kind"], literal: unknown): void => {
		const node = asAstNode(literal);
		if (
			node?.type === "StringLiteral" &&
			typeof node.value === "string" &&
			typeof node.start === "number" &&
			typeof node.end === "number"
		) {
			references.push({ kind, specifier: node.value, start: node.start, end: node.end });
		}
	};
	const createRequireBindings = new Set<string>();
	const moduleNamespaceBindings = new Set<string>();
	for (const { node } of collectScopedAstNodes(ast, candidate => candidate.type === "ImportDeclaration")) {
		const source = asAstNode(node.source);
		if (source?.type !== "StringLiteral" || (source.value !== "node:module" && source.value !== "module")) continue;
		for (const value of Array.isArray(node.specifiers) ? node.specifiers : []) {
			const specifier = asAstNode(value);
			const local = asAstNode(specifier?.local);
			if (local?.type !== "Identifier" || typeof local.name !== "string") continue;
			if (specifier?.type === "ImportNamespaceSpecifier") {
				moduleNamespaceBindings.add(local.name);
			} else if (specifier?.type === "ImportSpecifier") {
				const imported = asAstNode(specifier.imported);
				if (
					(imported?.type === "Identifier" && imported.name === "createRequire") ||
					(imported?.type === "StringLiteral" && imported.value === "createRequire")
				) {
					createRequireBindings.add(local.name);
				}
			}
		}
	}
	for (const { node, scope } of collectScopedAstNodes(ast, isSpecifierReferenceNode)) {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration"
		) {
			record("import", node.source);
		} else if (node.type === "ImportExpression") {
			record("import", node.source);
		} else if (node.type === "TSImportEqualsDeclaration") {
			const moduleReference = asAstNode(node.moduleReference);
			if (moduleReference?.type === "TSExternalModuleReference") {
				record("require", moduleReference.expression);
			}
		} else if (node.type === "CallExpression") {
			const callee = asAstNode(node.callee);
			if (callee?.type === "Import") {
				record("import", nodeArgument(node, 0));
			} else if (isIdentifier(callee, "require") && !scopeHasBinding(scope, REQUIRE_BINDING)) {
				record("require", nodeArgument(node, 0));
			} else if (isCreateRequireInvocation(callee, createRequireBindings, moduleNamespaceBindings)) {
				// `createRequire(base)(spec)` — pin the invoked bare dependency so it
				// loads without a runtime `node_modules` lookup. Relative specifiers
				// resolve against `base`, which is not rewritten, so restrict to bare.
				const argument = nodeArgument(node, 0);
				if (
					argument?.type === "StringLiteral" &&
					typeof argument.value === "string" &&
					isBareExtensionDependencySpecifier(argument.value)
				) {
					record("require", argument);
				}
			}
		}
	}
	return references;
}

const EXTENSION_PARSE_CACHE_SCHEMA_VERSION = 1;
const EXTENSION_PARSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const EXTENSION_PARSE_CACHE_MAX_ENTRIES = 10_000;

interface ExtensionSourceAnalysis {
	readonly sourceType: "script" | "module";
	readonly references: readonly ExtensionSpecifierReference[];
	readonly commonJsNamedExports: readonly string[];
	readonly commonJsReexportSpecifiers: readonly string[];
}

interface ExtensionParseCacheRow {
	source_type: "script" | "module";
	references: string;
	commonjs_named_exports: string;
	commonjs_reexport_specifiers: string;
}

let extensionParseCacheDb: Database | null | undefined;
const extensionSourceAnalysisCache = new Map<string, ExtensionSourceAnalysis>();

function extensionParseCacheKey(source: string, importerPath: string): string {
	return `${EXTENSION_PARSE_CACHE_SCHEMA_VERSION}:${path.extname(importerPath).toLowerCase()}:${Bun.hash(source).toString(16)}`;
}

function getExtensionParseCacheDb(): Database | null {
	if (extensionParseCacheDb !== undefined) return extensionParseCacheDb;
	try {
		const cachePath = getLegacyPiExtensionCacheDbPath();
		try {
			if (fs.statSync(cachePath).size > EXTENSION_PARSE_CACHE_MAX_BYTES) {
				// Remove the full WAL set, not just the main db. A leftover
				// `-wal`/`-shm` pair still owned by a concurrent omp process is
				// adopted by this fresh connection; when that `-wal` has
				// uncheckpointed frames (the normal case while another omp is
				// writing its own cache entries), `journal_mode=WAL` fails with
				// SQLITE_IOERR — disabling the parse cache for the whole process
				// and forcing a reparse of every extension on startup. See #9549.
				for (const suffix of ["", "-wal", "-shm"]) {
					fs.rmSync(`${cachePath}${suffix}`, { force: true });
				}
			}
		} catch {
			// A missing or unreadable cache is a cold cache.
		}
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		const db = new Database(cachePath, { create: true });
		// Install the busy handler BEFORE any lock-taking statement (incl.
		// `PRAGMA journal_mode=WAL`, which takes an exclusive lock during WAL
		// recovery). See #2421. WAL + synchronous=NORMAL avoids the per-entry
		// journal create/delete + fsync churn that serialized this cache behind
		// concurrent omp startups and blocked the event loop for ~20s (#9549).
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run("PRAGMA journal_mode=WAL");
		db.run("PRAGMA synchronous=NORMAL");
		db.run(
			"CREATE TABLE IF NOT EXISTS extension_parse_cache (cache_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, [references] TEXT NOT NULL, commonjs_named_exports TEXT NOT NULL, commonjs_reexport_specifiers TEXT NOT NULL)",
		);
		extensionParseCacheDb = db;
		return db;
	} catch (error) {
		logger.debug("legacy Pi extension parse cache unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		extensionParseCacheDb = null;
		return null;
	}
}

/**
 * Test seam: whether the extension parse cache opened successfully. Exercises
 * the real eviction + open path, including full WAL-set cleanup on oversized
 * caches (#9549).
 */
export function __isExtensionParseCacheAvailableForTests(): boolean {
	return getExtensionParseCacheDb() !== null;
}

function parseCachedAnalysis(row: ExtensionParseCacheRow): ExtensionSourceAnalysis | null {
	try {
		if (row.source_type !== "script" && row.source_type !== "module") return null;
		const references = JSON.parse(row.references) as unknown;
		const commonJsNamedExports = JSON.parse(row.commonjs_named_exports) as unknown;
		const commonJsReexportSpecifiers = JSON.parse(row.commonjs_reexport_specifiers) as unknown;
		if (
			!Array.isArray(references) ||
			!references.every(
				reference =>
					reference &&
					typeof reference === "object" &&
					(reference.kind === "import" || reference.kind === "require") &&
					typeof reference.specifier === "string" &&
					typeof reference.start === "number" &&
					typeof reference.end === "number",
			) ||
			!Array.isArray(commonJsNamedExports) ||
			!commonJsNamedExports.every(name => typeof name === "string") ||
			!Array.isArray(commonJsReexportSpecifiers) ||
			!commonJsReexportSpecifiers.every(specifier => typeof specifier === "string")
		) {
			return null;
		}
		return {
			sourceType: row.source_type,
			references: references as ExtensionSpecifierReference[],
			commonJsNamedExports,
			commonJsReexportSpecifiers,
		};
	} catch {
		return null;
	}
}

function writeExtensionSourceAnalysis(cacheKey: string, analysis: ExtensionSourceAnalysis): void {
	void Promise.resolve()
		.then(() => {
			const db = getExtensionParseCacheDb();
			if (!db) return;
			db.run(
				"INSERT OR REPLACE INTO extension_parse_cache (cache_key, source_type, [references], commonjs_named_exports, commonjs_reexport_specifiers) VALUES (?, ?, ?, ?, ?)",
				[
					cacheKey,
					analysis.sourceType,
					JSON.stringify(analysis.references),
					JSON.stringify(analysis.commonJsNamedExports),
					JSON.stringify(analysis.commonJsReexportSpecifiers),
				],
			);
			const count =
				db.query<{ count: number }, []>("SELECT count(*) AS count FROM extension_parse_cache").get()?.count ?? 0;
			if (count > EXTENSION_PARSE_CACHE_MAX_ENTRIES) {
				db.run("DELETE FROM extension_parse_cache");
			}
		})
		.catch(error => {
			logger.debug("legacy Pi extension parse cache write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

function getExtensionSourceAnalysis(source: string, importerPath: string): ExtensionSourceAnalysis {
	const cacheKey = extensionParseCacheKey(source, importerPath);
	const memoryCached = extensionSourceAnalysisCache.get(cacheKey);
	if (memoryCached) return memoryCached;

	const db = getExtensionParseCacheDb();
	try {
		const row = db
			?.query<ExtensionParseCacheRow, [string]>(
				"SELECT source_type, [references], commonjs_named_exports, commonjs_reexport_specifiers FROM extension_parse_cache WHERE cache_key = ?",
			)
			.get(cacheKey);
		if (row) {
			const cached = parseCachedAnalysis(row);
			if (cached) {
				extensionSourceAnalysisCache.set(cacheKey, cached);
				return cached;
			}
		}
	} catch (error) {
		logger.debug("legacy Pi extension parse cache read failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const ast = parseExtensionSource(source, importerPath);
	const commonJs = collectCommonJsExportAnalysis(ast);
	const analysis: ExtensionSourceAnalysis = {
		sourceType: ast.program.sourceType,
		references: collectExtensionSpecifierReferences(source, importerPath, ast),
		...commonJs,
	};
	extensionSourceAnalysisCache.set(cacheKey, analysis);
	writeExtensionSourceAnalysis(cacheKey, analysis);
	return analysis;
}

function applySpecifierReplacements(
	source: string,
	replacements: ReadonlyArray<ExtensionSpecifierReference & { readonly replacement: string }>,
): string {
	let rewritten = source;
	for (const reference of [...replacements].sort((left, right) => right.start - left.start)) {
		rewritten = `${rewritten.slice(0, reference.start)}${JSON.stringify(reference.replacement)}${rewritten.slice(reference.end)}`;
	}
	return rewritten;
}

const loadedBundledModules: Record<string, BundledModule> = {};
let bundledModuleLoadersPromise: Promise<BundledModuleLoaders> | null = null;

/**
 * Load the build-supplied module registry without evaluating its host modules.
 *
 * `globalThis` bridges the synthetic ES modules, which cannot close over this
 * file's lexical scope. Dev/test runs never execute the conditional import;
 * binary builds resolve it through the in-memory build plugin.
 */
function ensureBundledModuleLoadersLoaded(): Promise<BundledModuleLoaders> {
	if (!IS_COMPILED_BINARY) {
		return Promise.reject(new Error("omp:legacy-pi-shim: bundled modules are only available in compiled mode"));
	}
	if (!bundledModuleLoadersPromise) {
		bundledModuleLoadersPromise = import("omp-legacy-pi-modules").then(module => {
			Reflect.set(globalThis, BUNDLED_MODULES_GLOBAL, loadedBundledModules);
			return module.BUNDLED_PI_MODULE_LOADERS;
		});
	}
	return bundledModuleLoadersPromise;
}

async function loadBundledModule(moduleKey: string): Promise<void> {
	const loaders = await ensureBundledModuleLoadersLoaded();
	const loader = loaders[moduleKey];
	if (!loader) {
		throw new Error(`omp:legacy-pi-shim: no bundled module registered for ${moduleKey}`);
	}
	loadedBundledModules[moduleKey] = await loader();
}

function bundledModuleVirtualSpecifier(moduleKey: string): string {
	return `${BUNDLED_VIRTUAL_SCHEME}${moduleKey}`;
}

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(BUNDLED_VIRTUAL_SCHEME);
}

function toLegacyPiResolveResult(resolvedPath: string): LegacyPiResolveResult {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		const registryKey = resolvedPath.slice(BUNDLED_VIRTUAL_SCHEME.length);
		return { path: registryKey, namespace: BUNDLED_VIRTUAL_NAMESPACE };
	}
	return { path: resolvedPath };
}

/** Maps a bundled virtual specifier or registry key to Bun's plugin namespace shape. */
export function resolveBundledVirtualSpecifier(specifier: string): BundledVirtualResolveResult {
	const registryKey = isBundledVirtualSpecifier(specifier)
		? specifier.slice(BUNDLED_VIRTUAL_SCHEME.length)
		: specifier;
	if (!registryKey) {
		throw new Error("omp:legacy-pi-shim: bundled virtual specifier has no registry key");
	}
	return { path: registryKey, namespace: BUNDLED_VIRTUAL_NAMESPACE };
}

/**
 * Build a synthetic ES module for one live bundled namespace. Every export
 * reads through the global bridge; no bunfs path or copied package is involved.
 */
function synthesizeBundledModuleSourceFromModules(moduleKey: string, modules: BundledModules): string {
	const mod = modules[moduleKey];
	if (!mod) {
		throw new Error(`omp:legacy-pi-shim: no bundled module registered for ${moduleKey}`);
	}
	const lines: string[] = [
		`const __omp_bundled = globalThis[${JSON.stringify(BUNDLED_MODULES_GLOBAL)}][${JSON.stringify(moduleKey)}];`,
	];
	let hasDefault = false;
	for (const exportName in mod) {
		if (exportName === "default") {
			hasDefault = true;
			continue;
		}
		lines.push(`export const ${exportName} = __omp_bundled[${JSON.stringify(exportName)}];`);
	}
	if (hasDefault) {
		lines.push("export default __omp_bundled.default;");
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Build the synthetic source served for one
 * `omp-legacy-pi-bundled:<key>` import.
 */
async function synthesizeBundledModuleSource(moduleKey: string): Promise<string> {
	await loadBundledModule(moduleKey);
	return synthesizeBundledModuleSourceFromModules(moduleKey, loadedBundledModules);
}

/** Test seam for the virtual module's named/default export forwarding. */
export function __synthesizeLegacyPiBundledSourceWithModules(
	moduleKey: string,
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

/** Test seam for the global bridge key shared with synthetic module source. */
export function __getLegacyPiBundledModulesGlobal(): string {
	return BUNDLED_MODULES_GLOBAL;
}

// Canonical scope for in-process pi packages. Plugins published against any of
// the aliased scopes below (mariozechner's original publish, earendil-works'
// fork, or the canonical @oh-my-pi scope itself) are remapped to this scope and
// resolved against the bundled copy that ships inside the omp binary. This
// keeps plugins running against the exact runtime state of the host (single
// module registry, single tool registry, etc.) regardless of which historical
// scope name they happened to declare in their peerDependencies.
const CANONICAL_PI_SCOPE = "@oh-my-pi";

// Scopes that have historically been used to publish (or alias) the same set
// of internal pi-* packages. `@oh-my-pi` is intentionally included so direct
// canonical imports still pass through the same host-bundled package resolution
// path instead of pulling a duplicate copy from plugin node_modules.
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;

// Internal pi-* package basenames bundled inside the omp binary.
const PI_PACKAGE_NAMES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"] as const;

const PI_SCOPE_ALTERNATION = PI_SCOPE_ALIASES.join("|");
const PI_PACKAGE_ALTERNATION = PI_PACKAGE_NAMES.join("|");

// Upstream `@mariozechner/*` packages exposed a few subpaths at the package
// root that we relocated under a different folder. Each entry rewrites
// `<pkg>/<from>` → `<pkg>/<to>` after the scope has been canonicalised, so
// plugins importing the upstream layout still resolve to a real file in our
// bundled copy. Entries ending in `/` rewrite the whole subtree; add new
// `pkg/from -> pkg/to` pairs whenever an upstream-only subpath breaks resolution.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	["pi-ai/utils/oauth", "pi-ai/oauth"],
	["pi-ai/utils/oauth/", "pi-ai/oauth/"],
	["pi-ai/compat", "pi-ai"],
]);

function remapLegacyPiSubpath(rest: string): string {
	const exact = PI_SUBPATH_REMAPS.get(rest);
	if (exact) {
		return exact;
	}

	for (const [from, to] of PI_SUBPATH_REMAPS) {
		if (from.endsWith("/") && rest.startsWith(from)) {
			return `${to}${rest.slice(from.length)}`;
		}
	}

	return rest;
}

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(`^@(?:${PI_SCOPE_ALTERNATION})/(?:${PI_PACKAGE_ALTERNATION})(?:/.*)?$`);
const resolvedSpecifierFallbacks = new Map<string, string>();
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SUPPORTED_PACKAGE_IMPORT_CONDITIONS = new Set(["bun", "node", "import", "default"]);
const SUPPORTED_PACKAGE_REQUIRE_CONDITIONS = new Set(["bun", "node", "require", "default"]);
const packageRootCache = new Map<string, string | null>();
const packageImportsCache = new Map<string, Record<string, unknown> | null>();
const nodePackageRootCache = new Map<string, Promise<string | null>>();
const packageManifestCache = new Map<string, Promise<Record<string, unknown> | null>>();
const bareDependencyResolutionCache = new Map<string, Promise<string | null>>();
const bareRequireResolutionCache = new Map<string, Promise<string | null>>();
const realpathCache = new Map<string, Promise<string>>();
const nativeAddonResolutionCache = new Map<string, Promise<string | null>>();
const nativeAddonRequireScanCache = new Map<string, Promise<boolean>>();

function clearLegacyPiResolutionCaches(): void {
	resolvedSpecifierFallbacks.clear();
	packageRootCache.clear();
	packageImportsCache.clear();
	nodePackageRootCache.clear();
	packageManifestCache.clear();
	bareDependencyResolutionCache.clear();
	bareRequireResolutionCache.clear();
	nativeAddonResolutionCache.clear();
	nativeAddonRequireScanCache.clear();
	realpathCache.clear();
}

registerPluginCacheInvalidator(clearLegacyPiResolutionCaches);
const PACKAGE_IMPORT_EXCLUDED = Symbol("packageImportExcluded");

// Extensions importing TypeBox directly are redirected to omptype's TypeBox
// facade, keeping legacy builders while producing callable omptype schemas at
// the tool wire boundary. Submodules such as `@sinclair/typebox/compiler` are
// intentionally not remapped: plugins relying on those TypeBox-only APIs must
// vendor TypeBox directly.
const TYPEBOX_SPECIFIER_FILTER = /^(?:@sinclair\/typebox|typebox)$/;

// Compat-shim path resolution. In compiled-binary mode every bundled surface
// is served through the `omp-legacy-pi-bundled:` virtual namespace (see the
// bundled-module block above) — bunfs paths are unreachable on Bun 1.3.14+, so the
// pre-#3423 helpers that derived `/$bunfs/root/...` paths from
// `import.meta.dir` are gone. Dev / source-link / installed-package modes
// still need a real filesystem path for the source shims, which
// `sourceShimPath` computes either from the npm prebuilt `dist/cli.js`
// bundle (`PI_BUNDLED=true`) or directly from the monorepo source tree.

/**
 * Compute the package root for the npm prebuilt `dist/cli.js` bundle.
 *
 * `bundle-dist.ts` defines `process.env.PI_BUNDLED="true"`; after bundling,
 * `import.meta.dir` points at `<package>/dist`. Do not resolve the package via
 * bare `@oh-my-pi/pi-coding-agent` here: from a global install Bun can pick an
 * older cache entry, recreating mixed-runtime plugin loading.
 */
export function __computeBundledSelfPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (pathImpl.basename(normalizedMetaDir) === "dist") {
		return pathImpl.resolve(metaDir, "..");
	}

	const pluginsDirSuffix = pathImpl.join("src", "extensibility", "plugins");
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..");
	}

	return pathImpl.resolve(metaDir);
}

function resolveBundledSelfPackageRoot(): string | undefined {
	if (!process.env.PI_BUNDLED) return undefined;
	return __computeBundledSelfPackageRoot(import.meta.dir);
}

const BUNDLED_SELF_PACKAGE_ROOT = resolveBundledSelfPackageRoot();

function sourceShimPath(file: string): string {
	return BUNDLED_SELF_PACKAGE_ROOT
		? path.join(BUNDLED_SELF_PACKAGE_ROOT, "src", "extensibility", file)
		: path.resolve(import.meta.dir, "..", file);
}

/**
 * Resolve the coding-agent compatibility surface that composes omptype's
 * TypeBox facade with legacy `Type.Unsafe`, then drop the remap when that
 * entrypoint is missing.
 *
 * In compiled-binary mode the surface is served through the
 * `omp-legacy-pi-bundled:` virtual namespace (issue #3423). Dev, source-link,
 * and installed-package modes use the shipped source module.
 *
 * Exported for tests; production callers use `TYPEBOX_SHIM_PATH`.
 */
export function __resolveTypeBoxShimPath(
	isCompiled: boolean,
	sourcePath: string,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): string | null {
	if (isCompiled) {
		return bundledModuleVirtualSpecifier(TYPEBOX_BUNDLED_MODULE_KEY);
	}
	return pathExistsSync(sourcePath) ? sourcePath : null;
}

const TYPEBOX_SHIM_PATH = __resolveTypeBoxShimPath(IS_COMPILED_BINARY, sourceShimPath("legacy-typebox.ts"));

// Legacy extensions historically imported `Type` (and `Static`/`TSchema`) from
// the package root of `@(scope)/pi-ai`. pi-ai 15.1.0 removed the runtime `Type`
// export (see `packages/ai/CHANGELOG.md`), so the bare canonical specifier no
// longer satisfies those imports. The override below redirects only the bare
// pi-ai package root onto a sibling shim that re-exports the canonical surface
// plus the borrowed `Type` runtime from the omptype TypeBox facade. Subpath
// imports such as `@oh-my-pi/pi-ai/oauth` continue to resolve directly
// against the bundled pi-ai package.
const LEGACY_PI_AI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-ai`)
	: sourceShimPath("legacy-pi-ai-shim.ts");

// The coding-agent's own `./src/index.ts` cannot be listed as an extra
// `bun --compile` entrypoint alongside the CLI entry without breaking binary
// startup (issue #1474 follow-up). In compiled-binary mode the legacy
// `@(scope)/pi-coding-agent` root therefore resolves through the bundled
// module shim; in dev / source-link / installed-package mode it points at the
// sibling source shim whose distinct file path avoids the #1474 collision
// while still re-exporting the canonical package surface.
const LEGACY_PI_CODING_AGENT_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-coding-agent`)
	: sourceShimPath("legacy-pi-coding-agent-shim.ts");

// Legacy pi-tui exported `decodeKittyPrintable` from its package root. The
// canonical TUI replaced it with the broader `decodePrintableKey`; route only
// legacy root imports through a sibling shim that preserves the old name.
const LEGACY_PI_TUI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-tui`)
	: sourceShimPath("legacy-pi-tui-shim.ts");

// Package-root overrides. Shim entries (`pi-ai`, `pi-coding-agent`, `pi-tui`)
// always replace the canonical surface so legacy helpers stay reachable. The
// other bundled host packages (`pi-agent-core`, `pi-natives`, `pi-utils`) are
// added only in compiled-binary mode to route extensions onto the in-process
// module instance — in dev / source-link / installed-package mode the canonical
// specifier resolves cleanly through `Bun.resolveSync` and hardcoding a
// source-tree path would miss installs where bundled packages live at
// `node_modules/@oh-my-pi/pi-*`.
//
// Compiled-binary entries are `omp-legacy-pi-bundled:<key>` specifiers handed
// to the synthetic onLoad in `installLegacyPiSpecifierShim()` — bunfs paths
// are unusable on Bun 1.3.14+ (issue #3423). Filesystem-shaped overrides are
// still validated against on-disk presence so a missing dev-mode shim falls
// through to `getResolvedSpecifier`.

/**
 * Drop overrides whose filesystem targets are missing so they can fall
 * through to the canonical-resolution path. Virtual `omp-legacy-pi-bundled:`
 * entries always pass — live bundled module references are the source of truth
 * in compiled mode where bunfs paths are unreachable (issue #3423).
 *
 * `pathExistsSync` defaults to `fs.existsSync`; tests inject a stub to
 * simulate the missing-entrypoint failure mode without touching the real FS.
 */
export function __validateLegacyPiPackageRootOverrides(
	candidates: Record<string, string>,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): Record<string, string> {
	const valid: Record<string, string> = {};
	for (const key in candidates) {
		const candidate = candidates[key];
		if (candidate && (isBundledVirtualSpecifier(candidate) || pathExistsSync(candidate))) {
			valid[key] = candidate;
		}
	}
	return valid;
}

/**
 * Compute the override map keyed by every canonical specifier the host serves
 * directly: the pi-ai / pi-coding-agent roots (compat shims that re-attach
 * legacy helpers) plus, in compiled mode, every build-supplied module key.
 * Subpath coverage stops `@(scope)/pi-ai/oauth` and friends from falling
 * through to the extension's absent peer install when bunfs walks fail.
 */
export function __buildLegacyPiPackageRootOverrides(
	isCompiled: boolean,
	bundledModuleKeys: Iterable<string> = [],
): Record<string, string> {
	const candidates: Record<string, string> = {
		[`${CANONICAL_PI_SCOPE}/pi-ai`]: LEGACY_PI_AI_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-tui`]: LEGACY_PI_TUI_SHIM_PATH,
	};
	if (isCompiled) {
		for (const key of bundledModuleKeys) {
			// Shim-bearing roots already map to their compat surfaces; TypeBox
			// has a dedicated TYPEBOX_SHIM_PATH route.
			if (key in candidates || key === TYPEBOX_BUNDLED_MODULE_KEY) continue;
			candidates[key] = bundledModuleVirtualSpecifier(key);
		}
	}
	return __validateLegacyPiPackageRootOverrides(candidates);
}

// Seeded with compat roots at module init; first compiled extension load adds
// every key supplied by the in-memory build module.
let legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(IS_COMPILED_BINARY);
let legacyPiOverridesReadyPromise: Promise<void> | null = null;

/** Complete compiled-mode overrides from the lazy host-module registry. */
function ensureLegacyPiOverridesReady(): Promise<void> {
	if (!IS_COMPILED_BINARY) {
		return Promise.resolve();
	}
	if (!legacyPiOverridesReadyPromise) {
		legacyPiOverridesReadyPromise = ensureBundledModuleLoadersLoaded().then(loaders => {
			legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(true, Object.keys(loaders));
		});
	}
	return legacyPiOverridesReadyPromise;
}

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	// Filter guarantees a slash exists, but guard anyway to keep the type narrow.
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = remapLegacyPiSubpath(rest);
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

/**
 * Resolve a canonical `@oh-my-pi/*` specifier to a filesystem path, preferring
 * a bundled compat shim when one is registered for the package root.
 *
 * Falls back to `getResolvedSpecifier` (which may throw under compiled binary
 * mode); callers handle that the same way they would for non-overridden
 * specifiers.
 */
function resolveCanonicalPiSpecifier(remappedSpecifier: string): string {
	const override = legacyPiPackageRootOverrides[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(remappedSpecifier);
}

function toImportSpecifier(resolvedPath: string): string {
	// Virtual `omp-legacy-pi-bundled:` specifiers are served by the synthetic
	// onLoad in `installLegacyPiSpecifierShim()`; wrapping them as `file://`
	// would corrupt the scheme.
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(stripWindowsExtendedLengthPathPrefix(resolvedPath)).href;
}

/**
 * Rewrite the extension-owned specifiers OMP must host-resolve — legacy
 * `@(scope)/pi-*`, bare TypeBox packages, package `imports` aliases like
 * `#src/*`, and extension-local bare dependencies — to absolute `file://` URLs
 * or compiled-mode virtual specifiers. Relative siblings and built-in modules
 * are left untouched so Bun resolves them from the extension's real on-disk
 * location.
 *
 * When `mtimeTag` is provided, extension-owned relative graph specifiers
 * (`./`/`../`) and, by default, resolved package `#alias/*` and extension-local
 * bare deps also carry a `?mtime=<tag>` cache-bust so Bun rekeys them on
 * same-process reloads. `resolvedImportMtimeTag` can disable the tag for
 * resolved package and bare ESM imports inside third-party dependencies, whose
 * transitive ESM imports retain a query-free importer path for Bun's runtime
 * `node_modules` resolution. Host package rewrites (legacy
 * `@(scope)/pi-*`, TypeBox shim) always emit `file://` URLs because they resolve
 * to in-process host code that never changes between reloads.
 */
async function rewriteLegacyExtensionSource(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
	resolvedImportMtimeTag: string | null = mtimeTag,
): Promise<string> {
	// Compiled mode completes the override map from the build-supplied module
	// keys on first use; every rewrite path must see the full map.
	await ensureLegacyPiOverridesReady();
	const references = getExtensionSourceAnalysis(source, importerPath).references;
	const replacements: Array<ExtensionSpecifierReference & { replacement: string }> = [];
	for (const reference of references) {
		if (reference.kind !== "import") continue;

		const specifier = reference.specifier;
		let replacement: string | null = null;
		const remappedSpecifier = remapLegacyPiSpecifier(specifier);
		if (remappedSpecifier) {
			try {
				replacement = toImportSpecifier(resolveCanonicalPiSpecifier(remappedSpecifier));
			} catch {
				// Compiled fallback may be absent from a malformed build. Continue to
				// the extension's on-disk peer dependency resolution below.
			}
		}
		if (!replacement && TYPEBOX_SHIM_PATH && (specifier === "typebox" || specifier === "@sinclair/typebox")) {
			replacement = toImportSpecifier(TYPEBOX_SHIM_PATH);
		}
		if (!replacement && specifier.startsWith("#")) {
			const resolved = packageImportPath(specifier, await resolvePackageImportSpecifier(specifier, importerPath));
			if (resolved) replacement = toGraphImportSpecifier(resolved, resolvedImportMtimeTag);
		}
		if (!replacement && isBareExtensionDependencySpecifier(specifier)) {
			const resolved = await resolveExtensionBareDependency(specifier, importerPath);
			if (resolved) replacement = toGraphImportSpecifier(resolved, resolvedImportMtimeTag);
		}
		if (!replacement && mtimeTag && /^\.\.?\//.test(specifier) && !specifier.includes("?")) {
			replacement = `${specifier}?mtime=${mtimeTag}`;
		}
		if (replacement && replacement !== specifier) {
			replacements.push({ ...reference, replacement });
		}
	}
	const withImports = applySpecifierReplacements(source, replacements);
	return rewriteExtensionSpecifiers(withImports, importerPath);
}

/** Test seam for compiled-binary legacy extension source rewriting. */
export async function __rewriteLegacyExtensionSourceForTests(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
	resolvedImportMtimeTag: string | null = mtimeTag,
): Promise<string> {
	return rewriteLegacyExtensionSource(source, importerPath, mtimeTag, resolvedImportMtimeTag);
}

/**
 * Build the import specifier for a graph-resolved absolute path. POSIX
 * emits a bare filesystem path with an optional `?mtime=<tag>` (Bun keys
 * query strings for bare-path specifiers), so same-process extension
 * reloads pick up edits to package-alias (`#foo/*`) and extension-local
 * bare deps. Windows and bundled virtual specifiers keep the current
 * `file://` / virtual form — Bun ignores queries on `file://` URLs, so
 * cache-bust does not reach Windows extensions until Bun changes that.
 */
function toGraphImportSpecifier(resolvedPath: string, mtimeTag: string | null): string {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	if (process.platform === "win32" || !mtimeTag) {
		return url.pathToFileURL(stripWindowsExtendedLengthPathPrefix(resolvedPath)).href;
	}
	return `${stripWindowsExtendedLengthPathPrefix(resolvedPath)}?mtime=${mtimeTag}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.promises.stat(p);
		return true;
	} catch {
		return false;
	}
}

function hasSourceModuleExtension(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return (SOURCE_MODULE_EXTENSIONS as readonly string[]).includes(ext);
}

async function resolveSourceModuleFile(basePath: string): Promise<string | null> {
	try {
		const stats = await fs.promises.stat(basePath);
		if (stats.isFile()) {
			// Non-source files (JSON, WASM, text assets, etc.) bypass the on-load
			// rewrite hook so Bun's native loaders handle them; our hook would
			// otherwise pass them through `getLoader()` which falls back to `js`.
			return hasSourceModuleExtension(basePath) ? realpathOrSelf(basePath) : null;
		}
		if (stats.isDirectory()) {
			for (const extension of SOURCE_MODULE_EXTENSIONS) {
				const resolved = await resolveSourceModuleFile(path.join(basePath, `index${extension}`));
				if (resolved) return resolved;
			}
		}
	} catch {
		// Fall through to extension candidates below.
	}

	if (path.extname(basePath)) {
		return null;
	}

	for (const extension of SOURCE_MODULE_EXTENSIONS) {
		const resolved = await resolveSourceModuleFile(`${basePath}${extension}`);
		if (resolved) return resolved;
	}
	return null;
}

async function resolveRelativeCommonJsRequire(specifier: string, importerPath: string): Promise<string | null> {
	const candidate = path.resolve(path.dirname(importerPath), specifier);
	try {
		const stats = await fs.promises.stat(candidate);
		if (stats.isDirectory()) {
			const manifest = await readPackageManifest(candidate);
			if (typeof manifest?.main === "string") {
				const main = await resolveSourceModuleFile(path.resolve(candidate, manifest.main));
				if (main) return main;
			}
		}
	} catch {
		// Missing candidates fall through to extension and index resolution.
	}
	return resolveSourceModuleFile(candidate);
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(rootPath, candidatePath);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolvePackageSourceTarget(packageRoot: string, targetPath: string): Promise<string | null> {
	const candidate = path.resolve(targetPath);
	if (!isPathInsideRoot(path.resolve(packageRoot), candidate)) {
		return null;
	}
	const resolved = await resolveSourceModuleFile(candidate);
	if (!resolved) {
		return null;
	}
	const realPackageRoot = await realpathOrSelf(packageRoot);
	return isPathInsideRoot(realPackageRoot, resolved) ? resolved : null;
}

async function resolvePackageFileTarget(packageRoot: string, targetPath: string): Promise<string | null> {
	const candidate = path.resolve(targetPath);
	if (!isPathInsideRoot(path.resolve(packageRoot), candidate) || !(await pathExists(candidate))) {
		return null;
	}
	const [realPackageRoot, resolved] = await Promise.all([realpathOrSelf(packageRoot), realpathOrSelf(candidate)]);
	return isPathInsideRoot(realPackageRoot, resolved) ? resolved : null;
}

async function findPackageRoot(importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const cached = packageRootCache.get(dir);
		if (cached !== undefined) {
			return cached;
		}

		if (await pathExists(path.join(dir, "package.json"))) {
			packageRootCache.set(path.dirname(importerPath), dir);
			return dir;
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			packageRootCache.set(path.dirname(importerPath), null);
			return null;
		}
		dir = parent;
	}
}

async function readPackageImports(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageImportsCache.get(packageRoot);
	if (cached !== undefined) {
		return cached;
	}

	let imports: Record<string, unknown> | null = null;
	try {
		const pkg = await Bun.file(path.join(packageRoot, "package.json")).json();
		if (isRecord(pkg) && isRecord(pkg.imports)) {
			imports = pkg.imports;
		}
	} catch {
		imports = null;
	}
	packageImportsCache.set(packageRoot, imports);
	return imports;
}

type PackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED | null;
type ResolvedPackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED;

function selectPackageImportTarget(
	entry: unknown,
	conditions: ReadonlySet<string> = SUPPORTED_PACKAGE_IMPORT_CONDITIONS,
): PackageImportTargetSelection {
	if (entry === null) {
		return PACKAGE_IMPORT_EXCLUDED;
	}
	if (typeof entry === "string") {
		return entry;
	}
	if (Array.isArray(entry)) {
		for (const item of entry) {
			const target = selectPackageImportTarget(item, conditions);
			if (target !== null) return target;
		}
		return null;
	}
	if (!isRecord(entry)) {
		return null;
	}
	for (const [condition, value] of Object.entries(entry)) {
		if (!conditions.has(condition)) {
			continue;
		}
		const target = selectPackageImportTarget(value, conditions);
		if (target !== null) return target;
	}
	return null;
}

async function resolvePackageImportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, substituted));
}
type PackageImportResolution = string | typeof PACKAGE_IMPORT_EXCLUDED | null;

async function resolvePackageImportSpecifier(
	specifier: string,
	importerPath: string,
): Promise<PackageImportResolution> {
	if (!specifier.startsWith("#")) {
		return null;
	}

	const packageRoot = await findPackageRoot(importerPath);
	if (!packageRoot) {
		return null;
	}

	const imports = await readPackageImports(packageRoot);
	if (!imports) {
		return null;
	}

	const exactTarget = selectPackageImportTarget(imports[specifier]);
	if (exactTarget === PACKAGE_IMPORT_EXCLUDED) {
		return PACKAGE_IMPORT_EXCLUDED;
	}
	if (exactTarget !== null) {
		return resolvePackageImportTarget(packageRoot, exactTarget, null);
	}

	let bestMatch: { keyLength: number; target: ResolvedPackageImportTargetSelection; wildcard: string } | null = null;
	for (const [key, entry] of Object.entries(imports)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1) continue;

		const prefix = key.slice(0, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
			continue;
		}

		const target = selectPackageImportTarget(entry);
		if (target === null) {
			continue;
		}

		if (!bestMatch || key.length > bestMatch.keyLength) {
			bestMatch = {
				keyLength: key.length,
				target,
				wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
			};
		}
	}

	if (!bestMatch || bestMatch.target === PACKAGE_IMPORT_EXCLUDED) {
		return bestMatch?.target ?? null;
	}
	return resolvePackageImportTarget(packageRoot, bestMatch.target, bestMatch.wildcard);
}
function packageImportPath(specifier: string, resolution: PackageImportResolution): string | null {
	if (resolution === PACKAGE_IMPORT_EXCLUDED) {
		throw new Error(`Package import "${specifier}" is excluded by its package imports map`);
	}
	return resolution;
}

function isBareExtensionDependencySpecifier(specifier: string): boolean {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.startsWith("node:") ||
		specifier.startsWith("bun:") ||
		/^[a-z][a-z0-9+.-]*:/i.test(specifier)
	) {
		return false;
	}
	const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return Boolean(packageName && !isBuiltin(specifier));
}

interface BarePackageSpecifier {
	readonly name: string;
	readonly subpath: string | null;
}

function splitBarePackageSpecifier(specifier: string): BarePackageSpecifier | null {
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		const [scope, name, ...rest] = parts;
		if (!scope || !name) return null;
		return { name: `${scope}/${name}`, subpath: rest.length > 0 ? rest.join("/") : null };
	}
	const [name, ...rest] = parts;
	if (!name) return null;
	return { name, subpath: rest.length > 0 ? rest.join("/") : null };
}

async function findNodePackageRoot(packageName: string, importerPath: string): Promise<string | null> {
	const cacheKey = `${packageName}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = nodePackageRootCache.get(cacheKey);
	if (cached) return cached;

	const promise = findNodePackageRootUncached(packageName, importerPath);
	nodePackageRootCache.set(cacheKey, promise);
	return promise;
}

async function findNodePackageRootUncached(packageName: string, importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const candidate = path.join(dir, "node_modules", packageName);
		if (await pathExists(path.join(candidate, "package.json"))) {
			return candidate;
		}
		const workspaceMember = await findWorkspaceMemberPackageRoot(dir, packageName);
		if (workspaceMember) {
			return workspaceMember;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/**
 * Resolve `packageName` as a workspace member when `dir` is a workspace root.
 *
 * An installed git dependency of a monorepo plugin contains the full
 * workspace tree but no node_modules links: `bun install` materializes a git
 * dependency's regular npm dependencies into the host tree and skips its
 * `workspace:*` / `file:` edges. Bare imports between workspace siblings
 * therefore never resolve through the node_modules walk above. When a
 * directory on that walk declares `workspaces` (array form or the yarn-style
 * `{ packages: [...] }` object), scan the member manifests for the requested
 * package name. node_modules candidates at the same level win, so an
 * explicitly installed copy still shadows the workspace member.
 */
async function findWorkspaceMemberPackageRoot(dir: string, packageName: string): Promise<string | null> {
	if (!(await pathExists(path.join(dir, "package.json")))) {
		return null;
	}
	const manifest = await readPackageManifest(dir);
	const rawWorkspaces = manifest?.workspaces;
	const patterns = Array.isArray(rawWorkspaces)
		? rawWorkspaces
		: isRecord(rawWorkspaces) && Array.isArray(rawWorkspaces.packages)
			? rawWorkspaces.packages
			: null;
	if (!patterns) {
		return null;
	}
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.startsWith("!")) {
			continue;
		}
		const glob = new Bun.Glob(path.join(pattern, "package.json"));
		for await (const match of glob.scan({ cwd: dir, onlyFiles: true })) {
			const memberRoot = path.dirname(path.join(dir, match));
			const memberManifest = await readPackageManifest(memberRoot);
			if (memberManifest?.name === packageName) {
				return memberRoot;
			}
		}
	}
	return null;
}

async function readPackageManifest(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageManifestCache.get(packageRoot);
	if (cached) return cached;

	const promise = readPackageManifestUncached(packageRoot);
	packageManifestCache.set(packageRoot, promise);
	return promise;
}

async function readPackageManifestUncached(packageRoot: string): Promise<Record<string, unknown> | null> {
	try {
		const manifest = await Bun.file(path.join(packageRoot, "package.json")).json();
		return isRecord(manifest) ? manifest : null;
	} catch {
		return null;
	}
}

type ExtensionModuleKind = "commonjs" | "esm";

async function isCommonJsModulePath(
	modulePath: string,
	sourceType?: "script" | "module",
	inheritedKind?: ExtensionModuleKind,
): Promise<boolean> {
	const extension = path.extname(modulePath).toLowerCase();
	if (extension === ".cjs" || extension === ".cts") {
		return true;
	}
	if (extension !== ".js" && extension !== ".jsx") {
		return false;
	}

	const packageRoot = await findPackageRoot(modulePath);
	const manifest = packageRoot ? await readPackageManifest(packageRoot) : null;
	if (manifest?.type === "module") {
		return false;
	}
	if (manifest?.type === "commonjs") {
		return true;
	}
	const parsedSourceType =
		sourceType ?? getExtensionSourceAnalysis(await Bun.file(modulePath).text(), modulePath).sourceType;
	if (parsedSourceType === "module") {
		return false;
	}
	if (parsedSourceType === "script") {
		const ast = parseExtensionSource(await Bun.file(modulePath).text(), modulePath);
		const hasUnshadowedCommonJsSyntax = collectScopedAstNodes(
			ast,
			node => node.type === "CallExpression" || node.type === "MemberExpression",
		).some(({ node, scope }) => {
			if (isGlobalRequireCall(node, scope)) return true;
			if (node.type !== "MemberExpression") return false;
			return isUnshadowedExportsTarget(node, scope) || isUnshadowedExportsTarget(asAstNode(node.object), scope);
		});
		if (hasUnshadowedCommonJsSyntax) {
			return true;
		}
	}
	if (inheritedKind) {
		return inheritedKind === "commonjs";
	}
	const declaredModuleEntry =
		packageRoot && typeof manifest?.module === "string"
			? await resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, manifest.module))
			: null;
	return !declaredModuleEntry || path.resolve(modulePath) !== path.resolve(declaredModuleEntry);
}

async function isGraphOwnedCommonJsModule(
	modulePath: string,
	entryRealPath: string,
	sourceType?: "script" | "module",
	inheritedKind?: ExtensionModuleKind,
): Promise<boolean> {
	const extension = path.extname(modulePath).toLowerCase();
	if (modulePath === entryRealPath && extension !== ".cjs" && extension !== ".cts") {
		return false;
	}
	return isCommonJsModulePath(modulePath, sourceType, inheritedKind);
}

async function resolvePackageExportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, substituted));
}

async function resolveNodePackageExport(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
	conditions: ReadonlySet<string> = SUPPORTED_PACKAGE_IMPORT_CONDITIONS,
): Promise<string | null> {
	const exportsField = manifest.exports;
	const rootTarget = subpath === null ? selectPackageImportTarget(exportsField, conditions) : null;
	if (rootTarget !== null && rootTarget !== PACKAGE_IMPORT_EXCLUDED) {
		return resolvePackageExportTarget(packageRoot, rootTarget, null);
	}
	if (!isRecord(exportsField)) {
		return null;
	}

	const exactKey = subpath === null ? "." : `./${subpath}`;
	if (Object.hasOwn(exportsField, exactKey)) {
		const exactTarget = selectPackageImportTarget(exportsField[exactKey], conditions);
		return exactTarget !== null && exactTarget !== PACKAGE_IMPORT_EXCLUDED
			? resolvePackageExportTarget(packageRoot, exactTarget, null)
			: null;
	}

	let bestMatch: {
		keyLength: number;
		prefixLength: number;
		target: PackageImportTargetSelection;
		wildcard: string;
	} | null = null;
	for (const [key, entry] of Object.entries(exportsField)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1 || subpath === null || !key.startsWith("./")) continue;
		const prefix = key.slice(2, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		if (
			!bestMatch ||
			prefix.length > bestMatch.prefixLength ||
			(prefix.length === bestMatch.prefixLength && key.length > bestMatch.keyLength)
		) {
			bestMatch = {
				keyLength: key.length,
				prefixLength: prefix.length,
				target: selectPackageImportTarget(entry, conditions),
				wildcard: subpath.slice(prefix.length, subpath.length - suffix.length),
			};
		}
	}
	return bestMatch?.target && bestMatch.target !== PACKAGE_IMPORT_EXCLUDED
		? resolvePackageExportTarget(packageRoot, bestMatch.target, bestMatch.wildcard)
		: null;
}

async function resolveNodePackageFallback(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
): Promise<string | null> {
	if (subpath) {
		return resolvePackageSourceTarget(packageRoot, path.join(packageRoot, subpath));
	}
	for (const field of ["module", "main"]) {
		const target = manifest[field];
		if (typeof target === "string") {
			const resolved = await resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, target));
			if (resolved) return resolved;
		}
	}
	return resolvePackageSourceTarget(packageRoot, path.join(packageRoot, "index"));
}

async function resolveNodePackageDependency(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;
	const manifest = await readPackageManifest(packageRoot);
	if (!manifest) return null;
	return Object.hasOwn(manifest, "exports")
		? resolveNodePackageExport(packageRoot, parsed.subpath, manifest)
		: resolveNodePackageFallback(packageRoot, parsed.subpath, manifest);
}

async function resolveNodePackageRequire(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;
	const manifest = await readPackageManifest(packageRoot);
	if (!manifest) return null;

	if (Object.hasOwn(manifest, "exports")) {
		return resolveNodePackageExport(packageRoot, parsed.subpath, manifest, SUPPORTED_PACKAGE_REQUIRE_CONDITIONS);
	}
	if (parsed.subpath) {
		return resolvePackageSourceTarget(packageRoot, path.join(packageRoot, parsed.subpath));
	}
	const main = manifest.main;
	return typeof main === "string"
		? await resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, main))
		: await resolvePackageSourceTarget(packageRoot, path.join(packageRoot, "index"));
}

async function validateResolvedBarePackagePath(
	specifier: string,
	importerPath: string,
	resolvedPath: string,
): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	const packageRoot = parsed ? await findNodePackageRoot(parsed.name, importerPath) : null;
	return packageRoot ? resolvePackageFileTarget(packageRoot, resolvedPath) : null;
}

async function isSelectedNoTypeEsmPackageBranch(
	specifier: string,
	importerPath: string,
	resolvedPath: string,
): Promise<boolean> {
	const parsed = splitBarePackageSpecifier(specifier);
	const packageRoot = parsed ? await findNodePackageRoot(parsed.name, importerPath) : null;
	const manifest = packageRoot ? await readPackageManifest(packageRoot) : null;
	if (!packageRoot || !manifest || manifest.type !== undefined) {
		return false;
	}
	if (parsed?.subpath === null && typeof manifest.module === "string") {
		const moduleEntry = await resolvePackageSourceTarget(packageRoot, path.resolve(packageRoot, manifest.module));
		if (moduleEntry && path.resolve(moduleEntry) === path.resolve(resolvedPath)) {
			return true;
		}
	}
	if (!Object.hasOwn(manifest, "exports")) {
		return false;
	}
	const importTarget = await resolveNodePackageExport(packageRoot, parsed?.subpath ?? null, manifest);
	const requireTarget = await resolveNodePackageExport(
		packageRoot,
		parsed?.subpath ?? null,
		manifest,
		SUPPORTED_PACKAGE_REQUIRE_CONDITIONS,
	);
	return Boolean(
		importTarget &&
		path.resolve(importTarget) === path.resolve(resolvedPath) &&
		(!requireTarget || path.resolve(requireTarget) !== path.resolve(importTarget)),
	);
}

async function resolveExtensionBareDependency(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}

	const cacheKey = `${specifier}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = bareDependencyResolutionCache.get(cacheKey);
	if (cached) return cached;

	const promise = resolveExtensionBareDependencyUncached(specifier, importerPath);
	bareDependencyResolutionCache.set(cacheKey, promise);
	return promise;
}

async function resolveExtensionBareDependencyUncached(specifier: string, importerPath: string): Promise<string | null> {
	// Resolve against the runtime package manifest first. Besides working in a
	// compiled binary, this preserves the package's ESM `import` condition when
	// the absolute target is later loaded outside normal package resolution.
	const packageResolved = await resolveNodePackageDependency(specifier, importerPath);
	if (packageResolved) {
		return packageResolved;
	}
	try {
		const resolved = Bun.resolveSync(specifier, path.dirname(importerPath));
		if (resolved && resolved !== specifier && !resolved.startsWith("node:") && !resolved.startsWith("bun:")) {
			return validateResolvedBarePackagePath(specifier, importerPath, resolved);
		}
	} catch {
		// Compiled binaries do not reliably resolve runtime extension node_modules.
	}
	return null;
}

const NATIVE_ADDON_EXTENSION = ".node";

/**
 * Resolve a bare specifier whose target is a native `.node` addon — either a
 * package subpath ending in `.node`, or a package whose `main` points at an
 * addon (the napi-rs per-platform package convention, e.g.
 * `@yuuang/ffi-rs-darwin-arm64` → `ffi-rs.darwin-arm64.node`). Returns the
 * addon's absolute realpath, or null when the specifier is not a native addon.
 */
async function resolveExtensionNativeAddon(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}

	const cacheKey = `${specifier}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = nativeAddonResolutionCache.get(cacheKey);
	if (cached) return cached;

	const promise = resolveExtensionNativeAddonUncached(specifier, importerPath);
	nativeAddonResolutionCache.set(cacheKey, promise);
	return promise;
}

async function resolveExtensionNativeAddonUncached(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;

	let target: string | null = null;
	if (parsed.subpath !== null) {
		target = parsed.subpath.endsWith(NATIVE_ADDON_EXTENSION) ? path.join(packageRoot, parsed.subpath) : null;
	} else {
		const manifest = await readPackageManifest(packageRoot);
		const main = manifest?.main;
		target =
			typeof main === "string" && main.endsWith(NATIVE_ADDON_EXTENSION) ? path.resolve(packageRoot, main) : null;
	}
	if (!target) {
		return null;
	}
	return resolvePackageFileTarget(packageRoot, target);
}

async function resolveExtensionBareRequire(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}

	const cacheKey = `${specifier}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = bareRequireResolutionCache.get(cacheKey);
	if (cached) return cached;

	const resolution = (async () => {
		const nativeAddon = await resolveExtensionNativeAddon(specifier, importerPath);
		if (nativeAddon) {
			return nativeAddon;
		}
		const packageResolved = await resolveNodePackageRequire(specifier, importerPath);
		if (packageResolved) {
			return realpathOrSelf(packageResolved);
		}
		try {
			const resolved = createRequire(importerPath).resolve(specifier);
			return resolved === specifier || resolved.startsWith("node:") || resolved.startsWith("bun:")
				? null
				: await validateResolvedBarePackagePath(specifier, importerPath, resolved);
		} catch {
			return null;
		}
	})();
	bareRequireResolutionCache.set(cacheKey, resolution);
	return resolution;
}

async function resolveExtensionCommonJsRequire(specifier: string, importerPath: string): Promise<string | null> {
	if (specifier.startsWith(".")) {
		return resolveRelativeCommonJsRequire(specifier, importerPath);
	}
	const remappedSpecifier = remapLegacyPiSpecifier(specifier);
	if (remappedSpecifier) {
		try {
			const resolved = resolveCanonicalPiSpecifier(remappedSpecifier);
			if (isBundledVirtualSpecifier(resolved)) {
				const moduleKey = resolved.slice(BUNDLED_VIRTUAL_SCHEME.length);
				if (!(moduleKey in loadedBundledModules)) {
					await loadBundledModule(moduleKey);
				}
			}
			return resolved;
		} catch {
			// A malformed compiled registry can still fall through to an
			// extension-installed legacy peer dependency.
		}
	}
	return resolveExtensionBareRequire(specifier, importerPath);
}

/**
 * Rewrite CommonJS graph specifiers that cannot resolve from the bridge's
 * generated function: bare `require()` calls and, for graph-owned CommonJS
 * sources, import specifiers. Resolved targets are retained for synchronous
 * lazy hydration after load-time source caches clear.
 */
async function rewriteExtensionSpecifiers(
	source: string,
	importerPath: string,
	rewriteImports = false,
): Promise<string> {
	const references = getExtensionSourceAnalysis(source, importerPath).references;
	const resolvedSpecifierTargets = new Map<string, string>();
	const replacements: Array<ExtensionSpecifierReference & { replacement: string }> = [];
	for (const reference of references) {
		let resolved: string | null = null;
		if (reference.kind === "require") {
			resolved = await resolveExtensionCommonJsRequire(reference.specifier, importerPath);
		} else if (rewriteImports) {
			if (reference.specifier.startsWith(".")) {
				const candidate = Bun.resolveSync(reference.specifier, path.dirname(importerPath));
				resolved = hasSourceModuleExtension(candidate) ? await realpathOrSelf(candidate) : null;
			} else if (reference.specifier.startsWith("#")) {
				resolved = packageImportPath(
					reference.specifier,
					await resolvePackageImportSpecifier(reference.specifier, importerPath),
				);
			} else {
				resolved = await resolveExtensionBareDependency(reference.specifier, importerPath);
			}
		}
		if (!resolved) continue;
		const replacement = stripWindowsExtendedLengthPathPrefix(resolved).replaceAll("\\", "/");
		resolvedSpecifierTargets.set(`${reference.kind}\0${reference.specifier}`, replacement);
		replacements.push({ ...reference, replacement });
	}
	extensionSynchronousSpecifierTargets.set(importerPath, resolvedSpecifierTargets);
	return applySpecifierReplacements(source, replacements);
}

function rewriteExtensionSpecifiersFromCache(source: string, importerPath: string): string {
	const resolvedSpecifierTargets = extensionSynchronousSpecifierTargets.get(importerPath);
	if (!resolvedSpecifierTargets || resolvedSpecifierTargets.size === 0) {
		return source;
	}
	const replacements: Array<ExtensionSpecifierReference & { replacement: string }> = [];
	for (const reference of getExtensionSourceAnalysis(source, importerPath).references) {
		const replacement = resolvedSpecifierTargets.get(`${reference.kind}\0${reference.specifier}`);
		if (replacement) {
			replacements.push({ ...reference, replacement });
		}
	}
	return applySpecifierReplacements(source, replacements);
}

/**
 * Whether a module's source contains a bare require that resolves to a native
 * `.node` addon — i.e. a napi-rs style loader that must be hooked into the
 * extension graph so {@link rewriteExtensionSpecifiers} can pin its
 * platform-package requires to absolute paths.
 */
async function moduleRequiresNativeAddon(modulePath: string): Promise<boolean> {
	const cached = nativeAddonRequireScanCache.get(modulePath);
	if (cached) return cached;

	const promise = moduleRequiresNativeAddonUncached(modulePath);
	nativeAddonRequireScanCache.set(modulePath, promise);
	return promise;
}

async function moduleRequiresNativeAddonUncached(modulePath: string): Promise<boolean> {
	let source: string;
	try {
		source = await Bun.file(modulePath).text();
	} catch {
		return false;
	}
	for (const reference of getExtensionSourceAnalysis(source, modulePath).references) {
		if (reference.kind === "require" && (await resolveExtensionNativeAddon(reference.specifier, modulePath))) {
			return true;
		}
	}
	return false;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Source modules in an extension graph are discovered from parsed static,
// dynamic, re-export, and direct CommonJS require specifiers. Parsing keeps
// import-looking text in strings, templates, regex literals, and comments out
// of dependency resolution.

// Extension source realpaths already covered by an installed load-time hook for
// each entry. `Bun.plugin()` registrations are process-global and permanent, so
// reloads install supplemental hooks only for modules added to the graph since
// the previous load.
const extensionGraphHookModules = new Map<string, Set<string>>();
const extensionGraphCacheBustResolvedImportModules = new Map<string, Set<string>>();
const commonJsModuleSources = new Map<string, string>();
const commonJsFallbackModulePaths = new Map<string, string>();
const extensionSynchronousSpecifierTargets = new Map<string, Map<string, string>>();
const synchronousModuleSources = new Map<string, string>();
const commonJsGraphModulePaths = new Set<string>();
const COMMONJS_REQUIRE_GLOBAL = "__ompLegacyPiRequireGraphModule";
const commonJsModuleDefinitions = new Map<string, { source: string; filename: string; dirname: string }>();
const commonJsModuleCache = new Map<
	string,
	{
		exports: unknown;
		filename: string;
		id: string;
		path: string;
		require: NodeJS.Require;
		loaded: boolean;
	}
>();
const commonJsTypeScriptTranspiler = new Bun.Transpiler({ loader: "ts" });

function evaluateGraphCommonJs(modulePath: string): unknown {
	const cached = commonJsModuleCache.get(modulePath);
	if (cached) {
		return cached.exports;
	}
	let definition = commonJsModuleDefinitions.get(modulePath);
	if (!definition && commonJsGraphModulePaths.has(modulePath)) {
		const targetPath = commonJsFallbackModulePaths.get(modulePath) ?? modulePath;
		const source = rewriteExtensionSpecifiersFromCache(fs.readFileSync(targetPath, "utf8"), modulePath);
		synthesizeCommonJsDefaultModule(modulePath, source, targetPath);
		definition = commonJsModuleDefinitions.get(modulePath);
	}
	if (!definition) {
		throw new Error(`Missing graph-owned CommonJS definition: ${modulePath}`);
	}

	const nativeRequire = createRequire(definition.filename);
	const module = {
		exports: {},
		filename: definition.filename,
		id: definition.filename,
		path: definition.dirname,
		require: nativeRequire,
		loaded: false,
	};
	commonJsModuleCache.set(modulePath, module);
	const graphRequire: NodeJS.Require = Object.assign(
		(specifier: string) => {
			if (isBundledVirtualSpecifier(specifier)) {
				const moduleKey = specifier.slice(BUNDLED_VIRTUAL_SCHEME.length);
				const bundledModule = loadedBundledModules[moduleKey];
				if (!bundledModule) {
					throw new Error(`Missing bundled CommonJS host module: ${moduleKey}`);
				}
				return bundledModule;
			}
			const resolved = nativeRequire.resolve(specifier);
			let graphPath = resolved;
			try {
				graphPath = fs.realpathSync(resolved);
			} catch {
				// Builtins and virtual modules have no filesystem realpath.
			}
			return commonJsGraphModulePaths.has(graphPath) ? evaluateGraphCommonJs(graphPath) : nativeRequire(specifier);
		},
		{
			resolve: nativeRequire.resolve,
			cache: nativeRequire.cache,
			extensions: nativeRequire.extensions,
			main: nativeRequire.main,
		},
	);
	module.require = graphRequire;
	const execute = new Function("exports", "require", "module", "__filename", "__dirname", definition.source);
	try {
		execute.call(module.exports, module.exports, graphRequire, module, definition.filename, definition.dirname);
		module.loaded = true;
		return module.exports;
	} catch (error) {
		commonJsModuleCache.delete(modulePath);
		throw error;
	}
}

/**
 * Register {@link evaluateGraphCommonJs} as the graph-owned CommonJS require
 * bridge on `globalThis`, first-wins.
 *
 * On source-link installs the `@(scope)/pi-coding-agent` root shim is served
 * from `src/`, so an extension import can evaluate a second instance of this
 * module with empty graph state. An unconditional set would let that empty
 * instance clobber the host bundle's populated bridge and break transitive
 * CommonJS resolution (#6449); guarding preserves the first (host-owned)
 * registration. Idempotent: a subsequent call with a value already present is a
 * no-op.
 */
export function ensureGraphCommonJsRequireRegistered(): void {
	if (!Reflect.get(globalThis, COMMONJS_REQUIRE_GLOBAL)) {
		Reflect.set(globalThis, COMMONJS_REQUIRE_GLOBAL, evaluateGraphCommonJs);
	}
}

ensureGraphCommonJsRequireRegistered();

let legacyPiLoadTag = 0;

function nextLegacyPiLoadTag(): string {
	legacyPiLoadTag = Math.max(legacyPiLoadTag + 1, Date.now());
	return String(legacyPiLoadTag);
}

/** Resolve symlinks in a path, falling back to the input if realpath fails. */
async function realpathOrSelf(p: string): Promise<string> {
	const cached = realpathCache.get(p);
	if (cached) return cached;

	const promise = realpathOrSelfUncached(p);
	realpathCache.set(p, promise);
	return promise;
}

async function realpathOrSelfUncached(p: string): Promise<string> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return p;
	}
}

interface ExtensionModuleGraph {
	readonly modules: Map<string, string>;
	readonly cacheBustResolvedImportModules: Set<string>;
	readonly commonJsPaths: Set<string>;
	readonly synchronousSourcePaths: Set<string>;
}

/**
 * Walk the extension's import graph starting at `entryRealPath`, returning the
 * realpath of every reachable source module OMP must rewrite at load time.
 * Relative imports, package `imports` aliases, and ESM bare dependencies are
 * graph-owned recursively because compiled Bun cannot resolve runtime
 * `node_modules` from those modules. Graph-owned CommonJS modules also own
 * their relative and bare CommonJS descendants, which are evaluated by the
 * synchronous bridge. Resolved ESM imports inside third-party dependencies
 * omit the reload tag so their importer paths stay query-free.
 */
async function collectExtensionModules(entryRealPath: string): Promise<ExtensionModuleGraph> {
	const modules = new Map<string, string>();
	const commonJsPaths = new Set<string>();
	const synchronousSourcePaths = new Set<string>();
	const queuedCacheBustResolvedImports = new Map<string, boolean>([[entryRealPath, true]]);
	const queuedModuleKinds = new Map<string, ExtensionModuleKind>([[entryRealPath, "esm"]]);
	const queuedEsmBranchPaths = new Set<string>();
	const queue: Array<{
		file: string;
		cacheBustResolvedImports: boolean;
		moduleKind?: ExtensionModuleKind;
		esmBranch?: boolean;
	}> = [{ file: entryRealPath, cacheBustResolvedImports: true, moduleKind: "esm" }];
	while (queue.length > 0) {
		const item = queue.pop();
		if (!item) {
			continue;
		}
		const file = item.file;
		const cacheBustResolvedImports = queuedCacheBustResolvedImports.get(file) ?? item.cacheBustResolvedImports;
		const inheritedModuleKind = queuedModuleKinds.get(file) ?? item.moduleKind;
		const esmBranch = queuedEsmBranchPaths.has(file) || item.esmBranch === true;
		if (modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.set(file, source);
		const analysis = getExtensionSourceAnalysis(source, file);
		const sourceIsCommonJs = await isGraphOwnedCommonJsModule(
			file,
			entryRealPath,
			analysis.sourceType,
			inheritedModuleKind,
		);
		if (sourceIsCommonJs) {
			commonJsPaths.add(file);
		}
		const dir = path.dirname(file);
		const references = analysis.references;
		for (const reference of references) {
			const specifier = reference.specifier;
			try {
				let resolved: string | null = null;
				let nextCacheBustResolvedImports = cacheBustResolvedImports;
				let resolvedModuleKind: ExtensionModuleKind | undefined;
				let resolvedEsmBranch = false;
				let requiresNativeAddonRewrite = false;
				let requiresSynchronousSourceHook = false;
				let synchronousSourceUpgraded = false;
				const isRequired = reference.kind === "require";
				if (specifier.startsWith(".")) {
					const candidate = isRequired
						? await resolveRelativeCommonJsRequire(specifier, file)
						: Bun.resolveSync(specifier, dir);
					if (candidate && hasSourceModuleExtension(candidate)) {
						const inheritedTargetKind = isRequired
							? sourceIsCommonJs
								? "commonjs"
								: undefined
							: sourceIsCommonJs
								? "commonjs"
								: esmBranch
									? "esm"
									: undefined;
						const targetIsCommonJs = await isCommonJsModulePath(candidate, undefined, inheritedTargetKind);
						const isCommonJsDescendant = isRequired && sourceIsCommonJs && targetIsCommonJs;
						requiresNativeAddonRewrite =
							isRequired && !isCommonJsDescendant && (await moduleRequiresNativeAddon(candidate));
						if (!isRequired || isCommonJsDescendant || requiresNativeAddonRewrite || !targetIsCommonJs) {
							resolved = await realpathOrSelf(candidate);
							resolvedModuleKind = targetIsCommonJs ? "commonjs" : "esm";
							resolvedEsmBranch = !targetIsCommonJs && esmBranch;
							requiresSynchronousSourceHook = isRequired && !targetIsCommonJs;
						}
					}
				} else if (specifier.startsWith("#")) {
					const candidate = packageImportPath(specifier, await resolvePackageImportSpecifier(specifier, file));
					if (candidate) {
						const inheritedTargetKind = isRequired
							? sourceIsCommonJs
								? "commonjs"
								: undefined
							: sourceIsCommonJs
								? "commonjs"
								: esmBranch
									? "esm"
									: undefined;
						const targetIsCommonJs = await isCommonJsModulePath(candidate, undefined, inheritedTargetKind);
						const isCommonJsDescendant = isRequired && sourceIsCommonJs && targetIsCommonJs;
						requiresNativeAddonRewrite =
							isRequired && !isCommonJsDescendant && (await moduleRequiresNativeAddon(candidate));
						if (!isRequired || isCommonJsDescendant || requiresNativeAddonRewrite || !targetIsCommonJs) {
							resolved = candidate;
							resolvedModuleKind = targetIsCommonJs ? "commonjs" : "esm";
							resolvedEsmBranch = !targetIsCommonJs && esmBranch;
							requiresSynchronousSourceHook = isRequired && !targetIsCommonJs;
						}
					}
				} else if (
					isBareExtensionDependencySpecifier(specifier) &&
					!remapLegacyPiSpecifier(specifier) &&
					specifier !== "typebox" &&
					specifier !== "@sinclair/typebox"
				) {
					const dependencyEntry = isRequired
						? await resolveExtensionBareRequire(specifier, file)
						: await resolveExtensionBareDependency(specifier, file);
					const isHookableEntry = Boolean(dependencyEntry && hasSourceModuleExtension(dependencyEntry));
					const selectedEsmBranch =
						!isRequired &&
						isHookableEntry &&
						dependencyEntry !== null &&
						(await isSelectedNoTypeEsmPackageBranch(specifier, file, dependencyEntry));
					const inheritedTargetKind = isRequired
						? sourceIsCommonJs
							? "commonjs"
							: undefined
						: selectedEsmBranch
							? "esm"
							: undefined;
					const isCommonJsEntry =
						isHookableEntry && dependencyEntry
							? await isCommonJsModulePath(dependencyEntry, undefined, inheritedTargetKind)
							: false;
					if (isHookableEntry && dependencyEntry && (!isRequired || (sourceIsCommonJs && isCommonJsEntry))) {
						resolved = await realpathOrSelf(dependencyEntry);
					} else if (isHookableEntry && dependencyEntry && isRequired && !isCommonJsEntry) {
						resolved = await realpathOrSelf(dependencyEntry);
						requiresSynchronousSourceHook = true;
					} else if (isHookableEntry && dependencyEntry && isRequired) {
						requiresNativeAddonRewrite = await moduleRequiresNativeAddon(dependencyEntry);
						if (requiresNativeAddonRewrite) {
							resolved = await realpathOrSelf(dependencyEntry);
						}
					}
					if (resolved) {
						resolvedModuleKind = isCommonJsEntry ? "commonjs" : "esm";
						resolvedEsmBranch = selectedEsmBranch && !isCommonJsEntry;
					}
					nextCacheBustResolvedImports = false;
				}
				if (
					resolved &&
					(requiresNativeAddonRewrite ||
						requiresSynchronousSourceHook ||
						(synchronousSourcePaths.has(file) && resolvedModuleKind === "esm"))
				) {
					synchronousSourceUpgraded = !synchronousSourcePaths.has(resolved);
					synchronousSourcePaths.add(resolved);
				}
				if (resolved) {
					const queuedCacheBust = queuedCacheBustResolvedImports.get(resolved) ?? false;
					const mergedCacheBust = queuedCacheBust || nextCacheBustResolvedImports;
					queuedCacheBustResolvedImports.set(resolved, mergedCacheBust);
					const queuedModuleKind = queuedModuleKinds.get(resolved);
					const mergedEsmBranch = queuedEsmBranchPaths.has(resolved) || resolvedEsmBranch;
					const mergedModuleKind =
						queuedModuleKind && resolvedModuleKind && queuedModuleKind !== resolvedModuleKind
							? mergedEsmBranch
								? "esm"
								: "commonjs"
							: (queuedModuleKind ?? resolvedModuleKind);
					if (mergedModuleKind) {
						queuedModuleKinds.set(resolved, mergedModuleKind);
					}
					if (mergedEsmBranch) {
						queuedEsmBranchPaths.add(resolved);
					}
					if (modules.has(resolved) && (queuedModuleKind !== mergedModuleKind || synchronousSourceUpgraded)) {
						modules.delete(resolved);
						commonJsPaths.delete(resolved);
					}
					if (!modules.has(resolved)) {
						queue.push({
							file: resolved,
							cacheBustResolvedImports: mergedCacheBust,
							moduleKind: mergedModuleKind,
							esmBranch: resolvedEsmBranch,
						});
					}
				}
			} catch {
				// Unresolvable import (e.g. a type-only path); skip it.
			}
		}
	}
	for (const [modulePath, source] of modules) {
		if (commonJsPaths.has(modulePath)) {
			modules.set(modulePath, await rewriteExtensionSpecifiers(source, modulePath, true));
		} else if (synchronousSourcePaths.has(modulePath)) {
			modules.set(modulePath, await rewriteLegacyExtensionSource(source, modulePath));
		}
	}
	return {
		modules,
		commonJsPaths,
		synchronousSourcePaths,
		cacheBustResolvedImportModules: new Set(
			[...queuedCacheBustResolvedImports]
				.filter(([modulePath, enabled]) => enabled && modules.has(modulePath))
				.map(([modulePath]) => modulePath),
		),
	};
}

/** Test seam for compiled-binary dependency graph discovery and rewriting. */
export async function __collectLegacyPiExtensionSourcesForTests(
	entryPath: string,
): Promise<ReadonlyMap<string, string>> {
	const entryRealPath = await realpathOrSelf(path.resolve(entryPath));
	const graph = await collectExtensionModules(entryRealPath);
	return graph.modules;
}

/**
 * Discovers CommonJS export names Bun normally exposes to ESM importers. The
 * bridge must declare them statically because its default export is synthetic.
 */
const COMMONJS_NAMED_EXPORT_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function collectCommonJsExportAnalysis(
	ast: ParseResult,
): Pick<ExtensionSourceAnalysis, "commonJsNamedExports" | "commonJsReexportSpecifiers"> {
	const names = new Set<string>();
	const reexportSpecifiers = new Set<string>();
	for (const { node, scope } of collectScopedAstNodes(
		ast,
		candidate => candidate.type === "CallExpression" || candidate.type === "AssignmentExpression",
	)) {
		if (node.type === "CallExpression") {
			const callee = asAstNode(node.callee);
			if (isUncomputedMember(callee, "Object", "defineProperty") && !scopeHasBinding(scope, OBJECT_BINDING)) {
				const target = nodeArgument(node, 0);
				const property = nodeArgument(node, 1);
				if (
					isUnshadowedExportsTarget(target, scope) &&
					property?.type === "StringLiteral" &&
					typeof property.value === "string" &&
					property.value !== "default" &&
					COMMONJS_NAMED_EXPORT_IDENTIFIER.test(property.value)
				) {
					names.add(property.value);
				}
				continue;
			}
			if (isIdentifier(callee, "__exportStar")) {
				const sourceCall = nodeArgument(node, 0);
				const target = nodeArgument(node, 1);
				if (isUnshadowedExportsTarget(target, scope) && isGlobalRequireCall(sourceCall, scope)) {
					const argument = nodeArgument(sourceCall, 0);
					if (argument?.type === "StringLiteral" && typeof argument.value === "string") {
						reexportSpecifiers.add(argument.value);
					}
				}
				continue;
			}
		}
		if (node.type !== "AssignmentExpression" || node.operator !== "=") continue;
		const left = asAstNode(node.left);
		if (left?.type !== "MemberExpression") continue;
		const propertyName = staticMemberPropertyName(left);
		const object = asAstNode(left.object);
		if (propertyName !== null && isUnshadowedExportsTarget(object, scope)) {
			if (propertyName !== "default" && COMMONJS_NAMED_EXPORT_IDENTIFIER.test(propertyName)) names.add(propertyName);
			continue;
		}
		if (!isUncomputedMember(left, "module", "exports") || scopeHasBinding(scope, MODULE_BINDING)) continue;
		const right = asAstNode(node.right);
		if (right?.type === "ObjectExpression") {
			const properties = nodeArray(right, "properties");
			if (properties) {
				for (const value of properties) {
					const property = asAstNode(value);
					if (!property || (property.type !== "ObjectProperty" && property.type !== "ObjectMethod")) continue;
					const name = staticObjectPropertyName(property);
					if (name && name !== "default" && COMMONJS_NAMED_EXPORT_IDENTIFIER.test(name)) names.add(name);
				}
			}
			continue;
		}
		if (isGlobalRequireCall(right, scope)) {
			const argument = nodeArgument(right, 0);
			if (argument?.type === "StringLiteral" && typeof argument.value === "string")
				reexportSpecifiers.add(argument.value);
		}
	}
	return { commonJsNamedExports: [...names], commonJsReexportSpecifiers: [...reexportSpecifiers] };
}

function collectCommonJsNamedExports(source: string, modulePath: string, visited = new Set<string>()): string[] {
	let realModulePath = modulePath;
	try {
		realModulePath = fs.realpathSync(modulePath);
	} catch {
		// The caller's path remains the stable cycle key when realpath fails.
	}
	if (visited.has(realModulePath)) return [];
	visited.add(realModulePath);
	const analysis = getExtensionSourceAnalysis(source, modulePath);
	const names = new Set(analysis.commonJsNamedExports);
	const nativeRequire = createRequire(modulePath);
	for (const specifier of analysis.commonJsReexportSpecifiers) {
		try {
			const resolved = fs.realpathSync(nativeRequire.resolve(specifier));
			const reexportedSource = rewriteExtensionSpecifiersFromCache(fs.readFileSync(resolved, "utf8"), resolved);
			for (const name of collectCommonJsNamedExports(reexportedSource, resolved, visited)) names.add(name);
		} catch {
			// Native modules and non-source re-exports do not expose analyzable names.
		}
	}
	return [...names];
}

/**
 * The shared evaluator gives ESM imports and sibling `require()` calls the
 * same `module.exports` value and cycle-aware cache.
 */
function synthesizeCommonJsDefaultModule(modulePath: string, source: string, targetPath = modulePath): string {
	let commonJsSource = source;
	if (commonJsSource.startsWith("#!")) {
		const firstLineEnd = commonJsSource.indexOf("\n");
		commonJsSource = firstLineEnd === -1 ? "" : commonJsSource.slice(firstLineEnd + 1);
	}

	const executableSource = targetPath.endsWith(".cts")
		? commonJsTypeScriptTranspiler.transformSync(commonJsSource)
		: commonJsSource;
	commonJsModuleDefinitions.set(modulePath, {
		source: executableSource,
		filename: targetPath,
		dirname: path.dirname(targetPath),
	});
	commonJsModuleCache.delete(modulePath);
	const exportsBinding = "__ompLegacyPiCommonJsExports";
	const namedExports = collectCommonJsNamedExports(executableSource, targetPath)
		.map(
			(name, index) =>
				`const __ompLegacyPiCommonJsExport${index} = ${exportsBinding}[${JSON.stringify(name)}]; export { __ompLegacyPiCommonJsExport${index} as ${name} };`,
		)
		.join("\n");
	return `const ${exportsBinding} = globalThis[${JSON.stringify(COMMONJS_REQUIRE_GLOBAL)}](${JSON.stringify(modulePath)});\nexport default ${exportsBinding};\n${namedExports}\n`;
}

/**
 * Linkedom's canvas bridge uses its bundled fallback because OMP does not ship
 * native canvas.
 */
async function prepareCommonJsDefaultModule(modulePath: string, source: string): Promise<string> {
	const packageRoot = await findPackageRoot(modulePath);
	if (!packageRoot) {
		return synthesizeCommonJsDefaultModule(modulePath, source);
	}
	const manifest = await readPackageManifest(packageRoot);
	const packageRelativePath = path.relative(packageRoot, modulePath).split(path.sep).join("/");
	if (manifest?.name !== "linkedom" || packageRelativePath !== "commonjs/canvas.cjs") {
		return synthesizeCommonJsDefaultModule(modulePath, source);
	}

	const targetPath = path.join(packageRoot, "commonjs", "canvas-shim.cjs");
	commonJsFallbackModulePaths.set(modulePath, targetPath);
	return synthesizeCommonJsDefaultModule(modulePath, await Bun.file(targetPath).text(), targetPath);
}

/**
 * Install exact-path load hooks for the current extension graph. ESM/TS source
 * retains the async rewrite path. Graph-owned CommonJS modules and native-addon
 * loaders stay synchronous because Bun rejects `require()` targets backed by
 * async `onLoad` callbacks.
 */
async function installExtensionGraphHook(
	entryRealPath: string,
	modules: Map<string, string>,
	commonJsPaths: Set<string>,
	synchronousSourcePaths: ReadonlySet<string>,
	cacheBustResolvedImportModules: ReadonlySet<string>,
): Promise<{ asyncModules: Map<string, string> }> {
	const asyncModules = new Map<string, string>();
	for (const [modulePath, source] of modules) {
		if (commonJsPaths.has(modulePath) || synchronousSourcePaths.has(modulePath)) {
			continue;
		}
		asyncModules.set(modulePath, source);
	}

	if (asyncModules.size > 0) {
		const alternation = [...asyncModules.keys()].map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(`${entryRealPath}\0async\0${[...asyncModules.keys()].join("\0")}`).toString(36);
		Bun.plugin({
			name: `omp:legacy-pi-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					const mtimeTag = queryIndex >= 0 ? args.path.slice(queryIndex + "?mtime=".length) : null;
					// A later reload can upgrade this module to synchronous loading (a
					// new `require()` edge reaches it) without re-registering hooks:
					// this filter keeps matching and `require()` rejects async onLoad
					// results, so serve the pre-rewritten synchronous source inline.
					// `ensureExtensionGraphHook` refreshes it on every (re)load.
					const synchronousSource = synchronousModuleSources.get(sourcePath);
					if (synchronousSource !== undefined) {
						return { contents: synchronousSource, loader: getLoader(sourcePath) };
					}
					const cached = asyncModules.get(sourcePath);
					const resolvedImportMtimeTag = cacheBustResolvedImportModules.has(sourcePath) ? mtimeTag : null;
					return (async () => {
						let raw: string;
						if (cached !== undefined) {
							// consume-once: preserves ?mtime edit-pickup for re-imports
							asyncModules.delete(sourcePath);
							raw = cached;
						} else {
							raw = await Bun.file(sourcePath).text();
						}
						return {
							contents: await rewriteLegacyExtensionSource(raw, sourcePath, mtimeTag, resolvedImportMtimeTag),
							loader: getLoader(sourcePath),
						};
					})();
				});
			},
		});
	}

	if (commonJsPaths.size > 0) {
		const alternation = [...commonJsPaths].map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(`${entryRealPath}\0commonjs\0${[...commonJsPaths].join("\0")}`).toString(36);
		Bun.plugin({
			name: `omp:legacy-pi-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					let source = commonJsModuleSources.get(sourcePath);
					if (source === undefined) {
						const targetPath = commonJsFallbackModulePaths.get(sourcePath) ?? sourcePath;
						const raw = rewriteExtensionSpecifiersFromCache(fs.readFileSync(targetPath, "utf8"), sourcePath);
						source = synthesizeCommonJsDefaultModule(sourcePath, raw, targetPath);
					}
					return { contents: source, loader: getLoader(sourcePath) };
				});
			},
		});
	}

	if (synchronousSourcePaths.size > 0) {
		const alternation = [...synchronousSourcePaths].map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(`${entryRealPath}\0sync-source\0${[...synchronousSourcePaths].join("\0")}`).toString(36);
		Bun.plugin({
			name: `omp:legacy-pi-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					const source = synchronousModuleSources.get(sourcePath);
					if (source === undefined) {
						throw new Error(`Missing pre-rewritten synchronous extension source: ${sourcePath}`);
					}
					return { contents: source, loader: getLoader(sourcePath) };
				});
			},
		});
	}
	return { asyncModules };
}

/**
 * Ensure every currently reachable extension source module has a load-time
 * rewrite hook. The entry graph can grow across reloads, so each call collects
 * the current graph and registers hooks for paths not covered by earlier loads.
 *
 * Returns a clearable handle to drop cached sources that weren't consumed
 * during the initial load; `undefined` when no new modules were discovered.
 */
async function ensureExtensionGraphHook(entryRealPath: string): Promise<{ clear(): void } | undefined> {
	const {
		modules: currentModules,
		commonJsPaths,
		cacheBustResolvedImportModules: discoveredCacheBustModules,
		synchronousSourcePaths,
	} = await collectExtensionModules(entryRealPath);
	let cacheBustResolvedImportModules = extensionGraphCacheBustResolvedImportModules.get(entryRealPath);
	if (!cacheBustResolvedImportModules) {
		cacheBustResolvedImportModules = new Set<string>();
		extensionGraphCacheBustResolvedImportModules.set(entryRealPath, cacheBustResolvedImportModules);
	}
	for (const modulePath of discoveredCacheBustModules) {
		cacheBustResolvedImportModules.add(modulePath);
	}
	for (const [modulePath, source] of currentModules) {
		if (commonJsPaths.has(modulePath)) {
			commonJsModuleSources.set(modulePath, await prepareCommonJsDefaultModule(modulePath, source));
			commonJsGraphModulePaths.add(modulePath);
		}
		if (synchronousSourcePaths.has(modulePath)) {
			synchronousModuleSources.set(modulePath, source);
		} else if (synchronousModuleSources.has(modulePath)) {
			// The path lost its require() edges on this walk, but the permanent
			// hooks installed while it was synchronous still serve it from this
			// map — keep the pre-rewritten bytes fresh instead of serving the
			// stale snapshot from the walk that flagged it.
			synchronousModuleSources.set(modulePath, await rewriteLegacyExtensionSource(source, modulePath));
		}
	}
	let hookedModules = extensionGraphHookModules.get(entryRealPath);
	if (!hookedModules) {
		hookedModules = new Set<string>();
		extensionGraphHookModules.set(entryRealPath, hookedModules);
	}

	const pendingModules = new Map<string, string>();
	const pendingCommonJsPaths = new Set<string>();
	const pendingSynchronousSourcePaths = new Set<string>();
	for (const [modulePath, source] of currentModules) {
		if (!hookedModules.has(modulePath)) {
			pendingModules.set(modulePath, source);
			if (commonJsPaths.has(modulePath)) {
				pendingCommonJsPaths.add(modulePath);
			}
			if (synchronousSourcePaths.has(modulePath)) {
				pendingSynchronousSourcePaths.add(modulePath);
			}
		}
	}
	if (pendingModules.size === 0 && commonJsPaths.size === 0) {
		return undefined;
	}

	let asyncModules = new Map<string, string>();
	if (pendingModules.size > 0) {
		({ asyncModules } = await installExtensionGraphHook(
			entryRealPath,
			pendingModules,
			pendingCommonJsPaths,
			pendingSynchronousSourcePaths,
			cacheBustResolvedImportModules,
		));
		for (const modulePath of pendingModules.keys()) {
			hookedModules.add(modulePath);
		}
	}
	return {
		clear() {
			asyncModules.clear();
			for (const modulePath of commonJsPaths) {
				commonJsModuleSources.delete(modulePath);
				commonJsModuleDefinitions.delete(modulePath);
				commonJsModuleCache.delete(modulePath);
			}
		},
	};
}

/**
 * Load a legacy Pi extension module from its real on-disk location.
 *
 * The extension runs in place, so its `import.meta.url` is the real source file
 * and `__dirname`-relative `readFileSync` asset loads (HTML/CSS bundled next to
 * the entry) resolve exactly as they do under the original Pi runtime — no
 * temp-directory mirroring and no asset copying. An `onLoad` hook scoped to the
 * entry's source graph rewrites only host-resolved compatibility imports in the
 * extension's own source; everything else resolves natively.
 */
export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	// Bun reports the realpath of a loaded module to `onLoad` and exposes it as
	// `import.meta.url`. Resolve symlinks here too (macOS `/var`→`/private/var`,
	// `bun link`/pnpm installs) so the rewrite filter matches the path Bun
	// actually hands the hook.
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureLegacyPiOverridesReady();
	const pendingSources = await ensureExtensionGraphHook(entryRealPath);
	try {
		// Dynamic import is required: legacy extension entry paths are user/plugin supplied at runtime.
		// On POSIX, use the raw filesystem path so Bun keys the `?mtime`
		// suffix as part of the module identity; Bun ignores query strings on
		// `file://` specifiers, which would serve stale edited source.
		const entrySpecifier =
			process.platform === "win32" || isBundledVirtualSpecifier(entryRealPath)
				? toImportSpecifier(entryRealPath)
				: entryRealPath;
		return await import(`${entrySpecifier}?mtime=${nextLegacyPiLoadTag()}`);
	} finally {
		// Drop whatever the initial import didn't consume: graph modules only
		// reached by lazy dynamic imports must be read from disk at their actual
		// import time, not served from this load-time snapshot.
		pendingSources?.clear();
	}
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): LegacyPiResolveResult | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	// Primary: resolve the canonical @oh-my-pi/* specifier from the host binary
	// location. Works in dev mode and in source-link installs.
	try {
		return toLegacyPiResolveResult(resolveCanonicalPiSpecifier(remappedSpecifier));
	} catch {
		// Fallback for compiled binary mode: the bundled packages live inside
		// /$bunfs/root and aren't reachable by filesystem resolution. Prefer the
		// canonical specifier against the importing file's directory when the
		// plugin installed @oh-my-pi peer deps, then try the original legacy
		// specifier for plugins that still vendor only @mariozechner or
		// @earendil-works peer deps.
		const importerDir = path.dirname(args.importer);
		try {
			return toLegacyPiResolveResult(Bun.resolveSync(remappedSpecifier, importerDir));
		} catch {
			try {
				return toLegacyPiResolveResult(Bun.resolveSync(args.path, importerDir));
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): LegacyPiResolveResult | undefined {
	return TYPEBOX_SHIM_PATH ? toLegacyPiResolveResult(TYPEBOX_SHIM_PATH) : undefined;
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "omp:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
			build.onResolve({ filter: /^omp-legacy-pi-bundled:.+$/, namespace: "file" }, args =>
				resolveBundledVirtualSpecifier(args.path),
			);
			build.onResolve({ filter: /.*/, namespace: BUNDLED_VIRTUAL_NAMESPACE }, args =>
				resolveBundledVirtualSpecifier(args.path),
			);
			// Compiled mode serves `omp-legacy-pi-bundled:<key>` imports from
			// live host module references. No bunfs path leaves this loader.
			build.onLoad({ filter: /.*/, namespace: BUNDLED_VIRTUAL_NAMESPACE }, async args => {
				return { contents: await synthesizeBundledModuleSource(args.path), loader: "js" };
			});
		},
	});
}

/** Test seam: clears the memoized canonical specifier resolutions. */
export function __resetLegacyPiResolutionCache(): void {
	clearLegacyPiResolutionCaches();
}
