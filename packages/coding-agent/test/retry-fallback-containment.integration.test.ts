import { expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

it("exercises worker containment against a loopback OpenAI-compatible provider", async () => {
	await initTheme();
	const temp = TempDir.createSync("retry-containment-");
	const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
	const requested: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = await request.json() as { model: string };
			requested.push(body.model);
			if (body.model !== "B") {
				return Response.json({ error: { message: "worker quota exhausted", type: "rate_limit_error" } }, {
					status: 429,
					headers: { "retry-after": "11180" },
				});
			}
			const chunk = { id: "loopback", object: "chat.completion.chunk", created: 0, model: "B",
				choices: [{ index: 0, delta: { role: "assistant", content: "default success" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}

data: [DONE]

`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		for (const policy of ["fail", "unset"] as const) {
			requested.length = 0;
			const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
			registry.registerProvider("containment-loopback", {
				api: "openai-completions",
				apiKey: "loopback-key",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				models: ["worker-primary", "A", "B"].map(id => ({
					id, name: id, reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000, maxTokens: 8192,
				})),
			});
			const primary = registry.find("containment-loopback", "worker-primary");
			if (!primary) throw new Error("Missing exercise primary");
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxDelayMs": 100,
				"retry.fallbackChains": { task: ["containment-loopback/A"], default: ["containment-loopback/B"] },
				...(policy === "fail" ? { "retry.fallbackChainExhausted": { task: "fail" } } : {}),
			});
			settings.setModelRole("task", "containment-loopback/worker-primary");
			settings.setModelRole("default", "containment-loopback/worker-primary");
			const manager = SessionManager.inMemory();
			manager.appendModelChange("containment-loopback/worker-primary", "task");
			const agent = new Agent({
				getApiKey: () => "loopback-key",
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			const session = new AgentSession({ agent, settings, modelRegistry: registry, sessionManager: manager });
			try {
				await session.prompt("Exhaust the worker chain");
				await session.waitForIdle();
				const last = session.messages.at(-1);
				if (last?.role !== "assistant") throw new Error("Missing exercise result");
				expect(requested).toEqual(policy === "fail" ? ["worker-primary", "A"] : ["worker-primary", "A", "B"]);
				expect(last.stopReason).toBe(policy === "fail" ? "error" : "stop");
				if (policy === "fail") expect(last.errorMessage).toContain("worker quota exhausted");
				console.log(`containment exercise policy=${policy} requests=${requested.join(" -> ")} result=${last.stopReason}${policy === "fail" ? " error=worker quota exhausted" : ""}`);
			} finally {
				await session.dispose();
			}
			registry.unregisterProvider("containment-loopback");
		}
	} finally {
		server.stop(true);
		auth.close();
		temp.removeSync();
	}
});
