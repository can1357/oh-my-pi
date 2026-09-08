import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "../packages/utils/src/dirs.ts";
import { loadGrokbotConfig } from "./grokbot-probe-config.mjs";

const tempDirs: string[] = [];
const previousAgentDir = getAgentDir();
const GROKBOT_ENV_KEYS = [
	"GROKBOT_MACHINE_ID",
	"GROKBOT_RENEWAL_CREDENTIAL",
	"SAND_INFERENCE_RENEWAL_CREDENTIAL",
	"GROKBOT_NAMESPACE",
	"GROKBOT_CLIENT_VERSION",
] as const;
const previousEnv = Object.fromEntries(GROKBOT_ENV_KEYS.map(key => [key, process.env[key]])) as Record<
	(typeof GROKBOT_ENV_KEYS)[number],
	string | undefined
>;

afterEach(() => {
	setAgentDir(previousAgentDir);
	for (const key of GROKBOT_ENV_KEYS) {
		const prior = previousEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

describe("grokbot-probe-config secrets parsing", () => {
	test("loads export-prefixed, quoted, and inline-comment credentials like the CLI", () => {
		// Hand-rolled KEY=VALUE splits miss `export`, keep quotes, and retain
		// trailing comments — probes would mint with different credentials than omp.
		for (const key of GROKBOT_ENV_KEYS) delete process.env[key];
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
		setAgentDir(agentDir);

		const cfg = loadGrokbotConfig();
		expect(cfg.machineId).toBe("machine-quoted");
		expect(cfg.renewal).toBe("renew-secret");
		expect(cfg.namespace).toBe("lab");
		expect(cfg.clientVersion).toBe("0.30.0-lab");
	});
});
