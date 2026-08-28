/**
 * Adaptive-Fidelity Facade (ACF lane).
 *
 * The single observe-only integration point for the adaptive-fidelity track.
 * It composes four optional stages behind ONE flag:
 *
 *   planState -> bounded full/summarized/evicted working state
 *   route     -> representation lanes
 *   gate      -> activate/shadow/suppress decisions
 *   measure   -> activation-sparsity telemetry
 *
 * It imports NOTHING: every stage is an INJECTED PORT. That keeps the facade
 * self-contained and means it can never introduce an unresolvable import,
 * no matter what order the underlying modules land in.
 *
 * Discipline (matches the rest of the memory-fabric lanes):
 *   - Imports NOTHING; additive (not wired into any index).
 *   - OBSERVE-ONLY: assembles a view; executes/mutates nothing.
 *   - DISABLED-BY-DEFAULT: inert unless `options.enabled === true`.
 *   - FAIL-OPEN at the top AND per-stage: a throwing or null-returning port
 *     degrades only that stage (recorded as not-run); the others still run.
 *   - DETERMINISTIC: no clocks, no randomness.
 */

/** Stage names, in composition order. */
export type AdaptiveFidelityStage = "state" | "route" | "gate" | "sparsity";

/**
 * Injected stage ports. All optional — a stage is simply skipped when its port
 * is absent. Kept structurally loose (each returns `unknown`) so the facade
 * stays decoupled from the concrete stage module types and imports nothing.
 */
export interface AdaptiveFidelityPorts {
	/** Plan the bounded full/summarized/evicted working state. */
	planState?: (items: unknown[], options?: unknown) => unknown;
	/** Route retained items into representation lanes. */
	route?: (items: unknown[], options?: unknown) => unknown;
	/** Gate activations into activate/shadow/suppress. */
	gate?: (signals: unknown[], options?: unknown) => unknown;
	/** Measure activation sparsity. */
	measure?: (input: unknown, options?: unknown) => unknown;
}

/** A routable item shape the facade can derive from a planned state item. */
interface DerivableStateItem {
	id?: unknown;
	tier?: unknown;
	protected?: unknown;
	local?: unknown;
	evidence?: unknown;
}

export interface AdaptiveFidelityRequest {
	/** planState input: candidate context items. */
	items?: unknown[];
	stateOptions?: unknown;
	/** route input: explicit items to route. When omitted, derived from the planned state. */
	routeItems?: unknown[];
	routeOptions?: unknown;
	/** gate input: activation signals. */
	signals?: unknown[];
	gateOptions?: unknown;
	/** measure input: sparsity counts (or a fidelity-state object). */
	sparsityInput?: unknown;
	sparsityOptions?: unknown;
}

export interface AdaptiveFidelityViewOptions {
	/** Disabled by default. When not true an inert view is returned. */
	enabled?: boolean;
}

export interface AdaptiveFidelityView {
	mode: "observe";
	enabled: boolean;
	/** Which stages actually ran (a port present, invoked, and returning non-null). */
	stages: AdaptiveFidelityStage[];
	state: unknown;
	routing: unknown;
	gate: unknown;
	sparsity: unknown;
}

function inert(): AdaptiveFidelityView {
	return { mode: "observe", enabled: false, stages: [], state: null, routing: null, gate: null, sparsity: null };
}

/** Run a stage port, returning `fallback` on throw or null/undefined result. */
function safeRun<T>(fn: () => T, fallback: T): T {
	try {
		const value = fn();
		return value === undefined || value === null ? fallback : value;
	} catch {
		return fallback;
	}
}

/** Derive route items from a planned state's `items`, when present. */
function deriveRouteItems(state: unknown): unknown[] | null {
	const items = (state as { items?: unknown })?.items;
	if (!Array.isArray(items)) return null;
	return items.map(i => {
		const it = (i ?? {}) as DerivableStateItem;
		return { id: it.id, tier: it.tier, protected: it.protected, local: it.local, evidence: it.evidence };
	});
}

/**
 * Compose the adaptive-fidelity track into one observe-only view. Every stage
 * is optional and independently fail-open. Inert when disabled.
 */
export function buildAdaptiveFidelityView(
	request: AdaptiveFidelityRequest,
	ports: AdaptiveFidelityPorts = {},
	options: AdaptiveFidelityViewOptions = {},
): AdaptiveFidelityView {
	if (options.enabled !== true) return inert();

	try {
		const req = request ?? ({} as AdaptiveFidelityRequest);
		const p = ports ?? ({} as AdaptiveFidelityPorts);
		const stages: AdaptiveFidelityStage[] = [];

		const planState = p.planState;
		let state: unknown = null;
		if (typeof planState === "function") {
			state = safeRun(() => planState(req.items ?? [], req.stateOptions), null);
			if (state !== null) stages.push("state");
		}

		const route = p.route;
		let routing: unknown = null;
		if (typeof route === "function") {
			const routeItems = req.routeItems ?? deriveRouteItems(state) ?? [];
			routing = safeRun(() => route(routeItems, req.routeOptions), null);
			if (routing !== null) stages.push("route");
		}

		const gate = p.gate;
		let gateResult: unknown = null;
		if (typeof gate === "function") {
			gateResult = safeRun(() => gate(req.signals ?? [], req.gateOptions), null);
			if (gateResult !== null) stages.push("gate");
		}

		const measure = p.measure;
		let sparsity: unknown = null;
		if (typeof measure === "function") {
			sparsity = safeRun(() => measure(req.sparsityInput ?? {}, req.sparsityOptions), null);
			if (sparsity !== null) stages.push("sparsity");
		}

		return { mode: "observe", enabled: true, stages, state, routing, gate: gateResult, sparsity };
	} catch {
		return inert();
	}
}

/** A short deterministic one-line summary (for logs/telemetry). */
export function summarizeAdaptiveFidelityView(view: AdaptiveFidelityView): string {
	if (view?.enabled !== true) return "adaptive-fidelity: disabled";
	return `adaptive-fidelity: stages=[${view.stages.join(",")}]`;
}
