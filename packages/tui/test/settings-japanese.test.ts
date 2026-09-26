import { expect, test } from "bun:test";
import { getAllSettingDefs } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { translateUiStatus } from "@oh-my-pi/pi-tui/ui-locale";

test("Japanese settings keep their schema paths and show translated labels", () => {
	const previous = process.env.PI_UI_LANG;
	try {
		process.env.PI_UI_LANG = "ja";
		const defs = getAllSettingDefs([
			{
				path: "theme.dark",
				type: "string",
				defaultValue: "titanium",
				ui: {
					tab: "appearance",
					group: "Theme",
					label: "Dark Theme",
					description: "Theme used when the terminal has a dark background",
				},
			},
		]);
		expect(defs[0]).toMatchObject({
			path: "theme.dark",
			group: "Theme",
			label: "ダークテーマ",
			description: "端末の背景が暗いときに使うテーマ",
		});
	} finally {
		if (previous === undefined) delete process.env.PI_UI_LANG;
		else process.env.PI_UI_LANG = previous;
	}
});

test("Japanese command menu keeps live status values while translating the labels", () => {
	const previous = process.env.PI_UI_LANG;
	try {
		process.env.PI_UI_LANG = "ja";
		expect(translateUiStatus("Login: choose provider")).toBe("ログイン: プロバイダーを選択");
		expect(translateUiStatus("Model: openai/gpt-6")).toBe("モデル: openai/gpt-6");
		expect(translateUiStatus("Goal: paused (translate docs)")).toBe("ゴール: 一時停止中（translate docs）");
		expect(translateUiStatus("Jobs: 2 running, 3 recent")).toBe("ジョブ: 実行中2件、最近3件");
	} finally {
		if (previous === undefined) delete process.env.PI_UI_LANG;
		else process.env.PI_UI_LANG = previous;
	}
});
