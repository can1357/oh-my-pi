/**
 * Live output monitors for supervised services: one session-scoped broker
 * output subscription per service name, delivering bounded progress batches
 * into the owning session under `wake` or `ambient` delivery.
 *
 * A monitor never changes the service's lifecycle. Attach, retune, and detach
 * happen through `bash` service starts (`progress`) and `proc://<name>/progress`
 * writes; see {@link ../launch/services}.
 */
import { formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import type { DaemonMonitorWatcher, DaemonSnapshot, DaemonState } from "@oh-my-pi/pi-tui/tools/daemon";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobProgressDelivery } from "../async";
import { flattenPreviewText, ProgressPreviewAccumulator } from "../session/progress-preview";
import type { ToolSession } from "../tools";
import type { DaemonBrokerClient, DaemonOutputUnregister } from "./client";
import type { DaemonMonitorNotification, DaemonOutputSubscription } from "./protocol";

/** Monitoring needs a live broker connection to the process; detached services have none, so name the alternative. */
export const DETACHED_MONITOR_ERROR =
	"Detached services cannot be live-monitored; relaunch it with bash `name` to monitor it, or read its output with `read proc://<name>`";

export type LocalStopResponse = "failed" | "non-terminal" | "terminal";

type LocalStopLifecycle =
	| { state: "idle" }
	| {
			state: "response-pending";
			response: Promise<LocalStopResponse>;
			settle: (response: LocalStopResponse) => void;
	  }
	| { state: "terminal-response" };

interface OutputRegistration {
	id: string;
	name: string;
	owner: string;
	delivery: AsyncJobProgressDelivery;
	epoch: number;
	startedAt: number;
	/** Daemon incarnation this monitor accepted; never rebound by process name. */
	daemonId?: string;
	/** Whether the broker must defer binding until a new start replaces the current record. */
	binding: "start-pending" | "attached";
	active: boolean;
	/** Terminal daemon state observed while an attach was still being published. */
	terminalState?: DaemonState;
	/** Readiness of the initial broker publication for this registration. */
	ready: Promise<void>;
	/**
	 * A terminal local stop response is the authoritative completion surface.
	 * Notifications racing a pending response wait to learn whether they still
	 * need to synthesize completion.
	 */
	localStop: LocalStopLifecycle;
	artifactId?: string;
	cleanup: () => Promise<void>;
	/** Switch the delivery mode in place and re-advertise it so `ps`/`describe` watcher rows stay accurate. */
	retune: (delivery: AsyncJobProgressDelivery) => void;
	acquirePendingStart?: (delivery: AsyncJobProgressDelivery) => OutputLease;
}

const outputRegistrations = new WeakMap<ToolSession, Map<DaemonBrokerClient, Map<string, OutputRegistration>>>();
const outputRegistrationGenerations = new WeakMap<ToolSession, Map<DaemonBrokerClient, Map<string, string>>>();

function claimOutputRegistrationGeneration(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
	id: string,
): void {
	let clients = outputRegistrationGenerations.get(session);
	if (!clients) {
		clients = new Map();
		outputRegistrationGenerations.set(session, clients);
	}
	let monitors = clients.get(client);
	if (!monitors) {
		monitors = new Map();
		clients.set(client, monitors);
	}
	monitors.set(name, id);
}

type OutputRegistrationOperationOutcome = "accepted" | "rejected";

interface OutputRegistrationOperation {
	previous?: OutputRegistrationOperation;
	phase: "allocating" | "installed" | OutputRegistrationOperationOutcome;
	settled: Promise<OutputRegistrationOperationOutcome>;
	markInstalled(): void;
	accept(): void;
	reject(): void;
}

const outputRegistrationOperations = new WeakMap<
	ToolSession,
	Map<DaemonBrokerClient, Map<string, OutputRegistrationOperation>>
>();

function createOutputRegistrationOperation(previous?: OutputRegistrationOperation): OutputRegistrationOperation {
	const { promise, resolve } = Promise.withResolvers<OutputRegistrationOperationOutcome>();
	let settled = false;
	const settle = (outcome: OutputRegistrationOperationOutcome): void => {
		if (settled) return;
		settled = true;
		resolve(outcome);
	};
	return {
		previous,
		phase: "allocating",
		settled: promise,
		markInstalled() {
			if (this.phase === "allocating") this.phase = "installed";
		},
		accept() {
			if (settled) return;
			this.phase = "accepted";
			this.previous = undefined;
			settle("accepted");
		},
		reject() {
			if (settled) return;
			this.phase = "rejected";
			settle("rejected");
		},
	};
}

function claimOutputRegistrationOperation(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
): OutputRegistrationOperation {
	let clients = outputRegistrationOperations.get(session);
	if (!clients) {
		clients = new Map();
		outputRegistrationOperations.set(session, clients);
	}
	let monitors = clients.get(client);
	if (!monitors) {
		monitors = new Map();
		clients.set(client, monitors);
	}
	const operation = createOutputRegistrationOperation(monitors.get(name));
	monitors.set(name, operation);
	return operation;
}

function rejectOutputRegistrationOperation(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
	operation: OutputRegistrationOperation,
): void {
	const monitors = outputRegistrationOperations.get(session)?.get(client);
	if (monitors?.get(name) === operation) {
		if (operation.previous) {
			monitors.set(name, operation.previous);
		} else {
			monitors.delete(name);
		}
	}
	operation.reject();
}

async function canInstallOutputRegistrationOperation(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
	operation: OutputRegistrationOperation,
): Promise<boolean> {
	let current = outputRegistrationOperations.get(session)?.get(client)?.get(name);
	while (current !== operation) {
		if (!current) return false;
		if (current.phase === "allocating") {
			current = current.previous;
			continue;
		}
		const outcome = await current.settled;
		if (outcome === "accepted") return false;
		current = current.previous;
	}
	return true;
}

export interface OutputLease {
	registration: OutputRegistration;
	bindDaemon(daemonId: string): void;
	retain(): Promise<void>;
	reject(): Promise<void>;
}

interface SpeculativeMonitorBuffer {
	preview: ProgressPreviewAccumulator;
	latestProgress?: Extract<DaemonMonitorNotification, { event: "daemon-output" }>;
	suppressedEvents: number;
	sourceTruncated: boolean;
	terminal?: Exclude<DaemonMonitorNotification, { event: "daemon-output" }>;
}

function bufferSpeculativeMonitorNotification(
	buffer: SpeculativeMonitorBuffer,
	notification: DaemonMonitorNotification,
): void {
	if (notification.event !== "daemon-output") {
		buffer.terminal = notification;
		return;
	}
	if (notification.batchKind === "artifact-only") return;
	buffer.preview.append(notification.text, notification.truncated);
	buffer.suppressedEvents += notification.suppressedEvents;
	buffer.sourceTruncated ||= notification.truncated === true;
	buffer.latestProgress = {
		...notification,
		text: "",
		suppressedEvents: 0,
		reminder: notification.reminder ?? buffer.latestProgress?.reminder,
		truncated: undefined,
	};
}

function takeSpeculativeMonitorNotifications(buffer: SpeculativeMonitorBuffer): DaemonMonitorNotification[] {
	const notifications: DaemonMonitorNotification[] = [];
	if (buffer.latestProgress) {
		const preview = buffer.preview.take();
		notifications.push({
			...buffer.latestProgress,
			text: preview ? flattenPreviewText(preview) : "",
			suppressedEvents: buffer.suppressedEvents,
			truncated:
				preview?.truncated === true || buffer.sourceTruncated || buffer.suppressedEvents > 0 ? true : undefined,
		});
	}
	if (buffer.terminal) notifications.push(buffer.terminal);
	return notifications;
}

export async function registerOutputSink(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
	owner: string,
	delivery: AsyncJobProgressDelivery,
	startPending: boolean,
	daemonId?: string,
	restoreOf?: OutputRegistration,
): Promise<OutputLease | undefined> {
	if (restoreOf && outputRegistrationGenerations.get(session)?.get(client)?.get(name) !== restoreOf.id)
		return undefined;
	const captureLaunchProgressEpoch = session.captureLaunchProgressEpoch;
	if (
		!captureLaunchProgressEpoch ||
		!session.queueLaunchProgress ||
		!session.queueLaunchCompletion ||
		!client.onOutput
	) {
		return undefined;
	}
	const epoch = captureLaunchProgressEpoch();
	const existing = outputRegistrations.get(session)?.get(client)?.get(name);
	if (existing?.epoch === epoch && existing.binding === "start-pending" && startPending) {
		return existing.acquirePendingStart?.(delivery);
	}
	if (existing?.epoch === epoch && existing.active && !startPending && existing.daemonId === daemonId) {
		// Retune of a live monitor. The operation is still validating, so
		// keep the prior delivery mode until retain(): output arriving
		// during a failed retune must be delivered under the old mode —
		// once queued it cannot be retracted by reject().
		let settled = false;
		return {
			bindDaemon: () => {},
			registration: existing,
			retain: async () => {
				if (settled) return;
				await existing.ready;
				settled = true;
				if (captureLaunchProgressEpoch() !== existing.epoch) {
					await existing.cleanup();
					return;
				}
				if (!existing.active) return;
				existing.retune(delivery);
			},
			reject: async () => {
				settled = true;
			},
		};
	}
	const operation = claimOutputRegistrationOperation(session, client, name);
	const rejectOperation = (): void => {
		rejectOutputRegistrationOperation(session, client, name, operation);
	};
	const bindOperation = (lease: OutputLease | undefined): OutputLease | undefined => {
		if (!lease) {
			rejectOperation();
			return undefined;
		}
		return {
			registration: lease.registration,
			bindDaemon: lease.bindDaemon,
			retain: async () => {
				try {
					await lease.retain();
				} catch (error) {
					rejectOperation();
					throw error;
				}
				operation.accept();
			},
			reject: async () => {
				try {
					await lease.reject();
				} finally {
					rejectOperation();
				}
			},
		};
	};
	let artifact: { id?: string; path?: string } | undefined;
	try {
		artifact = await session.allocateOutputArtifact?.("service-progress");
	} catch (error) {
		rejectOperation();
		throw error;
	}
	if (!artifact?.id || !artifact.path) {
		rejectOperation();
		return undefined;
	}
	if (!(await canInstallOutputRegistrationOperation(session, client, name, operation))) {
		rejectOperation();
		return undefined;
	}
	if (restoreOf && outputRegistrationGenerations.get(session)?.get(client)?.get(name) !== restoreOf.id) {
		rejectOperation();
		return undefined;
	}
	if (captureLaunchProgressEpoch() !== epoch) {
		rejectOperation();
		return undefined;
	}
	const current = outputRegistrations.get(session)?.get(client)?.get(name);
	if (current?.epoch === epoch && current.active && current.binding === "start-pending" && startPending) {
		operation.markInstalled();
		return bindOperation(current.acquirePendingStart?.(delivery));
	}
	const replaceable = current?.active === true ? current : undefined;
	const previous = replaceable
		? {
				owner: replaceable.owner,
				delivery: replaceable.delivery,
				daemonId: replaceable.daemonId,
			}
		: undefined;
	if (replaceable) {
		// A monitored start targets a new process incarnation. Reusing the
		// old registration would keep advertising its subscription id — with
		// the start-pending marker long cleared and the old artifact path —
		// so the broker could replay the previous daemon's terminal
		// notification and tear the monitor down before the new process
		// launches. Replace it with a fresh start-pending subscription. If the
		// start fails, reject() attaches a fresh monitor under the prior mode;
		// this intentionally cannot replay the old registration's pending
		// batches or output from before the restoration boundary. Recheck after
		// artifact allocation because terminal delivery can clean up the old
		// registration while allocation is pending.
		await replaceable.cleanup();
	}
	if (!(await canInstallOutputRegistrationOperation(session, client, name, operation))) {
		rejectOperation();
		return undefined;
	}
	if (captureLaunchProgressEpoch() !== epoch) {
		rejectOperation();
		return undefined;
	}
	// (Re-)link the per-session maps only after the stale registration was
	// replaced above: its cleanup may have unlinked the maps it lived in.
	let clients = outputRegistrations.get(session);
	if (!clients) {
		clients = new Map();
		outputRegistrations.set(session, clients);
	}
	let monitors = clients.get(client);
	if (!monitors) {
		monitors = new Map();
		clients.set(client, monitors);
	}

	const id = crypto.randomUUID();
	const artifactId = artifact.id;
	let unregisterDispose: (() => void) | void;
	let unregisterContextBoundary: (() => void) | void;
	let outputUnregister: DaemonOutputUnregister | undefined;
	let cleanupPromise: Promise<void> | undefined;
	const registration: OutputRegistration = {
		id,
		name,
		owner,
		epoch,
		delivery,
		daemonId,
		binding: startPending ? "start-pending" : "attached",
		startedAt: Date.now(),
		active: true,
		localStop: { state: "idle" },
		ready: Promise.resolve(),
		artifactId,
		cleanup: () => {
			if (cleanupPromise) return cleanupPromise;
			registration.active = false;
			// Fence synchronous re-entry before unregistering broker/session
			// callbacks; every underlying resource must be released at most once.
			cleanupPromise = Promise.resolve();
			session.setLaunchMonitorActive?.(id, registration.delivery, false, registration.epoch);
			outputUnregister?.();
			unregisterDispose?.();
			unregisterContextBoundary?.();
			if (monitors.get(name) === registration) monitors.delete(name);
			if (monitors.size === 0 && clients.get(client) === monitors) clients.delete(client);
			if (clients.size === 0 && outputRegistrations.get(session) === clients) {
				outputRegistrations.delete(session);
			}
			return cleanupPromise;
		},
		retune: next => {
			if (registration.delivery === next) return;
			session.setLaunchMonitorActive?.(id, registration.delivery, false, registration.epoch);
			registration.delivery = next;
			subscription.delivery = next;
			session.setLaunchMonitorActive?.(id, next, true, registration.epoch);
			// Output sampled before the switch belongs to the mode the model
			// just asked for. Only `wake` needs the move: it is the kind an idle
			// flush drains, so ambient entries left behind would arrive on a
			// later turn, behind newer wake output. `daemonId` is unset while a
			// start is pending, and no output can have been queued yet then.
			if (next === "wake" && registration.daemonId) {
				session.promoteLaunchProgress?.(registration.daemonId, registration.epoch);
			}
			outputUnregister?.republish();
		},
	};
	const deliver = async (notification: DaemonMonitorNotification, waitForTerminalCompletion = true): Promise<void> => {
		if (!registration.active || session.isDisposed?.())
			throw new Error("Session disposed before launch output delivery");
		if (notification.event === "daemon-output") {
			if (
				notification.batchKind !== "artifact-only" &&
				(notification.text.length > 0 || notification.suppressedEvents > 0)
			) {
				session.queueLaunchProgress?.(
					notification,
					registration.delivery,
					registration.startedAt,
					registration.epoch,
					registration.artifactId,
				);
			}
			return;
		}
		if (notification.event === "daemon-monitor-expired") {
			await registration.cleanup();
			return;
		}
		const localStop = registration.localStop;
		if (localStop.state === "response-pending") {
			const response = await localStop.response;
			if (!registration.active) return;
			if (response === "terminal") {
				await registration.cleanup();
				return;
			}
		}
		registration.terminalState = notification.daemon.state;
		await registration.cleanup();
		// The owner session receives the real daemon-completed through its
		// completion subscription, so a synthesized one would duplicate it — but
		// only when the broker actually emitted one. A stop issued by another
		// client (or a settlement without a completion subscription) sets
		// ownerNotified=false and this terminal notification is then the only
		// signal the monitoring session will ever get. An absent flag means an
		// older broker: keep the historical suppression.
		if (notification.daemon.owner === owner && notification.ownerNotified !== false) return;
		// Once a local stop RPC reports terminal settlement, its tool result is
		// the single completion surface even when the monitor notification
		// arrives after the response.
		if (registration.localStop.state === "terminal-response") return;
		const completion = session.queueLaunchCompletion?.({
			event: "daemon-completed",
			completionId: `monitor:${id}:${notification.daemon.id}:${notification.daemon.exitedAt ?? Date.now()}`,
			owner,
			daemon: notification.daemon,
		});
		if (waitForTerminalCompletion) {
			await completion;
		} else {
			// Buffered terminal notifications were already accepted by the
			// client sink while the start RPC was pending. Queue the completion
			// after their preceding output, but do not wait for its delivery
			// receipt: that receipt can require the current tool step to finish.
			void completion?.catch(error => {
				logger.warn("Buffered launch monitor completion delivery failed", {
					monitorId: id,
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	};
	// A new subscription may receive broker notifications before its
	// publication or launch operation is confirmed. Retain one bounded
	// head/tail preview plus fixed suppression metadata and the terminal
	// notification. Successful retention flushes progress before terminal;
	// rejection discards both so a failed operation never wakes the session.
	let speculative: SpeculativeMonitorBuffer | undefined = {
		preview: new ProgressPreviewAccumulator(),
		suppressedEvents: 0,
		sourceTruncated: false,
	};
	let speculativeFlush: Promise<void> | undefined;
	const sink = async (notification: DaemonMonitorNotification): Promise<void> => {
		if (speculative) {
			bufferSpeculativeMonitorNotification(speculative, notification);
			return;
		}
		if (speculativeFlush) await speculativeFlush;
		await deliver(notification);
	};
	const subscription: DaemonOutputSubscription = {
		id,
		name,
		owner,
		artifactPath: artifact.path,
		daemonId,
		delivery,
		since: Date.now(),
		artifactId,
	};
	if (startPending) subscription.startPending = true;
	const restorePrevious = async (fence: OutputRegistration = registration): Promise<void> => {
		if (!previous) return;
		// cleanup() removes the failed registration from the live slot. Its
		// generation remains as a fence so a later failure cannot restore over
		// a newer registration, including one installed while artifact
		// allocation is pending.
		const restored = await registerOutputSink(
			session,
			client,
			name,
			previous.owner,
			previous.delivery,
			false,
			previous.daemonId,
			fence,
		);
		await restored?.retain();
	};
	try {
		outputUnregister = client.onOutput(subscription, sink);
	} catch (error) {
		rejectOperation();
		await restorePrevious(replaceable);
		throw error;
	}
	registration.ready = outputUnregister.ready;
	const bindDaemon = (boundDaemonId: string): void => {
		registration.daemonId ??= boundDaemonId;
		subscription.daemonId ??= boundDaemonId;
	};
	const flushSpeculative = async (): Promise<void> => {
		const buffered = speculative;
		speculative = undefined;
		if (!buffered) return;
		const notifications = takeSpeculativeMonitorNotifications(buffered);
		const pendingFlush = (async () => {
			for (const notification of notifications) await deliver(notification, false);
		})().catch(error => {
			logger.warn("Buffered launch monitor delivery failed", {
				monitorId: id,
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		speculativeFlush = pendingFlush;
		await pendingFlush;
		if (speculativeFlush === pendingFlush) speculativeFlush = undefined;
	};
	if (startPending) {
		let pendingLeases = 0;
		let startAccepted = false;
		registration.acquirePendingStart = requestedDelivery => {
			pendingLeases++;
			let settled = false;
			return {
				registration,
				bindDaemon,
				retain: async () => {
					if (settled) return;
					await registration.ready;
					settled = true;
					pendingLeases--;
					if (captureLaunchProgressEpoch() !== registration.epoch) {
						await registration.cleanup();
						return;
					}
					if (!registration.active) return;
					registration.retune(requestedDelivery);
					if (startAccepted) return;
					startAccepted = true;
					registration.binding = "attached";
					subscription.startPending = undefined;
					if (captureLaunchProgressEpoch() !== registration.epoch) {
						await registration.cleanup();
						return;
					}
					await flushSpeculative();
					if (captureLaunchProgressEpoch() !== registration.epoch) {
						await registration.cleanup();
					}
				},
				reject: async () => {
					if (settled) return;
					settled = true;
					pendingLeases--;
					if (startAccepted || pendingLeases > 0 || !registration.active || monitors.get(name) !== registration) {
						return;
					}
					speculative = undefined;
					await registration.cleanup();
					await restorePrevious();
				},
			};
		};
		operation.markInstalled();
		monitors.set(name, registration);
		claimOutputRegistrationGeneration(session, client, name, id);
		session.setLaunchMonitorActive?.(id, delivery, true, registration.epoch);
		unregisterDispose = session.registerDisposeCallback?.(() => void registration.cleanup());
		unregisterContextBoundary = session.registerContextBoundaryCallback?.(() => void registration.cleanup());
		return bindOperation(registration.acquirePendingStart(delivery));
	}
	operation.markInstalled();
	monitors.set(name, registration);
	claimOutputRegistrationGeneration(session, client, name, id);
	session.setLaunchMonitorActive?.(id, delivery, true, registration.epoch);
	unregisterDispose = session.registerDisposeCallback?.(() => void registration.cleanup());
	unregisterContextBoundary = session.registerContextBoundaryCallback?.(() => void registration.cleanup());
	let retained = false;
	const lease: OutputLease = {
		registration,
		bindDaemon,
		retain: async () => {
			if (captureLaunchProgressEpoch() !== registration.epoch) {
				await registration.cleanup();
				return;
			}
			await registration.ready;
			if (captureLaunchProgressEpoch() !== registration.epoch) {
				await registration.cleanup();
				return;
			}
			retained = true;
			await flushSpeculative();
			if (captureLaunchProgressEpoch() !== registration.epoch) {
				await registration.cleanup();
			}
		},
		reject: async () => {
			speculative = undefined;
			if (retained || monitors.get(name) !== registration) return;
			await registration.cleanup();
			await restorePrevious();
		},
	};
	return bindOperation(lease);
}

export async function detachOutputSink(session: ToolSession, client: DaemonBrokerClient, name: string): Promise<boolean> {
	const registration = outputRegistrations.get(session)?.get(client)?.get(name);
	if (!registration) return false;
	await registration.cleanup();
	return true;
}

/**
 * Local stop lifecycle for a monitored service. A monitor notification can race
 * the stop response; its delivery stays pending until the response says whether
 * the stop call itself is already the authoritative terminal surface.
 */
export interface LocalStopHandle {
	settle(response: LocalStopResponse): void;
}

export function beginLocalStop(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
): LocalStopHandle | undefined {
	const registration = outputRegistrations.get(session)?.get(client)?.get(name);
	if (!registration) return undefined;
	const { promise: response, resolve } = Promise.withResolvers<LocalStopResponse>();
	const lifecycle = { state: "response-pending", response, settle: resolve } satisfies LocalStopLifecycle;
	registration.localStop = lifecycle;
	return {
		settle(result) {
			lifecycle.settle(result);
			if (registration.localStop !== lifecycle) return;
			registration.localStop = result === "terminal" ? { state: "terminal-response" } : { state: "idle" };
		},
	};
}

/**
 * One watcher in prose: who (this session vs. a session id), the delivery
 * mode, how long it has been attached, its artifact, and any state that
 * explains silence (disconnected, still waiting for a start, or bound to a
 * previous incarnation of the same name).
 */
export function watcherLabel(
	watcher: DaemonMonitorWatcher,
	daemon: DaemonSnapshot,
	sessionOwner: string | null | undefined,
): string {
	const who = watcher.owner === sessionOwner ? "this session" : watcher.owner;
	const facts = [watcher.delivery ?? "unknown mode"];
	if (watcher.since !== undefined) facts.push(`since ${formatDuration(Math.max(0, Date.now() - watcher.since))} ago`);
	if (watcher.artifactId) facts.push(`artifact://${watcher.artifactId}`);
	if (!watcher.connected) facts.push("disconnected");
	if (watcher.daemonId === undefined) facts.push("awaiting start");
	else if (watcher.daemonId !== daemon.id) facts.push("previous incarnation");
	return `${who} (${facts.join(", ")})`;
}
