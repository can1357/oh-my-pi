import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const extensionContext =
	'import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";\ndeclare const pi: ExtensionAPI;\n';
// Fence IDs, rather than block positions, let surrounding prose and examples move freely.
const sources = {
	"docs/extensions.md": {
		"extensions-quick-start": "",
		"extensions-command-provider": "declare function runCommandAndPushEvents(...args: unknown[]): Promise<void>;\n",
		"extensions-tool-call-guard": extensionContext,
		"extensions-tool-template": extensionContext,
	},
	"docs/hooks.md": { "hooks-context-filter": "" },
	"docs/skills/authoring-hooks.md": { "skills-context-filter": "" },
	"packages/coding-agent/examples/extensions/README.md": {
		"extensions-readme": "",
		"extensions-readme-reconstruct": extensionContext,
	},
	"packages/coding-agent/examples/hooks/README.md": { "hooks-readme": "" },
	"packages/ai/README.md": {
		"ai-provider-options": 'import type { Context } from "@oh-my-pi/pi-ai";\ndeclare const context: Context;\n',
		"ai-type-safety":
			'import { stream, type Context } from "@oh-my-pi/pi-ai";\nimport { getBundledModel } from "@oh-my-pi/pi-catalog/models";\ndeclare const context: Context;\n',
		"ai-multi-provider": "",
	},
};
const assertions: Record<string, string> = {
	"ai-type-safety": `
const api: "anthropic-messages" = claude.api;
// @ts-expect-error Anthropic options must reject OpenAI's reasoning option.
stream(claude, context, { reasoning: "high" });
`,
	"ai-multi-provider": `
const claudeApi: "anthropic-messages" = claude.api;
const gptApi: "openai-responses" = gpt5.api;
const geminiApi: "google-generative-ai" = gemini.api;
`,
	"ai-provider-options": `
const openaiApi: "openai-responses" = openaiModel.api;
const anthropicApi: "anthropic-messages" = anthropicModel.api;
const googleApi: "google-generative-ai" = googleModel.api;
// @ts-expect-error OpenAI options must reject Anthropic's thinking budget.
complete(openaiModel, context, { thinkingBudgetTokens: 2048 });
`,
};

/** Extract named TypeScript fences; neither source formatting nor ordinal positions are contracts. */
function codeBlocks(markdown: string): Map<string, string> {
	const blocks = new Map<string, string>();
	const lines = markdown.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const fence = lines[index]!.match(/^(`{3,}|~{3,})(?:ts|typescript)\s+check=([\w-]+)\s*$/);
		if (!fence) continue;
		const [, delimiter, id] = fence;
		const body: string[] = [];
		for (index++; index < lines.length && lines[index]!.trim() !== delimiter; index++) body.push(lines[index]!);
		if (index === lines.length) throw new Error(`Unclosed TypeScript fence: ${id}`);
		if (blocks.has(id!)) throw new Error(`Duplicate TypeScript fence: ${id}`);
		blocks.set(id!, `${body.join("\n")}\n`);
	}
	return blocks;
}

async function compile(config: string): Promise<{ exitCode: number; diagnostics: string }> {
	const child = Bun.spawn([path.join(repoRoot, "node_modules/.bin/tsgo"), "--project", config, "--pretty", "false"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, diagnostics: stdout + stderr };
}

it("compiles the documented extension, hook and provider examples and rejects a broken extracted block", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-doc-snippets-"));
	try {
		await fs.symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
		const files: string[] = [];
		for (const [source, snippets] of Object.entries(sources)) {
			const blocks = codeBlocks(await Bun.file(path.join(repoRoot, source)).text());
			for (const [id, prelude] of Object.entries(snippets)) {
				const body = blocks.get(id);
				if (body === undefined) throw new Error(`Missing TypeScript fence ${id} in ${source}`);
				const file = path.join(dir, `${id}.ts`);
				await Bun.write(file, prelude + body + (assertions[id] ?? ""));
				files.push(file);
			}
		}
		const config = path.join(dir, "tsconfig.json");
		await Bun.write(
			config,
			JSON.stringify({ extends: path.join(repoRoot, "tsconfig.base.json"), files, include: [] }),
		);
		const result = await compile(config);
		expect(result.diagnostics).toBe("");
		expect(result.exitCode).toBe(0);

		// Mutate only a temporary extracted copy: the check must catch a broken documented parameter.
		const quickStart = path.join(dir, "extensions-quick-start.ts");
		const valid = await Bun.file(quickStart).text();
		await Bun.write(quickStart, valid.replaceAll("params.name", "params.missingDocumentedParameter"));
		const broken = await compile(config);
		expect(broken.exitCode).not.toBe(0);
		expect(broken.diagnostics).toContain("extensions-quick-start.ts");
		expect(broken.diagnostics).toContain("missingDocumentedParameter");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 120_000);
