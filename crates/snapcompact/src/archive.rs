//! Provider-aware frame geometry and bounded text chunking.

use std::{borrow::Cow, result, str};

use crate::{
	Result as RenderResult, SnapcompactError, SnapcompactRenderOptions, cell_units,
	render_snapcompact_png,
};

/// Maximum archive frames carried by one compaction.
pub const MAX_FRAMES_DEFAULT: usize = 80;
/// Conservative encoded size used before rendering a frame.
pub const FRAME_DATA_BYTES_ESTIMATE: usize = 170_000;
/// Maximum PNG bytes carried in rebuilt requests.
pub const FRAME_DATA_BYTES_BUDGET: usize = 3_000_000;
/// Minimum source-to-image savings required to accept an archive.
pub const SAVINGS_MARGIN: f64 = 0.9;
/// Safe image-count floor for an unknown provider.
pub const DEFAULT_PROVIDER_IMAGE_BUDGET: usize = 5;

/// Whether data-URL text came from intact source or a structure-blind legacy
/// archive slice.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DataUrlContext {
	/// Intact source text; short non-canonical examples remain prose.
	#[default]
	Source,
	/// Previously archived text that may end at any point inside a payload.
	Archive,
}

const DAMAGED_PAYLOAD_MIN_CHARS: usize = 40;

const fn ascii_eq(left: u8, right: u8) -> bool {
	left.eq_ignore_ascii_case(&right)
}

fn starts_ascii_case_insensitive(bytes: &[u8], needle: &[u8]) -> bool {
	bytes.len() >= needle.len()
		&& bytes
			.iter()
			.zip(needle)
			.all(|(&left, &right)| ascii_eq(left, right))
}

const fn media_token(byte: u8) -> bool {
	byte.is_ascii_alphanumeric()
		|| matches!(
			byte,
			b'_'
				| b'!' | b'#'
				| b'$' | b'%'
				| b'&' | b'\''
				| b'*' | b'+'
				| b'-' | b'.'
				| b'^' | b'|'
				| b'~'
		)
}

fn take_media_token(bytes: &[u8], mut at: usize) -> usize {
	while bytes.get(at).is_some_and(|byte| media_token(*byte)) {
		at += 1;
	}
	at
}

fn parse_data_url_prefix(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
	let mut at = start.checked_add(5)?;
	if !bytes.get(at).is_some_and(u8::is_ascii_alphabetic) {
		return None;
	}
	at = take_media_token(bytes, at + 1);
	if bytes.get(at) != Some(&b'/') {
		return None;
	}
	at += 1;
	let subtype = at;
	at = take_media_token(bytes, at);
	if at == subtype {
		return None;
	}
	loop {
		if starts_ascii_case_insensitive(bytes.get(at..)?, b";base64,") {
			return Some((at, at + b";base64,".len()));
		}
		if bytes.get(at) != Some(&b';') {
			return None;
		}
		at += 1;
		let name = at;
		at = take_media_token(bytes, at);
		if at == name || bytes.get(at) != Some(&b'=') {
			return None;
		}
		at += 1;
		let value = at;
		at = take_media_token(bytes, at);
		if at == value {
			return None;
		}
	}
}

fn canonical_base64(payload: &[u8]) -> bool {
	if !payload.len().is_multiple_of(4) {
		return false;
	}
	let padding = payload
		.iter()
		.rev()
		.take_while(|&&byte| byte == b'=')
		.count();
	padding <= 2
		&& payload[..payload.len().saturating_sub(padding)]
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
		&& payload[payload.len().saturating_sub(padding)..]
			.iter()
			.all(|byte| *byte == b'=')
}

fn parse_elided_marker(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
	let (ellipsis, mut at) = if bytes.get(start..)?.starts_with("[…".as_bytes()) {
		("…".as_bytes(), start + "[…".len())
	} else if bytes.get(start..)?.starts_with(b"[...") {
		(b"...".as_slice(), start + 4)
	} else {
		return None;
	};
	let digits = at;
	while bytes.get(at).is_some_and(u8::is_ascii_digit) {
		at += 1;
	}
	if at == digits || !bytes.get(at..)?.starts_with(b"ch elided") {
		return None;
	}
	let count = str::from_utf8(&bytes[digits..at])
		.ok()?
		.parse::<usize>()
		.ok()?;
	at += b"ch elided".len();
	if !bytes.get(at..)?.starts_with(ellipsis) {
		return None;
	}
	at += ellipsis.len();
	(bytes.get(at) == Some(&b']')).then_some((at + 1, count))
}

fn adjacent_markdown_opener(text: &str, data_start: usize, floor: usize) -> Option<usize> {
	let bytes = text.as_bytes();
	let mut at = data_start;
	while at > floor && bytes[at - 1].is_ascii_whitespace() {
		at -= 1;
	}
	if at < floor + 2 || bytes.get(at - 2..at) != Some(b"](") {
		return None;
	}
	let mut opener = None;
	for index in (floor..at - 2).rev() {
		match bytes[index] {
			b']' | b'\n' => break,
			b'[' => opener = Some(index),
			_ => {},
		}
	}
	let opener = opener?;
	Some(if opener > floor && bytes[opener - 1] == b'!' {
		opener - 1
	} else {
		opener
	})
}

/// Atomically replaces inline base64 data URLs before any character or frame
/// slicing.
///
/// Archive context also heals short, non-canonical fragments left by older
/// structure-blind slices. Matching advances from `data:` prefixes and only
/// scans backward through the adjacent unprocessed Markdown opener, keeping
/// unmatched-bracket input linear.
pub fn elide_data_urls(text: &str, context: DataUrlContext) -> Cow<'_, str> {
	let bytes = text.as_bytes();
	let mut search = 0usize;
	let mut floor = 0usize;
	let mut emitted = 0usize;
	let mut output = None::<String>;
	while search + 5 <= bytes.len() {
		let Some(relative) = bytes[search..]
			.windows(5)
			.position(|window| starts_ascii_case_insensitive(window, b"data:"))
		else {
			break;
		};
		let start = search + relative;
		let Some((mime_end, payload_start)) = parse_data_url_prefix(bytes, start) else {
			search = start + 5;
			continue;
		};
		let mut payload_end = payload_start;
		while bytes
			.get(payload_end)
			.is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
		{
			payload_end += 1;
		}
		let first_run_end = payload_end;
		let mut marker = None;
		let mut after_space = payload_end;
		while bytes.get(after_space).is_some_and(u8::is_ascii_whitespace) {
			after_space += 1;
		}
		if let Some((marker_end, restored)) = parse_elided_marker(bytes, after_space) {
			let mut second_run = marker_end;
			while bytes.get(second_run).is_some_and(u8::is_ascii_whitespace) {
				second_run += 1;
			}
			let second_start = second_run;
			while bytes
				.get(second_run)
				.is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
			{
				second_run += 1;
			}
			marker = Some((second_start, second_run, restored));
			payload_end = second_run;
		}
		let mut url_end = payload_end;
		while bytes.get(url_end).is_some_and(u8::is_ascii_whitespace) {
			url_end += 1;
		}
		let closer = (bytes.get(url_end) == Some(&b')')).then_some(url_end + 1);
		if let Some(end) = closer {
			url_end = end;
		} else {
			url_end = payload_end;
		}
		let payload = &bytes[payload_start..first_run_end];
		let is_atom = context == DataUrlContext::Archive
			|| marker.is_some()
			|| canonical_base64(payload)
			|| payload.len() >= DAMAGED_PAYLOAD_MIN_CHARS;
		if !is_atom {
			floor = url_end;
			search = url_end.max(start + 5);
			continue;
		}
		let payload_chars = marker.map_or(payload.len(), |(second_start, second_end, restored)| {
			first_run_end
				.saturating_sub(payload_start)
				.saturating_add(second_end.saturating_sub(second_start))
				.saturating_add(restored)
		});
		let opener = adjacent_markdown_opener(text, start, floor);
		let replace_start = opener.unwrap_or(start);
		let output = output.get_or_insert_with(|| String::with_capacity(text.len()));
		output.push_str(&text[emitted..replace_start]);
		if opener.is_some() && closer.is_none() {
			output.push_str(&text[opener.unwrap_or(start)..start]);
		}
		let mime = &text[start + 5..mime_end];
		use std::fmt::Write as _;
		let _ = write!(output, "[data URL omitted: {mime}, {payload_chars} base64 chars]");
		if opener.is_none() && closer.is_some() {
			output.push_str(&text[payload_end..url_end]);
		}
		emitted = url_end;
		floor = url_end;
		search = url_end.max(start + 5);
	}
	if let Some(mut output) = output {
		output.push_str(&text[emitted..]);
		Cow::Owned(output)
	} else {
		Cow::Borrowed(text)
	}
}

/// Provider billing family for image inputs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BillingFamily {
	/// Anthropic patch billing.
	Anthropic,
	/// Google fixed media-resolution billing.
	Google,
	/// `OpenAI` patch billing.
	OpenAi,
	/// Conservative unknown-provider billing.
	Unknown,
}

/// One eval-validated rendering geometry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Shape {
	/// Bundled renderer font.
	pub font:                 &'static str,
	/// Horizontal cell advance.
	pub cell_width:           u32,
	/// Vertical cell pitch.
	pub cell_height:          u32,
	/// Whether the renderer may stretch bitmap glyphs.
	pub stretch:              Option<bool>,
	/// Ink variant.
	pub variant:              &'static str,
	/// Number of repeated copies of each line.
	pub line_repeat:          u32,
	/// Newspaper columns, either one or two.
	pub columns:              u32,
	/// Square frame edge in pixels.
	pub frame_size:           u32,
	/// Conservative provider input tokens billed per frame.
	pub frame_token_estimate: u64,
}

/// Model and transport identity used to select a shape.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ShapeTarget<'a> {
	/// Wire API name.
	pub api:      Option<&'a str>,
	/// Catalog model identifier.
	pub model_id: Option<&'a str>,
}

/// A rendered PNG and its exact reading geometry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
	/// PNG bytes.
	pub png:   Vec<u8>,
	/// Characters per row.
	pub cols:  u32,
	/// Available text rows.
	pub rows:  u32,
	/// Unicode scalar values printed in this frame.
	pub chars: usize,
	/// Geometry used to render the frame.
	pub shape: Shape,
}

/// Measured compaction accounting persisted beside an archive.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SavingsRecord {
	/// Estimated source text tokens before imaging.
	pub source_tokens: u64,
	/// Conservative provider tokens after imaging.
	pub image_tokens:  u64,
	/// Exact PNG bytes retained.
	pub png_bytes:     usize,
	/// Frames retained.
	pub frames:        usize,
	/// `image_tokens / source_tokens`.
	pub ratio:         f64,
}

/// Completed bounded archive.
#[derive(Clone, Debug, PartialEq)]
pub struct Archive {
	/// Oldest-to-newest rendered frames.
	pub frames:          Vec<Frame>,
	/// Characters omitted from provider-visible frames. Successful archives are
	/// lossless and therefore always record zero.
	pub truncated_chars: usize,
	/// Measured savings used for admission.
	pub savings:         SavingsRecord,
}

/// Failure to construct an admissible archive.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
	/// The bitmap renderer rejected a frame.
	#[error(transparent)]
	Renderer(#[from] SnapcompactError),
	/// The provider has no remaining image slots for a lossless archive.
	#[error("snapcompact provider image budget has no remaining frame")]
	NoFrameBudget,
	/// Lossless pagination requires more frames than the provider admits.
	#[error("snapcompact history exceeds the {maximum}-frame provider budget")]
	FrameBudgetExceeded {
		/// Maximum provider-visible frames available to this archive.
		maximum: usize,
	},
	/// Lossless PNG publication would exceed the request byte budget.
	#[error("snapcompact frames exceed the {maximum_bytes}-byte request budget")]
	DataBudgetExceeded {
		/// Maximum aggregate encoded frame bytes.
		maximum_bytes: usize,
	},
	/// Image input would not save the required ten-percent margin.
	#[error(
		"snapcompact image cost {image_tokens} tokens exceeds the {maximum_tokens}-token admission \
		 ceiling"
	)]
	InsufficientSavings {
		/// Conservative image token estimate.
		image_tokens:   u64,
		/// Largest admitted image token estimate.
		maximum_tokens: u64,
	},
}

/// Archive construction result.
pub type ArchiveResult<T, E = ArchiveError> = result::Result<T, E>;

/// Resolves a wire API name to its image billing family.
pub fn billing_family(api: Option<&str>) -> BillingFamily {
	match api {
		Some("anthropic-messages" | "bedrock-converse-stream") => BillingFamily::Anthropic,
		Some("google-generative-ai" | "google-gemini-cli" | "google-vertex") => BillingFamily::Google,
		Some(
			"openai-completions"
			| "openai-responses"
			| "openai-codex-responses"
			| "azure-openai-responses",
		) => BillingFamily::OpenAi,
		_ => BillingFamily::Unknown,
	}
}

/// Returns the conservative request image budget for a provider.
pub fn provider_image_budget(provider: Option<&str>) -> usize {
	match provider {
		Some("anthropic" | "amazon-bedrock" | "openrouter") => 90,
		Some("openai" | "openai-codex" | "google" | "google-vertex" | "google-gemini-cli") => 200,
		Some("umans") => 10,
		_ => DEFAULT_PROVIDER_IMAGE_BUDGET,
	}
}

/// Returns the bounded number of archive frames available to a provider.
pub fn provider_frame_budget(provider: Option<&str>, existing_images: usize) -> usize {
	provider_image_budget(provider)
		.saturating_sub(existing_images)
		.min(MAX_FRAMES_DEFAULT)
		.min((FRAME_DATA_BYTES_BUDGET / FRAME_DATA_BYTES_ESTIMATE).max(1))
}

fn billed_tokens(family: BillingFamily, frame_size: u32) -> u64 {
	match family {
		BillingFamily::Google => 1_120,
		BillingFamily::OpenAi => {
			let patches = u64::from(frame_size.div_ceil(32)).pow(2).min(10_000);
			(patches as f64 * 1.2).ceil() as u64
		},
		BillingFamily::Anthropic | BillingFamily::Unknown => {
			let patches = u64::from(frame_size.div_ceil(28)).pow(2).min(4_784);
			(patches as f64 * 1.05).ceil() as u64
		},
	}
}

/// Selects eval-winning geometry for a model and carrying API.
pub fn resolve_shape(target: ShapeTarget<'_>) -> Shape {
	let family = billing_family(target.api);
	let id = target.model_id.unwrap_or_default().to_ascii_lowercase();
	let (font, cell_width, cell_height, stretch, frame_size) = if id.contains("claude") {
		let high_resolution = id.contains("fable")
			|| id.contains("mythos")
			|| id.contains("opus-4-7")
			|| id.contains("opus-4.7")
			|| id.contains("opus-4-8")
			|| id.contains("opus-4.8");
		("8x13", 11, 16, Some(false), if high_resolution { 1_932 } else { 1_568 })
	} else if id.contains("gemini") {
		("8x13", 8, 22, Some(false), 2_048)
	} else if id.contains("glm") {
		("8x13", 8, 16, Some(false), 1_568)
	} else {
		match family {
			BillingFamily::Anthropic => ("8x13", 11, 16, Some(false), 1_568),
			BillingFamily::Google | BillingFamily::OpenAi | BillingFamily::Unknown => {
				("8x13", 8, 22, Some(false), 1_568)
			},
		}
	};
	Shape {
		font,
		cell_width,
		cell_height,
		stretch,
		variant: "bw",
		line_repeat: 1,
		columns: 1,
		frame_size,
		frame_token_estimate: billed_tokens(family, frame_size),
	}
}

fn shape_options(shape: Shape) -> SnapcompactRenderOptions {
	SnapcompactRenderOptions {
		size:        shape.frame_size,
		font:        Some(shape.font.to_owned()),
		cell_width:  Some(shape.cell_width),
		cell_height: Some(shape.cell_height),
		variant:     Some(shape.variant.to_owned()),
		line_repeat: Some(shape.line_repeat),
		stretch:     shape.stretch,
		columns:     Some(shape.columns),
	}
}

const fn frame_capacity(shape: Shape) -> (usize, u32, u32) {
	let cols = shape.frame_size / shape.cell_width;
	let rows = shape.frame_size / shape.cell_height / shape.line_repeat;
	((cols as usize).saturating_mul(rows as usize), cols, rows)
}

fn take_frame_end(
	text: &str,
	start: usize,
	capacity: usize,
	cols: usize,
	wide_cells: bool,
) -> (usize, usize) {
	let mut cells = 0usize;
	let mut chars = 0usize;
	let mut end = start;
	for (offset, ch) in text[start..].char_indices() {
		let units = cell_units(ch as u32, wide_cells);
		let row_offset = cells % cols;
		let pad = usize::from(units == 2 && cols >= 2 && row_offset == cols - 1);
		if chars != 0 && cells.saturating_add(pad).saturating_add(units) > capacity {
			break;
		}
		cells = cells.saturating_add(pad).saturating_add(units);
		chars += 1;
		end = start + offset + ch.len_utf8();
	}
	(end, chars)
}

/// Renders text into provider-bounded PNG frames and enforces the 0.9 savings
/// margin.
///
/// `source_tokens` must be measured by the active model tokenizer. Frames are
/// admitted only when their conservative image bill remains at least ten
/// percent below that source measurement.
#[tracing::instrument(
	level = "debug",
	name = "snapshot_compaction",
	skip_all,
	fields(
		provider = provider.unwrap_or("unknown"),
		model = target.model_id.unwrap_or("unknown"),
		api = target.api.unwrap_or("unknown"),
		source_tokens = source_tokens,
		existing_images = existing_images
	)
)]
pub fn render_archive(
	text: &str,
	source_tokens: u64,
	target: ShapeTarget<'_>,
	provider: Option<&str>,
	existing_images: usize,
) -> ArchiveResult<Archive> {
	let text = elide_data_urls(text, DataUrlContext::Source);
	let text = text.as_ref();
	let shape = resolve_shape(target);
	let max_frames = provider_frame_budget(provider, existing_images);
	if max_frames == 0 {
		return Err(ArchiveError::NoFrameBudget);
	}
	let (capacity, cols, rows) = frame_capacity(shape);
	let mut pages = Vec::with_capacity(max_frames.min(16));
	let mut cursor = 0usize;
	while cursor < text.len() {
		if pages.len() == max_frames {
			return Err(ArchiveError::FrameBudgetExceeded { maximum: max_frames });
		}
		let (end, chars) =
			take_frame_end(text, cursor, capacity, cols as usize, shape.font != "silver");
		if end == cursor {
			return Err(ArchiveError::NoFrameBudget);
		}
		pages.push((cursor, end, chars));
		cursor = end;
	}
	if pages.is_empty() {
		return Err(ArchiveError::NoFrameBudget);
	}
	let image_tokens = shape
		.frame_token_estimate
		.saturating_mul(pages.len() as u64);
	let maximum_tokens = (source_tokens as f64 * SAVINGS_MARGIN).floor() as u64;
	if image_tokens > maximum_tokens {
		return Err(ArchiveError::InsufficientSavings { image_tokens, maximum_tokens });
	}
	let mut frames = Vec::with_capacity(pages.len());
	let mut png_bytes = 0usize;
	for (start, end, chars) in pages {
		let png = render_snapcompact_png(&text[start..end], &shape_options(shape))?;
		if png_bytes.saturating_add(png.len()) > FRAME_DATA_BYTES_BUDGET {
			return Err(ArchiveError::DataBudgetExceeded { maximum_bytes: FRAME_DATA_BYTES_BUDGET });
		}
		png_bytes += png.len();
		frames.push(Frame { png, cols, rows, chars, shape });
	}
	let truncated_chars = 0;
	let ratio = if source_tokens == 0 {
		0.0
	} else {
		image_tokens as f64 / source_tokens as f64
	};
	let frame_count = frames.len();
	tracing::info!(
		provider = provider.unwrap_or("unknown"),
		model = target.model_id.unwrap_or("unknown"),
		source_tokens,
		image_tokens,
		png_bytes,
		frames = frame_count,
		ratio,
		"snapshot compaction completed"
	);
	Ok(Archive {
		frames,
		truncated_chars,
		savings: SavingsRecord { source_tokens, image_tokens, png_bytes, frames: frame_count, ratio },
	})
}

/// Calls the renderer directly for callers that already performed framing.
pub fn render_frame(text: &str, shape: Shape) -> RenderResult<Vec<u8>> {
	render_snapcompact_png(text, &shape_options(shape))
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn data_urls_are_elided_before_any_frame_slice() {
		let payload = "QUFB".repeat(2_000);
		let source = format!("{}![img](data:image/png;base64,{payload}){}", "x".repeat(1_199), "y");
		let elided = elide_data_urls(&source, DataUrlContext::Source);
		assert!(elided.contains("[data URL omitted: image/png, 8000 base64 chars]"));
		assert!(!elided.contains(";base64,"), "no decodable prefix can straddle a later slice");
	}

	#[test]
	fn unmatched_markdown_brackets_do_not_rescan_the_remaining_input() {
		let source = format!("{};base64,", "[".repeat(80_000));
		assert_eq!(elide_data_urls(&source, DataUrlContext::Source), source);
	}

	#[test]
	fn archive_elision_restores_legacy_marker_character_counts() {
		let source = "data:image/png;base64,QUFB [...900ch elided...] QUFB";
		assert_eq!(
			elide_data_urls(source, DataUrlContext::Archive),
			"[data URL omitted: image/png, 908 base64 chars]"
		);
	}

	#[test]
	fn provider_frame_budget_applies_provider_cap_and_unknown_floor() {
		assert_eq!(provider_frame_budget(Some("unknown-gateway"), 0), 5);
		assert_eq!(provider_frame_budget(Some("umans"), 7), 3);
		assert_eq!(provider_frame_budget(Some("openai"), 0), 17);
	}
	#[test]
	fn cjk_row_straddles_start_on_the_next_frame_row_without_loss() {
		let text = "aaa界z";
		let (first_end, first_chars) = take_frame_end(text, 0, 4, 4, true);
		assert_eq!((&text[..first_end], first_chars), ("aaa", 3));
		let (second_end, second_chars) = take_frame_end(text, first_end, 4, 4, true);
		assert_eq!((&text[first_end..second_end], second_chars), ("界z", 2));
		assert_eq!(second_end, text.len());
	}

	#[test]
	fn exhausted_provider_budget_cannot_publish_an_empty_archive() {
		assert!(matches!(
			render_archive("durable history", 10_000, ShapeTarget::default(), Some("unknown"), 5),
			Err(ArchiveError::NoFrameBudget)
		));
	}
	#[test]
	fn frame_limit_rejects_instead_of_dropping_recent_history() {
		let shape = resolve_shape(ShapeTarget::default());
		let (capacity, ..) = frame_capacity(shape);
		let text = "x".repeat(capacity.saturating_mul(6));
		assert!(matches!(
			render_archive(&text, u64::MAX, ShapeTarget::default(), Some("unknown"), 0),
			Err(ArchiveError::FrameBudgetExceeded { maximum: 5 })
		));
	}
}
