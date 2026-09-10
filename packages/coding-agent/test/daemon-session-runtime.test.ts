import { afterEach, describe, expect, type Mock, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { createAgentSessionRuntime } from "../src/daemon/session-runtime";
import type { HostedTerminalDescriptor } from "../src/daemon/terminal-bridge";
import * as interactiveModeModule from "../src/modes/interactive-mode";
import * as themeModule from "../src/modes/theme/theme";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { CreateAgentSessionResult } from "../src/sdk";
import {
	type AgentSession,
	type AgentSessionDisposeOptions,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import * as changelogModule from "../src/utils/changelog";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("daemon session runtime", () => {
	test("bounds memory consolidation while disposing a hosted session", async () => {
		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted",
			createSession: async options => {
				const session = {
					sessionId: "hosted",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async (received?: AgentSessionDisposeOptions) => {
						disposeOptions = received;
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return {
					session,
					setToolUIContext: () => {},
				} as unknown as CreateAgentSessionResult;
			},
		});

		await runtime.dispose();

		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});
	test("seeds a recovered CLI runtime with the requested session identity", async () => {
		let createdSessionId: string | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "stable-recovery-id",
			overrides: { argv: ["--no-session", "--no-extensions"] },
			createSession: async options => {
				createdSessionId = options.sessionManager?.getSessionId();
				const session = {
					sessionId: createdSessionId,
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return {
					session,
					setToolUIContext: () => {},
				} as unknown as CreateAgentSessionResult;
			},
		});
		try {
			expect(createdSessionId).toBe("stable-recovery-id");
			expect(runtime.sessionId).toBe("stable-recovery-id");
			expect(runtime.session.sessionId).toBe("stable-recovery-id");
		} finally {
			await runtime.dispose();
		}
	});

	test("keeps creation and commands inside each session working-directory context", async () => {
		const root = process.cwd();
		const firstCwd = path.join(root, "first-project");
		const secondCwd = path.join(root, "second-project");
		const creationCwds: string[] = [];
		const createRuntime = (cwd: string, sessionId: string) =>
			createAgentSessionRuntime({
				cwd,
				sessionId,
				createSession: async options => {
					creationCwds.push(getProjectDir());
					const session = {
						sessionId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						getSessionStats: () => ({ cwd: getProjectDir() }),
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return {
						session,
						setToolUIContext: () => {},
					} as unknown as CreateAgentSessionResult;
				},
			});

		const [first, second] = await Promise.all([createRuntime(firstCwd, "first"), createRuntime(secondCwd, "second")]);
		try {
			expect(creationCwds).toEqual([firstCwd, secondCwd]);
			expect(await first.command({ type: "get_session_stats" })).toEqual({ cwd: firstCwd });
			expect(await second.command({ type: "get_session_stats" })).toEqual({ cwd: secondCwd });
			expect(getProjectDir()).toBe(root);
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});
	test("isolates concurrent runtime registries and re-enters each command scope", async () => {
		const registries: AgentRegistry[] = [];
		const createRuntime = (sessionId: string) =>
			createAgentSessionRuntime({
				cwd: process.cwd(),
				sessionId,
				createSession: async options => {
					const registry = options.agentRegistry;
					expect(registry).toBeDefined();
					if (!registry) throw new Error("runtime must inject an agent registry");
					registries.push(registry);
					registry.register({
						id: `child-${sessionId}`,
						displayName: `Child ${sessionId}`,
						kind: "sub",
						parentId: sessionId,
						session: null,
					});
					expect(AgentRegistry.global()).toBe(registry);
					const session = {
						sessionId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						getSessionStats: () => ({
							registryIds: AgentRegistry.global()
								.list()
								.map(ref => ref.id),
						}),
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return {
						session,
						setToolUIContext: () => {},
					} as unknown as CreateAgentSessionResult;
				},
			});

		const [first, second] = await Promise.all([createRuntime("first-registry"), createRuntime("second-registry")]);
		try {
			expect(registries).toHaveLength(2);
			expect(registries[0]).not.toBe(registries[1]);
			expect(registries[0]!.list().map(ref => ref.id)).toEqual(["child-first-registry"]);
			expect(registries[1]!.list().map(ref => ref.id)).toEqual(["child-second-registry"]);
			expect(await first.command({ type: "get_session_stats" })).toEqual({
				registryIds: ["child-first-registry"],
			});
			expect(await second.command({ type: "get_session_stats" })).toEqual({
				registryIds: ["child-second-registry"],
			});
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});

	test("reports the underlying session id in RPC state, not the registry handle", async () => {
		// The registry id is a random per-daemon UUID; the resume hint (and any
		// other state consumer) needs the persisted session's own id — resuming
		// by registry id can never find a session file.
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "registry-handle-id",
			createSession: async options => {
				const session = {
					sessionId: "0197-real-session-id",
					sessionFile: "/tmp/0197-real-session-id.jsonl",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		try {
			const state = (await runtime.command({ type: "get_state" })) as { sessionId?: string; sessionFile?: string };
			expect(state.sessionId).toBe("0197-real-session-id");
			expect(state.sessionFile).toBe("/tmp/0197-real-session-id.jsonl");
			// The registry keeps addressing the runtime by its own handle.
			expect(runtime.sessionId).toBe("registry-handle-id");
		} finally {
			await runtime.dispose();
		}
	});

	test("resume argv opens the persisted session instead of silently creating a fresh one", async () => {
		// User-reported critical regression shape: `omp --daemon --resume <id>`
		// appeared to work while hosting an EMPTY new session. The daemon-side
		// CLI launch must resolve the resume id to the existing transcript and
		// hand that exact SessionManager to session creation.
		const cwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-resume-"));
		const fixture = SessionManager.create(cwd);
		const persistedId = fixture.getSessionId();
		fixture.appendMessage({ role: "user", content: "resume fixture", timestamp: Date.now() });
		fixture.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fixture ack" }],
			timestamp: Date.now(),
			stopReason: "stop",
			api: "openai-completions",
			model: "mock",
			provider: "mock",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const persistedFile = fixture.getSessionFile();
		await fixture.close();

		let resumedId: string | undefined;
		let resumedFile: string | undefined;
		try {
			const runtime = await createAgentSessionRuntime({
				cwd,
				sessionId: "registry-resume-handle",
				overrides: { argv: ["--resume", persistedId, "--no-extensions"] },
				createSession: async options => {
					resumedId = options.sessionManager?.getSessionId();
					resumedFile = options.sessionManager?.getSessionFile() ?? undefined;
					const session = {
						sessionId: resumedId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
				},
			});
			await runtime.dispose();
			expect(resumedId).toBe(persistedId);
			expect(resumedFile).toBe(persistedFile ?? undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			if (persistedFile) await rm(path.dirname(persistedFile), { recursive: true, force: true });
		}
	}, 30_000);

	test("terminal_start takes over a defunct hosted terminal without awaiting its pinned task", async () => {
		type FakeMode = {
			isShuttingDown: boolean;
			detachHosted: Mock<() => void>;
			init: () => Promise<void>;
			renderInitialMessages: () => void;
			setDaemonSnapshot: () => void;
			getUserInput: () => Promise<unknown>;
		};
		const modes: FakeMode[] = [];
		const makeFakeMode = (): FakeMode => {
			const input = Promise.withResolvers<unknown>();
			const mode: FakeMode = {
				isShuttingDown: false,
				detachHosted: vi.fn(() => {
					mode.isShuttingDown = true;
					// The first host simulates a mode pinned by an in-flight turn:
					// its loop never settles even after detach. Later hosts settle
					// cooperatively so dispose() can drain the active task.
					if (modes[0] !== mode) input.resolve({ text: "", cancelled: true, started: false });
				}),
				init: async () => {},
				renderInitialMessages: () => {},
				setDaemonSnapshot: () => {},
				getUserInput: () => input.promise,
			};
			modes.push(mode);
			return mode;
		};
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		vi.spyOn(changelogModule, "loadStartupChangelog").mockResolvedValue(undefined);
		type ModeFactory = { InteractiveMode: () => interactiveModeModule.InteractiveMode };
		const modeCtor = vi
			.spyOn(interactiveModeModule as unknown as ModeFactory, "InteractiveMode")
			.mockImplementation(function (this: unknown) {
				return makeFakeMode() as unknown as interactiveModeModule.InteractiveMode;
			});
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted",
			createSession: async options => {
				const session = {
					sessionId: "hosted",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					settings: { get: () => undefined },
					sessionManager: { getCwd: () => process.cwd() },
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		const descriptor = { columns: 80, rows: 24 } as HostedTerminalDescriptor;
		try {
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a1");
			expect(modeCtor).toHaveBeenCalledTimes(1);

			// Server-observed drop: the registry's fire-and-forget detach put the
			// hosted mode into shutdown, but its task stays pinned (in-flight turn).
			modes[0]!.isShuttingDown = true;
			// Same attachment reconnects. Pre-fix this either no-oped (same id =>
			// permanently blank screen) or awaited the pinned task (hang); now it
			// must hand over promptly.
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a1");
			expect(modeCtor).toHaveBeenCalledTimes(2);
			expect(modes[0]!.detachHosted).toHaveBeenCalled();

			// A different attachment replaces the interactive terminal while the
			// current host is healthy (registry already rebound the attachment).
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a2");
			expect(modeCtor).toHaveBeenCalledTimes(3);
			expect(modes[1]!.detachHosted).toHaveBeenCalled();

			// A healthy same-id restart stays a no-op so an unnoticed transport
			// blip does not reset the TUI.
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a2");
			expect(modeCtor).toHaveBeenCalledTimes(3);
		} finally {
			await runtime.dispose();
		}
	});
});
