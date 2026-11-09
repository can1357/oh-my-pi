import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, TempDir } from "@oh-my-pi/pi-utils";
import { requestSessionTerminalRefresh, sessionAttachEndpoint } from "../../src/launch/session-attach";

type Frame = Record<string, unknown> & { id?: string; type?: string; message?: string };

interface RefreshServer {
	readonly endpoint: string;
	readonly requests: Frame[];
	close(): Promise<void>;
}

function serveRefresh(endpoint: string, reply: (frame: Frame) => object | undefined): Promise<RefreshServer> {
	const requests: Frame[] = [];
	const connections = new Set<IpcConnection>();
	const listening = IpcServer.listen(endpoint, { framing: "lines" }, connection => {
		connections.add(connection);
		connection.start(
			line => {
				const frame = JSON.parse(line) as Frame;
				requests.push(frame);
				const response = reply(frame);
				if (response) connection.send(JSON.stringify(response));
			},
			() => {
				connections.delete(connection);
			},
		);
		connection.send(JSON.stringify({ type: "ready", protocolVersion: 1 }));
	});
	return listening.then(server => ({
		endpoint,
		requests,
		async close() {
			for (const connection of connections) connection.destroy();
			await server.close();
		},
	}));
}

function refreshed(frame: Frame, overrides: Partial<Frame> = {}): object {
	return {
		type: "terminal_refreshed",
		id: frame.id,
		sessionId: frame.sessionId,
		generation: frame.generation,
		...overrides,
	};
}

describe("sessionAttachEndpoint", () => {
	it("falls back to the profile-independent run directory without OMP_RUN_DIR", () => {
		const previous = process.env.OMP_RUN_DIR;
		delete process.env.OMP_RUN_DIR;
		try {
			expect(sessionAttachEndpoint("session-a")).toBe(
				ipcEndpoint(path.join(getBaseConfigRoot(), "run"), "session-a"),
			);
		} finally {
			if (previous === undefined) delete process.env.OMP_RUN_DIR;
			else process.env.OMP_RUN_DIR = previous;
		}
	});

	it("honours an explicit endpoint directory", () => {
		using tempDir = TempDir.createSync("@omp-session-endpoint-");
		expect(sessionAttachEndpoint("session-a", tempDir.path())).toBe(ipcEndpoint(tempDir.path(), "session-a"));
	});

	it("rejects an id that could name a path", () => {
		expect(() => sessionAttachEndpoint("../escape")).toThrow(TypeError);
		expect(() => sessionAttachEndpoint("")).toThrow(TypeError);
	});
});

describe("requestSessionTerminalRefresh", () => {
	it("sends a fenced refresh and resolves on the matching refreshed frame", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		const endpoint = sessionAttachEndpoint("session-a", tempDir.path());
		const server = await serveRefresh(endpoint, frame => refreshed(frame));
		try {
			await requestSessionTerminalRefresh("session-a", "generation-a", { endpointDir: tempDir.path() });

			expect(server.requests).toHaveLength(1);
			const request = server.requests[0]!;
			expect(request).toMatchObject({
				type: "terminal_refresh",
				sessionId: "session-a",
				generation: "generation-a",
			});
			expect(typeof request.id).toBe("string");
			expect(request.id!.length).toBeGreaterThan(0);
		} finally {
			await server.close();
		}
	});

	it("rejects with the endpoint's refusal message", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		const endpoint = sessionAttachEndpoint("session-a", tempDir.path());
		const server = await serveRefresh(endpoint, frame => ({
			type: "terminal_refresh_error",
			id: frame.id,
			message: "terminal refresh refused: not this attachment",
		}));
		try {
			await expect(
				requestSessionTerminalRefresh("session-a", "generation-a", { endpointDir: tempDir.path() }),
			).rejects.toThrow("not this attachment");
		} finally {
			await server.close();
		}
	});

	it("rejects a refreshed frame that names another session", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		const endpoint = sessionAttachEndpoint("session-a", tempDir.path());
		const server = await serveRefresh(endpoint, frame => refreshed(frame, { sessionId: "session-b" }));
		try {
			await expect(
				requestSessionTerminalRefresh("session-a", "generation-a", { endpointDir: tempDir.path() }),
			).rejects.toThrow("session-b");
		} finally {
			await server.close();
		}
	});

	it("rejects a refreshed frame that names another generation", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		const endpoint = sessionAttachEndpoint("session-a", tempDir.path());
		const server = await serveRefresh(endpoint, frame => refreshed(frame, { generation: "generation-b" }));
		try {
			await expect(
				requestSessionTerminalRefresh("session-a", "generation-a", { endpointDir: tempDir.path() }),
			).rejects.toThrow("generation-b");
		} finally {
			await server.close();
		}
	});

	it("rejects when no endpoint is listening", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		await expect(
			requestSessionTerminalRefresh("session-a", "generation-a", {
				endpointDir: tempDir.path(),
				timeoutMs: 500,
			}),
		).rejects.toThrow();
	});

	it("rejects instead of hanging when the endpoint never answers", async () => {
		using tempDir = TempDir.createSync("@omp-session-refresh-");
		const endpoint = sessionAttachEndpoint("session-a", tempDir.path());
		const server = await serveRefresh(endpoint, () => undefined);
		try {
			await expect(
				requestSessionTerminalRefresh("session-a", "generation-a", {
					endpointDir: tempDir.path(),
					timeoutMs: 250,
				}),
			).rejects.toThrow();
		} finally {
			await server.close();
		}
	});
});
