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
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseQueueShorthand } from "@oh-my-pi/pi-tui/prompt/queue-input";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const QUEUE_LIST = "=>\n1. ITEM ONE\n2. ITEM TWO\n3. ITEM THREE";

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

	async function setup(skillCommands = new Map<string, Skill>(), extensionFactory?: ExtensionFactory) {
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
		const sessionManager = SessionManager.inMemory();
		let extensionRunner: ExtensionRunner | undefined;
		if (extensionFactory) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				extensionFactory,
				process.cwd(),
				new EventBus(),
				runtime,
				"queue-test",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
		}
		const live = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		session = live;
		live.setFollowUpMode("one-at-a-time", false);
		// The transcript must end in an assistant turn: that is the tail the idle drain resumes from.
		await live.prompt("earlier turn");
		await live.waitForIdle();
		mock.reset();

		const dropped: DroppedPrompt[] = [];
		live.setPromptDropped(prompt => dropped.push(prompt));

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
			clearDraft() {
				text = "";
				this.pendingImages = [];
				this.pendingImageLinks = [];
				this.imageLinks = undefined;
			},
		};
		const showError = vi.fn();
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
			restoreDroppedPrompt: (prompt: DroppedPrompt) => dropped.push(prompt),
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
			recordLocalSubmission: () => () => {},
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
			startPendingSubmission: (input: Omit<SubmittedUserInput, "cancelled" | "started">) => ({
				...input,
				cancelled: false,
				started: false,
			}),
			// The interactive run loop: it dispatches a submission through submitInteractiveInput
			// only after the input handler that handed it over has returned.
			onInputCallback: (submission: SubmittedUserInput) => {
				pending = submission;
			},
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx);
		const submitList = async (list = QUEUE_LIST, duringDispatch?: () => Promise<void>) => {
			editor.setText(list);
			const body = parseQueueShorthand(list);
			if (body === undefined) throw new Error("Expected queue shorthand");
			await controller.handleQueueCommand(body);
			if (!pending) throw new Error("Expected the first item to be handed to the run loop");
			const dispatched = submitInteractiveInput(mode, live, pending);
			await duringDispatch?.();
			await dispatched;
			await live.waitForIdle();
		};
		/** Answer the first item's API-key lookup with `key()`; the seed turn already ran. */
		const setApiKey = (key: () => Promise<string | undefined>) => {
			apiKey = key;
		};
		return { session: live, mock, dropped, showError, submitList, setApiKey };
	}

	async function writeSkill(name: string): Promise<Skill> {
		const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-queue-skill-"));
		cleanupDirs.push(skillDir);
		const filePath = path.join(skillDir, `${name}.md`);
		await fs.writeFile(filePath, `---\nname: ${name}\n---\nSummarize recent changes.\n`);
		return { name, description: "", filePath, baseDir: skillDir, source: "test" };
	}

	/** Hold the first item's turn setup after admission (the rest is queued) until `release`. */
	function holdSetup(setApiKey: (key: () => Promise<string | undefined>) => void) {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		setApiKey(async () => {
			reached.resolve();
			await release.promise;
			return "test-key";
		});
		return { reached: reached.promise, release: () => release.resolve() };
	}

	it("sends the first item before the queued follow-ups", async () => {
		const { mock, dropped, submitList } = await setup();

		await submitList();

		expect(requestedPrompts(mock)).toEqual(["ITEM ONE", "ITEM TWO", "ITEM THREE"]);
		expect(dropped).toEqual([]);
	});

	it("sends a /skill: first item before the queued follow-ups", async () => {
		const skill = await writeSkill("recap");
		const { mock, submitList } = await setup(new Map([["skill:recap", skill]]));

		await submitList("=>\n1. /skill:recap now\n2. ITEM TWO\n3. ITEM THREE");

		const prompts = requestedPrompts(mock);
		expect(prompts[0]).toContain("Summarize recent changes.");
		expect(prompts.slice(1)).toEqual(["ITEM TWO", "ITEM THREE"]);
	});

	it("hands the whole list back when the first item's setup fails", async () => {
		const { session, mock, dropped, showError, submitList, setApiKey } = await setup();
		setApiKey(async () => undefined);

		await submitList();

		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(dropped).toEqual([{ text: "ITEM ONE", followUps: ["ITEM TWO", "ITEM THREE"] }]);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("No API key found"));
	});

	it("hands the whole list back when a /skill: first item fails before reaching the session", async () => {
		const skill = await writeSkill("gone");
		const { session, mock, dropped, submitList } = await setup(new Map([["skill:gone", skill]]));
		await fs.rm(skill.filePath);

		await submitList("=>\n1. /skill:gone now\n2. ITEM TWO\n3. ITEM THREE");

		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(dropped).toEqual([{ text: "/skill:gone now", followUps: ["ITEM TWO", "ITEM THREE"] }]);
	});

	it("keeps the list together when Esc lands while the first item is in setup", async () => {
		const { session, mock, dropped, submitList, setApiKey } = await setup();
		const setup1 = holdSetup(setApiKey);
		let restoredFromQueue: string[] | undefined;

		await submitList(QUEUE_LIST, async () => {
			await setup1.reached;
			// InputController's Esc: restore the queue to the editor, then abort.
			restoredFromQueue = session.clearQueue({ forInterrupt: true }).followUp.map(message => message.text);
			void session.abort({ reason: USER_INTERRUPT_LABEL });
			setup1.release();
		});

		expect(restoredFromQueue).toEqual([]);
		expect(requestedPrompts(mock)).toEqual([]);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(dropped).toEqual([{ text: "ITEM ONE", followUps: ["ITEM TWO", "ITEM THREE"] }]);
	});

	it("never runs the follow-ups on their own when an abort drops the first item during setup", async () => {
		const { session, mock, dropped, submitList, setApiKey } = await setup();
		const setup1 = holdSetup(setApiKey);

		await submitList(QUEUE_LIST, async () => {
			await setup1.reached;
			// Let the abort settle (and its stranded-queue drain run) while the setup is still parked.
			await session.abort();
			setup1.release();
		});

		expect(requestedPrompts(mock)).toEqual([]);
		expect(dropped).toEqual([{ text: "ITEM ONE", followUps: ["ITEM TWO", "ITEM THREE"] }]);
	});

	it("keeps the follow-ups from a run that starts while the first item is in setup", async () => {
		const { session, mock, submitList, setApiKey } = await setup();
		const setup1 = holdSetup(setApiKey);

		await submitList(QUEUE_LIST, async () => {
			await setup1.reached;
			// An autonomous run (an IRC wake) claims the agent before the first item goes live.
			await session.agent.prompt({
				role: "user",
				content: [{ type: "text", text: "AUTONOMOUS" }],
				attribution: "agent",
				timestamp: Date.now(),
			});
			setup1.release();
		});

		expect(requestedPrompts(mock)).toEqual(["AUTONOMOUS", "ITEM ONE", "ITEM TWO", "ITEM THREE"]);
	});

	it("queues the follow-ups only once an extension command first item has finished", async () => {
		let queuedDuringCommand: readonly string[] | undefined;
		const { mock, submitList } = await setup(undefined, pi => {
			pi.registerCommand("note", {
				handler: async () => {
					queuedDuringCommand = session?.getQueuedMessages().followUp;
				},
			});
		});

		await submitList("=>\n1. /note hi\n2. ITEM TWO\n3. ITEM THREE");

		expect(queuedDuringCommand).toEqual([]);
		expect(requestedPrompts(mock)).toEqual(["ITEM TWO", "ITEM THREE"]);
	});

	it("hands the list back when an extension command first item fails", async () => {
		const { mock, dropped, submitList } = await setup(undefined, pi => {
			pi.registerCommand("note", {
				handler: async () => {
					throw new Error("note failed");
				},
			});
		});

		await submitList("=>\n1. /note hi\n2. ITEM TWO\n3. ITEM THREE");

		expect(requestedPrompts(mock)).toEqual([]);
		expect(dropped).toEqual([{ text: "/note hi", followUps: ["ITEM TWO", "ITEM THREE"] }]);
	});

	it("refuses a list with a later extension command before sending any of it", async () => {
		const { mock, dropped, showError, submitList } = await setup(undefined, pi => {
			pi.registerCommand("note", { handler: async () => {} });
		});

		await submitList("=>\n1. ITEM ONE\n2. /note hi\n3. ITEM THREE");

		expect(requestedPrompts(mock)).toEqual([]);
		expect(dropped).toEqual([{ text: "ITEM ONE", followUps: ["/note hi", "ITEM THREE"] }]);
		expect(showError).toHaveBeenCalledWith(expect.stringContaining('"/note"'));
	});
});
