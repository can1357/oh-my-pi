/**
 * Display-only string catalog for the settings overlay.
 *
 * A catalog replaces rendered text and nothing else: setting paths, stored
 * values, section slugs and group ordering stay canonical English, so a
 * translation cannot change behaviour. With no catalog installed every lookup
 * returns the English literal at the call site, which keeps the default
 * rendering byte-identical.
 *
 * Key convention:
 * - `tab.<id>.label` / `tab.<id>.lead` — nav label and page lead of a tab
 * - `group.<tab>.<group>` — section heading (`<group>` is the canonical name)
 * - `setting.<path>.label` / `.description` / `.warning` — one setting's text
 * - `setting.<path>.option.<value>.label` / `.description` — one choice's text
 * - `chrome.<name>` — panel furniture: title, hints, `On`/`Off`, …
 * Templates use single-brace placeholders, e.g. `chrome.envNote.override` with `{env}`.
 */
export interface DisplayCatalog {
	readonly locale: string;
	readonly strings: Readonly<Record<string, string>>;
}

let activeCatalog: DisplayCatalog | undefined;
let catalogEpoch = 0;

/** Install a catalog (or clear it with `undefined`); every call invalidates derived caches. */
export function setDisplayCatalog(catalog: DisplayCatalog | undefined): void {
	activeCatalog = catalog;
	catalogEpoch++;
}

/** The catalog currently in effect, if any. */
export function getDisplayCatalog(): DisplayCatalog | undefined {
	return activeCatalog;
}

/** Counter bumped by every {@link setDisplayCatalog}; caches keyed on it rebuild when a catalog arrives. */
export function getDisplayCatalogEpoch(): number {
	return catalogEpoch;
}

/** Text for `key`, or `fallback` (the English literal) when no catalog translates it. */
export function displayText(key: string, fallback: string): string {
	return activeCatalog?.strings[key] ?? fallback;
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Text for `key` with `{name}` placeholders filled from `values`; `fallback` comes
 * back untouched when the key is missing or the template needs a value it lacks.
 */
export function displayTemplate(key: string, fallback: string, values: Readonly<Record<string, string>>): string {
	const template = activeCatalog?.strings[key];
	if (template === undefined) return fallback;
	let missing = false;
	const filled = template.replace(PLACEHOLDER, (placeholder, name: string) => {
		const value = values[name];
		if (value === undefined) {
			missing = true;
			return placeholder;
		}
		return value;
	});
	return missing ? fallback : filled;
}
