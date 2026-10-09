import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ModelRegistry } from "../../src/config/model-registry";
import { cfgDisabledProviders, cfgEnabledModels, cfgModelRoles } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import { cfgRetryFallbackChains } from "../../src/session/settings";
import {
	adoptRoleRouteCandidate,
	assertRoleDispatch,
	createTaskModelRoute,
	inspectRoleRouteCandidate,
	narrowRoleRoute,
	resolveRoleRoute,
	restoreTaskModelRoute,
	roleRouteFallbackCandidates,
	roleRouteMetadata,
	wrapRoleRouteStream,
	type TaskModelAuthority,
} from "../../src/task/role-routing";

function model(id: string, changes: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const base = buildModel({
		provider: "route-fixture",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	return { ...base, ...changes };
}

function fixture() {
	const primary = model("primary");
	const fallback = model("fallback");
	const outsider = model("outsider");
	const state = { models: [primary, fallback, outsider] as Model[], available: true };
	const registry = {
		getAll: () => state.models,
		getAvailable: () => (state.available ? state.models : []),
		hasConfiguredAuth: () => state.available,
		isSelectorSuppressed: () => false,
	} as unknown as ModelRegistry;
	const settings = Settings.isolated({
		modelRoles: { review: "route-fixture/primary:high", independent: "route-fixture/primary" },
		"retry.fallbackChains": { review: ["route-fixture/fallback:low"] },
	});
	const authority: TaskModelAuthority = { settings, agentName: "worker" };
	return { primary, fallback, outsider, state, registry, settings, authority };
}

function recordingStream(delivered: string[]): StreamFn {
	return async (serving, _context, options) => {
		await options?.onPayload?.({ model: serving.id, reasoning_effort: options?.reasoning }, serving);
		delivered.push(`${serving.provider}/${serving.id}:${options?.reasoning ?? "unset"}`);
		return new AssistantMessageEventStream();
	};
}

describe("governed provider dispatch closure", () => {
	it("blocks authenticated enabled catalog models without an operator grant", async () => {
		const f = fixture();
		cfgEnabledModels.override(f.settings, ["route-fixture/*"]);
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["route-fixture/outsider"],
				explicit: true,
			}),
		).rejects.toThrow(/not authorized/);
	});

	it("does not fuzzy-rematch an unavailable explicit identity onto a similarly named approved model", async () => {
		const f = fixture();
		const sibling = model("primary-extra");
		f.state.models = [sibling];
		cfgModelRoles.override(f.settings, { expected: "route-fixture/primary", sibling: "route-fixture/primary-extra" });
		cfgRetryFallbackChains.override(f.settings, {});
		const admitted = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["route-fixture/primary"],
			explicit: true,
		});
		expect(() => resolveRoleRoute(admitted.permit, f.registry)).toThrow(/No usable model remains/);
	});

	it("checks disabled entries' authority and preserves their ordered occurrence before using an approved alternative", async () => {
		const f = fixture();
		const disabled = model("disabled", { provider: "disabled-route" });
		const unassigned = model("unassigned", { provider: "disabled-route" });
		f.state.models.push(disabled, unassigned);
		cfgModelRoles.override(f.settings, { disabled: "disabled-route/disabled", enabled: "route-fixture/primary" });
		cfgRetryFallbackChains.override(f.settings, {});
		cfgDisabledProviders.override(f.settings, ["disabled-route"]);
		await expect(
			createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["disabled-route/unassigned", "route-fixture/primary"],
				explicit: true,
			}),
		).rejects.toThrow(/not authorized/);
		const admitted = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["disabled-route/disabled", "route-fixture/primary"],
			explicit: true,
		});
		expect(resolveRoleRoute(admitted.permit, f.registry)).toMatchObject({
			model: { provider: "route-fixture", id: "primary" },
			occurrence: 1,
		});
	});

	it("surfaces fixed effort changes and provider-side fallback options before dispatch", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const delivered: string[] = [];
		const guarded = wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry);
		await guarded(f.primary, { messages: [] }, { reasoning: Effort.High });
		await expect(guarded(f.primary, { messages: [] }, { reasoning: Effort.Low })).rejects.toThrow(/effort/);
		await expect(
			guarded(f.primary, { messages: [] }, { reasoning: Effort.High, forceReasoningOff: true }),
		).rejects.toThrow(/suppression/);
		await expect(
			guarded(f.primary, { messages: [] }, { reasoning: Effort.High, fallbacks: [{ model: "outsider" }] }),
		).rejects.toThrow(/fallback/);
		expect(delivered).toEqual(["route-fixture/primary:high"]);
	});

	it("rejects a payload hook changing the serving model or fixed reasoning", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const delivered: string[] = [];
		const guarded = wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry);
		await expect(
			guarded(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High, onPayload: () => ({ model: "outsider", reasoning_effort: "high" }) },
			),
		).rejects.toThrow(/payload/);
		await expect(
			guarded(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High, onPayload: () => ({ model: "primary", reasoning_effort: "low" }) },
			),
		).rejects.toThrow(/payload/);
		expect(delivered).toEqual([]);
	});

	it("allows hook narrowing/reorder and effort qualification without adding authority", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {
			review: "route-fixture/primary",
			fallback: "route-fixture/fallback",
			extra: "route-fixture/outsider",
		});
		const original = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review", "@fallback"],
			explicit: true,
		});
		const narrowed = narrowRoleRoute(original.permit, ["@fallback:high", "@review:low"], f.registry);
		expect(resolveRoleRoute(narrowed.permit, f.registry)).toMatchObject({
			model: { id: "fallback" },
			thinkingLevel: Effort.High,
			role: "fallback",
			occurrence: 0,
		});
		assertRoleDispatch(narrowed.permit, f.fallback, Effort.High, undefined, f.registry);
		expect(() => narrowRoleRoute(original.permit, ["@extra"], f.registry)).toThrow(/escaped/);
		expect(() => narrowRoleRoute(narrowed.permit, ["@fallback:low"], f.registry)).toThrow(/escaped/);
	});

	for (const change of ["removed", "reordered", "duplicate", "effort"] as const) {
		it(`revokes a ${change} role dependency even when another role grants the same model`, async () => {
			const f = fixture();
			cfgModelRoles.override(f.settings, {
				review: "route-fixture/primary:high,route-fixture/fallback:low",
				independent: "route-fixture/primary",
			});
			cfgRetryFallbackChains.override(f.settings, {});
			const { permit } = await createTaskModelRoute({
				authority: f.authority,
				modelRegistry: f.registry,
				selectors: ["@review"],
				explicit: true,
			});
			const replacements = {
				removed: undefined,
				reordered: "route-fixture/fallback:low,route-fixture/primary:high",
				duplicate: "route-fixture/primary:high,route-fixture/primary:high,route-fixture/fallback:low",
				effort: "route-fixture/primary:low,route-fixture/fallback:low",
			};
			cfgModelRoles.override(f.settings, {
				...(replacements[change] ? { review: replacements[change] } : {}),
				independent: "route-fixture/primary",
			});
			expect(() => assertRoleDispatch(permit, f.primary, Effort.High, undefined, f.registry)).toThrow(
				/configuration changed/,
			);
		});
	}

	it("keeps auto as a configured mode across an approved retry occurrence", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, { review: "route-fixture/primary:auto" });
		cfgRetryFallbackChains.override(f.settings, { review: ["route-fixture/fallback:auto"] });
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		const next = roleRouteFallbackCandidates(permit, f.registry)[0];
		expect(next).toMatchObject({ model: { id: "fallback" }, thinkingLevel: "auto", fixedEffort: false });
		inspectRoleRouteCandidate(permit, next.selector, next.model, f.registry);
		expect(resolveRoleRoute(permit, f.registry).model.id).toBe("primary");
		adoptRoleRouteCandidate(permit, next.selector, next.model, f.registry);
		assertRoleDispatch(permit, f.fallback, Effort.Low, undefined, f.registry);
		assertRoleDispatch(permit, f.fallback, Effort.High, undefined, f.registry);
		expect(roleRouteMetadata(permit)?.selectedOccurrence).toBe(1);
		expect(() => narrowRoleRoute(permit, ["route-fixture/fallback:low"], f.registry)).toThrow(/escaped/);
	});

	it("preserves literal colon IDs while role effort overrides remain independent", async () => {
		const f = fixture();
		const literal = model("primary:high");
		f.state.models.push(literal);
		cfgModelRoles.override(f.settings, { literal: "route-fixture/primary:high", review: "route-fixture/primary" });
		const literalRoute = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@literal:low"],
			explicit: true,
		});
		expect(resolveRoleRoute(literalRoute.permit, f.registry)).toMatchObject({
			model: { id: "primary:high" },
			thinkingLevel: Effort.Low,
		});
		assertRoleDispatch(literalRoute.permit, literal, Effort.Low, undefined, f.registry);
		const realPrimary = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review:high"],
			explicit: true,
		});
		expect(resolveRoleRoute(realPrimary.permit, f.registry)).toMatchObject({
			model: { id: "primary" },
			thinkingLevel: Effort.High,
		});
		expect(
			parseModelString("route-fixture/primary:high", {
				isLiteralModelId: (provider, id) => provider === "route-fixture" && id === literal.id,
			}),
		).toEqual({ provider: "route-fixture", id: "primary:high" });
	});

	it("revalidates deferred discovery identity and rejects a late transport replacement", async () => {
		const f = fixture();
		f.state.models = [];
		cfgModelRoles.override(f.settings, { review: "route-fixture/late" });
		cfgRetryFallbackChains.override(f.settings, {});
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review:high"],
			explicit: true,
		});
		const late = model("late");
		f.state.models.push(late);
		expect(resolveRoleRoute(permit, f.registry)).toMatchObject({ model: { id: "late" }, thinkingLevel: Effort.High });
		f.state.models = [{ ...late, baseUrl: "http://127.0.0.1:2/v1" }];
		expect(() => assertRoleDispatch(permit, late, Effort.High, undefined, f.registry)).toThrow(/transport/);
		f.state.models = [{ ...late, requestModelId: "unapproved-wire-model" }];
		expect(() => assertRoleDispatch(permit, late, Effort.High, undefined, f.registry)).toThrow(
			/wire model\/effort policy/,
		);
	});

	it("blocks current frontmatter revocation before delivering a provider request", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {});
		cfgRetryFallbackChains.override(f.settings, {});
		const authority: TaskModelAuthority = {
			settings: f.settings,
			agentName: "worker",
			agentModel: ["route-fixture/primary"],
			getAgentModel: async () => [],
		};
		const { permit } = await createTaskModelRoute({
			authority,
			modelRegistry: f.registry,
			selectors: ["route-fixture/primary"],
			explicit: true,
		});
		const delivered: string[] = [];
		await expect(
			wrapRoleRouteStream(() => permit, recordingStream(delivered), f.registry)(
				f.primary,
				{ messages: [] },
				{ reasoning: Effort.High },
			),
		).rejects.toThrow(/not authorized/);
		expect(delivered).toEqual([]);
	});

	it("does not revive a recorded old parent without current independent authority", async () => {
		const f = fixture();
		cfgModelRoles.override(f.settings, {});
		cfgRetryFallbackChains.override(f.settings, {});
		const live: TaskModelAuthority = {
			...f.authority,
			getParentModel: () => f.primary,
			getParentSelector: () => "route-fixture/primary:high",
		};
		const { permit } = await createTaskModelRoute({
			authority: live,
			modelRegistry: f.registry,
			selectors: ["@default"],
			explicit: true,
		});
		const receipt = roleRouteMetadata(permit)!;
		await expect(restoreTaskModelRoute(f.authority, f.registry, receipt)).rejects.toThrow(/not authorized/);
		cfgModelRoles.override(f.settings, { independent: "route-fixture/primary" });
		const restored = await restoreTaskModelRoute(f.authority, f.registry, receipt);
		assertRoleDispatch(restored.permit, f.primary, Effort.High, undefined, f.registry);
	});

	it("fails current enabled/provider/capability loss rather than switching to an unrelated model", async () => {
		const f = fixture();
		const { permit } = await createTaskModelRoute({
			authority: f.authority,
			modelRegistry: f.registry,
			selectors: ["@review"],
			explicit: true,
		});
		cfgEnabledModels.override(f.settings, ["route-fixture/fallback"]);
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
		cfgEnabledModels.override(f.settings, []);
		cfgDisabledProviders.override(f.settings, ["route-fixture"]);
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
		cfgDisabledProviders.override(f.settings, []);
		f.state.models = [{ ...f.primary, supportsTools: false }, f.fallback, f.outsider];
		expect(() => resolveRoleRoute(permit, f.registry)).toThrow(/unavailable/);
	});
});
