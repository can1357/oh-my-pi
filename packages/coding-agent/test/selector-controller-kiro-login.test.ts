import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

interface RenderableBlock {
	render(width: number): string[];
}

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/two";

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

async function loginKiro(orgName: string | undefined): Promise<string> {
	const presentedBlocks: unknown[] = [];
	const authStorage = {
		oauth: {
			login: vi.fn(async () => ({ type: "oauth", orgId: PROFILE_ARN, orgName })),
		},
	} as unknown as AuthStorage;
	const ctx = {
		oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
		session: { modelRegistry: { authStorage, refreshProvider: vi.fn(async () => {}) } },
		editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
		editor: {},
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		present: vi.fn((block: unknown) => {
			presentedBlocks.push(block);
		}),
		openInBrowser: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);

	await controller.showOAuthSelector("login", "kiro");
	return renderPresented(presentedBlocks);
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController Kiro login", () => {
	it("names the selected AWS profile without echoing its ARN or account id", async () => {
		const output = await loginKiro("Work");

		expect(output).toContain("Successfully logged in to kiro");
		expect(output).toContain("Work");
		expect(output).not.toContain("arn:");
		expect(output).not.toContain("123456789012");
	});

	it("renders the ARN-safe segment a nameless profile falls back to", async () => {
		// loginKiroHook guarantees orgName is a display label even when the AWS
		// profile carries no name, so the controller receives the segment itself.
		const output = await loginKiro("two");

		expect(output).toContain("Successfully logged in to kiro as two");
		expect(output).not.toContain("arn:");
		expect(output).not.toContain("123456789012");
	});
});
