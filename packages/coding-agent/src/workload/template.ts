/** One completed step's observable result, as the template scope sees it. */
export interface WorkloadStepOutput {
	/** Agent step: yielded text, or parsed data when the step declared an output_schema. For a for_each step: the array of per-item outputs, in item order. */
	output?: unknown;
	/** Shell step only. */
	stdout?: string;
	/** Shell step only. */
	exitCode?: number;
}

export interface TemplateScope {
	args: Record<string, string>;
	steps: Record<string, WorkloadStepOutput>;
	/** Present only while expanding a for_each step's own fields. */
	item?: unknown;
	itemIndex?: number;
}

export class WorkloadTemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkloadTemplateError";
	}
}

const VALID_ROOTS = "args, steps, item, item_index";

/** Expand every `${...}` reference in `text`. Objects/arrays render as compact JSON. */
export function interpolate(text: string, scope: TemplateScope): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("$${", i)) {
			out += "${";
			i += 3;
			continue;
		}
		if (text.startsWith("${", i)) {
			const close = text.indexOf("}", i + 2);
			if (close === -1) {
				throw new WorkloadTemplateError(`Unterminated template reference ${JSON.stringify(text.slice(i))}.`);
			}
			const display = text.slice(i, close + 1);
			const value = resolvePath(text.slice(i + 2, close).trim(), scope, display);
			if (typeof value === "string") {
				out += value;
			} else if (typeof value === "number" || typeof value === "boolean" || value === null) {
				out += String(value);
			} else {
				out += JSON.stringify(value);
			}
			i = close + 1;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

/** Resolve one reference to its raw value; the input may be `"${steps.a.output.files}"` (with or without surrounding whitespace) or a bare path like `steps.a.output.files`. */
export function resolveReference(expression: string, scope: TemplateScope): unknown {
	const trimmed = expression.trim();
	if (trimmed.startsWith("${")) {
		if (!trimmed.endsWith("}")) {
			throw new WorkloadTemplateError(`Unterminated template reference ${JSON.stringify(trimmed)}.`);
		}
		return resolvePath(trimmed.slice(2, -1).trim(), scope, trimmed);
	}
	return resolvePath(trimmed, scope, trimmed);
}

function resolvePath(expr: string, scope: TemplateScope, display: string): unknown {
	if (!expr) {
		throw new WorkloadTemplateError(`Empty template reference "${display}". Valid roots: ${VALID_ROOTS}.`);
	}
	const segments = splitPath(expr, display);
	const root = segments[0]!;
	if (root !== "args" && root !== "steps" && root !== "item" && root !== "item_index") {
		throw new WorkloadTemplateError(`Unknown template root "${root}" in "${display}". Valid roots: ${VALID_ROOTS}.`);
	}

	if (root === "args") {
		if (segments.length === 1) return scope.args;
		const name = segments[1]!;
		if (!Object.hasOwn(scope.args, name)) {
			throw new WorkloadTemplateError(`Missing path "${name}" in "${display}".`);
		}
		return walk(scope.args[name], segments, 2, display);
	}

	if (root === "steps") {
		if (segments.length === 1) return scope.steps;
		const stepId = segments[1]!;
		if (!Object.hasOwn(scope.steps, stepId)) {
			throw new WorkloadTemplateError(`Unknown or unfinished step "${stepId}" in "${display}".`);
		}
		const step = scope.steps[stepId]!;
		if (segments.length === 2) return step;
		const fieldToken = segments[2]!;
		const field = fieldToken === "exit_code" ? "exitCode" : fieldToken;
		if (field !== "output" && field !== "stdout" && field !== "exitCode") {
			throw new WorkloadTemplateError(`Missing path "${fieldToken}" in "${display}".`);
		}
		if (!Object.hasOwn(step, field) || step[field] === undefined) {
			throw new WorkloadTemplateError(`Missing path "${fieldToken}" in "${display}".`);
		}
		return walk(step[field], segments, 3, display);
	}

	if (root === "item") {
		if (scope.item === undefined) {
			throw new WorkloadTemplateError(`Reference "${display}" is only valid inside a for_each step.`);
		}
		return walk(scope.item, segments, 1, display);
	}

	if (scope.itemIndex === undefined) {
		throw new WorkloadTemplateError(`Reference "${display}" is only valid inside a for_each step.`);
	}
	return walk(scope.itemIndex, segments, 1, display);
}

function splitPath(expr: string, display: string): string[] {
	const segments: string[] = [];
	let i = 0;

	const skipWs = (): void => {
		while (i < expr.length && /\s/.test(expr[i]!)) i++;
	};

	const readIdent = (): string => {
		skipWs();
		const start = i;
		while (i < expr.length && /[A-Za-z0-9_-]/.test(expr[i]!)) i++;
		if (i === start) {
			throw new WorkloadTemplateError(`Invalid template reference "${display}".`);
		}
		return expr.slice(start, i);
	};

	segments.push(readIdent());
	while (i < expr.length) {
		skipWs();
		if (i >= expr.length) break;
		if (expr[i] === ".") {
			i++;
			segments.push(readIdent());
			continue;
		}
		if (expr[i] === "[") {
			i++;
			skipWs();
			let seg: string;
			const quote = expr[i];
			if (quote === '"' || quote === "'") {
				const close = expr.indexOf(quote, i + 1);
				if (close === -1) {
					throw new WorkloadTemplateError(`Invalid template reference "${display}".`);
				}
				seg = expr.slice(i + 1, close);
				i = close + 1;
			} else {
				seg = readIdent();
			}
			skipWs();
			if (expr[i] !== "]") {
				throw new WorkloadTemplateError(`Invalid template reference "${display}".`);
			}
			i++;
			segments.push(seg);
			continue;
		}
		throw new WorkloadTemplateError(`Invalid template reference "${display}".`);
	}
	return segments;
}

function walk(current: unknown, segments: string[], from: number, display: string): unknown {
	for (let s = from; s < segments.length; s++) {
		const key = segments[s]!;
		if (current === null || current === undefined || typeof current !== "object") {
			throw new WorkloadTemplateError(`Missing path "${key}" in "${display}".`);
		}
		if (Array.isArray(current)) {
			const idx = Number(key);
			if (String(idx) === key && Number.isInteger(idx) && idx >= 0 && Object.hasOwn(current, idx)) {
				current = current[idx];
				continue;
			}
		}
		if (!Object.hasOwn(current, key)) {
			throw new WorkloadTemplateError(`Missing path "${key}" in "${display}".`);
		}
		current = (current as Record<string, unknown>)[key];
	}
	if (current === undefined) {
		throw new WorkloadTemplateError(`Missing path "${segments[segments.length - 1]}" in "${display}".`);
	}
	return current;
}
