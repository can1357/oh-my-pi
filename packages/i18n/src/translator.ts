import { formatDate, formatNumber, formatRelativeTime } from "./formatter";
import type { Locale } from "./locale";
import { EN_MESSAGES, type MessageKey, type MessageValue, ZH_CN_MESSAGES } from "./messages";

export type MessageValues = Readonly<Record<string, string | number>>;

export interface I18n {
	readonly locale: Locale;
	t(key: MessageKey, values?: MessageValues): string;
	number(value: number, options?: Intl.NumberFormatOptions): string;
	date(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
	relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string;
}

export interface I18nOptions {
	onMissingKey?: (key: string) => void;
}

function flattenMessages(messages: Readonly<Record<string, unknown>>): Map<string, MessageValue> {
	const result = new Map<string, MessageValue>();

	const visit = (value: unknown, prefix: string): void => {
		if (typeof value === "string") {
			result.set(prefix, value);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Readonly<Record<string, unknown>>;
		if (typeof record.other === "string") {
			const plural = Object.fromEntries(
				Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			) as Readonly<Record<string, string>>;
			result.set(prefix, plural);
			return;
		}
		for (const [key, child] of Object.entries(record)) {
			visit(child, prefix ? `${prefix}.${key}` : key);
		}
	};

	for (const [key, value] of Object.entries(messages)) visit(value, key);
	return result;
}

function interpolate(value: string, values: MessageValues | undefined): string {
	return value.replaceAll(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name: string) => {
		const replacement = values?.[name];
		return replacement === undefined ? placeholder : String(replacement);
	});
}

function renderMessage(value: MessageValue, locale: Locale, values: MessageValues | undefined): string {
	if (typeof value === "string") return interpolate(value, values);
	const count = values?.count;
	const category = typeof count === "number" ? new Intl.PluralRules(locale).select(count) : "other";
	return interpolate(value[category] ?? value.other, values);
}

export function createI18n(locale: Locale, options: I18nOptions = {}): I18n {
	const english = flattenMessages(EN_MESSAGES);
	const localized = locale === "en" ? english : flattenMessages(ZH_CN_MESSAGES);

	return {
		locale,
		t(key, values) {
			const message = localized.get(key) ?? english.get(key);
			if (!message) options.onMissingKey?.(key);
			return message ? renderMessage(message, locale, values) : "Translation unavailable";
		},
		number(value, options) {
			return formatNumber(locale, value, options);
		},
		date(value, options) {
			return formatDate(locale, value, options);
		},
		relativeTime(value, unit) {
			return formatRelativeTime(locale, value, unit);
		},
	};
}
