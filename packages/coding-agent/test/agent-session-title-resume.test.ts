import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TITLE_CHANGE_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tmpDir: string | undefined;
// Suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind, which gates titling off.
let previousNoTitle: string | undefined;

beforeEach(async () => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
	forkRequests = 0;
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-title-resume-"));
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
	if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
	tmpDir = undefined;
});

/** The brief the dead session was launched with, as `omp "@brief.md"` sends it. */
const BRIEF = `<file name="/mnt/briefs/shellport-audit.md">
You are the ShellPortAudit lane. You own seven pull requests that were out of draft and are now
unmergeable, because upstream main deleted the vendored brush crates and rewrote the builtins.
Rebase each one onto live main, resolve the conflicts, re-run the shell suite and report.
</file>`;

/** What the dead session had already said when it was killed. */
const PRIOR_WORK =
	"Starting on the ShellPortAudit lane. Seven pull requests need rebasing onto live main after the vendored brush crates were deleted, so each one's conflicts have to be resolved against the new builtins before the shell suite can run again. I will take them oldest first and report once the suite is green.";

/** What the relaunched process sends instead of a message: an Envoy wake notice, which is a `custom` message. */
const WAKE_NOTICE = "Session relaunched by agentbox-run; the predecessor's transcript is carried.";

/** The reply the resumed session streams after the wake. */
const RESUMED_REPLY =
	"Picking the ShellPortAudit lane back up where the previous process stopped: three of the seven pull requests are still unrebased, so I will resolve their brush-builtin conflicts against live main and re-run the shell suite on each before reporting to the lead.";

/** Title requests the fork path started, which the title-model count alone cannot see. */
let forkRequests = 0;

/** The title fork declines, so every title here comes from the title model and is one countable call. */
const forkStream = createMockModel({ handler: { content: ["<title/>"] } }).stream;
const declineTitleFork: typeof forkStream = (...args) => {
	forkRequests++;
	return forkStream(...args);
};

/** Plain titles: a card request would double every title-model call and hide the bound under test. */
const PLAIN_TITLES = { "title.icons": "boring" };

/** The model every session here runs, and the one a switched-to transcript records. */
const TEST_MODEL_ID = "claude-sonnet-4-5";

/**
 * A real on-disk transcript of a session that did work and was killed: a `<file>`
 * brief, an assistant turn, and — unless `title` says otherwise — no title.
 */
async function writeDeadTranscript(dir: string, title?: string): Promise<string> {
	const file = path.join(dir, "dead.jsonl");
	const manager = await SessionManager.open(file, dir);
	if (title) await manager.setSessionName(title, "auto");
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: BRIEF }],
		attribution: "user",
		timestamp: Date.now(),
	});
	manager.appendMessage(createAssistantMessage(PRIOR_WORK));
	await manager.flush();
	return file;
}

/** A real on-disk transcript whose only turn names no task, so nothing can be titled from it. */
async function writeThinTranscript(dir: string): Promise<string> {
	const file = path.join(dir, "thin.jsonl");
	const manager = await SessionManager.open(file, dir);
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "hey" }],
		attribution: "user",
		timestamp: Date.now(),
	});
	await manager.flush();
	return file;
}

/** A second real on-disk transcript, untitled and with work of its own. */
async function writeOtherTranscript(dir: string): Promise<string> {
	const file = path.join(dir, "other.jsonl");
	const manager = await SessionManager.open(file, dir);
	// A switch restores the target's recorded model, and refuses the switch when
	// it cannot; the mock assistant turns carry no model a registry would know.
	manager.appendModelChange(`anthropic/${TEST_MODEL_ID}`);
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "port the broken-pipe tests to the new builtins and report" }],
		attribution: "user",
		timestamp: Date.now(),
	});
	manager.appendMessage(createAssistantMessage(PRIOR_WORK));
	await manager.flush();
	return file;
}

/** Reopen `file` the way a relaunch does, and build the session that carries its transcript. */
async function resume(file: string, settings: Record<string, unknown> = {}): Promise<AgentSession> {
	const sessionManager = await SessionManager.open(file);
	const restored = sessionManager.buildSessionContext();
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", TEST_MODEL_ID);
	if (!model) throw new Error(`Expected ${TEST_MODEL_ID} model to exist`);
	const main: MockModel = createMockModel({
		responses: [{ content: [RESUMED_REPLY] }, { content: [RESUMED_REPLY] }, { content: [RESUMED_REPLY] }],
	});
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: restored.messages },
			streamFn: main.stream,
		}),
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.modelFallback": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
			...PLAIN_TITLES,
			...settings,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
		sideStreamFn: declineTitleFork,
		autoTitle: true,
	});
	return session;
}

/** Deliver the relaunch's wake notice: a `custom` message, which is not an operator message. */
async function wake(target: AgentSession): Promise<void> {
	await target.promptCustomMessage({
		customType: "envoy-wake",
		content: [{ type: "text", text: WAKE_NOTICE }],
		display: true,
		attribution: "agent",
	});
	await target.waitForIdle();
}

/** `title_change` entries the session file carries. */
async function titleChanges(file: string): Promise<number> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(file).text());
	let count = 0;
	for (const entry of entries) {
		if (entry && typeof entry === "object" && "type" in entry && entry.type === TITLE_CHANGE_ENTRY_TYPE) count++;
	}
	return count;
}

describe("AgentSession names a resumed session that carries no operator message", () => {
	it("names a resumed untitled session from the transcript it carries", async () => {
		const file = await writeDeadTranscript(tmpDir!);
		const target = await resume(file);
		const titleInputs: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			const content = context.messages[0]?.content;
			titleInputs.push(typeof content === "string" ? content : "");
			return createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>");
		});

		await wake(target);
		await target.sessionManager.flush();

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		// One request, and it reads the carried transcript rather than the wake notice.
		expect(titleInputs).toHaveLength(1);
		expect(titleInputs[0]).toContain("ShellPortAudit");
		expect(await titleChanges(file)).toBe(1);
	});

	it("spends the resumed transcript's title budget once, however many turns the wake drives", async () => {
		// The bound. One resumed transcript buys what one operator message buys:
		// the request itself, plus the single context retitle its deferral allows
		// when the title model declines. Assistant turns never buy more, so a
		// relaunched session that works for hours costs two title calls, not one
		// per turn.
		const file = await writeDeadTranscript(tmpDir!);
		const target = await resume(file);
		const titleModel = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("<title/>"));

		await wake(target);
		const afterFirstWake = titleModel.mock.calls.length;
		await wake(target);
		await wake(target);

		// Still unnamed: the title model declined both times, and nothing retries.
		expect(target.sessionName).toBeUndefined();
		expect(afterFirstWake).toBe(2);
		expect(titleModel).toHaveBeenCalledTimes(2);
	});

	it("starts no title request of either kind when the resumed session already has a title", async () => {
		// Counting the title model alone would miss a title FORK at a named
		// session: the fork's own fallback declines to call the model, so the
		// count stays zero while a request has in fact been paid for.
		const file = await writeDeadTranscript(tmpDir!, "Rebase the ShellPortAudit pull requests");
		const target = await resume(file);
		const titleModel = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("<title>Something else</title>"));

		await wake(target);
		await target.sessionManager.flush();

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		expect(titleModel).not.toHaveBeenCalled();
		expect(forkRequests).toBe(0);
		expect(await titleChanges(file)).toBe(1);
	});

	it("reads the resumed transcript once, and never again from what later turns added", async () => {
		// The other half of the bound. A transcript that names no task is read at
		// the first reply and dropped: later turns do not make the session read it
		// again, so an untitleable resume costs no model call at all — it waits
		// for an operator message, as a session whose first message was "hey" does.
		const file = await writeThinTranscript(tmpDir!);
		const target = await resume(file);
		const titleModel = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"));

		await wake(target);
		await wake(target);
		await wake(target);

		expect(target.sessionName).toBeUndefined();
		expect(titleModel).not.toHaveBeenCalled();
	});

	it("spends the entitlement on the session that earned it, not on one switched to later", async () => {
		// The carried transcript earns ONE session a title try. Without that
		// binding the entitlement is a process-wide coupon: a session switched to
		// before the first reply spends it and gets named, while the same switch
		// after one reply does not — the same action naming a session or not,
		// depending on history. Switching is not a resume, and is not covered.
		const earned = await writeDeadTranscript(tmpDir!);
		const other = await writeOtherTranscript(tmpDir!);
		const target = await resume(earned);
		const titleModel = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"));

		expect(await target.switchSession(other)).toBe(true);
		await wake(target);

		expect(target.sessionName).toBeUndefined();
		expect(titleModel).not.toHaveBeenCalled();
	});

	it("does not revive the resumed transcript's try when its request is interrupted", async () => {
		// An interrupt revives an operator message's try, because the operator can
		// send it again. A transcript cannot be sent again, and reviving it let
		// every later wake start another request: three wakes, three calls, past
		// the one this resume is allowed.
		const file = await writeDeadTranscript(tmpDir!);
		const target = await resume(file, { "title.generator": "tiny" });
		const request = Promise.withResolvers<ai.AssistantMessage>();
		let calls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			calls++;
			return request.promise;
		});

		await wake(target);
		expect(calls).toBe(1);
		// `abort()` cancels the in-flight title request and rotates its controller.
		await target.abort();
		request.resolve(createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"));
		await wake(target);
		await wake(target);

		expect(target.sessionName).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("keeps the try when persistence moves the same transcript to a sibling file", async () => {
		// The discriminating case for keying to the conversation rather than the
		// persisted id. A write conflict makes SessionManager continue this very
		// transcript in a sibling file under a NEW id; keyed by id, the resume
		// would read its own persistence as a replaced conversation and lose the
		// try. A session switch cannot show this: it moves the id AND the
		// generation, so it passes either way.
		const file = await writeDeadTranscript(tmpDir!);
		const target = await resume(file);
		const before = target.sessionManager.getSessionId();
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"),
		);

		// Another process claims the journal underneath us.
		await Bun.write(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "claimed-by-someone-else", timestamp: new Date().toISOString(), cwd: tmpDir })}\n`,
		);
		await wake(target);
		await target.sessionManager.flush();

		expect(target.sessionManager.getSessionId()).not.toBe(before);
		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
	});
});
