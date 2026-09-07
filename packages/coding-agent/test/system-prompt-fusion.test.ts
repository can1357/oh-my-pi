import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
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

	async function renderBlocks(opts: Partial<BuildSystemPromptOptions> = {}): Promise<string[]> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["task"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...opts,
		});
		return systemPrompt;
	}

	async function render(opts: Partial<BuildSystemPromptOptions> = {}): Promise<string> {
		return (await renderBlocks(opts)).join("\n\n");
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
	it.each([false, true])(
		"appends one complete savings block after project and active-repo context (custom=%j)",
		async custom => {
			fs.mkdirSync(path.join(tempDir, "active-project", ".git"), { recursive: true });
			const opts = {
				resolvedCustomPrompt: custom ? "<test-custom-context />" : undefined,
				resolvedAppendSystemPrompt: "<test-append-context />",
				contextFiles: [{ path: "project-rules.txt", content: "<test-project-context />" }],
				personality: "friendly" as const,
			};
			const normal = await renderBlocks(opts);
			const savings = await renderBlocks({ ...opts, fusionTokenSavings: true });
			const terminal = savings.at(-1) ?? "";
			expect(savings.slice(0, -1)).toEqual(normal);
			expect(normal.join("\n")).toContain("<active-repo-context>");
			expect(normal.join("\n")).toContain("<test-append-context />");
			expect(normal.join("\n")).toContain("<test-project-context />");
			expect(terminal.trim()).toMatch(/^<fusion-token-savings>[\s\S]*<\/fusion-token-savings>$/);
			expect(terminal.match(/<fusion-token-savings>/g)).toHaveLength(1);
			expect(terminal.match(/<bulk-work-delegation>/g)).toHaveLength(1);
		},
	);

	it.each([{ toolNames: [] }, { toolNames: ["read", "bash"] }])(
		"omits savings delegation without task capability (%j)",
		async ({ toolNames }) => {
			const rendered = await render({ fusionTokenSavings: true, toolNames: [...toolNames] });
			expect(rendered).not.toContain("<fusion-token-savings>");
			expect(rendered).not.toContain("<bulk-work-delegation>");
		},
	);

	it("uses the exposed task tool name in the bulk-work contract", async () => {
		const rendered = await render({
			fusionTokenSavings: true,
			tools: new Map([
				["task", { label: "Delegate", description: "", parameters: { type: "object" }, wireName: "dispatch_work" }],
			]),
		});
		const bulk = rendered.match(/<bulk-work-delegation>([\s\S]*?)<\/bulk-work-delegation>/)?.[1] ?? "";
		expect(bulk).toContain("`dispatch_work`");
		expect(bulk).not.toContain("`task`");
	});

	it.each([undefined, false])("omits savings contracts outside savings mode (%j)", async fusionTokenSavings => {
		const rendered = await render({ fusionTokenSavings });
		expect(rendered).not.toContain("<fusion-token-savings>");
		expect(rendered).not.toContain("<bulk-work-delegation>");
	});

	it.each([
		{ eagerTasks: true, eagerTasksAlways: true, taskBatch: true },
		{ eagerTasks: true, eagerTasksAlways: false, taskBatch: false },
		{ ultraMode: true, taskBatch: true },
	])("preserves distinct eager delegation behavior (%j)", async eagerOptions => {
		const normal = await renderBlocks(eagerOptions);
		const savings = await renderBlocks({ ...eagerOptions, fusionTokenSavings: true });
		expect(savings.slice(0, -1)).toEqual(normal);
		expect(savings.join("\n").match(/<bulk-work-delegation>/g)).toHaveLength(1);
	});
});
