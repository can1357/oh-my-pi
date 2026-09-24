import type { LocalePreference } from "@oh-my-pi/pi-i18n";
import { useMetaI18n } from "./i18n";

export function LanguageSelector() {
	const { i18n, preference, setPreference } = useMetaI18n();
	return (
		<label>
			<span className="sr-only">{i18n.t("metaharness.language.label")}</span>
			<select
				aria-label={i18n.t("metaharness.language.label")}
				value={preference}
				onChange={event => setPreference(event.target.value as LocalePreference)}
			>
				<option value="auto">{i18n.t("metaharness.language.auto")}</option>
				<option value="en">{i18n.t("metaharness.language.english")}</option>
				<option value="zh-CN">{i18n.t("metaharness.language.chinese")}</option>
			</select>
		</label>
	);
}
