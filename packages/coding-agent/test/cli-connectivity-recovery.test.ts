import { expect, it } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { TempDir } from "@oh-my-pi/pi-utils";

it("a running CLI preserves a completed side effect through real TCP disconnects and reconnects", async () => {
	using tempDir = TempDir.createSync("@omp-cli-connectivity-");
	let requests = 0;
	let recoveredWithToolResult = false;
	const ledger = tempDir.join("side-effect-ledger.txt");
	const server = net.createServer(socket => {
		socket.on("error", () => {});
		let request = "";
		let responded = false;
		socket.on("data", data => {
			request += data.toString();
			const headerEnd = request.indexOf("\r\n\r\n");
			if (responded || headerEnd < 0) return;
			const length = Number(/content-length:\s*(\d+)/i.exec(request.slice(0, headerEnd))?.[1] ?? 0);
			const requestBody = request.slice(headerEnd + 4);
			if (new TextEncoder().encode(requestBody).byteLength < length) return;
			responded = true;
			requests++;
			if (requests > 1 && requests <= 7) {
				const prefix = 'data: {"id":"dropped","choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n';
				socket.write(
					`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1048576\r\n\r\n${prefix}`,
				);
				setTimeout(() => socket.resetAndDestroy(), 10);
				return;
			}
			const payload = JSON.parse(requestBody) as {
				messages: { role: string; tool_call_id?: string; content?: string }[];
			};
			if (requests > 7)
				recoveredWithToolResult = payload.messages.some(
					message =>
						message.role === "tool" && message.tool_call_id === "record-1" && message.content === "recorded once",
				);
			const events =
				requests === 1
					? [
							{
								id: "record",
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{
													index: 0,
													id: "record-1",
													type: "function",
													function: { name: "connectivity_record", arguments: "{}" },
												},
											],
										},
										finish_reason: null,
									},
								],
							},
							{ id: "record", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
						]
					: [
							{
								id: "reconnected",
								choices: [{ index: 0, delta: { content: "finished after reconnect" }, finish_reason: null }],
							},
							{
								id: "reconnected",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							},
						];
			const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
			socket.end(
				`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: ${new TextEncoder().encode(body).byteLength}\r\n\r\n${body}`,
			);
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP test endpoint");
		const agentDir = tempDir.join("agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"compaction:\n  enabled: false\nretry:\n  waitForConnection: true\n  maxRetries: 1\n  baseDelayMs: 1\n  modelFallback: false\n",
		);
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(env)) {
			if (
				/(_API_KEY|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_CREDENTIALS|_BASE_URL)$/.test(key) ||
				key.startsWith("HERDR_") ||
				/^(PI_|OMP_PROFILE$)/.test(key)
			)
				delete env[key];
		}
		env.PI_CODING_AGENT_DIR = agentDir;
		env.OMP_CONNECTIVITY_TEST_URL = `http://127.0.0.1:${address.port}/v1`;
		env.OMP_CONNECTIVITY_TEST_LEDGER = ledger;
		env.NO_COLOR = "1";
		const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
		const fixture = path.resolve(import.meta.dir, "fixtures/connectivity-provider.ts");
		const proc = Bun.spawn(
			[
				process.execPath,
				cliEntry,
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--no-tools",
				"--tools",
				"connectivity_record",
				"--no-lsp",
				"--no-title",
				"--no-prewalk",
				"--no-skills",
				"--no-rules",
				"--no-extensions",
				"-e",
				fixture,
				"--model",
				"connectivity-fixture/connection-test",
				"Finish after the endpoint recovers",
			],
			{
				cwd: tempDir.path(),
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(45_000),
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		const events: AgentSessionEvent[] = stdout
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line));
		const starts = events.filter(event => event.type === "auto_retry_start");
		expect(starts.length).toBeGreaterThan(1);
		expect(starts.every(event => event.connectivity && event.maxAttempts === 0)).toBe(true);
		expect(events).toContainEqual(expect.objectContaining({ type: "auto_retry_end", success: true }));
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message_end",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "stop",
					content: expect.arrayContaining([{ type: "text", text: "finished after reconnect" }]),
				}),
			}),
		);
		expect(requests).toBeGreaterThan(7);
		expect(recoveredWithToolResult).toBe(true);
		expect(await Bun.file(ledger).text()).toBe("recorded once\n");
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	}
}, 60_000);
