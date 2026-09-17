#!/usr/bin/env bun
/**
 * Builtin shortcut for the prompt-inference probe.
 *
 * Instead of hand-writing a tool's JSON schema + outline, point this at a live
 * builtin tool name. It resolves the tool (direct constructor for availability-gated
 * `github`/`irc`, else the BUILTIN_TOOLS/HIDDEN_TOOLS factory map), pulls the EXACT wire
 * schema the model sees (`toolWireSchema`) and the rendered prompt (`tool.description`),
 * derives an outline by blanking section bodies, then runs the same `probe()` panel.
 *
 * Usage:
 *   bun probe-builtin.ts --tool <name> [--no-summary] [--show]
 *     --tool <name>      builtin tool name (e.g. irc, github, read). Required.
 *     --no-summary       ablation: blank the one-line summary too (isolate schema-alone).
 *     --show             print resolved schema + outline + real prompt and exit (no API calls).
 *     --samples / --model / --max-tokens / --json  forwarded to probe().
 *
 * The heavy coding-agent import lives here; probe.ts stays pi-ai-only.
 */
import { parseArgs } from "node:util";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, GithubTool, HIDDEN_TOOLS, IrcTool, type Tool, type ToolFactory, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { probe } from "./probe.ts";

const OPEN_TAG = /^<[a-z_][\w-]*>$/i;
const CLOSE_TAG = /^<\/[a-z_][\w-]*>$/i;
const MD_HEADER = /^#{1,6}\s/;

/** Keep the summary + every section header/tag; collapse each body run to a single `...`. */
function deriveOutline(description: string, dropSummary: boolean): string {
	const lines = description.split("\n");
	let i = 0;
	const summary: string[] = [];
	const isHeader = (l: string): boolean => {
		const t = l.trim();
		return OPEN_TAG.test(t) || CLOSE_TAG.test(t) || MD_HEADER.test(l);
	};
	while (i < lines.length && !isHeader(lines[i])) {
		summary.push(lines[i]);
		i++;
	}
	const parts: string[] = [dropSummary ? "" : summary.join("\n").trim()];
	let pendingBody = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const t = line.trim();
		if (OPEN_TAG.test(t) || MD_HEADER.test(line)) {
			parts.push("", line);
			pendingBody = false;
		} else if (CLOSE_TAG.test(t)) {
			parts.push(line);
			pendingBody = false;
		} else if (t !== "") {
			if (!pendingBody) {
				parts.push("...");
				pendingBody = true;
			}
		}
	}
	return parts.join("\n").trim();
}

async function resolveTool(name: string): Promise<Tool> {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const settings = Settings.isolated({});
	// Enriched stub: we only read `.parameters` / `.description`, never `execute`, so the
	// availability-gated factories (irc needs a registry + agent id; github needs `gh`) can
	// still construct. Factory map bypasses the settings allowlist (`isToolAllowed`).
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		taskDepth: 0,
		getAgentId: () => "Probe",
		agentRegistry: {},
	} as ToolSession;
	// `github`/`irc` map to `*.createIf`, which gates on external availability (gh CLI) or a
	// live agent registry. We only read `.parameters`/`.description`, so direct-construct those
	// two — keeps the probe gh-independent. Everything else goes through the factory map.
	const direct: Record<string, (s: ToolSession) => Tool> = {
		github: s => new GithubTool(s),
		irc: s => new IrcTool(s),
	};
	const key = name.toLowerCase();
	const directCtor = direct[key];
	if (directCtor) return directCtor(session);
	const factories: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const factory = factories[key];
	if (!factory) {
		const names = Object.keys(factories).sort().join(", ");
		throw new Error(`unknown builtin tool "${name}". available: ${names}`);
	}
	const tool = await factory(session);
	if (!tool) {
		throw new Error(`tool "${name}" did not construct here — blocked by an availability gate (e.g. ssh, or a memory backend that isn't configured). Fall back to the manual --schema/--template path.`);
	}
	return tool;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			tool: { type: "string" },
			"no-summary": { type: "boolean" },
			show: { type: "boolean" },
			samples: { type: "string" },
			model: { type: "string" },
			"max-tokens": { type: "string" },
			json: { type: "boolean" },
		},
		allowPositionals: false,
	});

	if (!values.tool) {
		console.error("usage: bun probe-builtin.ts --tool <name> [--no-summary] [--show] [--samples N] [--model p/id,...] [--max-tokens N] [--json]");
		process.exit(2);
	}

	const tool = await resolveTool(values.tool);
	const schema = toolWireSchema(tool);
	const realPrompt = tool.description ?? "";
	const outline = deriveOutline(realPrompt, Boolean(values["no-summary"]));

	if (values.show) {
		console.log(`# tool: ${tool.name}\n\n## wire schema\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n`);
		console.log(`## derived outline\n${outline}\n`);
		console.log(`## real prompt (${Buffer.byteLength(realPrompt)} bytes)\n${realPrompt}`);
		return;
	}

	const run = await probe({
		schema,
		template: outline,
		name: tool.name,
		samples: values.samples ? Number(values.samples) : undefined,
		models: values.model ? values.model.split(",").map(s => s.trim()).filter(Boolean) : undefined,
		maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
	});

	if (values.json) {
		console.log(JSON.stringify({ ...run, realPrompt }, null, 2));
		return;
	}

	for (const result of run.results) {
		console.log(`\n############ ${result.model} ############`);
		result.samples.forEach((s, i) => {
			const tag = s.error ? `ERROR: ${s.error}` : s.stopReason;
			console.log(`\n----- sample ${i + 1}/${result.samples.length} [${tag}] -----`);
			console.log(s.error ? "" : s.text);
		});
	}
	console.log(`\n############ REAL PROMPT (${tool.name}) ############\n${realPrompt}`);
}

if (import.meta.main) {
	await main();
}
