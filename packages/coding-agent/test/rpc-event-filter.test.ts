import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";

describe("set_event_filter over RPC", () => {
	test("rejects invalid replacements atomically and echoes projection resets in v1 and v2", async () => {
		const dir = TempDir.createSync("@omp-rpc-filter-");
		const model = "claude-sonnet-4-5";
		const sse = [
			{
				type: "message_start",
				message: {
					id: "msg_mock",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					usage: { input_tokens: 8, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		]
			.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join("");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.method === "GET")
					return Response.json({
						data: [{ id: model, type: "model", display_name: "Mock", created_at: "2025-09-29T00:00:00Z" }],
						has_more: false,
					});
				return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const home = dir.path();
		await Bun.write(
			join(home, ".omp/agent/models.yml"),
			`providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${server.port}\n    apiKey: test-dummy-key\n`,
		);
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../src/cli.ts"),
				"--mode",
				"rpc",
				"--no-ui",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--provider",
				"anthropic",
				"--model",
				model,
			],
			{
				cwd: home,
				env: {
					HOME: home,
					PATH: process.env.PATH,
					XDG_CONFIG_HOME: home,
					XDG_DATA_HOME: home,
					PI_CODING_AGENT_DIR: join(home, ".omp/agent"),
					NO_COLOR: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30000));
		const decoder = new TextDecoder();
		const receive = async (): Promise<Record<string, unknown>> => {
			const line = await lines.next();
			if (line.done) throw new Error(await stderr);
			return JSON.parse(decoder.decode(line.value));
		};
		let id = 0;
		const command = async (fields: object): Promise<Record<string, unknown>> => {
			const requestId = String(++id);
			child.stdin.write(JSON.stringify({ ...fields, id: requestId }) + "\n");
			await child.stdin.flush();
			for (;;) {
				const frame = await receive();
				if (frame.type === "response" && frame.id === requestId) return frame;
			}
		};
		const updates = async () => {
			expect(await command({ type: "prompt", message: "hello" })).toMatchObject({ success: true });
			const frames: Record<string, unknown>[] = [];
			for (;;) {
				const frame = await receive();
				if (frame.type === "session_settled") return frames;
				if (frame.type === "prompt_result") expect(frame.status).toBe("completed");
				if (frame.type === "message_update" || frame.type === "message_end") frames.push(frame);
			}
		};
		try {
			while ((await receive()).type !== "ready") {}
			for (const version of [1, 2]) {
				if (version === 2)
					expect(await command({ type: "negotiate_protocol", protocolVersion: 2 })).toMatchObject({
						success: true,
					});
				expect(
					await command({ type: "set_event_filter", events: ["message_update"], messageUpdates: "delta" }),
				).toMatchObject({ success: true, data: { events: ["message_update"], messageUpdates: "delta" } });
				for (const invalid of ["bad", null]) {
					expect(
						await command({ type: "set_event_filter", events: ["message_end"], messageUpdates: invalid }),
					).toMatchObject({ command: "set_event_filter", success: false, error: expect.any(String) });
				}
				expect(await command({ type: "set_event_filter", events: [1], messageUpdates: "full" })).toMatchObject({
					success: false,
				});
				const projected = await updates();
				expect(projected.some(frame => frame.type === "message_end")).toBe(false);
				const delta = projected.find(
					frame => (frame.assistantMessageEvent as { type: string }).type === "text_delta",
				);
				expect(delta).toMatchObject({
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
				});
				expect(delta?.message).toEqual({ role: "assistant" });
				expect(delta?.assistantMessageEvent).not.toHaveProperty("partial");
				expect(await command({ type: "set_event_filter", events: null })).toMatchObject({
					success: true,
					data: { events: null, messageUpdates: "full" },
				});
				const restored = await updates();
				expect(restored.some(frame => frame.type === "message_end")).toBe(true);
				const full = restored.find(
					frame =>
						frame.type === "message_update" &&
						(frame.assistantMessageEvent as { type: string }).type === "text_delta",
				);
				expect(full?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hello" }] });
				expect(full?.assistantMessageEvent).toHaveProperty("partial");
			}
		} finally {
			child.kill();
			await child.exited;
			await stderr;
			server.stop(true);
			await dir.remove();
		}
	}, 60000);
});
