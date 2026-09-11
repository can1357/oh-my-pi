import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	createDaemonBrokerClient,
	createLiveSessionHost,
	DaemonBrokerCapabilityError,
	INCOMPATIBLE_BROKER_RETRY_INITIAL_MS,
	INCOMPATIBLE_BROKER_RETRY_MAX_MS,
	type DaemonBrokerClient,
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

const LIVE_SESSION_RETRY_MS = 250;

interface AttachSession {
	readonly isDisposed: boolean;
	readonly sessionManager: {
		getCwd(): string;
		getSessionId(): string;
		getSessionName(): string | undefined;
		onCwdChanged(callback: () => void): () => void;
		onSessionNameChanged(callback: () => void): () => void;
	};
	queueNonInterruptingUserMessage(content: string, expectedSessionId: string, expectedCwd: string): Promise<void>;
	registerSessionChangeCallback(callback: () => void): () => void;
	waitForSessionTransition(): Promise<void>;
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
		throw new DaemonBrokerCapabilityError(
			"The running daemon broker must restart before live session attachment is available",
		);
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

/** Register through an injectable broker host for the distribution smoke probe. */
export async function startLiveSessionRegistrationWithHost(
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
	let retryNotBefore = 0;
	let incompatibleBrokerRetryMs = INCOMPATIBLE_BROKER_RETRY_INITIAL_MS;

	const registration = (sessionId: string, cwd: string): LiveSessionRegistration => ({
		version: LIVE_SESSION_PROTOCOL_VERSION,
		endpointId,
		sessionId,
		title: session.sessionManager.getSessionName(),
		startedAt,
		cwd,
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
		await session.queueNonInterruptingUserMessage(message, identity.sessionId, identity.cwd);
	};
	const publish = async (): Promise<void> => {
		if (closed || session.isDisposed) return;
		await session.waitForSessionTransition();
		if (closed || session.isDisposed) return;
		const generation = identityGeneration;
		const cwd = path.resolve(session.sessionManager.getCwd());
		const sessionId = session.sessionManager.getSessionId();
		const projectDir = await canonicalAttachProjectDir(cwd);
		const identity: PublishedSessionIdentity = { generation, cwd, projectDir, sessionId };
		if (!identityIsCurrent(identity)) return;
		const nextRegistration = registration(identity.sessionId, identity.cwd);
		if (active?.projectDir === identity.projectDir) {
			const currentHost = active.host;
			try {
				await currentHost.update(nextRegistration);
			} catch (error) {
				active = undefined;
				publishedIdentity = undefined;
				await currentHost.close().catch(() => undefined);
				throw error;
			}
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
	const scheduleRetry = (delayMs: number): void => {
		if (closed || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			schedulePublish();
		}, delayMs);
		retryTimer.unref();
	};
	const schedulePublish = (): void => {
		if (closed || updateQueued || retryTimer) return;
		updateQueued = true;
		updateInFlight = updateInFlight
			.then(async () => {
				updateQueued = false;
				const retryDelayMs = retryNotBefore - Date.now();
				if (retryDelayMs > 0) {
					scheduleRetry(retryDelayMs);
					return;
				}
				await publish();
				retryNotBefore = 0;
				incompatibleBrokerRetryMs = INCOMPATIBLE_BROKER_RETRY_INITIAL_MS;
			})
			.catch(error => {
				logger.warn("Live session registration update failed", { error: String(error) });
				if (closed) return;
				// Incompatible-broker retries are spaced out (not tight-looped) for
				// two reasons: the host asked the old broker for an atomic conditional
				// shutdown so the next attempt can spawn an upgraded replacement
				// (refused while it supervises live daemons, which shutdown would
				// terminate; pre-upgrade brokers without the conditional shutdown are
				// left alone), and every authenticated connection clears the old
				// broker's idle timer — a tight loop would keep it alive forever.
				const incompatibleBroker = error instanceof DaemonBrokerCapabilityError;
				const retryDelayMs = incompatibleBroker ? incompatibleBrokerRetryMs : LIVE_SESSION_RETRY_MS;
				incompatibleBrokerRetryMs = incompatibleBroker
					? Math.min(incompatibleBrokerRetryMs * 2, INCOMPATIBLE_BROKER_RETRY_MAX_MS)
					: INCOMPATIBLE_BROKER_RETRY_INITIAL_MS;
				retryNotBefore = Date.now() + retryDelayMs;
				scheduleRetry(retryDelayMs);
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
