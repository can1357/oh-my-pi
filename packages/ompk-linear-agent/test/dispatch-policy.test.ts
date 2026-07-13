import { describe, expect, it } from "bun:test";
import {
	type DispatchConfig,
	evaluateDispatch,
	type IssueSnapshot,
	resolveDispatchConfig,
	type WebhookEventInfo,
} from "../src/dispatch-policy";

const CONFIG: DispatchConfig = {
	agentUserId: "agent-user-1",
	allowedProjectIds: ["proj-1"],
	allowedModels: ["combo-a", "combo-b"],
};

function makeEvent(overrides: Partial<WebhookEventInfo> = {}): WebhookEventInfo {
	return {
		type: "Issue",
		action: "update",
		deliveryId: "delivery-1",
		issueId: "issue-1",
		...overrides,
	};
}

function makeIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
	return {
		id: "issue-1",
		identifier: "OMP-1",
		title: "Do the thing",
		description: "details",
		labels: ["model:combo-a", "Queue/Queued"],
		assigneeId: "agent-user-1",
		projectId: "proj-1",
		updatedAt: "2026-07-13T00:00:00.000Z",
		...overrides,
	};
}

describe("resolveDispatchConfig", () => {
	it("fails closed when any allowlist input is missing or empty", () => {
		expect(resolveDispatchConfig({})).toBeNull();
		expect(
			resolveDispatchConfig({ LINEAR_AGENT_USER_ID: "u", ALLOWED_PROJECT_IDS: "", ALLOWED_MODELS: "m" }),
		).toBeNull();
		expect(
			resolveDispatchConfig({ LINEAR_AGENT_USER_ID: " ", ALLOWED_PROJECT_IDS: "p", ALLOWED_MODELS: "m" }),
		).toBeNull();
	});

	it("parses comma-separated allowlists with whitespace tolerance", () => {
		const config = resolveDispatchConfig({
			LINEAR_AGENT_USER_ID: "agent-user-1",
			ALLOWED_PROJECT_IDS: " proj-1 , proj-2 ,",
			ALLOWED_MODELS: "combo-a",
		});
		expect(config).toEqual({
			agentUserId: "agent-user-1",
			allowedProjectIds: ["proj-1", "proj-2"],
			allowedModels: ["combo-a"],
		});
	});
});

describe("evaluateDispatch", () => {
	it("authorizes the explicit admission state and derives a revision-scoped dedupe key", () => {
		const decision = evaluateDispatch(makeEvent(), makeIssue(), CONFIG);
		expect(decision).toEqual({
			dispatch: true,
			model: "combo-a",
			dedupeKey: "delivery-1:issue-1:2026-07-13T00:00:00.000Z",
		});
	});

	it("rejects non-Issue and non-dispatchable actions", () => {
		expect(evaluateDispatch(makeEvent({ type: "Comment" }), makeIssue(), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent({ action: "remove" }), makeIssue(), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent({ action: undefined }), makeIssue(), CONFIG).dispatch).toBe(false);
	});

	it("rejects events without a delivery id or issue revision", () => {
		expect(evaluateDispatch(makeEvent({ deliveryId: null }), makeIssue(), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent(), makeIssue({ updatedAt: null }), CONFIG).dispatch).toBe(false);
	});

	it("requires the Queue/Queued admission label — a model label alone never dispatches", () => {
		const decision = evaluateDispatch(makeEvent(), makeIssue({ labels: ["model:combo-a"] }), CONFIG);
		expect(decision.dispatch).toBe(false);
	});

	it("rejects conflicting Queue/* labels", () => {
		const decision = evaluateDispatch(
			makeEvent(),
			makeIssue({ labels: ["model:combo-a", "Queue/Queued", "Queue/Ready"] }),
			CONFIG,
		);
		expect(decision.dispatch).toBe(false);
	});

	it("rejects wrong assignee, wrong project, and unlisted model", () => {
		expect(evaluateDispatch(makeEvent(), makeIssue({ assigneeId: "someone-else" }), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent(), makeIssue({ assigneeId: null }), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent(), makeIssue({ projectId: "proj-999" }), CONFIG).dispatch).toBe(false);
		expect(evaluateDispatch(makeEvent(), makeIssue({ projectId: null }), CONFIG).dispatch).toBe(false);
		expect(
			evaluateDispatch(makeEvent(), makeIssue({ labels: ["model:evil", "Queue/Queued"] }), CONFIG).dispatch,
		).toBe(false);
	});

	it("rejects issues with no model label", () => {
		expect(evaluateDispatch(makeEvent(), makeIssue({ labels: ["Queue/Queued"] }), CONFIG).dispatch).toBe(false);
	});
});
