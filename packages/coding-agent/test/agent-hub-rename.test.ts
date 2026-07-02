/**
 * Agent Hub rename contract: lowercase r enters inline rename mode for the
 * selected registry agent; empty names stay in rename mode instead of silently
 * clearing the existing label.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { IrcBus } from "@pk-nerdsaver-ai/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";

function createHub(registry: AgentRegistry): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry,
		irc: new IrcBus(registry),
		focusAgent: async () => {},
		cwd: "repo",
		kanbanSync: null,
	});
}

describe("Agent hub rename", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renames the selected registry agent from inline input", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Old worker",
			kind: "sub",
			session: null,
			status: "parked",
			cwd: "repo",
		});
		const hub = createHub(registry);
		try {
			// Rows: folder (0) → current session (1) → subagent Worker (2).
			hub.handleInput("j");
			hub.handleInput("j");
			hub.handleInput("r");
			for (const _char of "Old worker") hub.handleInput("\x7f");
			for (const char of "Renamed worker") hub.handleInput(char);
			hub.handleInput("\r");

			expect(registry.get("Worker")?.displayName).toBe("Renamed worker");
			expect(Bun.stripANSI(hub.render(120).join("\n"))).toContain("Renamed worker");
		} finally {
			hub.dispose();
		}
	});

	it("keeps rename mode active when the submitted name is empty", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "Worker",
			displayName: "Old",
			kind: "sub",
			session: null,
			status: "parked",
			cwd: "repo",
		});
		const hub = createHub(registry);
		try {
			hub.handleInput("j");
			hub.handleInput("j");
			hub.handleInput("r");
			for (const _char of "Old") hub.handleInput("\x7f");
			hub.handleInput("\r");

			const rendered = Bun.stripANSI(hub.render(120).join("\n"));
			expect(registry.get("Worker")?.displayName).toBe("Old");
			expect(rendered).toContain("Rename cannot be empty.");
			expect(rendered).toContain("Rename:");
		} finally {
			hub.dispose();
		}
	});
});
