// The idle drain needs an assistant tail to reproduce item 2 overtaking item 1 (#10802).
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { parseQueueShorthand } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const QUEUE_LIST = "=>\n1. ITEM ONE\n2. ITEM TWO\n3. ITEM THREE";
const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

function requestedPrompts(mock: MockModel): string[] {
	return mock.calls.map(call => {
		const message = call.context.messages.findLast(message => message.role === "user");
		if (!message) return "";
		if (typeof message.content === "string") return message.content;
		return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
	});
}

describe("queue shorthand on an idle session with a transcript (#10802)", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	const cleanupDirs: string[] = [];

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		await Promise.all(cleanupDirs.splice(0).map(dir => removeWithRetries(dir)));
		vi.restoreAllMocks();
	});

	async function setup(skillCommands = new Map<string, Skill>()) {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const model = { ...mock, input: ["text", "image"] as ("text" | "image")[] };
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		let apiKey = async (): Promise<string | undefined> => "test-key";
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(() => apiKey());
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
		});
		session = live;
		live.setFollowUpMode("one-at-a-time", false);
		// The transcript must end in an assistant turn: that is the tail the idle drain resumes from.
		await live.prompt("earlier turn");
		await live.waitForIdle();
		mock.reset();

		let text = "";
		const editor = {
			pendingImages: [] as ImageContent[],
			pendingImageLinks: [] as (string | undefined)[],
			imageLinks: undefined as (string | undefined)[] | undefined,
			getText: () => text,
			getExpandedText: () => text,
			setText: (next: string) => {
				text = next;
			},
			setCollapsedText: (next: string) => {
				text = next;
			},
			clearDraft() {
				text = "";
				this.pendingImages = [];
				this.pendingImageLinks = [];
				this.imageLinks = undefined;
			},
		};
		// InteractiveMode's contract for a typed prompt dropped before dispatch: it goes back to an empty editor only.
		live.setPromptDropped(prompt => {
			if (editor.getText().trim()) return;
			editor.setText(prompt.text);
			editor.pendingImages = prompt.images ? [...prompt.images] : [];
		});
		const showError = vi.fn();
		// The interactive run loop: it dispatches a submission through submitInteractiveInput
		// only after the input handler that handed it over has returned.
		const mode = {
			markPendingSubmissionStarted: (input: SubmittedUserInput) => {
				input.started = true;
				return true;
			},
			finishPendingSubmission: () => {},
			showError,
			checkShutdownRequested: async () => {},
			skillCommands,
			optimisticSkillMessagePending: false,
			renderOptimisticSkillMessage: () => {},
			clearOptimisticSkillMessage: () => {},
		};
		let pending: SubmittedUserInput | undefined;
		const ctx = {
			editor,
			session: live,
			sessionManager: live.sessionManager,
			collabGuest: undefined,
			yieldCompaction: undefined,
			compactionQueuedMessages: [],
			ui: { requestRender: () => {} },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError,
			updatePendingMessagesDisplay: () => {},
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
			startPendingSubmission: (input: Omit<SubmittedUserInput, "cancelled" | "started">) => ({
				...input,
				cancelled: false,
				started: false,
			}),
			onInputCallback: (submission: SubmittedUserInput) => {
				pending = submission;
			},
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		const submitList = async (list = QUEUE_LIST, options?: { duringDispatch?: () => Promise<void> }) => {
			editor.setText(list);
			const body = parseQueueShorthand(list);
			if (body === undefined) throw new Error("Expected queue shorthand");
			await controller.handleQueueCommand(body);
			if (!pending) throw new Error("Expected the first item to be handed to the run loop");
			const dispatched = submitInteractiveInput(mode, live, pending);
			await options?.duringDispatch?.();
			await dispatched;
			await live.waitForIdle();
		};
		/** Answer the first item's API-key lookup with `key()`; the seed turn already ran. */
		const setApiKey = (key: () => Promise<string | undefined>) => {
			apiKey = key;
		};
		return { session: live, mock, editor, showError, submitList, setApiKey };
	}

	async function writeSkill(name: string): Promise<Skill> {
		const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-queue-skill-"));
		cleanupDirs.push(skillDir);
		const filePath = path.join(skillDir, `${name}.md`);
		await fs.writeFile(filePath, `---\nname: ${name}\n---\nSummarize recent changes.\n`);
		return { name, description: "", filePath, baseDir: skillDir, source: "test" };
	}

	it("sends the first item before the queued follow-ups", async () => {
		const { mock, editor, submitList } = await setup();

		await submitList();

		expect(requestedPrompts(mock)).toEqual(["ITEM ONE", "ITEM TWO", "ITEM THREE"]);
		expect(editor.getText()).toBe("");
	});

	it("sends a /skill: first item before the queued follow-ups", async () => {
		const skill = await writeSkill("recap");
		const { mock, submitList } = await setup(new Map([["skill:recap", skill]]));

		await submitList("=>\n1. /skill:recap now\n2. ITEM TWO\n3. ITEM THREE");

		const prompts = requestedPrompts(mock);
		expect(prompts[0]).toContain("Summarize recent changes.");
		expect(prompts.slice(1)).toEqual(["ITEM TWO", "ITEM THREE"]);
	});

	it("returns the whole list to the editor when the first item fails before reaching the agent", async () => {
		const { session, mock, editor, showError, submitList, setApiKey } = await setup();
		setApiKey(async () => undefined);

		await submitList();

		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(editor.getText()).toBe(QUEUE_LIST);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("No API key found"));
	});

	it("returns the whole list when the first item fails before the session admits it", async () => {
		const skill = await writeSkill("gone");
		const { session, mock, editor, submitList } = await setup(new Map([["skill:gone", skill]]));
		await fs.rm(skill.filePath);
		const list = "=>\n1. /skill:gone now\n2. ITEM TWO\n3. ITEM THREE";

		await submitList(list);

		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(editor.getText()).toBe(list);
	});

	it("returns the whole list once, in order, when Esc drops the first item while its image is prepared", async () => {
		const { session, mock, editor, submitList } = await setup();
		const normalizing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			normalizing.resolve();
			await release.promise;
			return images;
		});
		editor.pendingImages = [IMAGE];

		await submitList(QUEUE_LIST, {
			duringDispatch: async () => {
				await normalizing.promise;
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				release.resolve();
			},
		});

		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(editor.getText()).toBe(QUEUE_LIST);
		expect(editor.pendingImages).toEqual([IMAGE]);
	});
});
