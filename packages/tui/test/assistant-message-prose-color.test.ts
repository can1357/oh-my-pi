import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { getThemeByName, initTheme, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const RENDER_WIDTH = 80;
const PROSE = "Assistant prose must be themeable.";
/** Distinctive hue for the token; its escape depends on the terminal's color depth. */
const TOKEN_HEX = "#ff00ff";
/** The base dark theme JSON — a known-valid theme we extend with the token. */
const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "theme", "dark.json");

const originalImageProtocol = TERMINAL.imageProtocol;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let tmpAgentDir: string;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Write a custom theme (the dark palette plus `colors` overrides) into the temp
 * agent dir and activate it. Loading goes through `parseThemeJson`, so this also
 * proves the runtime schema accepts the token.
 *
 * Returns the activated theme so callers can derive the token's escape through the
 * same public accessor the component uses: the concrete bytes depend on the
 * terminal's detected color depth (truecolor vs 256), which differs between a
 * local Windows Terminal and CI.
 */
async function applyTheme(name: string, colors: Record<string, string>) {
	const dark = (await Bun.file(DARK_THEME_PATH).json()) as Record<string, unknown>;
	const baseColors = (dark.colors ?? {}) as Record<string, unknown>;
	const themesDir = getCustomThemesDir();
	await fs.mkdir(themesDir, { recursive: true });
	await Bun.write(
		path.join(themesDir, `${name}.json`),
		JSON.stringify({ ...dark, name, colors: { ...baseColors, ...colors } }, null, 2),
	);
	const loaded = await getThemeByName(name);
	if (!loaded) throw new Error(`theme ${name} failed to load`);
	setThemeInstance(loaded);
	return loaded;
}

beforeAll(async () => {
	await initTheme(false);
});

/** Restore the process-wide theme so later suites in the same run see the default dark theme. */
afterAll(async () => {
	const dark = await getThemeByName("dark");
	if (dark) setThemeInstance(dark);
});

beforeEach(async () => {
	tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prose-color-"));
	setAgentDir(tmpAgentDir);
	setTerminalImageProtocol(null);
});

afterEach(async () => {
	setTerminalImageProtocol(originalImageProtocol);
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await removeWithRetries(tmpAgentDir);
});

describe("assistant prose theme token", () => {
	// Regression for #11204: assistant paragraph prose had no token and always
	// rendered at the terminal default foreground.
	it("paints assistant paragraph prose with the assistantMessageText token", async () => {
		const theme = await applyTheme("prose-colored", { assistantMessageText: TOKEN_HEX });

		const rendered = new AssistantMessageComponent(assistantMessage(PROSE)).render(RENDER_WIDTH).join("\n");

		expect(rendered).toContain(theme.fg("assistantMessageText", PROSE));
		expect(Bun.stripANSI(rendered)).toContain(PROSE);
	});

	it("leaves prose in the terminal default foreground when the token is unset", async () => {
		await applyTheme("prose-unset", {});

		const rendered = new AssistantMessageComponent(assistantMessage(PROSE)).render(RENDER_WIDTH).join("\n");
		const proseLine = rendered.split("\n").find(line => line.includes(PROSE));

		// Row-padded, but the prose run carries no foreground SGR at all.
		expect(proseLine?.trimEnd()).toBe(` ${PROSE}`);
	});

	it("resolves an omitted optional token to the terminal default", async () => {
		// A model-role color may name this token even when the active theme omits
		// it; painting it must degrade to the terminal default, not throw.
		const theme = await applyTheme("prose-omitted", {});

		expect(theme.hasColor("assistantMessageText")).toBe(false);
		expect(theme.fg("assistantMessageText", PROSE)).toBe(`\x1b[39m${PROSE}\x1b[39m`);
	});

	it("keeps an explicitly installed prose color transform over the token", async () => {
		const theme = await applyTheme("prose-explicit", { assistantMessageText: TOKEN_HEX });
		const green = "\x1b[38;2;0;255;0m";
		// Live-command output installs the transform on a fresh component before
		// its content arrives; mirror that ordering.
		const component = new AssistantMessageComponent();
		component.setTextColorTransform(text => `${green}${text}\x1b[39m`);
		component.updateContent(assistantMessage(PROSE));

		const rendered = component.render(RENDER_WIDTH).join("\n");

		expect(rendered).toContain(green);
		expect(rendered).not.toContain(theme.fg("assistantMessageText", PROSE));
	});

	// D2 regression (PR #11260): markdown sub-elements must keep their own
	// md* token colors; the prose token paints plain runs only, and the
	// mdHeading/mdLink escape stays the innermost (winning) SGR.
	it("keeps mdHeading and mdLink colors over the assistant prose token", async () => {
		const theme = await applyTheme("prose-md-precedence", { assistantMessageText: TOKEN_HEX });
		const md = "# Heading One\n\nplain paragraph with [link](https://example.com)";

		const rendered = new AssistantMessageComponent(assistantMessage(md)).render(RENDER_WIDTH).join("\n");
		const headingLine = rendered.split("\n").find(line => line.includes("Heading One")) ?? "";
		const linkLine = rendered.split("\n").find(line => line.includes("link")) ?? "";

		// mdHeading wins inside the heading: its escape encloses the heading text
		// with no prose-color escape between it and the text.
		expect(headingLine).toContain(theme.fg("mdHeading", "Heading One"));
		expect(headingLine).not.toContain(theme.fg("assistantMessageText", "Heading One"));
		// mdLink wins inside the link text.
		expect(linkLine).toContain(theme.fg("mdLink", "link"));
		expect(linkLine).not.toContain(theme.fg("assistantMessageText", "link"));
		// Plain prose runs still carry the token.
		expect(rendered).toContain(theme.fg("assistantMessageText", "plain paragraph with "));
	});

	// D1 regression (PR #11260): the stable-snapshot renderer must use the
	// same prose transform as the live child Markdown; otherwise the frozen
	// prefix's bytes diverge from the live render and #publishStableSnapshot's
	// byte-prefix guard silently disables mid-stream scrollback publication.
	it("publishes token-colored streaming prose as stable scrollback rows", async () => {
		const theme = await applyTheme("prose-stable-stream", { assistantMessageText: TOKEN_HEX });
		const full =
			"The first paragraph of a streaming turn is long enough to wrap onto its own rows. ".repeat(2) +
			"\n\nThe second paragraph is still being streamed.";
		const component = new AssistantMessageComponent();
		component.updateContent(assistantMessage(`${full.slice(0, 60)}\n\nSec`), { transient: true });
		component.render(RENDER_WIDTH);
		component.updateContent(assistantMessage(full), { transient: true });
		component.render(RENDER_WIDTH);

		const stableCount = component.getTranscriptStableRows().length;
		expect(stableCount).toBeGreaterThan(0);
		const stableRows = component.renderTranscriptStableRows(stableCount, RENDER_WIDTH);
		// Published prefix is painted with the prose token — the wrap may split
		// the phrase mid-word, so assert the row's prose text opens with the
		// token escape exactly as the live render's first row does.
		const tokenEscape = theme.fg("assistantMessageText", "x").split("x").join("").replace("\x1b[39m", "");
		const firstProseRow = stableRows.find(row => row.includes("The first paragraph"));
		expect(firstProseRow?.startsWith(` ${tokenEscape}The first`)).toBe(true);
	});

	it("keeps the explicit transform painting headings and links (live-command contract)", async () => {
		await applyTheme("prose-explicit-md", { assistantMessageText: TOKEN_HEX });
		const green = "\x1b[38;2;0;255;0m";
		const component = new AssistantMessageComponent();
		component.setTextColorTransform(text => `${green}${text}\x1b[39m`);
		const md = "# Heading One\n\nplain paragraph with [link](https://example.com)";
		component.updateContent(assistantMessage(md));

		const rendered = component.render(RENDER_WIDTH).join("\n");

		// The live-command transform paints every run, including semantically
		// themed spans; only mdLinkUrl keeps its own token (never passed through
		// the prose transform, matching pre-token behavior).
		expect(rendered).toContain(`${green}Heading One`);
		expect(rendered).toContain(`${green}link`);
		expect(rendered).toContain(`${green}plain paragraph with`);
	});
});
