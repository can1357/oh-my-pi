import { getLanguage, getMessages, t } from "@oh-my-pi/pi-utils/i18n";

/** Browser assets share a context so CLI wording can evolve independently. */
export function translateBrowserMessage(source: string): string {
	return t(`${source}\u0004browser-assets`);
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, character => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/** Pass the selected pack to bundled browser UI before its modules execute. */
export function browserLanguagePackScript(): string {
	return `<script id="omp-i18n" type="application/json">${scriptJson({ language: getLanguage(), messages: getMessages() })}</script>`;
}

/** Replace only explicit static message arguments; browser expressions stay in the browser. */
export function localizeBrowserScript(source: string): string {
	return source.replace(/\bompT\(("(?:[^"\\]|\\.)*")/g, (_match, literal: string) => {
		const translated = translateBrowserMessage(JSON.parse(literal));
		// These literals may be embedded in an HTML script, including user-edited language packs.
		const safe = scriptJson(translated);
		return `ompT(${safe}`;
	});
}

/** Localize only annotated static text/attributes, never arbitrary DOM or session content. */
export function localizeBrowserHtml(source: string): string {
	return localizeBrowserScript(source)
		.replace(
			/(<html\b[^>]*\blang=")[^"]*(")/i,
			(_match, before: string, after: string) => `${before}${getLanguage()}${after}`,
		)
		.replace(
			/<([a-z][\w:-]*)\b([^<>]*\sdata-omp-i18n(?=\s|>)[^<>]*)>([^<>]*)<\/\1>/gi,
			(_match, tag: string, attributes: string, text: string) =>
				`<${tag}${attributes.replace(/\sdata-omp-i18n(?=\s|$)/, "")}>${escapeHtml(translateBrowserMessage(text))}</${tag}>`,
		)
		.replace(/<[^<>]*\sdata-omp-i18n-attrs="([^"]+)"[^<>]*>/g, (tag: string, names: string) => {
			for (const name of names.split(/\s+/)) {
				if (!["title", "aria-label", "placeholder"].includes(name)) continue;
				tag = tag.replace(
					new RegExp(`(\\b${name}=")([^"]*)(")`),
					(_match, before: string, text: string, after: string) =>
						`${before}${escapeHtml(translateBrowserMessage(text))}${after}`,
				);
			}
			return tag.replace(/\sdata-omp-i18n-attrs="[^"]*"/, "");
		});
}

/** Manifest messages are JSON values, not HTML or executable script. */
export function localizeBrowserManifest(source: string): string {
	const manifest = JSON.parse(source);
	manifest.description = translateBrowserMessage(manifest.description);
	manifest.action.default_title = translateBrowserMessage(manifest.action.default_title);
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}
