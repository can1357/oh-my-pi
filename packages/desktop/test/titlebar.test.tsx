import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TitleBar } from "../src/components/TitleBar";

/**
 * The window is `titleBarStyle: "Overlay"`: macOS draws the traffic lights and
 * nothing else, so this row is the only thing that can move the window. It was
 * asking for that with `-webkit-app-region: drag`, which WKWebView does not
 * implement — the bar looked draggable and was not. These fix the contract with
 * Tauri's injected `mousedown` handler, which is what actually reads the DOM.
 *
 * `AddProjectButton` renders `null` here: it is gated on `isTauri()`, and under
 * `bun test` there is no `window`. Nothing below counts controls, so that is
 * fine — but it is why the left group looks one button short.
 */

const MARKUP = renderToStaticMarkup(
	<MemoryRouter>
		<TitleBar
			sidebarOpen
			panelOpen={false}
			project="oh-my-pi"
			title="New session"
			onToggleSidebar={() => {}}
			onTogglePanel={() => {}}
			onNewSession={() => {}}
			onAddProject={() => {}}
		/>
	</MemoryRouter>,
);

/** Opening tags of one element type, attributes included. */
function openTags(tag: string): string[] {
	return MARKUP.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? [];
}

describe("title bar drag region", () => {
	test("the row carries the attribute, and carries it deep", () => {
		const [header, ...rest] = openTags("header");
		expect(rest).toEqual([]);

		// Bare or `="true"` would drag only when the header itself is the event
		// target, so pressing the title text or the folder icon would do nothing.
		expect(header).toContain('data-tauri-drag-region="deep"');
	});

	test("no control is a drag region", () => {
		// Tauri blocks dragging from a BUTTON or A that has no attribute of its
		// own. Adding one to a control would hand its clicks to the window.
		const controls = [...openTags("button"), ...openTags("a")];
		expect(controls.length).toBeGreaterThan(0);
		for (const control of controls) expect(control).not.toContain("data-tauri-drag-region");
	});
});

test("the main window is allowed to start a drag", async () => {
	// The attribute only gets as far as `invoke("plugin:window|start_dragging")`.
	// Tauri ships that command disabled — `core:window:default` covers most of
	// the window plugin but not this one — so without the explicit grant the
	// call is denied and the bar looks inert in exactly the same way the
	// Chromium-only CSS did.
	const capability = await Bun.file(`${import.meta.dir}/../src-tauri/capabilities/default.json`).json();
	expect(capability.permissions).toContain("core:window:allow-start-dragging");
	expect(capability.windows).toContain("main");
});

test("the stylesheet does not ask for dragging in Chromium's dialect", async () => {
	// `-webkit-app-region` is an Electron/Chromium property. Under WKWebView it
	// parses, applies, and does nothing — which is how the bar came to be
	// undraggable while looking like it had been handled.
	const css = await Bun.file(`${import.meta.dir}/../src/styles/app.css`).text();
	expect(css).not.toContain("-webkit-app-region");
});
