import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_AUTH_BROKER_ENV = {
	OMP_AUTH_BROKER_URL: undefined,
	OMP_AUTH_BROKER_TOKEN: undefined,
	OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: undefined,
} as const;

describe("auth.accountSelection config discovery", () => {
	let agentDir = "";
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-selection-config-"));
	});

	afterEach(async () => {
		storage?.close();
		storage = null;
		if (agentDir) {
			await removeWithRetries(agentDir);
			agentDir = "";
		}
	});

	async function discover(config: string, accountSelection?: "balanced" | "fixed"): Promise<AuthStorage> {
		await Bun.write(path.join(agentDir, "config.yml"), config);
		let discovered: AuthStorage | undefined;
		await withEnv(SUPPRESS_AUTH_BROKER_ENV, async () => {
			discovered = await discoverAuthStorage({ agentDir, accountSelection });
		});
		if (!discovered) throw new Error("discoverAuthStorage returned nothing");
		storage = discovered;
		return discovered;
	}

	test("flat `auth.accountSelection: fixed` opens the local store with fixed selection", async () => {
		// Regression: the setting is written by `omp config set` but never reaches AuthStorage.
		expect((await discover("auth.accountSelection: fixed\n")).accountSelection).toBe("fixed");
	});

	test("nested `auth: { accountSelection }` resolves the same way", async () => {
		expect((await discover("auth:\n  accountSelection: fixed\n")).accountSelection).toBe("fixed");
	});

	test("an unknown value falls back to balanced instead of failing startup", async () => {
		expect((await discover("auth.accountSelection: sticky\n")).accountSelection).toBe("balanced");
	});

	test("an explicit option wins over config.yml", async () => {
		expect((await discover("auth.accountSelection: fixed\n", "balanced")).accountSelection).toBe("balanced");
	});
});
