import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { invalidateCommandConfig } from "../src/config/model-config-values";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfigValue } from "../src/config/model-config-values";
import {
	fetchDopplerSecretViaApi,
	parseDopplerSecretsGetCommand,
	resolveDopplerSecretsGetCommand,
	resolveDopplerSecretsGetCommandSync,
	resolveDopplerToken,
} from "../src/config/doppler-secret";

const CORNELL_COMMAND =
	"doppler secrets get LANE_DISPATCH_OPENCODE_GO_CORNELL_API_KEY -p personal -c dev --plain";

describe("doppler-secret headless resolver", () => {
	test("parses models.yml doppler secrets get commands", () => {
		expect(parseDopplerSecretsGetCommand(CORNELL_COMMAND)).toEqual({
			secretName: "LANE_DISPATCH_OPENCODE_GO_CORNELL_API_KEY",
			project: "personal",
			config: "dev",
		});
	});

	test("extracts computed secret values from download payloads", async () => {
		const value = await fetchDopplerSecretViaApi(
			{
				secretName: "LANE_DISPATCH_OPENCODE_GO_CORNELL_API_KEY",
				project: "personal",
				config: "dev",
			},
			"token",
			async () =>
				new Response(
					JSON.stringify({
						LANE_DISPATCH_OPENCODE_GO_CORNELL_API_KEY: { computed: "cornell-api-key" },
					}),
					{ status: 200 },
				),
		);
		expect(value).toBe("cornell-api-key");
	});

	test("prefers dp.ct API tokens over longer-path secret service tokens", () => {
		const root = "/Users/andrewfuller/Documents/epoch-sprint-2026-09-05/recovery/omppp";
		const tokens = {
			"/": "dp.ct.root-personal-token",
			"/Users/andrewfuller": "secret-service-token",
		};
		expect(resolveDopplerToken(root, undefined, tokens)).toBe("dp.ct.root-personal-token");
	});

	test("resolveDopplerSecretsGetCommand uses API instead of CLI", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-doppler-api-"));
		const configDir = path.join(root, ".doppler");
		await fs.promises.mkdir(configDir, { recursive: true });
		await fs.promises.writeFile(
			path.join(configDir, ".doppler.yaml"),
			"scoped:\n  /:\n    token: scoped-token\n",
			"utf8",
		);
		const value = await resolveDopplerSecretsGetCommand(
			CORNELL_COMMAND,
			root,
			async (_url, init) => {
				expect(init?.headers).toEqual({ Authorization: "Bearer scoped-token" });
				return new Response(
					JSON.stringify({
						LANE_DISPATCH_OPENCODE_GO_CORNELL_API_KEY: { computed: "headless-cornell-key" },
					}),
					{ status: 200 },
				);
			},
			configDir,
		);
		expect(value).toBe("headless-cornell-key");
		expect(resolveDopplerToken(root, configDir)).toBe("scoped-token");
	});
});

describe("model-config-values doppler fallback", () => {
	const originalExecSync = Bun.spawnSync;
	const originalDopplerToken = process.env.DOPPLER_TOKEN;
	let dopplerRoot = "";

	beforeEach(() => {
		process.env.DOPPLER_TOKEN = "scoped-token";
		invalidateCommandConfig(`!${CORNELL_COMMAND}`);
	});

	afterEach(async () => {
		Bun.spawnSync = originalExecSync;
		if (originalDopplerToken === undefined) delete process.env.DOPPLER_TOKEN;
		else process.env.DOPPLER_TOKEN = originalDopplerToken;
		invalidateCommandConfig(`!${CORNELL_COMMAND}`);
		if (dopplerRoot) {
			await fs.promises.rm(dopplerRoot, { recursive: true, force: true });
			dopplerRoot = "";
		}
	});

	test("resolveConfigValue resolves doppler commands when CLI would fail closed", async () => {
		dopplerRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-doppler-sync-"));

		Bun.spawnSync = ((options: Parameters<typeof Bun.spawnSync>[0]) => {
			const cmd = options?.cmd ?? [];
			const script = typeof cmd[2] === "string" ? cmd[2] : "";
			if (script.includes("api.doppler.com")) {
				return {
					exitCode: 0,
					stdout: Buffer.from("sync-cornell-key"),
					stderr: Buffer.alloc(0),
					success: true,
				} as ReturnType<typeof Bun.spawnSync>;
			}
			return {
				exitCode: 36,
				stdout: Buffer.alloc(0),
				stderr: Buffer.from("Unable to retrieve value from system keyring"),
				success: false,
			} as ReturnType<typeof Bun.spawnSync>;
		}) as typeof Bun.spawnSync;

		const direct = resolveDopplerSecretsGetCommandSync(CORNELL_COMMAND, dopplerRoot, 5_000);
		expect(direct).toBe("sync-cornell-key");

		const viaConfig = resolveConfigValue(`!${CORNELL_COMMAND}`);
		expect(viaConfig).toBe("sync-cornell-key");
	});
});
