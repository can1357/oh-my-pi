#!/usr/bin/env bun
/**
 * inline-functions — inline tiny, void, single-purpose helper functions into
 * their call sites, *prettily*.
 *
 * The motivating shape is a dispatcher full of one-call-site handlers:
 *
 *   function handleX(currentItem: Item | null, rawEvent: Record<string, unknown>): void {
 *     if (currentItem?.type !== "reasoning") return;
 *     appendPart(currentItem, (rawEvent as { part: Part }).part);
 *   }
 *   // ...
 *   handleX(runtime.currentItem, rawEvent);
 *
 * A naive inline is WRONG: the helper's bare `return` would return from the
 * *caller* (and skip whatever ran after the call). The pretty, semantics-
 * preserving transform inverts the leading guard clauses into one positive
 * wrapper — no IIFE, no synthetic block scope:
 *
 *   if (runtime.currentItem?.type === "reasoning") {
 *     appendPart(runtime.currentItem, (rawEvent as { part: Part }).part);
 *   }
 *
 * What it inlines (every condition must hold):
 *   - top-level, non-exported `function` declarations (refs cannot escape the
 *     module, so single-file reference analysis is exact);
 *   - no async / generator / overloads / type parameters / `this` param;
 *   - simple identifier params only — no destructuring, rest, or defaults;
 *   - no parameter is reassigned or incremented inside the body;
 *   - body = an optional run of leading guard clauses `if (cond) return;`
 *     (bare return, no `else`) followed by >=1 tail statements;
 *   - the tail escapes nowhere: no `return` bound to the helper, no top-level
 *     `break`/`continue`, no `this`/`arguments`/`super`, not recursive;
 *   - every reference is a call in statement position (return value discarded);
 *   - no call uses spread args or more args than params.
 *
 * Correctness guarantees:
 *   - Guard inversion uses De Morgan + comparator flips; `&&` short-circuit
 *     reproduces the original sequential-guard evaluation order exactly, so the
 *     transform is sound even when guard conditions have side effects.
 *   - By default, plain member/element access is treated as effect-free and
 *     inlined directly into the (possibly inverted) guard — the prettier result,
 *     matching how these handlers read by hand. Arguments with real side effects
 *     are still hoisted to a `const` that runs unconditionally and in source
 *     order (single evaluation). `--strict-effects` upgrades this to exact call
 *     semantics: every used argument is snapshotted left-to-right before the
 *     body (so getters/Proxies/throws and later-argument mutations are
 *     preserved), at the cost of more `const` temporaries. Unused pure args are
 *     dropped; unused impure args are still evaluated for their effects.
 *   - A helper is skipped if a free identifier in its body could resolve to a
 *     different binding at a call site (shadow check against every intermediate
 *     scope). Guardless inlining renames tail locals that would redeclare a name
 *     already live in the target block.
 *
 * Usage:
 *   bun scripts/inline-functions.ts <file...> [flags]      # dry-run diff
 *   bun scripts/inline-functions.ts <file...> -w           # apply + format
 *
 * Flags:
 *   -w, --write              apply edits in place (default: dry-run diff)
 *       --name <regex>       only inline functions whose name matches
 *       --max-statements <n> max tail statements (default: 3)
 *       --list               report candidates, make no edits
 *       --no-format          skip the biome format pass after --write
 *       --strict-effects     hoist every used argument (exact call semantics)
 *   -v, --verbose            print per-function skip reasons
 */

import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import type {
	CallExpression,
	Expression,
	FunctionDeclaration,
	Identifier,
	ParameterDeclaration,
	SourceFile,
	Statement,
} from "ts-morph";
import { IndentationText, Node, Project, SyntaxKind, VariableDeclarationKind } from "ts-morph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParamInfo {
	name: string;
	param: ParameterDeclaration;
	refs: Identifier[];
}

interface CallSite {
	stmt: Statement;
	call: CallExpression;
}

interface Candidate {
	fn: FunctionDeclaration;
	name: string;
	params: ParamInfo[];
	guards: Expression[];
	tail: Statement[];
	freeNames: Set<string>;
	callSites: CallSite[];
}

/** A text replacement, in absolute source positions, applied to a node's own text. */
interface Edit {
	start: number;
	end: number;
	text: string;
}

export interface Options {
	maxStatements: number;
	nameFilter: RegExp | undefined;
	verbose: boolean;
	strictEffects: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Logical-operator precedence, for parenthesizing inverted conditions. */
const PREC_OR = 1;
const PREC_AND = 2;
const PREC_ATOM = 3;

interface NegatedExpr {
	text: string;
	prec: number;
}

const FLIP_COMPARATOR: Record<string, string> = {
	"===": "!==",
	"!==": "===",
	"==": "!=",
	"!=": "==",
	"<": ">=",
	">": "<=",
	"<=": ">",
	">=": "<",
};

const ASSIGNMENT_OPS = new Set([
	"=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"**=",
	"<<=",
	">>=",
	">>>=",
	"&=",
	"|=",
	"^=",
	"&&=",
	"||=",
	"??=",
]);

// ---------------------------------------------------------------------------
// Expression classification
// ---------------------------------------------------------------------------

function isLiteralExpr(node: Node): boolean {
	return (
		Node.isStringLiteral(node) ||
		Node.isNumericLiteral(node) ||
		Node.isBigIntLiteral(node) ||
		Node.isTrueLiteral(node) ||
		Node.isFalseLiteral(node) ||
		Node.isNullLiteral(node) ||
		Node.isRegularExpressionLiteral(node) ||
		Node.isNoSubstitutionTemplateLiteral(node)
	);
}

function unwrapParens(node: Node): Node {
	let n = node;
	while (Node.isParenthesizedExpression(n)) n = n.getExpression();
	return n;
}

/**
 * Render `node` as an expression statement, parenthesizing the forms that would
 * otherwise be misparsed at statement position (object literal -> block,
 * function/class expression -> declaration).
 */
function asExprStatement(node: Node): string {
	const text = node.getText();
	if (Node.isParenthesizedExpression(node)) return `${text};`;
	const inner = unwrapParens(node);
	if (Node.isObjectLiteralExpression(inner) || Node.isFunctionExpression(inner) || Node.isClassExpression(inner)) {
		return `(${text});`;
	}
	return `${text};`;
}

/**
 * No observable side effects — safe to drop, reorder, or evaluate lazily.
 *
 * In `strict` mode, property/element access is treated as effectful (a getter,
 * Proxy trap, or nullish base can throw or mutate), so such arguments are
 * hoisted to a `const` that runs eagerly, in source order, exactly as a real
 * call would evaluate them. The default treats plain member access as pure — the
 * prettier result, and the common case for streaming dispatch handlers.
 */
function isPureExpr(node: Node, strict: boolean): boolean {
	if (Node.isParenthesizedExpression(node)) return isPureExpr(node.getExpression(), strict);
	if (Node.isIdentifier(node) || Node.isThisExpression(node) || isLiteralExpr(node)) return true;
	if (Node.isPropertyAccessExpression(node)) return !strict && isPureExpr(node.getExpression(), strict);
	if (Node.isElementAccessExpression(node)) {
		if (strict) return false;
		const arg = node.getArgumentExpression();
		return isPureExpr(node.getExpression(), strict) && arg !== undefined && isPureExpr(arg, strict);
	}
	if (Node.isNonNullExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
		return isPureExpr(node.getExpression(), strict);
	}
	if (Node.isTypeOfExpression(node) || Node.isVoidExpression(node)) return isPureExpr(node.getExpression(), strict);
	if (Node.isPrefixUnaryExpression(node)) {
		const op = node.getOperatorToken();
		if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) return false;
		return isPureExpr(node.getOperand(), strict);
	}
	if (Node.isConditionalExpression(node)) {
		return (
			isPureExpr(node.getCondition(), strict) &&
			isPureExpr(node.getWhenTrue(), strict) &&
			isPureExpr(node.getWhenFalse(), strict)
		);
	}
	if (Node.isBinaryExpression(node)) {
		if (ASSIGNMENT_OPS.has(node.getOperatorToken().getText())) return false;
		return isPureExpr(node.getLeft(), strict) && isPureExpr(node.getRight(), strict);
	}
	if (Node.isTemplateExpression(node))
		return node.getTemplateSpans().every(s => isPureExpr(s.getExpression(), strict));
	// Defining a closure is itself side-effect-free; we substitute the value, never invoke it.
	if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return true;
	return false;
}

/**
 * Cheap and safe to repeat verbatim at multiple use sites (leaves / member
 * chains, no calls). In `strict` mode member/element access is not duplicable
 * (it must be hoisted so it evaluates exactly once, eagerly).
 */
function isDuplicable(node: Node, strict: boolean): boolean {
	if (Node.isParenthesizedExpression(node)) return isDuplicable(node.getExpression(), strict);
	if (Node.isIdentifier(node) || Node.isThisExpression(node) || isLiteralExpr(node)) return true;
	if (Node.isPropertyAccessExpression(node)) return !strict && isDuplicable(node.getExpression(), strict);
	if (Node.isElementAccessExpression(node)) {
		if (strict) return false;
		const arg = node.getArgumentExpression();
		return isDuplicable(node.getExpression(), strict) && arg !== undefined && isDuplicable(arg, strict);
	}
	if (Node.isNonNullExpression(node) || Node.isAsExpression(node)) return isDuplicable(node.getExpression(), strict);
	return false;
}

/** Would this expression bind incorrectly when spliced into an arbitrary expression position? */
function argNeedsParens(node: Node): boolean {
	if (Node.isParenthesizedExpression(node)) return false;
	return (
		Node.isBinaryExpression(node) ||
		Node.isConditionalExpression(node) ||
		Node.isArrowFunction(node) ||
		Node.isFunctionExpression(node) ||
		Node.isAwaitExpression(node) ||
		Node.isYieldExpression(node) ||
		Node.isAsExpression(node) ||
		Node.isSatisfiesExpression(node) ||
		Node.isPrefixUnaryExpression(node) ||
		Node.isPostfixUnaryExpression(node) ||
		Node.isTypeOfExpression(node) ||
		Node.isVoidExpression(node) ||
		Node.isDeleteExpression(node)
	);
}

// ---------------------------------------------------------------------------
// Guard inversion
// ---------------------------------------------------------------------------

/** Apply the substitution edits that fall within `node`'s range to its source text. */
function subText(node: Node, edits: readonly Edit[]): string {
	const start = node.getStart();
	const end = node.getEnd();
	const local = edits.filter(e => e.start >= start && e.end <= end).sort((a, b) => b.start - a.start);
	let text = node.getText();
	for (const e of local) text = text.slice(0, e.start - start) + e.text + text.slice(e.end - start);
	return text;
}

function logicalPrec(node: Node): number {
	let n: Node = node;
	while (Node.isParenthesizedExpression(n)) n = n.getExpression();
	if (Node.isBinaryExpression(n)) {
		const op = n.getOperatorToken().getText();
		if (op === "||") return PREC_OR;
		if (op === "&&") return PREC_AND;
	}
	return PREC_ATOM;
}

/** Negated, param-substituted text of `expr` (its logical complement), prettified. */
function negate(expr: Expression, edits: readonly Edit[]): NegatedExpr {
	let e: Expression = expr;
	while (Node.isParenthesizedExpression(e)) e = e.getExpression();

	if (Node.isPrefixUnaryExpression(e) && e.getOperatorToken() === SyntaxKind.ExclamationToken) {
		const operand = e.getOperand();
		return { text: subText(operand, edits), prec: logicalPrec(operand) };
	}

	if (Node.isBinaryExpression(e)) {
		const op = e.getOperatorToken().getText();
		const flipped = FLIP_COMPARATOR[op];
		if (flipped) {
			return { text: `${subText(e.getLeft(), edits)} ${flipped} ${subText(e.getRight(), edits)}`, prec: PREC_ATOM };
		}
		if (op === "&&") {
			// !(a && b) === !a || !b
			const l = negate(e.getLeft(), edits);
			const r = negate(e.getRight(), edits);
			return { text: `${l.text} || ${r.text}`, prec: PREC_OR };
		}
		if (op === "||") {
			// !(a || b) === !a && !b
			const l = negate(e.getLeft(), edits);
			const r = negate(e.getRight(), edits);
			return { text: `${wrap(l, PREC_AND)} && ${wrap(r, PREC_AND)}`, prec: PREC_AND };
		}
	}

	return { text: `!(${subText(e, edits)})`, prec: PREC_ATOM };
}

function wrap(part: NegatedExpr, minPrec: number): string {
	return part.prec < minPrec ? `(${part.text})` : part.text;
}

/** Combine leading guard conditions into the single positive run-condition. */
function combineGuards(guards: readonly Expression[], edits: readonly Edit[]): string {
	const parts = guards.map(g => negate(g, edits));
	if (parts.length === 1) return parts[0].text;
	return parts.map(p => wrap(p, PREC_AND)).join(" && ");
}

// ---------------------------------------------------------------------------
// Scope / name helpers
// ---------------------------------------------------------------------------

function isFunctionLike(node: Node): boolean {
	return (
		Node.isFunctionDeclaration(node) ||
		Node.isFunctionExpression(node) ||
		Node.isArrowFunction(node) ||
		Node.isMethodDeclaration(node) ||
		Node.isConstructorDeclaration(node) ||
		Node.isGetAccessorDeclaration(node) ||
		Node.isSetAccessorDeclaration(node)
	);
}

/** Parameters introduced directly by `node` (empty for non-function nodes), without casts. */
function scopeParameters(node: Node): ParameterDeclaration[] {
	if (
		Node.isFunctionDeclaration(node) ||
		Node.isFunctionExpression(node) ||
		Node.isArrowFunction(node) ||
		Node.isMethodDeclaration(node) ||
		Node.isConstructorDeclaration(node) ||
		Node.isGetAccessorDeclaration(node) ||
		Node.isSetAccessorDeclaration(node)
	) {
		return node.getParameters();
	}
	return [];
}

function collectBindingNames(nameNode: Node, into: Set<string>): void {
	if (Node.isIdentifier(nameNode)) {
		into.add(nameNode.getText());
		return;
	}
	for (const id of nameNode.getDescendantsOfKind(SyntaxKind.Identifier)) into.add(id.getText());
}

/** Identifier used purely as a name (member, property key) — not a value reference. */
function isNameOnly(id: Identifier): boolean {
	const parent = id.getParent();
	if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return true;
	if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return true;
	if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === id) return true;
	if (Node.isQualifiedName(parent) && parent.getRight() === id) return true;
	return false;
}

/**
 * Identifier sitting in type space (`x: Foo`, `as Foo`, `Foo<Bar>`, unions, …),
 * which shares no scope with value bindings. A `typeof value` query is the
 * exception — it names a real value binding even though it lives in a type node.
 */
function isTypePositioned(id: Identifier): boolean {
	if (!id.getFirstAncestor(a => Node.isTypeNode(a))) return false;
	return !id.getFirstAncestor(a => Node.isTypeQuery(a));
}

/** Free identifiers in the body that resolve outside it (module / global) — shadow-sensitive. */
function computeFreeNames(fn: FunctionDeclaration, paramNames: readonly string[]): Set<string> {
	const body = fn.getBodyOrThrow();
	const local = new Set<string>(paramNames);
	for (const v of body.getDescendantsOfKind(SyntaxKind.VariableDeclaration))
		collectBindingNames(v.getNameNode(), local);
	for (const f of body.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
		const n = f.getName();
		if (n) local.add(n);
		for (const p of f.getParameters()) collectBindingNames(p.getNameNode(), local);
	}
	for (const f of body.getDescendantsOfKind(SyntaxKind.ArrowFunction)) {
		for (const p of f.getParameters()) collectBindingNames(p.getNameNode(), local);
	}
	for (const f of body.getDescendantsOfKind(SyntaxKind.FunctionExpression)) {
		for (const p of f.getParameters()) collectBindingNames(p.getNameNode(), local);
	}
	for (const c of body.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
		const n = c.getName();
		if (n) local.add(n);
	}
	for (const c of body.getDescendantsOfKind(SyntaxKind.CatchClause)) {
		const v = c.getVariableDeclaration();
		if (v) collectBindingNames(v.getNameNode(), local);
	}

	const free = new Set<string>();
	for (const id of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
		if (isNameOnly(id)) continue;
		const t = id.getText();
		if (!local.has(t)) free.add(t);
	}
	return free;
}

/** Names introduced by `node`'s own scope frame (not nested ones). */
function declaredNamesInScope(node: Node): Set<string> {
	const names = new Set<string>();
	for (const p of scopeParameters(node)) collectBindingNames(p.getNameNode(), names);
	if (Node.isBlock(node) || Node.isCaseClause(node) || Node.isDefaultClause(node) || Node.isModuleBlock(node)) {
		for (const stmt of node.getStatements()) {
			if (Node.isVariableStatement(stmt)) {
				for (const d of stmt.getDeclarations()) collectBindingNames(d.getNameNode(), names);
			} else if (Node.isFunctionDeclaration(stmt)) {
				const n = stmt.getName();
				if (n) names.add(n);
			} else if (Node.isClassDeclaration(stmt)) {
				const n = stmt.getName();
				if (n) names.add(n);
			}
		}
	}
	if (Node.isCatchClause(node)) {
		const v = node.getVariableDeclaration();
		if (v) collectBindingNames(v.getNameNode(), names);
	}
	if (Node.isForStatement(node)) {
		const init = node.getInitializer();
		if (init && Node.isVariableDeclarationList(init)) {
			for (const d of init.getDeclarations()) collectBindingNames(d.getNameNode(), names);
		}
	}
	if (Node.isForInStatement(node) || Node.isForOfStatement(node)) {
		const init = node.getInitializer();
		if (Node.isVariableDeclarationList(init)) {
			for (const d of init.getDeclarations()) collectBindingNames(d.getNameNode(), names);
		}
	}
	return names;
}

/** Is a free body name shadowed by an intermediate scope between the call and the module root? */
function callSiteShadows(call: CallExpression, freeNames: Set<string>): boolean {
	let cur: Node | undefined = call.getParent();
	while (cur && !Node.isSourceFile(cur)) {
		for (const name of declaredNamesInScope(cur)) {
			if (freeNames.has(name)) return true;
		}
		cur = cur.getParent();
	}
	return false;
}

function freshName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}_${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Text that replaces identifier `ref` with `replacement`. An identifier in an
 * object shorthand (`{ name }`) is both key and value, so a bare swap would
 * corrupt the key (or be invalid for a non-identifier replacement) — expand it
 * to `name: replacement` instead.
 */
function editTextFor(ref: Identifier, replacement: string): string {
	if (Node.isShorthandPropertyAssignment(ref.getParent())) return `${ref.getText()}: ${replacement}`;
	return replacement;
}

// ---------------------------------------------------------------------------
// Body shape: guards, tail, escapes
// ---------------------------------------------------------------------------

function isBareReturn(stmt: Statement): boolean {
	return Node.isReturnStatement(stmt) && stmt.getExpression() === undefined;
}

/** `if (cond) return;` with a bare return (or `{ return; }`) and no `else`; returns the condition. */
function asGuard(stmt: Statement): Expression | null {
	if (!Node.isIfStatement(stmt) || stmt.getElseStatement()) return null;
	const then = stmt.getThenStatement();
	if (isBareReturn(then)) return stmt.getExpression();
	if (Node.isBlock(then)) {
		const inner = then.getStatements();
		if (inner.length === 1 && isBareReturn(inner[0])) return stmt.getExpression();
	}
	return null;
}

function nearestFunction(node: Node): Node | undefined {
	return node.getFirstAncestor(a => isFunctionLike(a));
}

/** Does an unlabeled/labeled `break`/`continue` target something outside `root`? */
function jumpEscapes(jump: Node, root: Statement, isBreak: boolean): boolean {
	const boundary = root.getParent();
	const label = Node.isBreakStatement(jump) || Node.isContinueStatement(jump) ? jump.getLabel() : undefined;
	if (label) {
		let a: Node | undefined = jump.getParent();
		while (a && a !== boundary) {
			if (Node.isLabeledStatement(a) && a.getLabel().getText() === label.getText()) return false;
			a = a.getParent();
		}
		return true;
	}
	let a: Node | undefined = jump.getParent();
	while (a && a !== boundary) {
		if (
			Node.isForStatement(a) ||
			Node.isForInStatement(a) ||
			Node.isForOfStatement(a) ||
			Node.isWhileStatement(a) ||
			Node.isDoStatement(a)
		) {
			return false;
		}
		if (isBreak && Node.isSwitchStatement(a)) return false;
		a = a.getParent();
	}
	return true;
}

/** A param reference that is assigned to or incremented/decremented. */
function isWriteTarget(id: Identifier): boolean {
	const p = id.getParent();
	if (Node.isBinaryExpression(p) && p.getLeft() === id && ASSIGNMENT_OPS.has(p.getOperatorToken().getText())) {
		return true;
	}
	if (Node.isPrefixUnaryExpression(p)) {
		const op = p.getOperatorToken();
		if ((op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) && p.getOperand() === id) return true;
	}
	if (Node.isPostfixUnaryExpression(p) && p.getOperand() === id) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Candidate analysis
// ---------------------------------------------------------------------------

function skip(opts: Options, name: string, reason: string): null {
	if (opts.verbose) console.log(`  skip ${name}: ${reason}`);
	return null;
}

function analyze(fn: FunctionDeclaration, opts: Options): Candidate | null {
	const name = fn.getName();
	if (!name) return null;
	if (opts.nameFilter && !opts.nameFilter.test(name)) return null;
	if (!Node.isSourceFile(fn.getParent())) return skip(opts, name, "not a top-level declaration");
	if (fn.isExported() || fn.isDefaultExport()) return skip(opts, name, "exported (refs may escape module)");
	if (fn.isAsync()) return skip(opts, name, "async");
	if (fn.isGenerator()) return skip(opts, name, "generator");
	if (fn.hasDeclareKeyword()) return skip(opts, name, "ambient declaration");
	if (fn.getTypeParameters().length > 0) return skip(opts, name, "generic");
	if (fn.getOverloads().length > 0) return skip(opts, name, "has overloads");
	const body = fn.getBody();
	if (!body || !Node.isBlock(body)) return skip(opts, name, "no block body");

	// Parameters: simple identifiers only, no default values.
	const params: ParamInfo[] = [];
	for (const p of fn.getParameters()) {
		if (p.isRestParameter()) return skip(opts, name, "rest parameter");
		if (p.getInitializer()) return skip(opts, name, "parameter has a default value");
		const nameNode = p.getNameNode();
		if (!Node.isIdentifier(nameNode)) return skip(opts, name, "destructured parameter");
		if (nameNode.getText() === "this") return skip(opts, name, "`this` parameter");
		params.push({ name: nameNode.getText(), param: p, refs: [] });
	}

	// `this` / `super` / `arguments` would change meaning after inlining.
	if (body.getFirstDescendantByKind(SyntaxKind.ThisKeyword)) return skip(opts, name, "uses `this`");
	if (body.getFirstDescendantByKind(SyntaxKind.SuperKeyword)) return skip(opts, name, "uses `super`");
	for (const id of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
		if (id.getText() === "arguments" && !isNameOnly(id)) return skip(opts, name, "uses `arguments`");
	}

	// A function-scoped `var` (including `for (var ...)`) hoists to the *caller's*
	// function after inlining, not the vanished helper — a scope/hoisting change.
	for (const list of body.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
		if (list.getDeclarationKind() === VariableDeclarationKind.Var && nearestFunction(list) === fn) {
			return skip(opts, name, "uses a function-scoped `var`");
		}
	}

	// Recursion (conservative: a call to the helper's own name).
	for (const c of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const callee = c.getExpression();
		if (Node.isIdentifier(callee) && callee.getText() === name) return skip(opts, name, "recursive");
	}

	// Parameter references, scoped to the body; reject parameter writes.
	const bodyStart = body.getStart();
	const bodyEnd = body.getEnd();
	for (const pi of params) {
		for (const ref of pi.param.findReferencesAsNodes()) {
			if (Node.isIdentifier(ref) && ref.getStart() >= bodyStart && ref.getEnd() <= bodyEnd) pi.refs.push(ref);
		}
		for (const ref of pi.refs) {
			if (isWriteTarget(ref)) return skip(opts, name, `writes parameter \`${pi.name}\``);
		}
	}

	// Partition: leading guard clauses, then tail.
	const stmts = body.getStatements();
	const guards: Expression[] = [];
	let i = 0;
	for (; i < stmts.length; i++) {
		const cond = asGuard(stmts[i]);
		if (!cond) break;
		guards.push(cond);
	}
	const tail = stmts.slice(i);
	if (tail.length === 0) return skip(opts, name, "no tail statements");
	if (tail.length > opts.maxStatements) {
		return skip(opts, name, `tail too large (${tail.length} > ${opts.maxStatements})`);
	}

	// The tail must not escape the (about-to-vanish) helper frame.
	for (const t of tail) {
		for (const ret of t.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
			if (nearestFunction(ret) === fn) return skip(opts, name, "tail contains a return");
		}
		if (Node.isReturnStatement(t) && nearestFunction(t) === fn) return skip(opts, name, "tail contains a return");
		for (const br of t.getDescendantsOfKind(SyntaxKind.BreakStatement)) {
			if (jumpEscapes(br, t, true)) return skip(opts, name, "tail break escapes the helper");
		}
		for (const co of t.getDescendantsOfKind(SyntaxKind.ContinueStatement)) {
			if (jumpEscapes(co, t, false)) return skip(opts, name, "tail continue escapes the helper");
		}
	}

	// A top-level `function`/`class` declaration in the tail changes scope/hoisting
	// when moved: guarded inlining buries it in a new `if` block, guardless inlining
	// drops it into the caller block where it can collide. Skip rather than rewrite.
	for (const t of tail) {
		if (Node.isFunctionDeclaration(t) || Node.isClassDeclaration(t)) {
			return skip(opts, name, "tail declares a local function/class");
		}
	}

	// Guardless inlining splices direct tail statements into the caller block, where
	// a destructured local could redeclare a caller binding. The rename pass only
	// handles identifier names, so skip non-identifier bindings rather than risk it.
	if (guards.length === 0) {
		for (const t of tail) {
			if (!Node.isVariableStatement(t)) continue;
			for (const d of t.getDeclarations()) {
				if (!Node.isIdentifier(d.getNameNode())) {
					return skip(opts, name, "guardless tail has a destructured local");
				}
			}
		}
	}

	// Every reference must be a discarded call in statement position.
	const sourceFile = fn.getSourceFile();
	const nameNode = fn.getNameNode();
	const callSites: CallSite[] = [];
	for (const ref of fn.findReferencesAsNodes()) {
		if (ref === nameNode) continue;
		if (ref.getSourceFile() !== sourceFile) return skip(opts, name, "referenced in another file");
		if (!Node.isIdentifier(ref)) return skip(opts, name, "referenced as a non-identifier");
		const parent = ref.getParent();
		if (!Node.isCallExpression(parent) || parent.getExpression() !== ref) {
			return skip(opts, name, "referenced as a value, not a direct call");
		}
		const stmt = parent.getParent();
		if (!stmt || !Node.isExpressionStatement(stmt)) return skip(opts, name, "call result is used");
		const args = parent.getArguments();
		if (args.some(a => Node.isSpreadElement(a))) return skip(opts, name, "call uses spread args");
		if (args.length > params.length) return skip(opts, name, "call passes more args than params");
		callSites.push({ stmt, call: parent });
	}
	if (callSites.length === 0) return skip(opts, name, "no call sites");

	const freeNames = computeFreeNames(
		fn,
		params.map(p => p.name),
	);
	for (const cs of callSites) {
		if (callSiteShadows(cs.call, freeNames)) return skip(opts, name, "would shadow a free identifier at a call site");
	}

	return { fn, name, params, guards, tail, freeNames, callSites };
}

export function collectCandidates(sourceFile: SourceFile, opts: Options): Candidate[] {
	const out: Candidate[] = [];
	for (const fn of sourceFile.getFunctions()) {
		const c = analyze(fn, opts);
		if (c) out.push(c);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Replacement construction
// ---------------------------------------------------------------------------

/**
 * The lexical scope used to key reserved names for a call site. Statements are
 * inserted into the call's own statemented parent, but `case`/`default` clauses
 * share one scope (the switch's `CaseBlock`), so names must be reserved there to
 * avoid `const` collisions across sibling cases.
 */
function targetBlock(call: CallExpression): Node {
	const node = call.getParent()?.getParent() ?? call.getSourceFile();
	if (Node.isCaseClause(node) || Node.isDefaultClause(node)) return node.getParent() ?? node;
	return node;
}

/**
 * Per-target-block set of names already taken, seeded once from the identifiers
 * live in that block. A guardless tail local only collides when its name is
 * already used in the target block (a sibling declaration or a later reference
 * that our new binding would shadow); a name used elsewhere in the enclosing
 * function is in a different scope and is irrelevant. Hoisted temps and renamed
 * tail locals draw from this same set so neither collides with the other nor
 * across multiple call sites inlined into the same block.
 */
function reservedFor(call: CallExpression, reserved: Map<Node, Set<string>>): Set<string> {
	const key = targetBlock(call);
	let set = reserved.get(key);
	if (!set) {
		set = new Set<string>();
		// Only real value references (and bindings) can collide; member names,
		// property keys, and type names share no scope with our locals/temps.
		for (const id of key.getDescendantsOfKind(SyntaxKind.Identifier)) {
			if (!isNameOnly(id) && !isTypePositioned(id)) set.add(id.getText());
		}
		reserved.set(key, set);
	}
	return set;
}

/**
 * Guardless inlining: rename direct-tail block locals that would redeclare a name
 * already live in the target block. Only the tail's own top-level `VariableStatement`s
 * land in the caller block — declarations nested in loops, blocks, or functions keep
 * their own scope and never collide, so they are left untouched.
 */
function renameCollidingLocals(candidate: Candidate, call: CallExpression, reserved: Map<Node, Set<string>>): Edit[] {
	const edits: Edit[] = [];
	const taken = reservedFor(call, reserved);
	const lo = candidate.tail[0].getStart();
	const hi = candidate.tail[candidate.tail.length - 1].getEnd();
	for (const t of candidate.tail) {
		if (!Node.isVariableStatement(t)) continue;
		for (const v of t.getDeclarations()) {
			const nameNode = v.getNameNode();
			if (!Node.isIdentifier(nameNode)) continue;
			const original = nameNode.getText();
			if (!taken.has(original)) {
				taken.add(original);
				continue;
			}
			const fresh = freshName(original, taken);
			taken.add(fresh);
			// Rename the declaration itself plus every in-tail reference; dedupe by
			// position since findReferences may or may not include the declaration.
			const seen = new Set<number>();
			for (const ref of [nameNode, ...v.findReferencesAsNodes()]) {
				if (!Node.isIdentifier(ref)) continue;
				const start = ref.getStart();
				if (start < lo || ref.getEnd() > hi || seen.has(start)) continue;
				seen.add(start);
				edits.push({ start, end: ref.getEnd(), text: editTextFor(ref, fresh) });
			}
		}
	}
	return edits;
}

/**
 * The plan for replacing one call site: hoisted `prefix` statements, an optional
 * inverted-guard `condition`, and the substituted `tail`. Statement strings are
 * never pre-indented — `insertStatements` applies code indentation structurally
 * (and leaves template/string/comment interiors untouched).
 */
interface Replacement {
	prefix: string[];
	condition: string | null;
	tail: string[];
}

function buildReplacement(
	candidate: Candidate,
	call: CallExpression,
	reserved: Map<Node, Set<string>>,
	strict: boolean,
): Replacement {
	const args = call.getArguments();
	const prefix: string[] = [];
	const substByParam = new Map<string, string>();
	const reservedNames = reservedFor(call, reserved);

	for (let i = 0; i < candidate.params.length; i++) {
		const pi = candidate.params[i];
		const uses = pi.refs.length;
		const argNode: Node | undefined = i < args.length ? args[i] : undefined;

		if (uses === 0) {
			if (argNode === undefined) continue;
			if (!isPureExpr(argNode, strict)) {
				// Side-effecting and unused: evaluate it for the effect, in order.
				prefix.push(asExprStatement(argNode));
			} else if (strict && !isLiteralExpr(unwrapParens(argNode))) {
				// Strict exactness: a read can still throw (TDZ) or trigger a getter,
				// so preserve it; only literals are safe to drop entirely.
				prefix.push(asExprStatement(argNode));
			}
			continue;
		}
		if (argNode === undefined) {
			substByParam.set(pi.name, "undefined");
			continue;
		}
		// In strict mode every used argument is snapshotted (hoisted) left-to-right,
		// reproducing JS call semantics exactly — including reads of values a later
		// argument mutates. Otherwise hoist only when correctness/readability needs it.
		const hoist = strict || !isPureExpr(argNode, strict) || (uses >= 2 && !isDuplicable(argNode, strict));
		if (hoist) {
			const temp = freshName(`__inl_${pi.name}`, reservedNames);
			reservedNames.add(temp);
			prefix.push(`const ${temp} = ${argNode.getText()};`);
			substByParam.set(pi.name, temp);
		} else {
			substByParam.set(pi.name, argNeedsParens(argNode) ? `(${argNode.getText()})` : argNode.getText());
		}
	}

	const paramEdits: Edit[] = [];
	for (const pi of candidate.params) {
		const t = substByParam.get(pi.name);
		if (t === undefined) continue;
		for (const r of pi.refs) paramEdits.push({ start: r.getStart(), end: r.getEnd(), text: editTextFor(r, t) });
	}

	if (candidate.guards.length > 0) {
		return {
			prefix,
			condition: combineGuards(candidate.guards, paramEdits),
			tail: candidate.tail.map(s => subText(s, paramEdits)),
		};
	}

	const allEdits = paramEdits.concat(renameCollidingLocals(candidate, call, reserved));
	return { prefix, condition: null, tail: candidate.tail.map(s => subText(s, allEdits)) };
}

function applyReplacement(stmt: Statement, repl: Replacement): void {
	const parent = stmt.getParent();
	if (parent && Node.isStatemented(parent)) {
		const idx = parent.getStatements().indexOf(stmt);
		if (repl.condition === null) {
			const inserted = parent.insertStatements(idx, [...repl.prefix, ...repl.tail]);
			stmt.remove();
			// Normalize indentation structurally (AST-aware, so template/string/comment
			// interiors are never touched) — keeps output correct without a formatter.
			for (const node of inserted) node.formatText();
			return;
		}
		// Insert an empty wrapper, then fill its block so ts-morph indents the tail
		// structurally — never by rewriting raw text (which would corrupt templates).
		const inserted = parent.insertStatements(idx, [...repl.prefix, `if (${repl.condition}) {\n}`]);
		const ifStmt = inserted[inserted.length - 1];
		if (Node.isIfStatement(ifStmt)) {
			const then = ifStmt.getThenStatement();
			if (Node.isBlock(then)) then.insertStatements(0, repl.tail);
		}
		stmt.remove();
		for (const node of inserted) node.formatText();
		return;
	}
	// Rare fallback: the call is not in a statemented parent (e.g. a brace-less
	// `if (x) helper();`). Wrap the replacement in a fresh block.
	const lines =
		repl.condition === null
			? [...repl.prefix, ...repl.tail]
			: [...repl.prefix, `if (${repl.condition}) {`, ...repl.tail, "}"];
	stmt.replaceWithText(`{\n${lines.join("\n")}\n}`).formatText();
}

function inlineCandidate(candidate: Candidate, strict: boolean): void {
	const reserved = new Map<Node, Set<string>>();
	// Build every replacement before mutating, so positions stay valid.
	const plans = candidate.callSites.map(cs => ({
		stmt: cs.stmt,
		repl: buildReplacement(candidate, cs.call, reserved, strict),
	}));
	// Apply bottom-up so earlier call sites keep their positions.
	plans.sort((a, b) => b.stmt.getStart() - a.stmt.getStart());
	for (const plan of plans) applyReplacement(plan.stmt, plan.repl);
	candidate.fn.remove();
}

/** Inline every qualifying function, re-collecting after each so chained helpers resolve. */
export function inlineFile(sourceFile: SourceFile, opts: Options): string[] {
	const inlined: string[] = [];
	for (let round = 0; round < 100_000; round++) {
		const candidates = collectCandidates(sourceFile, opts);
		if (candidates.length === 0) break;
		const next = candidates[0];
		inlineCandidate(next, opts.strictEffects);
		inlined.push(next.name);
	}
	return inlined;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, "..");

async function formatFile(file: string): Promise<void> {
	const biome = path.join(REPO_ROOT, "node_modules/.bin/biome");
	const res = await $`${biome} format --write ${file}`.quiet().nothrow();
	if (res.exitCode !== 0) {
		// Biome ignores paths outside its config globs; the inliner already
		// self-indents, so this is a notice, not a failure.
		const first = res.stderr.toString().trim().split("\n")[0] ?? "";
		console.warn(`  note: biome did not format ${file} (output is self-indented). ${first}`);
	}
}

async function showDiff(file: string, updated: string): Promise<void> {
	const tmp = path.join(os.tmpdir(), `inline-${process.pid}-${path.basename(file)}`);
	await Bun.write(tmp, updated);
	await $`git --no-pager diff --no-index -- ${file} ${tmp}`.nothrow();
	await rm(tmp, { force: true });
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			write: { type: "boolean", short: "w", default: false },
			name: { type: "string" },
			"max-statements": { type: "string", default: "3" },
			list: { type: "boolean", default: false },
			"no-format": { type: "boolean", default: false },
			verbose: { type: "boolean", short: "v", default: false },
			"strict-effects": { type: "boolean", default: false },
		},
	});

	if (positionals.length === 0) {
		console.error("usage: bun scripts/inline-functions.ts <file...> [-w] [--name <regex>] [--max-statements <n>]");
		process.exitCode = 1;
		return;
	}

	const maxStatements = Number.parseInt(values["max-statements"] ?? "3", 10);
	if (!Number.isFinite(maxStatements) || maxStatements < 1) {
		console.error(`invalid --max-statements: ${values["max-statements"]}`);
		process.exitCode = 1;
		return;
	}
	const opts: Options = {
		maxStatements,
		nameFilter: values.name ? new RegExp(values.name) : undefined,
		verbose: values.verbose,
		strictEffects: values["strict-effects"],
	};
	const write = values.write;
	const format = !values["no-format"];

	for (const file of positionals) {
		const abs = path.resolve(file);
		const project = new Project({
			manipulationSettings: { indentationText: IndentationText.Tab },
			skipAddingFilesFromTsConfig: true,
		});
		const sourceFile = project.addSourceFileAtPath(abs);
		const original = sourceFile.getFullText();

		if (values.list) {
			const candidates = collectCandidates(sourceFile, opts);
			console.log(`${file}: ${candidates.length} inlinable function(s)`);
			for (const c of candidates) console.log(`  ${c.name} (${c.callSites.length} call site(s))`);
			continue;
		}

		const inlined = inlineFile(sourceFile, opts);
		const updated = sourceFile.getFullText();
		if (updated === original) {
			console.log(`${file}: nothing to inline`);
			continue;
		}
		console.log(`${file}: inlined ${inlined.length} function(s): ${inlined.join(", ")}`);
		if (write) {
			await sourceFile.save();
			if (format) await formatFile(abs);
		} else {
			await showDiff(abs, updated);
		}
	}
}

if (import.meta.main) await main();
