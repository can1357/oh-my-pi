import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	probeSessionAttach,
	resolveSessionEndpointDir,
	SESSION_RUN_DIR_ENV,
	sessionAttachEndpoint,
} from "../../src/launch/session-attach";
import { gateSessionTarget, type ResolvedSessionTarget } from "../../src/launch/session-attach-gate";
import type { RpcClientConn } from "../../src/modes/rpc/client-connection";
import {
	createAgentSessionSocket,
	type RpcSessionSocket,
	type RpcSessionSocketSurface,
} from "../../src/modes/rpc/rpc-socket";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { AttachFixture, sessionIdFor, TERMINAL } from "./session-attach-fixture";

const RUN_DIR_ENV = SESSION_RUN_DIR_ENV;
const BASE_RUN_DIR = path.join(getBaseConfigRoot(), "run");
const ORIGINAL_RUN_DIR = process.env[RUN_DIR_ENV];

let temp: TempDir | undefined;
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let socket: RpcSessionSocket | undefined;
let fixture: AttachFixture | undefined;

afterEach(async () => {
	await socket?.close();
	socket = undefined;
	await fixture?.close();
	fixture = undefined;
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	await temp?.remove();
	temp = undefined;
	if (ORIGINAL_RUN_DIR === undefined) delete process.env[RUN_DIR_ENV];
	else process.env[RUN_DIR_ENV] = ORIGINAL_RUN_DIR;
});

function createSession(dir: string): AgentSession {
	const mock = createMockModel({ responses: [] });
	authStorage = createInMemoryAuthStorage();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const created = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(dir),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
		toolRegistry: new Map(),
	});
	created.subscribe(() => {});
	session = created;
	return created;
}

function answeringSurface(sessionId: string): (conn: RpcClientConn) => RpcSessionSocketSurface {
	return conn => ({
		dispatch(frame: object): void {
			const record = frame as Record<string, unknown>;
			if (record.type !== "get_state") return;
			conn.send({
				type: "response",
				id: record.id,
				command: "get_state",
				success: true,
				data: { sessionId, isStreaming: false },
			});
		},
	});
}

function targetFor(sessionId: string, sessionPath: string): ResolvedSessionTarget {
	const timestamp = new Date(0);
	return {
		session: {
			path: sessionPath,
			id: sessionId,
			cwd: "/fixture/project",
			created: timestamp,
			modified: timestamp,
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

describe("session run directory resolution", () => {
	it("publishes an agent session socket under OMP_RUN_DIR", async () => {
		temp = TempDir.createSync("@omp-run-dir-");
		const runDir = path.join(temp.path(), "run");
		process.env[RUN_DIR_ENV] = `  ${runDir}  `;
		const created = createSession(temp.path());

		socket = createAgentSessionSocket(created);
		await socket.listen(answeringSurface(created.sessionId));

		expect(socket.endpoint).toBe(ipcEndpoint(runDir, created.sessionId));
		expect(socket.sidecarPath).toBe(path.join(runDir, `${created.sessionId}.json`));
		expect(fs.existsSync(ipcEndpoint(runDir, created.sessionId))).toBe(true);
		expect(fs.existsSync(path.join(runDir, `${created.sessionId}.json`))).toBe(true);
		expect(fs.existsSync(path.join(BASE_RUN_DIR, `${created.sessionId}.json`))).toBe(false);
		expect(sessionAttachEndpoint(created.sessionId)).toBe(ipcEndpoint(runDir, created.sessionId));
		expect(await probeSessionAttach(created.sessionId)).toEqual({ status: "live", sessionId: created.sessionId });
	});

	it("probes a live session published in OMP_RUN_DIR", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL });
		process.env[RUN_DIR_ENV] = fixture.runDir;

		expect(await probeSessionAttach(sessionId)).toEqual({ status: "live", sessionId, terminal: TERMINAL });
	});

	it("attaches a gate target that is live in OMP_RUN_DIR", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		const sessionPath = fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL });
		process.env[RUN_DIR_ENV] = fixture.runDir;

		const gate = await gateSessionTarget(targetFor(sessionId, sessionPath), { cwd: "/fixture/project" });
		try {
			expect(gate.kind).toBe("attach");
			if (gate.kind !== "attach") throw new Error("expected attach");
			expect(gate.terminal).toEqual(TERMINAL);
		} finally {
			if (gate.kind === "cold") gate.reservation.release();
		}
	});

	it("reports a session published in another run directory as absent", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL });
		process.env[RUN_DIR_ENV] = path.join(fixture.temp.path(), "other-run");

		expect((await probeSessionAttach(sessionId)).status).toBe("absent");
	});

	it("prefers an explicit endpoint directory over OMP_RUN_DIR", async () => {
		fixture = new AttachFixture();
		const sessionId = sessionIdFor();
		fixture.writeSession(sessionId);
		await fixture.startOwner(sessionId, { terminal: TERMINAL });
		process.env[RUN_DIR_ENV] = path.join(fixture.temp.path(), "other-run");

		expect(sessionAttachEndpoint(sessionId, fixture.runDir)).toBe(ipcEndpoint(fixture.runDir, sessionId));
		expect(await probeSessionAttach(sessionId, { endpointDir: fixture.runDir, timeoutMs: 4_000 })).toEqual({
			status: "live",
			sessionId,
			terminal: TERMINAL,
		});
	});

	it("falls back to the profile-independent run directory when OMP_RUN_DIR is unset or blank", () => {
		delete process.env[RUN_DIR_ENV];
		expect(sessionAttachEndpoint("session-fallback")).toBe(ipcEndpoint(BASE_RUN_DIR, "session-fallback"));

		process.env[RUN_DIR_ENV] = "   ";
		expect(sessionAttachEndpoint("session-fallback")).toBe(ipcEndpoint(BASE_RUN_DIR, "session-fallback"));
	});
});

describe("resolveSessionEndpointDir", () => {
	it("shares the OMP_RUN_DIR variable name with RPC clients", () => {
		expect(SESSION_RUN_DIR_ENV).toBe("OMP_RUN_DIR");
	});

	it("trims the configured run directory", () => {
		process.env[RUN_DIR_ENV] = "  /fixture/run  ";
		expect(resolveSessionEndpointDir()).toBe("/fixture/run");
	});

	it("falls back to the profile-independent run directory for a blank configuration", () => {
		for (const value of [undefined, "", "   "]) {
			if (value === undefined) delete process.env[RUN_DIR_ENV];
			else process.env[RUN_DIR_ENV] = value;
			expect(resolveSessionEndpointDir()).toBe(BASE_RUN_DIR);
		}
	});

	it("keeps an explicit endpoint directory over the configured run directory", () => {
		process.env[RUN_DIR_ENV] = "/fixture/configured";
		expect(resolveSessionEndpointDir("/fixture/explicit")).toBe("/fixture/explicit");
	});
});
