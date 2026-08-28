import { expect, test } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { type FetchImpl, streamSimple } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

test("keeps Gemini 3.6 advisor context and accepts a silent review", async () => {
	const temp = TempDir.createSync("@issue-8223-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	auth.setRuntimeApiKey("google", "test-key");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("google", "gemini-3.6-flash");
	if (!model) throw new Error("missing bundled model");
	const bodies: unknown[] = [];
	const fetchMock: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const chunk = {
			candidates: [
				{
					content: { role: "model", parts: [{ thought: true, text: "Analyzing only" }] },
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 10,
				candidatesTokenCount: 5,
				thoughtsTokenCount: 5,
				totalTokenCount: 15,
			},
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const advisorStreamFn: StreamFn = (requestModel, context, options) =>
		streamSimple(requestModel, context, { ...options, fetch: fetchMock });
	const agent = new Agent({ initialState: { model, systemPrompt: ["Primary"], tools: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(temp.path(), temp.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		advisorTools: [],
		advisorStreamFn,
	});
	try {
		session.settings.setModelRole("advisor", "google/gemini-3.6-flash");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("advisor did not start");
		await advisor.prompt("### Session update [in progress — more steps follow]\nImplement an order book.");
		expect(advisor.state.error).toBeUndefined();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			systemInstruction: {
				parts: [{ text: expect.any(String) }],
			},
			tools: [
				{
					functionDeclarations: [{ name: "advise" }],
				},
			],
		});
	} finally {
		await session.dispose();
		auth.close();
		await temp.remove();
	}
});
