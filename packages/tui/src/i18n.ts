import { createI18n, type I18n, type Locale, type MessageKey } from "@oh-my-pi/pi-i18n";

let defaultI18n: I18n = createI18n("en");

export function configureDefaultI18n(locale: Locale | I18n): I18n {
	defaultI18n = typeof locale === "string" ? createI18n(locale) : locale;
	return defaultI18n;
}

export function getDefaultI18n(): I18n {
	return defaultI18n;
}

const FIXED_TUI_TEXT: Readonly<Record<string, MessageKey>> = {
	"  Enter to edit provider · Esc to go back": "tui.hint.enterEditProviderEscBack",
	"  Enter to save · Esc to cancel · Clear field to unset": "tui.hint.enterSaveEscCancelClear",
	"  Enter to select · Esc to go back": "tui.hint.enterSelectEscBack",
};

export function localizeTuiText(value: string): string {
	const key = FIXED_TUI_TEXT[value];
	return key ? getDefaultI18n().t(key) : value;
}
