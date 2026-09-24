import type { LocalePreference } from "@oh-my-pi/pi-i18n";
import { useStatsI18n } from "../i18n";

export function LanguageSelector() {
	const { i18n, preference, setPreference } = useStatsI18n();
	return (
		<label>
			<span className="sr-only">{i18n.t("stats.language.label")}</span>
			<select
				aria-label={i18n.t("stats.language.label")}
				value={preference}
				onChange={event => setPreference(event.target.value as LocalePreference)}
			>
				<option value="auto">{i18n.t("stats.language.auto")}</option>
				<option value="en">{i18n.t("stats.language.english")}</option>
				<option value="zh-CN">{i18n.t("stats.language.chinese")}</option>
			</select>
		</label>
	);
}
