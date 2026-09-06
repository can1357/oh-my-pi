/**
 * Hub launch half — supervision of project-scoped long-running processes
 * (dev servers, watchers, debuggers, REPLs) through the shared daemon broker.
 * Hub ops map 1:1 onto broker operations; the hub's `ps` op is the broker's
 * `list`, and `send`/`wait` route here when they carry a process `name`.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJobProgressDelivery } from "../../async";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import {
	type DaemonBrokerClient,
	DaemonBrokerRejectedError,
	type DaemonOutputUnregister,
	daemonClientForProject,
} from "../../launch/client";
import type {
	DaemonMonitorNotification,
	DaemonMonitorWatcher,
	DaemonOperation,
	DaemonOutputSubscription,
	DaemonRpcResult,
	DaemonSnapshot,
	DaemonSpec,
	DaemonState,
} from "../../launch/protocol";
import { DAEMON_OUTPUT_MONITOR_CAPABILITY } from "../../launch/protocol";
import { renderTerminalOutputIsolated } from "../../launch/terminal-output-worker-client";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import { flattenPreviewText, ProgressPreviewAccumulator } from "../../session/progress-preview";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../../tui";
import type { ToolSession } from "..";
import { resolveToCwd } from "../path-utils";
import {
	capPreviewLines,
	createCachedComponent,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	pluralize,
	previewLine,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render-utils";
import { styleTerminalRow } from "../terminal-output";
import { ToolError } from "../tool-errors";

interface CompletionEpochBinding {
	operation: "monitor" | "restart" | "start";
	epoch: number;
	daemonId?: string;
	priorDaemonIds: Set<string>;
	outcome: Promise<"accepted" | "indeterminate" | "rejected">;
	accept(daemonId: string): void;
	preserve(): void;
	reject(): void;
}

interface CompletionRegistration {
	inFlight: number;
	retained: boolean;
	active: boolean;
	fallbackEpoch: number;
	daemonEpochs: Map<string, number>;
	daemonNames: Map<string, string>;
	pendingBindings: Map<string, Set<CompletionEpochBinding>>;
	cleanup: (preservePending?: boolean) => void;
}

interface CompletionLease {
	bindDaemon: (daemonId: string) => void;
	hasDaemon: (daemonId: string) => boolean;
	associateDaemon: (name: string, daemonId: string) => void;
	retain: () => void;
	retainIndeterminate: () => void;
	reject: (preservePending?: boolean) => void;
	hasConcurrentRequest: () => boolean;
}

const completionRegistrations = new WeakMap<
	ToolSession,
	Map<DaemonBrokerClient, Map<string, CompletionRegistration>>
>();

function releaseCompletionDaemonAssociation(
	session: ToolSession,
	client: DaemonBrokerClient,
	owner: string,
	daemonId: string,
	expectedEpoch?: number,
): void {
	const registration = completionRegistrations.get(session)?.get(client)?.get(owner);
	if (!registration || (expectedEpoch !== undefined && registration.daemonEpochs.get(daemonId) !== expectedEpoch)) {
		return;
	}
	registration.daemonEpochs.delete(daemonId);
	registration.daemonNames.delete(daemonId);
}

type LocalStopResponse = "failed" | "non-terminal" | "terminal";

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
	/** The broker disabled this monitor (artifact persistence failed or the process was replaced). */
	expired?: true;
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
	/**
	 * Pending-start lease a failed replacement's restore acquired on behalf of
	 * the still in-flight start that owned the replaced registration. That
	 * start's own lease adopts it, so an accepted start attaches this
	 * registration and a failed start releases it.
	 */
	restoredLease?: OutputLease;
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

interface OutputLease {
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

async function registerOutputSink(
	session: ToolSession,
	client: DaemonBrokerClient,
	name: string,
	owner: string,
	delivery: AsyncJobProgressDelivery,
	startPending: boolean,
	epoch: number,
	daemonId?: string,
	restoreOf?: OutputRegistration,
): Promise<OutputLease | undefined> {
	if (restoreOf && outputRegistrationGenerations.get(session)?.get(client)?.get(name) !== restoreOf.id)
		return undefined;
	const captureLaunchProgressEpoch = session.captureLaunchProgressEpoch;
	if (
		!captureLaunchProgressEpoch ||
		!session.queueLaunchProgress ||
		!session.discardLaunchProgress ||
		!session.queueLaunchCompletion ||
		!client.onOutput
	) {
		return undefined;
	}
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
		artifact = await session.allocateOutputArtifact?.("hub-progress");
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
				epoch: replaceable.epoch,
				daemonId: replaceable.daemonId,
				// A replaced start-pending registration has no incarnation yet;
				// restoring it as attached would bind it to whatever terminal
				// record the name currently describes.
				startPending: replaceable.binding === "start-pending",
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
	let speculativeTerminalReceipt: PromiseWithResolvers<void> | undefined;
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
			const terminalReceipt = speculativeTerminalReceipt;
			speculativeTerminalReceipt = undefined;
			terminalReceipt?.resolve();
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
			registration.expired = true;
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
		// The owner session receives the real daemon-completed through its
		// completion subscription, so a synthesized one would duplicate it — but
		// only when the broker actually emitted one. A stop issued by another
		// client (or a settlement without a completion subscription) sets
		// ownerNotified=false and this terminal notification is then the only
		// signal the monitoring session will ever get. An absent flag means an
		// older broker: keep the historical suppression.
		if (notification.daemon.owner === owner && notification.ownerNotified !== false) {
			await registration.cleanup();
			return;
		}
		// Once a local stop RPC reports terminal settlement, its tool result is
		// the single completion surface even when the monitor notification
		// arrives after the response.
		if (registration.localStop.state === "terminal-response") {
			await registration.cleanup();
			return;
		}
		const completion = session.queueLaunchCompletion?.(
			{
				event: "daemon-completed",
				completionId: `monitor:${id}:${notification.daemon.id}:${notification.daemon.exitedAt ?? "terminal"}`,
				owner,
				daemon: notification.daemon,
			},
			registration.epoch,
		);
		if (!completion) throw new Error("Session cannot accept launch completion delivery");
		const commitTerminalDelivery = async (): Promise<void> => {
			await completion;
			releaseCompletionDaemonAssociation(session, client, owner, notification.daemon.id);
			await registration.cleanup();
		};
		if (waitForTerminalCompletion) {
			await commitTerminalDelivery();
		} else {
			// Buffered terminal notifications reach the client sink while the
			// start RPC is pending. Queue completion after their preceding output,
			// but let the sink's deferred receipt wait for commit: awaiting it here
			// can require the current tool step itself to finish.
			void commitTerminalDelivery().catch(error => {
				const terminalReceipt = speculativeTerminalReceipt;
				speculativeTerminalReceipt = undefined;
				terminalReceipt?.reject(error);
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
			if (notification.event !== "daemon-monitor-completed") return;
			speculativeTerminalReceipt ??= Promise.withResolvers<void>();
			return speculativeTerminalReceipt.promise;
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
			previous.startPending,
			previous.epoch,
			previous.daemonId,
			fence,
		);
		if (!restored) return;
		// Retaining a start-pending lease means "the start was accepted"; a
		// restored pending registration must instead wait for the in-flight
		// start. Park the lease on the restored registration so that start's
		// own lease settles it: retain attaches, reject releases the slot.
		if (previous.startPending) {
			restored.registration.restoredLease = restored;
			return;
		}
		await restored.retain();
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
		// A failed same-name replacement may have restored the start-pending
		// slot under a fresh registration while this start was still in flight.
		// The restore parked its lease there on this start's behalf; take it so
		// the start's outcome settles the restored slot exactly once. The
		// restore may have rebuilt the per-client map, so resolve the live slot
		// instead of the map this registration was created in.
		const adoptRestoredLease = (leaseDaemonId: string | undefined): OutputLease | undefined => {
			const successor = outputRegistrations.get(session)?.get(client)?.get(name);
			if (
				!successor ||
				successor === registration ||
				!successor.active ||
				successor.binding !== "start-pending" ||
				successor.epoch !== registration.epoch
			) {
				return undefined;
			}
			const lease = successor.restoredLease;
			if (!lease) return undefined;
			successor.restoredLease = undefined;
			if (leaseDaemonId !== undefined) lease.bindDaemon(leaseDaemonId);
			return lease;
		};
		registration.acquirePendingStart = requestedDelivery => {
			pendingLeases++;
			let settled = false;
			let leaseDaemonId: string | undefined;
			return {
				registration,
				bindDaemon: boundDaemonId => {
					leaseDaemonId = boundDaemonId;
					bindDaemon(boundDaemonId);
				},
				retain: async () => {
					if (settled) return;
					await registration.ready;
					settled = true;
					pendingLeases--;
					if (captureLaunchProgressEpoch() !== registration.epoch) {
						await registration.cleanup();
						return;
					}
					if (!registration.active) {
						// Hand the accepted start to the restored registration so
						// the replacement's output is not stranded awaiting a start.
						const lease = adoptRestoredLease(leaseDaemonId);
						if (!lease) return;
						startAccepted = true;
						await lease.retain();
						// The restore re-used the replaced registration's mode; the
						// accepted start decides the delivery mode.
						if (lease.registration.active) lease.registration.retune(requestedDelivery);
						return;
					}
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
					if (startAccepted || pendingLeases > 0) return;
					if (!registration.active) {
						// The restored registration exists only for this start; a
						// failed start has nothing to monitor, so release it instead
						// of leaving it active and start-pending forever.
						await adoptRestoredLease(leaseDaemonId)?.reject();
						return;
					}
					if (monitors.get(name) !== registration) return;
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

async function detachOutputSink(session: ToolSession, client: DaemonBrokerClient, name: string): Promise<boolean> {
	const registration = outputRegistrations.get(session)?.get(client)?.get(name);
	if (!registration) return false;
	const cleanup = registration.cleanup();
	session.discardLaunchProgress?.(registration.id, registration.epoch);
	await cleanup;
	return true;
}

function registerCompletionSink(
	session: ToolSession,
	client: DaemonBrokerClient,
	owner: string,
	binding?: {
		name: string;
		epoch: number;
		operation: "monitor" | "restart" | "start";
	},
): CompletionLease | undefined {
	if (!session.queueLaunchCompletion) return undefined;
	let clients = completionRegistrations.get(session);
	if (!clients) {
		clients = new Map();
		completionRegistrations.set(session, clients);
	}
	let owners = clients.get(client);
	if (!owners) {
		owners = new Map();
		clients.set(client, owners);
	}
	let registration = owners.get(owner);
	if (!registration) {
		const fallbackEpoch = binding?.epoch ?? session.captureLaunchProgressEpoch?.() ?? 0;
		const unregister = client.onCompletion(owner, async notification => {
			const activeRegistration = owners.get(owner);
			if (!activeRegistration?.active || session.isDisposed?.()) {
				throw new Error("Session disposed before launch completion delivery");
			}
			let epoch = activeRegistration.daemonEpochs.get(notification.daemon.id);
			const pending = activeRegistration.pendingBindings.get(notification.daemon.name);
			let pendingBinding: CompletionEpochBinding | undefined;
			if (pending) {
				for (const candidate of pending) pendingBinding = candidate;
			}
			if (epoch === undefined) {
				if (pendingBinding) {
					const outcome = await pendingBinding.outcome;
					if (outcome === "accepted" && pendingBinding.daemonId === notification.daemon.id) {
						epoch = pendingBinding.epoch;
					} else if (outcome === "indeterminate") {
						const provenFreshRestart =
							pendingBinding.operation === "restart" &&
							pendingBinding.priorDaemonIds.size > 0 &&
							!pendingBinding.priorDaemonIds.has(notification.daemon.id);
						epoch =
							pendingBinding.operation === "start" || provenFreshRestart
								? pendingBinding.epoch
								: activeRegistration.fallbackEpoch;
						pendingBinding.reject();
					} else {
						// A replay for an older ID must not consume a replacement
						// binding accepted for the fresh daemon incarnation.
						epoch = activeRegistration.fallbackEpoch;
					}
				} else {
					// Replayed completions that predate a local start/monitor binding
					// belong to the completion subscription's original epoch. This
					// value never advances when a same-ID session resets.
					epoch = activeRegistration.fallbackEpoch;
				}
				activeRegistration.daemonEpochs.set(notification.daemon.id, epoch);
				activeRegistration.daemonNames.set(notification.daemon.id, notification.daemon.name);
			} else if (pendingBinding) {
				// A known old daemon may complete while restart waits for its
				// atomic incarnation result. Only an indeterminate request needs
				// explicit retirement; accepted replacement bindings stay intact.
				const outcome = await pendingBinding.outcome;
				if (outcome === "indeterminate") pendingBinding.reject();
			}
			const delivery = session.queueLaunchCompletion?.(notification, epoch);
			if (!delivery) throw new Error("Session cannot accept launch completion delivery");
			try {
				await delivery;
			} finally {
				releaseCompletionDaemonAssociation(session, client, owner, notification.daemon.id, epoch);
			}
		});
		// oxlint-disable-next-line prefer-const -- read by the cleanup closure before assignment
		let unregisterDispose: (() => void) | void;
		// oxlint-disable-next-line prefer-const -- read by the cleanup closure before assignment
		let unregisterContextBoundary: (() => void) | void;
		const cleanup = (preservePending = false): void => {
			if (!registration?.active) return;
			registration.active = false;
			for (const bindings of registration.pendingBindings.values()) {
				for (const pending of bindings) pending.reject();
			}
			registration.pendingBindings.clear();
			registration.daemonEpochs.clear();
			registration.daemonNames.clear();
			unregister({ preservePending });
			unregisterDispose?.();
			unregisterContextBoundary?.();
			owners.delete(owner);
			if (owners.size === 0) clients.delete(client);
			if (clients.size === 0) completionRegistrations.delete(session);
		};
		registration = {
			inFlight: 0,
			retained: false,
			active: true,
			fallbackEpoch,
			daemonEpochs: new Map(),
			daemonNames: new Map(),
			pendingBindings: new Map(),
			cleanup,
		};
		owners.set(owner, registration);
		// Disposal (CLI exit, subagent release) leaves the conversation resumable,
		// so the broker keeps this owner's completions for replay on reconnect.
		unregisterDispose = session.registerDisposeCallback?.(() => cleanup(true));
		// A switch also leaves the outgoing conversation resumable. A same-ID
		// reset or a new session does not: a completion retained there would
		// replay into the emptied conversation on the next Hub call re-registering
		// this owner (reset) or sit unacknowledged and block same-name restarts
		// (new), so those boundaries discard it.
		unregisterContextBoundary = session.registerContextBoundaryCallback?.(boundary => cleanup(boundary === "switch"));
	}
	const activeRegistration = registration;
	activeRegistration.inFlight++;
	let epochBinding: CompletionEpochBinding | undefined;
	if (binding) {
		const { promise: outcome, resolve } = Promise.withResolvers<"accepted" | "indeterminate" | "rejected">();
		let bindingState: "accepted" | "indeterminate" | "pending" | "rejected" = "pending";
		const removeBinding = (): void => {
			const pending = activeRegistration.pendingBindings.get(binding.name);
			pending?.delete(epochBinding!);
			if (pending?.size === 0) activeRegistration.pendingBindings.delete(binding.name);
		};
		const priorDaemonIds = new Set<string>();
		for (const [daemonId, name] of activeRegistration.daemonNames) {
			if (name === binding.name) priorDaemonIds.add(daemonId);
		}
		epochBinding = {
			operation: binding.operation,
			epoch: binding.epoch,
			priorDaemonIds,
			outcome,
			accept(daemonId) {
				if (bindingState === "accepted" || bindingState === "rejected") return;
				const wasPending = bindingState === "pending";
				bindingState = "accepted";
				this.daemonId = daemonId;
				const siblings = activeRegistration.pendingBindings.get(binding.name);
				if (siblings) {
					for (const sibling of siblings) {
						if (sibling !== this) sibling.reject();
					}
				}
				activeRegistration.daemonEpochs.set(daemonId, this.epoch);
				activeRegistration.daemonNames.set(daemonId, binding.name);
				if (wasPending) resolve("accepted");
				queueMicrotask(removeBinding);
			},
			preserve() {
				if (bindingState !== "pending") return;
				bindingState = "indeterminate";
				resolve("indeterminate");
			},
			reject() {
				if (bindingState === "accepted" || bindingState === "rejected") return;
				const wasPending = bindingState === "pending";
				bindingState = "rejected";
				if (wasPending) resolve("rejected");
				queueMicrotask(removeBinding);
			},
		};
		const pending = activeRegistration.pendingBindings.get(binding.name) ?? new Set<CompletionEpochBinding>();
		pending.add(epochBinding);
		activeRegistration.pendingBindings.set(binding.name, pending);
	}
	let settled = false;
	const settle = (retain: boolean, bindingDisposition: "preserve" | "reject", preservePending = false): void => {
		if (settled || !activeRegistration.active) return;
		settled = true;
		if (bindingDisposition === "preserve") epochBinding?.preserve();
		else epochBinding?.reject();
		activeRegistration.inFlight--;
		if (retain) activeRegistration.retained = true;
		if (!activeRegistration.retained && activeRegistration.inFlight === 0) {
			activeRegistration.cleanup(preservePending);
		}
	};
	return {
		bindDaemon: daemonId => epochBinding?.accept(daemonId),
		hasDaemon: daemonId => activeRegistration.daemonEpochs.has(daemonId),
		associateDaemon: (name, daemonId) => {
			if (!activeRegistration.daemonEpochs.has(daemonId)) {
				activeRegistration.daemonEpochs.set(daemonId, activeRegistration.fallbackEpoch);
			}
			activeRegistration.daemonNames.set(daemonId, name);
		},
		retain: () => settle(true, "reject"),
		retainIndeterminate: () => settle(true, "preserve"),
		hasConcurrentRequest: () => activeRegistration.active && activeRegistration.inFlight > 1,
		reject: preservePending => settle(false, "reject", preservePending),
	};
}

/** Broker-facing launch parameters; the hub adapts its `ps` op to `list` before calling in. */
export interface LaunchParams {
	op: "start" | "list" | "logs" | "wait" | "send" | "stop" | "restart" | "describe" | "monitor";
	name?: string;
	application?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	pty?: boolean;
	ready?: { log?: string; port?: number; host?: string; timeout?: number };
	restart?: "no" | "on-failure" | "always";
	persist?: boolean;
	detached?: boolean;
	progress?: AsyncJobProgressDelivery | "off";
	lines?: number;
	head?: boolean;
	grep?: string;
	follow?: boolean;
	cursor?: number;
	for?: "ready" | "exit";
	pattern?: string;
	text?: string;
	enter?: boolean;
	keys?: string[];
	signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";
	timeout?: number;
}

const KEY_INPUT: Record<string, string> = {
	ENTER: "\r",
	TAB: "\t",
	ESCAPE: "\u001b",
	CTRL_C: "\u0003",
	CTRL_D: "\u0004",
	UP: "\u001b[A",
	DOWN: "\u001b[B",
	RIGHT: "\u001b[C",
	LEFT: "\u001b[D",
};

/** Terminal daemon lifecycle states — the process is no longer running. */
const TERMINAL_STATES: Partial<Record<DaemonState, true>> = {
	exited: true,
	failed: true,
};

/** Monitoring needs a live broker connection to the process; detached daemons have none, so name the alternatives. */
const DETACHED_MONITOR_ERROR =
	"Detached processes cannot be live-monitored; start it without detached: true, or read its output with logs (follow: true)";

/** Structured launch state retained for compact TUI rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	cursor?: number;
	timedOut?: boolean;
	/** logs: daemon lifecycle state at read time. */
	state?: DaemonState;
	/** logs: virtual terminal rows for display; model-facing content remains sanitized text. */
	terminalRows?: string[];
	/** wait: output line that satisfied the pattern. */
	matched?: string;
	/** describe: immutable launch spec backing the command/cwd detail lines. */
	spec?: DaemonSpec;
	/** start/monitor: progress delivery mode this call resulted in; "off" when no monitor is live. */
	monitoring?: AsyncJobProgressDelivery | "off";
	/** monitor off: whether an active monitor was actually detached. */
	monitorDetached?: boolean;
	/** start with progress: why the requested monitor is no longer live although the process started. */
	monitorStopped?: string;
	/** list/describe: live output monitors per process, absent when the broker predates watcher reporting. */
	monitors?: DaemonMonitorWatcher[];
}

/** Why a start-requested monitor is no longer live once the start settled; undefined while it is. */
function monitorStopReason(registration: OutputRegistration): string | undefined {
	if (registration.terminalState !== undefined) return `process is ${registration.terminalState}`;
	if (registration.active) return undefined;
	if (registration.expired) {
		return "the broker disabled the monitor (its output artifact could not be persisted or the process was replaced)";
	}
	return "the session context changed before the start settled";
}

function requiredName(params: LaunchParams): string {
	if (!params.name) throw new ToolError(`${params.op} requires name`);
	return params.name;
}

function timeoutMs(value: number | undefined, fallbackSeconds: number): number {
	const seconds = Math.max(0.05, Math.min(3_600, value ?? fallbackSeconds));
	return Math.round(seconds * 1_000);
}

function commandSpec(params: LaunchParams, session: ToolSession): DaemonSpec {
	const name = requiredName(params);
	if (!params.application) throw new ToolError("start requires application");
	const ready = params.ready;
	const detached = params.detached ?? false;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535)) {
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	}
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	if (ready?.log) {
		try {
			new RegExp(ready.log, "u");
		} catch (error) {
			throw new ToolError(`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		name,
		application: params.application,
		args: params.args ?? [],
		env: params.env ?? {},
		cwd: resolveToCwd(params.cwd ?? session.cwd, session.cwd),
		pty: detached ? false : (params.pty ?? true),
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: timeoutMs(ready.timeout, 30),
				}
			: undefined,
		restart: params.restart ?? "no",
		persist: (params.persist ?? false) || detached,
		detached,
	};
}

function sendData(params: LaunchParams): string | undefined {
	let data = params.text ?? "";
	if (params.text && (params.enter ?? true)) data += KEY_INPUT.ENTER;
	for (const rawKey of params.keys ?? []) {
		const key = rawKey.trim().toUpperCase();
		const input = KEY_INPUT[key];
		if (input === undefined) throw new ToolError(`Unsupported launch key ${rawKey}`);
		data += input;
	}
	return data || undefined;
}

function operationFor(params: LaunchParams, session: ToolSession): DaemonOperation {
	switch (params.op) {
		case "start":
			return {
				op: "start",
				spec: commandSpec(params, session),
				owner: session.getSessionId?.() ?? undefined,
			};
		case "list":
			return { op: "list" };
		case "logs":
			return {
				op: "logs",
				name: requiredName(params),
				lines: Math.min(1_000, Math.floor(params.lines ?? 100)),
				head: params.head ?? false,
				grep: params.grep,
				follow: params.follow ?? false,
				cursor: params.cursor,
				renderTerminalRows: true,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "wait":
			return {
				op: "wait",
				name: requiredName(params),
				for: params.for ?? "exit",
				pattern: params.pattern,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "send":
			return {
				op: "send",
				name: requiredName(params),
				data: sendData(params),
				signal: params.signal,
			};
		case "stop":
			return {
				op: "stop",
				name: requiredName(params),
				timeoutMs: timeoutMs(params.timeout, 5),
			};
		case "restart":
			return { op: "restart", name: requiredName(params) };
		case "describe":
		case "monitor":
			return { op: "describe", name: requiredName(params) };
	}
}

function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit} uptime=${formatDuration(
		(daemon.exitedAt ?? Date.now()) - daemon.startedAt,
	)} restarts=${daemon.restartCount}${daemon.detached ? " detached" : daemon.persist ? " persistent" : ""}`;
}

/**
 * Human sentences for the readiness conditions still unmet, e.g.
 * `port 5173 on 127.0.0.1 never accepted connections`. `ready` (from the start
 * params) adds the concrete pattern/port; absent it falls back to generic labels.
 */
function readyPendingSummary(daemon: DaemonSnapshot, ready?: LaunchParams["ready"]): string[] {
	const parts: string[] = [];
	for (const condition of daemon.readyPending ?? []) {
		if (condition === "log") {
			parts.push(ready?.log ? `log pattern /${ready.log}/ never matched` : "the log pattern never matched");
		} else {
			parts.push(
				ready?.port !== undefined
					? `port ${ready.port} on ${ready.host ?? "127.0.0.1"} never accepted connections`
					: "the port never accepted connections",
			);
		}
	}
	return parts;
}

/**
 * One watcher in prose: who (this session vs. a session id), the delivery
 * mode, how long it has been attached, its artifact, and any state that
 * explains silence (disconnected, still waiting for a start, or bound to a
 * previous incarnation of the same name).
 */
function watcherLabel(watcher: DaemonMonitorWatcher, daemon: DaemonSnapshot, sessionOwner: string | undefined): string {
	const who = watcher.owner === sessionOwner ? "this session" : watcher.owner;
	const facts = [watcher.delivery ?? "unknown mode"];
	if (watcher.since !== undefined) facts.push(`since ${formatDuration(Math.max(0, Date.now() - watcher.since))} ago`);
	if (watcher.artifactId) facts.push(`artifact://${watcher.artifactId}`);
	if (!watcher.connected) facts.push("disconnected");
	if (watcher.daemonId === undefined) facts.push("awaiting start");
	else if (watcher.daemonId !== daemon.id) facts.push("previous incarnation");
	return `${who} (${facts.join(", ")})`;
}

function describeWatchers(
	watchers: DaemonMonitorWatcher[] | undefined,
	daemon: DaemonSnapshot,
	sessionOwner: string | undefined,
): string[] {
	if (!watchers) return [];
	if (watchers.length === 0) return ["Watchers: none"];
	return ["Watchers:", ...watchers.map(watcher => `- ${watcherLabel(watcher, daemon, sessionOwner)}`)];
}

function toolContent(
	result: DaemonRpcResult,
	params: LaunchParams,
	detached: boolean | undefined,
	monitorStopped: string | undefined,
	sessionOwner: string | undefined,
): string {
	switch (result.op) {
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
		case "start": {
			const daemon = result.daemon;
			const lines = [`${daemon.state === "failed" ? "Failed to launch" : "Started"} ${daemonLabel(daemon)}`];
			if (daemon.state === "failed" && daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			if (daemon.readyMatch) lines.push(`Ready log matched: ${daemon.readyMatch}`);
			if (result.readyTimedOut) {
				const pending = readyPendingSummary(daemon, params.ready);
				const cause = pending.length > 0 ? `: ${pending.join("; ")}` : "";
				lines.push(
					`NOT ready — readiness timed out after ${params.ready?.timeout ?? 30}s${cause}. The process is still running (state: ${daemon.state}); follow its logs or stop it.`,
				);
			} else if (params.ready && daemon.readyAt === undefined && TERMINAL_STATES[daemon.state]) {
				lines.push("Process exited before readiness was observed.");
			}
			if (monitorStopped) {
				lines.push(
					`Progress monitoring for ${daemon.name} stopped: ${monitorStopped}. Read its output with logs (follow: true).`,
				);
			}
			return lines.join("\n");
		}
		case "list": {
			if (result.daemons.length === 0) return "No daemons.";
			const lines: string[] = [];
			for (const daemon of result.daemons) {
				lines.push(`- ${daemonLabel(daemon)}`);
				const watchers = result.monitors?.filter(watcher => watcher.name === daemon.name) ?? [];
				if (watchers.length === 0) continue;
				lines.push(
					`  watched by: ${watchers.map(watcher => watcherLabel(watcher, daemon, sessionOwner)).join("; ")}`,
				);
			}
			return lines.join("\n");
		}
		case "logs": {
			const text = sanitizeText(result.text);
			return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[${result.name}: ${result.state}; cursor=${result.cursor}${result.timedOut ? "; follow timed out" : ""}]`;
		}
		case "wait": {
			const lines = [daemonLabel(result.daemon)];
			if (result.matched) lines.push(`Matched: ${result.matched}`);
			if (result.timedOut) {
				const pending = readyPendingSummary(result.daemon);
				lines.push(`Wait timed out${pending.length > 0 ? ` (still waiting on: ${pending.join("; ")})` : ""}.`);
			}
			return lines.join("\n");
		}
		case "send":
			return `Sent input to ${daemonLabel(result.daemon)}`;
		case "stop":
			return `Stopped ${daemonLabel(result.daemon)}`;
		case "restart":
			return `Restarted ${daemonLabel(result.daemon)}`;
		case "describe":
			if (params.op === "monitor") {
				if (params.progress !== "off") return `Monitoring ${daemonLabel(result.daemon)}`;
				return `${detached ? "Stopped monitoring" : "No active monitor for"} ${daemonLabel(result.daemon)}`;
			}
			return [
				daemonLabel(result.daemon),
				`Command: ${[result.spec.application, ...result.spec.args].join(" ")}`,
				`Cwd: ${shortenPath(result.spec.cwd)}`,
				`PTY: ${result.spec.pty}; restart=${result.spec.restart}; persist=${result.spec.persist}; detached=${result.spec.detached}`,
				...describeWatchers(result.monitors, result.daemon, sessionOwner),
			].join("\n");
	}
}

/** Resolve display rows while keeping legacy raw replay outside the client process. */
export async function renderLaunchLogTerminalRows(
	result: Extract<DaemonRpcResult, { op: "logs" }>,
	params: Pick<LaunchParams, "head" | "lines">,
): Promise<string[] | undefined> {
	if (result.terminalRows !== undefined) return result.terminalRows;
	if (result.terminalText === undefined) return undefined;
	return renderTerminalOutputIsolated(result.terminalText, {
		head: params.head ?? false,
		maxRows: Math.min(1_000, Math.floor(params.lines ?? 100)),
	});
}

async function toolDetails(
	result: DaemonRpcResult,
	params: LaunchParams,
	detached: boolean | undefined,
	monitorStopped: string | undefined,
): Promise<LaunchToolDetails> {
	switch (result.op) {
		case "start":
			return {
				op: "start",
				daemon: result.daemon,
				timedOut: result.readyTimedOut,
				monitoring: params.progress === undefined ? undefined : monitorStopped ? "off" : params.progress,
				monitorStopped,
			};
		case "list":
			return { op: "list", daemons: result.daemons, monitors: result.monitors };
		case "logs":
			return {
				op: "logs",
				cursor: result.cursor,
				timedOut: result.timedOut,
				state: result.state,
				terminalRows: await renderLaunchLogTerminalRows(result, params).catch(() => undefined),
			};
		case "wait":
			return {
				op: "wait",
				daemon: result.daemon,
				timedOut: result.timedOut,
				matched: result.matched,
			};
		case "send":
			return { op: "send", daemon: result.daemon };
		case "stop":
			return { op: "stop", daemon: result.daemon };
		case "restart":
			return { op: "restart", daemon: result.daemon };
		case "describe":
			return {
				op: params.op === "monitor" ? "monitor" : "describe",
				daemon: result.daemon,
				spec: result.spec,
				monitors: params.op === "monitor" ? undefined : result.monitors,
				monitoring: params.op === "monitor" ? params.progress : undefined,
				monitorDetached: params.op === "monitor" && params.progress === "off" ? detached === true : undefined,
			};
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
	}
}

/** Run one broker operation for the calling session's project. */
export async function executeLaunch(
	session: ToolSession,
	params: LaunchParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<LaunchToolDetails>> {
	if (params.progress !== undefined && params.op !== "start" && params.op !== "monitor") {
		throw new ToolError("progress is only valid with start or monitor");
	}
	if (params.op === "start" && params.progress === "off") throw new ToolError("start progress cannot be off");
	if (params.op === "start" && params.detached && params.progress !== undefined) {
		throw new ToolError(DETACHED_MONITOR_ERROR);
	}
	if (params.op === "monitor" && params.progress === undefined) {
		throw new ToolError("monitor requires progress: wake, ambient, or off");
	}
	const operation = operationFor(params, session);
	const name =
		params.op === "start" || params.op === "monitor" || params.op === "restart" ? requiredName(params) : undefined;
	const owner = session.getSessionId?.() ?? undefined;
	const progressDelivery = params.progress === "wake" || params.progress === "ambient" ? params.progress : undefined;
	if (progressDelivery && session.processProgressMode !== "session") {
		throw new ToolError("Live process progress monitoring is unavailable in this tool session");
	}
	if (params.op === "start" && progressDelivery && !owner) {
		throw new ToolError("Live progress monitoring requires a session owner");
	}
	const launchEpoch = session.captureLaunchProgressEpoch?.() ?? 0;
	const client = await daemonClientForProject(session.cwd);
	let outputLease: OutputLease | undefined;
	let monitorStopped: string | undefined;
	const completionOwner = operation.op === "start" ? operation.owner : undefined;
	const resumedOwner = params.op !== "start" ? (session.getSessionId?.() ?? undefined) : undefined;
	const registeredCompletionOwner = completionOwner ?? resumedOwner;
	const completionBinding =
		name && (params.op === "start" || params.op === "restart" || (params.op === "monitor" && progressDelivery))
			? { name, epoch: launchEpoch, operation: params.op }
			: undefined;
	const completionLease = registeredCompletionOwner
		? registerCompletionSink(session, client, registeredCompletionOwner, completionBinding)
		: undefined;
	const operationDispatch: { state: "local" | "written" } = { state: "local" };
	try {
		if (progressDelivery) {
			const ping = await client.request({ op: "ping" }, signal);
			if (ping.op !== "ping" || !ping.capabilities?.includes(DAEMON_OUTPUT_MONITOR_CAPABILITY)) {
				throw new ToolError("The running daemon broker cannot monitor output; restart it with this omp build");
			}
		}
		// Valid monitored starts advertise their start-pending subscription
		// after all local and broker-capability validation, but before the
		// process-launch request, so early output cannot be lost.
		if (name && owner && progressDelivery && params.op === "start") {
			outputLease = await registerOutputSink(session, client, name, owner, progressDelivery, true, launchEpoch);
			if (!outputLease) throw new ToolError("This session cannot accept process progress delivery");
		}
		// A monitor notification can race a locally issued stop response. Keep
		// its delivery pending until the response says whether the stop call
		// itself is already the authoritative terminal surface.
		const stopRegistration =
			operation.op === "stop" ? outputRegistrations.get(session)?.get(client)?.get(operation.name) : undefined;
		const localStop = stopRegistration
			? (() => {
					const { promise: response, resolve: settle } = Promise.withResolvers<LocalStopResponse>();
					const lifecycle = {
						state: "response-pending",
						response,
						settle,
					} satisfies LocalStopLifecycle;
					stopRegistration.localStop = lifecycle;
					return lifecycle;
				})()
			: undefined;
		let result: DaemonRpcResult;
		try {
			result = await client.request(operation, signal, state => {
				operationDispatch.state = state;
			});
		} catch (error) {
			localStop?.settle("failed");
			if (stopRegistration && stopRegistration.localStop === localStop) {
				stopRegistration.localStop = { state: "idle" };
			}
			throw error;
		}
		if (params.op === "start" && result.op === "start") {
			completionLease?.bindDaemon(result.daemon.id);
		} else if (params.op === "restart" && result.op === "restart") {
			if (result.daemon.owner !== resumedOwner) {
				completionLease?.reject(true);
			} else {
				const incarnation =
					result.incarnation === "unknown" && completionLease?.hasDaemon(result.daemon.id)
						? "continued"
						: result.incarnation;
				if (incarnation === "replaced") completionLease?.bindDaemon(result.daemon.id);
			}
		}
		if (localStop && stopRegistration && result.op === "stop") {
			const response: LocalStopResponse = TERMINAL_STATES[result.daemon.state] ? "terminal" : "non-terminal";
			localStop.settle(response);
			if (stopRegistration.localStop === localStop) {
				stopRegistration.localStop = response === "terminal" ? { state: "terminal-response" } : { state: "idle" };
			}
		}
		if (result.op === "stop" && TERMINAL_STATES[result.daemon.state] && registeredCompletionOwner) {
			releaseCompletionDaemonAssociation(session, client, registeredCompletionOwner, result.daemon.id);
		}
		const detached =
			params.op === "monitor" && params.progress === "off" && name
				? await detachOutputSink(session, client, name)
				: undefined;
		if (progressDelivery && "daemon" in result && result.daemon) {
			if (result.daemon.detached) throw new ToolError(DETACHED_MONITOR_ERROR);
			if (params.op === "monitor" && TERMINAL_STATES[result.daemon.state]) {
				throw new ToolError(`Cannot monitor ${params.name}: process is ${result.daemon.state}`);
			}
			if (!outputLease && name && owner) {
				outputLease = await registerOutputSink(
					session,
					client,
					name,
					owner,
					progressDelivery,
					false,
					launchEpoch,
					result.daemon.id,
				);
			}
			if (!outputLease) throw new ToolError("This session cannot accept process progress delivery");
			outputLease.bindDaemon(result.daemon.id);
			outputLease.registration.startedAt = result.daemon.startedAt;
			if (params.op === "monitor") completionLease?.bindDaemon(result.daemon.id);
			await outputLease.retain();
			// retain() flushes notifications buffered while the RPC was pending; a
			// terminal or expiry notification among them has already torn the
			// registration down. An attach has nothing to monitor, so it fails.
			// A start launched a real process: report success and say that its
			// monitor is gone rather than pretending wake/ambient delivery is live.
			const stopped = monitorStopReason(outputLease.registration);
			if (stopped !== undefined) {
				if (params.op === "monitor") throw new ToolError(`Cannot monitor ${params.name}: ${stopped}`);
				monitorStopped = stopped;
			}
		}
		const sessionOwner = session.getSessionId?.();
		let resumedDaemonFound = false;
		const daemons =
			result.op === "list" ? result.daemons : "daemon" in result && result.daemon ? [result.daemon] : [];
		for (const daemon of daemons) {
			if (!daemon.owner || daemon.owner !== sessionOwner || TERMINAL_STATES[daemon.state]) continue;
			resumedDaemonFound = true;
			if (daemon.owner === resumedOwner) completionLease?.associateDaemon(daemon.name, daemon.id);
			else registerCompletionSink(session, client, daemon.owner)?.retain();
		}
		if (params.op === "list" && resumedOwner && !resumedDaemonFound) completionLease?.reject(true);
		else completionLease?.retain();
		return {
			content: [
				{
					type: "text",
					text: replaceTabs(toolContent(result, params, detached, monitorStopped, sessionOwner ?? undefined)),
				},
			],
			details: await toolDetails(result, params, detached, monitorStopped),
		};
	} catch (error) {
		try {
			await outputLease?.reject();
		} catch (rejectError) {
			logger.warn("Launch monitor lease rollback failed", {
				name,
				error: rejectError instanceof Error ? rejectError.message : String(rejectError),
			});
		}
		if (error instanceof DaemonBrokerRejectedError && completionOwner) {
			if (completionLease?.hasConcurrentRequest()) {
				completionLease.reject();
			} else {
				try {
					const listed = await client.request({ op: "list" }, signal);
					const ownerStillRunning =
						listed.op === "list" &&
						listed.daemons.some(daemon => daemon.owner === owner && !TERMINAL_STATES[daemon.state]);
					if (ownerStillRunning) completionLease?.retain();
					else completionLease?.reject(true);
				} catch {
					completionLease?.retain();
				}
			}
		} else if (
			!(error instanceof DaemonBrokerRejectedError) &&
			operationDispatch.state === "written" &&
			(params.op === "start" || params.op === "restart")
		) {
			completionLease?.retainIndeterminate();
		} else {
			completionLease?.retain();
		}
		throw error;
	}
}

// =============================================================================
// TUI Renderer (launch half)
// =============================================================================

/** Args shape visible to the renderer, possibly mid-stream (every field optional). */
export type LaunchRenderArgs = Partial<Omit<LaunchParams, "op">> & {
	op?: string;
};

function stateColor(state: DaemonState): ThemeColor {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "failed":
			return "error";
		case "exited":
			return "muted";
		default:
			return "warning";
	}
}

/** Compact `state · pid · uptime` fragments for the status-line meta slot. */
function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const meta = [theme.fg(stateColor(daemon.state), daemon.state)];
	if (daemon.readyPending?.length) meta.push(theme.fg("warning", `waiting on ${daemon.readyPending.join("+")}`));
	if (daemon.exitCode !== undefined) {
		meta.push(theme.fg(daemon.exitCode === 0 ? "muted" : "error", `exit ${daemon.exitCode}`));
	} else if (daemon.pid !== undefined) {
		meta.push(`pid ${daemon.pid}`);
	}
	const lifespan = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	meta.push(daemon.exitedAt === undefined ? `up ${lifespan}` : `ran ${lifespan}`);
	if (daemon.restartCount > 0) meta.push(`restarts ${daemon.restartCount}`);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
}

/** Indented `↳ owner · mode · age · state` row under a process line; owner ids are sanitized like any display text. */
function watcherRow(watcher: DaemonMonitorWatcher, daemon: DaemonSnapshot, theme: Theme): string {
	const owner = truncateToWidth(replaceTabs(sanitizeText(watcher.owner)), TRUNCATE_LENGTHS.TITLE);
	const facts = [theme.fg("accent", watcher.delivery ?? "unknown mode")];
	if (watcher.since !== undefined) facts.push(`${formatDuration(Math.max(0, Date.now() - watcher.since))} ago`);
	if (!watcher.connected) facts.push(theme.fg("warning", "disconnected"));
	if (watcher.daemonId === undefined) facts.push(theme.fg("muted", "awaiting start"));
	else if (watcher.daemonId !== daemon.id) facts.push(theme.fg("warning", "previous incarnation"));
	return `  ${theme.fg("dim", "↳ watched by")} ${owner} ${theme.fg("dim", facts.join(theme.sep.dot))}`;
}

/** Op-specific call context (command line, log filters, wait condition, send payload). */
function callMeta(args: LaunchRenderArgs): string[] {
	const meta: string[] = [];
	switch (args.op) {
		case "start":
			if (args.application) meta.push([args.application, ...(args.args ?? [])].join(" "));
			break;
		case "logs":
			if (args.follow) meta.push("follow");
			if (args.grep) meta.push(`grep /${args.grep}/`);
			break;
		case "wait":
			meta.push(args.pattern ? `for /${args.pattern}/` : `for ${args.for ?? "exit"}`);
			break;
		case "send":
			if (args.signal) meta.push(args.signal);
			else if (args.text) meta.push(args.text);
			if (args.keys?.length) meta.push(args.keys.join(" "));
			break;
	}
	return meta.map(entry => previewLine(replaceTabs(entry), TRUNCATE_LENGTHS.SHORT));
}

/** Pending-call frame for launch ops; consumes the spinner while the broker call is live. */
export function launchRenderCall(args: LaunchRenderArgs, options: RenderResultOptions, theme: Theme): Component {
	const target = args.name ?? args.application;
	const header = renderStatusLine(
		{
			icon: options.spinnerFrame !== undefined ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: `Launch ${args.op ?? "…"}`,
			description: target ? replaceTabs(target) : undefined,
			meta: callMeta(args),
		},
		theme,
	);
	return new Text(header, 0, 0);
}

/** Result frame: one status header per op, meta from structured details, capped body lines. */
export function launchRenderResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: LaunchToolDetails;
		isError?: boolean;
	},
	options: RenderResultOptions,
	theme: Theme,
	args?: LaunchRenderArgs,
): Component {
	const details = result.details;
	const params = args ?? {};
	const op = details?.op ?? params.op;
	const isError = result.isError === true;
	const daemon = details?.daemon;
	const failed = isError || daemon?.state === "failed";
	const text =
		result.content
			?.filter(item => item.type === "text")
			.map(item => item.text ?? "")
			.join("\n") ?? "";

	const meta: string[] = [];
	const body: string[] = [];
	let description = params.name ?? daemon?.name;

	if (isError) {
		for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("error", line));
	} else {
		switch (op) {
			case "start": {
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (details?.monitoring === "off") meta.push(theme.fg("warning", "monitor stopped"));
				else if (details?.monitoring) meta.push(theme.fg("accent", `monitor ${details.monitoring}`));
				if (daemon?.readyMatch) body.push(theme.fg("dim", `log matched: ${replaceTabs(daemon.readyMatch)}`));
				if (daemon?.state === "failed" && daemon.exitReason)
					body.push(theme.fg("error", replaceTabs(daemon.exitReason)));
				if (details?.timedOut) {
					const pending = daemon ? readyPendingSummary(daemon, params.ready) : [];
					body.push(
						theme.fg(
							"warning",
							pending.length > 0
								? `Not ready — ${pending.join("; ")}. Still running.`
								: "Readiness timed out; the process is still running.",
						),
					);
				} else if (params.ready && daemon && daemon.readyAt === undefined && TERMINAL_STATES[daemon.state]) {
					body.push(theme.fg("warning", "Process exited before readiness was observed."));
				}
				if (details?.monitorStopped) {
					body.push(theme.fg("warning", `Progress monitoring stopped: ${replaceTabs(details.monitorStopped)}.`));
				}
				break;
			}
			case "send":
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "stop":
			case "restart":
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "wait": {
				meta.push(...callMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (details?.matched) body.push(theme.fg("dim", `matched: ${replaceTabs(details.matched)}`));
				if (details?.timedOut) {
					const pending = daemon ? readyPendingSummary(daemon) : [];
					body.push(
						theme.fg(
							"warning",
							pending.length > 0
								? `Wait timed out — still waiting on ${pending.join("; ")}.`
								: "Wait timed out.",
						),
					);
				}
				break;
			}
			case "list": {
				const daemons = details?.daemons ?? [];
				description = `${daemons.length || "no"} ${pluralize("process", daemons.length)}`;
				for (const item of daemons) {
					body.push(
						`${theme.fg("accent", replaceTabs(item.name))} ${theme.fg("dim", daemonMeta(item, theme).join(theme.sep.dot))}`,
					);
					for (const watcher of details?.monitors ?? []) {
						if (watcher.name === item.name) body.push(watcherRow(watcher, item, theme));
					}
				}
				break;
			}
			case "logs": {
				if (details?.state) meta.push(theme.fg(stateColor(details.state), details.state));
				if (details?.cursor !== undefined) meta.push(`cursor ${details.cursor}`);
				if (details?.timedOut) meta.push(theme.fg("warning", "follow timed out"));
				// Strip the trailing `[name: state; cursor=N]` status suffix `toolContent` appends.
				const logText = text.replace(/\n?\[[^\n]*\]$/, "").trimEnd();
				const terminalRows = details?.terminalRows;
				if (terminalRows) {
					for (const row of terminalRows) body.push(styleTerminalRow(row, theme.getFgAnsi("toolOutput")));
				} else if (logText) {
					for (const line of logText.split("\n")) body.push(theme.fg("toolOutput", replaceTabs(line)));
				}
				break;
			}
			case "monitor": {
				// Surface the resulting delivery mode so wake/ambient/off/no-op are
				// distinguishable at a glance; details carry the authoritative state.
				const mode = details?.monitoring ?? params.progress;
				if (mode === "off") {
					meta.push(theme.fg("muted", details?.monitorDetached === false ? "no active monitor" : "monitor off"));
				} else if (mode) {
					meta.push(theme.fg("accent", `monitor ${mode}`));
				}
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			}
			case "describe": {
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				const spec = details?.spec;
				if (spec) {
					body.push(theme.fg("toolOutput", replaceTabs([spec.application, ...spec.args].join(" "))));
					body.push(theme.fg("dim", `cwd ${shortenPath(spec.cwd)}`));
					const flags = [`pty ${spec.pty}`, `restart ${spec.restart}`];
					if (spec.detached) flags.push("detached");
					else if (spec.persist) flags.push("persistent");
					body.push(theme.fg("dim", flags.join(theme.sep.dot)));
				}
				if (daemon && details?.monitors) {
					if (details.monitors.length === 0) body.push(theme.fg("muted", "no watchers"));
					for (const watcher of details.monitors) body.push(watcherRow(watcher, daemon, theme));
				}
				break;
			}
			default:
				if (text.trim()) {
					for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("toolOutput", line));
				}
		}
	}

	const header = renderStatusLine(
		{
			...(failed
				? { icon: "error" as const }
				: options.isPartial
					? { icon: "pending" as const }
					: { iconOverride: theme.styledSymbol("tool.launch", "accent") }),
			title: `Launch ${op ?? ""}`.trimEnd(),
			description: description ? replaceTabs(description) : undefined,
			meta,
		},
		theme,
	);

	if (op === "logs") {
		return framedBlock(theme, width => {
			const innerWidth = outputBlockContentWidth(width);
			const rows = body.map(line => truncateToWidth(line, innerWidth));
			return {
				header,
				state: options.isPartial ? "pending" : failed ? "error" : "success",
				sections: [
					{
						label: theme.fg("toolTitle", "Output"),
						lines: capPreviewLines(rows, theme, {
							expanded: options.expanded,
							max: DEFAULT_TERMINAL_PREVIEW_LINES,
						}),
					},
				],
				width,
			};
		});
	}

	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			let visible = body;
			if (!expanded && op === "list" && body.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
				const remaining = body.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
				visible = [
					...body.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS),
					theme.fg("dim", `${formatMoreItems(remaining, "process")} ${formatExpandHint(theme, false, true)}`),
				];
			}
			return [header, ...visible].map(line => truncateToWidth(line, width));
		},
	);
}
