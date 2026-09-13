import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

afterEach(() => {
	mock.restore();
});

function makeSession(identity: { sessionId?: string | null; agentId?: string | null } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => identity.sessionId ?? null,
		getAgentId: () => identity.agentId ?? null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

async function runEcho(session: ToolSession, env?: Record<string, string>): Promise<string> {
	const tool = new BashTool(session);
	const result = await tool.execute("call-identity", {
		command: 'echo "[$OMP_SESSION_ID|$OMP_AGENT_ID]"',
		...(env ? { env } : {}),
	});
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("bash child session identity", () => {
	it("exports OMP_SESSION_ID and OMP_AGENT_ID to the child", async () => {
		const text = await runEcho(makeSession({ sessionId: "sess-42", agentId: "Harness" }));
		expect(text).toContain("[sess-42|Harness]");
	});

	it("falls back to the session id when the session carries no agent id", async () => {
		const text = await runEcho(makeSession({ sessionId: "sess-42" }));
		expect(text).toContain("[sess-42|sess-42]");
	});

	it("lets caller-supplied env override the injected identity", async () => {
		const text = await runEcho(makeSession({ sessionId: "sess-42", agentId: "Harness" }), {
			OMP_AGENT_ID: "Override",
		});
		expect(text).toContain("[sess-42|Override]");
	});

	it("injects nothing when the session has no identity", async () => {
		const text = await runEcho(makeSession());
		expect(text).toContain("[|]");
	});
});
