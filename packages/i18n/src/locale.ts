export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = "auto" | Locale;

export interface LocaleResolutionInput {
	explicit?: LocalePreference;
	configured?: LocalePreference;
	environment?: readonly string[];
}

function normalizeLanguageTag(value: string): string {
	return value.trim().split(/[.@]/, 1)[0]!.replaceAll("_", "-").toLowerCase();
}

export function normalizeLocale(value: string | undefined): Locale | undefined {
	if (!value) return undefined;
	const normalized = normalizeLanguageTag(value);
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-cn-")) return "zh-CN";
	return undefined;
}

function resolvePreference(value: LocalePreference | undefined): Locale | undefined {
	return value && value !== "auto" ? normalizeLocale(value) : undefined;
}

export function resolveLocale(input: LocaleResolutionInput): Locale {
	const explicit = resolvePreference(input.explicit);
	if (explicit) return explicit;

	const configured = resolvePreference(input.configured);
	if (configured) return configured;

	for (const value of input.environment ?? []) {
		const locale = normalizeLocale(value);
		if (locale) return locale;
	}

	return "en";
}
