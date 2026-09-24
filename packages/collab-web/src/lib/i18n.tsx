import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createI18n, resolveLocale, type I18n, type Locale, type LocalePreference } from "@oh-my-pi/pi-i18n";

interface CollabI18nContextValue {
	i18n: I18n;
	preference: LocalePreference;
	setPreference: (preference: LocalePreference) => void;
}

const FALLBACK_CONTEXT: CollabI18nContextValue = {
	i18n: createI18n("en"),
	preference: "auto",
	setPreference: () => {},
};

const CollabI18nContext = createContext<CollabI18nContextValue>(FALLBACK_CONTEXT);

function storedPreference(): LocalePreference {
	if (typeof localStorage === "undefined") return "auto";
	try {
		const value = localStorage.getItem("omp.locale");
		return value === "en" || value === "zh-CN" || value === "auto" ? value : "auto";
	} catch {
		return "auto";
	}
}

export function CollabI18nProvider({
	children,
	initialPreference,
}: {
	children: ReactNode;
	initialPreference?: LocalePreference;
}) {
	const [preference, setPreferenceState] = useState<LocalePreference>(initialPreference ?? storedPreference);
	const environment = typeof navigator === "undefined" ? [] : navigator.languages;
	const locale: Locale = resolveLocale({ explicit: preference, environment });
	const i18n = useMemo(() => createI18n(locale), [locale]);

	const setPreference = (next: LocalePreference): void => {
		setPreferenceState(next);
		try {
			localStorage.setItem("omp.locale", next);
		} catch {
			// Storage is optional.
		}
	};

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return (
		<CollabI18nContext.Provider value={{ i18n, preference, setPreference }}>{children}</CollabI18nContext.Provider>
	);
}

export function useCollabI18n(): CollabI18nContextValue {
	return useContext(CollabI18nContext);
}
