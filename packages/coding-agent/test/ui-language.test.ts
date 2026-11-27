import { afterEach, describe, expect, it } from "bun:test";
import { getUiLanguage, setUiLanguage, uiText } from "@oh-my-pi/pi-utils/ui-language";

const initialLanguage = getUiLanguage();
afterEach(() => setUiLanguage(initialLanguage));

describe("UI localization", () => {
	it("translates an interface label, not a runtime value", () => {
		setUiLanguage("ru");
		expect(uiText("Settings")).toBe("Настройки");
		expect(uiText("error: {{message}}", { message: "Settings {{message}} /tmp/Settings" })).toBe(
			"ошибка: Settings {{message}} /tmp/Settings",
		);
	});

	it("interpolates English fallback and leaves missing variables visible", () => {
		for (const language of ["en", "ru"] as const) {
			setUiLanguage(language);
			expect(uiText("Uncatalogued {{id}} {{missing}}", { id: "provider/model" })).toBe(
				"Uncatalogued provider/model {{missing}}",
			);
			expect(uiText("toString")).toBe("toString");
			expect(uiText("Uncatalogued {{toString}}", {})).toBe("Uncatalogued {{toString}}");
		}
	});
});
