import { describe, expect, it } from "bun:test";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { McpAuthorizationLink } from "../../../src/ui/transcript/messages/mcp-auth";

/** The block's terminal rows at `width` (with escapes), on a terminal that draws hyperlinks. */
function renderLink(url: string, width: number, launchUrl?: string): string[] {
	const term = createTestTerminal(() => ({ main: McpAuthorizationLink({ url, launchUrl }) }), {
		columns: width,
		rows: 200,
		capabilities: { hyperlinks: true },
	});
	const rows = [...term.rows()];
	while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
	return rows.map(row => row.trimEnd());
}

const OSC = "\x1b]";

function extractLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1];
}

const COPY_URL_LABEL = "Copy URL:";
const SHORTCUT_LABEL = "Local shortcut (this machine only):";

const LONG_AUTH_URL =
	"https://mcp.notion.com/oauth/authorize?response_type=code&client_id=notion-mcp-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A17895%2Fcallback&scope=read%3Aworkspace%20read%3Acontent&state=abcdef0123456789abcdef0123456789";

// Linear-shaped repro from #4418: the whole point of the fix is that the
// trailing `code_challenge_method=S256` is preserved even when the composed
// row would exceed the viewport.
const LINEAR_AUTH_URL = `https://mcp.linear.app/authorize?response_type=code&client_id=abcdefghij0123456789ABCDEFGHIJ0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&scope=read%20write%20mcp%3Aall&state=0123456789abcdef0123456789abcdef&code_challenge=5MlkJfN2GhX9uP0rQ7sT8vB1oCwDeFgHiJkLmNoPqRsTuVwXyZ&code_challenge_method=S256`;

/**
 * Reassemble the copy-URL rows for `label` into a single string, mirroring a
 * real multi-row terminal selection pasted into an address bar: browsers
 * strip the newlines, but any other leading bytes survive (verbatim or
 * percent-encoded) — so chunks are concatenated RAW, with no indent-stripping
 * that could mask a corrupting prefix. Returns "" if the label row isn't
 * found.
 */
function reassembleUrl(plainLines: string[], label: string): string {
	const start = plainLines.findIndex(line => line.startsWith(` ${label}`));
	if (start < 0) return "";
	const first = plainLines[start]!;
	// Inline form contains the whole URL on the label row.
	const inlineMatch = first.match(new RegExp(`^ ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (.*)$`));
	if (inlineMatch) return inlineMatch[1]!;
	// Wrapped form: indented label row, then UNINDENTED continuation chunks.
	// Any indented row (the next label) or blank row ends this URL's chunks.
	let joined = "";
	for (let i = start + 1; i < plainLines.length; i++) {
		const line = plainLines[i]!;
		if (line.startsWith(" ") || line.trim().length === 0) break;
		joined += line;
	}
	return joined;
}

describe("McpAuthorizationLink", () => {
	it("renders a clickable hyperlink label and inline Copy URL row when the row fits the viewport", () => {
		// Width large enough to keep ` Copy URL: <LONG_AUTH_URL>` on one row.
		const lines = renderLink(LONG_AUTH_URL, 1000);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain(`${OSC}8;`);
		expect(extractLinkUri(lines[1])).toBe(LONG_AUTH_URL);
		expect(plainLines[1]).toContain("Click here to authorize");
		expect(plainLines[2]).toBe(` ${COPY_URL_LABEL} ${LONG_AUTH_URL}`);
	});

	it("hard-wraps the full URL into width-fitted chunks so a narrow viewport cannot silently drop trailing parameters", () => {
		// #4418 fingerprint: narrow terminal + long S256 URL. Pre-fix, the
		// row went through `truncateToWidth(..., Ellipsis.Omit)` and dropped
		// `code_challenge_method=S256`. Post-fix, the render itself keeps
		// every character.
		const width = 80;
		const lines = renderLink(LINEAR_AUTH_URL, width);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		// Every emitted row fits inside the viewport, so nothing is cut.
		for (const line of plainLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Wrapping puts the label on its own indented row followed by
		// UNINDENTED continuation chunks — zero leading bytes, so a multi-row
		// selection pastes back to the exact URL.
		const labelRow = plainLines.indexOf(` ${COPY_URL_LABEL}`);
		expect(labelRow).toBeGreaterThanOrEqual(0);
		expect(plainLines[labelRow + 1]!.startsWith(" ")).toBe(false);

		// Chunks reassemble to the URL byte-for-byte — the trailing
		// `code_challenge_method=S256` MUST be present.
		const reassembled = reassembleUrl(plainLines, COPY_URL_LABEL);
		expect(reassembled).toBe(LINEAR_AUTH_URL);
		expect(reassembled).toEndWith("&code_challenge_method=S256");
	});

	it("links every wrapped chunk to the full URL under one OSC 8 id so a click never opens a fragment", () => {
		// #20192: unlinked chunks let terminal URL auto-detection open only the
		// clicked row — an authorize request missing its trailing parameters.
		const lines = renderLink(LINEAR_AUTH_URL, 80);
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const labelRow = plainLines.indexOf(` ${COPY_URL_LABEL}`);
		const chunks = lines.slice(labelRow + 1);
		expect(chunks.length).toBeGreaterThan(1);

		const ids = new Set<string | undefined>();
		for (const chunk of chunks) {
			expect(extractLinkUri(chunk)).toBe(LINEAR_AUTH_URL);
			ids.add(chunk.match(/\x1b\]8;id=([^;]+);/)?.[1]);
		}
		expect(ids.size).toBe(1);
		expect(ids.has(undefined)).toBe(false);
	});

	it("keeps the full URL as the primary copy target even when a launch shortcut is available", () => {
		const launchUrl = "http://localhost:14570/launch";
		const lines = renderLink(LINEAR_AUTH_URL, 80, launchUrl);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		// Full URL primacy: an SSH user copying the top URL after the label
		// still gets the whole authorize URL, byte-for-byte, so their local
		// browser reaches the provider.
		expect(reassembleUrl(plainLines, COPY_URL_LABEL)).toBe(LINEAR_AUTH_URL);
		// OSC 8 hyperlink continues to carry the full URL.
		expect(extractLinkUri(lines[1])).toBe(LINEAR_AUTH_URL);
	});

	it("advertises launchUrl as an additional local shortcut, wrapped to width so it also can never truncate", () => {
		const launchUrl = "http://localhost:14570/launch";
		const width = 80;
		const lines = renderLink(LINEAR_AUTH_URL, width, launchUrl);
		const plainLines = lines.map(line => Bun.stripANSI(line));

		for (const line of plainLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Local-shortcut row is emitted, either inline (when the label + URL
		// fit) or wrapped. Either way it reassembles to `launchUrl` exactly.
		expect(plainLines.some(line => line.includes(SHORTCUT_LABEL))).toBe(true);
		expect(reassembleUrl(plainLines, SHORTCUT_LABEL)).toBe(launchUrl);
	});

	it("omits the local-shortcut row when launchUrl is absent or identical to the full URL", () => {
		const withoutLaunch = renderLink(LONG_AUTH_URL, 1000);
		expect(withoutLaunch.some(line => line.includes(SHORTCUT_LABEL))).toBe(false);

		const withRedundantLaunch = renderLink(LONG_AUTH_URL, 1000, LONG_AUTH_URL);
		expect(withRedundantLaunch.some(line => line.includes(SHORTCUT_LABEL))).toBe(false);
	});

	it("floors the wrap width so degenerately-narrow viewports still emit every character", () => {
		// Below 16 cols the terminal is unusable, but the render still emits
		// chunks (bounded at the 16-column floor). No character is silently
		// dropped; the user can widen and reflow.
		const lines = renderLink(LINEAR_AUTH_URL, 4);
		const plainLines = lines.map(line => Bun.stripANSI(line));
		expect(reassembleUrl(plainLines, COPY_URL_LABEL)).toBe(LINEAR_AUTH_URL);
	});
});
