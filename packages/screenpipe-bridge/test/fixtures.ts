import type { ScreenpipeFrameRow } from "../src/types";

export function frame(overrides: Partial<ScreenpipeFrameRow> & { id: number; timestamp: string }): ScreenpipeFrameRow {
	return {
		device_name: "device-1",
		app_name: "code",
		window_name: "main.rs",
		browser_url: null,
		focused: 1,
		snapshot_path: null,
		full_text_redacted_at: null,
		accessibility_redacted_at: null,
		accessibility_tree_redacted_at: null,
		window_name_redacted_at: 1_752_415_200,
		browser_url_redacted_at: null,
		text_json_redacted_at: null,
		image_redacted_at: null,
		has_full_text: 0,
		has_accessibility_text: 0,
		has_accessibility_tree: 0,
		has_text_json: 0,
		...overrides,
	};
}
