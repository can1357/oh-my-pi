import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	isPreviewResolutionToolCall,
	isProposeToolCall,
	type PlanProposalHandler,
	proposeDispatchDetails,
	resolveDispatchDetails,
	specialToolCommands,
} from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { ToolCommandDispatch } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import {
	PROPOSE_COMMAND_NAME,
	REJECT_COMMAND_NAME,
	RESOLVE_COMMAND_NAME,
	resolveRenderer,
	type ResolveDetails,
} from "@oh-my-pi/pi-tui/tools/resolve";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
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

function command(session: ToolSession, name: string): Tool {
	const tool = specialToolCommands(session).find(candidate => candidate.name === name);
	if (!tool) throw new Error(`Tool ${name} is not available`);
	return tool;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/** A completed `bash` execution result carrying one dispatch record. */
function bashResult(toolCommands: ToolCommandDispatch[]): unknown {
	return { details: { toolCommands } };
}

describe("special tool commands", () => {
	it("errors and clears stale pending markers when resolve has no invoker", async () => {
		let clearRuns = 0;
		const session = createSession({
			clearPendingInvokers: () => {
				clearRuns++;
			},
		});
		await expect(command(session, RESOLVE_COMMAND_NAME).execute("call", { reason: "looks correct" })).rejects.toThrow(
			"No pending action to apply — `resolve` is only valid while a staged preview is pending.",
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
		const result = await command(session, REJECT_COMMAND_NAME).execute("call", {
			reason: "Abandoning the staged edit.",
		});
		expect(result.isError ?? false).toBe(false);
		expect(getText(result)).toContain("Nothing to reject");
		expect(result.details).toMatchObject({ action: "discard", reason: "Abandoning the staged edit." });
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
		const result = await command(createSession({ handler }), REJECT_COMMAND_NAME).execute("call", {
			reason: "Preview changed wrong callsites",
		});

		expect(getText(result)).toContain("Rejected pending preview.");
		expect(rejectedReason).toBe("Preview changed wrong callsites");
		expect(result.details).toEqual({
			action: "discard",
			reason: "Preview changed wrong callsites",
			sourceToolName: "ast_edit",
			label: "AST Edit: 2 replacements in 1 file",
		});
	});

	it("applies through the pending invoker", async () => {
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
		const result = await command(createSession({ handler }), RESOLVE_COMMAND_NAME).execute("call", {
			reason: "Preview is correct",
		});

		expect(appliedReason).toBe("Preview is correct");
		expect(getText(result)).toContain("Applied 1 replacement in 1 file.");
		expect(result.details).toEqual({
			action: "apply",
			reason: "Preview is correct",
			sourceToolName: "ast_edit",
			label: "AST Edit: 1 replacement in 1 file",
		});
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
		const result = await command(createSession({ proposalHandler }), PROPOSE_COMMAND_NAME).execute("call", {
			title: "demo",
		});
		expect(proposedTitle).toBe("demo");
		expect(getText(result)).toContain("Plan ready for approval.");
		expect(result.details).toMatchObject({ title: "demo", planFilePath: "local://demo-plan.md" });
	});

	it("fails propose with a message when no plan is awaiting approval", async () => {
		await expect(command(createSession(), PROPOSE_COMMAND_NAME).execute("call", { title: "demo" })).rejects.toThrow(
			"No plan is awaiting approval",
		);
	});
});

describe("special command tool-call predicates", () => {
	it("matches a direct resolve or reject call, or a bash line starting with the command word", () => {
		expect(isPreviewResolutionToolCall({ name: "resolve" })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "reject" })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "bash", arguments: { command: "resolve looks right" } })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "bash", arguments: { command: "reject wrong" } })).toBe(true);
		expect(isPreviewResolutionToolCall({ name: "propose" })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "write", arguments: { path: "/tmp/notes.md" } })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "bash", arguments: { command: "echo resolve" } })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "bash", arguments: { command: "grep -r resolve src" } })).toBe(false);
		expect(isPreviewResolutionToolCall({ name: "bash" })).toBe(false);
	});

	it("matches a direct propose call or a bash line starting with propose", () => {
		expect(isProposeToolCall({ name: "propose" })).toBe(true);
		expect(isProposeToolCall({ name: "bash", arguments: { command: "propose demo" } })).toBe(true);
		expect(isProposeToolCall({ name: "resolve" })).toBe(false);
		expect(isProposeToolCall({ name: "bash", arguments: { command: "echo propose demo" } })).toBe(false);
		expect(isProposeToolCall({ name: "ask", arguments: {} })).toBe(false);
	});
});

describe("resolution dispatch details", () => {
	it("reads details from a direct resolve or reject result", () => {
		const details: ResolveDetails = { action: "apply", reason: "ok", sourceToolName: "ast_edit", label: "AST Edit" };
		expect(resolveDispatchDetails(RESOLVE_COMMAND_NAME, { details })).toEqual(details);
		expect(resolveDispatchDetails(REJECT_COMMAND_NAME, { details: { ...details, action: "discard" } })).toEqual({
			...details,
			action: "discard",
		});
		expect(resolveDispatchDetails(RESOLVE_COMMAND_NAME, { details: { reason: "no action" } })).toBeUndefined();
	});

	it("reads the last resolve or reject dispatch from a bash result", () => {
		const result = bashResult([
			{ tool: "resolve", mode: "execute", exitCode: 0, inner: { action: "apply", reason: "first" } },
			{ tool: "reject", mode: "execute", exitCode: 0, inner: { action: "discard", reason: "second" } },
		]);
		expect(resolveDispatchDetails("bash", result)).toEqual({ action: "discard", reason: "second" });
	});

	it("ignores help, failed, and unrelated dispatches on a bash result", () => {
		const result = bashResult([
			{ tool: "resolve", mode: "help", exitCode: 0, inner: { action: "apply", reason: "help" } },
			{ tool: "grep", mode: "execute", exitCode: 0, inner: { action: "apply", reason: "other" } },
			{ tool: "resolve", mode: "execute", exitCode: 1 },
		]);
		expect(resolveDispatchDetails("bash", result)).toBeUndefined();
		expect(resolveDispatchDetails("resolve", result)).toBeUndefined();
	});

	it("reads a direct propose result but not a failed one", () => {
		const details = { planFilePath: "local://demo-plan.md", title: "demo", planExists: true };
		expect(proposeDispatchDetails(PROPOSE_COMMAND_NAME, { details })).toEqual(details);
		expect(proposeDispatchDetails(PROPOSE_COMMAND_NAME, { details, isError: true })).toBeUndefined();
	});

	it("reads the last successful propose dispatch from a bash result", () => {
		const result = bashResult([
			{ tool: "propose", mode: "execute", exitCode: 0, inner: { title: "first" } },
			{ tool: "propose", mode: "execute", exitCode: 1, inner: { title: "failed" } },
			{ tool: "propose", mode: "execute", exitCode: 0, inner: { title: "second" } },
		]);
		expect(proposeDispatchDetails("bash", result)).toEqual({ title: "second" });
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
