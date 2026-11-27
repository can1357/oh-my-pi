/**
 * `pi.sendUserMessage` when the session drops the message before the agent sees it.
 *
 * A bridge marks forwarded input delivered when the call resolves, so every drop must reject with
 * `PromptDroppedError` instead: an abort while the message's images are prepared, a session switch
 * that discards a queued skill, and a session disposed while its queue was being fed. Tagged input is
 * the sender's to retry, so a drop never hands it back to the interactive editor either; untagged
 * input keeps the editor restore (the positive control).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, PromptDroppedError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

const SKILL_BODY = "Review the supplied code for risks.";
const SKILL_INVOCATION = "/skill:reviewer focus on risks";

describe("pi.sendUserMessage drops", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let term: ModeTerminal | undefined;
	let streamCalls = 0;
	let previousKeybindings: KeybindingsManager;

	beforeAll(async () => {
		initTheme();
		previousKeybindings = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		tempDir = TempDir.createSync("@omp-send-user-input-drops-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		await Bun.write(
			path.join(tempDir.path(), "SKILL.md"),
			`---\nname: reviewer\ndescription: Review code\n---\n\n${SKILL_BODY}\n`,
		);
	});

	afterAll(() => {
		setKeybindings(previousKeybindings);
		tempDir[Symbol.dispose]();
	});

	beforeEach(() => {
		streamCalls = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (mode) {
			mode.stop();
			await mode.shell.stop();
		}
		mode = undefined;
		term?.dispose();
		term = undefined;
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	async function createSession(responses: MockHandler[]): Promise<AgentSession> {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const created = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ responses }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			skills: [
				{
					name: "reviewer",
					description: "Review code",
					filePath: path.join(tempDir.path(), "SKILL.md"),
					baseDir: tempDir.path(),
					source: "project",
				},
			],
			skillsSettings: { enableSkillCommands: true },
		});
		session = created;
		return created;
	}

	/** A turn that streams until released, so later sends take the queue branch. */
	function heldTurn(): { response: MockHandler; started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		return {
			response: async () => {
				streamCalls++;
				started.resolve();
				await release.promise;
				return { content: ["kickoff done"] };
			},
			started: started.promise,
			release: () => release.resolve(),
		};
	}

	const unexpectedTurn: MockHandler = () => {
		streamCalls++;
		return { content: ["must not run for a dropped message"] };
	};

	/** Holds image normalization for image-bearing calls until released. */
	function holdImageNormalization(): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			started.resolve();
			await release.promise;
			return images;
		});
		return { started: started.promise, release: () => release.resolve() };
	}

	function outcomeOf(sent: Promise<unknown>): Promise<unknown> {
		return sent.then(
			result => result,
			(error: unknown) => error,
		);
	}

	describe("an abort while the images are prepared, in the interactive TUI", () => {
		async function sendAndAbort(text: string, tag: string | undefined): Promise<unknown> {
			const created = await createSession([unexpectedTurn]);
			term = createModeTerminal();
			await term.start();
			// The real host: its constructor installs the setPromptDropped hook that owns editor restore.
			mode = new InteractiveMode(created, "test", undefined, undefined, undefined, undefined, term.frame);
			vi.spyOn(mode, "showError").mockImplementation(() => {});
			const normalization = holdImageNormalization();
			const sent = outcomeOf(created.sendUserMessage([{ type: "text", text }, IMAGE], { expand: true, tag }));
			await withTimeout(normalization.started, 5_000, "Normalization never started");
			await created.abort({ reason: USER_INTERRUPT_LABEL });
			normalization.release();
			return await sent;
		}

		it("rejects a tagged send and leaves the editor alone", async () => {
			const outcome = await sendAndAbort("bridge input aborted before admission", "msg-abort");

			expect(outcome).toBeInstanceOf(PromptDroppedError);
			expect(streamCalls).toBe(0);
			expect(session?.agent.state.messages.filter(message => message.role === "user")).toEqual([]);
			expect(mode?.composer.text()).toBe("");
			expect(mode?.composer.pendingImages).toEqual([]);
		});

		it("still restores untagged dropped input to the editor (positive control)", async () => {
			const outcome = await sendAndAbort("typed input aborted before admission", undefined);

			expect(outcome).toBeInstanceOf(PromptDroppedError);
			expect(mode?.composer.text()).toBe("typed input aborted before admission");
			expect(mode?.composer.pendingImages).toEqual([IMAGE]);
		});
	});

	it("rejects a queued skill a session switch discarded, and delivers it nowhere", async () => {
		const kickoff = heldTurn();
		const created = await createSession([kickoff.response, unexpectedTurn]);
		const turn = created.prompt("kickoff");
		await withTimeout(kickoff.started, 5_000, "Kickoff turn never started");

		const normalization = holdImageNormalization();
		const sent = outcomeOf(
			created.sendUserMessage([{ type: "text", text: SKILL_INVOCATION }, IMAGE], {
				expand: true,
				deliverAs: "aside",
				tag: "skill-switch",
			}),
		);
		await withTimeout(normalization.started, 5_000, "Skill image normalization never started");
		// Replaces the session the aside was meant for; its generation change makes the queue discard it.
		kickoff.release();
		await created.newSession();
		normalization.release();

		expect(await withTimeout(sent, 10_000, "sendUserMessage never settled")).toBeInstanceOf(PromptDroppedError);
		await turn.catch(() => undefined);
		await created.waitForIdle();
		// Nowhere: not in the new transcript, not on a queue, and no turn ran for it.
		const transcript = JSON.stringify(created.agent.state.messages);
		expect(transcript).not.toContain(SKILL_BODY);
		expect(transcript).not.toContain(SKILL_INVOCATION);
		expect(created.agent.peekSteeringQueue()).toEqual([]);
		expect(created.agent.peekFollowUpQueue()).toEqual([]);
		expect(streamCalls).toBe(1);
	});

	describe("a session disposed while the message is prepared", () => {
		it("rejects a queued user message instead of answering prompt", async () => {
			const created = await createSession([unexpectedTurn]);
			const normalization = holdImageNormalization();
			const sent = outcomeOf(
				created.sendUserMessage([{ type: "text", text: "forwarded during disposal" }, IMAGE], {
					deliverAs: "steer",
					tag: "msg-dispose",
				}),
			);
			await withTimeout(normalization.started, 5_000, "Normalization never started");
			const disposing = created.dispose();
			expect(created.isDisposed).toBe(true);
			normalization.release();

			expect(await withTimeout(sent, 10_000, "sendUserMessage never settled")).toBeInstanceOf(PromptDroppedError);
			await disposing;
			session = undefined;
			expect(streamCalls).toBe(0);
		});

		it("rejects a skill queued behind a running turn instead of answering skill", async () => {
			const kickoff = heldTurn();
			const created = await createSession([kickoff.response, unexpectedTurn]);
			const turn = created.prompt("kickoff");
			await withTimeout(kickoff.started, 5_000, "Kickoff turn never started");

			const normalization = holdImageNormalization();
			const sent = outcomeOf(
				created.sendUserMessage([{ type: "text", text: SKILL_INVOCATION }, IMAGE], {
					expand: true,
					deliverAs: "steer",
					tag: "skill-dispose",
				}),
			);
			await withTimeout(normalization.started, 5_000, "Skill image normalization never started");
			const disposing = created.dispose();
			expect(created.isDisposed).toBe(true);
			normalization.release();
			kickoff.release();

			expect(await withTimeout(sent, 10_000, "sendUserMessage never settled")).toBeInstanceOf(PromptDroppedError);
			await turn.catch(() => undefined);
			await disposing;
			session = undefined;
			expect(streamCalls).toBe(1);
		});
	});
});
