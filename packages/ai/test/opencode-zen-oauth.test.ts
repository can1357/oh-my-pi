import { describe, expect, it } from "bun:test";
import { openCodeZenTransport } from "@oh-my-pi/pi-ai/registry/opencode-zen";
import {
	OPENCODE_CONSOLE_INFERENCE_BASE_URL,
	OPENCODE_CONSOLE_ORG_HEADER,
	encodeOpenCodeZenCredential,
	parseOpenCodeZenCredential,
} from "@oh-my-pi/pi-ai/registry/oauth/opencode-zen";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { Model, StreamOptions } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const zenModel = getBundledModel("opencode-zen", "muse-spark-1.3-contributor-free") as Model<"openai-responses">;

const zenEnvelope = encodeOpenCodeZenCredential({
	token: "st_test-console-token",
	orgId: "wrk_test_workspace",
	orgName: "Default",
	baseUrl: OPENCODE_CONSOLE_INFERENCE_BASE_URL,
});

describe("OpenCode Zen Console credential codec", () => {
	it("ignores a plain Zen API key so the key lane is untouched", () => {
		expect(parseOpenCodeZenCredential("sk-live-zen-key")).toBeUndefined();
		expect(parseOpenCodeZenCredential(undefined)).toBeUndefined();
	});

	it("ignores JSON that is not the envelope", () => {
		expect(parseOpenCodeZenCredential('{"foo":"bar"}')).toBeUndefined();
		expect(parseOpenCodeZenCredential("{not json")).toBeUndefined();
	});

	it("round-trips the envelope", () => {
		expect(parseOpenCodeZenCredential(zenEnvelope)).toEqual({
			token: "st_test-console-token",
			orgId: "wrk_test_workspace",
			orgName: "Default",
			baseUrl: OPENCODE_CONSOLE_INFERENCE_BASE_URL,
		});
	});
});

describe("OpenCode Zen transport", () => {
	it("reroutes a Console credential to the inference lane with the workspace header", () => {
		const prepared = openCodeZenTransport.prepareRequest!(zenModel, {
			apiKey: zenEnvelope,
		} as StreamOptions)!;

		expect(prepared.model.baseUrl).toBe(OPENCODE_CONSOLE_INFERENCE_BASE_URL);
		// The bearer handed upstream is the raw session token, not the envelope.
		expect(prepared.options.apiKey).toBe("st_test-console-token");
		expect(prepared.options.headers?.[OPENCODE_CONSOLE_ORG_HEADER]).toBe("wrk_test_workspace");
	});

	it("leaves an API-key request on the catalog base URL", () => {
		const prepared = openCodeZenTransport.prepareRequest!(zenModel, {
			apiKey: "sk-live-zen-key",
		} as StreamOptions)!;

		expect(prepared.model.baseUrl).toBe(zenModel.baseUrl);
		expect(prepared.options.apiKey).toBe("sk-live-zen-key");
		expect(prepared.options.headers?.[OPENCODE_CONSOLE_ORG_HEADER]).toBeUndefined();
	});

	it("keeps caller headers authoritative over the injected workspace header", () => {
		const prepared = openCodeZenTransport.prepareRequest!(zenModel, {
			apiKey: zenEnvelope,
			headers: { [OPENCODE_CONSOLE_ORG_HEADER]: "wrk_caller" },
		} as StreamOptions)!;

		expect(prepared.options.headers?.[OPENCODE_CONSOLE_ORG_HEADER]).toBe("wrk_caller");
	});

	it("unwraps the bearer for model discovery without moving the base URL", () => {
		const prepared = openCodeZenTransport.prepareModelDiscovery!({
			apiKey: zenEnvelope,
			baseUrl: zenModel.baseUrl,
		});

		expect(prepared.apiKey).toBe("st_test-console-token");
		expect(prepared.baseUrl).toBe(zenModel.baseUrl);
		expect(prepared.authenticated).toBe(true);
	});
});

describe("OpenCode Zen Console sign-in provider", () => {
	it("registers a device-code login that stores under opencode-zen", () => {
		const definition = getProviderDefinition("opencode-zen-device");
		expect(definition).toBeDefined();
		expect(definition!.login).toBeDefined();
		expect(definition!.storeCredentialsAs).toBe("opencode-zen");
	});

	it("keeps the existing API-key entry for opencode-zen", () => {
		expect(getProviderDefinition("opencode-zen")!.login).toBeDefined();
	});
});
