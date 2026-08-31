/**
 * Contract: every routed advisor note is mirrored as a structured
 * `advisor_note` session event alongside the legacy delivery (preserved card
 * or steered custom message). The event is best-effort — a host that ignores
 * it loses nothing — but when it is emitted, its `deliveredAs` must match the
 * actual delivery path so headless hosts (RPC/ACP) can surface the advisory
 * without parsing transcript text.
 *
 * Two deterministic delivery seams, driven exactly like the existing advisor
 * suppression suite:
 *   - a late `concern` after a terminal text answer is preserved as a card
 *     (channel "preserve") → `deliveredAs: "card"`;
 *   - a late `blocker` after a terminal text answer still steers a corrective
 *     primary turn (blocker is exempt from terminal-answer preservation) →
 *     `deliveredAs: "steer"`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type AdvisorNoteEvent = Extract<AgentSessionEvent, { type: "advisor_note" }>;

interface AdvisorNoteHarness {
	session: AgentSession;
	mock: MockModel;
	advisorMock: MockModel;
	/** Resolves when the first `advisor_note` event is emitted to subscribers. */
	noteArrived: Promise<void>;
	noteEvents: AdvisorNoteEvent[];
}

function isAdvisorCard(message: AgentMessage): message is AgentMessage & { content: string } {
	if (message.role !== "custom") return false;
	if (!("content" in message) || typeof message.content !== "string") return false;
	if (!("customType" in message) || typeof message.customType !== "string") return false;
	return message.customType === "advisor";
}

describe("AgentSession advisor_note session event", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-note-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	/** Primary completes one terminal text turn; the advisor then raises one note. */
	async function createAdvisorNoteHarness(severity: "concern" | "blocker"): Promise<AdvisorNoteHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["EXACT VERDICT"], stopReason: "stop" },
				{ content: ["CHANGED VERDICT"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "Fixture verdict needs review", severity },
						},
					],
				},
				{ content: [], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const harnessSession = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		session = harnessSession;

		const noteEvents: AdvisorNoteEvent[] = [];
		const noteArrived = Promise.withResolvers<void>();
		harnessSession.subscribe(event => {
			if (event.type !== "advisor_note") return;
			noteEvents.push(event);
			noteArrived.resolve();
		});

		// Complete a terminal primary turn BEFORE enabling the advisor, so no
		// advisor auto-review can race the primary (mirrors the advisor
		// suppression suite). The advisor then raises one note on demand.
		await harnessSession.prompt("read five fixture files and answer with exactly one line");
		await harnessSession.waitForIdle();
		expect(mock.calls).toHaveLength(1);

		expect(harnessSession.setAdvisorEnabled(true)).toBe(true);
		const advisor = harnessSession.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		await advisor.prompt("inspect the completed turn");
		await harnessSession.waitForIdle();

		return { session: harnessSession, mock, advisorMock, noteArrived: noteArrived.promise, noteEvents };
	}

	it("mirrors a preserved advisor concern as advisor_note deliveredAs card", async () => {
		const { session: s, mock, noteArrived, noteEvents } = await createAdvisorNoteHarness("concern");
		await noteArrived;

		// Structured mirror of the preserved card.
		expect(noteEvents[0]).toMatchObject({
			type: "advisor_note",
			severity: "concern",
			note: "Fixture verdict needs review",
			deliveredAs: "card",
		});
		// The legacy delivery is still authoritative.
		const advisorCards = s.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards).toHaveLength(1);
		expect(advisorCards[0]!.content).toContain("Fixture verdict needs review");
		// A preserved concern must not wake the primary.
		expect(mock.calls).toHaveLength(1);
	});

	it("mirrors a steered advisor blocker as advisor_note deliveredAs steer", async () => {
		const { session: s, mock, noteArrived, noteEvents } = await createAdvisorNoteHarness("blocker");
		await noteArrived;

		expect(noteEvents[0]).toMatchObject({
			type: "advisor_note",
			severity: "blocker",
			note: "Fixture verdict needs review",
			deliveredAs: "steer",
		});
		// The steered blocker wakes the primary for a corrective turn.
		expect(mock.calls).toHaveLength(2);
		expect(s.agent.state.messages.filter(message => message.role === "custom")).toHaveLength(1);
	});

	it("never emits advisor_note for advisor notes dropped by the emission guard", async () => {
		const noteEvents: AdvisorNoteEvent[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: ["ONLY VERDICT"], stopReason: "stop" }],
		});
		// The advisor never raises: its only turn is a plain stop with no advise call.
		const advisorMock = createMockModel({ responses: [{ content: [], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		session.subscribe(event => {
			if (event.type === "advisor_note") noteEvents.push(event);
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("answer exactly one line");
		await session.waitForIdle();
		expect(await session.waitForAdvisorCatchup(1000)).toBe(true);

		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(0);
		expect(noteEvents).toEqual([]);
	});
});
