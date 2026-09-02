import { describe, expect, it } from "bun:test";
import { OPENZOO_LOCAL_TOKEN } from "@oh-my-pi/pi-ai/registry/openzoo";
import { isDiscoveryBearerApiKey, kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";

describe("isDiscoveryBearerApiKey", () => {
	it("rejects every local-provider placeholder, including the openzoo registry's own sentinel", () => {
		for (const placeholder of ["llama-cpp-local", "lm-studio-local", "vllm-local", OPENZOO_LOCAL_TOKEN]) {
			expect(isDiscoveryBearerApiKey(placeholder)).toBe(false);
		}
	});

	it("accepts a real bearer and rejects empty/no-auth values", () => {
		expect(isDiscoveryBearerApiKey("oz_tunnel-bearer")).toBe(true);
		expect(isDiscoveryBearerApiKey("")).toBe(false);
		expect(isDiscoveryBearerApiKey(undefined)).toBe(false);
		expect(isDiscoveryBearerApiKey(kNoAuth)).toBe(false);
	});
});
