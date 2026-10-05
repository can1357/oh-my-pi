import { logger } from "@oh-my-pi/pi-utils";
import { refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";
import { claimSessionName } from "../messaging/names";
import { MessagingService, formatSessionListing, type MessagingHost } from "../messaging/service";
import {
	cfgMessagingEnabled,
	cfgMessagingInbound,
	cfgMessagingDialogExpiry,
	cfgMessagingSend,
	cfgMessagingList,
	cfgMessagingRateLimit,
	cfgMessagingRateWindowSeconds,
	cfgMessagingRepeatWindowSeconds,
	cfgMessagingRelayMaxHops,
	cfgMessagingRelayMaxRevisits,
} from "../messaging/settings";
import { cfgToolsApprovalMode } from "../tools/settings";
import type { AgentSession } from "./agent-session";

const unavailableReasons = new WeakMap<AgentSession, string>();
const messagingEnvKeys = ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"] as const;

/** Bind once per top-level mode session, before emitting SessionStart. */
export async function bindSessionMessaging(
	session: AgentSession,
	opts: {
		directPrint: boolean;
		exportProcessEnv: boolean;
		claimNames?: boolean;
		askApproval?: MessagingHost["askApproval"];
	},
): Promise<{ ready(): void; dispose(): Promise<void> }> {
	if (session.isSubagent) return { ready() {}, async dispose() {} };
	let ready = false;
	let disposed = false;
	let service: MessagingService | undefined;
	let stopIdentity: (() => void) | undefined;
	let transition = Promise.resolve();

	const claimIdentity = async () => {
		const current = service;
		if (!current || opts.claimNames === false || opts.directPrint || session.sessionManager.titleSource !== "user")
			return;
		const requested = session.sessionManager.getSessionName();
		if (!requested) return;
		const sessions = await current.listSessions();
		if (current !== service || disposed || session.sessionManager.getSessionName() !== requested) return;
		const taken = new Set(sessions.flatMap(peer => (peer.name === null ? [] : [peer.name])));
		const name = claimSessionName(requested, taken);
		if (name === requested) return;
		await session.sessionManager.setSessionName(name, "user");
		session.emitNotice(
			"info",
			`Another session already uses "${requested}"; this session is now "${name}".`,
			"messaging",
		);
	};

	const stop = async () => {
		stopIdentity?.();
		stopIdentity = undefined;
		const previous = service;
		service = undefined;
		if (!previous) return;
		await previous.close();
		session.setMessaging(undefined);
		if (opts.exportProcessEnv) {
			for (const key of messagingEnvKeys) {
				if (process.env[key] === previous.env[key]) delete process.env[key];
			}
			refreshShellConfigCache();
		}
	};

	const reconcile = async () => {
		if (disposed || !cfgMessagingEnabled.get(session.settings)) {
			await stop();
			return;
		}
		if (service) return;
		const host: MessagingHost = {
			sessionId: () => session.sessionManager.getSessionId(),
			cwd: () => session.sessionManager.getCwd(),
			directPrint: opts.directPrint,
			sessionName: () => session.sessionManager.getSessionName(),
			titleSource: () => session.sessionManager.titleSource,
			isBusy: () => session.isStreaming,
			permissionClass: () => session.permissionClass(),
			onPolicyInputsChange: callback =>
				session.settings.onEffectiveChange(
					[
						cfgToolsApprovalMode,
						cfgMessagingEnabled,
						cfgMessagingInbound,
						cfgMessagingDialogExpiry,
						cfgMessagingSend,
						cfgMessagingList,
						cfgMessagingRateLimit,
						cfgMessagingRateWindowSeconds,
						cfgMessagingRepeatWindowSeconds,
						cfgMessagingRelayMaxHops,
						cfgMessagingRelayMaxRevisits,
					],
					callback,
				),
			deliverRemote: delivery => session.deliverRemoteMessage(delivery),
			pendingRemoteCount: () => session.pendingRemoteCount(),
			showNotice: text => session.emitNotice("info", text, "messaging"),
			deliverNotice: (from, body) =>
				session.deliverRemoteMessage({
					id: crypto.randomUUID(),
					from,
					body,
					chain: [],
					receivedAt: Date.now(),
				}),
			askApproval: opts.askApproval,
			currentRelayChain: () => session.currentRelayChain(),
			lastFinished: () => session.lastFinished(),
		};
		try {
			const started = await MessagingService.start(host, session.settings);
			if (disposed || !cfgMessagingEnabled.get(session.settings)) {
				await started.close();
				return;
			}
			service = started;
			unavailableReasons.delete(session);
			session.setMessaging(started);
			if (opts.exportProcessEnv) {
				Object.assign(process.env, started.env);
				refreshShellConfigCache();
			}
			await session.refreshBaseSystemPrompt();
			const onNameChange = () => {
				void claimIdentity().catch(error =>
					logger.warn("Failed to claim cross-session name", { error: String(error) }),
				);
			};
			const stopSession = session.registerSessionChangeCallback(() => {
				void (async () => {
					await started.retireConversation();
					await claimIdentity();
				})().catch(error => logger.warn("Failed to retire cross-session conversation", { error: String(error) }));
			});
			const stopName = session.sessionManager.onSessionNameChanged(onNameChange);
			stopIdentity = () => {
				stopSession();
				stopName();
			};
			await claimIdentity();
			if (ready) started.markReady();
		} catch (error) {
			await stop();
			const reason = error instanceof Error ? error.message : String(error);
			unavailableReasons.set(session, reason);
			logger.warn("Cross-session messaging unavailable", { reason });
		}
	};
	const schedule = () => {
		transition = transition.then(reconcile);
		return transition;
	};
	const unlisten = cfgMessagingEnabled.listen(session.settings, schedule);
	session.addDisposer?.(() => {
		disposed = true;
		unlisten();
		void stop().catch(error => logger.warn("Failed to close session messaging", { error: String(error) }));
	});
	await schedule();
	return {
		ready() {
			ready = true;
			service?.markReady();
		},
		async dispose() {
			disposed = true;
			unlisten();
			const stopping = stop();
			await transition;
			await stopping;
			await stop();
		},
	};
}

export function peerAddressDisplay(session: AgentSession): string {
	if (session.messaging) return session.messaging.peerAddress;
	if (!cfgMessagingEnabled.get(session.settings)) return "off";
	const reason = unavailableReasons.get(session);
	return reason ? `unavailable — ${reason}` : "off";
}

export function messagingEnvFor(session: { readonly messaging?: MessagingService }): {
	set: Record<string, string>;
	strip: readonly ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"];
} {
	return { set: session.messaging ? { ...session.messaging.env } : {}, strip: messagingEnvKeys };
}

export function ownSessionLine(session: { readonly messaging?: MessagingService }): string | undefined {
	const service = session.messaging;
	return service ? `This session: ${service.ownAddress() ?? "(unnamed)"} [${service.ownShortId()}]` : undefined;
}

export async function renderOtherSessionsSection(
	session: Pick<AgentSession, "settings"> & { readonly messaging?: MessagingService },
	signal?: AbortSignal,
): Promise<string | undefined> {
	const service = session.messaging;
	if (!service || cfgMessagingList.get(session.settings) === "deny") return undefined;
	const listing = formatSessionListing(
		{ name: service.ownAddress(), shortId: service.ownShortId() },
		await service.listSessions(signal),
	);
	return listing.slice(listing.indexOf("## Other sessions"));
}
