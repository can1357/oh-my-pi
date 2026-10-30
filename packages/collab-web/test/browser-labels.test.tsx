import { expect, it } from "bun:test";
import { initializeI18n } from "@oh-my-pi/pi-utils/i18n-browser";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectScreen } from "../src/components/shell/ConnectScreen";
import { ThemeToggle } from "../src/components/shell/ThemeToggle";
import { ToolView } from "../src/tool-render/ToolView";

it("renders the host language even when browser components were imported before initialization", async () => {
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const pack = {
		language: "ko",
		messages: {
			"System theme": "시스템 테마",
			"{0} (click to switch)": "{0} (클릭하여 전환)",
			apply: "적용",
			"proposed → resolved": "제안됨 → 적용됨",
			"hit condition": "적중 조건",
			"Run /collab in any omp session to get one.": "omp 세션에서 /collab을 실행하면 참여 링크를 얻을 수 있습니다.",
		},
	};
	const data = { textContent: JSON.stringify(pack) };
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { getElementById: () => data, documentElement: { lang: "en" } },
	});
	const render = () =>
		renderToStaticMarkup(
			<>
				<ThemeToggle />
				<ConnectScreen defaultName="guest" error={null} onConnect={() => {}} />
				<ToolView name="resolve" defaultOpen args={{ action: "apply" }} />
				<ToolView name="debug" defaultOpen args={{ action: "launch", hit_condition: "3" }} />
			</>,
		);
	try {
		await initializeI18n();
		const korean = render();
		expect(korean).toContain('aria-label="시스템 테마 (클릭하여 전환)"');
		expect(korean).toContain("제안됨 → 적용됨");
		expect(korean).toContain("적중 조건");
		expect(korean).toContain("omp 세션에서 /collab을 실행하면 참여 링크를 얻을 수 있습니다.");

		data.textContent = JSON.stringify({ language: "en" });
		await initializeI18n();
		const english = render();
		expect(english).toContain('aria-label="System theme (click to switch)"');
		expect(english).toContain("proposed → resolved");
		expect(english).toContain("hit condition");
		expect(english).toContain("Run /collab in any omp session to get one.");
	} finally {
		if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
		else Reflect.deleteProperty(globalThis, "document");
		await initializeI18n();
	}
});
