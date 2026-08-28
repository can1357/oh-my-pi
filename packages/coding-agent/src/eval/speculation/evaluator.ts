import type {
	ShadowEvaluationContext,
	ShadowExpression,
	ShadowOperation,
	ShadowOrigin,
	ShadowPlan,
	ShadowValue,
} from "./types";

function originKey(origin: ShadowOrigin): string {
	switch (origin.kind) {
		case "provider_literal":
		case "persistent_state":
			return origin.kind;
		case "local_read":
			return `${origin.kind}:${origin.resource}`;
		case "remote_read":
			return `${origin.kind}:${origin.authority}`;
		case "model_completion":
			return `${origin.kind}:${origin.provider}:${origin.authority}`;
	}
}

function isShadowValue(value: unknown): value is ShadowValue {
	return (
		typeof value === "object" &&
		value !== null &&
		"value" in value &&
		"origins" in value &&
		Array.isArray(value.origins)
	);
}

export function mergeShadowValues(value: unknown, inputs: readonly ShadowValue[]): ShadowValue {
	const origins: ShadowOrigin[] = [];
	const seen = new Set<string>();
	for (const input of inputs) {
		for (const origin of input.origins) {
			const key = originKey(origin);
			if (seen.has(key)) continue;
			seen.add(key);
			origins.push(origin);
		}
	}
	return { value, origins: Object.freeze(origins) };
}

function readProperty(value: unknown, property: string | number): unknown {
	if (Array.isArray(value)) {
		if (typeof property === "number" && Number.isSafeInteger(property) && property >= 0) return value[property];
		if (property === "length") return value.length;
		throw new Error("unsupported array property");
	}
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error("property access requires a plain shadow object");
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, String(property));
	if (!descriptor || !("value" in descriptor)) throw new Error("shadow property is absent or accessor-backed");
	return descriptor.value;
}

export function evaluateShadowExpression(expression: ShadowExpression, context: ShadowEvaluationContext): ShadowValue {
	switch (expression.kind) {
		case "literal":
			return { value: expression.value, origins: [{ kind: "provider_literal" }] };
		case "snapshot": {
			if (!Object.hasOwn(context.snapshot, expression.name))
				throw new Error(`snapshot value '${expression.name}' is absent`);
			const value = context.snapshot[expression.name];
			return isShadowValue(value) ? value : { value, origins: [{ kind: "persistent_state" }] };
		}
		case "operation_result": {
			const value = context.results.get(expression.operationId);
			if (!value) throw new Error(`operation result '${expression.operationId}' is not settled`);
			return value;
		}
		case "property": {
			const target = evaluateShadowExpression(expression.target, context);
			return { value: readProperty(target.value, expression.property), origins: target.origins };
		}
		case "array": {
			const items = expression.items.map(item => evaluateShadowExpression(item, context));
			return mergeShadowValues(
				items.map(item => item.value),
				items,
			);
		}
		case "object": {
			const entries = expression.entries.map(entry => ({
				...entry,
				evaluated: evaluateShadowExpression(entry.value, context),
			}));
			return mergeShadowValues(
				Object.fromEntries(entries.map(entry => [entry.key, entry.evaluated.value])),
				entries.map(entry => entry.evaluated),
			);
		}
		case "concat": {
			const items = expression.items.map(item => evaluateShadowExpression(item, context));
			return mergeShadowValues(items.map(item => String(item.value)).join(""), items);
		}
		case "transform": {
			const input = evaluateShadowExpression(expression.input, context);
			if (expression.name === "String") return { value: String(input.value), origins: input.origins };
			if (expression.name === "Python.str") {
				if (typeof input.value !== "string") {
					throw new Error("Python str() projection requires a string shadow value");
				}
				return input;
			}
			if (expression.name === "JSON.stringify") {
				const value = JSON.stringify(input.value);
				if (value === undefined) throw new Error("JSON.stringify produced no value");
				return { value, origins: input.origins };
			}
			if (!Array.isArray(input.value)) throw new Error("Array.join requires an array shadow value");
			const argument = expression.argument
				? evaluateShadowExpression(expression.argument, context)
				: { value: ",", origins: [{ kind: "provider_literal" } as const] };
			return mergeShadowValues(input.value.join(String(argument.value)), [input, argument]);
		}
	}
}

export interface EvaluatedShadowOperation {
	readonly operation: ShadowOperation;
	readonly args: ShadowValue;
}

export function completionEgressIsSafe(args: ShadowValue, provider: string, authority: string): boolean {
	return args.origins.every(origin => {
		if (origin.kind === "provider_literal") return true;
		return origin.kind === "model_completion" && origin.provider === provider && origin.authority === authority;
	});
}

export function evaluateShadowOperation(
	operation: ShadowOperation,
	context: ShadowEvaluationContext,
	completion?: { provider: string; authority: string },
): EvaluatedShadowOperation {
	const args = evaluateShadowExpression(operation.call.args, context);
	if (operation.call.name === "completion") {
		if (!completion || !completionEgressIsSafe(args, completion.provider, completion.authority)) {
			throw new Error("unsafe completion information flow");
		}
	}
	return { operation, args };
}

export function evaluateShadowPlan(
	plan: ShadowPlan,
	context: ShadowEvaluationContext,
	completion?: { provider: string; authority: string },
): { operations: readonly EvaluatedShadowOperation[]; barrier?: ShadowPlan["barrier"] } {
	const operations: EvaluatedShadowOperation[] = [];
	for (const operation of plan.operations) {
		try {
			operations.push(evaluateShadowOperation(operation, context, completion));
		} catch (error) {
			return {
				operations,
				barrier: {
					kind: "barrier",
					reason: error instanceof Error ? error.message : String(error),
					span: operation.call.span,
				},
			};
		}
	}
	return { operations, barrier: plan.barrier };
}
