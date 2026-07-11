/**
 * Web/export palette — the omp brand identity shared by the collab-web live
 * client (`my.omp.sh/`) and every public HTML export / share viewer (`/s/<id>`).
 *
 * Why this exists separately from `modes/theme/dark.json`: the `dark` theme is
 * the **default TUI theme** — its amber accent (`#febc38`) drives the terminal
 * status line, syntax highlighting, thinking levels, and bash/python mode
 * colors for every omp user. The public web artifacts want the collab-web
 * pink/purple identity instead, so they pin this palette rather than inheriting
 * the TUI's. Editing `dark.json` to repurpose it for the web would repaint
 * every terminal; this file keeps the two surfaces decoupled.
 *
 * Token layout — emitted as CSS custom properties on `:root`:
 *   • Legacy export names consumed by `template.css` / `template.js`
 *     (`--text`, `--body-bg`, `--container-bg`, `--info-bg`, `--accent`,
 *      `--border`, `--success`, `--error`, `--warning`, `--muted`, `--dim`,
 *      `--borderAccent`, `--selectedBg`, `--userMessageBg`, `--customMessageBg`,
 *      `--customMessageLabel`, `--mdHeading`, `--mdLink`, `--mdCode`,
 *      `--mdListBullet`, `--toolOutput`, `--thinkingText`, syntax*, …).
 *   • collab-web-native aliases consumed by the `tv-` tool-render bridge
 *     (`tool-render.css`: `var(--bg-inset, …)`, `var(--fg, …)`, …) so embedded
 *     tool cards resolve to the *real* collab-web tokens and render
 *     pixel-identical to the live client.
 *
 * Alpha-bearing tokens (`--border`, `--ring`, `--accent-muted`, …) keep their
 * `oklch(… / N%)` form — flattening them to opaque hex would produce harsh
 * white borders and non-matching translucent focus rings. Opaque surfaces are
 * sRGB hex (the collab-web `tokens.css` OKLCH dark-theme tokens converted via
 * the standard OKLab→linear-sRGB→gamma path); if the live client palette
 * changes, regenerate those from there.
 */
export const WEB_EXPORT_PALETTE = {
	// --- collab-web-native aliases (tv- bridge) ---
	"--bg": "#0f0b14",
	"--bg-raised": "#16111c",
	"--bg-inset": "#09060c",
	"--bg-overlay": "#211b28",
	"--fg": "#e6e3ea",
	"--fg-muted": "#a49faa",
	"--fg-faint": "#6e6974",
	"--accent": "#ed4abf",
	"--accent-muted": "oklch(0.674 0.23 341 / 18%)",
	"--ok": "#68ca80",
	"--err": "#f05653",
	"--warn": "#e4b33f",
	"--ring": "oklch(0.817 0.112 205 / 70%)",
	"--font-mono": 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',

	// --- legacy export names (template.css / template.js) ---
	// surfaces — map onto the collab-web purple ramp
	"--body-bg": "#0f0b14", // = --bg
	"--container-bg": "#16111c", // = --bg-raised
	"--info-bg": "#09060c", // = --bg-inset (recessed wells: code blocks, tool output)
	// text
	"--text": "#e6e3ea", // = --fg
	"--muted": "#a49faa", // = --fg-muted
	"--dim": "#6e6974", // = --fg-faint
	"--thinkingText": "#a49faa",
	// hairlines — white-alpha, matching collab-web's --border/--border-strong
	"--border": "oklch(1 0 0 / 9%)",
	"--borderMuted": "oklch(1 0 0 / 6%)",
	// accent + brand purple (the gradient's mid stop) for secondary highlights
	"--borderAccent": "#945ff9",
	"--selectedBg": "#2d2535",
	// status — semantic, used sparingly (cancelled / exit-code / success dots)
	"--success": "#68ca80", // = --ok
	"--error": "#f05653", // = --err
	"--warning": "#e4b33f", // = --warn
	// message bubbles
	"--userMessageBg": "oklch(0.674 0.23 341 / 6%)", // accent-tinted, like template.css user-message
	"--userMessageText": "#e6e3ea",
	"--customMessageBg": "#211b28", // = --bg-overlay
	"--customMessageText": "#a49faa", // = --fg-muted
	"--customMessageLabel": "#b281d6", // lilac, matching dark.json's label hue
	// tool surfaces
	"--toolPendingBg": "#16111c",
	"--toolSuccessBg": "#09060c",
	"--toolErrorBg": "oklch(0.66 0.19 25 / 14%)",
	"--toolTitle": "#e6e3ea",
	"--toolOutput": "#a49faa", // = --fg-muted
	// markdown
	"--mdHeading": "#ed4abf", // accent — headings carry the brand
	"--mdLink": "#5ad8e5", // ring cyan — links distinct from the pink accent
	"--mdLinkUrl": "#6e6974", // = --fg-faint
	"--mdCode": "#e6e3ea",
	"--mdCodeBlock": "#e6e3ea",
	"--mdCodeBlockBorder": "oklch(1 0 0 / 9%)",
	"--mdQuote": "#a49faa",
	"--mdQuoteBorder": "oklch(1 0 0 / 13%)",
	"--mdHr": "oklch(1 0 0 / 9%)",
	"--mdListBullet": "#ed4abf", // accent — bullets carry the brand
	// diff
	"--toolDiffAdded": "#68ca80",
	"--toolDiffRemoved": "#f05653",
	"--toolDiffContext": "#6e6974",
	// syntax — cool-neutral with pink/purple accents for keywords/types
	"--syntaxComment": "#6e6974", // = --fg-faint
	"--syntaxKeyword": "#945ff9", // brand purple
	"--syntaxFunction": "#e4b33f", // warn amber (analog of dark.json's DCDCAA)
	"--syntaxVariable": "#5ad8e5", // ring cyan
	"--syntaxString": "#68ca80", // ok green
	"--syntaxNumber": "#ed4abf", // accent
	"--syntaxType": "#b281d6", // lilac
	"--syntaxOperator": "#e6e3ea",
	"--syntaxPunctuation": "#a49faa",
	// thinking-level ramp — purple → lilac, matching the brand gradient
	"--thinkingOff": "#6e6974",
	"--thinkingMinimal": "#6e6974",
	"--thinkingLow": "#945ff9",
	"--thinkingMedium": "#b281d6",
	"--thinkingHigh": "#ed4abf",
	"--thinkingXhigh": "#e4b33f",
	// mode tints (sidebar/role tags) — not surfaced in the export tree but
	// emitted for completeness so template.js role classes resolve cleanly
	"--bashMode": "#5ad8e5",
	"--pythonMode": "#e4b33f",
	// status-line tokens are TUI-only; not consumed by the export template, but
	// emitted so any future surface that reads them inherits the brand.
	"--statusLineBg": "#0f0b14",
	"--statusLineSep": "#6e6974",
	"--statusLineModel": "#ed4abf",
	"--statusLinePath": "#5ad8e5",
	"--statusLineGitClean": "#68ca80",
	"--statusLineGitDirty": "#e4b33f",
	"--statusLineContext": "#a49faa",
	"--statusLineSpend": "#5ad8e5",
	"--statusLineStaged": "#68ca80",
	"--statusLineDirty": "#e4b33f",
	"--statusLineUntracked": "#945ff9",
	"--statusLineOutput": "#b281d6",
	"--statusLineCost": "#b281d6",
	"--statusLineSubagents": "#ed4abf",
} as const satisfies Record<string, string>;

/** Serialize the palette as `--key: value;` declarations for `:root { … }`. */
export function webExportThemeVars(): string {
	let out = "";
	for (const k in WEB_EXPORT_PALETTE) {
		out += `${k}: ${WEB_EXPORT_PALETTE[k as keyof typeof WEB_EXPORT_PALETTE]}; `;
	}
	return out.trimEnd();
}
