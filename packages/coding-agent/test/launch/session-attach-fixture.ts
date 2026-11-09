import * as fs from "node:fs";
import * as path from "node:path";
import { IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import type { SessionAttachTerminal } from "../../src/launch/session-attach";
import { RpcSessionSocket } from "../../src/modes/rpc/rpc-socket";

export const TERMINAL: SessionAttachTerminal = {
	protocolVersion: 1,
	projectDir: "/fixture/project",
	name: "mind-a",
	id: "generation-a",
};

export interface OwnerOptions {
	terminal?: SessionAttachTerminal;
	reportedSessionId?: string;
}

export function metadataFor(sessionId: string, terminal?: SessionAttachTerminal): Record<string, unknown> {
	return {
		pid: process.pid,
		sessionId,
		sessionFile: null,
		cwd: "/fixture/project",
		agent: "fixture/model",
		startedAt: Date.now(),
		...(terminal === undefined ? {} : { terminal }),
	};
}

export function sessionIdFor(): string {
	return `session-${Snowflake.next()}`;
}

export class AttachFixture {
	readonly temp = TempDir.createSync("@omp-session-attach-");
	readonly runDir: string;
	readonly sessionsDir: string;
	readonly #sockets: RpcSessionSocket[] = [];
	readonly #servers: IpcServer[] = [];

	constructor() {
		this.runDir = path.join(this.temp.path(), "run");
		this.sessionsDir = path.join(this.temp.path(), "sessions");
		fs.mkdirSync(this.runDir, { mode: 0o700 });
		fs.mkdirSync(this.sessionsDir, { mode: 0o700 });
	}

	async startOwner(sessionId: string, options: OwnerOptions = {}): Promise<RpcSessionSocket> {
		const socket = new RpcSessionSocket({
			endpointDir: this.runDir,
			identity: () => ({
				sessionId,
				sessionFile: this.sessionFile(sessionId),
				cwd: "/fixture/project",
				agent: "fixture/model",
			}),
			subscribe: () => () => {},
			terminal: () => options.terminal,
		});
		await socket.listen(conn => ({
			dispatch(frame) {
				const record = frame as Record<string, unknown>;
				if (record.type !== "get_state") return;
				conn.send({
					type: "response",
					id: record.id,
					command: "get_state",
					success: true,
					data: { sessionId: options.reportedSessionId ?? sessionId, isStreaming: false },
				});
			},
		}));
		this.#sockets.push(socket);
		return socket;
	}

	async startSilentEndpoint(sessionId: string): Promise<IpcServer> {
		const server = await IpcServer.listen(ipcEndpoint(this.runDir, sessionId), { framing: "lines" }, () => {});
		this.#servers.push(server);
		return server;
	}

	endpointFor(sessionId: string): string {
		return ipcEndpoint(this.runDir, sessionId);
	}

	sidecarFor(sessionId: string): string {
		return path.join(this.runDir, `${sessionId}.json`);
	}

	writeSidecar(sessionId: string, value: unknown): string {
		const file = this.sidecarFor(sessionId);
		fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
		return file;
	}

	writeSession(sessionId: string): string {
		const file = this.sessionFile(sessionId);
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { mode: 0o600 });
		return file;
	}

	sessionFile(sessionId: string): string {
		return path.join(this.sessionsDir, `${sessionId}.jsonl`);
	}

	snapshot(): Record<string, string> {
		const root = this.temp.path();
		const entries: Record<string, string> = {};
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				const relative = path.relative(root, full);
				if (entry.isDirectory()) {
					entries[`${relative}/`] = "";
					walk(full);
					continue;
				}
				const stat = fs.lstatSync(full);
				entries[relative] = stat.isFile() ? fs.readFileSync(full, "utf8") : `node:${stat.size}`;
			}
		};
		walk(root);
		return entries;
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets.splice(0)) {
			try {
				await socket.close();
			} catch {}
		}
		for (const server of this.#servers.splice(0)) {
			try {
				await server.close();
			} catch {}
		}
		await this.temp.remove();
	}
}

export { ipcEndpoint };
