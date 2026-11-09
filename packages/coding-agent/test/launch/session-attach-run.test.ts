// Integration test — real timers are not used: the owner exits only after the
// mirror forwards a local byte, and every awaited signal is a socket frame or a
// broker terminal notification.
import { describe, expect, it } from "bun:test";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import type { DaemonBrokerClient } from "../../src/launch/client";
import { sessionAttachEndpoint } from "../../src/launch/session-attach";
import { runLiveSessionAttach } from "../../src/launch/session-attach-run";
import type { TerminalMirrorInput, TerminalMirrorOutput } from "../../src/launch/terminal-mirror";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

type Frame = Record<string, unknown> & { id?: string; type?: string; message?: string };

interface LocalTerminal {
	readonly input: TerminalMirrorInput;
	readonly output: TerminalMirrorOutput;
	readonly chunks: string[];
	readonly typed: string[];
	send(data: string): void;
}

function localTerminal(): LocalTerminal {
	const chunks: string[] = [];
	const typed: string[] = [];
	let listener: ((data: string) => void) | undefined;
	const input: TerminalMirrorInput = {
		onData(next) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		resume: () => {},
		pause: () => {},
		setRawMode: () => {},
	};
	return {
		input,
		output: {
			write(data) {
				chunks.push(data);
				return true;
			},
		},
		chunks,
		typed,
		send(data) {
			typed.push(data);
			listener?.(data);
		},
	};
}

interface RefreshEndpoint {
	readonly requests: Frame[];
	close(): Promise<void>;
}

function serveRefresh(endpoint: string, reply: (frame: Frame) => object | undefined): Promise<RefreshEndpoint> {
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
		requests,
		async close() {
			for (const connection of connections) connection.destroy();
			await server.close();
		},
	}));
}

async function startOwner(
	client: DaemonBrokerClient,
	projectDir: string,
	script: string,
): Promise<{ name: string; id: string }> {
	const subscriptionId = `bootstrap-${Snowflake.next()}`;
	const name = `mind-${Snowflake.next()}`;
	const started = await client.request({
		op: "terminal_start",
		subscriptionId,
		spec: terminalSpec(projectDir, script, { name }),
		columns: 100,
		rows: 30,
	});
	if (started.op !== "terminal_start") throw new Error("terminal_start did not start the owner");
	await client.request({ op: "terminal_detach", subscriptionId, name, id: started.daemon.id });
	return { name, id: started.daemon.id };
}

const OWNER_SCRIPT = [
	"process.stdin.resume();",
	'process.stdin.once("data", () => { process.stdout.write("OWNER-BANNER\\r\\n"); process.exit(7); });',
].join("\n");

describe("runLiveSessionAttach", () => {
	it("mirrors the live owner, refreshes its renderer, and reports the owner exit code", async () => {
		await withTerminalBroker(async ({ client, projectDir, connect }) => {
			using tempDir = TempDir.createSync("@omp-session-attach-run-");
			const owner = await startOwner(client, projectDir, OWNER_SCRIPT);
			const sessionId = `session-${Snowflake.next()}`;
			const endpoint = sessionAttachEndpoint(sessionId, tempDir.path());
			const terminal = localTerminal();
			const server = await serveRefresh(endpoint, frame => {
				terminal.send("go\n");
				return { type: "terminal_refreshed", id: frame.id, sessionId, generation: owner.id };
			});
			try {
				const exitCode = await runLiveSessionAttach(
					sessionId,
					{ protocolVersion: 1, projectDir, name: owner.name, id: owner.id },
					{
						client: await connect(),
						endpointDir: tempDir.path(),
						timeoutMs: 5_000,
						mirror: { input: terminal.input, output: terminal.output },
					},
				);

				expect(exitCode).toBe(7);
				expect(terminal.chunks.join("")).toContain("OWNER-BANNER");
				expect(server.requests).toHaveLength(1);
				expect(server.requests[0]).toMatchObject({
					type: "terminal_refresh",
					sessionId,
					generation: owner.id,
				});
			} finally {
				await server.close();
			}
		});
	}, 30_000);

	it("propagates a refused refresh instead of running without a repaint", async () => {
		await withTerminalBroker(async ({ client, projectDir, connect }) => {
			using tempDir = TempDir.createSync("@omp-session-attach-run-");
			const owner = await startOwner(client, projectDir, OWNER_SCRIPT);
			const sessionId = `session-${Snowflake.next()}`;
			const endpoint = sessionAttachEndpoint(sessionId, tempDir.path());
			const terminal = localTerminal();
			const server = await serveRefresh(endpoint, frame => ({
				type: "terminal_refresh_error",
				id: frame.id,
				message: "refused: not this attachment",
			}));
			try {
				await expect(
					runLiveSessionAttach(
						sessionId,
						{ protocolVersion: 1, projectDir, name: owner.name, id: owner.id },
						{
							client: await connect(),
							endpointDir: tempDir.path(),
							timeoutMs: 5_000,
							mirror: { input: terminal.input, output: terminal.output },
						},
					),
				).rejects.toThrow("not this attachment");
			} finally {
				await server.close();
			}
		});
	}, 30_000);
});
