import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";

const SHARED_CWD = "/tmp/input-controller-internal-url-caller";

function registerSession(
	id: string,
	kind: "main" | "sub",
	backend: "local" | "off",
	artifactsDir?: string,
	producerScoped = false,
): AgentSession {
	const session = {
		sessionManager: {
			getCwd: () => SHARED_CWD,
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getArtifactsDir: () => artifactsDir ?? null,
		},
		localProtocolOptions: {
			getArtifactsDir: () => artifactsDir ?? null,
			getSessionId: () => id,
			...(producerScoped ? { artifactResolutionScope: "producer" as const } : {}),
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

	it("keeps producer scope when autocomplete follows a focused child", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "input-artifact-scope-"));
		try {
			const manager = new ArtifactManager(root);
			const parentId = await manager.save("parent", "read", "controller-main");
			const childId = await manager.save("child", "read", "controller-child");
			const main = registerSession("controller-main", "main", "off", root);
			const child = registerSession("controller-child", "sub", "off", root, true);
			const ctx = {
				viewSession: child,
				session: main,
				sessionManager: main.sessionManager,
				settings: main.settings,
				keybindings: KeybindingsManager.inMemory(),
			} as unknown as InteractiveModeContext;

			const provider = new InputController(ctx).createAutocompleteProvider([], SHARED_CWD);
			const line = "read artifact://";
			const result = await provider.getSuggestions([line], 0, line.length);
			expect(result?.items.map(item => item.value)).toEqual([`artifact://${childId}`]);
			expect(result?.items.map(item => item.value)).not.toContain(`artifact://${parentId}`);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
