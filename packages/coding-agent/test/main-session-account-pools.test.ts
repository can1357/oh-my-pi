import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseArgs, type Mode } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SessionAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeAll(() => {
	tempDir = TempDir.createSync("@cli-session-account-pools-");
	authStorage = createInMemoryAuthStorage();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

const DEFAULT_POOLS: SessionAccountPools = {
	company: { anthropic: ["email:a@example.com"] },
	personal: { "openai-codex": ["account:personal"] },
};

async function buildWithPools(pools: SessionAccountPools, cliArgs: string[] = [], mode?: Mode) {
	const cwd = tempDir.join("project");
	const parsed = parseArgs(["--cwd", cwd, ...cliArgs]);
	parsed.mode = mode;
	const settings = Settings.isolated({
		"auth.sessionAccountPools": pools,
	});
	const options = await buildSessionOptions(
		parsed,
		[],
		SessionManager.inMemory(cwd),
		new ModelRegistry(authStorage, tempDir.join("models.yml")),
		settings,
	);
	return { options, parsed };
}

async function build(cliArgs: string[] = [], mode?: Mode) {
	return (await buildWithPools(DEFAULT_POOLS, cliArgs, mode)).options;
}

test("top-level text and JSON sessions receive only the explicitly selected pool", async () => {
	for (const mode of [undefined, "text", "json"] as const) {
		const options = await build(["--account-pool", "company"], mode);
		expect(options.oauthAccountPools).toEqual({ anthropic: ["email:a@example.com"] });
		expect(options.oauthAccountPoolsDenyUnlistedProviders).toBe(true);
	}
});

test("the sole configured pool is selected automatically and exposed to the session environment", async () => {
	const { options, parsed } = await buildWithPools({
		personal: { "openai-codex": ["account:personal"] },
	});
	expect(options.oauthAccountPools).toEqual({ "openai-codex": ["account:personal"] });
	expect(options.oauthAccountPoolsDenyUnlistedProviders).toBe(true);
	expect(parsed.accountPool).toBe("personal");
});

test("multiple configured pools require a known explicit selection", async () => {
	await expect(build()).rejects.toThrow("multiple named pools; select one with --account-pool <name>");
	await expect(build(["--account-pool", "missing"])).rejects.toThrow('Unknown account pool "missing"');
	expect(parseArgs(["--account-pool=company"]).accountPool).toBe("company");
	expect(() => parseArgs(["--account-pool", ""])).toThrow("--account-pool requires a non-empty pool name");
});

test("RPC and ACP hosts keep ownership of their session credential policy", async () => {
	for (const mode of ["rpc", "rpc-ui", "acp"] as const) {
		expect((await build([], mode)).oauthAccountPools).toBeUndefined();
		await expect(build(["--account-pool", "company"], mode)).rejects.toThrow(
			`--account-pool does not apply to ${mode} mode`,
		);
	}
});
