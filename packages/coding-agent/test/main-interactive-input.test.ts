import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions, readPipedInput, submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { discoverTitleSystemPromptFile } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map(dir => removeWithRetries(dir)));
	vi.restoreAllMocks();
});

function createInput(overrides: Partial<SubmittedUserInput> = {}): SubmittedUserInput {
	return {
		text: "hello",
		images: undefined,
		cancelled: false,
		started: false,
		...overrides,
	};
}

describe("discoverTitleSystemPromptFile", () => {
	it("discovers TITLE_SYSTEM.md from the project omp config directory", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-title-system-"));
		cleanupDirs.push(projectDir);
		const configDir = path.join(projectDir, ".omp");
		await fs.mkdir(configDir, { recursive: true });
		const promptPath = path.join(configDir, "TITLE_SYSTEM.md");
		await fs.writeFile(promptPath, "custom title prompt");

		expect(discoverTitleSystemPromptFile(projectDir)).toBe(promptPath);
	});
});

describe("readPipedInput", () => {
	it("reads redirected stdin when Bun reports isTTY as undefined", async () => {
		const originalIsTTY = process.stdin.isTTY;
		const readText = vi.spyOn(Bun.stdin, "text").mockResolvedValue("piped prompt\n");
		Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

		try {
			expect(await readPipedInput()).toBe("piped prompt\n");
			expect(readText).toHaveBeenCalledTimes(1);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("system prompt template CLI resolution", () => {
	async function buildPromptOptions(cwd: string, args: string[]): Promise<CreateAgentSessionOptions> {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			return await buildSessionOptions(
				parseArgs(["--cwd", cwd, ...args]),
				[],
				SessionManager.inMemory(),
				new ModelRegistry(authStorage),
				Settings.isolated(),
			);
		} finally {
			authStorage.close();
		}
	}

	it("discovers SYSTEM_TEMPLATE.md and preserves the raw template", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-system-template-"));
		cleanupDirs.push(projectDir);
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "SYSTEM_TEMPLATE.md"), "Hello {{model}}");

		const options = await buildPromptOptions(projectDir, []);

		expect(options.systemPromptTemplate).toBe("Hello {{model}}");
		expect(options.customSystemPrompt).toBeUndefined();
	});

	it("lets an explicit literal prompt suppress discovered templates", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-system-prompt-"));
		cleanupDirs.push(projectDir);
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "SYSTEM_TEMPLATE.md"), "discovered");

		const options = await buildPromptOptions(projectDir, ["--system-prompt", "inline literal"]);

		expect(options.customSystemPrompt).toBe("inline literal");
		expect(options.systemPromptTemplate).toBeUndefined();
	});
});

function createMode(options?: { pendingStart?: boolean; skillCommands?: Map<string, Skill> }) {
	return {
		markPendingSubmissionStarted: vi.fn(() => options?.pendingStart ?? true),
		finishPendingSubmission: vi.fn(),
		showError: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		skillCommands: options?.skillCommands ?? new Map<string, Skill>(),
		optimisticSkillMessagePending: false,
		renderOptimisticSkillMessage: vi.fn(),
		clearOptimisticSkillMessage: vi.fn(),
	};
}

describe("submitInteractiveInput", () => {
	it("routes already-started synthetic continue submissions to a hidden developer prompt", async () => {
		const mode = createMode({ pendingStart: false });
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "resume now", started: true, synthetic: true });

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("resume now", {
			synthetic: true,
			expandPromptTemplates: false,
			userInitiated: undefined,
			onAccepted: undefined,
		});
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("skips prompting when optimistic submission was cancelled before start", async () => {
		const mode = createMode({ pendingStart: false });
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const onAccepted = vi.fn();
		const input = createInput({ onAccepted });

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).toHaveBeenCalledWith(input);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(onAccepted).not.toHaveBeenCalled();
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("routes hidden custom submissions through promptCustomMessage with followUp queueing", async () => {
		const mode = createMode();
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "continue goal", customType: "goal-continuation" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).not.toHaveBeenCalled();
		// Even when idle, followUp is passed so a background turn that starts in the
		// read-vs-dispatch gap queues the message instead of throwing AgentBusyError.
		expect(session.promptCustomMessage).toHaveBeenCalledWith(
			{
				customType: "goal-continuation",
				content: "continue goal",
				display: false,
				attribution: "agent",
			},
			{ streamingBehavior: "followUp", onAccepted: undefined },
		);
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("does not consume a stash for loop or goal automation, but accepts a typed submission", async () => {
		let stashAvailable = true;
		const mode = createMode();
		const session = {
			prompt: vi.fn(async (_text: string, options?: { onAccepted?: () => void }) => {
				options?.onAccepted?.();
				return true;
			}),
			promptCustomMessage: vi.fn(async (_message: unknown, options?: { onAccepted?: () => void }) => {
				options?.onAccepted?.();
				return true;
			}),
			isStreaming: false,
		};
		await submitInteractiveInput(mode, session, createInput({ text: "loop iteration" }));
		await submitInteractiveInput(
			mode,
			session,
			createInput({ text: "goal iteration", customType: "goal-continuation" }),
		);
		expect(stashAvailable).toBe(true);
		await submitInteractiveInput(
			mode,
			session,
			createInput({
				text: "typed",
				onAccepted: () => {
					stashAvailable = false;
				},
			}),
		);
		expect(stashAvailable).toBe(false);
	});

	it("passes followUp on a plain idle submission so a racing turn queues instead of erroring", async () => {
		const mode = createMode();
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "loop prompt" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).toHaveBeenCalledWith("loop prompt", {
			images: undefined,
			streamingBehavior: "followUp",
			onAccepted: undefined,
		});
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("honors a steer intent on the submission (normal Enter) instead of forcing followUp", async () => {
		const mode = createMode();
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: true,
		};
		const input = createInput({ text: "interrupt now", streamingBehavior: "steer" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).toHaveBeenCalledWith("interrupt now", {
			images: undefined,
			streamingBehavior: "steer",
			onAccepted: undefined,
		});
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("parks the loop when dispatch consumes the armed body locally", async () => {
		const mode = {
			...createMode(),
			loopPrompt: "/void-cmd",
			pauseLoop: vi.fn(),
		};
		const session = {
			prompt: vi.fn(async () => false),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "/void-cmd" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).toHaveBeenCalledWith("/void-cmd", {
			images: undefined,
			streamingBehavior: "followUp",
			onAccepted: undefined,
		});
		expect(mode.pauseLoop).toHaveBeenCalledTimes(1);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("accepts a locally consumed typed command only after successful dispatch", async () => {
		const onAccepted = vi.fn();
		const mode = createMode();
		const session = {
			prompt: vi.fn(async () => false),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		await submitInteractiveInput(mode, session, createInput({ text: "/local", onAccepted }));
		expect(onAccepted).toHaveBeenCalledTimes(1);
	});

	it("keeps the loop armed when dispatch starts a turn", async () => {
		const mode = {
			...createMode(),
			loopPrompt: "repeat me",
			pauseLoop: vi.fn(),
		};
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "repeat me" });

		await submitInteractiveInput(mode, session, input);

		expect(mode.pauseLoop).not.toHaveBeenCalled();
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("ignores local consumption when it is not the armed body", async () => {
		const mode = {
			...createMode(),
			loopPrompt: "repeat me",
			pauseLoop: vi.fn(),
		};
		const session = {
			prompt: vi.fn(async () => false),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "/other-cmd" });

		await submitInteractiveInput(mode, session, input);

		expect(mode.pauseLoop).not.toHaveBeenCalled();
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("parks the loop when dispatch rejects the armed body", async () => {
		const mode = {
			...createMode(),
			loopPrompt: "failing body",
			pauseLoop: vi.fn(),
		};
		const session = {
			prompt: vi.fn(async () => {
				throw new Error("attachment too large");
			}),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "failing body" });

		await submitInteractiveInput(mode, session, input);

		expect(mode.pauseLoop).toHaveBeenCalledTimes(1);
		expect(mode.showError).toHaveBeenCalledWith("attachment too large");
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
	});

	it("routes a resubmitted /skill: prompt through promptCustomMessage instead of raw text (regression for #8137-style loop resubmit)", async () => {
		const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-command-"));
		cleanupDirs.push(skillDir);
		const skillPath = path.join(skillDir, "recap.md");
		await fs.writeFile(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		const skill: Skill = { name: "recap", description: "", filePath: skillPath, baseDir: skillDir, source: "test" };
		const mode = createMode({ skillCommands: new Map([["skill:recap", skill]]) });
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => true),
			isStreaming: false,
		};
		const input = createInput({ text: "/skill:recap what changed" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.promptCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "user",
				display: true,
				details: expect.objectContaining({ name: "recap", args: "what changed" }),
			}),
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		// The row paints before the awaited dispatch, so a slow preflight does not
		// leave a loop iteration invisible (issue #8895).
		expect(mode.renderOptimisticSkillMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				attribution: "user",
			}),
			expect.anything(),
		);
		expect(mode.showError).not.toHaveBeenCalled();
	});
});
