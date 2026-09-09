import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

type RequestLine = {
	id?: unknown;
	method?: unknown;
	params?: unknown;
	jsonrpc?: unknown;
};

function readSocketLines(socket: net.Socket, handleLine: (line: string, socket: net.Socket) => void): void {
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("data", chunk => {
		buffer += String(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			handleLine(line, socket);
		}
	});
}

async function withSocketServer(
	handleLine: (line: string, socket: net.Socket) => void,
	run: (socketPath: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-browser-test-"));
	const socketPath = path.join(dir, "cmux.sock");
	const server = net.createServer(socket => {
		readSocketLines(socket, handleLine);
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;

	try {
		await run(socketPath);
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function withTcpRelayServer(
	challenge: Record<string, unknown>,
	handleLine: (line: string, socket: net.Socket) => void,
	run: (socketPath: string, port: number) => Promise<void>,
): Promise<void> {
	const server = net.createServer(socket => {
		readSocketLines(socket, handleLine);
		socket.write(`${JSON.stringify(challenge)}\n`);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("TCP relay server did not expose an address");
	}

	try {
		await run(`127.0.0.1:${address.port}`, address.port);
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CmuxSocketClient", () => {
	it("authenticates, frames JSON requests, and returns the result", async () => {
		const lines: string[] = [];
		const requests: RequestLine[] = [];

		await withSocketServer(
			(line, socket) => {
				lines.push(line);
				if (line.startsWith("auth ")) {
					socket.write("OK\n");
					return;
				}
				const request = JSON.parse(line) as RequestLine;
				requests.push(request);
				socket.write(`${JSON.stringify({ ok: true, result: { echoed: request.params } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath, password: "secret" });
				try {
					const result = await client.request("browser.navigate", {
						surface_id: "surface-1",
						url: "https://example.com",
					});

					expect(result).toEqual({
						echoed: { surface_id: "surface-1", url: "https://example.com" },
					});
					expect(lines[0]).toBe("auth secret");
					expect(requests).toHaveLength(1);
					expect(requests[0]?.id).toEqual(expect.any(String));
					expect(requests[0]?.method).toBe("browser.navigate");
					expect(requests[0]?.params).toEqual({
						surface_id: "surface-1",
						url: "https://example.com",
					});
					expect(requests[0]).not.toHaveProperty("jsonrpc");
				} finally {
					client.close();
				}
			},
		);
	});

	it("authenticates a TCP relay before forwarding JSON requests", async () => {
		const lines: string[] = [];
		await withTcpRelayServer(
			{ protocol: "cmux-relay-auth", version: 1, relay_id: "relay-1", nonce: "nonce-1" },
			(line, socket) => {
				lines.push(line);
				if (lines.length === 1) {
					socket.write(`${JSON.stringify({ ok: true })}\n`);
					return;
				}
				socket.write(`${JSON.stringify({ ok: true, result: { connected: true } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({
					socketPath,
					relayId: "relay-1",
					relayToken: "00112233445566778899aabbccddeeff",
				});
				try {
					expect(await client.request("browser.navigate", { url: "https://example.com" })).toEqual({
						connected: true,
					});
				} finally {
					client.close();
				}
			},
		);

		expect(JSON.parse(lines[0] ?? "")).toEqual({
			relay_id: "relay-1",
			mac: "f99276589f826dcb777c2e0137a80ff5cb2bdb7ac72b55b3080d0febdf18c414",
		});
		expect(JSON.parse(lines[1] ?? "")).toEqual({
			id: expect.any(String),
			method: "browser.navigate",
			params: { url: "https://example.com" },
		});
	});

	it("loads TCP relay credentials from the cmux auth file", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-relay-home-"));
		spyOn(os, "homedir").mockReturnValue(home);
		const lines: string[] = [];
		try {
			await withTcpRelayServer(
				{ protocol: "cmux-relay-auth", version: 1, relay_id: "relay-1", nonce: "nonce-1" },
				(line, socket) => {
					lines.push(line);
					if (lines.length === 1) {
						socket.write(`${JSON.stringify({ ok: true })}\n`);
						return;
					}
					socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`);
				},
				async (socketPath, port) => {
					await Bun.write(
						path.join(home, ".cmux", "relay", `${port}.auth`),
						JSON.stringify({
							relay_id: "relay-1",
							relay_token: "00112233445566778899aabbccddeeff",
						}),
					);
					const client = new CmuxSocketClient({ socketPath, relayId: "", relayToken: "" });
					try {
						await client.request("browser.get_url", {});
					} finally {
						client.close();
					}
				},
			);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}

		expect(JSON.parse(lines[0] ?? "")).toEqual({
			relay_id: "relay-1",
			mac: "f99276589f826dcb777c2e0137a80ff5cb2bdb7ac72b55b3080d0febdf18c414",
		});
	});

	it("throws ToolError for ok:false not_supported responses", async () => {
		await withSocketServer(
			(_line, socket) => {
				socket.write(`${JSON.stringify({ ok: false, error: { code: "not_supported", message: "x" } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath });
				try {
					await client.request("browser.drag", {});
					throw new Error("Expected cmux request to fail");
				} catch (error) {
					expect(error).toBeInstanceOf(ToolError);
					expect(error).toHaveProperty("message", "not_supported: x");
				} finally {
					client.close();
				}
			},
		);
	});

	it("serializes sequential requests on one socket", async () => {
		const seenMethods: string[] = [];
		let pendingFirstResponse: (() => void) | undefined;
		const firstRequestSeen = Promise.withResolvers<void>();

		await withSocketServer(
			(line, socket) => {
				const request = JSON.parse(line) as RequestLine;
				seenMethods.push(String(request.method));
				if (request.method === "first") {
					firstRequestSeen.resolve();
					pendingFirstResponse = () => {
						socket.write(`${JSON.stringify({ ok: true, result: { index: 1 } })}\n`);
					};
					return;
				}
				socket.write(`${JSON.stringify({ ok: true, result: { index: 2 } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath });
				try {
					const first = client.request("first", {});
					const second = client.request("second", {});
					await firstRequestSeen.promise;
					expect(seenMethods).toEqual(["first"]);
					pendingFirstResponse?.();
					expect(await first).toEqual({ index: 1 });
					expect(await second).toEqual({ index: 2 });
					expect(seenMethods).toEqual(["first", "second"]);
				} finally {
					client.close();
				}
			},
		);
	});
});
