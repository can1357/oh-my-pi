import type { RouteDefinition } from "./route-graph";

/**
 * Template virtual routes for coding roles. Targets are logical ids, not
 * catalog models. Callers register explicitly — {@link startAuthGateway} does
 * not auto-register these.
 */
export function defaultVirtualRoutes(): RouteDefinition[] {
	return [
		{
			id: "implementer",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "openai-codex/coding-model" },
					{ type: "target", model: "anthropic/coding-model" },
				],
			},
		},
		{
			id: "verifier",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "anthropic/reasoning-model" },
					{ type: "target", model: "openai-codex/reasoning-model" },
				],
			},
		},
		{
			id: "researcher",
			root: {
				type: "fallback",
				on: ["provider_unavailable"],
				children: [
					{ type: "target", model: "anthropic/reasoning-model" },
					{ type: "target", model: "openai-codex/reasoning-model" },
				],
			},
		},
	];
}
