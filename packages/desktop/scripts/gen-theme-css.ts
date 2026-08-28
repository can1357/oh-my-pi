/**
 * Emits `src/styles/tui-theme.css` from one of omp's own TUI themes.
 *
 * The colours in the transcript are not this app's invention: they are the
 * theme the CLI paints with, `titanium` by default. Reading them from the
 * source keeps the two from drifting the way a hand-copied palette does — the
 * previous one was sampled by eye from a screenshot and collapsed two surfaces
 * into the same black.
 *
 * It reads the theme's JSON rather than calling `getResolvedThemeColors`, even
 * though that is the canonical resolver. Importing it pulls coding-agent's
 * whole module graph into this package's type-check, which turned a clean
 * `check:types` into 42 errors from four packages this one does not build.
 * The three resolution rules it applies are small and are restated below with
 * a pointer at the file that owns them; the output was diffed against the
 * resolver's and is identical.
 *
 * Runs under Bun at author time, never in the webview. The output is committed.
 */
import themeJson from "../../coding-agent/src/modes/theme/defaults/titanium.json" with { type: "json" };

/*
 * Pinned, not selected. The import above is the whole knob: point it at another
 * file in that directory and the column changes theme. Anything more than that
 * would be a theme system, which nobody asked for.
 */
const THEME = "titanium";
const OUT = new URL("../src/styles/tui-theme.css", import.meta.url);

/*
 * The app's own names, re-pointed at the theme. Doing it this way is what keeps
 * the change small: every rule already written against `--text-strong` or
 * `--background-weak` follows along without being touched, and because the
 * whole block is scoped to one element, nothing outside the column moves.
 *
 * Backgrounds are not ordered by lightness in opencode's set — `base` is the
 * darkest and `weak` the lightest — so a raised surface maps to `weak`.
 */
const APP_TOKENS: Array<[string, string]> = [
	["--background-base", "page-bg"],
	["--background-weak", "card-bg"],
	["--background-strong", "card-bg"],
	["--background-stronger", "info-bg"],
	["--text-strong", "text"],
	["--text-base", "muted"],
	["--text-weak", "muted"],
	["--text-weaker", "dim"],
	["--text-interactive-base", "accent"],
	["--border-base", "border"],
	["--border-focus", "accent"],
	["--icon-success-base", "success"],
	["--icon-warning-base", "warning"],
	["--icon-critical-base", "error"],
	["--text-diff-add-base", "toolDiffAdded"],
	["--text-diff-add-strong", "toolDiffAdded"],
	["--text-diff-delete-base", "toolDiffRemoved"],
	["--text-diff-delete-strong", "toolDiffRemoved"],
];

/*
 * The documented seam into the shared tool renderers: they read these host-side
 * names, not the `--tv-*` variables. Redefining them here rather than in
 * tv-bridge.css keeps the tool cards on the theme inside the column and on the
 * app's palette anywhere else.
 */
const HOST_ALIASES: Array<[string, string]> = [
	["--fg", "text"],
	["--fg-muted", "muted"],
	["--fg-faint", "dim"],
	["--bg-raised", "card-bg"],
	["--bg-inset", "page-bg"],
	["--border", "border"],
	["--ring", "accent"],
	["--accent", "accent"],
	["--ok", "success"],
	["--err", "error"],
	["--warn", "warning"],
];

function kebab(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/*
 * The three rules, from coding-agent/src/modes/theme/color.ts:
 *
 *   a bare name   a reference into the theme's own `vars` block. Any string
 *                 that is not empty and does not start with `#` is one — there
 *                 is no sigil, and an unknown name is an error, not a colour.
 *   `""`      "whatever the terminal's default foreground is" — a real value,
 *             not a missing one. On the web it becomes #e5e5e7 on a dark theme
 *             and #000000 on a light one.
 *   a number  an ANSI-256 index. titanium uses none; `dark` does.
 *
 * A theme counts as light by the luminance of `statusLineBg`, not of the user
 * bubble — some light themes carry a dark bubble.
 */
type ColorValue = string | number;
const theme = themeJson as unknown as {
	vars?: Record<string, string>;
	colors?: Record<string, ColorValue>;
	export?: Record<string, string>;
};

const vars = theme.vars ?? {};

/* Transcribed from color.ts, including its table for the low 16 — those are a
 * convention, not a formula, and deriving them from bit positions gets them
 * wrong. */
const ANSI_BASIC = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

function ansi256ToHex(index: number): string {
	if (index < 16) return ANSI_BASIC[index];
	if (index < 232) {
		const cube = index - 16;
		const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${channel(Math.floor(cube / 36))}${channel(Math.floor((cube % 36) / 6))}${channel(cube % 6)}`;
	}
	const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
	return `#${gray}${gray}${gray}`;
}

function deref(value: ColorValue, seen = new Set<string>()): ColorValue {
	if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
	if (seen.has(value)) throw new Error(`circular variable reference: ${value}`);
	if (!(value in vars)) throw new Error(`variable reference not found: ${value}`);
	seen.add(value);
	return deref(vars[value], seen);
}

function luma(hex: string): number {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) return 0;
	const n = Number.parseInt(m[1], 16);
	return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

const rawColors = theme.colors ?? {};
const statusBg = deref(rawColors.statusLineBg ?? "");
const isLight = typeof statusBg === "string" && luma(statusBg) > 0.5;

function toHex(value: ColorValue): string {
	const resolved = deref(value);
	if (typeof resolved === "number") return ansi256ToHex(resolved);
	if (resolved === "") return isLight ? "#000000" : "#e5e5e7";
	return resolved;
}

const colors: Record<string, string> = {};
for (const [name, value] of Object.entries(rawColors)) colors[name] = toHex(value);

const exportBlock = theme.export ?? {};
const exported = {
	pageBg: exportBlock.pageBg ? toHex(exportBlock.pageBg) : undefined,
	cardBg: exportBlock.cardBg ? toHex(exportBlock.cardBg) : undefined,
	infoBg: exportBlock.infoBg ? toHex(exportBlock.infoBg) : undefined,
};

/*
 * `pageBg`/`cardBg` come from the theme's own `export` block, which is its
 * answer to "what surface goes behind this" — the TUI never paints one, it
 * inherits the terminal's. Guessing from a screenshot would mean guessing at a
 * translucent window over a wallpaper.
 *
 * All three are optional in the source type, and `getThemeExportColors` returns
 * an empty object rather than throwing when a theme has no `export` block. Left
 * unchecked that writes `--tui-page-bg: undefined` into a stylesheet nobody
 * reads again — so it stops here, loudly, instead.
 */
function required(value: string | undefined, key: string): string {
	if (!value) throw new Error(`theme "${THEME}" declares no export.${key}; cannot pick a surface for it`);
	return value;
}

const surfaces: Record<string, string> = {
	"page-bg": required(exported.pageBg, "pageBg"),
	"card-bg": required(exported.cardBg, "cardBg"),
	"info-bg": required(exported.infoBg, "infoBg"),
};

const lines: string[] = [];
lines.push(`/* Generated by scripts/gen-theme-css.ts from omp's \`${THEME}\` theme. Do not edit.`);
lines.push(" *");
lines.push(" * Regenerate with: bun run gen:theme");
lines.push(" *");
lines.push(" * Scoped to `.omp-main` on purpose. The transcript speaks the CLI's palette;");
lines.push(" * the sidebar and the side panel stay on opencode's, which is the boundary");
lines.push(" * the hairlines on either edge of the column are there to state.");
lines.push(" */");
lines.push(".omp-main {");

lines.push("\t/* -- the theme, verbatim ------------------------------------------------- */");
for (const [name, value] of Object.entries(colors).sort(([a], [b]) => a.localeCompare(b))) {
	if (!value) continue;
	lines.push(`\t--tui-${kebab(name)}: ${value};`);
}
for (const [name, value] of Object.entries(surfaces)) {
	lines.push(`\t--tui-${name}: ${value};`);
}

lines.push("");
lines.push("\t/* -- this app's names, re-pointed ---------------------------------------- */");
for (const [token, source] of APP_TOKENS) {
	lines.push(`\t${token}: var(--tui-${surfaces[source] ? source : kebab(source)});`);
}

lines.push("");
lines.push("\t/* -- the tool renderers' host seam --------------------------------------- */");
for (const [token, source] of HOST_ALIASES) {
	lines.push(`\t${token}: var(--tui-${surfaces[source] ? source : kebab(source)});`);
}

lines.push("}");
lines.push("");

await Bun.write(OUT, lines.join("\n"));
console.log(`wrote ${Bun.fileURLToPath(OUT)} — ${Object.keys(colors).length} theme tokens from "${THEME}"`);
