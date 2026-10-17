import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return [process.execPath, "--eval", "process.exit(1)"];
			},
			provider: "openrouter",
			model: "example/model",
			args: ["--no-session"],
		});

		await expect(client.start()).rejects.toThrow(/exited with code 1/);
		expect(received).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"openrouter",
			"--model",
			"example/model",
			"--no-session",
		]);
	});

	test("defaults an older skill diagnostic duplicate to a content match", async () => {
		const encoder = new TextEncoder();
		const exited = Promise.withResolvers<number>();
		let stdout!: ReadableStreamDefaultController<Uint8Array>;
		const proc: RpcAgentProcess = {
			stdin: {
				write(data: string) {
					const request = JSON.parse(data) as { id: string; type: string };
					if (request.type !== "get_skill_diagnostics") return data.length;
					stdout.enqueue(
						encoder.encode(
							`${JSON.stringify({
								id: request.id,
								type: "response",
								command: request.type,
								success: true,
								data: {
									cwd: "/workspace",
									showStartupDiagnostics: true,
									diagnostics: [
										{
											name: "review",
											reason: "source-order",
											skills: [{ name: "review", filePath: "/a/SKILL.md", source: "native:user" }],
											duplicates: [
												{
													skill: { name: "review", filePath: "/b/SKILL.md", source: "agents:user" },
													retained: { name: "review", filePath: "/a/SKILL.md", source: "native:user" },
												},
											],
										},
									],
								},
							})}\n`,
						),
					);
					return data.length;
				},
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();
		const snapshot = await client.getSkillDiagnostics();
		expect(snapshot.diagnostics[0].duplicates[0].match).toBe("content");
	});
});

describe("RpcClient stdin failures", () => {
	test("fails the request and stops the client when write rejects and flush throws", async () => {
		const exited = Promise.withResolvers<number>();
		const proc: RpcAgentProcess & { stdin: { flush(): never } } = {
			stdin: {
				// A pending pipe write rejects with EPIPE once the agent is gone; flush() can throw synchronously.
				write: () => Promise.reject(new Error("EPIPE: broken pipe, write")),
				flush: () => {
					throw new Error("flush failed");
				},
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("flush failed");
			// Unhandled rejections are reported once the microtask queue drains; one macrotask turn suffices.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			// The broken pipe is terminal: the agent is killed and the client no longer accepts commands.
			expect(await exited.promise).toBe(0);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("rejects a non-serializable command without stopping a healthy client", async () => {
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const proc: RpcAgentProcess = {
			stdin: { write: () => 0 },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				killed = true;
				exited.resolve(0);
			},
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		// A serialization error is not a pipe failure: only this request fails.
		await expect(client.goal("create", { tokenBudget: 1n as unknown as number })).rejects.toThrow(TypeError);
		expect(killed).toBe(false);
	});

	test("still stops the client when killing the agent throws during pipe-failure cleanup", async () => {
		const proc: RpcAgentProcess = {
			stdin: { write: () => Promise.reject(new Error("EPIPE: broken pipe, write")) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				throw new Error("kill failed");
			},
			exited: Promise.withResolvers<number>().promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("EPIPE");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("drops a manual login code that arrives after the client stopped", async () => {
		const exited = Promise.withResolvers<number>();
		const encoder = new TextEncoder();
		let stdout!: ReadableStreamDefaultController<Uint8Array>;
		const written: string[] = [];
		const proc: RpcAgentProcess = {
			stdin: { write: (data: string) => written.push(data) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const code = Promise.withResolvers<string>();
		const prompted = Promise.withResolvers<void>();
		const login = client.login("test-provider", {
			onManualCodeInput: () => {
				prompted.resolve();
				return code.promise;
			},
		});
		stdout.enqueue(
			encoder.encode(
				`${JSON.stringify({ type: "extension_ui_request", id: "ui_1", method: "input", title: "Paste code" })}\n`,
			),
		);
		await prompted.promise;

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// The client stops (as it does on a broken stdin pipe) while the user is still typing the code.
			await client.stop();
			await expect(login).rejects.toThrow("Client stopped");
			const writesBefore = written.length;
			code.resolve("pasted-code");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			expect(written.length).toBe(writesBefore);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
