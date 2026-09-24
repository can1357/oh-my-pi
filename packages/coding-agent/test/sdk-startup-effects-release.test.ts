import { describe, expect, it } from "bun:test";
import { isProviderEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects, effectsSettings, unbindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// A top-level SDK session binds process-wide state to its settings: setting effects (theme,
// credential redaction, request limits) and the discovery provider toggles. If startup fails,
// neither binding may outlive the call: effects only bind when nothing is bound, and the
// toggles would keep reading and persisting to a discarded Settings instance.
describe("createAgentSession startup failure", () => {
	it("releases the effect binding and restores the previous provider-toggle settings", async () => {
		const previousEffects = effectsSettings();
		unbindEffects();
		const hostSettings = Settings.isolated({ disabledProviders: ["claude"] });
		const restoreToggles = initializeWithSettings(hostSettings);
		const authStorage = createInMemoryAuthStorage();
		const registryAuthStorage = createInMemoryAuthStorage();
		try {
			await expect(
				createAgentSession({
					settings: Settings.isolated(),
					authStorage,
					modelRegistry: new ModelRegistry(registryAuthStorage),
				}),
			).rejects.toThrow("must be the same instance");

			expect(effectsSettings()).toBeUndefined();
			expect(isProviderEnabled("claude")).toBe(false);
		} finally {
			authStorage.close();
			registryAuthStorage.close();
			restoreToggles();
			if (previousEffects) bindEffects(previousEffects);
		}
	});
});
