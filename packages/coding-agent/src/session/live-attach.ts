import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	createDaemonBrokerClient,
	createLiveSessionHost,
	type DaemonBrokerClient,
	type DaemonBrokerClientOptions,
	type LiveSessionHost,
	type LiveSessionMessageSink,
} from "../launch/client";
import { canonicalProjectDir } from "../launch/paths";
import {
	DAEMON_CAPABILITY_LIVE_SESSIONS,
	LIVE_SESSION_PROTOCOL_VERSION,
	type LiveSessionInfo,
	type LiveSessionRegistration,
} from "../launch/protocol";
import { SessionManager } from "./session-manager";

interface AttachSession {
	readonly sessionManager: {
		getCwd(): string;
		getSessionId(): string;
		getSessionName(): string | undefined;
		onCwdChanged(callback: () => void): () => void;
		onSessionNameChanged(callback: () => void): () => void;
	};
	queueNonInterruptingUserMessage(content: string, expectedSessionId: string): Promise<void>;
	registerSessionChangeCallback(callback: () => void): () => void;
}

/** Owns one process-local broker registration; closing it stops retries and unregisters the session. */
export interface LiveSessionRegistrationHandle {
	readonly endpointId: string;
	close(): Promise<void>;
}

/** Input for an acknowledged message delivery to one exact live session identity. */
export interface LiveSessionMessage {
	endpointId: string;
	sessionId: string;
	cwd: string;
	message: string;
}

/** Identity accepted by the live process after it queued the delivered message. */
export interface LiveSessionDelivery {
	endpointId: string;
	sessionId: string;
}

type LiveSessionHostFactory = (
	projectDir: string,
	registration: LiveSessionRegistration,
	sink: LiveSessionMessageSink,
) => Promise<LiveSessionHost>;

interface PublishedSessionIdentity {
	generation: number;
	cwd: string;
	projectDir: string;
	sessionId: string;
}

async function requireLiveSessionCapability(client: DaemonBrokerClient): Promise<void> {
	const ping = await client.request({ op: "ping" });
	if (ping.op !== "ping" || !ping.capabilities?.includes(DAEMON_CAPABILITY_LIVE_SESSIONS)) {
		throw new Error("The running daemon broker must restart before live session attachment is available");
	}
}

async function canonicalAttachProjectDir(cwd: string): Promise<string> {
	const repositoryRoot = vcs.repo(cwd)?.root();
	return canonicalProjectDir(repositoryRoot ?? cwd);
}

/** List live interactive sessions in the repository scope containing `cwd`. */
export async function listLiveAttachSessions(cwd: string): Promise<LiveSessionInfo[]> {
	const projectDir = await canonicalAttachProjectDir(cwd);
	const client = await createDaemonBrokerClient(projectDir);
	try {
		await requireLiveSessionCapability(client);
		const result = await client.request({ op: "session-list" });
		if (result.op !== "session-list") throw new Error(`Unexpected broker response: ${result.op}`);
		return result.sessions;
	} finally {
		client.close();
	}
}

/** Deliver a noninterrupting message and resolve only after the target process acknowledges queueing it. */
export async function sendLiveSessionMessage(input: LiveSessionMessage): Promise<LiveSessionDelivery> {
	const projectDir = await canonicalAttachProjectDir(input.cwd);
	const client = await createDaemonBrokerClient(projectDir);
	try {
		await requireLiveSessionCapability(client);
		const result = await client.request({
			op: "session-send",
			endpointId: input.endpointId,
			sessionId: input.sessionId,
			message: input.message,
		});
		if (result.op !== "session-send") throw new Error(`Unexpected broker response: ${result.op}`);
		return { endpointId: result.endpointId, sessionId: result.sessionId };
	} finally {
		client.close();
	}
}

async function startLiveSessionRegistrationWithHost(
	session: AttachSession,
	createHost: LiveSessionHostFactory,
): Promise<LiveSessionRegistrationHandle> {
	const endpointId = crypto.randomUUID();
	const startedAt = new Date().toISOString();
	let active: { projectDir: string; host: LiveSessionHost } | undefined;
	let publishedIdentity: PublishedSessionIdentity | undefined;
	let identityGeneration = 0;
	let closed = false;
	let updateQueued = false;
	let retryTimer: NodeJS.Timeout | undefined;
	let updateInFlight = Promise.resolve();

	const registration = (sessionId: string): LiveSessionRegistration => ({
		version: LIVE_SESSION_PROTOCOL_VERSION,
		endpointId,
		sessionId,
		title: session.sessionManager.getSessionName(),
		startedAt,
	});
	const identityIsCurrent = (identity: PublishedSessionIdentity): boolean =>
		!closed &&
		identity.generation === identityGeneration &&
		session.sessionManager.getSessionId() === identity.sessionId &&
		path.resolve(session.sessionManager.getCwd()) === identity.cwd;
	const deliver = async (message: string): Promise<void> => {
		const identity = publishedIdentity;
		if (!identity || !identityIsCurrent(identity)) {
			throw new Error("The OMP process changed sessions or repositories; attach again");
		}
		await session.queueNonInterruptingUserMessage(message, identity.sessionId);
	};
	const publish = async (): Promise<void> => {
		if (closed) return;
		const generation = identityGeneration;
		const cwd = path.resolve(session.sessionManager.getCwd());
		const sessionId = session.sessionManager.getSessionId();
		const projectDir = await canonicalAttachProjectDir(cwd);
		const identity: PublishedSessionIdentity = { generation, cwd, projectDir, sessionId };
		if (!identityIsCurrent(identity)) return;

		const nextRegistration = registration(identity.sessionId);
		if (active?.projectDir === identity.projectDir) {
			await active.host.update(nextRegistration);
		} else {
			const previousHost = active?.host;
			active = undefined;
			publishedIdentity = undefined;
			await previousHost?.close();
			if (!identityIsCurrent(identity)) return;
			const nextHost = await createHost(identity.projectDir, nextRegistration, deliver);
			if (!identityIsCurrent(identity)) {
				await nextHost.close().catch(() => undefined);
				return;
			}
			active = { projectDir: identity.projectDir, host: nextHost };
		}
		if (identityIsCurrent(identity)) publishedIdentity = identity;
	};
	const schedulePublish = (): void => {
		if (closed || updateQueued) return;
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = undefined;
		}
		updateQueued = true;
		updateInFlight = updateInFlight
			.then(async () => {
				updateQueued = false;
				await publish();
			})
			.catch(error => {
				logger.warn("Live session registration update failed", { error: String(error) });
				if (closed || retryTimer) return;
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					schedulePublish();
				}, 250);
				retryTimer.unref();
			});
	};
	const scheduleIdentityPublish = (): void => {
		identityGeneration++;
		publishedIdentity = undefined;
		schedulePublish();
	};

	const unregisterSessionChange = session.registerSessionChangeCallback(scheduleIdentityPublish);
	const unregisterCwdChange = session.sessionManager.onCwdChanged(scheduleIdentityPublish);
	const unregisterSessionNameChange = session.sessionManager.onSessionNameChanged(schedulePublish);
	schedulePublish();

	return {
		endpointId,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			publishedIdentity = undefined;
			unregisterSessionChange();
			clearTimeout(retryTimer);
			retryTimer = undefined;
			unregisterCwdChange();
			unregisterSessionNameChange();
			await updateInFlight;
			await active?.host.close();
		},
	};
}

/** Publish a live session, track its identity/title/CWD, and retry broker registration until closed. */
export function startLiveSessionRegistration(session: AttachSession): Promise<LiveSessionRegistrationHandle> {
	return startLiveSessionRegistrationWithHost(session, createLiveSessionHost);
}

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
	const session: AttachSession = {
		sessionManager: {
			getCwd: () => sessionManager.getCwd(),
			getSessionId: () => sessionId,
			getSessionName: () => title,
			onCwdChanged(callback) {
				cwdChanges.add(callback);
				const unsubscribe = sessionManager.onCwdChanged(callback);
				return () => {
					cwdChanges.delete(callback);
					unsubscribe();
				};
			},
			onSessionNameChanged(callback) {
				titleChanges.add(callback);
				return () => {
					titleChanges.delete(callback);
				};
			},
		},
		async queueNonInterruptingUserMessage(message, expectedSessionId) {
			if (expectedSessionId !== sessionId) throw new Error("smoke delivery targeted a stale session");
			deliveries.push({ message, sessionId: expectedSessionId });
		},
		registerSessionChangeCallback(callback) {
			sessionChanges.add(callback);
			return () => {
				sessionChanges.delete(callback);
			};
		},
	};
	let registration: LiveSessionRegistrationHandle | undefined;
	let hostAttempts = 0;
	const createSmokeHost: LiveSessionHostFactory = async (projectDir, nextRegistration, sink) => {
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
