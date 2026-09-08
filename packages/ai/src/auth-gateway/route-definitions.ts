import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { GatewayErrorDisposition } from "../error/gateway";
import type { RouteDefinition, RouteNode } from "./route-graph";

const GATEWAY_ERROR_DISPOSITIONS = {
	cancelled: true,
	context_overflow: true,
	credential_permanent: true,
	credential_quota: true,
	credential_transient: true,
	gateway_terminal: true,
	model_unavailable: true,
	policy_terminal: true,
	provider_transient: true,
	provider_unavailable: true,
	request_terminal: true,
} as const satisfies Record<GatewayErrorDisposition, true>;

function parseDisposition(value: unknown): GatewayErrorDisposition {
	if (typeof value !== "string" || !Object.hasOwn(GATEWAY_ERROR_DISPOSITIONS, value)) {
		throw new AIError.ValidationError(`Unknown gateway error disposition: ${String(value)}`);
	}
	return value as GatewayErrorDisposition;
}

function parseNode(input: unknown): RouteNode {
	if (!isRecord(input)) {
		throw new AIError.ValidationError("Route node must be an object");
	}
	const type = input.type;
	if (type === "target") {
		if (typeof input.model !== "string" || input.model.length === 0) {
			throw new AIError.ValidationError("Target node missing model");
		}
		return { type: "target", model: input.model };
	}
	if (type === "fallback") {
		if (!Array.isArray(input.on)) {
			throw new AIError.ValidationError("Fallback node missing on dispositions");
		}
		if (!Array.isArray(input.children) || input.children.length === 0) {
			throw new AIError.ValidationError("Fallback node has empty children");
		}
		const on = input.on.map(parseDisposition);
		const children = input.children.map(parseNode);
		return { type: "fallback", on, children };
	}
	if (type === "balance") {
		if (input.strategy !== "rr" && input.strategy !== "weighted") {
			throw new AIError.ValidationError(`Unknown balance strategy: ${String(input.strategy)}`);
		}
		if (!Array.isArray(input.children)) {
			throw new AIError.ValidationError("Balance node missing children");
		}
		return { type: "balance", strategy: input.strategy, children: input.children.map(parseNode) };
	}
	if (type === "conditional") {
		if (!isRecord(input.when)) {
			throw new AIError.ValidationError("Conditional node missing when object");
		}
		const when: { vision?: boolean } = {};
		if ("vision" in input.when) {
			if (typeof input.when.vision !== "boolean") {
				throw new AIError.ValidationError("Conditional when.vision must be a boolean");
			}
			when.vision = input.when.vision;
		}
		if (!Array.isArray(input.children)) {
			throw new AIError.ValidationError("Conditional node missing children");
		}
		return { type: "conditional", when, children: input.children.map(parseNode) };
	}
	if (type === "domain") {
		if (typeof input.name !== "string" || input.name.length === 0) {
			throw new AIError.ValidationError("Domain node missing name");
		}
		if (!Array.isArray(input.children)) {
			throw new AIError.ValidationError("Domain node missing children");
		}
		return { type: "domain", name: input.name, children: input.children.map(parseNode) };
	}
	if (type === "route-ref") {
		if (typeof input.route !== "string" || input.route.length === 0) {
			throw new AIError.ValidationError("Route-ref node missing route");
		}
		return { type: "route-ref", route: input.route };
	}
	throw new AIError.ValidationError(`Unknown route node type: ${String(type)}`);
}

/**
 * Parse a single virtual route definition object.
 * Does not detect model-id cycles — {@link RouteRegistry.register} does.
 */
export function parseRouteDefinition(input: unknown): RouteDefinition {
	if (!isRecord(input)) {
		throw new AIError.ValidationError("Route definition must be an object");
	}
	if (typeof input.id !== "string" || input.id.length === 0) {
		throw new AIError.ValidationError("Route definition missing id");
	}
	if (!("root" in input)) {
		throw new AIError.ValidationError("Route definition missing root");
	}
	return { id: input.id, root: parseNode(input.root) };
}

/**
 * Parse virtual route definitions from a JSON/JSON5 document body.
 * Accepts `{ routes: RouteDefinition[] }` or `RouteDefinition[]`.
 * Does not detect model-id cycles — {@link RouteRegistry.register} does.
 */
export function parseRouteDefinitions(input: unknown): RouteDefinition[] {
	if (Array.isArray(input)) {
		return input.map(parseRouteDefinition);
	}
	if (isRecord(input) && Array.isArray(input.routes)) {
		return input.routes.map(parseRouteDefinition);
	}
	throw new AIError.ValidationError("Route definitions must be an array or an object with a routes array");
}

/**
 * Read UTF-8 JSON5 from `path` and parse it as route definitions.
 * Missing files and JSON5 syntax errors become {@link AIError.ValidationError}.
 */
export async function loadRouteDefinitionsFile(path: string): Promise<RouteDefinition[]> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new AIError.ValidationError(`Route definitions file not found: ${path}`, { cause: error });
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = Bun.JSON5.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new AIError.ValidationError(`Invalid JSON5 in route definitions file ${path}: ${detail}`, {
			cause: error,
		});
	}
	return parseRouteDefinitions(parsed);
}
