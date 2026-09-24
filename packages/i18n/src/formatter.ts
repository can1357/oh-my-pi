import type { Locale } from "./locale";

export function formatNumber(locale: Locale, value: number, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(locale: Locale, value: Date | number, options?: Intl.DateTimeFormatOptions): string {
	return new Intl.DateTimeFormat(locale, options).format(value);
}

export function formatRelativeTime(locale: Locale, value: number, unit: Intl.RelativeTimeFormatUnit): string {
	return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);
}
