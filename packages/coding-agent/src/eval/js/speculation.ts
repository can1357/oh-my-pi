import type {
	ArrayExpression,
	AssignmentExpression,
	AwaitExpression,
	BinaryExpression,
	BlockStatement,
	BooleanLiteral,
	CallExpression,
	Expression,
	ExpressionStatement,
	ForOfStatement,
	Identifier,
	IfStatement,
	MemberExpression,
	Node,
	NullLiteral,
	NumericLiteral,
	ObjectExpression,
	ObjectProperty,
	Program,
	Statement,
	StringLiteral,
	TemplateLiteral,
	VariableDeclaration,
} from "@babel/types";
import { evaluateShadowExpression } from "../speculation/evaluator";
import type {
	ShadowConditional,
	ShadowControlNode,
	ShadowExpression,
	ShadowJoin,
	ShadowLoop,
	ShadowOperation,
	ShadowPlan,
	ShadowSourceSpan,
	ShadowValue,
} from "../speculation/types";
import { loadBabelParser } from "./shared/rewrite-imports";

const MAX_STATIC_LOOP_ITERATIONS = 32;

function hasType<T extends Node["type"]>(node: Node | null | undefined, type: T): node is Extract<Node, { type: T }> {
	return node?.type === type;
}

function isIdentifier(node: Node | null | undefined, match?: { name: string }): node is Identifier {
	return hasType(node, "Identifier") && (match === undefined || node.name === match.name);
}

function isStringLiteral(node: Node | null | undefined): node is StringLiteral {
	return hasType(node, "StringLiteral");
}

function isNumericLiteral(node: Node | null | undefined): node is NumericLiteral {
	return hasType(node, "NumericLiteral");
}

function isBooleanLiteral(node: Node | null | undefined): node is BooleanLiteral {
	return hasType(node, "BooleanLiteral");
}

function isNullLiteral(node: Node | null | undefined): node is NullLiteral {
	return hasType(node, "NullLiteral");
}

function isArrayExpression(node: Node | null | undefined): node is ArrayExpression {
	return hasType(node, "ArrayExpression");
}

function isObjectExpression(node: Node | null | undefined): node is ObjectExpression {
	return hasType(node, "ObjectExpression");
}

function isObjectProperty(node: Node | null | undefined): node is ObjectProperty {
	return hasType(node, "ObjectProperty");
}

function isMemberExpression(node: Node | null | undefined): node is MemberExpression {
	return hasType(node, "MemberExpression");
}

function isTemplateLiteral(node: Node | null | undefined): node is TemplateLiteral {
	return hasType(node, "TemplateLiteral");
}

function isBinaryExpression(node: Node | null | undefined, match?: { operator: "+" }): node is BinaryExpression {
	return hasType(node, "BinaryExpression") && (match === undefined || node.operator === match.operator);
}

function isCallExpression(node: Node | null | undefined): node is CallExpression {
	return hasType(node, "CallExpression");
}

function isAwaitExpression(node: Node | null | undefined): node is AwaitExpression {
	return hasType(node, "AwaitExpression");
}

function isBlockStatement(node: Node | null | undefined): node is BlockStatement {
	return hasType(node, "BlockStatement");
}

function isVariableDeclaration(node: Node | null | undefined): node is VariableDeclaration {
	return hasType(node, "VariableDeclaration");
}

function isExpressionStatement(node: Node | null | undefined): node is ExpressionStatement {
	return hasType(node, "ExpressionStatement");
}

function isAssignmentExpression(
	node: Node | null | undefined,
	match?: { operator: "=" },
): node is AssignmentExpression {
	return hasType(node, "AssignmentExpression") && (match === undefined || node.operator === match.operator);
}

function isIfStatement(node: Node | null | undefined): node is IfStatement {
	return hasType(node, "IfStatement");
}

function isForOfStatement(node: Node | null | undefined): node is ForOfStatement {
	return hasType(node, "ForOfStatement");
}

function isExpression(node: Node | null | undefined): node is Expression {
	return (
		isIdentifier(node) ||
		isStringLiteral(node) ||
		isNumericLiteral(node) ||
		isBooleanLiteral(node) ||
		isNullLiteral(node) ||
		isArrayExpression(node) ||
		isObjectExpression(node) ||
		isMemberExpression(node) ||
		isTemplateLiteral(node) ||
		isBinaryExpression(node) ||
		isCallExpression(node) ||
		isAwaitExpression(node) ||
		isAssignmentExpression(node)
	);
}

function isDefinitelyString(expression: ShadowExpression): boolean {
	if (expression.kind === "literal") return typeof expression.value === "string";
	if (expression.kind === "concat") return true;
	return (
		expression.kind === "transform" &&
		(expression.name === "String" || expression.name === "JSON.stringify" || expression.name === "Array.join")
	);
}

type ProjectionState = {
	readonly snapshot: Readonly<Record<string, unknown>>;
	readonly environment: Map<string, ShadowExpression>;
	readonly operations: ShadowOperation[];
	readonly controls: ShadowControlNode[];
	readonly occurrences: Map<string, number>;
	barrier?: ShadowPlan["barrier"];
	sourceOrder: number;
};

function span(node: Node): ShadowSourceSpan {
	return { start: node.start ?? 0, end: node.end ?? node.start ?? 0 };
}

function siteId(node: Node): string {
	return `js:${node.start ?? 0}`;
}

function expressionDependencies(expression: ShadowExpression, output = new Set<string>()): Set<string> {
	switch (expression.kind) {
		case "operation_result":
			output.add(expression.operationId);
			break;
		case "property":
			expressionDependencies(expression.target, output);
			break;
		case "array":
		case "concat":
			for (const item of expression.items) expressionDependencies(item, output);
			break;
		case "object":
			for (const entry of expression.entries) expressionDependencies(entry.value, output);
			break;
		case "transform":
			expressionDependencies(expression.input, output);
			if (expression.argument) expressionDependencies(expression.argument, output);
			break;
		case "literal":
		case "snapshot":
			break;
	}
	return output;
}

function objectKey(property: Node): string | undefined {
	if (isIdentifier(property)) return property.name;
	if (isStringLiteral(property) || isNumericLiteral(property)) return String(property.value);
	return undefined;
}

function projectExpression(expression: Expression, state: ProjectionState): ShadowExpression | undefined {
	if (isNullLiteral(expression)) return { kind: "literal", value: null };
	if (isBooleanLiteral(expression) || isNumericLiteral(expression) || isStringLiteral(expression)) {
		return { kind: "literal", value: expression.value };
	}
	if (isIdentifier(expression)) {
		return state.environment.get(expression.name) ?? { kind: "snapshot", name: expression.name };
	}
	if (isArrayExpression(expression)) {
		const items: ShadowExpression[] = [];
		for (const item of expression.elements) {
			if (!item || !isExpression(item)) return undefined;
			const projected = projectExpression(item, state);
			if (!projected) return undefined;
			items.push(projected);
		}
		return { kind: "array", items };
	}
	if (isObjectExpression(expression)) {
		const entries: Array<{ key: string; value: ShadowExpression }> = [];
		for (const property of expression.properties) {
			if (!isObjectProperty(property) || property.computed || !isExpression(property.value)) {
				return undefined;
			}
			const key = objectKey(property.key);
			const value = projectExpression(property.value, state);
			if (key === undefined || !value) return undefined;
			entries.push({ key, value });
		}
		return { kind: "object", entries };
	}
	if (isMemberExpression(expression) && isExpression(expression.object)) {
		const target = projectExpression(expression.object, state);
		if (!target) return undefined;
		if (!expression.computed && isIdentifier(expression.property)) {
			return { kind: "property", target, property: expression.property.name };
		}
		if (expression.computed && isExpression(expression.property)) {
			const property = projectExpression(expression.property, state);
			if (
				property?.kind === "literal" &&
				(typeof property.value === "string" || typeof property.value === "number")
			) {
				return { kind: "property", target, property: property.value };
			}
		}
		return undefined;
	}
	if (isTemplateLiteral(expression)) {
		const items: ShadowExpression[] = [];
		for (let index = 0; index < expression.quasis.length; index++) {
			const text = expression.quasis[index]?.value.cooked;
			if (text === undefined) return undefined;
			items.push({ kind: "literal", value: text });
			const embedded = expression.expressions[index];
			if (embedded) {
				if (!isExpression(embedded)) return undefined;
				const projected = projectExpression(embedded, state);
				if (!projected) return undefined;
				items.push(projected);
			}
		}
		return { kind: "concat", items };
	}
	if (
		isBinaryExpression(expression, { operator: "+" }) &&
		isExpression(expression.left) &&
		isExpression(expression.right)
	) {
		const left = projectExpression(expression.left, state);
		const right = projectExpression(expression.right, state);
		return left && right && (isDefinitelyString(left) || isDefinitelyString(right))
			? { kind: "concat", items: [left, right] }
			: undefined;
	}
	if (isCallExpression(expression) && expression.arguments.every(argument => isExpression(argument))) {
		const args = expression.arguments as Expression[];
		if (isIdentifier(expression.callee, { name: "String" }) && args.length === 1) {
			const input = projectExpression(args[0] as Expression, state);
			return input ? { kind: "transform", name: "String", input } : undefined;
		}
		if (
			isMemberExpression(expression.callee) &&
			!expression.callee.computed &&
			isIdentifier(expression.callee.object, { name: "JSON" }) &&
			isIdentifier(expression.callee.property, { name: "stringify" }) &&
			args.length === 1
		) {
			const input = projectExpression(args[0] as Expression, state);
			return input ? { kind: "transform", name: "JSON.stringify", input } : undefined;
		}
		if (
			isMemberExpression(expression.callee) &&
			!expression.callee.computed &&
			isExpression(expression.callee.object) &&
			isIdentifier(expression.callee.property, { name: "join" }) &&
			args.length <= 1
		) {
			const input = projectExpression(expression.callee.object, state);
			const argument = args[0] ? projectExpression(args[0], state) : undefined;
			return input && (!args[0] || argument)
				? { kind: "transform", name: "Array.join", input, ...(argument ? { argument } : {}) }
				: undefined;
		}
	}
	return undefined;
}

function unwrapAwait(expression: Expression): Expression {
	return isAwaitExpression(expression) && isExpression(expression.argument) ? expression.argument : expression;
}

function callKind(expression: Expression): "read" | "completion" | "parallel" | undefined {
	const value = unwrapAwait(expression);
	if (!isCallExpression(value)) return undefined;
	if (isIdentifier(value.callee, { name: "completion" })) return "completion";
	if (isIdentifier(value.callee, { name: "parallel" })) return "parallel";
	if (
		isMemberExpression(value.callee) &&
		!value.callee.computed &&
		isIdentifier(value.callee.object, { name: "tool" }) &&
		isIdentifier(value.callee.property, { name: "read" })
	) {
		return "read";
	}
	return undefined;
}

function addOperation(
	expression: Expression,
	state: ProjectionState,
	dynamicPath: readonly string[],
	controlDependencies: readonly string[],
): ShadowOperation | undefined {
	const call = unwrapAwait(expression);
	if (!isCallExpression(call)) return undefined;
	const name = callKind(call);
	if (name !== "read" && name !== "completion") return undefined;
	if (call.arguments.some(argument => !isExpression(argument))) return undefined;
	const args = call.arguments as Expression[];
	if ((name === "read" && args.length !== 1) || (name === "completion" && args.length === 0)) return undefined;
	const projectedArgs =
		name === "read" || args.length === 1
			? projectExpression(args[0] as Expression, state)
			: (() => {
					const items = args.map(argument => projectExpression(argument, state));
					return items.every((item): item is ShadowExpression => item !== undefined)
						? ({ kind: "array", items } as const)
						: undefined;
				})();
	if (!projectedArgs) return undefined;
	const staticSite = siteId(call);
	const pathKey = `${staticSite}:${dynamicPath.join("/")}`;
	const occurrence = state.occurrences.get(pathKey) ?? 0;
	state.occurrences.set(pathKey, occurrence + 1);
	const id = `${pathKey}:${occurrence}`;
	const operation: ShadowOperation = {
		kind: "tool",
		call: {
			id,
			siteId: staticSite,
			dynamicPath: [...dynamicPath],
			occurrence,
			name,
			args: projectedArgs,
			dependencies: [...expressionDependencies(projectedArgs)],
			controlDependencies: [...controlDependencies],
			sourceOrder: state.sourceOrder++,
			span: span(call),
		},
	};
	state.operations.push(operation);
	return operation;
}

function staticValue(expression: ShadowExpression, state: ProjectionState): ShadowValue | undefined {
	try {
		return evaluateShadowExpression(expression, { snapshot: state.snapshot, results: new Map() });
	} catch {
		return undefined;
	}
}

function statements(node: Statement | BlockStatement): readonly Statement[] {
	return isBlockStatement(node) ? node.body : [node];
}

function addBarrier(state: ProjectionState, reason: string, node: Node): false {
	state.barrier ??= { kind: "barrier", reason, span: span(node) };
	return false;
}

function projectParallel(
	expression: Expression,
	state: ProjectionState,
	dynamicPath: readonly string[],
	controlDependencies: readonly string[],
): ShadowExpression | undefined {
	const call = unwrapAwait(expression);
	if (!isCallExpression(call) || callKind(call) !== "parallel" || call.arguments.length !== 1) return undefined;
	const input = call.arguments[0];
	if (!input || !isArrayExpression(input)) return undefined;
	const operationIds: string[] = [];
	const results: ShadowExpression[] = [];
	for (const [index, item] of input.elements.entries()) {
		if (!item || !isExpression(item)) return undefined;
		const operation = addOperation(item, state, [...dynamicPath, `parallel:${index}`], controlDependencies);
		if (!operation) return undefined;
		operationIds.push(operation.call.id);
		results.push({ kind: "operation_result", operationId: operation.call.id });
	}
	const join: ShadowJoin = {
		kind: "join",
		id: `${siteId(call)}:join`,
		operationIds,
		failureOrder: [...operationIds],
		span: span(call),
	};
	state.controls.push(join);
	return { kind: "array", items: results };
}

function projectStatement(
	statement: Statement,
	state: ProjectionState,
	dynamicPath: readonly string[],
	controlDependencies: readonly string[],
): boolean {
	if (isVariableDeclaration(statement)) {
		for (const declaration of statement.declarations) {
			if (!isIdentifier(declaration.id) || !declaration.init || !isExpression(declaration.init)) {
				return addBarrier(state, "unsupported JavaScript declaration", declaration);
			}
			const operation = addOperation(declaration.init, state, dynamicPath, controlDependencies);
			if (operation) {
				state.environment.set(declaration.id.name, { kind: "operation_result", operationId: operation.call.id });
				continue;
			}
			const parallel = projectParallel(declaration.init, state, dynamicPath, controlDependencies);
			const value = parallel ?? projectExpression(declaration.init, state);
			if (!value) return addBarrier(state, "unsupported JavaScript declaration value", declaration.init);
			state.environment.set(declaration.id.name, value);
		}
		return true;
	}
	if (isExpressionStatement(statement)) {
		const expression = statement.expression;
		if (
			isAssignmentExpression(expression, { operator: "=" }) &&
			isIdentifier(expression.left) &&
			isExpression(expression.right)
		) {
			const operation = addOperation(expression.right, state, dynamicPath, controlDependencies);
			if (operation) {
				state.environment.set(expression.left.name, { kind: "operation_result", operationId: operation.call.id });
				return true;
			}
			const value = projectExpression(expression.right, state);
			if (!value) return addBarrier(state, "unsupported JavaScript assignment", expression);
			state.environment.set(expression.left.name, value);
			return true;
		}
		if (addOperation(expression, state, dynamicPath, controlDependencies)) return true;
		if (projectParallel(expression, state, dynamicPath, controlDependencies)) return true;
		const unwrapped = unwrapAwait(expression);
		if (isCallExpression(unwrapped) && isIdentifier(unwrapped.callee, { name: "display" })) {
			return true;
		}
		if (projectExpression(expression, state)) return true;
		return addBarrier(state, "unsupported JavaScript statement", statement);
	}
	if (isIfStatement(statement) && isExpression(statement.test)) {
		const test = projectExpression(statement.test, state);
		if (!test) return addBarrier(state, "unsupported JavaScript condition", statement.test);
		const conditionalId = `${siteId(statement)}:if`;
		const evaluated = staticValue(test, state);
		if (evaluated) {
			const selected = evaluated.value ? statement.consequent : statement.alternate;
			if (!selected) return true;
			for (const child of statements(selected)) {
				if (
					!projectStatement(
						child,
						state,
						[...dynamicPath, evaluated.value ? "if:true" : "if:false"],
						controlDependencies,
					)
				) {
					return false;
				}
			}
			return true;
		}
		const control: ShadowConditional = {
			kind: "conditional",
			id: conditionalId,
			test,
			consequentPath: "if:true",
			alternatePath: "if:false",
			span: span(statement),
		};
		state.controls.push(control);
		const environment = new Map(state.environment);
		for (const child of statements(statement.consequent)) {
			if (!projectStatement(child, state, [...dynamicPath, "if:true"], [...controlDependencies, conditionalId])) {
				state.environment.clear();
				for (const [name, value] of environment) state.environment.set(name, value);
				return false;
			}
		}
		state.environment.clear();
		for (const [name, value] of environment) state.environment.set(name, value);
		if (statement.alternate) {
			for (const child of statements(statement.alternate)) {
				if (
					!projectStatement(child, state, [...dynamicPath, "if:false"], [...controlDependencies, conditionalId])
				) {
					state.environment.clear();
					for (const [name, value] of environment) state.environment.set(name, value);
					return false;
				}
			}
		}
		state.environment.clear();
		for (const [name, value] of environment) state.environment.set(name, value);
		return true;
	}
	if (isForOfStatement(statement) && isVariableDeclaration(statement.left) && isExpression(statement.right)) {
		const declaration = statement.left.declarations[0];
		if (statement.left.declarations.length !== 1 || !declaration || !isIdentifier(declaration.id)) {
			return addBarrier(state, "unsupported JavaScript loop binding", statement.left);
		}
		const iterable = projectExpression(statement.right, state);
		const evaluated = iterable ? staticValue(iterable, state) : undefined;
		if (
			!iterable ||
			!evaluated ||
			!Array.isArray(evaluated.value) ||
			evaluated.value.length > MAX_STATIC_LOOP_ITERATIONS
		) {
			return addBarrier(state, "unbounded or dynamic JavaScript loop", statement);
		}
		const loop: ShadowLoop = {
			kind: "loop",
			id: `${siteId(statement)}:loop`,
			iterable,
			iterations: evaluated.value.length,
			span: span(statement),
		};
		state.controls.push(loop);
		const previous = state.environment.get(declaration.id.name);
		for (const [index, value] of evaluated.value.entries()) {
			state.environment.set(declaration.id.name, { kind: "literal", value });
			for (const child of statements(statement.body)) {
				if (!projectStatement(child, state, [...dynamicPath, `loop:${index}`], controlDependencies)) return false;
			}
		}
		if (previous) state.environment.set(declaration.id.name, previous);
		else state.environment.delete(declaration.id.name);
		return true;
	}
	return addBarrier(state, "unsupported JavaScript statement", statement);
}

export interface JavaScriptShadowProjectionOptions {
	readonly snapshot?: Readonly<Record<string, unknown>>;
}

/** Projects a closed, non-executing IR for the supported eval source subset. */
export async function projectJavaScriptShadowPlan(
	code: string,
	options: JavaScriptShadowProjectionOptions = {},
): Promise<ShadowPlan> {
	let program: Program;
	try {
		const { parse } = await loadBabelParser();
		program = parse(code, { sourceType: "module", errorRecovery: false }).program;
	} catch {
		return { operations: [], barrier: { kind: "barrier", reason: "incomplete or invalid JavaScript" } };
	}
	const state: ProjectionState = {
		snapshot: options.snapshot ?? {},
		environment: new Map(),
		operations: [],
		controls: [],
		occurrences: new Map(),
		sourceOrder: 0,
	};
	for (const statement of program.body) {
		if (!projectStatement(statement, state, [], [])) break;
	}
	return {
		operations: Object.freeze(state.operations),
		...(state.controls.length > 0 ? { controls: Object.freeze(state.controls) } : {}),
		...(state.barrier ? { barrier: state.barrier } : {}),
	};
}
