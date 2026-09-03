import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type { DaemonCompletionNotification, DaemonRpcResult } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
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

	it("routes a broker completion and releases its sink on session change", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const queued: DaemonCompletionNotification[] = [];
		let liveOwner = owner;
		let deliver: ((notification: DaemonCompletionNotification) => void) | undefined;
		let sessionChange: (() => void) | undefined;
		let preservedPending = false;
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
			onCompletion: (_owner: string, sink: (notification: DaemonCompletionNotification) => void) => {
				deliver = sink;
				return options => {
					preservedPending = options?.preservePending === true;
					deliver = undefined;
				};
			},
			request: async () => ({ op: "start", daemon: completion.daemon, readyTimedOut: false }) as const,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => liveOwner,
				isDisposed: () => false,
				queueLaunchCompletion: (notification: DaemonCompletionNotification) => queued.push(notification),
				registerSessionChangeCallback: (callback: () => void) => {
					sessionChange = callback;
				},
			} as unknown as ToolSession,
			{ op: "start", name: "web", application: process.execPath, args: [] },
		);

		liveOwner = "target-session";
		deliver?.(completion);
		expect(queued).toEqual([completion]);
		sessionChange?.();
		expect(deliver).toBeUndefined();
		expect(preservedPending).toBe(true);
	});

	it("keeps the completion sink when start delivery is indeterminate", async () => {
		const projectDir = process.cwd();
		let unregisters = 0;
		const client = {
			projectDir,
			onCompletion: () => () => {
				unregisters++;
			},
			request: async () => {
				throw new Error("Daemon broker request aborted");
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
			executeLaunch(session, { op: "start", name: "web", application: process.execPath, args: [] }),
		).rejects.toThrow("aborted");
		expect(unregisters).toBe(0);
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
