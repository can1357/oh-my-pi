import { expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import { createTaskModelRoute } from "../src/task/role-routing";
import { createTaskModelFixture } from "./helpers/model-fixtures";

it("automatically compacts an overflow on the admitted model and effort without calling the remote endpoint", async () => {
	let overflowNext = false;
	let compacting = false;
	let overflows = 0;
	const summaries: Array<{ model?: string; effort?: string }> = [];
	const remoteRequests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model?: string; reasoning_effort?: string };
			const pathname = new URL(request.url).pathname;
			if (pathname !== "/v1/chat/completions") {
				remoteRequests.push(pathname);
				return Response.json({ summary: "unadmitted remote summary" });
			}
			if (overflowNext) {
				overflowNext = false;
				overflows++;
				return Response.json(
					{
						error: {
							type: "invalid_request_error",
							code: "context_length_exceeded",
							message:
								"This model's maximum context length is 128000 tokens. However, you requested 128001 tokens. Reduce the length of the messages.",
						},
					},
					{ status: 400 },
				);
			}
			if (compacting) summaries.push({ model: body.model, effort: body.reasoning_effort });
			return new Response(
				'data: {"id":"compaction-route","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{"role":"assistant","content":"Approved continuation."}}]}\n\n' +
					'data: {"id":"compaction-route","object":"chat.completion.chunk","created":0,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":4,"total_tokens":34}}\n\n' +
					"data: [DONE]\n\n",
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const settings = Settings.isolated({
		modelRoles: { review: "routing-test/primary:high", smol: "routing-test/fallback:low" },
		"compaction.methodOrder": ["remote", "soft"],
		"compaction.keepRecentTokens": 1,
		"compaction.autoContinue": false,
		"compaction.remoteEndpoint": `${server.url}remote-compact`,
		"todo.enabled": false,
	});
	const fixture = createTaskModelFixture(settings, { baseUrl: `${server.url}v1` });
	const dir = TempDir.createSync("@governed-auto-compaction-");
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { permit } = await createTaskModelRoute({
			authority: { settings, agentName: "worker" },
			modelRegistry: fixture.modelRegistry,
			selectors: ["@review"],
			explicit: true,
		});
		({ session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			settings,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.modelRegistry,
			roleRoute: permit,
			sessionManager: SessionManager.inMemory(dir.path()),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			cacheWarming: false,
			toolNames: ["read"],
		}));
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") compacting = true;
			if (event.type === "auto_compaction_end") compacting = false;
		});
		await session.prompt("Complete the first approved step.");
		await session.waitForIdle();
		await session.prompt("Complete the second approved step.");
		await session.waitForIdle();
		overflowNext = true;
		await session.prompt("Recover the overflow and continue the approved work.");
		await session.waitForIdle();
		expect(overflows).toBe(1);
		expect(remoteRequests).toEqual([]);
		expect(new Set(summaries.map(request => `${request.model}:${request.effort}`))).toEqual(
			new Set(["primary:high"]),
		);
		const resumed = session.agent.state.messages.at(-1);
		if (!resumed || resumed.role !== "assistant") throw new Error("Missing resumed assistant message.");
		expect(resumed.stopReason).toBe("stop");
		expect(
			resumed.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		).toBe("Approved continuation.");
	} finally {
		await session?.dispose();
		server.stop(true);
		fixture.close();
		dir.removeSync();
	}
});
