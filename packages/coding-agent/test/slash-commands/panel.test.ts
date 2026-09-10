import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PanelRunResult, PanelSettings, PanelTaskMode } from "@oh-my-pi/pi-coding-agent/panel";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function panelistResult(status: "completed" | "failed" | "aborted", overrides?: Record<string, unknown>) {
	return {
		member: {
			index: 0,
			model: "anthropic/claude-opus-4-5",
			selector: "anthropic/claude-opus-4-5",
			modelId: "claude-opus-4-5",
			family: "claude",
		},
		status,
		output: status === "completed" ? "member output" : "",
		error: status === "completed" ? undefined : "member failed",
		truncated: false,
		durationMs: 100,
		tokens: 10,
		requests: 1,
		cost: 0,
		...overrides,
	};
}

function acpRuntime(overrides?: { runPanel?: (options: unknown) => Promise<unknown> }) {
	const runPanel = vi.fn(
		overrides?.runPanel ??
			(async () => ({
				results: [panelistResult("completed"), panelistResult("completed")],
				cancelled: false,
				usage: { tokens: 20, requests: 2, cost: 0.1 },
				synthesisInput: "synthesis prompt",
			})),
	);
	const output = vi.fn();
	const runtime = { session: { runPanel }, output } as unknown as SlashCommandRuntime;
	return { runPanel, output, runtime };
}

const SAVED_ROLE_PANEL_SETTINGS = {
	defaultRole: "saved",
	roles: {
		saved: {
			strategy: "independent",
			members: [{ model: "anthropic/claude-opus-4-5" }, { model: "openai/gpt-5.4" }],
		},
	},
	personas: {},
};

interface TuiRuntimeOverrides {
	readonly panelSettings?: unknown;
	readonly runPanel?: (options: unknown) => Promise<unknown>;
	readonly runPanelWithConfirmation?: (options: unknown) => Promise<PanelRunResult | undefined>;
	readonly showPanelRolePicker?: (settings: PanelSettings) => Promise<string | undefined>;
	readonly showPanelLineupBuilder?: (taskMode: PanelTaskMode, request: string) => Promise<PanelRunResult | undefined>;
}

function tuiRuntime(overrides: TuiRuntimeOverrides = {}) {
	const runPanel = vi.fn(
		overrides.runPanel ??
			(async () => ({
				results: [panelistResult("completed"), panelistResult("completed")],
				cancelled: false,
				usage: { tokens: 20, requests: 2, cost: 0.1 },
				synthesisInput: "tui synthesis prompt",
			})),
	);
	const runPanelWithConfirmation = vi.fn(
		overrides.runPanelWithConfirmation ??
			(async () =>
				({
					results: [panelistResult("completed"), panelistResult("completed")],
					cancelled: false,
					usage: { tokens: 20, requests: 2, cost: 0.1 },
					synthesisInput: "tui synthesis prompt",
				}) as unknown as PanelRunResult),
	);
	const showStatus = vi.fn();
	const setText = vi.fn();
	const showPanelRolePicker = vi.fn(overrides.showPanelRolePicker ?? (async () => undefined));
	const showPanelLineupBuilder = vi.fn(overrides.showPanelLineupBuilder ?? (async () => undefined));
	const panelSettings = overrides.panelSettings ?? SAVED_ROLE_PANEL_SETTINGS;
	const runtime = {
		ctx: {
			session: { runPanel },
			sessionManager: { getCwd: () => "/tmp" },
			settings: { get: vi.fn((key: string) => (key === "panel" ? panelSettings : undefined)) },
			showStatus,
			editor: { setText },
			showPanelRolePicker,
			runPanelWithConfirmation,
			showPanelLineupBuilder,
			refreshSlashCommandState: vi.fn(),
			refreshSkillState: vi.fn(),
		} as unknown as InteractiveModeContext,
	};
	return {
		runPanel,
		runPanelWithConfirmation,
		showStatus,
		setText,
		showPanelRolePicker,
		showPanelLineupBuilder,
		runtime,
	};
}

describe("/panel slash command", () => {
	it("resolves the default role for a bare answer invocation", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/panel answer what is the plan?", h.runtime);

		expect(h.runPanel).toHaveBeenCalledWith({ taskMode: "answer", request: "what is the plan?" });
		expect(result).toEqual({ prompt: "synthesis prompt" });
	});

	it("resolves a plan invocation with a named @role", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/panel plan @frontier ship the feature", h.runtime);

		expect(h.runPanel).toHaveBeenCalledWith({
			taskMode: "plan",
			request: "ship the feature",
			requestedRole: "frontier",
		});
	});

	it("preserves request whitespace after a named role", async () => {
		const h = acpRuntime();
		await executeAcpBuiltinSlashCommand("/panel plan @frontier  retain   this\tspacing", h.runtime);

		expect(h.runPanel).toHaveBeenCalledWith({
			taskMode: "plan",
			request: " retain   this\tspacing",
			requestedRole: "frontier",
		});
	});

	it("rejects an unknown mode without invoking the runner", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/panel debate what now?", h.runtime);

		expect(h.runPanel).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("Usage: /panel");
	});

	it("rejects a missing request without invoking the runner", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/panel answer", h.runtime);

		expect(h.runPanel).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("Usage: /panel");
	});

	it("rejects a role marker with no trailing request text", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/panel answer @frontier", h.runtime);

		expect(h.runPanel).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
	});

	it("propagates errors thrown by the runner", async () => {
		const h = acpRuntime({
			runPanel: async () => {
				throw new Error("no available models for role");
			},
		});

		await expect(executeAcpBuiltinSlashCommand("/panel answer anything?", h.runtime)).rejects.toThrow(
			"no available models for role",
		);
	});

	it("withholds partial synthesis in ACP because it cannot obtain a confirmation", async () => {
		const h = acpRuntime({
			runPanel: async () => ({
				results: [panelistResult("completed"), panelistResult("failed"), panelistResult("aborted")],
				cancelled: true,
				usage: { tokens: 30, requests: 3, cost: 0.125 },
				synthesisInput: "combined synthesis",
			}),
		});

		const result = await executeAcpBuiltinSlashCommand("/panel plan build it", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Panel: 1 completed, 1 failed, 1 aborted. Usage: 30 tokens, 3 requests, $0.1250. Partial synthesis requires confirmation in the interactive TUI.",
		);
		expect(result).not.toEqual({ prompt: "combined synthesis" });
	});

	it("skips synthesis when every ACP panel member is aborted", async () => {
		const h = acpRuntime({
			runPanel: async () => ({
				results: [panelistResult("aborted"), panelistResult("aborted")],
				cancelled: true,
				usage: { tokens: 0, requests: 0, cost: 0 },
				synthesisInput: "must not be returned",
			}),
		});

		const result = await executeAcpBuiltinSlashCommand("/panel answer build it", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Panel: 0 completed, 0 failed, 2 aborted. Usage: 0 tokens, 0 requests, $0.0000. No member completed; synthesis was skipped.",
		);
		expect(result).not.toEqual({ prompt: "must not be returned" });
	});

	it("synthesizes ACP results with member-only aborts", async () => {
		const h = acpRuntime({
			runPanel: async () => ({
				results: [panelistResult("completed"), panelistResult("aborted")],
				cancelled: false,
				usage: { tokens: 10, requests: 1, cost: 0.1 },
				synthesisInput: "timeout synthesis",
			}),
		});

		const result = await executeAcpBuiltinSlashCommand("/panel answer build it", h.runtime);

		expect(h.output).toHaveBeenCalledWith(
			"Panel: 1 completed, 0 failed, 1 aborted. Usage: 10 tokens, 1 request, $0.1000.",
		);
		expect(result).toEqual({ prompt: "timeout synthesis" });
	});

	it("consumes lineup and personas in ACP with a TUI-required status", async () => {
		for (const subcommand of ["lineup", "personas"] as const) {
			const h = acpRuntime();
			const result = await executeAcpBuiltinSlashCommand(`/panel ${subcommand} answer one-off request`, h.runtime);

			expect(result).toEqual({ consumed: true });
			expect(h.runPanel).not.toHaveBeenCalled();
			expect(h.output).toHaveBeenCalledWith(`/panel ${subcommand} requires the interactive TUI.`);
		}
	});

	it("advertises an ACP-dispatchable panel command alongside TUI interaction", () => {
		const spec = lookupBuiltinSlashCommand("panel");
		expect(spec?.handle).toBeDefined();
		expect(spec?.handleTui).toBeDefined();

		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(c => c.name === "panel");
		expect(advertised).toBeDefined();
		expect(advertised?.input?.hint).toBe("<answer|plan> [@role] <request>");
	});
});

describe("/panel slash command (TUI adapter over shared handle)", () => {
	it("routes a saved-role answer through the TUI confirmation workflow and clears the editor", async () => {
		const h = tuiRuntime();
		const promptText = await executeBuiltinSlashCommand("/panel answer what now?", h.runtime);

		expect(h.runPanelWithConfirmation).toHaveBeenCalledWith({ taskMode: "answer", request: "what now?" });
		expect(h.runPanel).not.toHaveBeenCalled();
		expect(promptText).toBe("tui synthesis prompt");
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("awaits role selection before forwarding an exact request and returned synthesis prompt", async () => {
		const picker = Promise.withResolvers<string | undefined>();
		const h = tuiRuntime({
			panelSettings: {
				roles: {
					chosen: {
						strategy: "independent",
						members: [{ model: "anthropic/claude-opus-4-5" }, { model: "openai/gpt-5.4" }],
					},
				},
				personas: {},
			},
			showPanelRolePicker: () => picker.promise,
		});

		const handled = executeBuiltinSlashCommand("/panel plan  retain   this\tspacing", h.runtime);
		expect(h.showPanelRolePicker).toHaveBeenCalledTimes(1);
		expect(h.runPanelWithConfirmation).not.toHaveBeenCalled();

		picker.resolve("chosen");
		await expect(handled).resolves.toBe("tui synthesis prompt");
		expect(h.runPanelWithConfirmation).toHaveBeenCalledWith({
			taskMode: "plan",
			request: " retain   this\tspacing",
			requestedRole: "chosen",
		});
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("does not run a panel when the role picker is cancelled", async () => {
		const h = tuiRuntime({
			panelSettings: {
				roles: {
					available: {
						strategy: "independent",
						members: [{ model: "anthropic/claude-opus-4-5" }, { model: "openai/gpt-5.4" }],
					},
				},
				personas: {},
			},
			showPanelRolePicker: async () => undefined,
		});
		await expect(executeBuiltinSlashCommand("/panel answer what now?", h.runtime)).resolves.toBe(true);

		expect(h.runPanelWithConfirmation).not.toHaveBeenCalled();
		expect(h.showStatus).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("delegates a lineup to the TUI builder and forwards its synthesis prompt", async () => {
		const lineupResult = {
			results: [panelistResult("completed"), panelistResult("completed")],
			synthesisInput: "lineup synthesis prompt",
		} as unknown as PanelRunResult;
		const h = tuiRuntime({
			showPanelLineupBuilder: async () => lineupResult,
		});

		const prompt = await executeBuiltinSlashCommand("/panel lineup answer  retain   this\tspacing", h.runtime);

		expect(h.showPanelLineupBuilder).toHaveBeenCalledWith("answer", " retain   this\tspacing");
		expect(h.runPanel).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
		expect(prompt).toBe("lineup synthesis prompt");
	});

	it("shows the usage message via showStatus for a missing request", async () => {
		const h = tuiRuntime();
		const handled = await executeBuiltinSlashCommand("/panel plan", h.runtime);

		expect(h.runPanel).not.toHaveBeenCalled();
		expect(handled).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining("Usage: /panel"));
	});
});
