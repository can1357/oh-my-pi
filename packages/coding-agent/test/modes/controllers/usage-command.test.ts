import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	EXPECTED_USAGE_BREAKDOWN,
	USAGE_FIXTURE_ACCOUNTS,
	USAGE_FIXTURE_CONTEXT_LINES,
	USAGE_FIXTURE_DISABLED,
	USAGE_FIXTURE_MODEL_SELECTORS,
	USAGE_FIXTURE_NOW,
	USAGE_FIXTURE_REPORTS,
} from "../../helpers/usage-breakdown-fixture";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

function createUsageSessionDouble() {
	return {
		modelRegistry: {
			authStorage: {
				getAll: () => ({}),
				usageProviderFor: () => undefined,
				listDisabledCredentials: async () => [],
				getOAuthAccountIdentity: () => undefined,
			},
		},
		getUsageReportingModelSelectors: () => [],
	};
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("75.0% used");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("150 / 500 requests");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			await controller.handleUsageCommand(reports);
		} finally {
			nowSpy.mockRestore();
		}

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("user@example.com · ✦ 2 saved resets");
		expect(output).toContain(`expires in 2d (${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("renders the pinned detailed body plus only the approved session context", async () => {
		const present = vi.fn();
		const authStorage = {
			getAll: () => ({
				anthropic: USAGE_FIXTURE_ACCOUNTS.map(account => ({ type: account.type, email: account.email })),
			}),
			usageProviderFor: () => ({}),
			listDisabledCredentials: async () => USAGE_FIXTURE_DISABLED,
			getOAuthAccountIdentity: () => ({ email: "active@example.test" }),
		};
		const ctx = {
			session: {
				model: { provider: "anthropic" },
				sessionId: "session-id",
				modelRegistry: { authStorage },
				getUsageReportingModelSelectors: () => USAGE_FIXTURE_MODEL_SELECTORS,
			},
			ui: { terminal: { columns: 120 } },
			present,
			presentCommandOutput: present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(USAGE_FIXTURE_NOW);
		try {
			await new CommandController(ctx).handleUsageCommand(USAGE_FIXTURE_REPORTS);
		} finally {
			nowSpy.mockRestore();
		}

		const rendered = stripVTControlCharacters(renderPresentedBlocks(present.mock.calls[0]?.[0]))
			.split("\n")
			.map(line => line.slice(1).trimEnd())
			.join("\n")
			.trim();
		const renderedLines = rendered.split("\n");
		const contextLines: string[] = [...USAGE_FIXTURE_CONTEXT_LINES];
		expect(renderedLines.filter(line => contextLines.includes(line))).toEqual(contextLines);
		expect(renderedLines.filter(line => !contextLines.includes(line)).join("\n")).toBe(EXPECTED_USAGE_BREAKDOWN);
	});

	it("renders stored credentials when the provider returns no reports", async () => {
		const present = vi.fn();
		const showWarning = vi.fn();
		const authStorage = {
			getAll: () => ({ anthropic: { type: "oauth", email: "stored@example.test" } }),
			usageProviderFor: () => ({}),
			listDisabledCredentials: async () => [],
			getOAuthAccountIdentity: () => undefined,
		};
		const ctx = {
			session: {
				model: undefined,
				sessionId: "session-id",
				modelRegistry: { authStorage },
				getUsageReportingModelSelectors: () => [],
			},
			ui: { terminal: { columns: 120 } },
			presentCommandOutput: present,
			showWarning,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([]);

		expect(showWarning).not.toHaveBeenCalled();
		expect(renderPresentedBlocks(present.mock.calls[0]?.[0])).toContain("stored@example.test — no usage data");
	});

	it("renders actionable disabled credentials when the provider returns no reports", async () => {
		const present = vi.fn();
		const showWarning = vi.fn();
		const authStorage = {
			getAll: () => ({}),
			usageProviderFor: () => ({}),
			listDisabledCredentials: async () => USAGE_FIXTURE_DISABLED,
			getOAuthAccountIdentity: () => undefined,
		};
		const ctx = {
			session: {
				model: undefined,
				sessionId: "session-id",
				modelRegistry: { authStorage },
				getUsageReportingModelSelectors: () => [],
			},
			ui: { terminal: { columns: 120 } },
			presentCommandOutput: present,
			showWarning,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new CommandController(ctx).handleUsageCommand([]);

		expect(showWarning).not.toHaveBeenCalled();
		expect(renderPresentedBlocks(present.mock.calls[0]?.[0])).toContain("disabled@example.test — disabled");
	});
});
