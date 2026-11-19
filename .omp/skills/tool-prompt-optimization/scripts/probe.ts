#!/usr/bin/env bun
/**
 * Schema -> prompt inference probe.
 *
 * Given a tool's JSON parameter schema + a description-prompt outline ("template"),
 * ask one or more models to reconstruct the full description. Whatever they reliably
 * predict is inferable from the schema/outline alone — i.e. a candidate to PRUNE from
 * the hand-written prompt. Run several samples and several models: trust only content
 * that is STABLE across samples AND agrees across models.
 *
 * Routes through @oh-my-pi/pi-ai (`completeSimple`) rather than raw HTTP so model
 * resolution, auth, and provider quirks match production.
 * Per-provider env keys (<PROVIDER>_API_KEY) are resolved automatically; temperature is never sent.
 * Caller passes two things: a JSON schema and a template. Everything else has defaults.
 * With no `--model`, probes a 3-model panel (Fireworks Kimi, Claude Opus, GPT) x 3 samples.
 *
 * CLI:
 *   bun probe.ts --schema <file|json> --template <file|text> [options]
 *     --name <toolName>           tool name shown to the model (default "the tool")
 *     --samples <n>               independent samples per model (default 3)
 *     --model <p/id[,p/id...]>    override panel; comma-separated for several
 *     --max-tokens <n>            output cap (default 1200)
 *     --json                      emit JSON instead of human-readable blocks
 *
 * Programmatic: import { probe } from "./probe.ts"
 */
import { parseArgs } from "node:util";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/** Default 3-model panel when the caller does not pin a model. */
const DEFAULT_MODELS = ["fireworks/kimi-k2.7-code", "anthropic/claude-opus-4-8", "openai/gpt-5.5"];
const DEFAULT_SAMPLES = 3;

const SYSTEM_PROMPT = [
	"You write the description prompt that an AI coding agent reads to learn one of its built-in tools.",
	"You are given ONLY the tool name and its JSON parameter schema, plus a fixed description outline.",
	"Fill in the outline: replace every `...` and write the body of every named section, grounded strictly in the schema.",
	"Output ONLY the finished description as markdown. No preamble, no commentary, no surrounding code fence.",
].join("\n");

export interface ProbeOptions {
	/** JSON Schema for the tool's parameters (object or JSON string). */
	schema: unknown;
	/** Description outline: a one-line summary + section skeleton (with `...` placeholders). */
	template: string;
	/** Tool name surfaced to the model. */
	name?: string;
	/** Independent samples per model. Only content stable across samples is trustworthy. */
	samples?: number;
	/** `provider/id` list. Defaults to the 3-model panel. */
	models?: string[];
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface ProbeSample {
	text: string;
	stopReason: AssistantMessage["stopReason"];
	usage?: AssistantMessage["usage"];
	error?: string;
}

export interface ProbeModelResult {
	model: string;
	samples: ProbeSample[];
}

export interface ProbeRun {
	prompt: string;
	results: ProbeModelResult[];
}

function resolveModel(ref: string): Model<Api> {
	const slash = ref.indexOf("/");
	if (slash === -1) throw new Error(`model must be "provider/id", got: ${ref}`);
	// Runtime-validated below: getBundledModel returns undefined for an unknown provider/id.
	const provider = ref.slice(0, slash) as GeneratedProvider;
	const id = ref.slice(slash + 1);
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`unknown bundled model: ${ref}`);
	return model;
}

function extractText(content: AssistantMessage["content"]): string {
	let out = "";
	for (const block of content) {
		if (block.type === "text") out += block.text;
	}
	return out.trim();
}

function buildUserPrompt(name: string, schema: unknown, template: string): string {
	const schemaText = typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
	return [
		`Tool name: ${name}`,
		"",
		"JSON parameter schema:",
		"```json",
		schemaText,
		"```",
		"",
		"Description outline to complete (write the body of every section; output ONLY the finished description):",
		"",
		template,
	].join("\n");
}

export async function probe(opts: ProbeOptions): Promise<ProbeRun> {
	const refs = opts.models && opts.models.length > 0 ? opts.models : DEFAULT_MODELS;
	const name = opts.name ?? "the tool";
	const sampleCount = Math.max(1, opts.samples ?? DEFAULT_SAMPLES);
	const userPrompt = buildUserPrompt(name, opts.schema, opts.template);

	const drawOne = async (model: Model<Api>): Promise<ProbeSample> => {
		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: [SYSTEM_PROMPT],
					messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
				},
				{
					maxTokens: opts.maxTokens ?? 1200,
					disableReasoning: true,
					signal: opts.signal,
				},
			);
			const text = extractText(response.content);
			const sample: ProbeSample = { text, stopReason: response.stopReason, usage: response.usage };
			if (response.stopReason === "error") sample.error = response.errorMessage ?? "unknown error";
			return sample;
		} catch (err) {
			return { text: "", stopReason: "error", error: err instanceof Error ? err.message : String(err) };
		}
	};

	const results = await Promise.all(
		refs.map(async (ref): Promise<ProbeModelResult> => {
			let model: Model<Api>;
			try {
				model = resolveModel(ref);
			} catch (err) {
				return { model: ref, samples: [{ text: "", stopReason: "error", error: err instanceof Error ? err.message : String(err) }] };
			}
			const samples = await Promise.all(Array.from({ length: sampleCount }, () => drawOne(model)));
			return { model: `${model.provider}/${model.id}`, samples };
		}),
	);

	return { prompt: userPrompt, results };
}

async function resolveInput(value: string): Promise<string> {
	const file = Bun.file(value);
	if (await file.exists()) return (await file.text()).trim();
	return value;
}

function formatUsage(usage: AssistantMessage["usage"] | undefined): string {
	if (!usage) return "";
	const out = typeof usage.output === "number" ? usage.output : undefined;
	return out === undefined ? "" : `, ${out} tok`;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			schema: { type: "string" },
			template: { type: "string" },
			name: { type: "string" },
			samples: { type: "string" },
			model: { type: "string" },
			"max-tokens": { type: "string" },
			json: { type: "boolean" },
		},
		allowPositionals: false,
	});

	if (!values.schema || !values.template) {
		console.error(
			"usage: bun probe.ts --schema <file|json> --template <file|text> [--name N] [--samples 3] [--model p/id,p/id] [--max-tokens 1200] [--json]",
		);
		process.exit(2);
	}

	const schemaRaw = await resolveInput(values.schema);
	let schema: unknown = schemaRaw;
	try {
		schema = JSON.parse(schemaRaw);
	} catch {
		// Leave as raw text — caller may pass a non-JSON schema notation.
	}
	const template = await resolveInput(values.template);

	const run = await probe({
		schema,
		template,
		name: values.name,
		samples: values.samples ? Number(values.samples) : undefined,
		models: values.model ? values.model.split(",").map(s => s.trim()).filter(Boolean) : undefined,
		maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
	});

	if (values.json) {
		console.log(JSON.stringify(run, null, 2));
		return;
	}

	for (const result of run.results) {
		console.log(`\n############ ${result.model} ############`);
		result.samples.forEach((s, i) => {
			const tag = s.error ? `ERROR: ${s.error}` : `${s.stopReason}${formatUsage(s.usage)}`;
			console.log(`\n----- sample ${i + 1}/${result.samples.length} [${tag}] -----`);
			console.log(s.error ? "" : s.text);
		});
	}
}

if (import.meta.main) {
	await main();
}
