/**
 * `sendUserMessage(text, { expand: true, tag })` when abort() lands before the
 * prompt is admitted.
 *
 * Two contracts a bridge depends on:
 *  - the result must not say `prompt` for a message that was never submitted —
 *    a consumer that calls `turnSubmitted(...)` on `prompt` would report an
 *    aborted send as delivered;
 *  - tagged input is the sender's to retry, so it must never be handed back to
 *    the interactive editor as text the person has to notice and resend.
 * Untagged input keeps the old restoration behavior (the positive control).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

describe("sendUserMessage(expand) racing abort", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	const restores: Array<() => void> = [];
	let streamCalls = 0;
	let tempDir: TempDir | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-send-user-input-abort-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
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
		mode = undefined;
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
	});

	async function start(): Promise<{ session: AgentSession; mode: InteractiveMode }> {
		streamCalls = 0;
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({
				responses: [
					() => {
						streamCalls++;
						return { content: ["should not run"] };
					},
				],
			}).stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session = created;
		// The real host, not a bare callback: its constructor installs the
		// setPromptDropped hook that owns editor restoration.
		const created_mode = new InteractiveMode(created, "test");
		created_mode.ui.requestRender = vi.fn();
		mode = created_mode;
		return { session: created, mode: created_mode };
	}

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

	async function sendAndAbort(text: string, tag: string | undefined) {
		const { session: s } = await start();
		const normalization = holdImageNormalization();
		const sent = s.sendUserMessage([{ type: "text", text }, IMAGE], { expand: true, tag });
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		await s.abort({ reason: USER_INTERRUPT_LABEL });
		normalization.release();
		return await sent;
	}

	it("reports an aborted tagged send as dropped, not as a submitted prompt", async () => {
		const result = await sendAndAbort("bridge input aborted before admission", "msg-abort");

		expect(result).toEqual({ handled: "dropped" });
		expect(streamCalls).toBe(0);
		expect(session?.agent.state.messages.filter(m => m.role === "user")).toEqual([]);
	});

	it("never hands tagged input back to the editor when it is dropped before admission", async () => {
		await sendAndAbort("bridge input aborted before admission", "msg-abort");

		expect(mode?.editor.getText()).toBe("");
		expect(mode?.editor.pendingImages).toEqual([]);
	});

	it("still restores untagged dropped input to the editor (positive control)", async () => {
		await sendAndAbort("typed input aborted before admission", undefined);

		expect(mode?.editor.getText()).toBe("typed input aborted before admission");
		expect(mode?.editor.pendingImages).toEqual([IMAGE]);
	});
});
