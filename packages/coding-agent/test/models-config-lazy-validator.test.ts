import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ProbeResult {
	retainedHeapNodes: number;
	schemaIdentityStable?: boolean;
	model?: {
		provider: string;
		id: string;
		baseUrl: string;
		api: string;
		thinking?: unknown;
	};
}

interface ProbeResults {
	missing: ProbeResult;
	custom: ProbeResult;
}

const probePath = path.join(import.meta.dir, "fixtures", "models-config-validator-construction-probe.ts");

async function runProbe(root: string): Promise<ProbeResults> {
	const proc = Bun.spawn([process.execPath, probePath, root], {
		cwd: path.join(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ProbeResults;
}

test("models config validation resources are retained only for a custom config", async () => {
	const tempDir = TempDir.createSync("@models-config-validator-");
	try {
		const { missing, custom } = await runProbe(tempDir.path());

		expect(missing.model).toMatchObject({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
		});
		expect(custom.model).toEqual({
			provider: "lazy-models",
			id: "lazy-model",
			baseUrl: "https://lazy.example/v1",
			api: "openai-responses",
			thinking: {
				mode: "effort",
				efforts: ["low", "medium", "high"],
				defaultLevel: "medium",
				requiresEffort: false,
			},
		});
		expect(custom.schemaIdentityStable).toBe(true);
		expect(missing.retainedHeapNodes).toBeLessThan(custom.retainedHeapNodes);
		expect(
			custom.retainedHeapNodes - missing.retainedHeapNodes,
			"custom config validation should retain its schema bundle",
		).toBeGreaterThan(5_000);
	} finally {
		await tempDir.remove().catch(() => {});
	}
}, 60_000);
