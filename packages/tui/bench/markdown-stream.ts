/**
 * Streaming markdown render benchmark.
 *
 * Simulates a model streaming a long markdown message into one reused
 * `Markdown` component (the interactive-mode hot path): the text grows in
 * fixed-size deltas and the component re-renders after each delta.
 *
 * Exercises the profile hotspots from the 2026-07 capture: marked's GFM `url`
 * tokenizer (73.3% self), inline extension `start()` scans, emStrong, and the
 * streaming stable-prefix freeze (`#freezeStablePrefix`).
 *
 * Run: bun packages/tui/bench/markdown-stream.ts
 */
import { clearRenderCache, Markdown } from "../src/components/markdown";
import { getMarkdownTheme, getMarkdownThemeWithLinkTargets, initTheme } from "../src/theme/theme";
import { defaultMarkdownTheme } from "../test/test-themes";

const WIDTH = 100;
const deltaArgument = process.argv.find(argument => argument.startsWith("--delta="));
const DELTA = deltaArgument === undefined ? 64 : Number(deltaArgument.slice("--delta=".length));
if (!Number.isInteger(DELTA) || DELTA < 1) throw new RangeError("--delta must be a positive integer");
const itemsArgument = process.argv.find(argument => argument.startsWith("--list-items="));
const LIST_ITEMS = itemsArgument === undefined ? 200 : Number(itemsArgument.slice("--list-items=".length));
if (!Number.isInteger(LIST_ITEMS) || LIST_ITEMS < 1) throw new RangeError("--list-items must be a positive integer");

// --- Fixtures -------------------------------------------------------------

/** Long bullet list — the shape that defeats prefix freezing (list guard). */
function bulletList(items: number): string {
	const lines: string[] = [];
	for (let i = 0; i < items; i++) {
		lines.push(
			`- \`packages/tui/src/components/markdown_component_${i}.ts\` handles the ` +
				`stable_prefix_freeze_path_${i} and re-lexes only the unfrozen tail, see ` +
				`https://github.com/can1357/oh-my-pi/issues/${1000 + i} for details on token_${i}.`,
		);
	}
	return `${lines.join("\n")}\n\n`;
}

/** Prose dense in email-branch pathology: long `[A-Za-z0-9._+-]+` runs with no `@`. */
function identifierProse(paragraphs: number): string {
	const parts: string[] = [];
	for (let i = 0; i < paragraphs; i++) {
		parts.push(
			`The resolver maps session_listing.scan_session_file.header_cache_v${i} onto ` +
				`auth_broker.remote_store.filter_usage_reports_${i} while user${i}@example.com and ` +
				`www.example${i}.org stay autolinked; identifiers like RENDER_CACHE_MAX_ENTRY_SIZE_${i} ` +
				`and freeze.stable.prefix.tokens.v${i} must parse as plain *text* with **no** backtracking.`,
		);
	}
	return `${parts.join("\n\n")}\n\n`;
}

function fences(count: number): string {
	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		parts.push(`\`\`\`ts\nconst x_${i} = await fetch("https://api.example.com/v1/usage");\n\`\`\`\n`);
	}
	return `${parts.join("\n")}\n`;
}

const DOC = process.argv.includes("--list-only")
	? bulletList(LIST_ITEMS)
	: identifierProse(20) + bulletList(120) + fences(8) + identifierProse(20) + bulletList(80);
let theme = defaultMarkdownTheme;
if (process.argv.includes("--production-theme")) {
	await initTheme();
	theme = process.argv.includes("--resolved-links")
		? getMarkdownThemeWithLinkTargets(
				new Map([["https://github.com/can1357/oh-my-pi/issues/1000", "https://example.com/resolved"]]),
			)
		: getMarkdownTheme();
}

// --- Bench ----------------------------------------------------------------

function streamOnce(text: string): number {
	clearRenderCache();
	const component = new Markdown("", 0, 0, theme);
	component.transientRenderCache = true;
	const start = Bun.nanoseconds();
	for (let len = DELTA; len < text.length; len += DELTA) {
		component.setText(text.slice(0, len));
		component.render(WIDTH);
	}
	component.setText(text);
	const rendered = component.render(WIDTH);
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	clearRenderCache();
	const cold = new Markdown(text, 0, 0, theme).render(WIDTH);
	if (JSON.stringify(rendered) !== JSON.stringify(cold)) throw new Error("Streaming rows differ from cold rendering");
	return elapsed;
}

function coldOnce(text: string): number {
	clearRenderCache();
	const start = Bun.nanoseconds();
	new Markdown(text, 0, 0, theme).render(WIDTH);
	return (Bun.nanoseconds() - start) / 1e6;
}

console.log(`doc: ${DOC.length} chars, ${Math.ceil(DOC.length / DELTA)} streaming steps, width ${WIDTH}`);
// Warmup (JIT + regex compilation)
streamOnce(DOC.slice(0, 4096));

if (!process.argv.includes("--stream-only")) {
	const cold = coldOnce(DOC);
	console.log(`cold full render: ${cold.toFixed(1)}ms`);
}

const runs: number[] = [];
for (let i = 0; i < 3; i++) runs.push(streamOnce(DOC));
runs.sort((a, b) => a - b);
console.log(`streamed render (${runs.length} runs): min ${runs[0]!.toFixed(1)}ms, median ${runs[1]!.toFixed(1)}ms`);
