import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient, DaemonCompletionUnregisterOptions } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type { DaemonCompletionNotification, DaemonRpcResult } from "../../../src/launch/protocol";
import type { LaunchContextBoundary, ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";

afterEach(() => {
	vi.restoreAllMocks();
});

class CleanExitWorker extends EventTarget {
	postMessage(): void {
		this.dispatchEvent(new Event("close"));
	}

	terminate(): void {}
}

describe("launch broker protocol compatibility", () => {
	it("replays raw terminal text returned by an already-running legacy broker", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			close() {},
			onCompletion: () => () => {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
			op: "logs",
			name: "web",
			lines: 10,
			head: false,
		});

		expect(result.details?.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
	});

	it("keeps sanitized legacy logs when optional terminal replay fails", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "raw",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			onCompletion: () => () => {},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		expect(originalWorkerDescriptor).toBeDefined();
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: CleanExitWorker });
		try {
			const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
				op: "logs",
				name: "web",
				lines: 10,
				head: false,
			});
			expect(result.content).toEqual([{ type: "text", text: "ready\n[web: running; cursor=42]" }]);
			expect(result.details?.terminalRows).toBeUndefined();
		} finally {
			if (originalWorkerDescriptor) {
				Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "Worker");
			}
		}
		expect(Object.getOwnPropertyDescriptor(globalThis, "Worker")).toEqual(originalWorkerDescriptor);
	});

	it("restores a completion sink when a resumed session lists its live daemon", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const registered: string[] = [];
		const client = {
			projectDir,
			onCompletion: (registeredOwner: string) => {
				registered.push(registeredOwner);
				return () => {};
			},
			request: async () => {
				expect(registered).toEqual([owner]);
				return {
					op: "list",
					daemons: [
						{
							name: "web",
							id: "daemon-id",
							state: "running",
							createdAt: 1,
							startedAt: 1,
							restartCount: 0,
							outputBytes: 0,
							owner,
							persist: true,
							detached: false,
						},
					],
				} as const;
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				queueLaunchCompletion: () => {},
				registerDisposeCallback: () => {},
			} as unknown as ToolSession,
			{ op: "list" },
		);

		expect(registered).toEqual([owner]);
	});

	it("restores a completion sink before a resumed session reads logs", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const registered: string[] = [];
		const client = {
			projectDir,
			onCompletion: (registeredOwner: string) => {
				registered.push(registeredOwner);
				return () => {};
			},
			request: async () =>
				({
					op: "logs",
					name: "web",
					text: "ready",
					cursor: 5,
					timedOut: false,
					state: "running",
				}) as const,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				queueLaunchCompletion: () => {},
				registerDisposeCallback: () => {},
			} as unknown as ToolSession,
			{ op: "logs", name: "web", lines: 10, head: false, follow: false },
		);

		expect(registered).toEqual([owner]);
	});

	it("restores a completion sink before a resumed session stops one daemon", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const registered: string[] = [];
		const client = {
			projectDir,
			onCompletion: (registeredOwner: string) => {
				registered.push(registeredOwner);
				return () => {};
			},
			request: async () => {
				expect(registered).toEqual([owner]);
				return {
					op: "stop",
					daemon: {
						name: "web",
						id: "daemon-id",
						state: "exited",
						createdAt: 1,
						startedAt: 1,
						exitedAt: 2,
						exitCode: 0,
						restartCount: 0,
						outputBytes: 0,
						owner,
						persist: true,
						detached: false,
					},
				} as const;
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				queueLaunchCompletion: () => {},
				registerDisposeCallback: () => {},
			} as unknown as ToolSession,
			{ op: "stop", name: "web", timeout: 1 },
		);
	});

	it("restores a completion sink before a resumed session waits on a daemon", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const registered: string[] = [];
		const daemon = {
			name: "web",
			id: "daemon-id",
			state: "running",
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: true,
			detached: false,
		} as const;
		const client = {
			projectDir,
			onCompletion: (registeredOwner: string) => {
				registered.push(registeredOwner);
				return () => {};
			},
			request: async () => {
				expect(registered).toEqual([owner]);
				return { op: "wait", daemon, timedOut: false } as const;
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				queueLaunchCompletion: () => {},
				registerDisposeCallback: () => {},
			} as unknown as ToolSession,
			{ op: "wait", name: "web", for: "exit", timeout: 1 },
		);
	});

	it("preserves replayed completions when a resumed owner has no live daemon", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let preservedPending = false;
		const client = {
			projectDir,
			onCompletion: () => options => {
				preservedPending = options?.preservePending === true;
			},
			request: async () => ({ op: "list", daemons: [] }) as const,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				queueLaunchCompletion: () => {},
			} as unknown as ToolSession,
			{ op: "list" },
		);

		expect(preservedPending).toBe(true);
	});

	function completionBoundaryFixture(): {
		session: ToolSession;
		deliver: () => (notification: DaemonCompletionNotification) => void;
		queued: DaemonCompletionNotification[];
		crossBoundary: (boundary: LaunchContextBoundary) => void;
		unregisterOptions: () => Array<{ preservePending: boolean }>;
	} {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const queued: DaemonCompletionNotification[] = [];
		let deliver: ((notification: DaemonCompletionNotification) => void) | undefined;
		let contextBoundary: ((boundary: LaunchContextBoundary) => void) | undefined;
		const unregisterOptions: Array<{ preservePending: boolean }> = [];
		const daemon = {
			name: "web",
			id: "daemon-id",
			state: "running",
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		} as const;
		const client = {
			projectDir,
			onCompletion: (_owner: string, sink: (notification: DaemonCompletionNotification) => void) => {
				deliver = sink;
				return options => {
					unregisterOptions.push({ preservePending: options?.preservePending === true });
					deliver = undefined;
				};
			},
			request: async () => ({ op: "start", daemon, readyTimedOut: false }) as const,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			queueLaunchCompletion: (notification: DaemonCompletionNotification) => queued.push(notification),
			registerContextBoundaryCallback: (callback: (boundary: LaunchContextBoundary) => void) => {
				contextBoundary = callback;
				return () => {
					if (contextBoundary === callback) contextBoundary = undefined;
				};
			},
		} as unknown as ToolSession;
		return {
			session,
			queued,
			deliver: () => {
				if (!deliver) throw new Error("Expected a live completion sink");
				return deliver;
			},
			crossBoundary: boundary => {
				if (!contextBoundary) throw new Error("Expected a registered context boundary callback");
				contextBoundary(boundary);
			},
			unregisterOptions: () => unregisterOptions,
		};
	}

	it("routes a broker completion and keeps it replayable when a switch releases the sink", async () => {
		const fixture = completionBoundaryFixture();
		await executeLaunch(fixture.session, { op: "start", name: "web", application: process.execPath, args: [] });

		const completion = {
			event: "daemon-completed",
			completionId: "completion-id",
			owner: "owner-session",
			daemon: {
				name: "web",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: "owner-session",
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;
		fixture.deliver()(completion);
		expect(fixture.queued).toEqual([completion]);

		// The outgoing session stays on disk: whatever the process reports after
		// the switch must still reach it when it is resumed.
		fixture.crossBoundary("switch");
		expect(fixture.unregisterOptions()).toEqual([{ preservePending: true }]);
		expect(() => fixture.deliver()).toThrow("Expected a live completion sink");
	});

	it.each<LaunchContextBoundary>(["reset", "new"])(
		"discards the owner's pending completions at a destructive %s boundary",
		async boundary => {
			const fixture = completionBoundaryFixture();
			await executeLaunch(fixture.session, { op: "start", name: "web", application: process.execPath, args: [] });

			// The conversation that started the process is gone for good: a
			// retained completion would replay into the emptied context the next
			// time this owner registers, or sit unacknowledged and block a
			// same-name restart.
			fixture.crossBoundary(boundary);
			expect(fixture.unregisterOptions()).toEqual([{ preservePending: false }]);
			expect(() => fixture.deliver()).toThrow("Expected a live completion sink");

			// The boundary callback fired once and unregistered itself.
			expect(() => fixture.crossBoundary(boundary)).toThrow("Expected a registered context boundary callback");
			expect(fixture.unregisterOptions()).toHaveLength(1);
		},
	);

	it("preserves daemon epochs across ToolSession session changes and cleans them on disposal", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 61;
		let liveOwner = owner;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		let dispose: (() => void) | undefined;
		let preservedPending = false;
		const queued: Array<{ notification: DaemonCompletionNotification; epoch: number }> = [];
		const completion = {
			event: "daemon-completed",
			completionId: "completion-id",
			owner,
			daemon: {
				name: "web",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return (options?: { preservePending?: boolean }) => {
					preservedPending = options?.preservePending === true;
					deliver = undefined;
				};
			},
			request: async () => ({ op: "start", daemon: completion.daemon, readyTimedOut: false }) as const,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => liveOwner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queued.push({ notification, epoch: capturedEpoch });
			},
			registerDisposeCallback: (callback: () => void) => {
				dispose = callback;
			},
			registerSessionChangeCallback: () => {
				throw new Error("Completion associations must survive session changes");
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "start", name: "web", application: process.execPath, args: [] });
		liveOwner = "target-session";
		epoch = 62;
		await deliver?.(completion);

		expect(queued).toEqual([{ notification: completion, epoch: 61 }]);
		expect(deliver).toBeDefined();
		dispose?.();
		expect(deliver).toBeUndefined();
		expect(preservedPending).toBe(true);
	});

	it.each([
		{ lifecycle: "running same-ID", restartedId: "old-id", expectedEpoch: 11, incarnation: "continued" },
		{ lifecycle: "terminal fresh-ID", restartedId: "restarted-id", expectedEpoch: 12, incarnation: "replaced" },
		{ lifecycle: "legacy same-ID", restartedId: "old-id", expectedEpoch: 11, incarnation: "unknown" },
		{ lifecycle: "legacy fresh-ID", restartedId: "legacy-fresh-id", expectedEpoch: 11, incarnation: "unknown" },
	] as const)(
		"keeps the $lifecycle restart on its incarnation epoch after reset",
		async ({ restartedId, expectedEpoch, incarnation }) => {
			const projectDir = process.cwd();
			const owner = "owner-session";
			let epoch = 11;
			let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
			const queued: Array<{ notification: DaemonCompletionNotification; epoch: number }> = [];
			const oldSnapshot = {
				name: "web",
				id: "old-id",
				state: "running",
				pid: 123,
				createdAt: 1,
				startedAt: 1,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			} as const;
			const restartedSnapshot = {
				...oldSnapshot,
				id: restartedId,
				createdAt: 2,
				startedAt: 2,
				restartCount: 1,
			};
			const restartBaseline =
				restartedId === oldSnapshot.id
					? oldSnapshot
					: {
							...oldSnapshot,
							state: "exited" as const,
							pid: undefined,
							exitedAt: 2,
							exitCode: 0,
						};
			const client = {
				projectDir,
				onCompletion: (
					_registeredOwner: string,
					sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
				) => {
					deliver = sink;
					return () => {};
				},
				request: async (operation: { op: string }) => {
					if (operation.op === "start") {
						return { op: "start", daemon: oldSnapshot, readyTimedOut: false } as const;
					}
					if (operation.op === "restart") {
						return {
							op: "restart",
							daemon: restartedSnapshot,
							incarnation,
						} as const;
					}
					throw new Error(`Unexpected operation: ${operation.op}`);
				},
				close() {},
			} as unknown as DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
			const session = {
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				captureLaunchProgressEpoch: () => epoch,
				queueLaunchCompletion: async (notification: DaemonCompletionNotification, capturedEpoch: number) => {
					queued.push({ notification, epoch: capturedEpoch });
				},
			} as unknown as ToolSession;

			await executeLaunch(session, { op: "start", name: "web", application: process.execPath });
			if (restartedId !== oldSnapshot.id) {
				await deliver?.({
					event: "daemon-completed",
					completionId: "old-terminal-completion",
					owner,
					daemon: restartBaseline,
				});
				queued.length = 0;
			}
			// resetSessionContext advances the epoch without changing the owner ID.
			epoch = 12;
			await executeLaunch(session, { op: "restart", name: "web" });
			const completion = {
				event: "daemon-completed",
				completionId: "restarted-completion",
				owner,
				daemon: {
					...restartedSnapshot,
					state: "exited",
					pid: undefined,
					exitedAt: 20,
					exitCode: 0,
				},
			} satisfies DaemonCompletionNotification;
			await deliver?.(completion);

			expect(queued).toEqual([{ notification: completion, epoch: expectedEpoch }]);
		},
	);

	it("keeps an old replay off a pending fresh restart binding", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 51;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queued: Array<{ id: string; epoch: number }> = [];
		const restartEntered = Promise.withResolvers<void>();
		const restartResult = Promise.withResolvers<DaemonRpcResult>();
		const oldDaemon = {
			name: "web",
			id: "old-id",
			state: "running",
			pid: 123,
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		} as const;
		const freshDaemon = { ...oldDaemon, id: "fresh-id", createdAt: 2, startedAt: 2, restartCount: 1 };
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return () => {};
			},
			request: async (operation: { op: string }) => {
				if (operation.op === "start") {
					return { op: "start", daemon: oldDaemon, readyTimedOut: false } as const;
				}
				if (operation.op === "restart") {
					restartEntered.resolve();
					return restartResult.promise;
				}
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queued.push({ id: notification.daemon.id, epoch: capturedEpoch });
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "start", name: "web", application: process.execPath });
		epoch = 52;
		const restarting = executeLaunch(session, { op: "restart", name: "web" });
		await restartEntered.promise;
		const oldReplay = deliver?.({
			event: "daemon-completed",
			completionId: "old-replay",
			owner,
			daemon: {
				...oldDaemon,
				id: "older-replay-id",
				state: "exited",
				pid: undefined,
				exitedAt: 2,
				exitCode: 0,
			},
		});
		restartResult.resolve({ op: "restart", daemon: freshDaemon, incarnation: "replaced" });
		await restarting;
		await oldReplay;
		await deliver?.({
			event: "daemon-completed",
			completionId: "fresh-completion",
			owner,
			daemon: {
				...freshDaemon,
				state: "exited",
				pid: undefined,
				exitedAt: 3,
				exitCode: 0,
			},
		});

		expect(queued).toEqual([
			{ id: "older-replay-id", epoch: 51 },
			{ id: "fresh-id", epoch: 52 },
		]);
	});

	it("removes the caller restart lease when the daemon belongs to another session", async () => {
		const projectDir = process.cwd();
		const caller = "caller-session";
		const daemonOwner = "daemon-owner";
		const registeredOwners: string[] = [];
		let unregisters = 0;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		let preservedPending = false;
		const foreignDaemon = {
			name: "shared",
			id: "shared-fresh",
			state: "running",
			pid: 123,
			createdAt: 3,
			startedAt: 3,
			restartCount: 1,
			outputBytes: 0,
			owner: daemonOwner,
			persist: true,
			detached: false,
		} as const;
		const client = {
			projectDir,
			onCompletion: (owner: string, sink: (notification: DaemonCompletionNotification) => Promise<void> | void) => {
				registeredOwners.push(owner);
				deliver = sink;
				return (options?: DaemonCompletionUnregisterOptions) => {
					unregisters++;
					preservedPending = options?.preservePending === true;
					deliver = undefined;
				};
			},
			request: async (operation: { op: string }) => {
				if (operation.op !== "restart") throw new Error(`Unexpected operation: ${operation.op}`);
				expect(registeredOwners).toEqual([caller]);
				return { op: "restart", daemon: foreignDaemon, incarnation: "replaced" } as const;
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => caller,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => 41,
			queueLaunchCompletion: async () => {
				throw new Error("Foreign completion must not enter the caller queue");
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "restart", name: "shared" });

		expect(registeredOwners).toEqual([caller]);
		expect(unregisters).toBe(1);
		expect(deliver).toBeUndefined();
		expect(preservedPending).toBe(true);
	});

	it("does not retain epoch bindings for repeated local or pre-dispatch start failures", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 31;
		let registrations = 0;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queuedEpochs: number[] = [];
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				registrations++;
				deliver = sink;
				return () => {};
			},
			request: async (_operation: unknown, signal?: AbortSignal) => {
				if (signal?.aborted) throw new Error("Daemon broker request aborted");
				throw new Error("Local socket failed before write");
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (_notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queuedEpochs.push(capturedEpoch);
			},
		} as unknown as ToolSession;

		const aborted = new AbortController();
		aborted.abort();
		await expect(
			executeLaunch(session, { op: "start", name: "aborted", application: process.execPath }, aborted.signal),
		).rejects.toThrow("aborted");
		for (let index = 0; index < 10; index++) {
			epoch++;
			await expect(
				executeLaunch(session, { op: "start", name: `local-${index}`, application: process.execPath }),
			).rejects.toThrow("before write");
		}
		await deliver?.({
			event: "daemon-completed",
			completionId: "unrelated-local-failure-completion",
			owner,
			daemon: {
				name: "local-9",
				id: "unrelated-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		});

		expect(registrations).toBe(1);
		expect(queuedEpochs).toEqual([31]);
	});

	it("preserves an ambiguously accepted start epoch until its matching completion", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 21;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queued: Array<{ id: string; epoch: number }> = [];
		const baseline = {
			name: "baseline",
			id: "baseline-id",
			state: "running",
			pid: 123,
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		} as const;
		const accepted = { ...baseline, name: "lost", id: "accepted-id", createdAt: 2, startedAt: 2 } as const;
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return () => {};
			},
			request: async (
				operation: { op: string; spec?: { name: string } },
				_signal?: AbortSignal,
				onDispatch?: (state: "written") => void,
			) => {
				if (operation.op !== "start" || !operation.spec) throw new Error(`Unexpected operation: ${operation.op}`);
				onDispatch?.("written");
				if (operation.spec.name === "baseline") {
					return { op: "start", daemon: baseline, readyTimedOut: false } as const;
				}
				throw new Error("Broker accepted start but response was lost");
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queued.push({ id: notification.daemon.id, epoch: capturedEpoch });
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "start", name: "baseline", application: process.execPath });
		// Same owner ID, new launch epoch after reset.
		epoch = 22;
		await expect(
			executeLaunch(session, { op: "start", name: "lost", application: process.execPath }),
		).rejects.toThrow("response was lost");
		const completion = {
			event: "daemon-completed",
			completionId: "accepted-completion",
			owner,
			daemon: {
				...accepted,
				state: "exited",
				pid: undefined,
				exitedAt: 3,
				exitCode: 0,
			},
		} satisfies DaemonCompletionNotification;
		await deliver?.(completion);
		await deliver?.({
			...completion,
			completionId: "unrelated-completion",
			daemon: { ...completion.daemon, id: "unrelated-id" },
		});

		// The matching completion consumes the indeterminate binding. A later
		// unrelated ID falls back to the registration epoch instead of leaking 22.
		expect(queued).toEqual([
			{ id: "accepted-id", epoch: 22 },
			{ id: "unrelated-id", epoch: 21 },
		]);
	});

	it("uses the launch epoch for a fresh completion after a written restart loses its response", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 71;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queued: Array<{ id: string; epoch: number }> = [];
		const oldDaemon = {
			name: "web",
			id: "old-id",
			state: "running",
			pid: 123,
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		} as const;
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return () => {};
			},
			request: async (operation: { op: string }, _signal?: AbortSignal, onDispatch?: (state: "written") => void) => {
				onDispatch?.("written");
				if (operation.op === "start") return { op: "start", daemon: oldDaemon, readyTimedOut: false } as const;
				if (operation.op === "restart") throw new Error("Broker accepted restart but response was lost");
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queued.push({ id: notification.daemon.id, epoch: capturedEpoch });
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "start", name: "web", application: process.execPath });
		epoch = 72;
		await expect(executeLaunch(session, { op: "restart", name: "web" })).rejects.toThrow("response was lost");
		await deliver?.({
			event: "daemon-completed",
			completionId: "fresh-after-lost-response",
			owner,
			daemon: {
				...oldDaemon,
				id: "fresh-id",
				state: "exited",
				pid: undefined,
				createdAt: 2,
				startedAt: 2,
				exitedAt: 3,
				exitCode: 0,
			},
		});

		expect(queued).toEqual([{ id: "fresh-id", epoch: 72 }]);
	});

	it("keeps a restored same-ID restart completion on its old epoch when the response is lost", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 81;
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queuedEpochs: number[] = [];
		const daemon = {
			name: "web",
			id: "restored-id",
			state: "running",
			pid: 123,
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: true,
			detached: false,
		} as const;
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return () => {};
			},
			request: async (operation: { op: string }, _signal?: AbortSignal, onDispatch?: (state: "written") => void) => {
				if (operation.op === "list") return { op: "list", daemons: [daemon] } as const;
				if (operation.op === "restart") {
					onDispatch?.("written");
					throw new Error("Broker accepted continued restart but response was lost");
				}
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (_notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queuedEpochs.push(capturedEpoch);
			},
		} as unknown as ToolSession;

		await executeLaunch(session, { op: "list" });
		epoch = 82;
		await expect(executeLaunch(session, { op: "restart", name: "web" })).rejects.toThrow("response was lost");
		await deliver?.({
			event: "daemon-completed",
			completionId: "continued-after-lost-response",
			owner,
			daemon: {
				...daemon,
				state: "exited",
				pid: undefined,
				exitedAt: 3,
				exitCode: 0,
			},
		});

		expect(queuedEpochs).toEqual([81]);
	});
	it("releases every terminal stop association before later restart correlation", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let epoch = 91;
		let daemonId = "daemon-0";
		let deliver: ((notification: DaemonCompletionNotification) => Promise<void> | void) | undefined;
		const queuedEpochs: number[] = [];
		const snapshot = (state: "exited" | "running") => ({
			name: "web",
			id: daemonId,
			state,
			pid: state === "running" ? 123 : undefined,
			createdAt: 1,
			startedAt: 1,
			exitedAt: state === "exited" ? 2 : undefined,
			exitCode: state === "exited" ? 0 : undefined,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: true,
			detached: false,
		});
		const client = {
			projectDir,
			onCompletion: (
				_registeredOwner: string,
				sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
			) => {
				deliver = sink;
				return () => {};
			},
			request: async (operation: { op: string }, _signal?: AbortSignal, onDispatch?: (state: "written") => void) => {
				if (operation.op === "list") return { op: "list", daemons: [snapshot("running")] } as const;
				if (operation.op === "stop") return { op: "stop", daemon: snapshot("exited") } as const;
				if (operation.op === "restart") {
					onDispatch?.("written");
					throw new Error("Broker accepted restart but response was lost");
				}
				throw new Error(`Unexpected operation: ${operation.op}`);
			},
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			captureLaunchProgressEpoch: () => epoch,
			queueLaunchCompletion: async (_notification: DaemonCompletionNotification, capturedEpoch: number) => {
				queuedEpochs.push(capturedEpoch);
			},
		} as unknown as ToolSession;

		for (let index = 0; index < 3; index++) {
			daemonId = `daemon-${index}`;
			await executeLaunch(session, { op: "list" });
			await executeLaunch(session, { op: "stop", name: "web" });
		}
		epoch = 92;
		await expect(executeLaunch(session, { op: "restart", name: "web" })).rejects.toThrow("response was lost");
		daemonId = "fresh-id";
		await deliver?.({
			event: "daemon-completed",
			completionId: "fresh-after-stops",
			owner,
			daemon: snapshot("exited"),
		});

		expect(queuedEpochs).toEqual([91]);
	});

	it("detaches the completion sink without deleting pending replay when the broker rejects start", async () => {
		const projectDir = process.cwd();
		let unregisters = 0;
		let preservedPending = false;
		let disposeRemovals = 0;
		const client = {
			projectDir,
			onCompletion: () => options => {
				unregisters++;
				preservedPending = options?.preservePending === true;
			},

			request: async operation => {
				if (operation.op === "start") throw new daemonClient.DaemonBrokerRejectedError("name already exists");
				return { op: "list", daemons: [] };
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const session = {
			cwd: projectDir,
			getSessionId: () => "owner-session",
			isDisposed: () => false,
			queueLaunchCompletion: () => {},
			registerDisposeCallback: () => () => {
				disposeRemovals++;
			},
		} as unknown as ToolSession;
		await expect(
			executeLaunch(session, { op: "start", name: "web", application: process.execPath, args: [] }),
		).rejects.toThrow("name already exists");
		expect(unregisters).toBe(1);
		expect(disposeRemovals).toBe(1);
		expect(preservedPending).toBe(true);
	});

	it("keeps a resumed owner's sink when duplicate start finds its live daemon", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let unregisters = 0;
		const client = {
			projectDir,
			onCompletion: () => () => {
				unregisters++;
			},
			request: async operation => {
				if (operation.op === "start") throw new daemonClient.DaemonBrokerRejectedError("name already exists");
				return {
					op: "list",
					daemons: [
						{
							name: "web",
							id: "daemon-id",
							state: "running",
							createdAt: 1,
							startedAt: 1,
							restartCount: 0,
							outputBytes: 0,
							owner,
							persist: false,
							detached: false,
						},
					],
				};
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			queueLaunchCompletion: async () => {},
			registerDisposeCallback: () => {},
		} as unknown as ToolSession;

		await expect(
			executeLaunch(session, { op: "start", name: "web", application: process.execPath, args: [] }),
		).rejects.toThrow("name already exists");
		expect(unregisters).toBe(0);
	});

	it("keeps a resumed owner's completion sink after a rejected operation", async () => {
		const projectDir = process.cwd();
		let unregisters = 0;
		const client = {
			projectDir,
			onCompletion: () => () => {
				unregisters++;
			},
			request: async () => {
				throw new daemonClient.DaemonBrokerRejectedError("daemon not found");
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const session = {
			cwd: projectDir,
			getSessionId: () => "owner-session",
			isDisposed: () => false,
			queueLaunchCompletion: () => {},
			registerDisposeCallback: () => {},
		} as unknown as ToolSession;

		await expect(
			executeLaunch(session, { op: "logs", name: "misspelled", lines: 10, head: false, follow: false }),
		).rejects.toThrow("daemon not found");
		expect(unregisters).toBe(0);
	});
	it("keeps a shared completion sink when a sibling start succeeds", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		let unregisters = 0;
		let dispose: (() => void) | undefined;
		const rejected = Promise.withResolvers<DaemonRpcResult>();
		const accepted = Promise.withResolvers<DaemonRpcResult>();
		let requests = 0;
		const client = {
			projectDir,
			onCompletion: () => () => {
				unregisters++;
			},
			request: () => (++requests === 1 ? rejected.promise : accepted.promise),
			close() {},
		} as unknown as DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const session = {
			cwd: projectDir,
			getSessionId: () => owner,
			isDisposed: () => false,
			queueLaunchCompletion: () => {},
			registerDisposeCallback: (callback: () => void) => {
				dispose = callback;
			},
		} as unknown as ToolSession;

		const first = executeLaunch(session, { op: "start", name: "first", application: process.execPath, args: [] });
		const second = executeLaunch(session, { op: "start", name: "second", application: process.execPath, args: [] });
		rejected.reject(new daemonClient.DaemonBrokerRejectedError("name already exists"));
		await expect(first).rejects.toThrow("name already exists");
		expect(unregisters).toBe(0);
		accepted.resolve({
			op: "start",
			daemon: {
				name: "second",
				id: "daemon-id",
				state: "running",
				createdAt: 1,
				startedAt: 1,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
			readyTimedOut: false,
		});
		await second;
		expect(unregisters).toBe(0);
		dispose?.();
		expect(unregisters).toBe(1);
	});
});
