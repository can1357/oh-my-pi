import { logger } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, createLiveSessionHost, type LiveSessionHost } from "../launch/client";
import { canonicalProjectDir } from "../launch/paths";
import { LIVE_SESSION_PROTOCOL_VERSION, type LiveSessionInfo, type LiveSessionRegistration } from "../launch/protocol";
import * as git from "../utils/git";

interface AttachSession {
	readonly sessionManager: {
		getCwd(): string;
		getSessionId(): string;
		getSessionName(): string | undefined;
		onCwdChanged(callback: () => void): () => void;
		onSessionNameChanged(callback: () => void): () => void;
	};
	sendUserMessage(content: string): Promise<void>;
	registerSessionChangeCallback(callback: () => void): () => void;
}

export interface LiveSessionRegistrationHandle {
	readonly endpointId: string;
	close(): Promise<void>;
}

export interface LiveSessionMessage {
	endpointId: string;
	sessionId: string;
	cwd: string;
	message: string;
}

export interface LiveSessionDelivery {
	endpointId: string;
	sessionId: string;
}

async function canonicalAttachProjectDir(cwd: string): Promise<string> {
	const repositoryRoot = await git.repo.root(cwd);
	return canonicalProjectDir(repositoryRoot ?? cwd);
}

export async function listLiveAttachSessions(cwd: string): Promise<LiveSessionInfo[]> {
	const projectDir = await canonicalAttachProjectDir(cwd);
	const client = await createDaemonBrokerClient(projectDir);
	try {
		const result = await client.request({ op: "session-list" });
		if (result.op !== "session-list") throw new Error(`Unexpected broker response: ${result.op}`);
		return result.sessions;
	} finally {
		client.close();
	}
}

export async function sendLiveSessionMessage(input: LiveSessionMessage): Promise<LiveSessionDelivery> {
	const projectDir = await canonicalAttachProjectDir(input.cwd);
	const client = await createDaemonBrokerClient(projectDir);
	try {
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

export async function startLiveSessionRegistration(session: AttachSession): Promise<LiveSessionRegistrationHandle> {
	const endpointId = crypto.randomUUID();
	const startedAt = new Date().toISOString();
	let active: { projectDir: string; host: LiveSessionHost } | undefined;
	let closed = false;
	let updateQueued = false;
	let updateInFlight = Promise.resolve();

	const registration = (): LiveSessionRegistration => ({
		version: LIVE_SESSION_PROTOCOL_VERSION,
		endpointId,
		sessionId: session.sessionManager.getSessionId(),
		title: session.sessionManager.getSessionName(),
		startedAt,
	});
	const publish = async (): Promise<void> => {
		if (closed) return;
		const cwd = session.sessionManager.getCwd();
		const projectDir = await canonicalAttachProjectDir(cwd);
		if (closed) return;
		if (active?.projectDir === projectDir) {
			await active.host.update(registration());
			return;
		}
		const nextHost = await createLiveSessionHost(projectDir, registration(), message => {
			void session.sendUserMessage(message).catch(error => {
				logger.warn("Live session message failed after delivery", {
					sessionId: session.sessionManager.getSessionId(),
					error: String(error),
				});
			});
		});
		const previousHost = active?.host;
		active = { projectDir, host: nextHost };
		await previousHost?.close();
	};
	const schedulePublish = (): void => {
		if (closed || updateQueued) return;
		updateQueued = true;
		updateInFlight = updateInFlight
			.then(async () => {
				updateQueued = false;
				await publish();
			})
			.catch(error => {
				logger.warn("Live session registration update failed", { error: String(error) });
			});
	};

	await publish();
	const unregisterSessionChange = session.registerSessionChangeCallback(schedulePublish);
	const unregisterCwdChange = session.sessionManager.onCwdChanged(schedulePublish);
	const unregisterSessionNameChange = session.sessionManager.onSessionNameChanged(schedulePublish);

	return {
		endpointId,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			unregisterSessionChange();
			unregisterCwdChange();
			unregisterSessionNameChange();
			await updateInFlight;
			await active?.host.close();
		},
	};
}
