import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as skillsModule from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SKILL_BODY = "Demo skill body: count the widgets.";

describe("AgentSession.sendUserMessage expandPromptTemplates", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	/** Set by a test to hold the next model turn open until it resolves `release`. */
	let heldTurn: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	const observedTurns: string[] = [];
	const observedRoles: string[] = [];
	let skillsSettings: { enableSkillCommands: boolean };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-send-user-message-expand-");
		observedTurns.length = 0;
		observedRoles.length = 0;
		heldTurn = undefined;
		skillsSettings = { enableSkillCommands: true };
		const skillDir = path.join(tempDir.path(), "demo");
		const skillPath = path.join(skillDir, "SKILL.md");
		await Bun.write(skillPath, `---\nname: demo\ndescription: Demo skill\n---\n\n${SKILL_BODY}\n`);

		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const last = context.messages.at(-1);
				const content = last?.content;
				observedRoles.push(last?.role ?? "");
				observedTurns.push(
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content.map(block => (block.type === "text" ? block.text : "")).join("\n")
							: "",
				);
				const stream = new AssistantMessageEventStream();
				const finish = () => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				};
				const hold = heldTurn;
				heldTurn = undefined;
				if (hold) {
					hold.release.promise.then(finish);
					hold.started.resolve();
				} else queueMicrotask(finish);
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			skills: [{ name: "demo", description: "Demo skill", filePath: skillPath, baseDir: skillDir, source: "test" }],
			skillsSettings,
			promptTemplates: [{ name: "tpl", description: "Demo template", content: "TPL BODY $1", source: "(test)" }],
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("keeps extension text literal by default and expands a /skill: command on opt-in", async () => {
		await session.sendUserMessage("/skill:demo first");
		await session.waitForIdle();
		await session.sendUserMessage("/skill:demo second", { expandPromptTemplates: true });
		await session.waitForIdle();

		expect(observedTurns[0]).toBe("/skill:demo first");
		expect(observedTurns[1]).toContain(SKILL_BODY);
		expect(observedTurns[1]).toContain("second");
	});

	it("keeps /skill: text literal when skill commands are disabled", async () => {
		skillsSettings.enableSkillCommands = false;
		await session.sendUserMessage("/skill:demo off", { expandPromptTemplates: true });
		await session.waitForIdle();

		expect(observedTurns).toEqual(["/skill:demo off"]);
	});

	it("queues an idle explicit follow-up skill without starting a turn", async () => {
		await session.sendUserMessage("/skill:demo later", { expandPromptTemplates: true, deliverAs: "followUp" });

		expect(observedTurns).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("queues an expanded prompt template that the submitted text can still remove", async () => {
		await session.sendUserMessage("/tpl x", { expandPromptTemplates: true, deliverAs: "steer" });

		expect(session.getQueuedMessages().steering).toEqual(["TPL BODY x"]);
		expect(session.removeQueuedMessage("/tpl x", "steering")).toBe(true);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("drops a skill send when abort lands while SKILL.md is read", async () => {
		const read = Promise.withResolvers<void>();
		const build = skillsModule.buildSkillPromptMessage;
		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async (...args) => {
			await read.promise;
			return build(...args);
		});
		const send = session.sendUserMessage("/skill:demo late", { expandPromptTemplates: true });
		await session.abort();
		read.resolve();
		await send;
		await session.waitForIdle();

		expect(observedTurns).toHaveLength(0);
	});

	for (const [label, interrupt] of [
		["abort", (target: AgentSession) => target.abort()],
		["disposal", (target: AgentSession) => target.beginDispose()],
	] as const) {
		it(`reports a queued custom message dropped by ${label} during image normalization`, async () => {
			const normalizing = Promise.withResolvers<void>();
			const normalized = Promise.withResolvers<void>();
			vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
				normalizing.resolve();
				await normalized.promise;
				return images;
			});
			const send = session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: [
						{ type: "text", text: "skill body" },
						{ type: "image", data: "aW1n", mimeType: "image/png" },
					],
					display: true,
					attribution: "user",
				},
				{ streamingBehavior: "followUp", queueOnly: true },
			);
			await normalizing.promise;
			await interrupt(session);
			normalized.resolve();

			expect(await send).toBe(false);
			expect(session.queuedMessageCount).toBe(0);
			expect(observedTurns).toHaveLength(0);
		});
	}

	it("delivers an agent-attributed expanded skill as a user-role message", async () => {
		await session.sendUserMessage("/skill:demo relay", { expandPromptTemplates: true, attribution: "agent" });
		await session.waitForIdle();

		expect(observedRoles).toEqual(["user"]);
		expect(observedTurns[0]).toContain(SKILL_BODY);
	});

	it("expands a /skill: command queued as a follow-up while the agent is streaming", async () => {
		const hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		heldTurn = hold;
		const first = session.sendUserMessage("start");
		await hold.started.promise;
		await session.sendUserMessage("/skill:demo queued", { expandPromptTemplates: true, deliverAs: "followUp" });
		hold.release.resolve();
		await first;
		await session.waitForIdle();

		expect(observedTurns).toHaveLength(2);
		expect(observedTurns[1]).toContain(SKILL_BODY);
		expect(observedTurns[1]).toContain("queued");
	});
});
