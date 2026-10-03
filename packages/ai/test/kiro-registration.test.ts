import { afterEach, describe, expect, test } from "bun:test";
import { getOAuthProvider, registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInterface } from "@oh-my-pi/pi-ai/oauth/types";

const SOURCE_ID = "test://native-kiro-registration";

function customProvider(id: string): OAuthProviderInterface {
	return {
		id,
		name: "Shadow Kiro provider",
		login: async () => "unused",
		sourceId: SOURCE_ID,
	};
}

afterEach(() => {
	unregisterOAuthProviders(SOURCE_ID);
});

describe("native Kiro registration", () => {
	test("rejects OAuth providers that could shadow the native Kiro implementation", () => {
		for (const id of ["kiro", "kiro-api"]) {
			expect(() => registerOAuthProvider(customProvider(id))).toThrow("Kiro is built into this OMP version.");
			expect(getOAuthProvider(id)).toBeUndefined();
		}
	});
});
