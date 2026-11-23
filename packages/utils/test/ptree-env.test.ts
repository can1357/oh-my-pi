import { afterEach, describe, expect, it } from "bun:test";
import { exec } from "@oh-my-pi/pi-utils/ptree";

const NAME = "OMP_PTREE_ENV_PROBE";

describe("ptree child environment", () => {
	afterEach(() => {
		delete Bun.env[NAME];
	});

	// omp loads `~/.env` and the agent `.env` into `Bun.env` after startup; Bun.spawn's
	// own default environment predates those writes, so `!command` config values
	// reading such a variable resolved to an empty credential.
	it("inherits values written into Bun.env after startup", async () => {
		Bun.env[NAME] = "loaded-from-dotenv";
		const result = await exec([process.execPath, "-e", `process.stdout.write(process.env.${NAME} ?? "")`]);
		expect(result.stdout).toBe("loaded-from-dotenv");
	});
});
