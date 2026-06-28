import { describe, expect, it } from "bun:test";
import { AutoLearnController, buildAutoLearnInstructions } from "@pk-nerdsaver-ai/pi-coding-agent/autolearn/controller";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";

interface CapturedNudge {
	message: { customType: string; content: string; display?: boolean; attribution?: string };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly sent: CapturedNudge[] = [];
	planEnabled = false;
	goalEnabled = false;
	/** Whether a triggerTurn dispatch actually starts a synthetic turn. */
	turnStarts = true;
	/** Force the dispatch to reject (models a failed send). */
	failSend = false;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async sendCustomMessage(message: CapturedNudge["message"], options?: CapturedNudge["options"]): Promise<boolean> {
		if (this.failSend) throw new Error("send failed");
		this.sent.push({ message, options });
		// Mirror AgentSession: a turn starts only when triggerTurn is honored.
		return options?.triggerTurn === true && this.turnStarts;
	}

	getPlanModeState(): { enabled: boolean } | undefined {
		return this.planEnabled ? { enabled: true } : undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(n: number): void {
		for (let i = 0; i < n; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: null });
		}
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	agentEnd(): void {
		this.emit({ type: "agent_end", messages: [] });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({ session: session as unknown as AgentSession, settings });
	return settings;
}

describe("AutoLearnController", () => {
	it("fires one passive nudge once the tool-call threshold is met", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();

		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.message.customType).toBe("autolearn-nudge");
		expect(session.sent[0]?.message.display).toBe(false);
		expect(session.sent[0]?.options?.deliverAs).toBe("nextTurn");
		expect(session.sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("the passive nudge is framed as additive — answer the user, capture alongside", () => {
		// Passive mode rides the user's real next message, so the nudge must
		// NOT tell the agent to stop after capturing — the user's message is
		// the real work. Locking in the content of #3504's fix so a later
		// edit cannot silently swap the two prompts.
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();
		const body = String(session.sent[0]?.message.content);
		expect(body).toMatch(/answer that message normally|in addition to|not a replacement/i);
		expect(body).not.toMatch(/wait for the user'?s next prompt/i);
		expect(body).not.toMatch(/then stop\.|do not resume prior work/i);
	});

	it("the auto-continue nudge is terminal — capture then stop, never assume approval (#3504)", () => {
		// Regression: with autoContinue on, the synthetic capture turn carries
		// the nudge as its only user-role payload. Without an explicit "stop /
		// not a user reply / do not assume approval" contract, the agent reads
		// its own unanswered prior question (e.g. "Want me to commit and
		// push?") as accepted and continues — exactly the scenario in #3504.
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		const body = String(session.sent[0]?.message.content);
		// Frames the prompt as automated, not as the user's response.
		expect(body).toMatch(/not a user reply|not from the user/i);
		// Forbids inferring approval / acting on pending questions.
		expect(body).toMatch(/not.*(approval|accept|pending|prior)/i);
		// Demands a hard stop after capture, with no continuation.
		expect(body).toMatch(/then stop\./i);
		expect(body).toMatch(/do not.*(continue|resume|other tools)/i);
		expect(body).toMatch(/wait for the user'?s next prompt/i);
	});

	it("does not nudge below the threshold", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(4);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});

	it("does not nudge during plan mode", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});
	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		// Neither turn reached the threshold; the counter must not accumulate.
		expect(session.sent).toHaveLength(0);
	});

	it("discards plan-mode tool calls instead of leaking them into the next turn", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session);
		session.toolCalls(5);
		session.agentEnd(); // plan mode: no fire, counter reset
		session.planEnabled = false;
		session.toolCalls(1);
		session.agentEnd(); // 1 < threshold -> no fire (no plan-mode leak)
		expect(session.sent).toHaveLength(0);
	});

	it("stops nudging when autolearn is disabled mid-session", () => {
		const session = new FakeSession();
		// Enable via the global layer (not an isolated override) so the live flag
		// can be flipped and the controller's fire-time re-check is exercised.
		const settings = Settings.isolated({});
		settings.set("autolearn.enabled", true);
		new AutoLearnController({ session: session as unknown as AgentSession, settings });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // fires while enabled
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		settings.set("autolearn.enabled", true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("does not nudge during goal mode and leaks no suppression latch", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		// Goal mode owns the continuation; auto-learn stays out of the loop.
		expect(session.sent).toHaveLength(0);
		// The skipped stop must not arm suppression for the next non-goal stop.
		session.goalEnabled = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("never nudges a turn that started in goal mode even if the goal ended mid-turn", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session);
		// The turn begins as a goal continuation...
		session.agentStart();
		session.toolCalls(5);
		// ...then a `goal` tool completes/drops the goal mid-turn: the live flag is
		// off by the time the turn stops, but this turn must still never be nudged.
		session.goalEnabled = false;
		session.agentEnd();
		expect(session.sent).toHaveLength(0);

		// The capture is per-turn: a fresh turn that did not start in goal mode
		// nudges normally, proving the latch resets.
		session.agentStart();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("auto-runs a capture turn and suppresses exactly one follow-up agent_end", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });

		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(true);

		// The synthetic capture turn's agent_end is swallowed.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);

		// Suppression is one-shot: the next qualifying stop fires again.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("disarms suppression when the capture turn is deferred (not started)", async () => {
		const session = new FakeSession();
		// triggerTurn honored but downgraded to a queue: no synthetic agent_end.
		session.turnStarts = false;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(true);
		await Bun.sleep(1); // flush the async disarm
		// No turn ran, so the next real stop must still nudge.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("disarms suppression when the capture-turn dispatch fails", async () => {
		const session = new FakeSession();
		session.failSend = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd(); // dispatch rejects: armed, then disarmed in .catch
		expect(session.sent).toHaveLength(0);
		await Bun.sleep(1); // flush the async disarm
		session.failSend = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("respects a custom minToolCalls threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});
});

describe("buildAutoLearnInstructions", () => {
	it("returns null when manage_skill is not in the active tool set", () => {
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: false })).toBeNull();
		// learn without manage_skill still yields no guidance (manage_skill gates it).
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: true })).toBeNull();
	});

	it("includes the learn addendum when the learn tool is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: true });
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("omits the learn addendum when only manage_skill is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: false });
		expect(text).toContain("manage_skill");
		expect(text).not.toContain("long-term memory");
	});
});
