import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createDaemonBrokerClient,
	createLiveSessionHost,
	type DaemonBrokerClient,
	type DaemonBrokerClientOptions,
	type LiveSessionMessageSink,
} from "../launch/client";
import {
	DAEMON_CAPABILITY_LIVE_SESSIONS,
	type LiveSessionInfo,
	type LiveSessionRegistration,
} from "../launch/protocol";
import { startLiveSessionRegistrationWithHost, type LiveSessionRegistrationHandle } from "./live-attach";
import { SessionManager } from "./session-manager";

async function listSmokeSessions(client: DaemonBrokerClient): Promise<LiveSessionInfo[]> {
	const result = await client.request({ op: "session-list" });
	if (result.op !== "session-list") throw new Error(`Unexpected broker response: ${result.op}`);
	return result.sessions;
}

async function waitForSmokeSessions(
	client: DaemonBrokerClient,
	accept: (sessions: LiveSessionInfo[]) => boolean,
	failure: string,
): Promise<LiveSessionInfo[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const sessions = await listSmokeSessions(client);
		if (accept(sessions)) return sessions;
		if (Date.now() >= deadline) throw new Error(failure);
		await Bun.sleep(25);
	}
}

/** Exercise broker startup plus live registration retries, updates, migration, delivery, and cleanup. */
export async function smokeTestDaemonBroker(): Promise<void> {
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const projectA = path.join(smokeRoot, "project-a");
	const projectB = path.join(smokeRoot, "project-b");
	await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true })]);
	const brokerOptions = (projectDir: string): DaemonBrokerClientOptions => ({
		runtimeDir: path.join(smokeRoot, `run-${path.basename(projectDir)}`),
		idleGraceMs: 5_000,
	});
	let clientA: DaemonBrokerClient | undefined;
	let clientB: DaemonBrokerClient | undefined;
	const sessionChanges = new Set<() => void>();
	const cwdChanges = new Set<() => void>();
	const titleChanges = new Set<() => void>();
	const deliveries: Array<{ message: string; sessionId: string }> = [];
	const sessionManager = SessionManager.inMemory(projectA);
	let sessionId = "smoke-session-a";
	let title: string | undefined = "Broker smoke";
	const session = {
		sessionManager: {
			getCwd: () => sessionManager.getCwd(),
			getSessionId: () => sessionId,
			getSessionName: () => title,
			onCwdChanged(callback: () => void) {
				cwdChanges.add(callback);
				const unsubscribe = sessionManager.onCwdChanged(callback);
				return () => {
					cwdChanges.delete(callback);
					unsubscribe();
				};
			},
			onSessionNameChanged(callback: () => void) {
				titleChanges.add(callback);
				return () => {
					titleChanges.delete(callback);
				};
			},
		},
		async queueNonInterruptingUserMessage(message: string, expectedSessionId: string) {
			if (expectedSessionId !== sessionId) throw new Error("smoke delivery targeted a stale session");
			deliveries.push({ message, sessionId: expectedSessionId });
		},
		registerSessionChangeCallback(callback: () => void) {
			sessionChanges.add(callback);
			return () => {
				sessionChanges.delete(callback);
			};
		},
	};
	let registration: LiveSessionRegistrationHandle | undefined;
	let hostAttempts = 0;
	const createSmokeHost = async (
		projectDir: string,
		nextRegistration: LiveSessionRegistration,
		sink: LiveSessionMessageSink,
	) => {
		hostAttempts++;
		if (hostAttempts === 1) throw new Error("intentional initial live registration failure");
		return createLiveSessionHost(projectDir, nextRegistration, sink, brokerOptions(projectDir));
	};
	const notify = (callbacks: Set<() => void>): void => {
		for (const callback of callbacks) callback();
	};
	try {
		clientA = await createDaemonBrokerClient(projectA, brokerOptions(projectA));
		clientB = await createDaemonBrokerClient(projectB, brokerOptions(projectB));
		for (const client of [clientA, clientB]) {
			const ping = await client.request({ op: "ping" });
			if (
				ping.op !== "ping" ||
				ping.projectDir !== client.projectDir ||
				!ping.capabilities?.includes(DAEMON_CAPABILITY_LIVE_SESSIONS)
			) {
				throw new Error("daemon broker ping mismatch");
			}
		}

		registration = await startLiveSessionRegistrationWithHost(session, createSmokeHost);
		await waitForSmokeSessions(
			clientA,
			sessions =>
				sessions.length === 1 &&
				sessions[0]?.endpointId === registration?.endpointId &&
				sessions[0]?.sessionId === sessionId &&
				sessions[0]?.title === title,
			"initial live session registration was not listed after retry",
		);
		if (hostAttempts < 2) throw new Error("initial live session registration did not retry");

		const send = async (client: DaemonBrokerClient, message: string): Promise<void> => {
			const deliveryIndex = deliveries.length;
			const sent = await client.request({
				op: "session-send",
				endpointId: registration?.endpointId ?? "",
				sessionId,
				message,
			});
			const delivered = deliveries[deliveryIndex];
			if (
				sent.op !== "session-send" ||
				sent.endpointId !== registration?.endpointId ||
				sent.sessionId !== sessionId ||
				delivered?.message !== message ||
				delivered.sessionId !== sessionId ||
				deliveries.length !== deliveryIndex + 1
			) {
				throw new Error("live session message was not acknowledged by the target session");
			}
		};
		await send(clientA, "smoke message a");

		title = "Broker smoke renamed";
		notify(titleChanges);
		await waitForSmokeSessions(
			clientA,
			sessions => sessions.length === 1 && sessions[0]?.title === title,
			"live session title update was not listed",
		);

		sessionId = "smoke-session-b";
		notify(sessionChanges);
		await waitForSmokeSessions(
			clientA,
			sessions => sessions.length === 1 && sessions[0]?.sessionId === sessionId,
			"live session identity update was not listed",
		);

		await sessionManager.moveTo(projectB);
		await waitForSmokeSessions(
			clientB,
			sessions =>
				sessions.length === 1 &&
				sessions[0]?.endpointId === registration?.endpointId &&
				sessions[0]?.sessionId === sessionId,
			"live session repository migration was not listed in the new broker",
		);
		await waitForSmokeSessions(
			clientA,
			sessions => sessions.length === 0,
			"live session repository migration remained listed in the old broker",
		);
		await send(clientB, "smoke message b");

		sessionManager.setCwdWithoutRelocation(projectA);
		await sessionManager.moveTo(projectA);
		await waitForSmokeSessions(
			clientA,
			sessions =>
				sessions.length === 1 &&
				sessions[0]?.endpointId === registration?.endpointId &&
				sessions[0]?.sessionId === sessionId,
			"live session rollback was not republished in the original broker",
		);
		await waitForSmokeSessions(
			clientB,
			sessions => sessions.length === 0,
			"live session rollback remained listed in the rejected broker",
		);
		await send(clientA, "smoke message after rollback");

		await registration.close();
		registration = undefined;
		if (sessionChanges.size !== 0 || cwdChanges.size !== 0 || titleChanges.size !== 0) {
			throw new Error("live session registration callbacks remained subscribed after close");
		}
		await waitForSmokeSessions(clientA, sessions => sessions.length === 0, "closed live session remained registered");
	} finally {
		await registration?.close().catch(() => undefined);
		await Promise.all([
			clientA?.request({ op: "shutdown" }).catch(() => undefined),
			clientB?.request({ op: "shutdown" }).catch(() => undefined),
		]);
		clientA?.close();
		clientB?.close();
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}
