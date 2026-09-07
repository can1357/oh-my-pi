import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt fusion sidekick policy", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-fusion-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-fusion-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(opts: {
		fusionSidekick?: boolean;
		fusionEscalate?: boolean;
		fusionTokenSavings?: boolean;
		sidekickModel?: string;
		toolNames?: string[];
	}): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: opts.toolNames ?? ["task"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			fusionSidekick: opts.fusionSidekick,
			fusionEscalate: opts.fusionEscalate,
			fusionTokenSavings: opts.fusionTokenSavings,
			sidekickModel: opts.sidekickModel,
		});
		return systemPrompt.join("\n\n");
	}

	it("injects the sidekick policy with the configured model when enabled", async () => {
		const rendered = await render({ fusionSidekick: true, sidekickModel: "vendor/cheapo-1" });
		expect(rendered).toContain("Sidekick (cost mode)");
		expect(rendered).toContain("Minimize your own actions");
		// The configured sidekick model is interpolated into the policy.
		expect(rendered).toContain("vendor/cheapo-1");
	});

	it("adds the escalate guidance only in escalate mode", async () => {
		const escalate = await render({ fusionSidekick: true, fusionEscalate: true, sidekickModel: "pi/smol" });
		expect(escalate).toContain("escalate the hard parts");

		const delegateOnly = await render({ fusionSidekick: true, fusionEscalate: false, sidekickModel: "pi/smol" });
		expect(delegateOnly).toContain("Sidekick (cost mode)");
		expect(delegateOnly).not.toContain("escalate the hard parts");
	});

	it("omits the sidekick policy when fusion is off", async () => {
		const rendered = await render({ fusionSidekick: false });
		expect(rendered).not.toContain("Sidekick (cost mode)");
	});

	it("omits the sidekick policy when the task tool is unavailable", async () => {
		const rendered = await render({ fusionSidekick: true, toolNames: [] });
		expect(rendered).not.toContain("Sidekick (cost mode)");
	});
	it("injects token savings mode instructions when fusionTokenSavings is true", async () => {
		const rendered = await render({ fusionTokenSavings: true });
		expect(rendered).toContain("Token Savings Mode (Fusion)");
		expect(rendered).toContain("at most two calls and simple tasks");
		expect(rendered).toContain("pi/slow");
		expect(rendered).toContain("pi/max-intelligence");
		expect(rendered).toContain("pi/task");
		expect(rendered).toContain("pi/browser-control");
		expect(rendered).toContain("pi/smol");
	});

	it("omits token savings mode instructions when fusionTokenSavings is false", async () => {
		const rendered = await render({ fusionTokenSavings: false });
		expect(rendered).not.toContain("Token Savings Mode (Fusion)");
	});
});
