import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionSendQueue } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/send-queue";
import type { ExtensionActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import * as skillsModule from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
	}) => void,
	skills: Skill[] = [],
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let promptIndex = 0;
	const state = { messages: [] as unknown[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		...createSessionDefaults(),
		state,
		skills,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit });
			return true;
		},
		sendCustomMessage: vi.fn(async () => {}),
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult:
			{} as unknown as import("@oh-my-pi/pi-coding-agent/extensibility/extensions/types").LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("autoloadSkills in executor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("calls sendCustomMessage for each autoloaded skill before prompt", async () => {
		const mockSkills: Skill[] = [
			{
				name: "user-created-skill-a",
				description: "Skill A",
				filePath: "/skills/user-created-skill-a/SKILL.md",
				baseDir: "/skills/user-created-skill-a",
				source: "user",
			},
			{
				name: "user-created-skill-b",
				description: "Skill B",
				filePath: "/skills/user-created-skill-b/SKILL.md",
				baseDir: "/skills/user-created-skill-b",
				source: "user",
			},
		];

		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async skill => ({
			message: `Content of ${skill.name}\n\n---\n\nSkill: ${skill.filePath}`,
			details: {
				name: skill.name,
				path: skill.filePath,
				args: undefined,
				lineCount: 1,
			},
		}));

		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		}, mockSkills);

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({
			...baseOptions,
			skills: mockSkills,
			autoloadSkillNames: mockSkills.map(skill => skill.name),
		});

		const sendCustomMessage = session.sendCustomMessage as Mock<any>;
		expect(sendCustomMessage).toHaveBeenCalledTimes(2);

		// Verify first skill
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			1,
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Content of user-created-skill-a"),
				display: false,
				details: { name: "user-created-skill-a", path: "/skills/user-created-skill-a/SKILL.md" },
			},
			{ triggerTurn: false },
		);

		// Verify second skill
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			2,
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Content of user-created-skill-b"),
				display: false,
				details: { name: "user-created-skill-b", path: "/skills/user-created-skill-b/SKILL.md" },
			},
			{ triggerTurn: false },
		);
	});

	it("does not call sendCustomMessage when autoloadSkillNames is empty", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess(baseOptions);

		const sendCustomMessage = session.sendCustomMessage as Mock<any>;
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("skill messages are sent before the task prompt", async () => {
		const callOrder: string[] = [];
		const mockSkill: Skill = {
			name: "user-created-skill",
			description: "A custom skill",
			filePath: "/skills/user-created-skill/SKILL.md",
			baseDir: "/skills/user-created-skill",
			source: "user",
		};

		const session = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			[mockSkill],
		);

		// Track sendCustomMessage call order
		(session.sendCustomMessage as Mock<any>).mockImplementation(async () => {
			callOrder.push("sendCustomMessage");
		});

		// Track the original prompt to capture order
		const originalPrompt = session.prompt;
		session.prompt = async (text: string, options?: PromptOptions) => {
			callOrder.push("prompt");
			return originalPrompt(text, options);
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockResolvedValue({
			message: "Skill content\n\n---\n\nSkill: /skills/user-created-skill/SKILL.md",
			details: { name: "user-created-skill", path: "/skills/user-created-skill/SKILL.md", lineCount: 1 },
		});

		await runSubprocess({
			...baseOptions,
			skills: [mockSkill],
			autoloadSkillNames: [mockSkill.name],
		});

		expect(callOrder).toEqual(["sendCustomMessage", "prompt"]);
	});

	// Regression: autoload resolution must use the child session's merged
	// skill set (post-`resources_discover`), not the spawner's snapshot — a
	// child-replaced skill (same name, different file) must inject the
	// child's content, and a name the parent could not resolve must still
	// autoload once the child contributes it.
	it("resolves autoload names against the child session's skills, not the parent snapshot", async () => {
		const parentSkill: Skill = {
			name: "shared-skill",
			description: "parent copy",
			filePath: "/parent/skills/shared-skill/SKILL.md",
			baseDir: "/parent/skills/shared-skill",
			source: "omp",
		};
		const childReplacement: Skill = {
			name: "shared-skill",
			description: "child copy (extension-contributed)",
			filePath: "/child/worktree/skills/shared-skill/SKILL.md",
			baseDir: "/child/worktree/skills/shared-skill",
			source: "extension:user",
		};
		const childOnly: Skill = {
			name: "child-only-skill",
			description: "exists only after child discovery",
			filePath: "/child/worktree/skills/child-only-skill/SKILL.md",
			baseDir: "/child/worktree/skills/child-only-skill",
			source: "extension:user",
		};

		const session = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			[childReplacement, childOnly],
		);

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async skill => ({
			message: `Content of ${skill.filePath}`,
			details: { name: skill.name, path: skill.filePath, args: undefined, lineCount: 1 },
		}));

		await runSubprocess({
			...baseOptions,
			skills: [parentSkill],
			autoloadSkillNames: ["shared-skill", "child-only-skill"],
		});

		const sendCustomMessage = session.sendCustomMessage as Mock<any>;
		expect(sendCustomMessage).toHaveBeenCalledTimes(2);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				details: { name: "shared-skill", path: childReplacement.filePath },
			}),
			{ triggerTurn: false },
		);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				details: { name: "child-only-skill", path: childOnly.filePath },
			}),
			{ triggerTurn: false },
		);
	});

	// Released SDK surface: `autoloadSkills` (Skill objects) predates
	// `autoloadSkillNames` and must keep working — resolved against the child
	// session when the name exists there (the child copy wins), and injected
	// verbatim when the session never discovered the skill.
	it("keeps the released autoloadSkills option working: session copy wins, caller object is the fallback", async () => {
		const parentCopy: Skill = {
			name: "shared-skill",
			description: "parent copy",
			filePath: "/parent/skills/shared-skill/SKILL.md",
			baseDir: "/parent/skills/shared-skill",
			source: "omp",
		};
		const childCopy: Skill = {
			name: "shared-skill",
			description: "child copy",
			filePath: "/child/skills/shared-skill/SKILL.md",
			baseDir: "/child/skills/shared-skill",
			source: "extension:user",
		};
		const sdkOnly: Skill = {
			name: "sdk-injected-skill",
			description: "never discovered by the session",
			filePath: "/sdk/skills/sdk-injected-skill/SKILL.md",
			baseDir: "/sdk/skills/sdk-injected-skill",
			source: "user",
		};

		const session = createMockSession(
			({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			},
			[childCopy],
		);

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async skill => ({
			message: `Content of ${skill.filePath}`,
			details: { name: skill.name, path: skill.filePath, args: undefined, lineCount: 1 },
		}));

		await runSubprocess({
			...baseOptions,
			skills: [parentCopy],
			autoloadSkills: [parentCopy, sdkOnly],
		});

		const sendCustomMessage = session.sendCustomMessage as Mock<any>;
		expect(sendCustomMessage).toHaveBeenCalledTimes(2);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				details: { name: "shared-skill", path: childCopy.filePath },
			}),
			{ triggerTurn: false },
		);
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				details: { name: "sdk-injected-skill", path: sdkOnly.filePath },
			}),
			{ triggerTurn: false },
		);
	});

	// A direct SDK caller of the exported runSubprocess() who passes `skills`
	// gets a fixed snapshot: only callers that set mergeDiscoveredSkillPaths
	// (the task, eval and vibe spawners) let the child's resources_discover
	// results merge into it (PR #9379 review).
	it("keeps a direct caller's skills fixed unless it sets mergeDiscoveredSkillPaths", async () => {
		const supplied: Skill = {
			name: "curated-skill",
			description: "curated by the SDK caller",
			filePath: "/sdk/skills/curated-skill/SKILL.md",
			baseDir: "/sdk/skills/curated-skill",
			source: "user",
		};
		const yieldNow = ({ emit }: { emit: (event: AgentSessionEvent) => void }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		};
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockImplementation(async () => createSessionResult(createMockSession(yieldNow, [supplied])));

		await runSubprocess({ ...baseOptions, skills: [supplied] });
		await runSubprocess({ ...baseOptions, skills: [supplied], mergeDiscoveredSkillPaths: true });

		expect(createSession).toHaveBeenCalledTimes(2);
		const [direct] = createSession.mock.calls[0];
		const [spawner] = createSession.mock.calls[1];
		expect(direct?.skills).toEqual([supplied]);
		expect(direct?.mergeDiscoveredSkillPaths).toBe(false);
		expect(spawner?.skills).toEqual([supplied]);
		expect(spawner?.mergeDiscoveredSkillPaths).toBe(true);
	});
});

describe("autoloadSkills through task spawn", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers a skill added after the parent session's skill list was loaded", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-late-skill-"));
		try {
			const baseDir = path.join(root, "late-skill");
			const filePath = path.join(baseDir, "SKILL.md");
			await fs.mkdir(baseDir);
			await Bun.write(
				filePath,
				"---\nname: late-skill\ndescription: Added after startup.\n---\n\nLate skill body.\n",
			);
			const lateSkill: Skill = {
				name: "late-skill",
				description: "Added after startup.",
				filePath,
				baseDir,
				source: "user",
			};

			let parentSkills: Skill[] = [];
			const refreshSkills = vi.fn(async () => {
				parentSkills = [lateSkill];
			});
			const parent = {
				cwd: root,
				hasUI: false,
				settings: Settings.isolated({ "task.isolation.enabled": false }),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionAgents: () => [],
				getPlanModeState: () => undefined,
				get skills() {
					return parentSkills;
				},
				refreshSkills,
			} as unknown as ToolSession;

			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
				agents: [
					{
						name: "late-agent",
						description: "Autoloads a late skill",
						systemPrompt: "test",
						source: "project",
						autoloadSkills: ["late-skill"],
					},
				],
				projectAgentsDir: null,
			});
			// The executor resolves autoload names against the child session's
			// skills, which createAgentSession seeds from the `skills` the spawn
			// forwards: the parent's list, read after refreshSkills.
			const childSkills: Skill[] = [];
			const child = createMockSession(({ emit }) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}, childSkills);
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				childSkills.push(...(options?.skills ?? []));
				return createSessionResult(child);
			});

			await runStructuredSubagent({
				session: parent,
				invocationKind: "task",
				assignment: "do work",
				agent: "late-agent",
			});

			expect(refreshSkills).toHaveBeenCalledTimes(1);
			expect(child.sendCustomMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: expect.stringContaining("Late skill body."),
				}),
				{ triggerTurn: false },
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("subagent session_init persistence ordering (regression: PR #9379 review)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseOptions = {
		cwd: "/tmp",
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" } as AgentDefinition,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as ModelRegistry,
		enableLsp: false,
	};

	/**
	 * A subagent session whose runner, session_init persistence and discovery
	 * are observable. Built inline (rather than via createMockSession + post-hoc
	 * field assignment) so every overridden member is part of the object literal
	 * the single `as unknown as AgentSession` cast applies to, not an assignment
	 * against an already-typed (and therefore readonly-checked) reference.
	 */
	function createStartupSession(overrides: {
		systemPromptParts: string[];
		appendSessionInit: (init: { systemPrompt: string[] }) => string;
		discoverStartupSkillPaths: () => Promise<void>;
		onSessionStart?: (actions: ExtensionActions) => void;
		sendUserMessage?: () => Promise<void>;
	}): AgentSession {
		const listeners: Array<(event: AgentSessionEvent) => void> = [];
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		};
		let actions: ExtensionActions | undefined;
		return {
			...createSessionDefaults(),
			state: { messages: [] as unknown[] },
			skills: [],
			agent: { state: { systemPrompt: overrides.systemPromptParts } },
			getAgentId: () => undefined,
			model: undefined,
			extensionRunner: {
				initialize: (initialActions: ExtensionActions) => {
					actions = initialActions;
				},
				onError: vi.fn(),
				emit: vi.fn(async (event: { type: string }) => {
					if (event.type === "session_start" && actions) overrides.onSessionStart?.(actions);
					return undefined;
				}),
				sends: new ExtensionSendQueue(),
			},
			sessionManager: { appendSessionInit: overrides.appendSessionInit },
			getActiveToolNames: () => ["read", "yield"],
			getEnabledToolNames: () => ["read", "yield"],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
			prompt: async (_text: string, _options?: PromptOptions) => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-1",
					toolName: "yield",
					result: { content: [{ type: "text", text: "done" }], details: { status: "success", data: {} } },
					isError: false,
				});
			},
			sendCustomMessage: vi.fn(async () => {}),
			sendUserMessage: overrides.sendUserMessage ?? vi.fn(async () => {}),
			getLastAssistantMessage: () => undefined,
			discoverStartupSkillPaths: overrides.discoverStartupSkillPaths,
		} as unknown as AgentSession;
	}

	it("persists session_init.systemPrompt after startup skill discovery has run, not before", async () => {
		// A mutable "live" system prompt: discoverStartupSkillPaths appends to it,
		// mirroring session-tools.ts's refreshBaseSystemPrompt rebuilding
		// session.agent.state.systemPrompt when a resources_discover handler
		// contributes a directory.
		const systemPromptParts = ["base prompt"];
		const appendSessionInitCalls: Array<{ systemPrompt: string[] }> = [];
		const session = createStartupSession({
			systemPromptParts,
			appendSessionInit: init => {
				// Copy: the live prompt array keeps changing after this record is written.
				appendSessionInitCalls.push({ systemPrompt: [...init.systemPrompt] });
				return "init-id";
			},
			discoverStartupSkillPaths: async () => {
				systemPromptParts.push("discovered skill notice");
			},
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({ ...baseOptions });

		// One session_init at spawn, inside the Agent Hub's bounded prefix read
		// (persisted-agents.ts), and a newer one after discovery: cold revival
		// (persisted-revive.ts) replays the latest, so it must carry the
		// post-discovery prompt, not the pre-discovery snapshot.
		expect(appendSessionInitCalls).toHaveLength(2);
		expect(appendSessionInitCalls.at(-1)?.systemPrompt).toEqual(["base prompt", "discovered skill notice"]);
	});

	it("runs a session_start-triggered turn after discovery and session_init (regression: PR #9379 review, executor.ts startup sends)", async () => {
		// The turn must see the child's discovered skills, and its records must
		// follow session_init: persisted-agents.ts reads agent metadata from the
		// first records of the session file only. The spawn record comes first;
		// discovery changes the prompt, so a newer record follows before the send.
		const order: string[] = [];
		const systemPromptParts = ["base prompt"];
		const session = createStartupSession({
			systemPromptParts,
			appendSessionInit: () => {
				order.push("session_init");
				return "init-id";
			},
			discoverStartupSkillPaths: async () => {
				order.push("discovery");
				systemPromptParts.push("discovered skill notice");
			},
			onSessionStart: actions => actions.sendUserMessage("hello from session_start"),
			sendUserMessage: async () => {
				order.push("send");
			},
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({ ...baseOptions });

		expect(order).toEqual(["session_init", "discovery", "session_init", "send"]);
	});
});
