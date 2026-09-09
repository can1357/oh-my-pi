import generate from "@babel/generator";
import { type ParserPlugin, parse } from "@babel/parser";
import traverse, { type Binding, type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
	generate as generateRegex,
	parse as parseRegex,
	type NodePath as RegexNodePath,
	traverse as traverseRegex,
} from "regexp-tree";
import type { AstRegExp, Quantifier as RegexQuantifier } from "regexp-tree/ast";

/**
 * Code mutations for edit benchmark generation.
 *
 * Each mutation introduces a subtle bug that tests edit precision, not bug-finding
 * ability. The mutation can be trivial - what matters is whether the model can
 * surgically apply the patch in difficult contexts.
 */
export interface MutationInfo {
	lineNumber: number;
	originalSnippet: string;
	mutatedSnippet: string;
	/** Correct/misspelled rename pair; set by identifier-multi-edit for rename-style prompts. */
	identifier?: { correct: string; misspelled: string };
}

export interface Mutation {
	name: string;
	category: string;
	/** Whether this mutation intentionally produces multiple separated hunks. */
	multiHunk?: boolean;

	canApply(content: string): boolean;
	mutate(content: string, rng: () => number): [string, MutationInfo];
}

type Candidate<TNode extends t.Node = t.Node, TMeta = unknown> = {
	path: NodePath<TNode>;
	meta?: TMeta;
};

function randomChoice<T>(arr: T[], rng: () => number): T {
	return arr[Math.floor(rng() * arr.length)];
}

function randomSample<T>(arr: T[], count: number, rng: () => number): T[] {
	const copy = [...arr];
	const result: T[] = [];
	for (let i = 0; i < count && copy.length > 0; i++) {
		const idx = Math.floor(rng() * copy.length);
		result.push(copy.splice(idx, 1)[0]);
	}
	return result;
}

function mutateIdentifier(identifier: string): string | null {
	if (identifier.length < 2) return null;
	let mutated: string;
	if (identifier.length >= 3 && identifier[0] === identifier[1]) {
		mutated = identifier[identifier.length - 1] + identifier.slice(1, -1) + identifier[0];
	} else {
		mutated = identifier[1] + identifier[0] + identifier.slice(2);
	}
	return mutated === identifier ? null : mutated;
}

type Parsed = {
	ast: t.File;
	code: string;
};

function parseWithPlugins(code: string, plugins: ParserPlugin[]): t.File {
	return parse(code, {
		sourceType: "unambiguous",
		allowReturnOutsideFunction: true,
		errorRecovery: true,
		plugins,
	});
}

function parseCode(code: string): Parsed | null {
	const pluginSets: ParserPlugin[][] = [
		[
			"flow",
			"flowComments",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
		[
			"typescript",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
	];

	for (const plugins of pluginSets) {
		try {
			return { ast: parseWithPlugins(code, plugins), code };
		} catch {}
	}

	return null;
}

/*
 * Babel parser 7.29 emits TSTypeCastExpression but generator/types don't define it.
 * Register it in VISITOR_KEYS (so the printer's isLastChild doesn't crash) and in
 * generatorInfosMap with a custom handler that unwraps the TSTypeAnnotation wrapper.
 */
t.VISITOR_KEYS.TSTypeCastExpression = ["expression", "typeAnnotation"];
{
	const { generatorInfosMap } = require("@babel/generator/lib/nodes") as {
		generatorInfosMap: Map<string, [any, number, unknown]>;
	};
	if (!generatorInfosMap.has("TSTypeCastExpression")) {
		const tsAs = generatorInfosMap.get("TSAsExpression");
		if (tsAs) {
			// Custom handler: like TSAsExpression but unwraps TSTypeAnnotation → TSType
			function TSTypeCastExpression(
				this: {
					print: (node: unknown, printComments?: boolean) => void;
					space: () => void;
					word: (word: string) => void;
				},
				node: Record<string, unknown>,
			): void {
				this.print(node.expression, true);
				this.space();
				this.word("as");
				this.space();
				const annot = node.typeAnnotation as Record<string, unknown> | undefined;
				// TSTypeCastExpression.typeAnnotation is TSTypeAnnotation {typeAnnotation: TSType}
				this.print(annot && "typeAnnotation" in annot ? annot.typeAnnotation : annot);
			}
			generatorInfosMap.set("TSTypeCastExpression", [TSTypeCastExpression, tsAs[1], tsAs[2]]);
		}
	}
}

type SourceRange = {
	start: number;
	end: number;
};

type SourceEdit = SourceRange & {
	replacement: string;
};

function nodeLine(node: t.Node): number {
	return node.loc?.start.line ?? 0;
}

function nodeRange(node: t.Node): SourceRange | null {
	if (typeof node.start === "number" && typeof node.end === "number" && node.start <= node.end) {
		return { start: node.start, end: node.end };
	}
	return null;
}

function snippetFromSource(src: string, node: t.Node, fallback = ""): string {
	const range = nodeRange(node);
	if (range) {
		return src.slice(range.start, range.end);
	}
	return fallback;
}

function trimSnippet(snippet: string): string {
	return snippet.replace(/^\n+/, "").replace(/\n+$/, "");
}

function snippetFromNode(node: t.Node): string {
	try {
		return trimSnippet(generate(node, { comments: false, compact: false, retainLines: false }).code);
	} catch {
		return "";
	}
}

function applySourceEdits(content: string, edits: SourceEdit[]): string | null {
	if (edits.length === 0) return content;
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	let previousStart = content.length + 1;
	let out = content;
	for (const edit of sorted) {
		if (edit.start < 0 || edit.end < edit.start || edit.end > out.length) {
			return null;
		}
		if (edit.end > previousStart) {
			return null;
		}
		out = `${out.slice(0, edit.start)}${edit.replacement}${out.slice(edit.end)}`;
		previousStart = edit.start;
	}
	return out;
}

function noopInfo(): MutationInfo {
	return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
}

function applyBinaryOperatorSwap(
	parsed: Parsed,
	candidate: Candidate<t.BinaryExpression>,
	swap: Record<string, t.BinaryExpression["operator"]>,
): MutationInfo {
	const node = candidate.path.node;
	const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
	const swapped = swap[node.operator];
	if (!swapped) return noopInfo();
	node.operator = swapped;
	return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
}

function isLengthMemberExpression(node: t.Node): node is t.MemberExpression {
	return t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property, { name: "length" });
}

abstract class BaseAstMutation implements Mutation {
	abstract name: string;
	abstract category: string;

	abstract collectCandidates(parsed: Parsed): Candidate[];
	abstract applyCandidate(parsed: Parsed, candidate: Candidate, rng: () => number): MutationInfo;

	protected buildEdits(_parsed: Parsed, candidate: Candidate, originalRange: SourceRange | null): SourceEdit[] | null {
		if (!originalRange) return null;
		if (candidate.path.removed) {
			return [{ ...originalRange, replacement: "" }];
		}
		const replacement = snippetFromNode(candidate.path.node);
		if (!replacement) return null;
		return [{ ...originalRange, replacement }];
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		if (!parsed) return false;
		return this.collectCandidates(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const originalRange = nodeRange(chosen.path.node);
		const info = this.applyCandidate(parsed, chosen, rng);
		if (info.lineNumber === 0) return [content, noopInfo()];
		const edits = this.buildEdits(parsed, chosen, originalRange);
		if (!edits) return [content, noopInfo()];
		const mutated = applySourceEdits(content, edits);
		if (!mutated || mutated === content) return [content, noopInfo()];
		return [mutated, info];
	}
}

class SwapComparisonMutation extends BaseAstMutation {
	name = "swap-comparison";
	category = "operator";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"<=": "<",
		"<": "<=",
		">=": ">",
		">": ">=",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "<" || op === "<=" || op === ">" || op === ">=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class SwapEqualityMutation extends BaseAstMutation {
	name = "swap-equality";
	category = "operator";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"===": "!==",
		"!==": "===",
		"==": "!=",
		"!=": "==",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "===" || op === "!==" || op === "==" || op === "!=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class SwapLogicalMutation extends BaseAstMutation {
	name = "swap-logical";
	category = "operator";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "&&" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "&&" ? "||" : "&&";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class RemoveNegationMutation extends BaseAstMutation {
	name = "remove-negation";
	category = "operator";

	collectCandidates(parsed: Parsed): Candidate<t.UnaryExpression>[] {
		const out: Candidate<t.UnaryExpression>[] = [];
		traverse(parsed.ast, {
			UnaryExpression: path => {
				if (path.node.operator === "!" && path.node.prefix) out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UnaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const replacement = node.argument;
		candidate.path.replaceWith(replacement);
		return {
			lineNumber: nodeLine(node),
			originalSnippet: before,
			mutatedSnippet: snippetFromNode(replacement),
		};
	}
}

class SwapIncDecMutation extends BaseAstMutation {
	name = "swap-increment-decrement";
	category = "operator";

	collectCandidates(parsed: Parsed): Candidate<t.UpdateExpression>[] {
		const out: Candidate<t.UpdateExpression>[] = [];
		traverse(parsed.ast, {
			UpdateExpression: path => {
				if (path.node.operator === "++" || path.node.operator === "--") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UpdateExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "++" ? "--" : "++";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class SwapArithmeticMutation extends BaseAstMutation {
	name = "swap-arithmetic";
	category = "operator";

	#swap: Record<string, t.BinaryExpression["operator"]> = { "+": "-", "-": "+", "*": "/", "/": "*" };

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "+" || op === "-" || op === "*" || op === "/") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class BooleanLiteralFlipMutation extends BaseAstMutation {
	name = "flip-boolean";
	category = "literal";

	collectCandidates(parsed: Parsed): Candidate<t.BooleanLiteral>[] {
		const out: Candidate<t.BooleanLiteral>[] = [];
		traverse(parsed.ast, {
			BooleanLiteral: path => {
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BooleanLiteral>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.value = !node.value;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class OptionalChainRemovalMutation extends BaseAstMutation {
	name = "remove-optional-chain";
	category = "access";

	collectCandidates(parsed: Parsed): Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] {
		const out: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] = [];
		traverse(parsed.ast, {
			OptionalMemberExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
			OptionalCallExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
		});
		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>,
	): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.optional = false;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class CallArgumentSwapMutation extends BaseAstMutation {
	name = "swap-call-args";
	category = "call";

	collectCandidates(parsed: Parsed): Candidate<t.CallExpression>[] {
		const out: Candidate<t.CallExpression>[] = [];
		traverse(parsed.ast, {
			CallExpression: path => {
				const args = path.node.arguments;
				if (args.length >= 2 && !t.isSpreadElement(args[0]) && !t.isSpreadElement(args[1])) out.push({ path });
			},
		});
		return out;
	}

	override mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const node = chosen.path.node;
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second || t.isSpreadElement(first) || t.isSpreadElement(second)) return [content, noopInfo()];

		const firstRange = nodeRange(first);
		const secondRange = nodeRange(second);
		const callRange = nodeRange(node);
		if (!firstRange || !secondRange || !callRange) return [content, noopInfo()];
		if (firstRange.start >= firstRange.end || secondRange.start >= secondRange.end) return [content, noopInfo()];
		if (firstRange.end > secondRange.start) return [content, noopInfo()];

		const betweenArgs = content.slice(firstRange.end, secondRange.start);
		const swappedArgs = `${content.slice(secondRange.start, secondRange.end)}${betweenArgs}${content.slice(firstRange.start, firstRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: firstRange.start, end: secondRange.end, replacement: swappedArgs },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: nodeLine(node),
				originalSnippet: content.slice(callRange.start, callRange.end),
				mutatedSnippet: mutated.slice(callRange.start, callRange.end),
			},
		];
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.CallExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second) return noopInfo();
		node.arguments[0] = second;
		node.arguments[1] = first;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class NullishCoalescingSwapMutation extends BaseAstMutation {
	name = "swap-nullish";
	category = "operator";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "??" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "??" ? "||" : "??";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class RegexQuantifierSwapMutation extends BaseAstMutation {
	name = "swap-regex-quantifier";
	category = "regex";

	collectCandidates(parsed: Parsed): Candidate<t.RegExpLiteral>[] {
		const out: Candidate<t.RegExpLiteral>[] = [];
		traverse(parsed.ast, {
			RegExpLiteral: path => {
				const source = `/${path.node.pattern}/${path.node.flags ?? ""}`;
				try {
					const ast = parseRegex(source);
					let hasQuantifier = false;
					traverseRegex(ast, {
						Quantifier: quantPath => {
							const kind = quantPath.node.kind;
							if (kind === "+" || kind === "*") hasQuantifier = true;
						},
					});
					if (hasQuantifier) out.push({ path });
				} catch {
					return;
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.RegExpLiteral>, rng: () => number): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const source = `/${node.pattern}/${node.flags ?? ""}`;

		try {
			const ast: AstRegExp = parseRegex(source);
			const quantifiers: Array<RegexNodePath<RegexQuantifier>> = [];
			traverseRegex(ast, {
				Quantifier: quantPath => {
					const kind = quantPath.node.kind;
					if (kind === "+" || kind === "*") quantifiers.push(quantPath as RegexNodePath<RegexQuantifier>);
				},
			});
			if (quantifiers.length === 0) return noopInfo();

			const chosen = randomChoice(quantifiers, rng);
			chosen.node.kind = chosen.node.kind === "+" ? "*" : "+";

			const regenerated = generateRegex(ast);
			const firstSlash = regenerated.indexOf("/");
			const lastSlash = regenerated.lastIndexOf("/");
			if (firstSlash === -1 || lastSlash <= firstSlash) return noopInfo();

			node.pattern = regenerated.slice(firstSlash + 1, lastSlash);
			node.flags = regenerated.slice(lastSlash + 1);
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		} catch {
			return noopInfo();
		}
	}
}

class UnicodeHyphenMutation extends BaseAstMutation {
	name = "unicode-hyphen";
	category = "unicode";

	collectCandidates(parsed: Parsed): Candidate<t.StringLiteral | t.TemplateElement>[] {
		const out: Candidate<t.StringLiteral | t.TemplateElement>[] = [];
		traverse(parsed.ast, {
			StringLiteral: path => {
				if (path.node.value.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
			TemplateElement: path => {
				if (path.node.value.raw.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.StringLiteral | t.TemplateElement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isStringLiteral(node)) {
			const idx = node.value.indexOf("-");
			if (idx === -1) return noopInfo();
			node.value = `${node.value.slice(0, idx)}–${node.value.slice(idx + 1)}`;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const idx = node.value.raw.indexOf("-");
		if (idx === -1) return noopInfo();
		node.value.raw = `${node.value.raw.slice(0, idx)}–${node.value.raw.slice(idx + 1)}`;
		node.value.cooked = (node.value.cooked ?? node.value.raw).replace("-", "–");
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class IdentifierMultiEditMutation extends BaseAstMutation {
	name = "identifier-multi-edit";
	category = "identifier";
	multiHunk = true;

	#keywords = new Set([
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"debugger",
		"default",
		"delete",
		"do",
		"else",
		"export",
		"extends",
		"finally",
		"for",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"new",
		"return",
		"super",
		"switch",
		"this",
		"throw",
		"try",
		"typeof",
		"var",
		"void",
		"while",
		"with",
		"yield",
		"let",
		"enum",
		"implements",
		"interface",
		"package",
		"private",
		"protected",
		"public",
		"static",
		"null",
		"true",
		"false",
	]);

	collectCandidates(parsed: Parsed): Candidate<t.Program>[] {
		const out: Candidate<t.Program>[] = [];
		traverse(parsed.ast, {
			Program: path => {
				out.push({ path });
			},
		});
		return out;
	}

	override mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];
		const candidate = randomChoice(candidates, rng);

		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let bindingCandidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (bindingCandidates.length === 0) {
			bindingCandidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (bindingCandidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(bindingCandidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return [content, noopInfo()];

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return [content, noopInfo()];

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return [content, noopInfo()];

		const edits: SourceEdit[] = [];
		for (const selectedPath of selectedPaths) {
			const range = nodeRange(selectedPath.node);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			const range = nodeRange(bindingId);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const deduped = new Map<string, SourceEdit>();
		for (const edit of edits) {
			deduped.set(`${edit.start}:${edit.end}`, edit);
		}
		if (deduped.size < 2) return [content, noopInfo()];

		const mutatedContent = applySourceEdits(content, Array.from(deduped.values()));
		if (!mutatedContent || mutatedContent === content) return [content, noopInfo()];

		return [
			mutatedContent,
			{
				lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
				originalSnippet: chosen.name,
				mutatedSnippet: mutated,
				identifier: { correct: chosen.name, misspelled: mutated },
			},
		];
	}

	applyCandidate(_parsed: Parsed, candidate: Candidate<t.Program>, rng: () => number): MutationInfo {
		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let candidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (candidates.length === 0) {
			candidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (candidates.length === 0) return noopInfo();

		const chosen = randomChoice(candidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return noopInfo();

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return noopInfo();

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return noopInfo();

		for (const selectedPath of selectedPaths) {
			selectedPath.node.name = mutated;
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			bindingId.name = mutated;
		}

		return {
			lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
			originalSnippet: chosen.name,
			mutatedSnippet: mutated,
			identifier: { correct: chosen.name, misspelled: mutated },
		};
	}
}

class DuplicateLineLiteralFlipMutation extends BaseAstMutation {
	name = "duplicate-line-flip";
	category = "duplicate";

	collectCandidates(parsed: Parsed): Candidate<t.Statement, { group: string }>[] {
		const out: Candidate<t.Statement, { group: string }>[] = [];
		const statements: Array<{ path: NodePath<t.Statement>; text: string }> = [];

		traverse(parsed.ast, {
			Statement: path => {
				if (!path.node.loc) return;
				if (t.isBlockStatement(path.node)) return;
				const text = snippetFromSource(parsed.code, path.node, "");
				if (text.trim().length === 0) return;
				statements.push({ path, text });
			},
		});

		const counts = new Map<string, number>();
		for (const statement of statements) {
			counts.set(statement.text, (counts.get(statement.text) ?? 0) + 1);
		}

		for (const statement of statements) {
			if ((counts.get(statement.text) ?? 0) < 2) continue;
			out.push({ path: statement.path, meta: { group: statement.text } });
		}

		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.Statement, { group: string }>,
		rng: () => number,
	): MutationInfo {
		const flips: Candidate<t.BooleanLiteral | t.BinaryExpression>[] = [];
		candidate.path.traverse({
			BooleanLiteral: path => {
				flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				const op = path.node.operator;
				if (
					op === "===" ||
					op === "!==" ||
					op === "==" ||
					op === "!=" ||
					op === "<" ||
					op === "<=" ||
					op === ">" ||
					op === ">="
				) {
					flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
				}
			},
		});

		if (flips.length === 0) return noopInfo();

		const chosen = randomChoice(flips, rng);
		const node = chosen.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isBooleanLiteral(node)) {
			node.value = !node.value;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const eqSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"===": "!==",
			"!==": "===",
			"==": "!=",
			"!=": "==",
		};
		const compSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"<=": "<",
			"<": "<=",
			">=": ">",
			">": ">=",
		};
		const swapped = eqSwap[node.operator] ?? compSwap[node.operator];
		if (!swapped) return noopInfo();
		node.operator = swapped;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class SwapAdjacentLinesMutation extends BaseAstMutation {
	name = "swap-adjacent-lines";
	category = "structural";

	collectCandidates(parsed: Parsed): Candidate<t.Program | t.BlockStatement, { index: number }>[] {
		const out: Candidate<t.Program | t.BlockStatement, { index: number }>[] = [];

		const considerList = (
			path: NodePath<t.Program | t.BlockStatement>,
			body: Array<t.Statement | t.ModuleDeclaration>,
		): void => {
			for (let i = 0; i < body.length - 1; i++) {
				const left = body[i];
				const right = body[i + 1];
				if (!left || !right) continue;
				if (!t.isStatement(left) || !t.isStatement(right)) continue;
				if (!left.loc || !right.loc) continue;
				if (left.loc.start.line !== left.loc.end.line) continue;
				if (right.loc.start.line !== right.loc.end.line) continue;

				const leftText = snippetFromSource(parsed.code, left, "").trim();
				const rightText = snippetFromSource(parsed.code, right, "").trim();
				if (!leftText || !rightText) continue;
				if (leftText === rightText) continue;

				const gap = right.loc.start.line - left.loc.end.line;
				if (gap > 2) continue;

				out.push({ path, meta: { index: i } });
			}
		};

		traverse(parsed.ast, {
			Program: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
			},
			BlockStatement: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
			},
		});

		return out;
	}

	override mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const container = chosen.path.node;
		const index = chosen.meta?.index;
		if (index === undefined) return [content, noopInfo()];

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return [content, noopInfo()];
		if (!t.isStatement(left) || !t.isStatement(right)) return [content, noopInfo()];

		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		if (!leftRange || !rightRange) return [content, noopInfo()];
		if (leftRange.end > rightRange.start) return [content, noopInfo()];

		const between = content.slice(leftRange.end, rightRange.start);
		const swapped = `${content.slice(rightRange.start, rightRange.end)}${between}${content.slice(leftRange.start, leftRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: rightRange.end, replacement: swapped },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: left.loc?.start.line ?? 0,
				originalSnippet: `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`,
				mutatedSnippet: "[swapped]",
			},
		];
	}

	applyCandidate(
		_parsed: Parsed,
		candidate: Candidate<t.Program | t.BlockStatement, { index: number }>,
	): MutationInfo {
		const container = candidate.path.node;
		const index = candidate.meta?.index;
		if (index === undefined) return noopInfo();

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return noopInfo();
		if (!t.isStatement(left) || !t.isStatement(right)) return noopInfo();

		const before = `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`;
		[body[index], body[index + 1]] = [body[index + 1]!, body[index]!];
		return {
			lineNumber: left.loc?.start.line ?? 0,
			originalSnippet: before,
			mutatedSnippet: "[swapped]",
		};
	}
}

class SwapIfElseBranchesMutation extends BaseAstMutation {
	name = "swap-if-else";
	category = "structural";

	collectCandidates(parsed: Parsed): Candidate<t.IfStatement>[] {
		const out: Candidate<t.IfStatement>[] = [];
		traverse(parsed.ast, {
			IfStatement: path => {
				const node = path.node;
				if (!node.alternate) return;
				if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return;
				if (node.consequent.body.length === 0 || node.alternate.body.length === 0) return;
				if (node.consequent.body.length > 5 || node.alternate.body.length > 5) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.IfStatement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return noopInfo();
		const consequent = node.consequent;
		node.consequent = node.alternate;
		node.alternate = consequent;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: "[swapped]" };
	}
}

/**
 * Remove one label from a fall-through `case A: case B:` pair. The fix inserts
 * the missing label back — a deterministic pure-insertion task whose content
 * is dictated by the visible sibling label, not by hidden deleted code.
 */
class RemoveCaseLabelMutation extends BaseAstMutation {
	name = "remove-case-label";
	category = "structural";

	collectCandidates(parsed: Parsed): Candidate<t.SwitchCase>[] {
		const out: Candidate<t.SwitchCase>[] = [];
		traverse(parsed.ast, {
			SwitchCase: path => {
				const node = path.node;
				if (!node.test || node.consequent.length > 0) return;
				if (!t.isSwitchStatement(path.parent)) return;
				const index = path.parent.cases.indexOf(node);
				if (index < 0 || index >= path.parent.cases.length - 1) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.SwitchCase>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		candidate.path.remove();
		return { lineNumber: nodeLine(node), originalSnippet: before.trim(), mutatedSnippet: "[removed]" };
	}
}

/**
 * Wrap a block's body in a redundant `if (true) { ... }`. The fix removes the
 * wrapper and dedents — an indentation-shifting multi-line edit whose entire
 * content stays visible in the buggy file (no invisible-code reconstruction).
 */
class WrapRedundantIfMutation extends BaseAstMutation {
	name = "wrap-redundant-if";
	category = "structural";

	#lineSpan(node: t.Node): number {
		if (!node.loc) return 0;
		return node.loc.end.line - node.loc.start.line + 1;
	}

	collectCandidates(parsed: Parsed): Candidate<t.BlockStatement>[] {
		const out: Candidate<t.BlockStatement>[] = [];
		traverse(parsed.ast, {
			BlockStatement: path => {
				const span = this.#lineSpan(path.node);
				if (span < 4 || span > 160) return;
				if (path.node.body.length === 0) return;
				if (path.node.directives.length > 0) return;
				// Don't wrap a body that is itself just an `if (true)` (repeated mutation noise).
				if (path.node.body.length === 1 && t.isIfStatement(path.node.body[0])) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(_parsed: Parsed, candidate: Candidate<t.BlockStatement>): MutationInfo {
		const node = candidate.path.node;
		const line = nodeLine(node);
		node.body = [t.ifStatement(t.booleanLiteral(true), t.blockStatement(node.body))];
		return { lineNumber: line, originalSnippet: "", mutatedSnippet: "if (true) {" };
	}
}

/**
 * Swap two adjacent multi-line sibling statements (functions, if-chains,
 * loops). The fix swaps them back — a large contiguous replace whose content
 * is fully visible.
 */
class SwapSiblingBlocksMutation implements Mutation {
	name = "swap-sibling-blocks";
	category = "structural";

	#collect(parsed: Parsed): Array<{ left: t.Statement; right: t.Statement }> {
		const out: Array<{ left: t.Statement; right: t.Statement }> = [];
		const lineSpan = (node: t.Node): number => (node.loc ? node.loc.end.line - node.loc.start.line + 1 : 0);

		const considerList = (body: Array<t.Statement | t.ModuleDeclaration>): void => {
			for (let i = 0; i < body.length - 1; i++) {
				const left = body[i];
				const right = body[i + 1];
				if (!left || !right || !t.isStatement(left) || !t.isStatement(right)) continue;
				if (!left.loc || !right.loc) continue;
				if (t.isImportDeclaration(left) || t.isImportDeclaration(right)) continue;
				const leftSpan = lineSpan(left);
				const rightSpan = lineSpan(right);
				// At least one true block; bounded total so prompts stay readable.
				if (Math.max(leftSpan, rightSpan) < 3) continue;
				if (leftSpan > 80 || rightSpan > 80 || leftSpan + rightSpan > 120) continue;
				const gap = right.loc.start.line - left.loc.end.line;
				if (gap > 2) continue;
				const leftText = snippetFromSource(parsed.code, left, "").trim();
				const rightText = snippetFromSource(parsed.code, right, "").trim();
				if (!leftText || !rightText || leftText === rightText) continue;
				out.push({ left, right });
			}
		};

		traverse(parsed.ast, {
			Program: path => considerList(path.node.body),
			BlockStatement: path => considerList(path.node.body),
		});
		return out;
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		return parsed !== null && this.#collect(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.#collect(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const { left, right } = randomChoice(candidates, rng);
		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		if (!leftRange || !rightRange || leftRange.end > rightRange.start) return [content, noopInfo()];

		const between = content.slice(leftRange.end, rightRange.start);
		const swapped = `${content.slice(rightRange.start, rightRange.end)}${between}${content.slice(leftRange.start, leftRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: rightRange.end, replacement: swapped },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: left.loc?.start.line ?? 0,
				originalSnippet: `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`,
				mutatedSnippet: "[swapped]",
			},
		];
	}
}

/**
 * Duplicate a multi-line statement right after itself (a copy-paste accident).
 * The fix deletes the second copy — a large deletion where the surviving copy
 * stays visible, so the task is deterministic without revealing hidden code.
 */
class DuplicateBlockMutation implements Mutation {
	name = "duplicate-block";
	category = "structural";

	#collect(parsed: Parsed): t.Statement[] {
		const out: t.Statement[] = [];
		const consider = (statement: t.Statement | t.ModuleDeclaration): void => {
			if (!t.isStatement(statement) || !statement.loc) return;
			const span = statement.loc.end.line - statement.loc.start.line + 1;
			if (span < 3 || span > 120) return;
			// Duplicating lexical declarations or exports produces parse/redeclaration
			// errors; stick to statements that stay syntactically valid twice.
			if (
				!t.isIfStatement(statement) &&
				!t.isExpressionStatement(statement) &&
				!t.isForStatement(statement) &&
				!t.isForOfStatement(statement) &&
				!t.isWhileStatement(statement) &&
				!t.isTryStatement(statement) &&
				!t.isSwitchStatement(statement)
			) {
				return;
			}
			out.push(statement);
		};
		traverse(parsed.ast, {
			Program: path => {
				for (const statement of path.node.body) consider(statement);
			},
			BlockStatement: path => {
				for (const statement of path.node.body) consider(statement);
			},
		});
		return out;
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		return parsed !== null && this.#collect(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.#collect(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const statement = randomChoice(candidates, rng);
		const range = nodeRange(statement);
		if (!range) return [content, noopInfo()];

		const text = content.slice(range.start, range.end);
		const mutated = applySourceEdits(content, [{ start: range.end, end: range.end, replacement: `\n\n${text}` }]);
		if (!mutated || mutated === content) return [content, noopInfo()];
		// Reject mutations that no longer parse (e.g. duplicated declarations).
		if (!parseCode(mutated)) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: statement.loc?.start.line ?? 0,
				originalSnippet: text.split("\n")[0]?.trim() ?? "",
				mutatedSnippet: text.split("\n")[0]?.trim() ?? "",
			},
		];
	}
}

/**
 * Move a multi-line statement to a distant position in the same statement
 * list. The fix moves it back — one delete hunk plus one insert hunk, the two
 * dominant hunk shapes in real edits — with the moved content fully visible.
 */
class MoveDistantBlockMutation implements Mutation {
	name = "move-distant-block";
	category = "structural";
	multiHunk = true;

	#collect(parsed: Parsed): Array<{ moved: t.Statement; next: t.Statement; target: t.Statement }> {
		const out: Array<{ moved: t.Statement; next: t.Statement; target: t.Statement }> = [];

		const considerList = (body: Array<t.Statement | t.ModuleDeclaration>): void => {
			if (body.length < 5) return;
			for (let from = 0; from < body.length - 1; from++) {
				const moved = body[from];
				const next = body[from + 1];
				if (!moved || !next || !t.isStatement(moved) || !t.isStatement(next)) continue;
				if (!moved.loc || t.isImportDeclaration(moved)) continue;
				const span = moved.loc.end.line - moved.loc.start.line + 1;
				if (span < 3 || span > 60) continue;
				for (let to = from + 3; to < body.length; to++) {
					const target = body[to];
					if (!target || !t.isStatement(target) || !target.loc) continue;
					out.push({ moved, next, target });
				}
			}
		};

		traverse(parsed.ast, {
			Program: path => considerList(path.node.body),
			BlockStatement: path => considerList(path.node.body),
		});
		return out;
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		return parsed !== null && this.#collect(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.#collect(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const { moved, next, target } = randomChoice(candidates, rng);
		const movedRange = nodeRange(moved);
		const nextRange = nodeRange(next);
		const targetRange = nodeRange(target);
		if (!movedRange || !nextRange || !targetRange) return [content, noopInfo()];
		if (movedRange.end > nextRange.start || nextRange.start > targetRange.end) return [content, noopInfo()];

		const movedText = content.slice(movedRange.start, movedRange.end);
		const mutated = applySourceEdits(content, [
			// Cut the statement together with its trailing separator...
			{ start: movedRange.start, end: nextRange.start, replacement: "" },
			// ...and splice it back in after the distant target statement.
			{ start: targetRange.end, end: targetRange.end, replacement: `\n\n${movedText}` },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];
		if (!parseCode(mutated)) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: moved.loc?.start.line ?? 0,
				originalSnippet: movedText.split("\n")[0]?.trim() ?? "",
				mutatedSnippet: movedText.split("\n")[0]?.trim() ?? "",
			},
		];
	}
}

/**
 * Apply several independent token-level mutations in one file — the multi-hunk
 * edit shape that dominates real sessions. Each constituent bug is a
 * single-line change fully specified by the task's before/after blocks.
 */
class CompositeMultiEditMutation implements Mutation {
	name = "composite-multi-edit";
	category = "multi";
	multiHunk = true;

	#parts: Mutation[];

	constructor(parts: Mutation[]) {
		this.#parts = parts;
	}

	canApply(content: string): boolean {
		let applicable = 0;
		for (const part of this.#parts) {
			try {
				if (part.canApply(content)) applicable++;
			} catch {
				// Unparseable for this part; skip.
			}
			if (applicable >= 2) return true;
		}
		return false;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const applicable = this.#parts.filter(part => {
			try {
				return part.canApply(content);
			} catch {
				return false;
			}
		});
		if (applicable.length < 2) return [content, noopInfo()];

		const target = Math.min(3 + Math.floor(rng() * 3), applicable.length);
		const parts = randomSample(applicable, target, rng);
		let current = content;
		let firstInfo: MutationInfo | null = null;
		let applied = 0;
		for (const part of parts) {
			try {
				const [next, info] = part.mutate(current, rng);
				if (next === current || info.lineNumber === 0) continue;
				current = next;
				firstInfo ??= info;
				applied++;
			} catch {
				// A part failing on already-mutated content just shrinks the composite.
			}
		}
		if (applied < 2 || !firstInfo) return [content, noopInfo()];
		return [current, firstInfo];
	}
}

class OffByOneMutation extends BaseAstMutation {
	name = "off-by-one";
	category = "literal";

	collectCandidates(parsed: Parsed): Candidate<t.NumericLiteral | t.BinaryExpression>[] {
		const out: Candidate<t.NumericLiteral | t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			NumericLiteral: path => {
				if (path.node.value !== 0 && path.node.value !== 1) return;
				const hasBoundaryAncestor =
					path.findParent(parent => {
						return (
							parent.isForStatement() ||
							parent.isWhileStatement() ||
							parent.isDoWhileStatement() ||
							parent.isIfStatement() ||
							(parent.isBinaryExpression() && ["<", "<=", ">", ">="].includes(parent.node.operator))
						);
					}) != null;
				if (hasBoundaryAncestor) out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				if (
					(path.node.operator === "<" || path.node.operator === "<=") &&
					isLengthMemberExpression(path.node.right)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
					return;
				}
				if (
					path.node.operator === "-" &&
					isLengthMemberExpression(path.node.left) &&
					t.isNumericLiteral(path.node.right) &&
					(path.node.right.value === 1 || path.node.right.value === 2)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.NumericLiteral | t.BinaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isNumericLiteral(node)) {
			node.value = node.value === 0 ? 1 : 0;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (node.operator === "<" || node.operator === "<=") {
			if (!isLengthMemberExpression(node.right)) return noopInfo();
			node.operator = node.operator === "<" ? "<=" : "<";
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (
			node.operator === "-" &&
			isLengthMemberExpression(node.left) &&
			t.isNumericLiteral(node.right) &&
			(node.right.value === 1 || node.right.value === 2)
		) {
			node.right.value = node.right.value === 1 ? 2 : 1;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		return noopInfo();
	}
}

/** Single-line token mutations; also the constituent parts of the composite. */
const TOKEN_MUTATIONS: Mutation[] = [
	new SwapComparisonMutation(),
	new SwapEqualityMutation(),
	new SwapLogicalMutation(),
	new RemoveNegationMutation(),
	new SwapIncDecMutation(),
	new SwapArithmeticMutation(),
	new BooleanLiteralFlipMutation(),
	new OptionalChainRemovalMutation(),
	new CallArgumentSwapMutation(),
	new NullishCoalescingSwapMutation(),
	new RegexQuantifierSwapMutation(),
	new UnicodeHyphenMutation(),
	new OffByOneMutation(),
];

export const ALL_MUTATIONS: Mutation[] = [
	...TOKEN_MUTATIONS,
	new IdentifierMultiEditMutation(),
	new DuplicateLineLiteralFlipMutation(),
	new SwapAdjacentLinesMutation(),
	new SwapIfElseBranchesMutation(),
	new WrapRedundantIfMutation(),
	new SwapSiblingBlocksMutation(),
	new DuplicateBlockMutation(),
	new MoveDistantBlockMutation(),
	new RemoveCaseLabelMutation(),
	new CompositeMultiEditMutation(TOKEN_MUTATIONS),
];

export const CATEGORY_MAP: Record<string, string[]> = {
	operator: ALL_MUTATIONS.filter(m => m.category === "operator").map(m => m.name),
	literal: ALL_MUTATIONS.filter(m => m.category === "literal").map(m => m.name),
	access: ALL_MUTATIONS.filter(m => m.category === "access").map(m => m.name),
	call: ALL_MUTATIONS.filter(m => m.category === "call").map(m => m.name),
	regex: ALL_MUTATIONS.filter(m => m.category === "regex").map(m => m.name),
	unicode: ALL_MUTATIONS.filter(m => m.category === "unicode").map(m => m.name),
	identifier: ALL_MUTATIONS.filter(m => m.category === "identifier").map(m => m.name),
	duplicate: ALL_MUTATIONS.filter(m => m.category === "duplicate").map(m => m.name),
	structural: ALL_MUTATIONS.filter(m => m.category === "structural").map(m => m.name),
	multi: ALL_MUTATIONS.filter(m => m.category === "multi").map(m => m.name),
};
