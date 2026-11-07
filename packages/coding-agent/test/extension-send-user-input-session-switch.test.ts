/**
 * `sendUserMessage("/skill:…", { expand: true, deliverAs: "aside", tag })` when a
 * `newSession()` commits while the skill's images are still being normalized.
 *
 * The aside belongs to the session that has just been replaced, so the session
 * discards it rather than letting it land in the new transcript. The call must
 * then answer `dropped`: a bridge that reads `skill` as "submitted" would report
 * input that was never delivered and would never retry it. The second assertion
 * is what stops the first from passing for the wrong reason — the text must be
 * nowhere: not in the new session's messages, not on either queue, and no turn
 * may run for it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as path from "node:path";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

const SKILL_BODY = "Review the supplied code for risks.";
const SKILL_INVOCATION = "/skill:reviewer focus on risks";

describe("sendUserMessage(expand) racing a session switch", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let tempDir: TempDir | undefined;
	const restores: Array<() => void> = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-send-user-input-switch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		await Bun.write(
			path.join(tempDir.path(), "SKILL.md"),
			`---\nname: reviewer\ndescription: Review code\n---\n\n${SKILL_BODY}\n`,
		);
	});

	afterAll(() => {
		tempDir?.[Symbol.dispose]();
		tempDir = undefined;
	});

	beforeEach(() => {
		initTheme();
	});

	afterEach(async () => {
		for (const restore of restores.splice(0)) restore();
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	/** Holds image normalization for image-bearing calls until released. */
	function holdImageNormalization() {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const spy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			started.resolve();
			await release.promise;
			return images;
		});
		restores.push(() => spy.mockRestore());
		return { started: started.promise, release: () => release.resolve() };
	}

	it("reports a queued skill discarded by the session switch as dropped, and delivers it nowhere", async () => {
		const dir = tempDir?.path();
		if (!dir) throw new Error("Expected a temp dir");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({
				responses: [
					async () => {
						streamCalls++;
						turnStarted.resolve();
						await releaseTurn.promise;
						return { content: ["kickoff done"] };
					},
					() => {
						streamCalls++;
						return { content: ["must not run for the discarded skill"] };
					},
				],
			}).stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			skills: [
				{
					name: "reviewer",
					description: "Review code",
					filePath: path.join(dir, "SKILL.md"),
					baseDir: dir,
					source: "project",
				},
			],
			skillsSettings: { enableSkillCommands: true },
		});
		session = created;

		// A turn must be running so the skill takes the queue branch rather than
		// starting its own turn.
		const turn = created.prompt("kickoff");
		await withTimeout(turnStarted.promise, 5_000, "Kickoff turn never started");

		const normalization = holdImageNormalization();
		const sent = created.sendUserMessage([{ type: "text", text: SKILL_INVOCATION }, IMAGE], {
			expand: true,
			deliverAs: "aside",
			tag: "skill-switch",
		});
		await withTimeout(normalization.started, 5_000, "Skill image normalization never started");

		// Replaces the session the aside was meant for; its generation bump is what
		// makes the queue discard the record.
		releaseTurn.resolve();
		await created.newSession();
		normalization.release();

		const result = await withTimeout(sent, 10_000, "sendUserMessage never settled");
		await turn.catch(() => undefined);
		await created.waitForIdle();

		expect(result).toEqual({ handled: "dropped" });
		// Nowhere: not submitted into the new transcript, not left on a queue, no turn.
		const transcript = JSON.stringify(created.agent.state.messages);
		expect(transcript).not.toContain(SKILL_BODY);
		expect(transcript).not.toContain(SKILL_INVOCATION);
		expect(created.agent.peekSteeringQueue()).toEqual([]);
		expect(created.agent.peekFollowUpQueue()).toEqual([]);
		expect(streamCalls).toBe(1);
	});
});
