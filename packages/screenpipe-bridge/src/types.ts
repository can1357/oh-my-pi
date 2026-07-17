/** One row from screenpipe's `frames` table, as returned by `POST /raw_sql`. */
export interface ScreenpipeFrameRow {
	readonly id: number;
	readonly timestamp: string;
	readonly device_name: string;
	readonly app_name: string | null;
	readonly window_name: string | null;
	readonly browser_url: string | null;
	readonly focused: number | null;
	readonly snapshot_path: string | null;
	readonly full_text_redacted_at: number | null;
	readonly accessibility_redacted_at: number | null;
	readonly accessibility_tree_redacted_at: number | null;
	readonly window_name_redacted_at: number | null;
	readonly browser_url_redacted_at: number | null;
	readonly text_json_redacted_at: number | null;
	readonly image_redacted_at: number | null;
	readonly has_full_text: number;
	readonly has_accessibility_text: number;
	readonly has_accessibility_tree: number;
	readonly has_text_json: number;
}

export interface FrameSegment {
	readonly deviceName: string;
	readonly frames: readonly ScreenpipeFrameRow[];
	readonly window: { readonly startedAt: string; readonly endedAt: string };
	readonly appIdentity: { readonly processName: string; readonly browserOrigin?: string };
}
