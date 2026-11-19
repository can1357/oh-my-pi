import { describe, expect, it } from "bun:test";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";

describe("OAuthManualInputManager", () => {
	it("resolves waitForInput with submitted value", async () => {
		const manager = new OAuthManualInputManager();
		const promise = manager.waitForInput("openai-codex");

		const submitted = manager.submit("callback-url");

		expect(submitted).toBe(true);
		expect(await promise).toBe("callback-url");
		expect(manager.hasPending()).toBe(false);
	});

	it("does not replace pending input when using tryWaitForInput", async () => {
		const manager = new OAuthManualInputManager();
		const first = manager.waitForInput("openai-codex");

		expect(manager.tryWaitForInput("mcp")).toBeUndefined();
		expect(manager.pendingProviderId).toBe("openai-codex");

		expect(manager.submit("callback-url")).toBe(true);
		expect(await first).toBe("callback-url");
	});

	it("returns false when no pending input", () => {
		const manager = new OAuthManualInputManager();

		expect(manager.submit("callback-url")).toBe(false);
	});

	it("clears pending input and rejects promise", async () => {
		const manager = new OAuthManualInputManager();
		const promise = manager.waitForInput("anthropic");

		manager.clear();

		await expect(promise).rejects.toThrow("Manual OAuth input cleared");
		expect(manager.submit("late-url")).toBe(false);
	});
});
