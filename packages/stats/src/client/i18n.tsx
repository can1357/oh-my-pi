import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createI18n, resolveLocale, type I18n, type Locale, type LocalePreference } from "@oh-my-pi/pi-i18n";

interface StatsI18nContextValue {
	i18n: I18n;
	preference: LocalePreference;
	setPreference: (preference: LocalePreference) => void;
}

const FALLBACK_CONTEXT: StatsI18nContextValue = {
	i18n: createI18n("en"),
	preference: "auto",
	setPreference: () => {},
};

const StatsI18nContext = createContext<StatsI18nContextValue>(FALLBACK_CONTEXT);

function storedPreference(): LocalePreference {
	if (typeof localStorage === "undefined") return "auto";
	try {
		const value = localStorage.getItem("omp.locale");
		return value === "en" || value === "zh-CN" || value === "auto" ? value : "auto";
	} catch {
		return "auto";
	}
}

function browserLocales(): readonly string[] {
	return typeof navigator === "undefined" ? [] : navigator.languages;
}

export function StatsI18nProvider({
	children,
	initialPreference,
}: {
	children: ReactNode;
	initialPreference?: LocalePreference;
}) {
	const [preference, setPreferenceState] = useState<LocalePreference>(initialPreference ?? storedPreference);
	const locale: Locale = resolveLocale({ explicit: preference, environment: browserLocales() });
	const i18n = useMemo(() => createI18n(locale), [locale]);

	const setPreference = (next: LocalePreference): void => {
		setPreferenceState(next);
		try {
			localStorage.setItem("omp.locale", next);
		} catch {
			// Storage is optional in private browsing and embedded views.
		}
	};

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return <StatsI18nContext.Provider value={{ i18n, preference, setPreference }}>{children}</StatsI18nContext.Provider>;
}

export function useStatsI18n(): StatsI18nContextValue {
	return useContext(StatsI18nContext);
}
