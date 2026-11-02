import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");

describe("headless startup resume", () => {
	test.each(["print", "json", "rpc", "rpc-ui"])(
		"does not send a saved transcript to the settings default in %s mode",
		async mode => {
			using tempDir = TempDir.createSync("@omp-resume-model-");
			const requests: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					requests.push(await request.text());
					return Response.json({ error: { message: "Unexpected transcript disclosure" } }, { status: 400 });
				},
			});
			try {
				const agentDir = tempDir.join("home", ".omp", "agent");
				await Bun.write(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							other: {
								baseUrl: `${server.url.origin}/v1`,
								api: "openai-completions",
								auth: "none",
								models: [
									{
										id: "default-model",
										name: "Default Model",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 131072,
										maxTokens: 1024,
									},
								],
							},
						},
					}),
				);
				await Bun.write(
					path.join(agentDir, "config.yml"),
					JSON.stringify({
						modelRoles: { default: "other/default-model" },
						retry: { enabled: false },
						compaction: { enabled: false },
					}),
				);
				const sessionFile = tempDir.join("saved.jsonl");
				const timestamp = "2026-06-01T00:00:00.000Z";
				await Bun.write(
					sessionFile,
					`${[
						{ type: "session", version: 3, id: "saved", timestamp, cwd: tempDir.path() },
						{
							type: "model_change",
							id: "model",
							parentId: null,
							timestamp,
							model: "local/missing-model",
							role: "default",
						},
						{
							type: "message",
							id: "user",
							parentId: "model",
							timestamp,
							message: { role: "user", content: "Remember ZEBRA-42.", timestamp: Date.parse(timestamp) },
						},
					]
						.map(entry => JSON.stringify(entry))
						.join("\n")}\n`,
				);
				const rpc = mode === "rpc" || mode === "rpc-ui";
				const args = mode === "print" ? ["-p"] : ["--mode", mode];
				if (!rpc) args.push("Continue the previous turn.");
				const proc = Bun.spawn(
					[
						process.execPath,
						cliEntry,
						"--no-title",
						"--no-lsp",
						"--no-extensions",
						"--no-tools",
						"--resume",
						sessionFile,
						...args,
					],
					{
						cwd: tempDir.path(),
						env: {
							PATH: process.env.PATH,
							HOME: tempDir.join("home"),
							// os.homedir() reads USERPROFILE on Windows.
							USERPROFILE: tempDir.join("home"),
							TMPDIR: process.env.TMPDIR,
							NO_COLOR: "1",
						},
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				try {
					if (rpc) {
						proc.stdin.write(`${JSON.stringify({ id: "resume", type: "prompt", message: "Continue." })}\n`);
					} else {
						proc.stdin.end();
					}
					const stdout = (async () => {
						let text = "";
						for await (const bytes of proc.stdout) {
							text += new TextDecoder().decode(bytes);
							if (rpc && text.includes('"type":"agent_end"')) proc.stdin.end();
						}
						return text;
					})();
					const [exitCode, out, stderr] = await Promise.all([
						proc.exited,
						stdout,
						new Response(proc.stderr).text(),
					]);
					expect(stderr).toContain("Could not restore model local/missing-model");
					expect(exitCode).toBe(1);
					expect(requests).toEqual([]);
					expect(out).toBe("");
				} finally {
					proc.kill();
					await proc.exited;
				}
			} finally {
				server.stop(true);
			}
		},
		30_000,
	);
});

type RpcFrame = { type?: string; id?: string; success?: boolean; error?: string; data?: Record<string, unknown> };

/** A loopback provider model; the `local` provider renamed `local-model` to `renamed-model`. */
function loopbackModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 1024,
	};
}

describe("headless runtime session switch", () => {
	/**
	 * Two loopback providers under an isolated HOME: `local`, whose `local-model`
	 * has been renamed to `renamed-model`, and `other`, the settings default.
	 * Requests are recorded by provider and always fail, ending the turn.
	 */
	async function withRpcHost(
		run: (host: {
			cwd: string;
			requests: { provider: string; body: string }[];
			writeThread: (name: string, savedModel: string) => Promise<{ dir: string; file: string }>;
			request: (command: Record<string, unknown>) => Promise<RpcFrame>;
			waitFor: (type: string) => Promise<RpcFrame>;
		}) => Promise<void>,
	): Promise<void> {
		using tempDir = TempDir.createSync("@omp-switch-model-");
		const cwd = tempDir.path();
		const requests: { provider: string; body: string }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push({ provider: new URL(request.url).pathname.split("/")[1], body: await request.text() });
				return Response.json({ error: { message: "Loopback provider" } }, { status: 400 });
			},
		});
		const agentDir = path.join(cwd, "home", ".omp", "agent");
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `${server.url.origin}/local/v1`,
						api: "openai-completions",
						auth: "none",
						models: [loopbackModel("renamed-model")],
					},
					other: {
						baseUrl: `${server.url.origin}/other/v1`,
						api: "openai-completions",
						auth: "none",
						models: [loopbackModel("default-model")],
					},
				},
			}),
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			JSON.stringify({
				modelRoles: { default: "other/default-model" },
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
		);
		const writeThread = async (name: string, savedModel: string) => {
			const dir = path.join(cwd, "threads", name);
			const file = path.join(dir, `2026-06-01T00-00-00-000Z_${name}.jsonl`);
			const timestamp = "2026-06-01T00:00:00.000Z";
			const [provider, model] = savedModel.split("/");
			const assistant = {
				role: "assistant",
				content: [{ type: "text", text: "Noted." }],
				api: "openai-completions",
				provider,
				model,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			};
			await Bun.write(
				file,
				`${[
					{ type: "session", version: 3, id: name, timestamp, cwd },
					{ type: "model_change", id: "model", parentId: null, timestamp, model: savedModel, role: "default" },
					{
						type: "message",
						id: "user",
						parentId: "model",
						timestamp,
						message: { role: "user", content: "Remember ZEBRA-42.", timestamp: Date.parse(timestamp) },
					},
					{ type: "message", id: "assistant", parentId: "user", timestamp, message: assistant },
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			return { dir, file };
		};

		const proc = Bun.spawn(
			[process.execPath, cliEntry, "--no-title", "--no-lsp", "--no-extensions", "--no-tools", "--mode", "rpc"],
			{
				cwd,
				env: {
					PATH: process.env.PATH,
					HOME: path.join(cwd, "home"),
					USERPROFILE: path.join(cwd, "home"),
					TMPDIR: process.env.TMPDIR,
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const frames = readJsonl<RpcFrame>(proc.stdout);
		const waitUntil = async (matches: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
			for (;;) {
				const next = await frames.next();
				if (next.done) throw new Error(`RPC output ended: ${await new Response(proc.stderr).text()}`);
				if (matches(next.value)) return next.value;
			}
		};
		try {
			await waitUntil(frame => frame.type === "ready");
			await run({
				cwd,
				requests,
				writeThread,
				request: command => {
					proc.stdin.write(`${JSON.stringify(command)}\n`);
					return waitUntil(frame => frame.type === "response" && frame.id === command.id);
				},
				waitFor: type => waitUntil(frame => frame.type === type),
			});
		} finally {
			proc.stdin.end();
			proc.kill();
			await proc.exited;
			server.stop(true);
		}
	}

	test("fails open_session and switch_session on an unrestorable saved model and keeps serving", async () => {
		await withRpcHost(async ({ requests, writeThread, request }) => {
			const renamed = await writeThread("renamed", "local/local-model");
			const current = await writeThread("current", "local/renamed-model");
			const before = await request({ id: "state-before", type: "get_state" });

			const opened = await request({ id: "open", type: "open_session", sessionDir: renamed.dir });
			expect(opened).toMatchObject({ success: false, error: "Could not restore model local/local-model" });
			const switched = await request({ id: "switch", type: "switch_session", sessionPath: renamed.file });
			expect(switched).toMatchObject({ success: false, error: "Could not restore model local/local-model" });
			const after = await request({ id: "state-after", type: "get_state" });
			expect(after.data).toMatchObject({
				sessionFile: before.data?.sessionFile,
				sessionId: before.data?.sessionId,
				messageCount: 0,
				model: { provider: "other", id: "default-model" },
			});

			// A thread whose saved model still exists opens as before.
			const reopened = await request({ id: "open-current", type: "open_session", sessionDir: current.dir });
			expect(reopened).toMatchObject({ success: true, data: { resumed: true, sessionFile: current.file } });
			const state = await request({ id: "state-current", type: "get_state" });
			expect(state.data).toMatchObject({ messageCount: 2, model: { provider: "local", id: "renamed-model" } });
			expect(requests).toEqual([]);
		});
	}, 30_000);

	test("binds open_session to an explicit model instead of the unrestorable saved one", async () => {
		await withRpcHost(async ({ requests, writeThread, request, waitFor }) => {
			const renamed = await writeThread("renamed", "local/local-model");
			const base = { type: "open_session", sessionDir: renamed.dir };

			expect(await request({ ...base, id: "partial", provider: "local" })).toMatchObject({
				success: false,
				error: "provider and modelId must be given together",
			});
			expect(await request({ ...base, id: "stale", provider: "local", modelId: "local-model" })).toMatchObject({
				success: false,
				error: "Model not found: local/local-model",
			});
			const opened = await request({ ...base, id: "open", provider: "local", modelId: "renamed-model" });
			expect(opened).toMatchObject({
				success: true,
				data: { cancelled: false, resumed: true, sessionFile: renamed.file },
			});
			const state = await request({ id: "state", type: "get_state" });
			expect(state.data).toMatchObject({ messageCount: 2, model: { provider: "local", id: "renamed-model" } });

			await request({ id: "turn", type: "prompt", message: "What did I ask you to remember?" });
			await waitFor("agent_end");
			expect(requests.map(entry => entry.provider)).toEqual(["local"]);
			expect(requests[0]?.body).toContain("ZEBRA-42");
		});
	}, 30_000);
});
