import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import { getProjectAgentDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const PROVIDER = "commit-extension-fixture";
const MODEL = "deepseek-v4-flash";
const SELECTOR = `${PROVIDER}/${MODEL}:high`;

let agentTmp: TempDir;
let tmp: TempDir;
let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	tmp = await TempDir.create("@commit-extension-provider-");
	agentTmp = await TempDir.create("@commit-extension-provider-agent-");
	setProjectDir(tmp.path());
	setAgentDir(agentTmp.path());

	const extensionPath = tmp.join("provider.ts");
	await Bun.write(
		extensionPath,
		`export default function (pi) {
	pi.registerProvider("${PROVIDER}", {
		baseUrl: "https://example.invalid/v1",
		apiKey: "fixture-key",
		api: "openai-completions",
		models: [{
			id: "${MODEL}",
			name: "DeepSeek V4 Flash",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
		}],
	});
}
`,
	);
	await Bun.write(
		path.join(getProjectAgentDir(tmp.path()), "settings.json"),
		JSON.stringify({
			extensions: [extensionPath],
			modelRoles: { commit: SELECTOR },
		}),
	);

	await $`git init --initial-branch=main`.cwd(tmp.path()).quiet();
	await $`git add -A`.cwd(tmp.path()).quiet();
	await $`git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m baseline`.cwd(tmp.path()).quiet();

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await tmp.remove();
	await agentTmp.remove();
});

describe.serial("commit extension provider resolution", () => {
	test("agentic pipeline resolves an explicit extension-provided model", async () => {
		await expect(
			runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				model: SELECTOR,
			}),
		).resolves.toEqual({ usedFallback: false });
	});

	test("legacy pipeline resolves the project commit role from an extension provider", async () => {
		await expect(
			runCommitCommand({
				push: false,
				dryRun: true,
				noChangelog: true,
				legacy: true,
			}),
		).resolves.toEqual({ usedFallback: false });
	});
});
