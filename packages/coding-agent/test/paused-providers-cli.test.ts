import { afterEach, describe, expect, it, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import * as piAi from "@oh-my-pi/pi-ai";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { renderProviderModels } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

const PAUSED: piAi.PausedProvider = { id: "acme-cloud", name: "Acme Cloud", reason: "Acme is paused for testing." };

const acme = buildModel({
	id: "acme-1",
	name: "Acme 1",
	api: "openai-completions",
	provider: "acme",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
} as ModelSpec);

/** Run `omp models [pattern]` against one available model and the {@link PAUSED} provider. */
function listing(pattern: string | undefined, json = false): string {
	spyOn(piAi, "pausedProviders").mockReturnValue([PAUSED]);
	const output: string[] = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	const available: Model<Api>[] = [acme];
	renderProviderModels({ getAvailable: () => available, getError: () => undefined }, "ls", pattern, json);
	vi.restoreAllMocks();
	return output.join("").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("omp models with a paused provider", () => {
	it("names the paused provider and its reason instead of reporting no match", () => {
		const text = listing("acme-cloud");
		expect(text).not.toContain("No models matching");
		expect(text).toContain("acme-cloud (paused)");
		expect(text).toContain(PAUSED.reason);
	});

	it("lists paused providers beside the available ones when unfiltered", () => {
		const text = listing(undefined);
		expect(text).toContain("acme-1");
		expect(text).toContain("acme-cloud (paused)");
	});

	it("leaves a paused provider out when the filter names an available provider exactly", () => {
		const text = listing("acme");
		expect(text).toContain("acme-1");
		expect(text).not.toContain("(paused)");
	});

	it("still reports no match when neither a model nor a paused provider matches", () => {
		expect(listing("nosuch").trim()).toBe('No models matching "nosuch"');
	});

	it("reports paused providers in --json output", () => {
		const json = JSON.parse(listing("acme-cloud", true));
		expect(json).toEqual({
			models: [],
			paused: [{ provider: "acme-cloud", name: "Acme Cloud", reason: PAUSED.reason }],
		});
	});
});

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const [catalogPaused] = piAi.pausedProviders();

test.if(catalogPaused !== undefined)(
	"omp token on a paused provider prints the reason and exits 1 without a stack trace",
	async () => {
		using tempDir = TempDir.createSync("@omp-token-paused-");
		const proc = Bun.spawn([process.execPath, cliEntry, "token", catalogPaused!.id], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				NO_COLOR: "1",
				OMP_AUTH_BROKER_TOKEN: undefined,
				OMP_AUTH_BROKER_URL: undefined,
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
				PI_CODING_AGENT_DIR: tempDir.path(),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.trim()).toBe(`Provider "${catalogPaused!.id}" is paused: ${catalogPaused!.reason}`);
	},
	30_000,
);
