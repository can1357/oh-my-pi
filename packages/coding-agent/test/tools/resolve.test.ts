import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	dispatchResolutionDevice,
	isPreviewResolutionToolCall,
	isProposeToolCall,
	type PlanProposalHandler,
	PROPOSE_DEVICE_NAME,
	PROPOSE_DEVICE_PATH,
	REJECT_DEVICE_NAME,
	REJECT_DEVICE_PATH,
	RESOLVE_DEVICE_NAME,
	RESOLVE_DEVICE_PATH,
	resolutionDeviceUsage,
	resolveRenderer,
	writeDeviceDispatch,
} from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { sanitizeText } from "@oh-my-pi/pi-utils";

function createSession(
	options: {
		handler?: (input: unknown) => Promise<unknown>;
		proposalHandler?: PlanProposalHandler;
		clearPendingInvokers?: () => void;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		peekQueueInvoker: options.handler ? () => options.handler : () => undefined,
		peekPlanProposalHandler: options.proposalHandler ? () => options.proposalHandler : () => undefined,
		clearPendingInvokers: options.clearPendingInvokers,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("dispatchResolutionDevice", () => {
	it("returns usage text for each device", () => {
		expect(resolutionDeviceUsage(RESOLVE_DEVICE_NAME)).toContain(RESOLVE_DEVICE_PATH);
		expect(resolutionDeviceUsage(REJECT_DEVICE_NAME)).toContain(REJECT_DEVICE_PATH);
		expect(resolutionDeviceUsage(PROPOSE_DEVICE_NAME)).toContain(PROPOSE_DEVICE_PATH);
	});

	it("errors and clears stale pending markers when resolve has no invoker", async () => {
		let clearRuns = 0;
		const session = createSession({
			clearPendingInvokers: () => {
				clearRuns++;
			},
		});
		await expect(dispatchResolutionDevice(session, RESOLVE_DEVICE_NAME, "looks correct")).rejects.toThrow(
			`No pending action to apply — ${RESOLVE_DEVICE_PATH} is only valid while a staged preview is pending.`,
		);
		expect(clearRuns).toBe(1);
	});

	it("treats reject with no pending action as a successful cancellation and clears stale markers", async () => {
		let clearRuns = 0;
		const session = createSession({
			clearPendingInvokers: () => {
				clearRuns++;
			},
		});
		const { result, xdev } = await dispatchResolutionDevice(
			session,
			REJECT_DEVICE_NAME,
			"Abandoning the staged edit.",
		);
		expect(result.isError ?? false).toBe(false);
		expect(getText(result)).toContain("Nothing to reject");
		expect(result.details).toMatchObject({ action: "discard", reason: "Abandoning the staged edit." });
		expect(xdev.inner).toMatchObject({ action: "discard" });
		expect(clearRuns).toBe(1);
	});

	it("rejects through the pending invoker", async () => {
		let rejectedReason: string | undefined;
		const handler = async (input: unknown) => {
			if (!input || typeof input !== "object" || !("action" in input) || !("reason" in input)) {
				throw new Error("invalid test input");
			}
			const action = input.action;
			const reason = input.reason;
			if (action === "discard" && typeof reason === "string") {
				rejectedReason = reason;
			}
			return {
				content: [{ type: "text", text: "Rejected pending preview." }],
				details: {
					action,
					reason,
					sourceToolName: "ast_edit",
					label: "AST Edit: 2 replacements in 1 file",
				},
			};
		};
		const { result, xdev } = await dispatchResolutionDevice(
			createSession({ handler }),
			REJECT_DEVICE_NAME,
			"Preview changed wrong callsites",
		);

		expect(getText(result)).toContain("Rejected pending preview.");
		expect(rejectedReason).toBe("Preview changed wrong callsites");
		expect(result.details).toEqual({
			action: "discard",
			reason: "Preview changed wrong callsites",
			sourceToolName: "ast_edit",
			label: "AST Edit: 2 replacements in 1 file",
		});
		expect(xdev.tool).toBe(REJECT_DEVICE_NAME);
	});

	it("applies through the pending invoker and carries dispatch metadata", async () => {
		let appliedReason: string | undefined;
		const handler = async (input: unknown) => {
			if (!input || typeof input !== "object" || !("action" in input) || !("reason" in input)) {
				throw new Error("invalid test input");
			}
			const action = input.action;
			const reason = input.reason;
			if (action === "apply" && typeof reason === "string") {
				appliedReason = reason;
			}
			return {
				content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
				details: {
					action,
					reason,
					sourceToolName: "ast_edit",
					label: "AST Edit: 1 replacement in 1 file",
				},
			};
		};
		const { result, xdev } = await dispatchResolutionDevice(
			createSession({ handler }),
			RESOLVE_DEVICE_NAME,
			"Preview is correct",
		);

		expect(appliedReason).toBe("Preview is correct");
		expect(getText(result)).toContain("Applied 1 replacement in 1 file.");
		expect(result.details).toEqual({
			action: "apply",
			reason: "Preview is correct",
			sourceToolName: "ast_edit",
			label: "AST Edit: 1 replacement in 1 file",
		});
		expect(writeDeviceDispatch("write", { details: { xdev } })?.tool).toBe(RESOLVE_DEVICE_NAME);
	});

	it("routes propose to the plan proposal handler", async () => {
		let proposedTitle = "";
		const proposalHandler: PlanProposalHandler = async (title: string) => {
			proposedTitle = title;
			return {
				content: [{ type: "text", text: "Plan ready for approval." }],
				details: { planFilePath: "local://demo-plan.md", title, planExists: true },
			};
		};
		const { result, xdev } = await dispatchResolutionDevice(
			createSession({ proposalHandler }),
			PROPOSE_DEVICE_NAME,
			"demo",
		);
		expect(proposedTitle).toBe("demo");
		expect(getText(result)).toContain("Plan ready for approval.");
		expect(xdev).toMatchObject({ tool: PROPOSE_DEVICE_NAME, mode: "execute", args: { title: "demo" } });
	});
});

describe("device tool-call predicates", () => {
	it("matches only writes targeting the preview-resolution devices", () => {
		expect(isPreviewResolutionToolCall({ name: "write", arguments: { path: RESOLVE_DEVICE_PATH } })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "write", arguments: { path: REJECT_DEVICE_PATH } })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "write", arguments: { path: PROPOSE_DEVICE_PATH } })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "write", arguments: { path: "/tmp/notes.md" } })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "edit", arguments: { path: RESOLVE_DEVICE_PATH } })).toBe(false);
	});

	it("matches only writes targeting xd://propose for plan decisions", () => {
		expect(isProposeToolCall({ name: "write", arguments: { path: PROPOSE_DEVICE_PATH } })).toBe(true);
		expect(isProposeToolCall({ name: "write", arguments: { path: RESOLVE_DEVICE_PATH } })).toBe(false);
		expect(isProposeToolCall({ name: "ask", arguments: {} })).toBe(false);
	});
});

it("renders a highlighted apply summary", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveRenderer.renderResult(
		{
			content: [{ type: "text", text: "Applied 2 replacements in 1 file." }],
			details: {
				action: "apply",
				reason: "All replacements are correct",
				sourceToolName: "ast_edit",
				label: "AST Edit: 2 replacements in 1 file",
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	const rendered = sanitizeText(component.render(90).join("\n"));
	expect(rendered).toContain("Accept: 2 replacements in 1 file");
	expect(rendered).toContain("AST Edit");
	expect(rendered).toContain("All replacements are correct");
	expect(rendered).not.toContain("Applied 2 replacements in 1 file.");
	expect(rendered).not.toContain("Decision");
	expect(rendered).not.toContain(uiTheme.boxRound.topLeft);
});

it("keeps the inverse block color across the full line (no mid-line fg reset)", async () => {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveRenderer.renderResult(
		{
			content: [{ type: "text", text: "Applied 2 replacements in 1 file." }],
			details: {
				action: "apply",
				reason: "All replacements are correct",
				sourceToolName: "ast_edit",
				label: "AST Edit: 2 replacements in 1 file",
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	for (const line of component.render(90)) {
		expect(line.split("\x1b[39m")).toHaveLength(2);
	}
});
