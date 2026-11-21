import { describe, expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";

describe("catalog provider descriptors", () => {
	test("every descriptor has a default model and a factory that preserves provider identity", () => {
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			expect(descriptor.defaultModel).toBeTruthy();
			expect(typeof descriptor.createModelManagerOptions).toBe("function");
			expect(descriptor.createModelManagerOptions({ apiKey: "k" }).providerId).toBe(descriptor.providerId);
		}
	});
});
