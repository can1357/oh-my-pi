import baseRuCatalog from "./ui-language-ru.json" with { type: "json" };
import cliRuCatalog from "./ui-language-cli-ru.json" with { type: "json" };
import tuiRuCatalog from "./ui-language-tui-ru.json" with { type: "json" };
import slashRuCatalog from "./ui-language-slash-ru.json" with { type: "json" };
import settingsRuCatalog from "./ui-language-settings-ru.json" with { type: "json" };
import setupRuCatalog from "./ui-language-setup-ru.json" with { type: "json" };

declare const __OMP_RU_BUILD__: boolean | undefined;

/** True only for binaries explicitly compiled with OMP_BUILD_FLAVOR=ru. */
export const IS_RUSSIAN_BUILD: boolean =
	typeof __OMP_RU_BUILD__ !== "undefined" && __OMP_RU_BUILD__ === true;

export type UiLanguage = "ru" | "en";
export type UiTextVariables = Readonly<Record<string, string | number>>;

let activeLanguage: UiLanguage = IS_RUSSIAN_BUILD ? "ru" : "en";

/** Set the current display language; persist the choice through the settings layer. */
export function setUiLanguage(language: UiLanguage): void {
	activeLanguage = language;
}

/** Return the active display language. */
export function getUiLanguage(): UiLanguage {
	return activeLanguage;
}

const catalog: Readonly<Record<string, string>> = {
	...cliRuCatalog,
	...slashRuCatalog,
	...tuiRuCatalog,
	...setupRuCatalog,
	...baseRuCatalog,
	...settingsRuCatalog,
};

function lookup(key: string): string | undefined {
	return Object.hasOwn(catalog, key) ? catalog[key] || undefined : undefined;
}

/**
 * Translate one static user-interface template at its display boundary.
 * Interpolation is a single pass, so runtime values can never be retranslated.
 */
export function uiText(english: string, vars?: UiTextVariables, context?: string): string {
	const template =
		activeLanguage === "ru"
			? ((context ? lookup(`${context}\u0004${english}`) : undefined) ?? lookup(english) ?? english)
			: english;
	if (!vars || !template.includes("{{")) return template;
	return template.replace(/\{\{([\w.-]+)\}\}/g, (placeholder, name: string) =>
		Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
	);
}
