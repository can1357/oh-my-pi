/**
 * Contract: a discovered reasoning model without a model-scoped effort rule
 * adopts the ladder the shared catalog publishes for its id, while reviewed
 * ladders and non-reasoning rows stay exactly as they are. The shared catalog
 * is the only source; nothing else is fetched.
 *
 * Moonshot's mapper marks any `-thinking` variant as reasoning, including
 * unrecognized ids with only a neutral wire default. Novita supplies the
 * complementary case: an unrecognized id with a provider-wide class default.
 */
import { expect, test } from "bun:test";
import { hasModelScopedEffortLadder, resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	moonshotModelManagerOptions,
	novitaModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const SHARED_CATALOG_URL = "https://catalog.stencil.so/models.json.zstd";
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_MODELS_URL = `${MOONSHOT_BASE_URL}/models`;

/** No rule declares this id's tiers: its ladder is the neutral wire default. */
const UNREVIEWED_ID = "nebula-9b-thinking";
/** A rule-owned identity: reviewed KDL declares this model's tiers. */
const REVIEWED_ID = "kimi-k3";

function catalogRow(ladder?: string[]): Record<string, unknown> {
	return {
		tool_call: true,
		reasoning: true,
		modalities: { input: ["text"] },
		limit: { context: 131_072, output: 32_768 },
		cost: { input: 1, output: 2 },
		...(ladder && { reasoning_options: [{ type: "effort", values: ladder }] }),
	};
}

function stubFetch(routes: Record<string, unknown>, calls: string[], modelIds: string[]): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url.startsWith(MOONSHOT_MODELS_URL)) {
			return Response.json({ data: modelIds.map(id => ({ id, object: "model" })) });
		}
		const payload = routes[url];
		return payload === undefined ? new Response("not found", { status: 404 }) : Response.json(payload);
	}) as FetchImpl;
}

function discover(fetchImpl: FetchImpl): Promise<readonly ModelSpec<"openai-completions">[] | null | undefined> {
	return Promise.resolve(
		moonshotModelManagerOptions({
			apiKey: "moonshot-test-key",
			baseUrl: MOONSHOT_BASE_URL,
			fetch: fetchImpl,
		}).fetchDynamicModels?.(),
	);
}

test("the neutral default and a rule-owned ladder are distinguishable", () => {
	const spec = {
		id: UNREVIEWED_ID,
		name: UNREVIEWED_ID,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: MOONSHOT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">;

	expect(hasModelScopedEffortLadder(spec)).toBe(false);
	expect(hasModelScopedEffortLadder({ ...spec, id: REVIEWED_ID })).toBe(true);
});

test("published tiers replace the guess", async () => {
	const calls: string[] = [];
	const models = await discover(
		stubFetch(
			{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high", "max"]) } } } },
			calls,
			[UNREVIEWED_ID],
		),
	);
	const model = models?.find(candidate => candidate.id === UNREVIEWED_ID);

	expect(model?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	// The guess it replaced, so the assertion above cannot pass by accident.
	expect(resolveModelPolicy({ ...model!, thinking: undefined }).thinking?.efforts).not.toEqual([
		Effort.Low,
		Effort.High,
		Effort.Max,
	]);
	// The shared catalog is the only source consulted.
	expect(calls.filter(url => url !== MOONSHOT_MODELS_URL)).toEqual([SHARED_CATALOG_URL]);
});

test("gateway prefixes are peeled to find the upstream host's ladder", async () => {
	const id = `acme/${UNREVIEWED_ID}`;
	const models = await discover(
		stubFetch(
			{ [SHARED_CATALOG_URL]: { acme: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } } },
			[],
			[id],
		),
	);

	expect(models?.find(candidate => candidate.id === id)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
});

test("a provider-wide unknown-class ladder yields to published tiers", async () => {
	const baseUrl = "https://api.novita.ai/openai/v1";
	const id = "acme/nebula-9b";
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === `${baseUrl}/models`) {
			return Response.json({
				data: [
					{
						id,
						features: ["reasoning", "function-calling"],
						endpoints: ["chat/completions"],
						max_output_tokens: 32_768,
					},
				],
			});
		}
		return Response.json({ novita: { models: { [id]: catalogRow(["low", "high"]) } } });
	}) as FetchImpl;
	const models = await novitaModelManagerOptions({
		apiKey: "novita-test-key",
		baseUrl,
		fetch: fetchImpl,
	}).fetchDynamicModels?.();
	const model = models?.find(candidate => candidate.id === id);

	// The provider fallback differs from the published ladder, so accepting
	// the catalog's tiers cannot pass by inheriting the existing default.
	expect(resolveModelPolicy({ ...model!, thinking: undefined }).thinking?.efforts).not.toEqual([
		Effort.Low,
		Effort.High,
	]);
	expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
	expect(resolveModelPolicy(model!).thinking?.efforts).toEqual([Effort.Low, Effort.High]);
});

test("rule-owned ladders and non-reasoning rows are left alone", async () => {
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					moonshotai: {
						models: {
							[REVIEWED_ID]: catalogRow(["minimal"]),
							"plain-chat-9b": catalogRow(["low", "high"]),
						},
					},
				},
			},
			[],
			[REVIEWED_ID, "plain-chat-9b"],
		),
	);
	const reviewed = models?.find(candidate => candidate.id === REVIEWED_ID);
	const plain = models?.find(candidate => candidate.id === "plain-chat-9b");

	// The catalog publishes a narrower ["minimal"]; the reviewed tiers survive.
	expect(reviewed?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	expect(resolveModelPolicy(reviewed!).thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	// Discovery says this one does not reason; a published ladder cannot flip that.
	expect(plain?.reasoning).toBe(false);
	expect(plain?.thinking).toBeUndefined();
});

test("no catalog request when every discovered model's tiers are already known", async () => {
	const calls: string[] = [];
	const models = await discover(stubFetch({}, calls, [REVIEWED_ID]));

	expect(models?.map(model => model.id)).toEqual([REVIEWED_ID]);
	expect(calls).toEqual([MOONSHOT_MODELS_URL]);
});

test("an unreachable catalog, or one that knows nothing about the id, leaves the guess in place", async () => {
	const calls: string[] = [];
	const unreachable = await discover(stubFetch({}, calls, [UNREVIEWED_ID]));
	expect(calls).toContain(SHARED_CATALOG_URL);
	expect(unreachable?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toBeUndefined();

	const unknown = await discover(
		stubFetch(
			{ [SHARED_CATALOG_URL]: { moonshotai: { models: { "other-model": catalogRow(["low"]) } } } },
			[],
			[UNREVIEWED_ID],
		),
	);
	expect(unknown?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
});

test("a duplicated id takes the ladder its own host published", async () => {
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					// Listed first, so a bare-id index would hand this ladder to Moonshot.
					acme: { models: { [UNREVIEWED_ID]: catalogRow(["minimal", "low"]) } },
					moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high", "max"]) } },
				},
			},
			[],
			[UNREVIEWED_ID],
		),
	);

	expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High, Effort.Max],
	});
});

test("an inferred host ladder outranks a foreign full-id ladder", async () => {
	const id = `acme/${UNREVIEWED_ID}`;
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					zeta: { models: { [id]: catalogRow(["minimal", "low"]) } },
					acme: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } },
				},
			},
			[],
			[id],
		),
	);

	expect(models?.find(model => model.id === id)?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
});

test("an inferred host without a dial vetoes a foreign full-id ladder", async () => {
	const id = `acme/${UNREVIEWED_ID}`;
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					zeta: { models: { [id]: catalogRow(["minimal", "low"]) } },
					acme: { models: { [UNREVIEWED_ID]: catalogRow() } },
				},
			},
			[],
			[id],
		),
	);

	expect(models?.find(model => model.id === id)?.thinking).toBeUndefined();
});

test("an id foreign hosts publish differently stays unknown; hosts that agree still answer", async () => {
	const agreedId = "quasar-7b-thinking";
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					acme: {
						models: {
							[UNREVIEWED_ID]: catalogRow(["minimal", "low"]),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
					zeta: {
						models: {
							[UNREVIEWED_ID]: catalogRow(["low", "high", "max"]),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
				},
			},
			[],
			[UNREVIEWED_ID, agreedId],
		),
	);

	// Neither host is Moonshot's and they disagree: offering either could name a
	// tier this endpoint rejects, so the ladder stays the neutral guess.
	expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
	expect(models?.find(candidate => candidate.id === agreedId)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
});

test("a host row without an effort ladder blocks a foreign bare-id ladder", async () => {
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					acme: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } },
					moonshotai: { models: { [UNREVIEWED_ID]: catalogRow() } },
				},
			},
			[],
			[UNREVIEWED_ID],
		),
	);
	expect(models?.find(model => model.id === UNREVIEWED_ID)?.thinking).toBeUndefined();
});

test("a bare id any host publishes without an effort dial stays unknown", async () => {
	// Moonshot hosts none of these ids, so only the bare-id index can answer
	// and no per-host veto is reachable. Row order differs per id: the dialless
	// row arrives after the ladder for one and before it for the other.
	const ladderFirstId = "nebula-8b-thinking";
	const diallessFirstId = "nebula-7b-thinking";
	const agreedId = "nebula-6b-thinking";
	const models = await discover(
		stubFetch(
			{
				[SHARED_CATALOG_URL]: {
					acme: {
						models: {
							[ladderFirstId]: catalogRow(["low", "high"]),
							[diallessFirstId]: catalogRow(),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
					zeta: {
						models: {
							[ladderFirstId]: catalogRow(),
							[diallessFirstId]: catalogRow(["low", "high"]),
							[agreedId]: catalogRow(["low", "high"]),
						},
					},
				},
			},
			[],
			[ladderFirstId, diallessFirstId, agreedId],
		),
	);

	// A host serving the id with no effort dial means some deployment of it
	// rejects one, so a foreign host's ladder may not speak for it.
	expect(models?.find(model => model.id === ladderFirstId)?.thinking).toBeUndefined();
	expect(models?.find(model => model.id === diallessFirstId)?.thinking).toBeUndefined();
	// Hosts that all publish a dial still answer for the bare id.
	expect(models?.find(model => model.id === agreedId)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
});

test("concurrent discovery refreshes share one catalog request", async () => {
	const calls: string[] = [];
	const fetchImpl = stubFetch(
		{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } } },
		calls,
		[UNREVIEWED_ID],
	);

	const refreshes = await Promise.all([discover(fetchImpl), discover(fetchImpl)]);

	expect(calls.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
	for (const models of refreshes) {
		expect(models?.find(candidate => candidate.id === UNREVIEWED_ID)?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
		});
	}
});

test("isolates published ladders by fetch implementation", async () => {
	const callsA: string[] = [];
	const callsB: string[] = [];
	const fetchA = stubFetch(
		{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low"]) } } } },
		callsA,
		[UNREVIEWED_ID],
	);
	const fetchB = stubFetch(
		{ [SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["high"]) } } } },
		callsB,
		[UNREVIEWED_ID],
	);
	const [modelsA, modelsB] = await Promise.all([discover(fetchA), discover(fetchB)]);
	expect(modelsA?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low],
	});
	expect(modelsB?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.High],
	});
	expect(callsA.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
	expect(callsB.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(1);
});

test("keeps the last good ladders when a catalog refresh fails", async () => {
	const calls: string[] = [];
	const routes: Record<string, unknown> = {
		[SHARED_CATALOG_URL]: { moonshotai: { models: { [UNREVIEWED_ID]: catalogRow(["low", "high"]) } } },
	};
	const fetchImpl = stubFetch(routes, calls, [UNREVIEWED_ID]);
	const first = await discover(fetchImpl);
	expect(first?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});

	routes[SHARED_CATALOG_URL] = undefined;
	const second = await discover(fetchImpl);
	expect(second?.find(model => model.id === UNREVIEWED_ID)?.thinking).toEqual({
		mode: "effort",
		efforts: [Effort.Low, Effort.High],
	});
	expect(calls.filter(url => url === SHARED_CATALOG_URL)).toHaveLength(2);
});
