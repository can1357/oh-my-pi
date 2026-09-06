import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const SHARED_CWD = "/tmp/input-controller-internal-url-caller";

function registerSession(id: string, kind: "main" | "sub", backend: "local" | "off"): AgentSession {
	const session = {
		sessionManager: {
			getCwd: () => SHARED_CWD,
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getArtifactsDir: () => null,
		},
		settings: Settings.isolated({ "memory.backend": backend }),
	} as unknown as AgentSession;
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind,
		...(kind === "sub" ? { parentId: "controller-main" } : {}),
		session,
		sessionFile: null,
	});
	return session;
}

describe("InputController autocomplete caller binding", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("completes internal URLs for the session the prompt is submitted to", async () => {
		// Both sessions live in one cwd, so cwd alone cannot name the caller.
		const main = registerSession("controller-main", "main", "local");
		const child = registerSession("controller-child", "sub", "off");

		let viewSession = main;
		const ctx = {
			get viewSession() {
				return viewSession;
			},
			session: main,
			sessionManager: main.sessionManager,
			settings: main.settings,
			keybindings: KeybindingsManager.inMemory(),
		} as unknown as InteractiveModeContext;
		const provider = new InputController(ctx).createAutocompleteProvider([], SHARED_CWD);

		const line = "read memory://";
		const forMain = await provider.getSuggestions([line], 0, line.length);
		expect(forMain?.items.map(item => item.value) ?? []).toContain("memory://root");

		// Focusing the child re-points editor submission at it, and it disabled
		// memory: the popup must follow that caller, not the peer in its cwd.
		viewSession = child;
		const forChild = await provider.getSuggestions([line], 0, line.length);
		expect(forChild?.items.map(item => item.value) ?? []).not.toContain("memory://root");
	});
});
