import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadGrokbotSecretFile, loadGrokbotSecretFileSync } from "../src/discovery/grokbot-auth";

describe("grokbot secrets dotenv parsing", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	test("strips quotes, export prefixes, and inline comments via shared parseEnvFile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-"));
		dirs.push(dir);
		const filePath = path.join(dir, "grokbot.env");
		await Bun.write(
			filePath,
			[
				"# host secrets",
				"export GROKBOT_MACHINE_ID=machine-1",
				'GROKBOT_RENEWAL_CREDENTIAL="token-with-spaces"',
				"GROKBOT_NAMESPACE=prod # inline",
			].join("\n"),
		);

		const asyncFile = await loadGrokbotSecretFile(filePath);
		const syncFile = loadGrokbotSecretFileSync(filePath);

		expect(asyncFile).toEqual({
			GROKBOT_MACHINE_ID: "machine-1",
			GROKBOT_RENEWAL_CREDENTIAL: "token-with-spaces",
			GROKBOT_NAMESPACE: "prod",
		});
		expect(syncFile).toEqual(asyncFile);
	});

	test("missing secrets file yields an empty map", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-grokbot-env-missing-"));
		dirs.push(dir);
		const missing = path.join(dir, "absent.env");
		expect(await loadGrokbotSecretFile(missing)).toEqual({});
		expect(loadGrokbotSecretFileSync(missing)).toEqual({});
	});
});
