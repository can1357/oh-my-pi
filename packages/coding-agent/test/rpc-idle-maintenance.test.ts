import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, readJsonl, removeWithRetries, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const RPC_TEST_TIMEOUT_MS = 30_000;
const RPC_CHILD_TIMEOUT_MS = 20_000;

const scriptedIdleExtension = `function (pi) {
	pi.registerProvider("scripted", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "scripted-key",
		api: "scripted-idle",
		models: [{
			id: "idle",
			name: "Scripted idle",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 4096,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const lastUser = context.messages.findLast(entry => entry.role === "user");
			const promptText = typeof lastUser?.content === "string" ? lastUser.content : lastUser?.content.map(part => part.text ?? "").join("") ?? "";
			const responseText = promptText === "First turn" || promptText === "Second turn"
				? Array.from({ length: 200 }, (_, index) => "word" + index).join(" ")
				: "Short summary.";
			const message = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 60000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 60100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
				content: [{ type: "text", text: responseText }],
				stopReason: "stop",
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	pi.on("session_start", async () => {
		await pi.sendUserMessage("First turn");
		await pi.sendUserMessage("Second turn");
	});
}
`;

describe("RPC idle maintenance", () => {
	it(
		"runs configured idle compaction after extension startup turns without journaling an idle recap",
		async () => {
			await using temp = await TempDir.create("@rpc-idle-maintenance-");
			const sourceDir = path.resolve(import.meta.dir, "../src");
			const fixturePath = temp.join("runtime.ts");
			await Bun.write(
				fixturePath,
				`
import { createAssistantMessageEventStream } from ${JSON.stringify(path.resolve(import.meta.dir, "../../ai/src/index.ts"))};
import { buildModel } from ${JSON.stringify(path.resolve(import.meta.dir, "../../catalog/src/build.ts"))};
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};

globalThis.fetch = async () => { throw new Error("Offline RPC idle fixture refuses network"); };
const { session } = await createAgentSession({
	cwd: process.cwd(),
	toolNames: [],
	enableMCP: false,
	enableLsp: false,
	disableExtensionDiscovery: true,
	extensions: [${scriptedIdleExtension}],
	model: buildModel({
		id: "idle",
		name: "Scripted idle",
		api: "scripted-idle",
		provider: "scripted",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 4096,
	}),
	settings: Settings.isolated({
		"compaction.enabled": true,
		"compaction.autoContinue": false,
		"compaction.idleEnabled": true,
		"compaction.idleThresholdTokens": 1,
		"compaction.idleTimeoutSeconds": 60,
		"compaction.keepRecentTokens": 1,
		"compaction.methodOrder": ["soft"],
		"contextPromotion.enabled": false,
		"recap.enabled": true,
		"recap.idleSeconds": 60,
		"todo.enabled": false,
		"todo.reminders": false,
	}),
});
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback, delay = 0, ...args) =>
	originalSetTimeout(callback, delay === 60000 ? 25 : delay, ...args)) as typeof setTimeout;
await runRpcMode(session, { headless: true });
`,
			);
			const agentDir = temp.join("agent");
			const child = Bun.spawn([process.execPath, fixturePath], {
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: agentDir,
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: RPC_CHILD_TIMEOUT_MS,
			});
			const stderr = new Response(child.stderr).text();
			let autoCompactionStart: unknown;
			let autoCompactionEnd: unknown;
			const frames: unknown[] = [];
			try {
				for await (const frame of readJsonl<unknown>(child.stdout)) {
					if (!isRecord(frame)) continue;
					frames.push({
						type: frame.type,
						id: frame.id,
						command: frame.command,
						success: frame.success,
						status: frame.status,
						error: frame.error,
						stopReason: isRecord(frame.message) ? frame.message.stopReason : undefined,
						errorMessage: isRecord(frame.message) ? frame.message.errorMessage : undefined,
					});
					if (frame.type === "auto_compaction_start") {
						autoCompactionStart = frame;
					} else if (frame.type === "auto_compaction_end") {
						autoCompactionEnd = frame;
						break;
					}
				}
			} finally {
				child.stdin.end();
				child.kill();
				await child.exited;
			}

			expect(autoCompactionStart).toMatchObject({ type: "auto_compaction_start", reason: "idle" });
			expect(autoCompactionEnd, JSON.stringify({ frames, stderr: await stderr })).toBeDefined();
			const sessionFiles = await Array.fromAsync(new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir }));
			const entries = await Promise.all(
				sessionFiles.map(async file => parseSessionEntries(await Bun.file(path.join(agentDir, file)).text())),
			);
			expect(
				entries.flat().filter(entry => entry.type === "compaction"),
				JSON.stringify({ autoCompactionEnd, sessionFiles }),
			).toHaveLength(1);

			const historyPath = path.join(agentDir, "history.db");
			let recapCount = 0;
			if (await Bun.file(historyPath).exists()) {
				const history = new Database(historyPath, { readonly: true });
				try {
					const row = history.query("SELECT COUNT(*) AS count FROM session_recaps").get() as { count: number };
					recapCount = row.count;
				} finally {
					history.close();
				}
			}
			expect(recapCount).toBe(0);
		},
		RPC_TEST_TIMEOUT_MS,
	);

	it(
		"keeps idle compaction blocked while a goal continuation is held and re-arms on drop",
		async () => {
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-idle-"));
			const rpc = new RpcClient({
				command: [process.execPath, path.join(import.meta.dir, "fixtures", "goal-rpc-agent.ts")],
				cwd: directory,
				env: {
					PI_CODING_AGENT_DIR: directory,
					PI_NO_TITLE: "1",
					GOAL_RPC_CONTINUATION: "1",
					GOAL_RPC_SCRIPT: "complete",
					GOAL_RPC_PLAN: "0",
					GOAL_RPC_PERSIST: "0",
					GOAL_RPC_IDLE_MAINTENANCE: "1",
				},
			});
			try {
				await rpc.start();
				await rpc.promptAndWait("setup for idle compaction");
				const firstTurnEnd = Promise.withResolvers<void>();
				const idleStart = Promise.withResolvers<void>();
				let idleStarts = 0;
				let agentStartsAfterDrop = 0;
				let dropped = false;
				const unsubscribe = rpc.onSessionEvent(event => {
					if (event.type === "agent_start" && dropped) agentStartsAfterDrop++;
					if (event.type === "agent_end") firstTurnEnd.resolve();
					if (event.type === "auto_compaction_start" && event.reason === "idle") {
						idleStarts++;
						idleStart.resolve();
					}
				});
				try {
					await rpc.goal("create", { objective: "hold the second turn, then drop it" });
					await withTimeout(firstTurnEnd.promise, 10_000, "First goal turn never finished");
					await Bun.sleep(150);
					expect(idleStarts).toBe(0);
					const held = await rpc.getState();
					expect(held.goal?.goal.status).toBe("active");
					expect(held.isSettled).toBe(false);
					await rpc.goal("drop");
					dropped = true;
					await rpc.promptAndWait("/goaltest-release-continuation");
					await withTimeout(idleStart.promise, 5_000, "Dropped continuation did not re-arm idle compaction");
					expect(idleStarts).toBe(1);
					expect(agentStartsAfterDrop).toBe(0);
				} finally {
					unsubscribe();
				}
			} finally {
				await rpc.stop();
				await removeWithRetries(directory);
			}
		},
		RPC_TEST_TIMEOUT_MS,
	);
});
