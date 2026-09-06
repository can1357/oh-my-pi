import { describe, expect, it } from "bun:test";
import type { OAuthAuthInfo, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { opencodeGoProvider } from "@oh-my-pi/pi-ai/registry/opencode-go";
import { opencodeZenProvider } from "@oh-my-pi/pi-ai/registry/opencode-zen";

/**
 * Regression for #8738: `opencode-go` and `opencode-zen` share the same
 * `loginOpenCode` helper. It used to hardcode "OpenCode Zen" in the paste
 * prompt, so selecting OpenCode Go asked the user for an OpenCode Zen key.
 * The prompt (and browser instructions) must name the provider the user
 * actually selected.
 */
function captureLogin(): { callbacks: OAuthLoginCallbacks; seen: { auth?: OAuthAuthInfo; message?: string } } {
	const seen: { auth?: OAuthAuthInfo; message?: string } = {};
	const callbacks: OAuthLoginCallbacks = {
		onAuth: info => {
			seen.auth = info;
		},
		onPrompt: async prompt => {
			seen.message = prompt.message;
			return "sk-test-key";
		},
	};
	return { callbacks, seen };
}

describe("OpenCode login prompt (#8738)", () => {
	it("asks for an OpenCode Go key when connecting OpenCode Go", async () => {
		const { callbacks, seen } = captureLogin();
		const key = await opencodeGoProvider.login(callbacks);

		expect(key).toBe("sk-test-key");
		expect(seen.message).toBe("Paste your OpenCode Go API key");
		expect(seen.message).not.toContain("Zen");
		// Go keys are minted from the same Zen console, so the URL is shared,
		// but the instructions must still reference the selected provider.
		expect(seen.auth?.url).toBe("https://opencode.ai/auth");
		expect(seen.auth?.instructions).toContain("OpenCode Go API key");
	});

	it("asks for an OpenCode Zen key when connecting OpenCode Zen", async () => {
		const { callbacks, seen } = captureLogin();
		const key = await opencodeZenProvider.login(callbacks);

		expect(key).toBe("sk-test-key");
		expect(seen.message).toBe("Paste your OpenCode Zen API key");
		expect(seen.auth?.url).toBe("https://opencode.ai/auth");
	});

	it("rejects an empty pasted key", async () => {
		const callbacks: OAuthLoginCallbacks = {
			onAuth: () => {},
			onPrompt: async () => "   ",
		};
		await expect(opencodeGoProvider.login(callbacks)).rejects.toThrow();
	});
});
