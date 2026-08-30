import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { StaticPromptContextSources } from "../../system-prompt";

export type StaticContextComponentId =
	| "renderedSystemTemplate"
	| "nativeToolSchemas"
	| "projectContextBlocks"
	| "skillCatalog";

/**
 * Provider-facing static fragments and their exact budget ownership.
 * `completeStaticContext` preserves the canonical request-field boundaries.
 * The four component sequences may introduce split boundaries while assigning
 * embedded sections; their byte/token residual belongs to the system template.
 */
export interface StaticContextSources {
	readonly completeStaticContext: readonly string[];
	readonly renderedSystemTemplate: readonly string[];
	readonly nativeToolSchemas: readonly string[];
	readonly projectContextBlocks: readonly string[];
	readonly skillCatalog: readonly string[];
}

export function combineStaticContextSources(
	promptSources: StaticPromptContextSources,
	nativeToolSchemas: readonly string[],
): StaticContextSources {
	return {
		completeStaticContext: [...promptSources.completeSystemPrompt, ...nativeToolSchemas],
		renderedSystemTemplate: promptSources.renderedSystemTemplate,
		nativeToolSchemas,
		projectContextBlocks: promptSources.projectContextBlocks,
		skillCatalog: promptSources.skillCatalog,
	};
}

/**
 * Reconcile prompt-section ownership with the system blocks currently sent by
 * the agent. Appended blocks keep the captured base ownership; a replacement
 * invalidates that split and owns the effective prompt as rendered template.
 */
export function reconcileStaticPromptContextSources(
	captured: StaticPromptContextSources,
	effectiveSystemPrompt: readonly string[],
): StaticPromptContextSources {
	const capturedPromptPreserved = captured.completeSystemPrompt.every(
		(fragment, index) => effectiveSystemPrompt[index] === fragment,
	);
	if (capturedPromptPreserved) {
		return { ...captured, completeSystemPrompt: effectiveSystemPrompt };
	}
	return {
		completeSystemPrompt: effectiveSystemPrompt,
		renderedSystemTemplate: effectiveSystemPrompt,
		projectContextBlocks: [],
		skillCatalog: [],
	};
}

export interface StaticContextComponent {
	readonly id: StaticContextComponentId;
	readonly label: string;
	readonly bytes: number;
	readonly tokens: number;
	readonly percentOfStaticTokens: number;
}

export type StaticContextWindow =
	| { readonly kind: "known"; readonly tokens: number; readonly percentUsed: number }
	| { readonly kind: "unknown" };

export interface StaticContextReport {
	readonly components: readonly [
		StaticContextComponent,
		StaticContextComponent,
		StaticContextComponent,
		StaticContextComponent,
	];
	readonly total: {
		readonly bytes: number;
		readonly tokens: number;
	};
	readonly contextWindow: StaticContextWindow;
}

export interface BuildStaticContextReportOptions {
	readonly sources: StaticContextSources;
	readonly tokenizer: Tokenizer;
	readonly contextWindowTokens?: number;
}

interface ComponentMeasurement {
	readonly id: StaticContextComponentId;
	readonly label: string;
	readonly bytes: number;
	readonly tokens: number;
}

function measure(
	id: StaticContextComponentId,
	label: string,
	fragments: readonly string[],
	tokenizer: Tokenizer,
): ComponentMeasurement {
	let bytes = 0;
	for (const fragment of fragments) bytes += Buffer.byteLength(fragment, "utf8");
	return { id, label, bytes, tokens: tokenizer.countTokens(Array.from(fragments)) };
}

function withStaticPercentage(measurement: ComponentMeasurement, totalTokens: number): StaticContextComponent {
	return {
		...measurement,
		percentOfStaticTokens: totalTokens === 0 ? 0 : (measurement.tokens / totalTokens) * 100,
	};
}

export function buildStaticContextReport(options: BuildStaticContextReportOptions): StaticContextReport {
	const { sources, tokenizer } = options;
	const measuredSystemTemplate = measure(
		"renderedSystemTemplate",
		"Rendered system template",
		sources.renderedSystemTemplate,
		tokenizer,
	);
	const nativeToolSchemas = measure("nativeToolSchemas", "Native tool schemas", sources.nativeToolSchemas, tokenizer);
	const projectContextBlocks = measure(
		"projectContextBlocks",
		"Project/context blocks",
		sources.projectContextBlocks,
		tokenizer,
	);
	const skillCatalog = measure("skillCatalog", "Skill catalog/listing", sources.skillCatalog, tokenizer);
	let completeBytes = 0;
	for (const fragment of sources.completeStaticContext) completeBytes += Buffer.byteLength(fragment, "utf8");
	const total = {
		bytes: completeBytes,
		tokens: tokenizer.countTokens(Array.from(sources.completeStaticContext)),
	};
	const measuredBytes =
		measuredSystemTemplate.bytes + nativeToolSchemas.bytes + projectContextBlocks.bytes + skillCatalog.bytes;
	const measuredTokens =
		measuredSystemTemplate.tokens + nativeToolSchemas.tokens + projectContextBlocks.tokens + skillCatalog.tokens;
	const renderedSystemTemplate: ComponentMeasurement = {
		...measuredSystemTemplate,
		bytes: measuredSystemTemplate.bytes + total.bytes - measuredBytes,
		tokens: measuredSystemTemplate.tokens + total.tokens - measuredTokens,
	};
	if (renderedSystemTemplate.bytes < 0 || renderedSystemTemplate.tokens < 0) {
		throw new Error("Static context component measurements exceed the complete provider-boundary sequence");
	}
	const contextWindow: StaticContextWindow =
		typeof options.contextWindowTokens === "number" &&
		Number.isFinite(options.contextWindowTokens) &&
		options.contextWindowTokens > 0
			? {
					kind: "known",
					tokens: options.contextWindowTokens,
					percentUsed: (total.tokens / options.contextWindowTokens) * 100,
				}
			: { kind: "unknown" };

	return {
		components: [
			withStaticPercentage(renderedSystemTemplate, total.tokens),
			withStaticPercentage(nativeToolSchemas, total.tokens),
			withStaticPercentage(projectContextBlocks, total.tokens),
			withStaticPercentage(skillCatalog, total.tokens),
		],
		total,
		contextWindow,
	};
}

export function formatStaticContextReport(report: StaticContextReport): string {
	const lines = ["Static context:"];
	for (const component of report.components) {
		const percent = component.percentOfStaticTokens.toFixed(1).replace(/\.0$/, "");
		lines.push(`  ${component.label}: ${component.bytes} bytes, ${component.tokens} tokens (${percent}% of static)`);
	}
	lines.push(`Total static: ${report.total.bytes} bytes, ${report.total.tokens} tokens`);
	if (report.contextWindow.kind === "known") {
		const percent = report.contextWindow.percentUsed.toFixed(1).replace(/\.0$/, "");
		lines.push(`Model context window: ${report.contextWindow.tokens} tokens (${percent}% used by static context)`);
	} else {
		lines.push("Model context window: unknown");
	}
	return lines.join("\n");
}
