import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../useSystemTheme";
import { useStatsI18n } from "../i18n";

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

export function ThemeToggle() {
	const { i18n } = useStatsI18n();
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];
	const label =
		preference === "system"
			? i18n.t("stats.theme.system")
			: preference === "light"
				? i18n.t("stats.theme.light")
				: i18n.t("stats.theme.dark");

	return (
		<button
			type="button"
			className="stats-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${label} (${i18n.t("stats.theme.switchHint")})`}
			title={`${label} — ${i18n.t("stats.theme.switchHint")}`}
		>
			<Icon size={16} />
		</button>
	);
}
