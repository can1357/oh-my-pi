import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { diffArrays } from "diff";
import { ts } from "ts-morph";
import { localizationKey } from "./localization-key";

// bun scripts/extract-locales.ts [--apply] [--reference=HEAD] [--report=path.json] [--files=path,...]
// Migrate an existing Korean source overlay after an upstream update; translated calls are left alone.
// Reviewed semantic pairs live in localization-resolutions.json. Unresolved AST pairs abort all writes.
// Ambiguous translations require Resolution.context (for example, "tool.write.action"); never infer aliases.
const apply = process.argv.includes("--apply");
const reference = process.argv.find(arg => arg.startsWith("--reference="))?.slice(12) ?? "HEAD";
const reportPath = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
const onlyFiles = process.argv
	.find(arg => arg.startsWith("--files="))
	?.slice(8)
	.split(",");
interface Resolution {
	file: string;
	korean: string;
	source: string;
	context?: string;
	values?: string[];
	translation?: string;
}
const reviewed = JSON.parse(readFileSync(resolve(import.meta.dir, "localization-resolutions.json"), "utf8")) as {
	messages: Record<string, string>;
	resolutions: Resolution[];
};
const resolutions = [
	...reviewed.resolutions,
	...process.argv
		.filter(arg => arg.startsWith("--resolutions="))
		.flatMap(arg => JSON.parse(readFileSync(resolve(import.meta.dir, "..", arg.slice(14)), "utf8")) as Resolution[]),
];
const root = resolve(import.meta.dir, "..");
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const korean = /[\uac00-\ud7a3]/;
const excludedFiles: Record<string, true> = {
	"packages/utils/src/i18n.ts": true,
	"packages/utils/src/i18n-browser.ts": true,
	"packages/utils/src/i18n-core.ts": true,
};
const files = git("ls-files")
	.trim()
	.split(/\r?\n/)
	.filter(
		file =>
			/^packages\/[^/]+\/src\/.*\.ts$/.test(file) &&
			!/(?:^|\/)(?:test|tests|__tests__|prompts|client)(?:\/|\.)|\.(?:test|spec)\./.test(file) &&
			!file.startsWith("packages/collab-web/") &&
			!excludedFiles[file] &&
			(!onlyFiles || onlyFiles.includes(file)),
	);
const enPath = resolve(root, "packages/utils/src/locales/en.json");
const koPath = resolve(root, "packages/utils/src/locales/ko.json");
function catalog(path: string): Record<string, string> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}
const en = catalog(enPath);
const ko = catalog(koPath);
const expressionKeys = new Map<string, string>();
for (const [source, translation] of Object.entries(reviewed.messages)) {
	const key = localizationKey(source, translation, ko);
	en[key] = source.split("\u0004", 1)[0];
	ko[key] = translation;
	expressionKeys.set(source, key);
}
type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
interface Parsed {
	ast: ts.SourceFile;
	literals: Literal[];
	tokens: ts.Node[];
}
type Pair = {
	node: Literal;
	other?: Literal;
	source?: string;
	context?: string;
	values?: (ts.Expression | string)[];
	englishIndexes?: number[];
	translation?: string;
	resolved?: boolean;
};
function isLiteral(node: ts.Node): node is Literal {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}
function text(node: Literal, indexes?: number[]): string {
	if (!ts.isTemplateExpression(node)) return node.text;
	return (
		node.head.text +
		node.templateSpans.map((span, index) => `{${indexes?.[index] ?? index}}${span.literal.text}`).join("")
	);
}
function parse(file: string, source: string) {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const literals: Literal[] = [];
	const tokens: ts.Node[] = [];
	function visit(node: ts.Node) {
		if (isLiteral(node)) literals.push(node);
		const children = node.getChildren(ast);
		if (children.length) for (const child of children) visit(child);
		else if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node);
	}
	visit(ast);
	return { ast, literals, tokens };
}
function tokenKey(node: ts.Node): string {
	if (
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		ts.isTemplateHead(node) ||
		ts.isTemplateMiddle(node) ||
		ts.isTemplateTail(node)
	)
		return `string:${node.kind}`;
	return `${node.kind}:${node.getText()}`;
}
function excluded(node: Literal): string | undefined {
	const parent = node.parent;
	if (ts.isLiteralTypeNode(parent)) return "type literal";
	if (
		(ts.isPropertyAssignment(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertySignature(parent)) &&
		parent.name === node
	)
		return "property name";
	if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isModuleDeclaration(parent))
		return "module identifier";
	for (let ancestor: ts.Node | undefined = parent; ancestor; ancestor = ancestor.parent) {
		if (
			ts.isCallExpression(ancestor) &&
			ts.isPropertyAccessExpression(ancestor.expression) &&
			ancestor.expression.name.text === "describe"
		)
			return "model schema description";
	}
	return undefined;
}
function expressionShape(node: ts.Node): string {
	if (isLiteral(node))
		return ts.isTemplateExpression(node)
			? `template(${node.templateSpans.map(span => expressionShape(span.expression)).join(",")})`
			: "string";
	const children = node.getChildren();
	return children.length
		? `${node.kind}(${children.map(expressionShape).join(",")})`
		: `${node.kind}:${node.getText()}`;
}
function pure(node: ts.Node, bindings: ReadonlySet<string>): boolean {
	if (ts.isIdentifier(node)) return bindings.has(node.text);
	if (
		ts.isLiteralExpression(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword
	)
		return true;
	if (ts.isPropertyAccessExpression(node)) return pure(node.expression, bindings);
	if (ts.isParenthesizedExpression(node)) return pure(node.expression, bindings);
	if (ts.isConditionalExpression(node))
		return pure(node.condition, bindings) && pure(node.whenTrue, bindings) && pure(node.whenFalse, bindings);
	if (ts.isBinaryExpression(node))
		return (
			![ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(
				node.operatorToken.kind,
			) &&
			pure(node.left, bindings) &&
			pure(node.right, bindings)
		);
	return false;
}
function context(node: ts.Node): string {
	const names: string[] = [];
	for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
		if (
			(ts.isFunctionDeclaration(ancestor) ||
				ts.isMethodDeclaration(ancestor) ||
				ts.isClassDeclaration(ancestor) ||
				ts.isVariableDeclaration(ancestor) ||
				ts.isPropertyDeclaration(ancestor) ||
				ts.isPropertyAssignment(ancestor)) &&
			ancestor.name
		)
			names.unshift(ancestor.name.getText());
	}
	return names.join(".");
}
const issues: object[] = [];
const skipped: object[] = [];
const comparisons: object[] = [];
const appended: object[] = [];
const contexts: object[] = [];
const changes: { file: string; source: string; count: number }[] = [];
const records: { file: string; source: string; current: Parsed; english: Parsed; pairs: Pair[] }[] = [];
const known = new Map<string, Set<string>>();
for (const file of files) {
	const source = readFileSync(resolve(root, file), "utf8");
	if (!korean.test(source)) continue;
	let original: string;
	try {
		original = git("show", `${reference}:${file}`);
	} catch {
		issues.push({ file, reason: "No reference source" });
		continue;
	}
	const current = parse(file, source);
	const english = parse(file, original);
	const positions = new Map<number, number>();
	let a = 0;
	let b = 0;
	for (const part of diffArrays(current.tokens.map(tokenKey), english.tokens.map(tokenKey))) {
		if (part.removed) a += part.count!;
		else if (part.added) b += part.count!;
		else
			for (let index = 0; index < part.count!; index++)
				positions.set(current.tokens[a++].getStart(), english.tokens[b++].getStart());
	}
	const englishByStart = new Map(english.literals.map(node => [node.getStart(), node]));
	const pairs: Pair[] = [];
	for (const node of current.literals) {
		if (!korean.test(text(node))) continue;
		const line = current.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
		const reason = excluded(node);
		if (reason) {
			skipped.push({ file, line, reason, text: text(node) });
			continue;
		}
		if (ts.isTaggedTemplateExpression(node.parent)) {
			issues.push({
				file,
				line,
				reason: "Tagged template requires an explicit tag-preserving migration",
				korean: node.getText(),
			});
			continue;
		}
		const other = englishByStart.get(positions.get(node.getStart()) ?? -1);
		if (other && korean.test(text(other))) {
			skipped.push({ file, line, reason: "Korean already present upstream", text: text(node) });
			continue;
		}
		pairs.push({ node, other: other?.kind === node.kind ? other : undefined });
		if (other && !ts.isTemplateExpression(node) && !ts.isTemplateExpression(other)) {
			const values = known.get(text(node)) ?? new Set();
			values.add(text(other));
			known.set(text(node), values);
		}
	}
	records.push({ file, source, current, english, pairs });
}
let aligned = 0;
let templates = 0;
let aliases = 0;
for (const { file, source, current, english, pairs } of records) {
	const bindings = new Set<string>();
	function collectBindings(node: ts.Node): void {
		if (
			(ts.isVariableDeclaration(node) ||
				ts.isParameter(node) ||
				ts.isBindingElement(node) ||
				ts.isImportClause(node) ||
				ts.isImportSpecifier(node) ||
				ts.isNamespaceImport(node) ||
				ts.isFunctionDeclaration(node) ||
				ts.isClassDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name)
		)
			bindings.add(node.name.text);
		ts.forEachChild(node, collectBindings);
	}
	collectBindings(current.ast);
	for (const pair of pairs) {
		const { node } = pair;
		const resolution = resolutions.find(item => item.file === file && item.korean === node.getText());
		if (resolution) {
			pair.source = resolution.source;
			pair.context = resolution.context;
			pair.values = resolution.values;
			pair.translation = resolution.translation;
			pair.resolved = true;
			continue;
		}
		if (!pair.other) {
			if (ts.isConditionalExpression(node.parent)) {
				const sibling = node === node.parent.whenTrue ? node.parent.whenFalse : node.parent.whenTrue;
				if (isLiteral(sibling) && !korean.test(text(sibling)) && sibling.kind === node.kind) pair.other = sibling;
			}
			if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
				const enclosing = context(node);
				if (/LABELS|_TEXT|_NAMES/.test(enclosing) && !ts.isTemplateExpression(node)) {
					const name = node.parent.name;
					pair.source = ts.isStringLiteral(name) ? name.text : name.getText();
				}
			}
			// Match an unchanged enclosing AST structure before reusing a proven literal pair.
			for (
				let ancestor: ts.Node = node.parent, depth = 0;
				depth < 4 && ancestor.parent;
				ancestor = ancestor.parent, depth++
			) {
				const siblings = current.literals.filter(
					item => item.getStart() >= ancestor.getStart() && item.end <= ancestor.end,
				);
				const index = siblings.indexOf(node);
				const candidates: Literal[] = [];
				function find(other: ts.Node) {
					if (other.kind === ancestor.kind && expressionShape(other) === expressionShape(ancestor)) {
						const items = english.literals.filter(
							item => item.getStart() >= other.getStart() && item.end <= other.end,
						);
						if (items[index]?.kind === node.kind) candidates.push(items[index]);
					} else ts.forEachChild(other, find);
				}
				find(english.ast);
				if (candidates.length === 1) {
					pair.other = candidates[0];
					break;
				}
			}
			if (!pair.other && !ts.isTemplateExpression(node)) {
				const originals = known.get(text(node));
				if (originals?.size === 1) pair.source = [...originals][0];
			}
		}
		if (!pair.resolved && ts.isTemplateExpression(node) && pair.other && ts.isTemplateExpression(pair.other)) {
			const values = node.templateSpans.map(span => span.expression);
			const indexes: number[] = [];
			const used = new Set<number>();
			for (const span of pair.other.templateSpans) {
				const shape = expressionShape(span.expression);
				let index = values.findIndex((value, index) => !used.has(index) && expressionShape(value) === shape);
				if (index < 0 && pure(span.expression, bindings)) {
					index = values.length;
					values.push(span.expression);
					appended.push({ file, context: context(node), expression: span.expression.getText() });
				}
				if (index < 0) break;
				used.add(index);
				indexes.push(index);
			}
			if (
				indexes.length === pair.other.templateSpans.length &&
				node.templateSpans.every((_, index) => used.has(index))
			) {
				pair.values = values;
				pair.englishIndexes = indexes;
			} else pair.source = undefined;
		}
	}
	const identifiers = new Set(current.tokens.filter(ts.isIdentifier).map(node => node.text));
	let helper = "t";
	if (identifiers.has(helper)) {
		helper = "localize";
		aliases++;
	}
	while (identifiers.has(helper)) helper = `_${helper}`;
	const replacements: { start: number; end: number; value: string }[] = [];
	function render(start: number, end: number): string {
		let value = source.slice(start, end);
		for (const edit of replacements
			.filter(edit => edit.start >= start && edit.end <= end)
			.sort((left, right) => right.start - left.start))
			value = value.slice(0, edit.start - start) + edit.value + value.slice(edit.end - start);
		return value;
	}
	let count = 0;
	for (const pair of [...pairs].sort(
		(left, right) => left.node.end - right.node.end || right.node.getStart() - left.node.getStart(),
	)) {
		const { node, other } = pair;
		if (
			pairs.some(
				owner =>
					owner !== pair &&
					owner.resolved &&
					owner.node.getStart() <= node.getStart() &&
					owner.node.end >= node.end,
			)
		)
			continue;
		const line = current.ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
		if ((!other && pair.source === undefined) || (ts.isTemplateExpression(node) && !pair.values)) {
			issues.push({
				file,
				line,
				context: context(node),
				reason: !other ? "Unaligned literal" : "Template expression mismatch",
				korean: node.getText(),
				english: other?.getText(),
			});
			continue;
		}
		const english = pair.source ?? text(other!, pair.englishIndexes);
		const translation = pair.translation ?? text(node);
		let key: string;
		try {
			key = localizationKey(english, translation, ko, pair.context);
		} catch (error) {
			issues.push({ file, line, reason: (error as Error).message, english, translation });
			continue;
		}
		if (key.includes("\u0004")) contexts.push({ file, english: key.split("\u0004", 1)[0], key, translation });
		en[key] = key.split("\u0004", 1)[0];
		ko[key] = translation;
		const parent = node.parent;
		const comparison =
			(ts.isBinaryExpression(parent) &&
				[
					ts.SyntaxKind.EqualsEqualsToken,
					ts.SyntaxKind.EqualsEqualsEqualsToken,
					ts.SyntaxKind.ExclamationEqualsToken,
					ts.SyntaxKind.ExclamationEqualsEqualsToken,
				].includes(parent.operatorToken.kind)) ||
			ts.isCaseClause(parent);
		if (comparison) comparisons.push({ file, line, korean: translation, english: key });
		const values =
			pair.values?.map(expression => {
				if (typeof expression === "string") {
					const parsed = ts.createSourceFile(
						"expression.ts",
						`const value = (${expression});`,
						ts.ScriptTarget.Latest,
						true,
					);
					const declaration = (parsed.statements[0] as ts.VariableStatement).declarationList.declarations[0];
					const result = ts.transform(declaration.initializer!, [
						cx => {
							const visit: ts.Visitor = node => {
								if (
									ts.isCallExpression(node) &&
									ts.isIdentifier(node.expression) &&
									node.expression.text === "__I18N__"
								) {
									const [first, ...args] = node.arguments;
									if (!first || !ts.isStringLiteral(first))
										throw new Error("Reviewed nested translation must have a literal key");
									const key = expressionKeys.get(first.text);
									if (!key) throw new Error(`Missing reviewed translation: ${first.text}`);
									return ts.factory.updateCallExpression(
										node,
										ts.factory.createIdentifier(helper),
										node.typeArguments,
										[
											ts.factory.createStringLiteral(key),
											...args.map(arg => ts.visitNode(arg, visit) as ts.Expression),
										],
									);
								}
								return ts.visitEachChild(node, visit, cx);
							};
							return node => ts.visitNode(node, visit) as ts.Expression;
						},
					]);
					const value = ts.createPrinter().printNode(ts.EmitHint.Expression, result.transformed[0], parsed);
					result.dispose();
					return `\`\${${value}}\``;
				}
				const expressionSource =
					expression.getSourceFile() === current.ast
						? render(expression.getStart(), expression.end)
						: expression.getText();
				return `\`\${${expressionSource}}\``;
			}) ?? [];
		if (values.length) templates++;
		const value =
			comparison && file.endsWith("/session-info-overlay.ts")
				? JSON.stringify(en[key])
				: `${helper}(${[JSON.stringify(key), ...values].join(", ")})`;
		for (let index = replacements.length - 1; index >= 0; index--)
			if (replacements[index].start >= node.getStart() && replacements[index].end <= node.end)
				replacements.splice(index, 1);
		replacements.push({ start: node.getStart(), end: node.end, value });
		aligned++;
		count++;
	}
	if (!count) continue;
	let output = source;
	for (const edit of replacements.sort((left, right) => right.start - left.start))
		output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
	const importText = `import { ${helper === "t" ? "t" : `t as ${helper}`} } from "@oh-my-pi/pi-utils/i18n";\n`;
	const firstImport =
		current.ast.statements.find(ts.isImportDeclaration)?.getStart() ??
		(source.startsWith("#!") ? source.indexOf("\n") + 1 : 0);
	output = output.slice(0, firstImport) + importText + output.slice(firstImport);
	if (file.endsWith("/modes/controllers/command-controller.ts")) {
		// Session report labels are parser IDs; its overlay localizes them at rendering.
		const generated = parse(file, output).ast;
		const labels: { start: number; end: number; value: string }[] = [];
		function restoreLabels(node: ts.Node, report = false): void {
			if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name)
				report = ["handleSessionCommand", "renderProviderSection"].includes(node.name.getText(generated));
			if (report && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const method = node.expression.name.text;
				const first = node.arguments[0];
				const argument =
					method === "bold"
						? first
						: method === "fg" && first && ts.isStringLiteral(first) && first.text === "dim"
							? node.arguments[1]
							: undefined;
				if (
					argument &&
					ts.isCallExpression(argument) &&
					argument.arguments.length === 1 &&
					ts.isIdentifier(argument.expression) &&
					argument.expression.text === helper &&
					ts.isStringLiteral(argument.arguments[0])
				) {
					const english = argument.arguments[0].text.split("\u0004", 1)[0];
					if (method === "bold" || english.endsWith(":"))
						labels.push({
							start: argument.getStart(generated),
							end: argument.end,
							value: JSON.stringify(english),
						});
				}
			}
			ts.forEachChild(node, child => restoreLabels(child, report));
		}
		restoreLabels(generated);
		for (const label of labels.sort((left, right) => right.start - left.start))
			output = output.slice(0, label.start) + label.value + output.slice(label.end);
	}
	changes.push({ file, source: output, count });
}
const report = {
	files: changes.length,
	aligned,
	templates,
	aliases,
	entries: Object.keys(ko).length,
	issues,
	skipped,
	comparisons,
	appended,
	contexts,
};
if (reportPath) writeFileSync(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(
	JSON.stringify(
		reportPath
			? {
					files: report.files,
					aligned,
					templates,
					aliases,
					entries: report.entries,
					issues: issues.length,
					skipped: skipped.length,
					comparisons: comparisons.length,
					appended: appended.length,
					contexts: contexts.length,
					reportPath,
				}
			: report,
		null,
		2,
	),
);
if (apply) {
	if (issues.length) throw new Error(`Resolve ${issues.length} extraction ambiguities before applying`);
	for (const change of changes) writeFileSync(resolve(root, change.file), change.source);
	mkdirSync(dirname(enPath), { recursive: true });
	writeFileSync(
		enPath,
		`${JSON.stringify(Object.fromEntries(Object.entries(en).sort(([a], [b]) => a.localeCompare(b))), null, "\t")}\n`,
	);
	writeFileSync(
		koPath,
		`${JSON.stringify(Object.fromEntries(Object.entries(ko).sort(([a], [b]) => a.localeCompare(b))), null, "\t")}\n`,
	);
}
