import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { COLLAB_AGENT_MESSAGE_TYPE, type CollabAgentMessageDetails } from "@oh-my-pi/pi-coding-agent/collab/registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ResetSessionContextResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const BODY = "Peer report: this is not a human instruction.";

describe("AgentSession synchronous agent message admission", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mock: MockModel;
	let modelInputs: AgentMessage[][];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-agent-message-admission-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelInputs = [];
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
			await tempDir.remove();
		}
	});

	function createSession(handler: MockHandler = { content: ["acknowledged"] }): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		mock = createMockModel({ handler });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm: messages => {
				modelInputs.push(messages.slice());
				return convertToLlm(messages);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			toolRegistry: new Map(),
		});
	}

	function payload(admission: "idle" | "busy" = "idle") {
		const details: CollabAgentMessageDetails = {
			version: 1,
			requestId: "test-admission-1",
			sender: { instanceId: "sender", generation: 1, sessionId: "sender-session" },
			recipient: {
				instanceId: "receiver",
				generation: 1,
				sessionId: session.sessionManager.getSessionId(),
			},
			admission,
			admittedAt: Date.now(),
		};
		return { customType: COLLAB_AGENT_MESSAGE_TYPE, content: BODY, display: true, details };
	}

	function admittedRecords(messages: readonly AgentMessage[]) {
		return messages.filter(message => message.role === "custom" && message.customType === COLLAB_AGENT_MESSAGE_TYPE);
	}

	it("admits synchronously while idle and delivers a persisted custom agent record, never a human prompt", async () => {
		createSession();
		// Even an extra caller-supplied attribution cannot promote the record to human authority.
		const message = { ...payload(), attribution: "user" as const };
		expect(
			session.admitAgentMessage(message, message.details.recipient.sessionId, session.sessionTransitionEpoch),
		).toBeUndefined();
		expect(admittedRecords(session.agent.peekSteeringQueue())).toEqual([
			expect.objectContaining({
				role: "custom",
				customType: COLLAB_AGENT_MESSAGE_TYPE,
				content: BODY,
				details: message.details,
				attribution: "agent",
			}),
		]);

		await session.waitForIdle();
		expect(modelInputs.some(messages => admittedRecords(messages).length === 1)).toBe(true);
		expect(session.state.messages.filter(message => message.role === "user")).toEqual([]);
		expect(session.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: COLLAB_AGENT_MESSAGE_TYPE,
				content: BODY,
				details: message.details,
				attribution: "agent",
			}),
		);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("accepts a busy yield-boundary queue immediately and preserves the original human request", async () => {
		createSession();
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			expect(session.isStreaming).toBe(true);
			const message = payload("busy");
			session.admitAgentMessage(message, message.details.recipient.sessionId, session.sessionTransitionEpoch);
			expect(admittedRecords(session.agent.peekSteeringQueue())).toHaveLength(1);
		});

		await session.prompt("original human request");
		await session.waitForIdle();
		expect(injected).toBe(true);
		expect(mock.calls).toHaveLength(2);
		expect(modelInputs.some(messages => admittedRecords(messages).length === 1)).toBe(true);
		expect(session.state.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(session.state.messages.filter(message => message.role === "user"))).toContain(
			"original human request",
		);
		expect(admittedRecords(session.state.messages)).toEqual([
			expect.objectContaining({ attribution: "agent", content: BODY }),
		]);
	});

	it("rejects stale and disposed recipients synchronously without queuing or contacting the model", () => {
		createSession();
		const message = payload();
		const epoch = session.sessionTransitionEpoch;
		expect(() => session.admitAgentMessage(message, "other-session", epoch)).toThrow("Session unavailable");
		session.beginDispose();
		expect(() => session.admitAgentMessage(message, message.details.recipient.sessionId, epoch)).toThrow(
			"Session unavailable",
		);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});

	it("rejects admissions during a transition and never carries an accepted busy record into the new session", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		createSession(async () => {
			if (++calls === 1) {
				started.resolve();
				await release.promise;
			}
			return { content: ["acknowledged"] };
		});
		const turn = session.prompt("old conversation");
		await started.promise;
		const message = payload("busy");
		const epoch = session.sessionTransitionEpoch;
		session.admitAgentMessage(message, message.details.recipient.sessionId, epoch);
		expect(admittedRecords(session.agent.peekSteeringQueue())).toHaveLength(1);
		const transition = session.newSession();
		try {
			expect(session.isSessionTransitioning).toBe(true);
			expect(() => session.admitAgentMessage(message, message.details.recipient.sessionId, epoch)).toThrow(
				"Session unavailable",
			);
			expect(admittedRecords(session.agent.peekSteeringQueue())).toEqual([]);
		} finally {
			release.resolve();
			await Promise.all([turn, transition]);
		}
		expect(session.sessionManager.getSessionId()).not.toBe(message.details.recipient.sessionId);
		expect(() => session.admitAgentMessage(message, message.details.recipient.sessionId, epoch)).toThrow(
			"Session unavailable",
		);
		await session.prompt("new conversation");
		expect(modelInputs.flatMap(admittedRecords)).toEqual([]);
		expect(admittedRecords(session.state.messages)).toEqual([]);
	});

	it("drops an undelivered admission when a fork would otherwise preserve the old queue", async () => {
		createSession();
		await session.prompt("seed persisted fork");
		await session.waitForIdle();
		const message = payload();
		session.admitAgentMessage(message, message.details.recipient.sessionId, session.sessionTransitionEpoch);
		expect(admittedRecords(session.agent.peekSteeringQueue())).toHaveLength(1);
		expect(await session.fork()).toBe(true);
		await session.waitForIdle();
		expect(session.sessionManager.getSessionId()).not.toBe(message.details.recipient.sessionId);
		expect(modelInputs.flatMap(admittedRecords)).toEqual([]);
		expect(admittedRecords(session.state.messages)).toEqual([]);
	});

	it("admits against transcript identity after freshSession rotates only the provider identity", async () => {
		createSession();
		const transcriptId = session.sessionManager.getSessionId();
		expect(session.freshSession()).toBeDefined();
		expect(session.sessionId).not.toBe(transcriptId);
		expect(session.sessionManager.getSessionId()).toBe(transcriptId);
		const message = payload();
		session.admitAgentMessage(message, transcriptId, session.sessionTransitionEpoch);
		await session.waitForIdle();
		expect(modelInputs.some(messages => admittedRecords(messages).length === 1)).toBe(true);
		expect(admittedRecords(session.state.messages)).toEqual([
			expect.objectContaining({ attribution: "agent", details: message.details }),
		]);
	});

	it("leaves a busy reset and its accepted admission untouched until the held turn delivers it", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		createSession(async () => {
			if (++calls === 1) {
				started.resolve();
				await release.promise;
			}
			return { content: ["acknowledged"] };
		});
		const pending = payload("busy");
		const notifications: { epoch: number; transitioning: boolean }[] = [];
		const unregister = session.registerSessionTransitionCallback(() => {
			notifications.push({ epoch: session.sessionTransitionEpoch, transitioning: session.isSessionTransitioning });
		});
		const turn = session.prompt("original busy reset conversation");
		try {
			await started.promise;
			expect(session.isStreaming).toBe(true);
			const epoch = session.sessionTransitionEpoch;
			const providerId = session.sessionId;
			const transcriptId = session.sessionManager.getSessionId();
			const leafId = session.sessionManager.getLeafId();
			const messages = session.state.messages.slice();
			session.admitAgentMessage(pending, transcriptId, epoch);
			const queued = session.agent.peekSteeringQueue().slice();
			expect(admittedRecords(queued)).toHaveLength(1);
			expect(await session.resetSessionContext()).toBeUndefined();
			expect(session.sessionTransitionEpoch).toBe(epoch);
			expect(session.isSessionTransitioning).toBe(false);
			expect(notifications).toEqual([]);
			expect(session.agent.peekSteeringQueue()).toEqual(queued);
			expect(session.sessionId).toBe(providerId);
			expect(session.sessionManager.getSessionId()).toBe(transcriptId);
			expect(session.sessionManager.getLeafId()).toBe(leafId);
			expect(session.state.messages).toEqual(messages);
		} finally {
			release.resolve();
			try {
				await turn;
				await session.waitForIdle();
			} finally {
				unregister();
			}
		}
		const delivered = expect.objectContaining({
			role: "custom",
			customType: COLLAB_AGENT_MESSAGE_TYPE,
			content: pending.content,
			details: pending.details,
			attribution: "agent",
		});
		expect(modelInputs.flatMap(admittedRecords)).toEqual([delivered]);
		expect(admittedRecords(session.state.messages)).toEqual([delivered]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.state.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(JSON.stringify(session.state.messages.filter(message => message.role === "user"))).toContain(
			"original busy reset conversation",
		);
	});

	it("revokes the epoch synchronously and settles a same-ID reset without reviving pending admissions", async () => {
		createSession();
		await session.prompt("conversation to clear");
		await session.waitForIdle();
		const transcriptId = session.sessionManager.getSessionId();
		const epoch = session.sessionTransitionEpoch;
		const droppedCount = session.state.messages.length;
		const pending = payload();
		const previousBridge = session.clientBridge;
		const refreshBaseSystemPrompt = session.refreshBaseSystemPrompt;
		const refreshReached = Promise.withResolvers<void>();
		const refreshRelease = Promise.withResolvers<void>();
		const notifications: { epoch: number; transitioning: boolean }[] = [];
		let identityChanges = 0;
		const unregisterIdentity = session.registerSessionChangeCallback(() => {
			identityChanges++;
		});
		const unregister = session.registerSessionTransitionCallback(() => {
			notifications.push({ epoch: session.sessionTransitionEpoch, transitioning: session.isSessionTransitioning });
		});

		let transition: Promise<ResetSessionContextResult | undefined> | undefined;
		let waiter: Promise<void> | undefined;
		try {
			session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
			session.refreshBaseSystemPrompt = async function (this: AgentSession, ...args) {
				await refreshBaseSystemPrompt.apply(this, args);
				refreshReached.resolve();
				await refreshRelease.promise;
			};
			session.admitAgentMessage(pending, transcriptId, epoch);
			expect(admittedRecords(session.agent.peekSteeringQueue())).toHaveLength(1);
			expect(session.isStreaming).toBe(false);
			transition = session.resetSessionContext();
			expect(session.sessionTransitionEpoch).toBe(epoch + 1);
			expect(notifications).toEqual([{ epoch: epoch + 1, transitioning: true }]);
			let settled = false;
			waiter = session.waitForSessionTransition().then(() => {
				settled = true;
			});
			await refreshReached.promise;
			expect(session.isSessionTransitioning).toBe(true);
			expect(admittedRecords(session.agent.peekSteeringQueue())).toEqual([]);
			expect(() => session.admitAgentMessage(pending, transcriptId, epoch)).toThrow("Session unavailable");
			expect(() => session.admitAgentMessage(pending, transcriptId, session.sessionTransitionEpoch)).toThrow(
				"Session unavailable",
			);
			expect(settled).toBe(false);
			refreshRelease.resolve();
			expect(await transition).toEqual({ droppedCount });
			await waiter;
			expect(settled).toBe(true);
			expect(session.isSessionTransitioning).toBe(false);
			expect(session.sessionTransitionEpoch).toBe(epoch + 1);
			expect(notifications).toEqual([
				{ epoch: epoch + 1, transitioning: true },
				{ epoch: epoch + 1, transitioning: false },
			]);
			expect(identityChanges).toBe(0);
		} finally {
			refreshRelease.resolve();
			try {
				await transition;
				await waiter;
			} finally {
				session.refreshBaseSystemPrompt = refreshBaseSystemPrompt;
				session.setClientBridge(previousBridge);
				unregister();
				unregisterIdentity();
			}
		}
		expect(session.sessionId).not.toBe(transcriptId);
		expect(session.sessionManager.getSessionId()).toBe(transcriptId);
		expect(() => session.admitAgentMessage(pending, transcriptId, epoch)).toThrow("Session unavailable");
		await session.waitForIdle();
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(modelInputs.flatMap(admittedRecords)).toEqual([]);
		expect(admittedRecords(session.state.messages)).toEqual([]);

		const message = payload();
		message.details.requestId = "fresh-reset-admission";
		session.admitAgentMessage(message, transcriptId, session.sessionTransitionEpoch);
		await session.waitForIdle();
		expect(modelInputs.some(messages => admittedRecords(messages).length === 1)).toBe(true);
		expect(admittedRecords(session.state.messages)).toEqual([
			expect.objectContaining({ attribution: "agent", details: message.details }),
		]);
		expect(session.state.messages.filter(message => message.role === "user")).toEqual([]);
	});

	it("revokes the epoch synchronously and settles same-ID tree navigation without reviving pending admissions", async () => {
		createSession();
		await session.prompt("conversation to abandon");
		await session.waitForIdle();
		const target = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!target) throw new Error("Expected persisted user navigation target");
		const transcriptId = session.sessionManager.getSessionId();
		const epoch = session.sessionTransitionEpoch;
		const pending = payload();
		session.admitAgentMessage(pending, transcriptId, epoch);
		expect(admittedRecords(session.agent.peekSteeringQueue())).toHaveLength(1);
		const notifications: { epoch: number; transitioning: boolean }[] = [];
		let identityChanges = 0;
		const unregisterIdentity = session.registerSessionChangeCallback(() => {
			identityChanges++;
		});
		const unregister = session.registerSessionTransitionCallback(() => {
			notifications.push({ epoch: session.sessionTransitionEpoch, transitioning: session.isSessionTransitioning });
		});

		const transition = session.navigateTree(target.id, { summarize: false });
		try {
			expect(session.sessionTransitionEpoch).toBe(epoch + 1);
			expect(session.isSessionTransitioning).toBe(true);
			expect(notifications).toEqual([{ epoch: epoch + 1, transitioning: true }]);
			expect(admittedRecords(session.agent.peekSteeringQueue())).toEqual([]);
			expect(() => session.admitAgentMessage(pending, transcriptId, epoch)).toThrow("Session unavailable");
			expect(() => session.admitAgentMessage(pending, transcriptId, session.sessionTransitionEpoch)).toThrow(
				"Session unavailable",
			);
			expect(await transition).toMatchObject({ cancelled: false, editorText: "conversation to abandon" });
			expect(session.isSessionTransitioning).toBe(false);
			expect(session.sessionTransitionEpoch).toBe(epoch + 1);
			expect(notifications).toEqual([
				{ epoch: epoch + 1, transitioning: true },
				{ epoch: epoch + 1, transitioning: false },
			]);
			expect(identityChanges).toBe(0);
		} finally {
			await transition;
			unregister();
			unregisterIdentity();
		}
		expect(session.sessionManager.getSessionId()).toBe(transcriptId);
		expect(session.sessionManager.getLeafId()).toBe(target.parentId);
		expect(session.state.messages.filter(message => message.role === "user")).toEqual([]);
		expect(() => session.admitAgentMessage(pending, transcriptId, epoch)).toThrow("Session unavailable");
		await session.waitForIdle();
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(modelInputs.flatMap(admittedRecords)).toEqual([]);
		expect(admittedRecords(session.state.messages)).toEqual([]);

		const message = payload();
		message.details.requestId = "fresh-tree-admission";
		session.admitAgentMessage(message, transcriptId, session.sessionTransitionEpoch);
		await session.waitForIdle();
		expect(modelInputs.some(messages => admittedRecords(messages).length === 1)).toBe(true);
		expect(admittedRecords(session.state.messages)).toEqual([
			expect.objectContaining({ attribution: "agent", details: message.details }),
		]);
	});

	it("keeps the advanced admission epoch after a failed switch restores the original session", async () => {
		createSession();
		session.sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const originalId = session.sessionManager.getSessionId();
		const originalCwd = session.sessionManager.getCwd();
		const originalEpoch = session.sessionTransitionEpoch;
		const originalPayload = payload();
		const sourceMessages = session.state.messages.slice();
		const targetCwd = tempDir.join("target-cwd");
		mkdirSync(targetCwd);
		const target = SessionManager.create(targetCwd, tempDir.join("sessions"));
		target.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await target.ensureOnDisk();
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target session");
		const adopted = Promise.withResolvers<void>();
		const failAdoption = Promise.withResolvers<void>();
		const rollbackReached = Promise.withResolvers<void>();
		const rollbackRelease = Promise.withResolvers<void>();
		const failure = new Error("settings adoption failed");
		const cwdChanges: { cwd: string; previousCwd: string }[] = [];
		const notifications: { epoch: number; transitioning: boolean }[] = [];
		const unregister = session.registerSessionTransitionCallback(() => {
			notifications.push({ epoch: session.sessionTransitionEpoch, transitioning: session.isSessionTransitioning });
		});
		let operation: Promise<unknown> | undefined;
		try {
			session.setSessionSwitchReconciler(async () => {
				rollbackReached.resolve();
				await rollbackRelease.promise;
			});
			let firstCwdChange = true;
			operation = session.switchSession(targetFile, {
				onCwdChange: async (cwd, previousCwd) => {
					cwdChanges.push({ cwd, previousCwd });
					if (!firstCwdChange) return true;
					firstCwdChange = false;
					adopted.resolve();
					await failAdoption.promise;
					throw failure;
				},
			});
			await adopted.promise;
			expect(cwdChanges).toEqual([{ cwd: targetCwd, previousCwd: originalCwd }]);
			expect(session.sessionManager.getCwd()).toBe(targetCwd);
			expect(session.sessionManager.getSessionId()).toBe(target.getSessionId());
			expect(session.sessionTransitionEpoch).toBe(originalEpoch + 1);
			expect(session.isSessionTransitioning).toBe(true);
			let settled = false;
			const waiter = session.waitForSessionTransition().then(() => {
				settled = true;
			});
			failAdoption.resolve();
			await rollbackReached.promise;
			expect(session.sessionManager.getSessionId()).toBe(originalId);
			expect(session.sessionManager.getCwd()).toBe(originalCwd);
			expect(session.sessionTransitionEpoch).toBe(originalEpoch + 1);
			expect(session.isSessionTransitioning).toBe(true);
			expect(settled).toBe(false);
			rollbackRelease.resolve();
			await expect(operation).rejects.toBe(failure);
			await waiter;
			expect(settled).toBe(true);
			expect(cwdChanges).toEqual([
				{ cwd: targetCwd, previousCwd: originalCwd },
				{ cwd: originalCwd, previousCwd: targetCwd },
			]);
			expect(session.sessionManager.getSessionId()).toBe(originalId);
			expect(session.sessionManager.getCwd()).toBe(originalCwd);
			expect(session.state.messages).toEqual(sourceMessages);
			expect(session.sessionTransitionEpoch).toBe(originalEpoch + 1);
			expect(session.isSessionTransitioning).toBe(false);
			expect(notifications).toEqual([
				{ epoch: originalEpoch + 1, transitioning: true },
				{ epoch: originalEpoch + 1, transitioning: false },
			]);
			expect(() => session.admitAgentMessage(originalPayload, originalId, originalEpoch)).toThrow(
				"Session unavailable",
			);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(mock.calls).toHaveLength(0);
			expect(modelInputs).toHaveLength(0);
			const freshPayload = payload();
			freshPayload.details.requestId = "fresh-rollback-admission";
			expect(session.admitAgentMessage(freshPayload, originalId, session.sessionTransitionEpoch)).toBeUndefined();
			await session.waitForIdle();
			const delivered = expect.objectContaining({
				role: "custom",
				customType: COLLAB_AGENT_MESSAGE_TYPE,
				content: freshPayload.content,
				details: freshPayload.details,
				attribution: "agent",
			});
			expect(modelInputs.flatMap(admittedRecords)).toContainEqual(delivered);
			expect(admittedRecords(session.state.messages)).toEqual([delivered]);
		} finally {
			failAdoption.resolve();
			rollbackRelease.resolve();
			await operation?.catch(() => {});
			unregister();
			session.setSessionSwitchReconciler(null);
		}
	});

	it("isolates throwing transition observers and stops notifying unsubscribed observers", async () => {
		createSession();
		const epoch = session.sessionTransitionEpoch;
		const failure = new Error("transition observer failed");
		const throwingNotifications: { epoch: number; transitioning: boolean }[] = [];
		const healthyNotifications: { epoch: number; transitioning: boolean }[] = [];
		const unregisterThrowing = session.registerSessionTransitionCallback(() => {
			throwingNotifications.push({
				epoch: session.sessionTransitionEpoch,
				transitioning: session.isSessionTransitioning,
			});
			throw failure;
		});
		const unregisterHealthy = session.registerSessionTransitionCallback(() => {
			healthyNotifications.push({
				epoch: session.sessionTransitionEpoch,
				transitioning: session.isSessionTransitioning,
			});
		});
		let operation: Promise<unknown> | undefined;
		try {
			operation = session.resetSessionContext();
			const waiter = session.waitForSessionTransition();
			await operation;
			await waiter;
			expect(session.sessionTransitionEpoch).toBe(epoch + 1);
			expect(session.isSessionTransitioning).toBe(false);
			const firstNotifications = [
				{ epoch: epoch + 1, transitioning: true },
				{ epoch: epoch + 1, transitioning: false },
			];
			expect(throwingNotifications).toEqual(firstNotifications);
			expect(healthyNotifications).toEqual(firstNotifications);
			unregisterThrowing();
			operation = session.resetSessionContext();
			const secondWaiter = session.waitForSessionTransition();
			await operation;
			await secondWaiter;
			expect(session.sessionTransitionEpoch).toBe(epoch + 2);
			expect(session.isSessionTransitioning).toBe(false);
			expect(throwingNotifications).toEqual(firstNotifications);
			expect(healthyNotifications).toEqual([
				...firstNotifications,
				{ epoch: epoch + 2, transitioning: true },
				{ epoch: epoch + 2, transitioning: false },
			]);
		} finally {
			await operation?.catch(() => {});
			unregisterThrowing();
			unregisterHealthy();
		}
	});
});
