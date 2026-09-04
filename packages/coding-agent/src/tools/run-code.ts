import { ToolError } from "./tool-errors";

const NON_SERIALIZABLE_RUN_ARGUMENT = "Run argument is not JSON-serializable; pass plain data";

/** Marker that renders a serialized function as an executable run argument. */
export interface FnArgMarker {
	__omp_fn: string;
}

/** Marker that renders a serialized regular expression as an executable run argument. */
export interface RegExpArgMarker {
	__omp_re: {
		source: string;
		flags?: string;
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasSoleOwnKey(value: Record<string, unknown>, key: string): boolean {
	const keys = Reflect.ownKeys(value);
	return keys.length === 1 && keys[0] === key;
}

/** Renders one host value as a JavaScript argument for an evaluated run. */
export function renderRunArg(value: unknown): string {
	if (value === undefined) return "undefined";

	if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_fn") && typeof value.__omp_fn === "string") {
		return `(${value.__omp_fn})`;
	}

	if (isPlainObject(value) && hasSoleOwnKey(value, "__omp_re")) {
		const marker = value.__omp_re;
		if (
			isPlainObject(marker) &&
			typeof marker.source === "string" &&
			(marker.flags === undefined || typeof marker.flags === "string")
		) {
			return `new RegExp(${JSON.stringify(marker.source)}, ${JSON.stringify(marker.flags ?? "")})`;
		}
	}

	let rendered: string | undefined;
	try {
		rendered = JSON.stringify(value);
	} catch {
		throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	}
	if (rendered === undefined) throw new ToolError(NON_SERIALIZABLE_RUN_ARGUMENT);
	return rendered;
}

/** Renders a function invocation with the requested run scope and positional arguments. */
export function renderFunctionRun(fnSource: string, scopeNames: readonly string[], args: readonly unknown[]): string {
	const scope = scopeNames.join(", ");
	const renderedArgs = args.map(value => `, ${renderRunArg(value)}`).join("");
	return `return await (${fnSource})({ ${scope} }${renderedArgs});`;
}
