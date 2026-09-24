import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import { type ThemePreference, useThemePreference } from "../../lib/theme";
import { useCollabI18n } from "../../lib/i18n";

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
	const { i18n } = useCollabI18n();
	const { preference, setPreference } = useThemePreference();
	const Icon = PREFERENCE_ICON[preference];
	const label =
		preference === "system"
			? i18n.t("collab.theme.system")
			: preference === "light"
				? i18n.t("collab.theme.light")
				: i18n.t("collab.theme.dark");

	return (
		<button
			type="button"
			className="sh-theme-toggle"
			onClick={() => setPreference(NEXT_PREFERENCE[preference])}
			aria-label={`${label} (${i18n.t("collab.theme.switchHint")})`}
			title={`${label} — ${i18n.t("collab.theme.switchHint")}`}
		>
			<Icon size={16} />
		</button>
	);
}
