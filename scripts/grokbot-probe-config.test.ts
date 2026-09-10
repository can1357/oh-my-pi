import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadGrokbotConfig,
	mintGrokbotAccessToken,
	runWithGrokbotAuthSource,
	runWithGrokbotAuthSourceAsync,
} from "./grokbot-probe-config.mjs";

const tempDirs: string[] = [];

/** Clear ambient Grok Bot env keys so only the injected overlay / secrets file apply. */
const CLEAR_GROKBOT_ENV: Record<string, string | undefined> = {
	GROKBOT_MACHINE_ID: undefined,
	GROKBOT_RENEWAL_CREDENTIAL: undefined,
	SAND_INFERENCE_RENEWAL_CREDENTIAL: undefined,
	GROKBOT_NAMESPACE: undefined,
	GROKBOT_CLIENT_VERSION: undefined,
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

describe("grokbot-probe-config secrets parsing", () => {
	test("loads export-prefixed, quoted, and inline-comment credentials like the CLI", async () => {
		// Hand-rolled KEY=VALUE splits miss `export`, keep quotes, and retain
		// trailing comments — probes would mint with different credentials than omp.
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-probe-cfg-"));
		tempDirs.push(agentDir);
		fs.mkdirSync(path.join(agentDir, "secrets"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "secrets", "grokbot.env"),
			[
				'export GROKBOT_MACHINE_ID="machine-quoted"',
				"GROKBOT_RENEWAL_CREDENTIAL=renew-secret # trailing comment",
				"GROKBOT_NAMESPACE=lab",
			].join("\n"),
		);

		const cfg = await runWithGrokbotAuthSource(
			{
				secretsPath: path.join(agentDir, "secrets", "grokbot.env"),
				env: CLEAR_GROKBOT_ENV,
			},
			() => loadGrokbotConfig(),
		);
		expect(cfg.machineId).toBe("machine-quoted");
		expect(cfg.renewal).toBe("renew-secret");
		expect(cfg.namespace).toBe("lab");
		expect(cfg.clientVersion).toBe("0.30.0-lab");
	});
});

describe("grokbot-probe-config mint errors", () => {
	test("token renew failures report status only (no response body)", async () => {
		// Reverse proxies may echo `{ credential: renewer }` in diagnostic bodies.
		const renewer = "long-lived-renewal-secret-must-not-leak";
		const fetchImpl = async () =>
			new Response(JSON.stringify({ error: "denied", credential: renewer }), {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		await expect(
			mintGrokbotAccessToken(
				{ renewal: renewer, machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
				fetchImpl,
			),
		).rejects.toThrow("Grok Bot token renew failed (HTTP 502)");
		try {
			await mintGrokbotAccessToken(
				{ renewal: renewer, machineId: "machine", namespace: "prod", clientVersion: "0.30.0" },
				fetchImpl,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).not.toContain(renewer);
			expect(message).not.toContain("credential");
		}
	});
});
