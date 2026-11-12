import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeKiroModelCatalog } from "@oh-my-pi/pi-catalog/discovery/kiro";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { resolveKiroModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/special";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	decodeKiroCredential,
	encodeKiroCredential,
	encodeKiroOAuthRow,
} from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import { logger } from "@oh-my-pi/pi-utils";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/kiro-default";
const API_ENDPOINT = "https://runtime.us-east-1.kiro.dev/";
const EU_API_ENDPOINT = "https://runtime.eu-central-1.kiro.dev/";

const apiKey = (token: string, apiEndpoint = API_ENDPOINT) =>
	encodeKiroCredential({ kind: "api_key", token: `ksk_${token}`, apiEndpoint });
const oauth = (loginId: string, profileArn?: string, apiEndpoint = API_ENDPOINT) =>
	encodeKiroCredential({ kind: "oauth", token: `access-${loginId}`, apiEndpoint, loginId, profileArn });
const model = (modelId: string, extra: object = {}) => ({
	modelId,
	supportedInputTypes: ["TEXT"],
	tokenLimits: { maxInputTokens: 100_000, maxOutputTokens: 8_192 },
	...extra,
});
const catalog = (...models: object[]) => ({ models });
const jsonFetch =
	(payload: unknown, status = 200): FetchImpl =>
	async () =>
		Response.json(payload, { status });
const discover = (payload: unknown) =>
	kiroModelManagerOptions({ apiKey: apiKey("test"), fetch: jsonFetch(payload) }).fetchDynamicModels?.();

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const object = (properties: object, extra: object = {}) => ({ type: "object", properties, ...extra });
const strings = (values: string[], extra: object = {}) => ({ type: "string", enum: values, ...extra });
const anthropicSchema = (thinkingTypes: string[]) =>
	object(
		{
			thinking: object(
				{ type: strings(thinkingTypes), display: strings(["summarized", "omitted"]) },
				{ required: ["type"] },
			),
			output_config: object({ effort: strings(LEVELS, { default: "medium" }) }),
			max_tokens: { type: "integer", minimum: 1024, maximum: 128_000 },
		},
		{ additionalProperties: false },
	);
const gptSchema = object(
	{ reasoning: object({ effort: strings(["none", ...LEVELS], { default: "high" }) }) },
	{ additionalProperties: false },
);

describe("Kiro provider discovery", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("maps live models in order, skips invalid rows, rejects bad envelopes, and returns null when none remain", async () => {
		for (const level of ["warn", "debug", "error"] as const) vi.spyOn(logger, level).mockImplementation(() => {});
		const models = await discover(
			catalog(
				model("provider/model-z", { supportedInputTypes: ["TEXT", "IMAGE"] }),
				model("bad-limits", { tokenLimits: { maxInputTokens: 0, maxOutputTokens: 8_192 } }),
				model("provider/model-a", { supportedInputTypes: ["VIDEO"] }),
			),
		);
		expect(models?.map(m => [m.id, m.input, m.contextWindow, m.maxTokens])).toEqual([
			["provider/model-z", ["text", "image"], 100_000, 8_192],
			["provider/model-a", ["text"], 100_000, 8_192],
		]);
		for (const envelope of [null, { models: "none" }, { models: [], nextToken: 7 }]) {
			expect(() => sanitizeKiroModelCatalog(envelope)).toThrow("Unsafe ListAvailableModels response");
		}
		expect(await discover(catalog(model("bad", { tokenLimits: { maxInputTokens: -1 } })))).toBeNull();
	});

	test("maps thinking schemas and lists an unrecognised schema without thinking", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const schemas: Array<[string, object]> = [
			["claude", anthropicSchema(["adaptive"])],
			["gpt", gptSchema],
			["claude-garbage", anthropicSchema(["surprise"])],
		];
		const payload = catalog(
			...schemas.map(([id, schema]) => model(id, { additionalModelRequestFieldsSchema: schema })),
		);
		const models = await discover(payload);
		expect(models?.map(m => [m.id, m.reasoning, m.thinking?.mode, m.thinking?.defaultLevel])).toEqual([
			["claude", true, "anthropic-adaptive", Effort.Medium],
			["gpt", true, "effort", Effort.High],
			["claude-garbage", false, undefined, undefined],
		]);
	});

	test("sends the OAuth profile ARN with the Kiro CLI service identity and follows nextToken", async () => {
		const bodies: unknown[] = [];
		let headers: Record<string, string> = {};
		const fetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			headers = Object.fromEntries(new Headers(init?.headers));
			return Response.json(
				body.nextToken ? catalog(model("page-two")) : { ...catalog(model("page-one")), nextToken: "p2" },
			);
		};
		const models = await kiroModelManagerOptions({ apiKey: oauth("a", PROFILE_ARN), fetch }).fetchDynamicModels?.();
		expect(models?.map(m => m.id)).toEqual(["page-one", "page-two"]);
		expect(bodies).toEqual([
			{ origin: "KIRO_CLI", profileArn: PROFILE_ARN },
			{ origin: "KIRO_CLI", profileArn: PROFILE_ARN, nextToken: "p2" },
		]);
		expect(headers).toMatchObject({
			"content-type": "application/x-amz-json-1.0",
			"x-amz-target": "KiroControlPlaneBearerService.ListAvailableModels",
			"user-agent": expect.stringMatching(/^aws-sdk-rust\/.* api\/kirocontrolplanebearer\/.* app\/AmazonQ-For-CLI$/),
			"x-amzn-codewhisperer-optout": "true",
			authorization: "Bearer access-a",
		});
	});

	test("routes an env API key to KIRO_API_REGION without probing other regions", async () => {
		const requested: string[] = [];
		const fetch: FetchImpl = async input => {
			requested.push(String(input));
			return Response.json(catalog(model("eu-model")));
		};
		const previous = Bun.env.KIRO_API_REGION;
		Bun.env.KIRO_API_REGION = "eu-central-1";
		try {
			const models = await kiroModelManagerOptions({ apiKey: "ksk_env-key", fetch }).fetchDynamicModels?.();
			expect(models?.map(m => [m.id, m.baseUrl])).toEqual([["eu-model", EU_API_ENDPOINT]]);
			expect(requested).toEqual(["https://management.eu-central-1.kiro.dev/"]);
		} finally {
			if (previous === undefined) delete Bun.env.KIRO_API_REGION;
			else Bun.env.KIRO_API_REGION = previous;
		}
	});

	test("scopes the model cache per login route and API key without raw credential identity", () => {
		const login = oauth("login-a", PROFILE_ARN);
		const distinct: Array<[string, string]> = [
			[oauth("login-a", `${PROFILE_ARN}-2`), login], // refresh changed profile
			[oauth("login-a", PROFILE_ARN, EU_API_ENDPOINT), login], // refresh changed endpoint
			[oauth("builder", undefined, EU_API_ENDPOINT), oauth("builder")], // Builder ID moved endpoint
			[oauth("login-b", PROFILE_ARN), login], // shared profile, different login
			[apiKey("key-a", EU_API_ENDPOINT), apiKey("key-a")],
			[apiKey("key-b"), apiKey("key-a")],
		];
		for (const pair of distinct) expect(new Set(pair.map(resolveKiroModelCacheProviderId)).size).toBe(2);
		const loginScope = resolveKiroModelCacheProviderId(login);
		expect(loginScope).toMatch(/^kiro:models-v2:/);
		for (const secret of [PROFILE_ARN, "login-a", "access-login-a"]) expect(loginScope).not.toContain(secret);
		expect(resolveKiroModelCacheProviderId(apiKey("key-a"))).not.toContain("ksk_key-a");
	});

	test("decodes only valid Kiro credentials and round-trips social logins", () => {
		const bearer = { kind: "oauth", token: "b", apiEndpoint: API_ENDPOINT } as const;
		const social = { access: "b", apiEndpoint: API_ENDPOINT, kiroLoginId: "s", kiroLoginProvider: "Github" as const };
		expect(decodeKiroCredential("ksk_raw", {})).toEqual({ kind: "api_key", token: "ksk_raw" });
		const decoded = decodeKiroCredential(encodeKiroOAuthRow({ ...social, orgId: PROFILE_ARN }), {});
		expect(decoded).toEqual({ ...bearer, loginId: "s", profileArn: PROFILE_ARN, loginProvider: "Github" });
		expect(() => encodeKiroOAuthRow(social)).toThrow("profile ARN");
		const rejected: Array<[unknown, string]> = [
			["raw-bearer", "ksk_"],
			[{ kind: "api_key", token: "not-a-key", apiEndpoint: API_ENDPOINT }, "ksk_"],
			[bearer, "login id"],
			[{ ...bearer, loginId: "s", loginProvider: "Google" }, "profile ARN"],
			[{ ...bearer, loginId: "s", profileArn: PROFILE_ARN, loginProvider: "google" }, "social login provider"],
		];
		for (const [input, message] of rejected) {
			const encoded = typeof input === "string" ? input : JSON.stringify(input);
			expect(() => decodeKiroCredential(encoded, {})).toThrow(message);
		}
	});

	test("live refresh prunes static fallback; discovery failure keeps cached rows as stale", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-kiro-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		const staticModels = (await discover(catalog(model("fallback"))))!;
		const resolve = (payload: unknown, status = 200) => {
			const options = kiroModelManagerOptions({ apiKey: apiKey("cached"), fetch: jsonFetch(payload, status) });
			return resolveProviderModels({ ...options, staticModels, cacheDbPath }, "online");
		};
		try {
			const live = await resolve(catalog(model("kiro-live")));
			expect([live.stale, live.models.map(m => m.id)]).toEqual([false, ["kiro-live"]]);
			const failed = await resolve({}, 503);
			expect([failed.stale, failed.models.map(m => m.id)]).toEqual([true, ["kiro-live"]]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
