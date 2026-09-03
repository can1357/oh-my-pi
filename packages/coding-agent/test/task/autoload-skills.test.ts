import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import * as skillsModule from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

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
		setActiveToolsByName: async () => {},
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
		},
		sendCustomMessage: vi.fn(async () => {}),
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
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

	it("does not call sendCustomMessage when autoloadSkillNames is undefined", async () => {
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

		await runSubprocess({ ...baseOptions, autoloadSkillNames: undefined });

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
});
