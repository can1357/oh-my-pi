import type { LocalePreference } from "@oh-my-pi/pi-i18n";
import { useCollabI18n } from "../../lib/i18n";

export function LanguageSelector() {
	const { i18n, preference, setPreference } = useCollabI18n();
	return (
		<label className="sh-language">
			<span className="sr-only">{i18n.t("collab.language.label")}</span>
			<select
				aria-label={i18n.t("collab.language.label")}
				value={preference}
				onChange={event => setPreference(event.target.value as LocalePreference)}
			>
				<option value="auto">{i18n.t("collab.language.auto")}</option>
				<option value="en">{i18n.t("collab.language.english")}</option>
				<option value="zh-CN">{i18n.t("collab.language.chinese")}</option>
			</select>
		</label>
	);
}
