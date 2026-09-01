#!/usr/bin/env bun
/**
 * Rewrite each package's `[Unreleased]` changelog section for release notes.
 *
 * A release cycle accumulates noisy implementation notes: a feature is added,
 * then internal bugs in that same not-yet-released feature are fixed, transport
 * plumbing is refactored, and behavior is renamed before anyone uses it. Only
 * the final shipped behavior belongs in release notes.
 *
 * For every non-empty `[Unreleased]` section this script hands the whole section
 * to a small model (default `openai-codex/gpt-5.6-luna` via `@oh-my-pi/pi-ai`),
 * and asks for a complete replacement grouped by changelog category. The model
 * returns structured sections/items; markdown is rendered locally so only the
 * Unreleased section changes and formatting stays deterministic.
 *
 * The prompt defines "user-visible" for package consumers broadly: public
 * exports/API, provider behavior, auth/errors, config, performance, and
 * breaking changes are visible; pure implementation/test/refactor/internal
 * protocol churn is not.
 *
 * Usage:
 *   bun scripts/rewrite-changelog.ts                       # rewrite + write
 *   bun scripts/rewrite-changelog.ts --dry-run             # report only
 *   bun scripts/rewrite-changelog.ts --check               # exit 1 if any would change
 *   bun scripts/rewrite-changelog.ts --package coding-agent
 *   bun scripts/rewrite-changelog.ts --model google/gemini-3.5-flash
 *
 * Auth: resolves the provider API key through omp's auth storage
 * (~/.omp/agent/agent.db: stored key, OAuth, or env var fallback).
 */

import * as path from "node:path";
import { parseArgs } from "node:util";
import { type } from "@oh-my-pi/omptype";
import { type Api, completeSimple, Effort, type Model, type Tool, type ToolCall } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	type ChangelogDocument,
	changelogPaths,
	type NumberedLine,
	parseChangelog,
	parseItems,
	type ReleaseSection,
	renderChangelog,
	resolveRepoRoot,
} from "./fix-changelogs";

const DEFAULT_MODEL = "openai-codex/gpt-5.6-luna";
/** Tried in order after the primary model fails (quota exhaustion, auth, hard API errors). */
const FALLBACK_MODELS = [];

// --------------------------------------------------------------------------
// Prompts

const SYSTEM_PROMPT = `You audit and consolidate the \`[Unreleased]\` section of a package's changelog, rewriting it into high-quality, user-facing release notes before a new release.

Your goal is to transform technical developer bullets into concise, user-facing release notes by:
1. Dropping non-user-visible internal implementation/test/refactor/infrastructure details.
2. Eliminating intermediate developer churn (e.g. fixes or changes made to features or systems that were *newly introduced in this same batch*).
3. Merging or consolidating multiple related internal milestones into single, unified, high-quality feature bullets.
4. Rewriting technical jargon to be clear, professional, and useful for the package's consumers (audience).

Call the \`rewrite\` tool with the rewritten release note sections.

---

## 1. What to Drop (Do Not Include)

- **Intermediate Churn/Fixes**: A bug fix or additional adjustment made to a feature, provider, command, or API that was itself added or introduced *in this same unreleased batch*. Users only ever see the final shipped state, so a line like "Fixed crash in new feature X" is redundant because the feature X they get will already be stable.
- **Pure Implementation Details**: Internal protocol messages/helpers, private exports, local WebSocket routing, transport-metadata handling, logging/tracing modifications, intermediate retry/recovery strategies, cache/session storage internal mechanics, serialization/parsing adjustments, or renamed internal variables.
- ** Bring-Up Spam**: If this batch introduces a completely new provider or major subsystem, do not list 20 separate lines detailing how different parts of that subsystem were wired up. Consolidate them into a single clean summary of the new system's capabilities.
- **Obsolete/Canceled Changes**: If a feature was added and then removed in this same batch, omit both.

## 2. What to Keep and Consolidate

- **User-Visible Capabilities**: New features, updated provider capabilities, authentication flow changes, config settings, and CLI commands.
- **Genuine Bug Fixes**: Fixes to issues that existed in a *previously released* version (this is vital, user-facing value!).
- **Breaking Changes**: Any actual backward-incompatible modifications to public exports, configuration, behavior, or API contracts.
- **External Behavior Parity**: Important performance enhancements, support for new model providers/features, and resilience/error handling improvements that developers calling the SDK/CLI will experience.

## 3. How to Rewrite and Consolidate

- **Merge Related Bullets**: Instead of listing five technical bullets for different GitLab Duo Workflow features (OAuth callbacks, workspace project auto-discovery, namespace enablement), merge them into one:
  > Added GitLab Duo Workflow provider support including official OAuth callback verification, workspace project auto-discovery, and automatic login-time namespace Duo enablement.
- **Be Concise and User-Facing**: Turn developer jargon (e.g., "replayed thinking blocks without context-management.keep") into description of the actual benefit (e.g., "Fixed preserving multi-turn thinking/reasoning context for Anthropic-compatible models").
- **Remove Leading Symbols**: Write the item as a clean text string without prepending "- " or "* ". The harness will handle bullet formatting locally.`;

// --------------------------------------------------------------------------
// Model + auth

interface RewriteModel {
	model: Model<Api>;
	apiKey: string;
	spec: string;
}

async function openModel(modelSpec: string): Promise<RewriteModel> {
	const slash = modelSpec.indexOf("/");
	if (slash <= 0) throw new Error(`--model must be <provider>/<model-id>, got "${modelSpec}"`);
	const provider = modelSpec.slice(0, slash);
	const modelId = modelSpec.slice(slash + 1);
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	if (!model) throw new Error(`unknown model "${modelSpec}" (not in bundled catalog)`);
	const storage = await discoverAuthStorage({ sourceLabel: "rewrite-changelog" });
	try {
		const apiKey = await storage.getApiKey(provider);
		if (!apiKey) {
			throw new Error(
				`no credentials for provider "${provider}" via ${storage.sourceLabel ?? "auth storage"} (check broker or run \`omp login\`)`,
			);
		}
		return { model, apiKey, spec: modelSpec };
	} finally {
		// Broker-backed storage runs a background SSE/long-poll loop that keeps
		// the event loop alive; release it once the key is captured.
		storage.close();
	}
}

// --------------------------------------------------------------------------
// Unreleased entries

interface UnreleasedEntry {
	index: number;
	category: string;
	text: string;
}

function unreleasedSection(document: ChangelogDocument): ReleaseSection | undefined {
	return document.sections.find(section => section.title === "Unreleased");
}

function collectEntries(section: ReleaseSection): UnreleasedEntry[] {
	const entries: UnreleasedEntry[] = [];
	let index = 1;
	for (const subsection of section.subsections) {
		for (const item of parseItems(subsection.lines)) {
			entries.push({ index: index++, category: subsection.title, text: item.lines.join("\n") });
		}
	}
	return entries;
}

// --------------------------------------------------------------------------
// LLM call

interface RewrittenSection {
	category: string;
	items: string[];
}

const REWRITE_RESPONSE = type({
	sections: type({
		category: "'Breaking Changes' | 'Added' | 'Changed' | 'Fixed' | 'Removed'",
		items: "string[]",
	})
		.array()
		.default(() => []),
});

const REWRITE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		sections: {
			type: "array",
			description: "Rewritten release note sections grouped by changelog category.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					category: {
						type: "string",
						enum: ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"],
					},
					items: {
						type: "array",
						description: "Consolidated, user-facing release note items for this category.",
						items: { type: "string" },
					},
				},
				required: ["category", "items"],
			},
		},
	},
	required: ["sections"],
} as unknown as Tool["parameters"];

const REWRITE_TOOL: Tool = {
	name: "rewrite",
	description: "Return the rewritten, consolidated release sections.",
	parameters: REWRITE_PARAMETERS,
	strict: false,
};

function validateRewrite(args: Record<string, unknown>): RewrittenSection[] {
	const parsed = REWRITE_RESPONSE(args);
	if (parsed instanceof type.errors) {
		throw new Error(`invalid tool arguments: ${parsed.summary}`);
	}
	return parsed.sections
		.map(sec => ({
			category: sec.category,
			items: sec.items.map(item => item.trim()).filter(Boolean),
		}))
		.filter(sec => sec.items.length > 0);
}

function normalizeRewriteItem(text: string): string[] {
	const lines = text
		.trim()
		.split("\n")
		.map(l => l.trimEnd());
	if (lines.length === 0) return [];
	const first = lines[0] ?? "";
	const content = first.startsWith("- ") ? first.slice(2) : first.startsWith("* ") ? first.slice(2) : first;
	const out = [`- ${content}`];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		out.push(line.startsWith("  ") ? line : `  ${line}`);
	}
	return out;
}

async function requestRewrite(
	model: RewriteModel,
	packageName: string,
	unreleasedBody: string,
): Promise<RewrittenSection[]> {
	const userText = `Package: \`${packageName}\`

Original \`[Unreleased]\` section body:
\`\`\`markdown
${unreleasedBody}
\`\`\`

Consolidate and rewrite this content into user-visible release notes. Keep all public API/config/auth/billing behavior, but drop intermediate churn and implementation-only details. Return the structured sections using the \`rewrite\` tool.`;
	let lastError = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await completeSimple(
			model.model,
			{
				systemPrompt: [SYSTEM_PROMPT],
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				tools: [REWRITE_TOOL],
			},
			{ apiKey: model.apiKey, toolChoice: { type: "tool", name: "rewrite" }, reasoning: Effort.Low, temperature: 0 },
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			lastError = response.errorMessage ?? response.stopReason;
			await Bun.sleep(1500 * (attempt + 1));
			continue;
		}

		const call = response.content.find(
			(content): content is ToolCall => content.type === "toolCall" && content.name === "rewrite",
		);
		if (!call) {
			lastError = "model returned no structured tool call";
			continue;
		}
		try {
			return validateRewrite(call.arguments);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new Error(`rewrite call failed for ${packageName}: ${lastError}`);
}

// --------------------------------------------------------------------------
// Run

interface RewrittenFile {
	path: string;
	originalCount: number;
	rewrittenCount: number;
	sections: RewrittenSection[];
}

interface RunOptions {
	repoRoot?: string;
	model: string;
	write: boolean;
	packageFilter?: string;
	concurrency?: number;
}

interface RunResult {
	model: string;
	changed: RewrittenFile[];
}

function applyRewrite(section: ReleaseSection, sections: RewrittenSection[]): void {
	section.subsections = sections
		.map(sec => {
			const rawLines = sec.items.flatMap(normalizeRewriteItem);
			const lines: NumberedLine[] = rawLines.map(text => ({ text, lineNumber: 0 }));
			return { title: sec.category, lines };
		})
		.filter(sub => sub.lines.length > 0);
}

async function run(options: RunOptions): Promise<RunResult> {
	const repoRoot = await resolveRepoRoot(options.repoRoot);
	const paths = (await changelogPaths(repoRoot)).filter(
		changelogPath => !options.packageFilter || changelogPath.includes(options.packageFilter),
	);
	const specs = [options.model, ...FALLBACK_MODELS.filter(spec => spec !== options.model)];
	const opened = new Map<string, Promise<RewriteModel>>();
	// Once a model spec fails (all requestRewrite retries or open error), later
	// files skip straight to the next spec instead of re-burning its retries.
	let activeSpec = 0;
	async function rewriteWithFallback(packageName: string, unreleasedBody: string): Promise<RewrittenSection[]> {
		let lastError: unknown;
		for (let i = activeSpec; i < specs.length; i++) {
			const spec = specs[i];
			if (!spec) continue;
			try {
				let model = opened.get(spec);
				if (!model) {
					model = openModel(spec);
					opened.set(spec, model);
				}
				return await requestRewrite(await model, packageName, unreleasedBody);
			} catch (error) {
				lastError = error;
				activeSpec = Math.max(activeSpec, i + 1);
				const next = specs[i + 1];
				if (next) {
					const message = error instanceof Error ? error.message : String(error);
					console.warn(`${packageName}: ${spec} failed (${message}); falling back to ${next}`);
				}
			}
		}
		throw lastError;
	}
	const concurrency = options.concurrency ?? 4;
	const results: Array<RewrittenFile | undefined> = new Array(paths.length);

	let pathIndex = 0;
	async function worker() {
		while (pathIndex < paths.length) {
			const i = pathIndex++;
			const changelogPath = paths[i];
			if (!changelogPath) continue;
			const absolutePath = path.join(repoRoot, changelogPath);
			const content = await Bun.file(absolutePath).text();
			const document = parseChangelog(content);
			const section = unreleasedSection(document);
			if (!section) continue;

			const originalCount = section.subsections.reduce((sum, sub) => sum + parseItems(sub.lines).length, 0);
			if (originalCount === 0) continue;

			const unreleasedBody = renderChangelog({ prefixLines: [], sections: [section] })
				.replace(/^## \[Unreleased\]\n?/, "")
				.trim();

			const rewritten = await rewriteWithFallback(changelogPath, unreleasedBody);
			applyRewrite(section, rewritten);
			const next = renderChangelog(document);
			if (next === content) continue;

			const rewrittenCount = rewritten.reduce((sum, sec) => sum + sec.items.length, 0);
			if (options.write) {
				await Bun.write(absolutePath, next);
			}

			results[i] = {
				path: changelogPath,
				originalCount,
				rewrittenCount,
				sections: rewritten,
			};
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, paths.length) }, worker);
	await Promise.all(workers);

	const changed: RewrittenFile[] = [];
	for (const res of results) {
		if (res !== undefined) changed.push(res);
	}

	return { model: specs.slice(0, activeSpec + 1).join(" -> "), changed };
}

// --------------------------------------------------------------------------
// CLI

interface CliOptions {
	mode: "write" | "dry-run" | "check";
	model: string;
	repoRoot?: string;
	packageFilter?: string;
	concurrency: number;
}

function parseCli(argv: string[]): CliOptions | "help" {
	const { values } = parseArgs({
		args: argv,
		options: {
			"dry-run": { type: "boolean", default: false },
			check: { type: "boolean", default: false },
			model: { type: "string", short: "m", default: DEFAULT_MODEL },
			package: { type: "string" },
			"repo-root": { type: "string" },
			concurrency: { type: "string", default: "4" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) return "help";
	return {
		mode: values.check ? "check" : values["dry-run"] ? "dry-run" : "write",
		model: values.model,
		repoRoot: values["repo-root"],
		packageFilter: values.package,
		concurrency: Number.parseInt(values.concurrency ?? "4", 10),
	};
}

function usage(): string {
	return [
		"Usage: bun scripts/rewrite-changelog.ts [--dry-run|--check] [-m|--model <prov/id>] [--package <substr>] [--concurrency <n>]",
		"",
		"Hands each non-empty [Unreleased] changelog section to a small model and rewrites the entries",
		"into user-facing release notes, dropping intermediate developer churn and implementation-only details",
		"while preserving public contract, exports, API, config, auth, and billing behavior.",
		"",
		"Options:",
		`  -m, --model <prov/id>  Classifier model (default ${DEFAULT_MODEL}${FALLBACK_MODELS.length > 0 ? `; falls back to ${FALLBACK_MODELS.join(", ")} on failure` : ""}).`,
		"  --package <substr> Only changelogs whose path contains this substring.",
		"  --concurrency <n>  Max concurrent changelogs to process in parallel (default 4).",
		"  --dry-run          Report what would be dropped without writing files.",
		"  --check            Exit 1 if any changelog would change.",
		"  --repo-root <dir>  Run against an explicit repository root.",
	].join("\n");
}

function printSummary(result: RunResult, mode: CliOptions["mode"]): void {
	if (result.changed.length === 0) {
		console.log(`No redundant or non-user-visible [Unreleased] entries to rewrite (model ${result.model}).`);
		return;
	}
	const suffix = mode === "write" ? "" : ` (${mode}, not written)`;
	console.log(`Rewrote [Unreleased] sections across ${result.changed.length} changelog(s)${suffix}:`);
	for (const file of result.changed) {
		console.log(`\n  ${file.path} (${file.originalCount} items -> ${file.rewrittenCount} items):`);
		for (const sec of file.sections) {
			console.log(`    ### ${sec.category}`);
			for (const item of sec.items) {
				console.log(`      - ${item}`);
			}
		}
	}
}

async function main(): Promise<void> {
	try {
		const cli = parseCli(process.argv.slice(2));
		if (cli === "help") {
			console.log(usage());
			return;
		}
		const result = await run({
			repoRoot: cli.repoRoot,
			model: cli.model,
			write: cli.mode === "write",
			packageFilter: cli.packageFilter,
			concurrency: cli.concurrency,
		});
		printSummary(result, cli.mode);
		if (cli.mode === "check" && result.changed.length > 0) {
			process.exit(1);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (import.meta.main) {
	await main();
}

export { applyRewrite, collectEntries, type RunResult, run, unreleasedSection, validateRewrite };
