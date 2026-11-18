import { afterEach, describe, expect, test, vi } from "bun:test";
import { fetchKiroModels, resolveKiroApiKeyRegion } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { encodeKiroCredential, type KiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro";
import { logger } from "@oh-my-pi/pi-utils";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-default";
const OAUTH: KiroCredential = { kind: "oauth", token: "access", region: "us-east-1", loginId: "login-a" };

const model = (modelId: string, extra: object = {}) => ({
	modelId,
	supportedInputTypes: ["TEXT"],
	tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
	...extra,
});
const catalog = (...models: object[]) => ({ models });
const discover = (payload: unknown, credential = OAUTH) =>
	fetchKiroModels({ credential, fetch: async () => Response.json(payload) });

const object = (properties: object) => ({ type: "object", properties });
const strings = (values: string[], extra: object = {}) => ({ type: "string", enum: values, ...extra });

describe("Kiro model discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("derives thinking from each model's request schema and lists unknown schemas without thinking", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const anthropic = object({
			thinking: object({ type: strings(["adaptive", "disabled"]), display: strings(["summarized", "omitted"]) }),
			output_config: object({ effort: strings(["max", "high", "low", "medium"], { default: "high" }) }),
			max_tokens: { type: "integer", minimum: 1024, maximum: 128_000 },
		});
		const gpt = object({ reasoning: object({ effort: strings(["high", "none", "low"], { default: "none" }) }) });
		const models = await discover(
			catalog(
				model("claude", { additionalModelRequestFieldsSchema: anthropic, rateMultiplier: 1.5, rateUnit: "Credit" }),
				model("gpt", { additionalModelRequestFieldsSchema: gpt, supportedInputTypes: ["TEXT", "IMAGE"] }),
				model("odd", { additionalModelRequestFieldsSchema: object({ surprise: strings(["x"]) }) }),
				model("no-limits", { tokenLimits: { maxInputTokens: 0 } }),
				{ modelName: "no id" },
			),
		);
		expect(models).toEqual([
			{
				id: "claude",
				name: "claude",
				api: "kiro-api",
				provider: "kiro",
				baseUrl: "https://runtime.us-east-1.kiro.dev/",
				reasoning: true,
				thinking: {
					mode: "anthropic-adaptive",
					efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
					defaultLevel: Effort.High,
					effortMap: { [Effort.Minimal]: Effort.Low },
					supportsDisplay: true,
				},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				premiumMultiplier: 1.5,
				contextWindow: 100_000,
				maxTokens: 128_000,
			},
			expect.objectContaining({
				id: "gpt",
				reasoning: true,
				thinking: {
					mode: "effort",
					efforts: [Effort.Minimal, Effort.Low, Effort.High],
					defaultLevel: Effort.Minimal,
					effortMap: { [Effort.Minimal]: "none" },
				},
				input: ["text", "image"],
				maxTokens: 8_192,
			}),
			expect.objectContaining({ id: "odd", reasoning: false, maxTokens: 8_192 }),
		]);
		expect(models?.[2]).not.toHaveProperty("thinking");
	});

	test("Identity Center credentials discover and stream against Amazon Q, not the Kiro runtime", async () => {
		const urls: string[] = [];
		const credential: KiroCredential = {
			kind: "oauth",
			token: "access",
			region: "eu-central-1",
			loginId: "login-idc",
			profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/p",
			service: "q",
		};
		const models = await fetchKiroModels({
			credential,
			fetch: async input => {
				urls.push(String(input));
				return Response.json(catalog(model("claude")));
			},
		});
		expect(urls).toEqual(["https://q.eu-central-1.amazonaws.com/"]);
		expect(models?.[0]?.baseUrl).toBe("https://q.eu-central-1.amazonaws.com/");
	});

	test("follows nextToken with the login's profile ARN and returns null when discovery fails", async () => {
		const bodies: unknown[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			// The second page repeats its token; the loop guard stops there.
			return Response.json({ ...catalog(model(body.nextToken ? "page-two" : "page-one")), nextToken: "p2" });
		};
		const credential: KiroCredential = { ...OAUTH, profileArn: PROFILE_ARN };
		const models = await fetchKiroModels({ credential, fetch });
		expect(models?.map(m => m.id)).toEqual(["page-one", "page-two"]);
		expect(bodies).toEqual([
			{ origin: "KIRO_CLI", profileArn: PROFILE_ARN },
			{ origin: "KIRO_CLI", profileArn: PROFILE_ARN, nextToken: "p2" },
		]);

		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const failing = await fetchKiroModels({ credential, fetch: async () => new Response("{}", { status: 503 }) });
		expect(failing).toBeNull();
	});

	test("an unpinned API key resolves to the single bootstrap region that accepts it", async () => {
		const accepting =
			(...regions: string[]): FetchImpl =>
			async input =>
				regions.some(region => String(input).includes(`.${region}.`))
					? Response.json(catalog(model(`model-${new URL(String(input)).hostname}`)))
					: new Response("{}", { status: 403 });
		const token = "ksk_unpinned";
		expect(await resolveKiroApiKeyRegion({ token, fetch: accepting("eu-central-1") })).toBe("eu-central-1");
		expect(await resolveKiroApiKeyRegion({ token, fetch: accepting() })).toBeNull();
		expect(await resolveKiroApiKeyRegion({ token, fetch: accepting("us-east-1", "eu-central-1") })).toBeNull();

		const models = await fetchKiroModels({
			credential: { kind: "api_key", token },
			fetch: accepting("eu-central-1"),
		});
		expect(models?.map(m => [m.id, m.baseUrl])).toEqual([
			["model-management.eu-central-1.kiro.dev", "https://runtime.eu-central-1.kiro.dev/"],
		]);
	});

	test("scopes the model cache per login, profile, region, and API key without leaking secrets", () => {
		const scope = (credential: KiroCredential) =>
			resolveModelCacheProviderId("kiro", { apiKey: encodeKiroCredential(credential) });
		const login: KiroCredential = { ...OAUTH, profileArn: PROFILE_ARN };
		const key: KiroCredential = { kind: "api_key", token: "ksk_key-a", region: "us-east-1" };
		const distinct: Array<[KiroCredential, KiroCredential]> = [
			[{ ...login, loginId: "login-b" }, login],
			[{ ...login, profileArn: `${PROFILE_ARN}-2` }, login],
			[{ ...login, region: "eu-central-1" }, login],
			[{ ...key, token: "ksk_key-b" }, key],
			[{ ...key, region: "eu-central-1" }, key],
		];
		for (const pair of distinct) expect(new Set(pair.map(scope)).size).toBe(2);
		expect(scope(login)).toMatch(/^kiro:models-v2:/);
		for (const secret of [PROFILE_ARN, "login-a", "access"]) expect(scope(login)).not.toContain(secret);
		expect(scope(key)).not.toContain("ksk_key-a");
		const invalid = resolveModelCacheProviderId("kiro", { apiKey: "not-a-credential" });
		expect([scope(login), scope(key)]).not.toContain(invalid);
		expect(invalid).not.toBe("kiro");
	});
});
