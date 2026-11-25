import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as catalogPolicy from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import type { BunPlugin } from "bun";
import { perturbContext, perturbPromptText, resetPromptPerturbation } from "../src/prompts/perturbation";
import type { Context } from "../src/types";

const pool: { entries: { source: string; variants: string[]; manual?: boolean }[] } = JSON.parse(
	readFileSync(new URL("../src/prompts/perturbation-pool.json.txt", import.meta.url), "utf8"),
);

const sample = pool.entries.find(entry => !entry.manual && /^[A-Z`]/.test(entry.source));
if (!sample) throw new Error("pool has no generated sentence");

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled fixture model missing");

const savedPerturbation = process.env.OMP_PROMPT_PERTURBATION;

beforeEach(() => {
	delete process.env.OMP_PROMPT_PERTURBATION;
	resetPromptPerturbation();
});

afterEach(() => {
	if (savedPerturbation === undefined) delete process.env.OMP_PROMPT_PERTURBATION;
	else process.env.OMP_PROMPT_PERTURBATION = savedPerturbation;
	resetPromptPerturbation();
	vi.restoreAllMocks();
});

function optIn(enabled: boolean): void {
	vi.spyOn(catalogPolicy, "resolveCatalogPolicy").mockReturnValue({ promptPerturbation: enabled });
}

const sampleContext: Context = { systemPrompt: [sample.source], messages: [] };

describe("per-install prompt perturbation", () => {
	it("replaces a pooled source with one of its committed variants, stably within the process", () => {
		const first = perturbPromptText(sample.source);
		const second = perturbPromptText(sample.source);
		expect(first).not.toBe(sample.source);
		expect(sample.variants).toContain(first);
		expect(second).toBe(first);
	});

	it("rewrites a pooled sentence wherever it renders, keeping its punctuation and surroundings", () => {
		const before = "  - Rendered value 42 here. ";
		const after = "! Trailing sentence that no pool entry could have authored.";
		const rendered = perturbPromptText(`${before}${sample.source}${after}`);
		expect(rendered.startsWith(before)).toBe(true);
		expect(rendered.endsWith(after)).toBe(true);
		expect(sample.variants).toContain(rendered.slice(before.length, -after.length));
	});

	it("leaves a pooled sentence inside fenced code untouched", () => {
		const fenced = `\`\`\`\n${sample.source}\n\`\`\``;
		expect(perturbPromptText(fenced)).toBe(fenced);
	});

	it("drops the system-prompt opener instead of paraphrasing it", async () => {
		const promptUrl = new URL("../../coding-agent/src/prompts/system/system-prompt.md", import.meta.url);
		const prompt = await Bun.file(promptUrl).text();
		expect(prompt.startsWith("You are omp's trusted coding assistant.\n\n")).toBe(true);
		expect(perturbPromptText(prompt).startsWith("# Engineering\n")).toBe(true);
	});

	it("reads the pool beside an npm-style bundle run from another directory", async () => {
		using dir = TempDir.createSync("@omp-perturbation-bundle-");
		const probe = dir.join("probe.ts");
		const perturbationModule = path.resolve(import.meta.dir, "../src/prompts/perturbation.ts");
		await Bun.write(
			probe,
			`import { perturbPromptText } from ${JSON.stringify(perturbationModule)};\nconsole.log(JSON.stringify(perturbPromptText(${JSON.stringify(sample.source)})));\n`,
		);
		const stubs: Record<string, string> = {
			"@oh-my-pi/pi-catalog/compat/catalog-policy": "export const resolveCatalogPolicy = () => ({});",
			"@oh-my-pi/pi-utils": 'export const getInstallId = () => "bundle-probe";',
		};
		const stubPlugin: BunPlugin = {
			name: "perturbation-probe-stubs",
			setup(build) {
				build.onResolve({ filter: /.*/ }, args =>
					stubs[args.path] === undefined ? undefined : { path: args.path, namespace: "perturbation-probe-stub" },
				);
				build.onLoad({ filter: /.*/, namespace: "perturbation-probe-stub" }, args => ({
					contents: stubs[args.path]!,
					loader: "js",
				}));
			},
		};
		const bundle = await Bun.build({
			entrypoints: [probe],
			outdir: dir.join("dist"),
			target: "bun",
			plugins: [stubPlugin],
		});
		expect(bundle.success, bundle.logs.map(log => log.message).join("\n")).toBe(true);
		const entry = bundle.outputs.find(output => output.kind === "entry-point");
		if (!entry) throw new Error("perturbation probe emitted no entry point");
		// The bundle's asset import is relative to the bundle; from another cwd only bundle-relative resolution finds it.
		const child = Bun.spawn([process.execPath, entry.path], { cwd: dir.path(), stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(sample.variants).toContain(JSON.parse(stdout));
	});

	it("leaves text that matches no pooled source untouched", () => {
		const text = "An arbitrary sentence that no pool entry could have authored.";
		expect(perturbPromptText(text)).toBe(text);
	});

	it("rewrites system blocks and tool descriptions but preserves tool identity and schemas", () => {
		const parameters = { type: "object", properties: {} } as const;
		optIn(true);
		const context = perturbContext(model, {
			systemPrompt: [sample.source, "Kept as-is."],
			messages: [],
			tools: [{ name: "read", description: sample.source, parameters }],
		});
		expect(context.systemPrompt?.[0]).not.toBe(sample.source);
		expect(context.systemPrompt?.[1]).toBe("Kept as-is.");
		expect(context.tools?.[0]?.description).not.toBe(sample.source);
		expect(context.tools?.[0]?.name).toBe("read");
		expect(context.tools?.[0]?.parameters).toBe(parameters);
	});

	it("sends the original prose unless the model opts in through its KDL policy", () => {
		optIn(false);
		expect(perturbContext(model, sampleContext)).toBe(sampleContext);
	});

	it("lets OMP_PROMPT_PERTURBATION override the KDL policy in both directions", () => {
		optIn(false);
		process.env.OMP_PROMPT_PERTURBATION = "1";
		expect(perturbContext(model, sampleContext).systemPrompt?.[0]).not.toBe(sample.source);
		optIn(true);
		process.env.OMP_PROMPT_PERTURBATION = "0";
		expect(perturbContext(model, sampleContext)).toBe(sampleContext);
	});
});
