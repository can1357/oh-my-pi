import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { getConfigRootDir, getProjectDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const COMMAND = "git commit --dry-run -m probe";
const OPERATOR_RULE = { match: "git commit*", approval: "deny" };
const PROJECT_ALLOW = { match: "git commit*", approval: "allow" };
const DENIED = {
	tier: "exec",
	override: true,
	policy: "deny",
	reason: "Blocked by bash pattern: git commit*",
};
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const fallbackProjectDir = getProjectDir();

let dir: TempDir | undefined;

beforeEach(() => {
	resetSettingsForTest();
	dir = TempDir.createSync("@omp-config-get-bash-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	setAgentDir(fallbackAgentDir);
	setProjectDir(fallbackProjectDir);
	await dir?.remove();
	dir = undefined;
});

/** The operator's config.yml denies `git commit*`; the repository's .omp/config.yml sets `projectPatterns`. */
async function configGetBashPatterns(projectPatterns: unknown[]): Promise<unknown> {
	const root = dir!.path();
	fs.mkdirSync(path.join(root, "repo"), { recursive: true });
	setAgentDir(path.join(root, "agent"));
	setProjectDir(path.join(root, "repo"));
	await Bun.write(path.join(root, "agent", "config.yml"), YAML.stringify({ bash: { patterns: [OPERATOR_RULE] } }));
	await Bun.write(
		path.join(root, "repo", ".omp", "config.yml"),
		YAML.stringify({ bash: { patterns: projectPatterns } }),
	);
	resetSettingsForTest();
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	await runConfigCommand({ action: "get", key: "bash.patterns", flags: { json: true } });
	const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { value: unknown };
	logSpy.mockRestore();
	return printed.value;
}

/** What the bash tool decides for COMMAND under the same settings. */
async function bashToolDecision(): Promise<unknown> {
	const settings = await Settings.init();
	const bash = new BashTool({ settings } as unknown as ConstructorParameters<typeof BashTool>[0]);
	return bash.approval({ command: COMMAND });
}

describe("omp config get bash.patterns reports the rules the bash tool enforces", () => {
	// A consumer that reads this value plans the command; the bash tool refuses it when the operator deny is missing or sits behind a project allow.
	it("project allow: the printed list leads with the operator deny the bash tool enforces", async () => {
		const printed = await configGetBashPatterns([PROJECT_ALLOW]);
		expect(await bashToolDecision()).toEqual(DENIED);
		expect(printed).toEqual([OPERATOR_RULE, PROJECT_ALLOW]);
	});

	it("project empty list: the printed list still carries the operator deny the bash tool enforces", async () => {
		const printed = await configGetBashPatterns([]);
		expect(await bashToolDecision()).toEqual(DENIED);
		expect(printed).toEqual([OPERATOR_RULE]);
	});
});
