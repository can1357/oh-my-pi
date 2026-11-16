//! Inline image rows: marker detection, Kitty direct placements, and the
//! SIXEL top crop.
//!
//! The component tree renders an image as a block of reserved rows whose last
//! row carries the protocol payload. The frame writer recognizes those rows
//! ([`is_image_line`]), re-anchors and clips Kitty placements for the row they
//! are written at ([`encode_kitty_placement_line`]), and crops SIXEL rasters
//! whose top rows lie above the frame ([`SixelCropper`]).

use std::{
	borrow::Cow,
	fmt::{self, Write as _},
	ops::Range,
};

use memchr::memmem;

use crate::tui::types::ImageProtocol;

const ESC: u8 = 0x1b;

// Marker scan windows, in UTF-16 code units as the component layer measures
// its rows: a marker past the window belongs to text that merely quotes an
// escape sequence, not to an image row.
const IMAGE_MARKER_SCAN_LIMIT: usize = 512;
const SIXEL_MARKER_SCAN_LIMIT: usize = 128;

/// Kitty Unicode placeholder (U+10EEEE), the cell of a virtual placement grid.
const KITTY_PLACEHOLDER: &[u8] = "\u{10eeee}".as_bytes();
/// First UTF-8 byte of [`KITTY_PLACEHOLDER`].
pub(super) const KITTY_PLACEHOLDER_LEAD: u8 = KITTY_PLACEHOLDER[0];

/// UTF-16 code units begun by `byte` of a UTF-8 string: one per character,
/// two for a character outside the BMP, none for a continuation byte.
#[inline]
pub(super) const fn utf16_units_started(byte: u8) -> usize {
	(byte & 0xc0 != 0x80) as usize + (byte >= 0xf0) as usize
}

/// Whether an image marker begins at byte `at` of `line`, which is UTF-16
/// offset `unit`. Kept as the shared primitive for both standalone image
/// checks and the renderer's combined ANSI/width scan, so their protocol
/// windows and sixel grammar cannot drift.
pub(super) fn has_image_marker_at(
	protocol: Option<ImageProtocol>,
	line: &[u8],
	at: usize,
	unit: usize,
) -> bool {
	let (Some(protocol), Some(rest)) = (protocol, line.get(at..)) else {
		return false;
	};
	let prefix: &[u8] = match protocol {
		ImageProtocol::Sixel => {
			// `ESC P [0-9;]* q`, with the `q` inside the scan window.
			if !rest.starts_with(b"\x1bP") {
				return false;
			}
			let mut offset = 2;
			while unit + offset < SIXEL_MARKER_SCAN_LIMIT
				&& rest
					.get(offset)
					.is_some_and(|&byte| byte.is_ascii_digit() || byte == b';')
			{
				offset += 1;
			}
			return unit + offset < SIXEL_MARKER_SCAN_LIMIT && rest.get(offset) == Some(&b'q');
		},
		ImageProtocol::Kitty => b"\x1b_G",
		ImageProtocol::Iterm2 => b"\x1b]1337;File=",
	};
	(unit + prefix.len() <= IMAGE_MARKER_SCAN_LIMIT && rest.starts_with(prefix))
		|| (unit + 2 <= IMAGE_MARKER_SCAN_LIMIT && rest.starts_with(KITTY_PLACEHOLDER))
}

/// Whether `line` is an image row for `protocol`: a protocol marker (or a
/// Kitty Unicode placeholder) begins inside the protocol's scan window.
pub(crate) fn is_image_line(protocol: Option<ImageProtocol>, line: &str) -> bool {
	let Some(active) = protocol else {
		return false;
	};
	let limit = if active == ImageProtocol::Sixel {
		SIXEL_MARKER_SCAN_LIMIT
	} else {
		IMAGE_MARKER_SCAN_LIMIT
	};
	let bytes = line.as_bytes();
	let mut unit = 0;
	for (at, &byte) in bytes.iter().enumerate() {
		if unit >= limit {
			break;
		}
		if (byte == ESC || byte == KITTY_PLACEHOLDER_LEAD)
			&& has_image_marker_at(protocol, bytes, at, unit)
		{
			return true;
		}
		unit += utf16_units_started(byte);
	}
	false
}

// ============================================================================
// Kitty direct placements
// ============================================================================

/// A frame line that consists solely of a Kitty direct placement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct KittyDirectPlacement {
	pub image_id:     u32,
	pub placement_id: Option<u32>,
	pub columns:      u32,
	pub rows:         u32,
}

/// Leading ASCII decimal number of `bytes` and the bytes after it. A number
/// beyond `u32` is no id or cell count any terminal accepts: no match.
fn leading_number(bytes: &[u8]) -> Option<(u32, &[u8])> {
	let digits = bytes
		.iter()
		.take_while(|byte| byte.is_ascii_digit())
		.count();
	if digits == 0 {
		return None;
	}
	let mut value = 0u32;
	for &byte in &bytes[..digits] {
		value = value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
	}
	Some((value, &bytes[digits..]))
}

/// An optional `key` + number parameter: `(value, rest)` when present, else
/// `(None, bytes)`.
fn optional_parameter<'a>(bytes: &'a [u8], key: &[u8]) -> (Option<u32>, &'a [u8]) {
	match bytes.strip_prefix(key).and_then(leading_number) {
		Some((value, rest)) => (Some(value), rest),
		None => (None, bytes),
	}
}

/// Undo tmux DCS passthrough envelopes (`ESC P tmux; … ESC \` with every
/// payload ESC doubled) so the wrapped command can be matched.
fn unwrap_tmux_passthrough(line: &str) -> Cow<'_, str> {
	const OPEN: &[u8] = b"\x1bPtmux;";
	let bytes = line.as_bytes();
	let Some(first) = memmem::find(bytes, OPEN) else {
		return Cow::Borrowed(line);
	};
	let mut out = String::with_capacity(line.len());
	let mut copied = 0;
	let mut next = Some(first);
	while let Some(open) = next {
		// Payload: any byte but ESC, or a doubled ESC; then the terminator.
		let payload = open + OPEN.len();
		let mut end = payload;
		while end < bytes.len() {
			if bytes[end] != ESC {
				end += 1;
			} else if bytes.get(end + 1) == Some(&ESC) {
				end += 2;
			} else {
				break;
			}
		}
		if bytes[end..].starts_with(b"\x1b\\") {
			out.push_str(&line[copied..open]);
			// ESC is ASCII: every cut around it is a character boundary.
			let mut rest = &line[payload..end];
			while let Some(doubled) = rest.find("\x1b\x1b") {
				out.push_str(&rest[..=doubled]);
				rest = &rest[doubled + 2..];
			}
			out.push_str(rest);
			copied = end + 2;
			next = memmem::find(&bytes[copied..], OPEN).map(|at| copied + at);
		} else {
			next = memmem::find(&bytes[open + 1..], OPEN).map(|at| open + 1 + at);
		}
	}
	out.push_str(&line[copied..]);
	Cow::Owned(out)
}

/// Parse a frame line that consists solely of a Kitty direct placement (the
/// last line of an image block): optional `ESC 7` + `CUU(rows-1)` prefix, the
/// `a=p,q=2,C=1,i=…[,p=…][,c=…][,r=…]` APC, optional `ESC 8` suffix. tmux
/// passthrough is unwrapped first. Returns `None` for anything else —
/// placeholder grids, sixel/iTerm2 payloads — so callers fall back to writing
/// the line verbatim.
pub(crate) fn parse_kitty_direct_placement_line(line: &str) -> Option<KittyDirectPlacement> {
	let line = unwrap_tmux_passthrough(line);
	let mut rest = line.as_bytes();
	if let Some(after_save) = rest.strip_prefix(b"\x1b7") {
		rest = after_save;
		if let Some((_, after_lift)) = rest.strip_prefix(b"\x1b[").and_then(leading_number)
			&& let Some(after_lift) = after_lift.strip_prefix(b"A")
		{
			rest = after_lift;
		}
	}
	let rest = rest.strip_prefix(b"\x1b_Ga=p,q=2,C=1,i=")?;
	let (image_id, rest) = leading_number(rest)?;
	let (placement_id, rest) = optional_parameter(rest, b",p=");
	let (columns, rest) = optional_parameter(rest, b",c=");
	let (rows, rest) = optional_parameter(rest, b",r=");
	let rest = rest.strip_prefix(b"\x1b\\")?;
	if !rest.is_empty() && rest != b"\x1b8" {
		return None;
	}
	let (columns, rows) = (columns?, rows?);
	if columns == 0 || rows == 0 {
		return None;
	}
	Some(KittyDirectPlacement { image_id, placement_id, columns, rows })
}

/// `ESC 7` + `CUU(n)` lead-in of an image direct-placement line: `n` and the
/// lead-in's byte length.
fn direct_placement_lead_in(line: &str) -> Option<(u32, usize)> {
	let after_save = line.as_bytes().strip_prefix(b"\x1b7\x1b[")?;
	let digits = after_save
		.iter()
		.take_while(|byte| byte.is_ascii_digit())
		.count();
	if digits == 0 || after_save.get(digits) != Some(&b'A') {
		return None;
	}
	let lift = after_save[..digits].iter().fold(0u32, |lift, &byte| {
		lift
			.saturating_mul(10)
			.saturating_add(u32::from(byte - b'0'))
	});
	Some((lift, 4 + digits + 1))
}

/// Rows above its own line that an image direct-placement line paints over:
/// the `CUU(rows-1)` of its lead-in, or 0 for any other line. The renderer
/// erases those rows before a SIXEL/iTerm2 block is written again, because
/// those protocols have no delete command and the block's reserved rows are
/// byte-identical between frames, so the diff never rewrites them.
pub(crate) fn direct_placement_lift(line: &str) -> u32 {
	direct_placement_lead_in(line).map_or(0, |(lift, _)| lift)
}

/// Re-anchor an image direct-placement line `lift` rows above its own row
/// instead of its encoded `CUU(rows-1)`. The renderer lowers the lift when the
/// block's top is clipped by the frame: the cursor-up would otherwise climb
/// past the frame's first row into whatever the terminal shows above it.
pub(crate) fn with_direct_placement_lift(line: &str, lift: u32) -> Cow<'_, str> {
	let Some((_, lead_in)) = direct_placement_lead_in(line) else {
		return Cow::Borrowed(line);
	};
	let rest = &line[lead_in..];
	let mut out = String::with_capacity(line.len());
	out.push_str("\x1b7");
	if lift > 0 {
		// Writing to a String cannot fail.
		let _ = write!(out, "\x1b[{lift}A");
	}
	out.push_str(rest);
	Cow::Owned(out)
}

/// One Kitty graphics command (`ESC _ G params ESC \`). Inside tmux
/// (`tmux`: the host saw `TMUX`) it is wrapped in tmux's DCS passthrough
/// envelope, which doubles every ESC of the payload.
fn kitty_command(params: fmt::Arguments<'_>, tmux: bool) -> String {
	if tmux {
		format!("\x1bPtmux;\x1b\x1b_G{params}\x1b\x1b\\\x1b\\")
	} else {
		format!("\x1b_G{params}\x1b\\")
	}
}

/// A direct placement to rebuild for the frame row it is written at.
#[derive(Clone, Copy, Debug)]
pub(crate) struct KittyPlacementLine {
	pub image_id:        u32,
	pub placement_id:    u32,
	pub columns:         u32,
	/// Total cell rows of the image block.
	pub rows:            u32,
	/// Frame row the block's last line is being written at.
	pub screen_row:      u32,
	/// Source image height in pixels, for the clipped source rectangle.
	pub image_height_px: f64,
}

/// Rebuild an image direct-placement line for the viewport row it is written
/// at. The component-rendered line encodes `CUU(rows-1)`, which clamps at the
/// viewport top once the block's leading rows have scrolled out — the
/// placement then re-anchors the full image shifted down over foreign rows.
/// Anchor at the block's first *visible* row instead, clipping the source
/// rectangle (`y=`/`h=`, image pixels) to the visible bottom slice.
pub(crate) fn encode_kitty_placement_line(placement: KittyPlacementLine, tmux: bool) -> String {
	let KittyPlacementLine { image_id, placement_id, columns, rows, screen_row, image_height_px } =
		placement;
	// Without a source pixel height the slice cannot be expressed — emit the
	// component's own full form (status quo) rather than squashing the whole
	// image into the reduced row count.
	let clippable = image_height_px > 0.0;
	let hidden_rows = if clippable {
		rows.saturating_sub(1).saturating_sub(screen_row)
	} else {
		0
	};
	let visible_rows = rows - hidden_rows;
	let apc = if hidden_rows > 0 {
		let src_y = (image_height_px * f64::from(hidden_rows) / f64::from(rows)).floor();
		let height = (image_height_px - src_y).max(1.0);
		kitty_command(
			format_args!(
				"a=p,q=2,C=1,i={image_id},p={placement_id},c={columns},r={visible_rows},y={src_y},\
				 h={height}"
			),
			tmux,
		)
	} else {
		kitty_command(
			format_args!("a=p,q=2,C=1,i={image_id},p={placement_id},c={columns},r={visible_rows}"),
			tmux,
		)
	};
	let cuu = visible_rows.saturating_sub(1);
	if cuu > 0 {
		format!("\x1b7\x1b[{cuu}A{apc}\x1b8")
	} else {
		apc
	}
}

/// Kitty graphics delete command for a single image id. Uses `d=I` (capital)
/// which removes the image and every one of its placements — on screen *and*
/// in scrollback — and frees the backing data. `q=2` suppresses the terminal
/// reply. Text-clearing escapes (`CSI 2 J` / `CSI 3 J`) do not remove Kitty
/// graphics, so this is the only way to actually purge a placed image.
pub(crate) fn encode_kitty_delete_image(image_id: u32, tmux: bool) -> String {
	kitty_command(format_args!("a=d,d=I,i={image_id},q=2"), tmux)
}

/// Delete every Kitty image and placement in the terminal. Used only by an
/// explicit destructive display reset: text erases leave untracked placements
/// painted, so per-image bookkeeping cannot guarantee a clean viewport.
pub(crate) fn encode_kitty_delete_all_images(tmux: bool) -> String {
	kitty_command(format_args!("a=d,d=A,q=2"), tmux)
}

/// Delete a single placement of an image (`d=i`, lowercase): removes its cells
/// and registry entry but keeps the transmitted data, so a later `a=p` under a
/// fresh placement id needs no retransmit. The frame writer uses this before
/// replacing a live image without deleting its archived copies.
pub(crate) fn encode_kitty_delete_placement(
	image_id: u32,
	placement_id: u32,
	tmux: bool,
) -> String {
	kitty_command(format_args!("a=d,d=i,i={image_id},p={placement_id},q=2"), tmux)
}

// ============================================================================
// SIXEL
// ============================================================================

/// Why a SIXEL raster could not be cropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SixelCropError {
	/// The sequence is outside the supported grammar.
	Invalid(&'static str),
	/// No token of the supported grammar starts at this byte offset.
	UnsupportedToken(usize),
}

impl fmt::Display for SixelCropError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Invalid(reason) => write!(f, "Cannot crop SIXEL: {reason}"),
			Self::UnsupportedToken(offset) => {
				write!(f, "Cannot crop SIXEL: unsupported token at offset {offset}")
			},
		}
	}
}

impl std::error::Error for SixelCropError {}

/// Length of the run of ASCII digits at the start of `bytes`.
fn digit_run(bytes: &[u8]) -> usize {
	bytes
		.iter()
		.take_while(|byte| byte.is_ascii_digit())
		.count()
}

/// Length of `ESC P [0-9;]* q` at the start of `bytes`.
fn sixel_header_len(bytes: &[u8]) -> Option<usize> {
	let params = bytes.strip_prefix(b"\x1bP")?;
	let length = params
		.iter()
		.take_while(|&&byte| byte.is_ascii_digit() || byte == b';')
		.count();
	(params.get(length) == Some(&b'q')).then_some(2 + length + 1)
}

/// Give an empty first band an explicit transparent width. Zellij derives the
/// decoded image width from its first pixel row, ignoring the raster minimum
/// for transparent images; an omitted band otherwise makes the image
/// invisible. Palette definitions stay before drawing so cropping can still
/// parse them.
pub(crate) fn ensure_sixel_raster_width(sequence: &str) -> Cow<'_, str> {
	// `ESC P params q " pan ; pad ; width ; height`, then only color
	// selections, palette definitions and `$`, up to a graphics newline.
	let bytes = sequence.as_bytes();
	let scan = || -> Option<(usize, Range<usize>)> {
		let mut at = sixel_header_len(bytes)?;
		if bytes.get(at) != Some(&b'"') {
			return None;
		}
		at += 1;
		let mut width = 0..0;
		for field in 0..4 {
			let digits = digit_run(&bytes[at..]);
			if digits == 0 {
				return None;
			}
			if field == 2 {
				width = at..at + digits;
			}
			at += digits;
			if field < 3 {
				if bytes.get(at) != Some(&b';') {
					return None;
				}
				at += 1;
			}
		}
		loop {
			match bytes.get(at) {
				Some(b'$') => at += 1,
				Some(b'#') => {
					let digits = digit_run(&bytes[at + 1..]);
					if digits == 0 {
						return None;
					}
					at += 1 + digits;
					at += palette_definition_len(&bytes[at..]);
				},
				Some(b'-') => return Some((at, width)),
				_ => return None,
			}
		}
	};
	let Some((newline, width)) = scan() else {
		return Cow::Borrowed(sequence);
	};
	let mut out = String::with_capacity(sequence.len() + width.len() + 3);
	out.push_str(&sequence[..newline]);
	out.push('!');
	out.push_str(&sequence[width]);
	out.push_str("?$");
	out.push_str(&sequence[newline..]);
	Cow::Owned(out)
}

/// Length of a `;[12];n;n;n` palette definition tail at the start of `bytes`,
/// or 0 when there is none.
fn palette_definition_len(bytes: &[u8]) -> usize {
	if bytes.first() != Some(&b';') || !matches!(bytes.get(1), Some(b'1' | b'2')) {
		return 0;
	}
	let mut at = 2;
	for _ in 0..3 {
		if bytes.get(at) != Some(&b';') {
			return 0;
		}
		let digits = digit_run(&bytes[at + 1..]);
		if digits == 0 {
			return 0;
		}
		at += 1 + digits;
	}
	at
}

/// Largest integer the component layer's encoder can represent exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn sixel_integer(digits: &[u8]) -> Result<u64, SixelCropError> {
	let mut value = 0u64;
	for &byte in digits {
		value = value
			.checked_mul(10)
			.and_then(|value| value.checked_add(u64::from(byte - b'0')))
			.filter(|&value| value <= MAX_SAFE_INTEGER)
			.ok_or(SixelCropError::Invalid("integer exceeds the safe range"))?;
	}
	Ok(value)
}

/// `;`-separated decimal parameters after a `#` or `"` introducer: the
/// parameter byte ranges within `bytes` and the offset just past them, or
/// `None` when no digit follows.
fn sixel_parameters(bytes: &[u8], start: usize) -> Option<(Vec<Range<usize>>, usize)> {
	let mut ranges = Vec::with_capacity(5);
	let mut at = start;
	loop {
		let digits = digit_run(&bytes[at..]);
		if digits == 0 {
			// A trailing `;` is not part of the token.
			if ranges.is_empty() {
				return None;
			}
			return Some((ranges, at - 1));
		}
		ranges.push(at..at + digits);
		at += digits;
		if bytes.get(at) != Some(&b';') {
			return Some((ranges, at));
		}
		at += 1;
	}
}

#[derive(Clone, Copy)]
enum SixelToken {
	/// Register selection (`#n`).
	Color(u64),
	/// Graphics carriage return (`$`).
	Return,
	Run {
		bits:  u8,
		count: u64,
	},
}

struct SixelBand {
	/// The selected register is inherited across graphics newlines.
	color:  u64,
	tokens: Range<usize>,
}

fn append_run(output: &mut String, bits: u8, count: u64) {
	let character = char::from(63 + bits);
	// Keep repeats compressed, including long transparent gaps.
	if count > 3 {
		// Writing to a String cannot fail.
		let _ = write!(output, "!{count}{character}");
	} else {
		for _ in 0..count {
			output.push(character);
		}
	}
}

/// Append `band` with every run shifted `shift` pixel rows toward the band's
/// top (negative: toward its bottom) and clipped to `mask`.
fn append_band(
	output: &mut String,
	tokens: &[SixelToken],
	band: Option<&SixelBand>,
	shift: i32,
	mask: u8,
) {
	let Some(band) = band else {
		return;
	};
	// Writing to a String cannot fail.
	let _ = write!(output, "#{}", band.color);
	for token in &tokens[band.tokens.clone()] {
		match *token {
			SixelToken::Color(color) => {
				let _ = write!(output, "#{color}");
			},
			SixelToken::Return => output.push('$'),
			SixelToken::Run { bits, count } => {
				let shifted = if shift >= 0 {
					bits >> shift
				} else {
					bits << -shift
				};
				append_run(output, shifted & mask, count);
			},
		}
	}
}

/// Crop integer pixel rows from a raw (not tmux-wrapped) SIXEL DCS image.
/// Runs are shifted between adjacent six-pixel bands, never decoded to pixels.
/// Palette selections, overdraw order, transparent gaps and DCS background
/// mode are retained. A zero crop returns the original sequence unchanged; a
/// crop that removes the whole image returns an empty string.
///
/// The supported grammar is the native `icy_sixel` encoder's: one leading
/// raster declaration with positive dimensions and square pixels, prefix
/// RGB/HLS palette definitions, register selections, sixel characters,
/// repeats, `$` and `-`. ESC DCS/ST framing only, as the TUI emits it.
///
/// Without `max_height_pixels` the crop is exact, including a partial final
/// band with zero padding bits and the exact declared raster height. Some
/// terminals still allocate all six rows of that final band. The renderer
/// supplies its available pixel height to cap the result at a whole-band
/// boundary, matching the native encoder's policy of dropping bottom pixels
/// rather than overwriting the following row.
///
/// # Errors
/// Palette definitions after drawing, additional raster declarations, other
/// controls and malformed input are rejected; forwarding an unsupported image
/// uncropped would reintroduce raster overflow.
pub(crate) fn crop_sixel_top(
	sequence: &str,
	pixels: u32,
	max_height_pixels: Option<u32>,
) -> Result<Cow<'_, str>, SixelCropError> {
	use SixelCropError::Invalid;

	if pixels == 0 {
		return Ok(Cow::Borrowed(sequence));
	}
	let bytes = sequence.as_bytes();
	let header = sixel_header_len(bytes).ok_or(Invalid("missing DCS introducer"))?;
	if !bytes.ends_with(b"\x1b\\") {
		return Err(Invalid("missing string terminator"));
	}
	let end = bytes.len() - 2;

	let mut palette: Vec<Range<usize>> = Vec::new();
	let mut tokens: Vec<SixelToken> = Vec::new();
	let mut bands: Vec<SixelBand> = Vec::new();
	let mut band_start = 0usize;
	let mut band_color = 0u64;
	let mut color = 0u64;
	let mut drawing = false;
	// Byte ranges of the raster's aspect numerator and denominator.
	let mut raster: Option<(Range<usize>, Range<usize>)> = None;
	let mut width = 0u64;
	let mut height = 0u64;
	let mut x = 0u64;
	let mut y = 0u64;
	let mut data_width = 0u64;
	let mut painted_height = 0u64;
	let mut cursor = header;

	while cursor < end {
		let unsupported = SixelCropError::UnsupportedToken(cursor);
		match bytes[cursor] {
			b'"' => {
				let (parameters, next) = sixel_parameters(bytes, cursor + 1).ok_or(unsupported)?;
				if raster.is_some() || drawing {
					return Err(Invalid("raster attributes must occur once before drawing"));
				}
				let [pan, pad, raster_width, raster_height] = parameters.as_slice() else {
					return Err(Invalid("expected four raster attributes"));
				};
				let pan_value = sixel_integer(&bytes[pan.clone()])?;
				let pad_value = sixel_integer(&bytes[pad.clone()])?;
				width = sixel_integer(&bytes[raster_width.clone()])?;
				height = sixel_integer(&bytes[raster_height.clone()])?;
				if pan_value == 0 || pan_value != pad_value {
					return Err(Invalid("only square pixels are supported"));
				}
				if width == 0 || height == 0 {
					return Err(Invalid("raster dimensions must be positive"));
				}
				raster = Some((pan.clone(), pad.clone()));
				cursor = next;
			},
			b'#' => {
				let (parameters, next) = sixel_parameters(bytes, cursor + 1).ok_or(unsupported)?;
				color = sixel_integer(&bytes[parameters[0].clone()])?;
				if parameters.len() > 1 {
					if drawing {
						return Err(Invalid("palette definitions must precede drawing"));
					}
					let model = &bytes[parameters[1].clone()];
					if parameters.len() != 5 || (model != b"1" && model != b"2") {
						return Err(Invalid("expected an RGB or HLS palette definition"));
					}
					for parameter in &parameters[2..] {
						sixel_integer(&bytes[parameter.clone()])?;
					}
					palette.push(cursor..next);
				}
				tokens.push(SixelToken::Color(color));
				cursor = next;
			},
			b'$' => {
				drawing = true;
				x = 0;
				tokens.push(SixelToken::Return);
				cursor += 1;
			},
			b'-' => {
				drawing = true;
				bands.push(SixelBand { color: band_color, tokens: band_start..tokens.len() });
				band_start = tokens.len();
				band_color = color;
				x = 0;
				y += 6;
				cursor += 1;
			},
			first => {
				// A sixel character (`?`..=`~`), optionally repeated (`!n`). The
				// terminator's ESC ends any digit run, so `at` stays in bounds.
				let at = if first == b'!' {
					let digits = digit_run(&bytes[cursor + 1..]);
					if digits == 0 {
						return Err(unsupported);
					}
					cursor + 1 + digits
				} else {
					cursor
				};
				let character = bytes[at];
				if !(b'?'..=b'~').contains(&character) {
					return Err(unsupported);
				}
				drawing = true;
				let count = if first == b'!' {
					sixel_integer(&bytes[cursor + 1..at])?
				} else {
					1
				};
				if count == 0 {
					return Err(Invalid("repeat count must be positive"));
				}
				let bits = character - 63;
				x = x
					.checked_add(count)
					.filter(|&x| x <= MAX_SAFE_INTEGER)
					.ok_or(Invalid("run width exceeds the safe range"))?;
				data_width = data_width.max(x);
				if bits != 0 {
					painted_height = painted_height.max(y + u64::from(8 - bits.leading_zeros()));
				}
				tokens.push(SixelToken::Run { bits, count });
				cursor = at + 1;
			},
		}
	}
	bands.push(SixelBand { color: band_color, tokens: band_start..tokens.len() });
	let (pan, pad) = raster.ok_or(Invalid("missing raster dimensions"))?;
	// Raster attributes specify a minimum, not a clip rectangle. Account for
	// drawing beyond them rather than silently discarding those source pixels.
	width = width.max(data_width);
	height = height.max(painted_height);
	let mut cropped_height = height.saturating_sub(u64::from(pixels));
	if let Some(max_height_pixels) = max_height_pixels {
		cropped_height = cropped_height.min(u64::from(max_height_pixels / 6 * 6));
	}
	if cropped_height == 0 {
		return Ok(Cow::Owned(String::new()));
	}

	let mut output = String::with_capacity(sequence.len());
	output.push_str(&sequence[..header]);
	// Writing to a String cannot fail.
	let _ = write!(output, "\"{};{};{width};{cropped_height}", &sequence[pan], &sequence[pad]);
	for definition in palette {
		output.push_str(&sequence[definition]);
	}
	let first_band = (pixels / 6) as usize;
	let shift = (pixels % 6) as i32;
	let band_count = cropped_height.div_ceil(6);
	for index in 0..band_count {
		if index > 0 {
			output.push('-');
		}
		let mask = (1u8 << (cropped_height - index * 6).min(6)) - 1;
		let source = first_band.saturating_add(usize::try_from(index).unwrap_or(usize::MAX));
		append_band(&mut output, &tokens, bands.get(source), shift, mask);
		if shift != 0 {
			output.push('$');
			append_band(&mut output, &tokens, bands.get(source.saturating_add(1)), shift - 6, mask);
		}
	}
	output.push_str("\x1b\\");
	let widened = match ensure_sixel_raster_width(&output) {
		Cow::Owned(widened) => Some(widened),
		Cow::Borrowed(_) => None,
	};
	Ok(Cow::Owned(widened.unwrap_or(output)))
}

struct SixelCrop {
	source:            String,
	pixels:            u32,
	max_height_pixels: u32,
	output:            String,
}

/// Crops SIXEL rasters whose top rows lie above the frame, remembering the
/// last crop: a clipped image block is re-emitted with the same crop on every
/// repaint until the frame scrolls.
#[derive(Default)]
pub(crate) struct SixelCropper {
	last: Option<SixelCrop>,
}

impl SixelCropper {
	/// Crop one raster. A raster the cropper cannot parse is dropped: painting
	/// it whole would overwrite the rows below the visible slice.
	fn crop(&mut self, source: &str, pixels: u32, max_height_pixels: u32) -> &str {
		let cached = self.last.as_ref().is_some_and(|last| {
			last.pixels == pixels
				&& last.max_height_pixels == max_height_pixels
				&& last.source == source
		});
		if !cached {
			let output = match crop_sixel_top(source, pixels, Some(max_height_pixels)) {
				Ok(output) => output.into_owned(),
				Err(err) => {
					log::warn!("Dropping top-clipped SIXEL image that cannot be cropped: {err}");
					String::new()
				},
			};
			self.last =
				Some(SixelCrop { source: source.to_owned(), pixels, max_height_pixels, output });
		}
		self.last.as_ref().map_or("", |last| last.output.as_str())
	}

	/// `line` with every SIXEL raster (`ESC P [0-9;]* q … ESC \`) cropped by
	/// `crop_pixels` top pixel rows and capped at `max_height_pixels`, or
	/// `None` when that changes nothing. An image line without a croppable
	/// raster (an OSC/APC image) must then be omitted rather than re-anchored:
	/// its hidden rows would paint below the reserved slice, over the
	/// following text.
	pub(crate) fn clip_line(
		&mut self,
		line: &str,
		crop_pixels: u32,
		max_height_pixels: u32,
	) -> Option<String> {
		let bytes = line.as_bytes();
		let mut out: Option<String> = None;
		let mut copied = 0;
		let mut from = 0;
		while let Some(found) = memmem::find(&bytes[from..], b"\x1bP") {
			let start = from + found;
			let Some(header) = sixel_header_len(&bytes[start..]) else {
				from = start + 2;
				continue;
			};
			let Some(terminator) = memmem::find(&bytes[start + header..], b"\x1b\\") else {
				break;
			};
			let end = start + header + terminator + 2;
			let cropped = self.crop(&line[start..end], crop_pixels, max_height_pixels);
			let out = out.get_or_insert_with(|| String::with_capacity(line.len()));
			out.push_str(&line[copied..start]);
			out.push_str(cropped);
			copied = end;
			from = end;
		}
		let mut out = out?;
		out.push_str(&line[copied..]);
		(out != line).then_some(out)
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;

	// ------------------------------------------------------------------------
	// Image rows
	// ------------------------------------------------------------------------

	#[test]
	fn image_rows_are_recognized_per_protocol() {
		let kitty = Some(ImageProtocol::Kitty);
		let iterm = Some(ImageProtocol::Iterm2);
		let sixel = Some(ImageProtocol::Sixel);
		let placement = "\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\\x1b8";
		assert!(is_image_line(kitty, placement));
		assert!(!is_image_line(None, placement));
		assert!(!is_image_line(sixel, placement));
		assert!(is_image_line(iterm, "\x1b]1337;File=inline=1:AAAA\x07"));
		assert!(!is_image_line(kitty, "\x1b]1337;File=inline=1:AAAA\x07"));
		assert!(is_image_line(sixel, "\x1b7\x1b[2A\x1bP0;1;0q\"1;1;4;6#1~\x1b\\\x1b8"));
		assert!(is_image_line(sixel, "\x1bPq~\x1b\\"));
		// A DCS that is not a sixel introducer, and plain styled text.
		assert!(!is_image_line(sixel, "\x1bPtmux;x\x1b\\"));
		assert!(!is_image_line(kitty, "\x1b[31mplain\x1b[0m"));
	}

	#[test]
	fn kitty_placeholders_mark_image_rows_for_kitty_and_iterm2() {
		let row = "\x1b[38;5;7m\u{10eeee}\u{305}\u{305}\u{10eeee}\u{305}\u{30d}\x1b[39m";
		assert!(is_image_line(Some(ImageProtocol::Kitty), row));
		assert!(is_image_line(Some(ImageProtocol::Iterm2), row));
		assert!(!is_image_line(Some(ImageProtocol::Sixel), row));
		// Another character sharing the placeholder's lead byte is no marker.
		assert!(!is_image_line(Some(ImageProtocol::Kitty), "\u{10eeef}\u{100000}"));
	}

	#[test]
	fn markers_past_the_scan_window_are_ignored() {
		let kitty = Some(ImageProtocol::Kitty);
		let marker = "\x1b_Ga=p\x1b\\";
		// The whole marker must fit in the first 512 code units.
		assert!(is_image_line(kitty, &format!("{}{marker}", "x".repeat(509))));
		assert!(!is_image_line(kitty, &format!("{}{marker}", "x".repeat(510))));
		// The window counts UTF-16 code units, not UTF-8 bytes.
		assert!(is_image_line(kitty, &format!("{}{marker}", "│".repeat(509))));
		assert!(!is_image_line(kitty, &format!("{}{marker}", "😀".repeat(255))));
		assert!(is_image_line(kitty, &format!("{}{marker}", "😀".repeat(254))));
		assert!(is_image_line(kitty, &format!("{}\u{10eeee}", "x".repeat(510))));
		assert!(!is_image_line(kitty, &format!("{}\u{10eeee}", "x".repeat(511))));

		let sixel = Some(ImageProtocol::Sixel);
		assert!(is_image_line(sixel, &format!("{}\x1bPq", "x".repeat(125))));
		assert!(!is_image_line(sixel, &format!("{}\x1bPq", "x".repeat(126))));
		assert!(!is_image_line(sixel, &format!("\x1bP{}q", "1;".repeat(70))));
	}

	// ------------------------------------------------------------------------
	// Kitty direct placements
	// ------------------------------------------------------------------------

	fn wrap_tmux(payload: &str) -> String {
		format!("\x1bPtmux;{}\x1b\\", payload.replace('\x1b', "\x1b\x1b"))
	}

	#[test]
	fn parses_the_direct_placement_line_forms() {
		let expected = KittyDirectPlacement {
			image_id:     7,
			placement_id: Some(7),
			columns:      4,
			rows:         6,
		};
		// The exact line an image block renders as its last row.
		assert_eq!(
			parse_kitty_direct_placement_line(
				"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=7,c=4,r=6\x1b\\\x1b8"
			),
			Some(expected)
		);
		// A one-row block has no cursor movement around the command.
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b_Ga=p,q=2,C=1,i=7,c=4,r=1\x1b\\"),
			Some(KittyDirectPlacement {
				image_id:     7,
				placement_id: None,
				columns:      4,
				rows:         1,
			})
		);
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b7\x1b_Ga=p,q=2,C=1,i=7,p=7,c=4,r=6\x1b\\"),
			Some(expected)
		);
	}

	#[test]
	fn rejects_non_placement_image_lines() {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\"),
			None
		);
		// Transmit-and-display and plain text never match.
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\"),
			None
		);
		assert_eq!(parse_kitty_direct_placement_line("plain text"), None);
		// A placement without its cell size, or with anything around it.
		assert_eq!(parse_kitty_direct_placement_line("\x1b_Ga=p,q=2,C=1,i=5,p=5\x1b\\"), None);
		assert_eq!(parse_kitty_direct_placement_line("\x1b_Ga=p,q=2,C=1,i=5,c=0,r=4\x1b\\"), None);
		assert_eq!(parse_kitty_direct_placement_line("x\x1b_Ga=p,q=2,C=1,i=5,c=4,r=4\x1b\\"), None);
		assert_eq!(parse_kitty_direct_placement_line("\x1b_Ga=p,q=2,C=1,i=5,c=4,r=4\x1b\\x"), None);
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b_Ga=p,q=2,C=1,i=5,c=4,r=4,y=2\x1b\\"),
			None
		);
		assert_eq!(
			parse_kitty_direct_placement_line("\x1b7\x1b[A\x1b_Ga=p,q=2,C=1,i=5,c=4,r=4\x1b\\"),
			None
		);
	}

	#[test]
	fn recognizes_passthrough_placements_so_tmux_redraws_can_delete_the_old_image() {
		let line =
			format!("\x1b7\x1b[3A{}\x1b8", wrap_tmux("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\"));
		assert_eq!(
			parse_kitty_direct_placement_line(&line),
			Some(KittyDirectPlacement {
				image_id:     5,
				placement_id: Some(5),
				columns:      4,
				rows:         4,
			})
		);
		// An envelope that never closes is left as is.
		assert_eq!(unwrap_tmux_passthrough("a\x1bPtmux;\x1b\x1b_Gx"), "a\x1bPtmux;\x1b\x1b_Gx");
		assert_eq!(
			unwrap_tmux_passthrough(&format!(
				"a{}b{}c",
				wrap_tmux("\x1b_G1\x1b\\"),
				wrap_tmux("é\x1b")
			)),
			"a\x1b_G1\x1b\\bé\x1bc"
		);
	}

	#[test]
	fn encodes_the_anchored_clipped_and_last_row_only_placement_forms() {
		let base = KittyPlacementLine {
			image_id:        7,
			placement_id:    1,
			columns:         4,
			rows:            6,
			screen_row:      9,
			image_height_px: 60.0,
		};
		// Whole block visible (last line at viewport row 9): full anchored form.
		assert_eq!(
			encode_kitty_placement_line(base, false),
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8"
		);
		// Straddling (last line at row 3): two rows hidden above, four visible —
		// the source slice starts at 60*2/6 = 20px.
		assert_eq!(
			encode_kitty_placement_line(
				KittyPlacementLine { placement_id: 2, screen_row: 3, ..base },
				false
			),
			"\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8"
		);
		// Only the last row visible: no cursor movement, bottom slice only.
		assert_eq!(
			encode_kitty_placement_line(
				KittyPlacementLine { placement_id: 3, screen_row: 0, ..base },
				false
			),
			"\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\"
		);
		// Unknown source height: the full form, even when rows are hidden.
		assert_eq!(
			encode_kitty_placement_line(
				KittyPlacementLine { screen_row: 0, image_height_px: 0.0, ..base },
				false
			),
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8"
		);
	}

	#[test]
	fn an_encoded_placement_parses_back() {
		for tmux in [false, true] {
			let line = encode_kitty_placement_line(
				KittyPlacementLine {
					image_id:        9,
					placement_id:    12,
					columns:         3,
					rows:            5,
					screen_row:      8,
					image_height_px: 50.0,
				},
				tmux,
			);
			assert_eq!(
				parse_kitty_direct_placement_line(&line),
				Some(KittyDirectPlacement {
					image_id:     9,
					placement_id: Some(12),
					columns:      3,
					rows:         5,
				})
			);
		}
	}

	#[test]
	fn delete_commands_free_the_image_a_placement_or_everything() {
		// An APC delete-by-id that frees the image and suppresses the reply.
		assert_eq!(encode_kitty_delete_image(42, false), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert_eq!(encode_kitty_delete_placement(42, 7, false), "\x1b_Ga=d,d=i,i=42,p=7,q=2\x1b\\");
		assert_eq!(encode_kitty_delete_all_images(false), "\x1b_Ga=d,d=A,q=2\x1b\\");
	}

	#[test]
	fn wraps_every_kitty_graphics_command_in_a_tmux_dcs_envelope() {
		assert_eq!(encode_kitty_delete_image(9, true), wrap_tmux("\x1b_Ga=d,d=I,i=9,q=2\x1b\\"));
		assert_eq!(
			encode_kitty_delete_placement(9, 3, true),
			wrap_tmux("\x1b_Ga=d,d=i,i=9,p=3,q=2\x1b\\")
		);
		assert_eq!(encode_kitty_delete_all_images(true), wrap_tmux("\x1b_Ga=d,d=A,q=2\x1b\\"));
		// Only the command is wrapped; the cursor save/restore stays outside.
		assert_eq!(
			encode_kitty_placement_line(
				KittyPlacementLine {
					image_id:        9,
					placement_id:    9,
					columns:         3,
					rows:            2,
					screen_row:      4,
					image_height_px: 20.0,
				},
				true
			),
			format!("\x1b7\x1b[1A{}\x1b8", wrap_tmux("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\"))
		);
	}

	#[test]
	fn direct_placement_lift_reads_and_rewrites_the_lead_in() {
		let line = "\x1b7\x1b[3A\x1bPq~\x1b\\\x1b8";
		assert_eq!(direct_placement_lift(line), 3);
		assert_eq!(direct_placement_lift("\x1b7\x1bPq~\x1b\\\x1b8"), 0);
		assert_eq!(direct_placement_lift("text \x1b7\x1b[3A"), 0);
		assert_eq!(with_direct_placement_lift(line, 1), "\x1b7\x1b[1A\x1bPq~\x1b\\\x1b8");
		assert_eq!(with_direct_placement_lift(line, 0), "\x1b7\x1bPq~\x1b\\\x1b8");
		assert!(matches!(with_direct_placement_lift("plain", 2), Cow::Borrowed("plain")));
	}

	// ------------------------------------------------------------------------
	// SIXEL
	// ------------------------------------------------------------------------

	struct Decoded {
		width:            usize,
		height:           usize,
		first_band_width: usize,
		pixels:           Vec<Vec<Option<String>>>,
	}

	/// Small independent interpreter: keep colors per pixel, never shift SIXEL
	/// bands.
	fn decode(sequence: &str) -> Decoded {
		let bytes = sequence.as_bytes();
		let header = sixel_header_len(bytes).expect("fixture has a DCS introducer");
		assert!(sequence.ends_with("\x1b\\"), "fixture has a string terminator");
		let numbers = |offset: &mut usize| -> Vec<usize> {
			let start = *offset;
			while bytes[*offset].is_ascii_digit() || bytes[*offset] == b';' {
				*offset += 1;
			}
			sequence[start..*offset]
				.split(';')
				.map(|number| number.parse().unwrap())
				.collect()
		};
		let mut raster_at = sequence.find('"').expect("fixture has raster attributes") + 1;
		let raster = numbers(&mut raster_at);
		let mut decoded = Decoded {
			width:            raster[2],
			height:           raster[3],
			first_band_width: 0,
			pixels:           vec![vec![None; raster[2]]; raster[3]],
		};
		let mut palette: HashMap<usize, String> = HashMap::new();
		let mut color = 0usize;
		let (mut x, mut y) = (0usize, 0usize);
		let mut offset = header;
		while offset < bytes.len() - 2 {
			let command = bytes[offset];
			offset += 1;
			let (character, repeat) = match command {
				b'"' => {
					numbers(&mut offset);
					continue;
				},
				b'#' => {
					let values = numbers(&mut offset);
					color = values[0];
					if values.len() > 1 {
						assert_eq!(values[1], 2, "fixture decoder expects RGB palette entries");
						let entry = values[2..]
							.iter()
							.map(usize::to_string)
							.collect::<Vec<_>>()
							.join(",");
						palette.insert(color, entry);
					}
					continue;
				},
				b'$' => {
					x = 0;
					continue;
				},
				b'-' => {
					x = 0;
					y += 6;
					continue;
				},
				b'!' => {
					let repeat = numbers(&mut offset)[0];
					let character = bytes[offset];
					offset += 1;
					(character, repeat)
				},
				character => (character, 1),
			};
			let mask = character
				.checked_sub(63)
				.filter(|&mask| mask <= 63)
				.expect("invalid SIXEL pixel");
			if y == 0 {
				decoded.first_band_width = decoded.first_band_width.max(x + repeat);
			}
			for _ in 0..repeat {
				for bit in 0..6 {
					if mask & (1 << bit) != 0 && y + bit < decoded.height && x < decoded.width {
						let value = palette
							.get(&color)
							.unwrap_or_else(|| panic!("undefined color {color}"));
						decoded.pixels[y + bit][x] = Some(value.clone());
					}
				}
				x += 1;
			}
		}
		decoded
	}

	fn crop(sequence: &str, pixels: u32) -> String {
		crop_sixel_top(sequence, pixels, None).unwrap().into_owned()
	}

	const RED: &str = "100,0,0";
	// Each band uses multiple color passes, transparent columns, and repeated
	// pixels. Bit patterns differ across adjacent bands so a band-only crop
	// cannot pass.
	const IMAGE: &str = concat!(
		"\x1bP0;1;0q\"1;1;5;18#1;2;100;0;0#2;2;0;100;0#3;2;0;0;100",
		"#1!2V?$#2??!2i-#3!3j$#1???@-#2!2~$#3??!2T\x1b\\",
	);

	fn red_row(width: usize) -> Vec<Option<String>> {
		vec![Some(RED.to_owned()); width]
	}

	#[test]
	fn leaves_a_zero_pixel_crop_byte_for_byte_unchanged() {
		assert!(
			matches!(crop_sixel_top(IMAGE, 0, None), Ok(Cow::Borrowed(sequence)) if sequence == IMAGE)
		);
	}

	#[test]
	fn keeps_transparent_leading_bands_visible_to_zellij_without_painting_their_pixels() {
		let source = "\x1bP9;1;0q\"1;1;5;18#1;2;100;0;0--#1!5~\x1b\\";
		let original = decode(source);
		assert_eq!(original.first_band_width, 0);
		let widened = ensure_sixel_raster_width(source);
		assert_eq!(widened, "\x1bP9;1;0q\"1;1;5;18#1;2;100;0;0!5?$--#1!5~\x1b\\");
		let result = decode(&widened);
		assert_eq!(result.first_band_width, 5);
		assert_eq!(result.pixels, original.pixels);
		assert_eq!(result.pixels[12], red_row(5));
		// A first band that draws is left alone.
		assert!(matches!(ensure_sixel_raster_width(IMAGE), Cow::Borrowed(_)));
	}

	#[test]
	fn retains_image_width_when_cropping_exposes_a_transparent_first_band() {
		let source = "\x1bP9;1;0q\"1;1;5;18#1;2;100;0;0#1!5~--#1!5~\x1b\\";
		let result = decode(&crop(source, 6));
		assert_eq!(result.first_band_width, 5);
		assert_eq!(result.pixels, decode(source).pixels[6..]);
		assert_eq!(result.pixels[6], red_row(5));
	}

	#[test]
	fn preserves_every_surviving_pixel_after_removing_top_pixels() {
		let source = decode(IMAGE);
		for pixels in [2usize, 6, 7, 17] {
			let cropped = crop(IMAGE, pixels as u32);
			let result = decode(&cropped);
			assert_eq!(result.width, source.width, "{pixels}");
			assert_eq!(result.height, source.height - pixels, "{pixels}");
			assert_eq!(result.pixels, source.pixels[pixels..], "{pixels}");
			assert!(cropped.starts_with("\x1bP0;1;0q"), "{pixels}");
		}
	}

	#[test]
	fn shifts_runs_between_bands_without_re_encoding() {
		const HEAD: &str = "\x1bP0;1;0q\"1;1;5;";
		const PALETTE: &str = "#1;2;100;0;0#2;2;0;100;0#3;2;0;0;100";
		// Each band is its own shifted runs, a carriage return, then the next
		// band's runs shifted into the rows the crop freed.
		for (pixels, max_height, height, body) in [
			(
				2,
				None,
				16,
				"#0#1#2#3#1DD?$#2??II$#2#3ooo$#1???O-#2#3III$#1????$#1#2oo$#3??OO-#1#2NN$#3??DD$",
			),
			// A whole-band crop only drops bands.
			(6, None, 12, "#2#3jjj$#1???@-#1#2~~$#3??TT"),
			(7, None, 11, "#2#3TTT$#1????$#1#2__$#3??__-#1#2^^$#3??II$"),
			(17, None, 1, "#1#2@@$#3????$"),
			// The height cap keeps whole bands only.
			(6, Some(8), 6, "#2#3jjj$#1???@"),
		] {
			assert_eq!(
				crop_sixel_top(IMAGE, pixels, max_height).unwrap(),
				format!("{HEAD}{height}{PALETTE}{body}\x1b\\"),
				"{pixels} {max_height:?}"
			);
		}
		// Long runs stay compressed, and an exposed empty first band is widened.
		assert_eq!(
			crop("\x1bP9;1;0q\"1;1;5;18#1;2;100;0;0#1!5~--#1!5~\x1b\\", 6),
			"\x1bP9;1;0q\"1;1;5;12#1;2;100;0;0#1!5?$-#1#1!5~\x1b\\"
		);
	}

	#[test]
	fn emits_no_dcs_for_a_fully_removed_image() {
		for pixels in [18, 19] {
			assert_eq!(crop(IMAGE, pixels), "");
		}
	}

	#[test]
	fn retains_palette_definitions_from_removed_bands_and_transparent_runs() {
		let source = "\x1bP0;1;0q\"1;1;40;12#7;2;100;0;0!40~-!10?!20~!10?\x1b\\";
		let cropped = decode(&crop(source, 6));
		assert_eq!(cropped.pixels, decode(source).pixels[6..]);
		let mut expected = vec![None; 10];
		expected.extend(red_row(20));
		expected.extend(vec![None; 10]);
		assert_eq!(cropped.pixels[0], expected);
	}

	#[test]
	fn crops_a_declared_partial_final_band_without_exposing_padding_pixels() {
		let source = "\x1bP0;1;0q\"1;1;2;8#1;2;100;0;0!2~-!2B\x1b\\";
		let cropped = decode(&crop(source, 3));
		assert_eq!(cropped.height, 5);
		assert_eq!(cropped.pixels, decode(source).pixels[3..]);
	}

	#[test]
	fn caps_a_38_pixel_remainder_to_six_safe_bands_inside_two_20_pixel_terminal_rows() {
		let bands = (0..13)
			.map(|index| format!("#{}!4~", index % 2 + 1))
			.collect::<Vec<_>>()
			.join("-");
		let source = format!("\x1bP0;1;0q\"1;1;4;78#1;2;100;0;0#2;2;0;100;0{bands}\x1b\\");
		let exact = decode(&crop(&source, 40));
		assert_eq!(exact.height, 38);
		assert_eq!(exact.pixels, decode(&source).pixels[40..]);

		let capped = crop_sixel_top(&source, 40, Some(40)).unwrap();
		let result = decode(&capped);
		assert_eq!(result.height, 36);
		assert_eq!(result.pixels, exact.pixels[..36]);
		let body = &capped[capped.find('q').unwrap() + 1..capped.len() - 2];
		assert!(body.split('-').count() * 6 <= 40);
	}

	#[test]
	fn rejects_rasters_outside_the_supported_grammar() {
		use SixelCropError::{Invalid, UnsupportedToken};
		let error = |sequence: &str| crop_sixel_top(sequence, 1, None).unwrap_err();
		assert_eq!(error("q\"1;1;2;6~\x1b\\"), Invalid("missing DCS introducer"));
		assert_eq!(error("\x1bPq\"1;1;2;6~"), Invalid("missing string terminator"));
		assert_eq!(error("\x1bPq~~\x1b\\"), Invalid("missing raster dimensions"));
		assert_eq!(error("\x1bPq\"1;1;2~\x1b\\"), Invalid("expected four raster attributes"));
		assert_eq!(error("\x1bPq\"2;1;2;6~\x1b\\"), Invalid("only square pixels are supported"));
		assert_eq!(error("\x1bPq\"1;1;0;6~\x1b\\"), Invalid("raster dimensions must be positive"));
		assert_eq!(
			error("\x1bPq\"1;1;2;6~\"1;1;2;6\x1b\\"),
			Invalid("raster attributes must occur once before drawing")
		);
		assert_eq!(
			error("\x1bPq\"1;1;2;6~#1;2;0;0;0\x1b\\"),
			Invalid("palette definitions must precede drawing")
		);
		assert_eq!(
			error("\x1bPq\"1;1;2;6#1;3;0;0;0~\x1b\\"),
			Invalid("expected an RGB or HLS palette definition")
		);
		assert_eq!(error("\x1bPq\"1;1;2;6!0~\x1b\\"), Invalid("repeat count must be positive"));
		assert_eq!(
			error("\x1bPq\"1;1;2;6#99999999999999999999~\x1b\\"),
			Invalid("integer exceeds the safe range")
		);
		assert_eq!(error("\x1bPq\"1;1;2;6~\x1b[0m~\x1b\\"), UnsupportedToken(12));
		assert_eq!(error("\x1bPq\"1;1;2;6~!3\x1b\\"), UnsupportedToken(12));
		assert_eq!(
			error("\x1bPq\"1;1;2;6~ \x1b\\").to_string(),
			"Cannot crop SIXEL: unsupported token at offset 12"
		);
	}

	#[test]
	fn clips_every_raster_in_a_line_and_drops_what_it_cannot_crop() {
		let mut cropper = SixelCropper::default();
		let line = format!("\x1b7\x1b[2A{IMAGE}\x1b8");
		let clipped = cropper.clip_line(&line, 6, 600).unwrap();
		assert_eq!(clipped, format!("\x1b7\x1b[2A{}\x1b8", crop(IMAGE, 6)));
		// The remembered crop answers the same request again.
		assert_eq!(cropper.clip_line(&line, 6, 600).unwrap(), clipped);
		// The height cap keeps whole bands only.
		let capped = cropper.clip_line(&line, 6, 8).unwrap();
		assert_eq!(decode(&capped[6..capped.len() - 2]).height, 6);
		// An unparseable raster is dropped, leaving the cursor framing.
		assert_eq!(
			cropper
				.clip_line("\x1b7\x1b[2A\x1bPq~~\x1b\\\x1b8", 6, 600)
				.unwrap(),
			"\x1b7\x1b[2A\x1b8"
		);
		// Lines without a raster — an iTerm2 image, text — cannot be cropped.
		assert_eq!(
			cropper.clip_line("\x1b7\x1b[2A\x1b]1337;File=inline=1:AAAA\x07\x1b8", 6, 600),
			None
		);
		assert_eq!(cropper.clip_line("\x1bPtmux;x\x1b\\", 6, 600), None);
		assert_eq!(cropper.clip_line(&line, 0, 600), None);
	}
}
