import { t as ___ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";

const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

const PREFERENCE_ICON: Record<ThemePreference, LucideIcon> = {
	system: Monitor,
	light: Sun,
	dark: Moon,
};

const PREFERENCE_LABEL: Record<ThemePreference, string> = {
	get system() {
		return __ompTranslate("System theme");
	},
	get light() {
		return __ompTranslate("Light theme");
	},
	get dark() {
		return __ompTranslate("Dark theme");
	},
};

export function ThemeToggle() {
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={___ompTranslate("{0} (click to switch)", `${PREFERENCE_LABEL[preference]}`)}
			title={___ompTranslate("{0} — click to switch", `${PREFERENCE_LABEL[preference]}`)}
		>
			<Icon size={16} />
		</button>
	);
}
