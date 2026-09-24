import { expect, test } from "bun:test";
import { uiLanguage } from "@oh-my-pi/pi-tui/ui-locale";

test.each([undefined, "", "en"])("PI_UI_LANG=%s keeps English selected", language => {
	const previous = process.env.PI_UI_LANG;
	try {
		if (language === undefined) delete process.env.PI_UI_LANG;
		else process.env.PI_UI_LANG = language;
		expect(uiLanguage()).toBe("en");
	} finally {
		if (previous === undefined) delete process.env.PI_UI_LANG;
		else process.env.PI_UI_LANG = previous;
	}
});

test.each(["ja", "ja-JP", "ja_JP", "JA", "JA-jp", "jA_jP"])(
	"PI_UI_LANG=%s selects Japanese through the documented alias",
	language => {
		const previous = process.env.PI_UI_LANG;
		try {
			process.env.PI_UI_LANG = language;
			expect(uiLanguage()).toBe("ja");
		} finally {
			if (previous === undefined) delete process.env.PI_UI_LANG;
			else process.env.PI_UI_LANG = previous;
		}
	},
);

test.each(["fr", "xja", "ja-JP.UTF-8"])(
	"PI_UI_LANG=%s rejects an unsupported language instead of falling back",
	language => {
		const previous = process.env.PI_UI_LANG;
		try {
			process.env.PI_UI_LANG = language;
			expect(() => uiLanguage()).toThrow(/Unsupported PI_UI_LANG/);
		} finally {
			if (previous === undefined) delete process.env.PI_UI_LANG;
			else process.env.PI_UI_LANG = previous;
		}
	},
);
