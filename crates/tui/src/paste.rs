//! Paste handling across terminal protocol, dropped-path classification, and OS
//! clipboards.
//!
//! [`PasteEvents`] implements the sans-I/O OSC 5522 conversation,
//! [`dropped_paths`] extracts explicit terminal-drop paths,
//! [`classify_attachment_path`] distinguishes previewable images/videos, and
//! the clipboard functions provide blocking native backends. Terminal and
//! runtime integration belongs beside [`crate::Terminal`].
//!
//! The clipboard functions block — subprocess bridges are killed after a few
//! seconds, but a wedged native clipboard (a dead X11 connection, a stuck
//! pasteboard) can hold them indefinitely. [`spawn_clipboard_read`] runs the
//! read on a detached thread reporting through a one-shot channel — never
//! tokio's blocking pool, which cannot abort a running task and stalls
//! runtime shutdown behind it. Pair the receiver with a deadline to recover
//! from a hung native handle.

use std::{
	env, io,
	io::{Read, Write},
	mem,
	path::PathBuf,
	process::{Command, Stdio},
	str, thread,
	time::{Duration, Instant},
};

use omp_core::{Str, base64, hex, sf};
use smallvec::SmallVec;
use tokio::sync::{oneshot, oneshot::Receiver};

use crate::{Key, imagefmt, imagefmt::ImageFormat};

const CLI_TIMEOUT: Duration = Duration::from_secs(5);
const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(8);
const PASTE_EVENT_NAME_BASE64: &str = "UGFzdGUgZXZlbnQ=";
const IMAGE_PRIORITY: [ImageFormat; 4] =
	[ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Webp, ImageFormat::Gif];

/// A completed out-of-band paste delivered by the terminal or clipboard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Pasted {
	/// Pasted UTF-8 text, with invalid sequences replaced.
	Text(Str),
	/// Pasted image bytes.
	Image(PastedImage),
}

/// Raw image payload with its sniffed container format.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PastedImage {
	/// Encoded image container bytes.
	pub bytes:  Vec<u8>,
	/// Image container format.
	pub format: ImageFormat,
}

impl PastedImage {
	/// Creates an image when `bytes` begin with a recognized container header.
	pub fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
		let format = imagefmt::format(&bytes)?;
		Some(Self { bytes, format })
	}

	/// Returns the conventional file extension for this image.
	pub const fn extension(&self) -> &'static str {
		match self.format {
			ImageFormat::Png => "png",
			ImageFormat::Jpeg => "jpg",
			ImageFormat::Gif => "gif",
			ImageFormat::Webp => "webp",
		}
	}

	/// Writes the image to a fresh private temporary file and returns its
	/// path.
	///
	/// The file is created with a randomized name, exclusively
	/// (`O_CREAT | O_EXCL`), and written through the open handle — a
	/// pre-planted symlink at a guessable `/tmp` name can neither be
	/// followed nor hijack the write. It persists (is not deleted on drop)
	/// for the lifetime of the attachment that references it.
	pub fn persist(&self) -> io::Result<PathBuf> {
		use std::io::Write as _;
		let mut file = tempfile::Builder::new()
			.prefix("omp-tui-paste-")
			.suffix(&format!(".{}", self.extension()))
			.tempfile()?;
		file.write_all(&self.bytes)?;
		let (file, path) = file.keep().map_err(|error| error.error)?;
		drop(file);
		Ok(path)
	}
}

/// Aggregate cap on buffered OSC 5522 payload chunks (encoded bytes),
/// matching the decoder's bracketed-paste ceiling. A runaway or malicious
/// transfer resets instead of growing without bound.
const MAX_READ_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
/// Bounds protocol overhead independently of payload bytes. Only a handful of
/// metadata fields and MIME types are valid in a real offer; hard limits keep
/// adversarial terminal replies from turning tiny payloads into large heaps.
const MAX_METADATA_FIELDS: usize = 32;
const MAX_PASSWORD_BYTES: usize = 4 * 1024;
const MAX_ENCODED_MIME_BYTES: usize = 256;
const MAX_ENCODED_MIME_LIST_BYTES: usize = 16 * 1024;
const MAX_READ_CHUNKS: usize = 64 * 1024;
/// Idle gap after which an unfinished conversation is considered abandoned
/// (a DONE lost to a truncated link) and resets before the next packet.
const READ_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PasteMime {
	Image(ImageFormat),
	Text,
}

impl PasteMime {
	fn parse(value: &str) -> Option<Self> {
		if value == "text/plain" {
			return Some(Self::Text);
		}
		IMAGE_PRIORITY
			.into_iter()
			.find(|format| format.media_type() == value)
			.map(Self::Image)
	}

	const fn as_str(self) -> &'static str {
		match self {
			Self::Image(format) => format.media_type(),
			Self::Text => "text/plain",
		}
	}
}

#[derive(Debug)]
enum PastePhase {
	Listing {
		mimes:     SmallVec<PasteMime, 5>,
		kitty_dot: bool,
		pw:        Option<Str>,
		loc:       Option<Str>,
	},
	Reading {
		mime:   PasteMime,
		chunks: SmallVec<Str, 4>,
		/// Aggregate encoded length across `chunks`.
		bytes:  usize,
	},
}

/// Sans-I/O OSC 5522 (kitty enhanced paste) read-offer state machine.
#[derive(Default, Debug)]
pub struct PasteEvents {
	phase:       Option<PastePhase>,
	last_packet: Option<Instant>,
}

/// One step of the OSC 5522 conversation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PasteProgress {
	/// The OSC body does not belong to protocol 5522.
	NotMine,
	/// The packet was handled without producing output.
	Consumed,
	/// The terminal must receive this protocol reply.
	Reply(String),
	/// A complete paste was decoded.
	Done(Pasted),
}

impl PasteEvents {
	/// Handles one unframed OSC body.
	pub fn handle_osc(&mut self, payload: &str) -> PasteProgress {
		self.handle_osc_at(payload, Instant::now())
	}

	fn handle_osc_at(&mut self, payload: &str, now: Instant) -> PasteProgress {
		let Some(body) = payload.strip_prefix("5522;") else {
			return PasteProgress::NotMine;
		};
		// A conversation whose peer went quiet (a DONE lost over a truncated
		// link) must not wedge enhanced paste forever: the OK acknowledging
		// our read request keeps `Reading` alive, so only staleness can
		// distinguish a fresh offer from that ack. Reset before processing
		// so the new packet starts clean.
		if self.phase.is_some()
			&& self
				.last_packet
				.is_some_and(|at| now.duration_since(at) >= READ_INACTIVITY_TIMEOUT)
		{
			self.reset();
		}
		self.last_packet = Some(now);
		let (metadata, data) = body.split_once(';').unwrap_or((body, ""));
		let metadata = parse_metadata(metadata);
		if metadata_value(&metadata, "type") != Some("read") {
			return PasteProgress::Consumed;
		}
		match metadata_value(&metadata, "status") {
			Some("OK") => {
				if !matches!(self.phase, Some(PastePhase::Reading { .. })) {
					let pw = metadata_value(&metadata, "pw");
					if pw.is_some_and(|value| {
						value.len() > MAX_PASSWORD_BYTES || !valid_metadata_token(value)
					}) {
						self.reset();
						return PasteProgress::Consumed;
					}
					self.phase = Some(PastePhase::Listing {
						mimes:     SmallVec::new(),
						kitty_dot: false,
						pw:        pw.map(Str::new),
						loc:       (metadata_value(&metadata, "loc") == Some("primary"))
							.then(|| sf!("primary")),
					});
				}
				PasteProgress::Consumed
			},
			Some("DATA") => {
				self.handle_data(&metadata, data);
				PasteProgress::Consumed
			},
			Some("DONE") => self.handle_done(),
			Some(_) => {
				self.reset();
				PasteProgress::Consumed
			},
			None => PasteProgress::Consumed,
		}
	}

	/// Clears any in-progress OSC 5522 conversation.
	pub fn reset(&mut self) {
		self.phase = None;
		self.last_packet = None;
	}

	fn handle_data(&mut self, metadata: &[(&str, &str)], payload: &str) {
		let Some(encoded_mime) = metadata_value(metadata, "mime") else {
			return;
		};
		let Some(mime) = decode_base64_text(encoded_mime, MAX_ENCODED_MIME_BYTES) else {
			self.reset();
			return;
		};
		let overflow = match self.phase.as_mut() {
			Some(PastePhase::Listing { mimes, kitty_dot, .. }) if mime == "." => {
				if payload.is_empty() {
					return;
				}
				let Some(listing) = decode_base64_text(payload, MAX_ENCODED_MIME_LIST_BYTES) else {
					self.reset();
					return;
				};
				*kitty_dot = true;
				for candidate in listing
					.split_ascii_whitespace()
					.filter_map(PasteMime::parse)
				{
					if !mimes.contains(&candidate) {
						mimes.push(candidate);
					}
				}
				false
			},
			Some(PastePhase::Listing { mimes, .. }) => {
				if let Some(mime) = PasteMime::parse(&mime)
					&& !mimes.contains(&mime)
				{
					mimes.push(mime);
				}
				false
			},
			Some(PastePhase::Reading { mime: selected, chunks, bytes })
				if selected.as_str() == mime && !payload.is_empty() =>
			{
				*bytes = bytes.saturating_add(payload.len());
				if *bytes > MAX_READ_PAYLOAD_BYTES || chunks.len() >= MAX_READ_CHUNKS {
					true
				} else {
					chunks.push(Str::new(payload));
					false
				}
			},
			_ => false,
		};
		// A transfer past the cap is dropped whole: a truncated image is
		// useless, and the reset lets the next offer proceed.
		if overflow {
			self.reset();
		}
	}

	fn handle_done(&mut self) -> PasteProgress {
		let Some(phase) = self.phase.take() else {
			return PasteProgress::Consumed;
		};
		match phase {
			PastePhase::Listing { mimes, kitty_dot, pw, loc } => {
				let Some(mime) = choose_mime(&mimes) else {
					return PasteProgress::Consumed;
				};
				let encoded = base64::encode(mime.as_str().as_bytes()).into_string();
				let mut reply = String::from("\x1b]5522;type=read");
				if let Some(loc) = loc {
					reply.push_str(":loc=");
					reply.push_str(&loc);
				}
				if let Some(pw) = pw {
					reply.push_str(":pw=");
					reply.push_str(&pw);
					reply.push_str(":name=");
					reply.push_str(PASTE_EVENT_NAME_BASE64);
				}
				reply.push_str(if kitty_dot { ";" } else { ":mime=" });
				reply.push_str(&encoded);
				reply.push('\x07');
				self.phase = Some(PastePhase::Reading { mime, chunks: SmallVec::new(), bytes: 0 });
				PasteProgress::Reply(reply)
			},
			PastePhase::Reading { mime, chunks, bytes: _ } => {
				// Each DATA packet is padded base64 in its own right, so the
				// chunks decode independently — concatenating the encoded
				// strings would corrupt at interior padding.
				let mut bytes = Vec::new();
				for chunk in &chunks {
					let Ok(decoded) = base64::decode(chunk.as_bytes()).into_vec() else {
						return PasteProgress::Consumed;
					};
					bytes.extend_from_slice(&decoded);
				}
				if bytes.is_empty() {
					return PasteProgress::Consumed;
				}
				if mime == PasteMime::Text {
					return PasteProgress::Done(Pasted::Text(Str::new(
						String::from_utf8_lossy(&bytes).as_ref(),
					)));
				}
				let PasteMime::Image(declared_format) = mime else {
					unreachable!("text paste returned above")
				};
				let image =
					PastedImage { format: imagefmt::format(&bytes).unwrap_or(declared_format), bytes };
				PasteProgress::Done(Pasted::Image(image))
			},
		}
	}
}

fn parse_metadata(raw: &str) -> SmallVec<(&str, &str), 6> {
	raw.split(':')
		.filter_map(|part| {
			let (key, value) = part.split_once('=')?;
			(!key.is_empty()).then_some((key, value))
		})
		.take(MAX_METADATA_FIELDS)
		.collect()
}

fn metadata_value<'a>(metadata: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
	metadata
		.iter()
		.rev()
		.find_map(|(candidate, value)| (*candidate == key).then_some(*value))
}

fn decode_base64_text(encoded: &str, max_encoded_bytes: usize) -> Option<String> {
	if encoded.len() > max_encoded_bytes {
		return None;
	}
	let bytes = base64::decode(encoded.as_bytes()).into_vec().ok()?;
	String::from_utf8(bytes).ok()
}

fn valid_metadata_token(value: &str) -> bool {
	value
		.bytes()
		.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_'))
}

fn choose_mime(mimes: &[PasteMime]) -> Option<PasteMime> {
	IMAGE_PRIORITY
		.into_iter()
		.map(PasteMime::Image)
		.chain([PasteMime::Text])
		.find(|candidate| mimes.contains(candidate))
}

/// Classifies a dropped string as one or more explicit local paths.
///
/// Every whitespace- or quote-delimited segment must be explicit. Ambiguous
/// bare relative text falls through unchanged instead of partially attaching.
pub fn dropped_paths(text: &str) -> SmallVec<Str, 2> {
	let trimmed = text.trim();
	if trimmed.is_empty() {
		return SmallVec::new();
	}
	if let Some(tokens) = split_path_tokens(trimmed) {
		let mut paths = SmallVec::new();
		let mut valid = true;
		for token in tokens {
			match normalize_path(&token) {
				Some(path) if is_explicit_path(&path) => paths.push(path),
				_ => {
					valid = false;
					break;
				},
			}
		}
		if valid && !paths.is_empty() {
			return paths;
		}
	}
	whole_text_attachment_path(trimmed)
		.into_iter()
		.collect::<SmallVec<Str, 2>>()
}

/// Previewable media kind inferred from a pasted path's extension.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PastedPathKind {
	/// A directly supported image container.
	Image,
	/// A video container accepted by the composer media path.
	Video,
}

/// Classifies a path as a previewable image or video attachment.
#[must_use]
pub fn classify_attachment_path(path: &str) -> Option<PastedPathKind> {
	if is_image_path(path) {
		Some(PastedPathKind::Image)
	} else if is_video_path(path) {
		Some(PastedPathKind::Video)
	} else {
		None
	}
}

/// Returns whether a path has a supported image extension.
#[must_use]
pub fn is_image_path(path: &str) -> bool {
	let Some((_, extension)) = path.rsplit_once('.') else {
		return false;
	};
	["png", "jpg", "jpeg", "gif", "webp"]
		.into_iter()
		.any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

/// Returns whether a path has a supported video-container extension.
#[must_use]
pub fn is_video_path(path: &str) -> bool {
	video_media_type(path).is_some()
}

/// Returns the media type for a supported video-container path.
#[must_use]
pub fn video_media_type(path: &str) -> Option<&'static str> {
	let (_, extension) = path.rsplit_once('.')?;
	if extension.eq_ignore_ascii_case("mp4") {
		Some("video/mp4")
	} else if extension.eq_ignore_ascii_case("mov") {
		Some("video/quicktime")
	} else if extension.eq_ignore_ascii_case("mkv") {
		Some("video/x-matroska")
	} else if extension.eq_ignore_ascii_case("webm") {
		Some("video/webm")
	} else if extension.eq_ignore_ascii_case("m4v") {
		Some("video/x-m4v")
	} else if extension.eq_ignore_ascii_case("avi") {
		Some("video/x-msvideo")
	} else if extension.eq_ignore_ascii_case("wmv") {
		Some("video/x-ms-wmv")
	} else {
		None
	}
}

fn split_path_tokens(text: &str) -> Option<Vec<Str>> {
	let mut tokens = Vec::new();
	let mut token = String::new();
	let mut quote = None;
	let mut escaped = false;
	for ch in text.chars() {
		if escaped {
			token.push(ch);
			escaped = false;
			continue;
		}
		if ch == '\\' && quote != Some('\'') {
			token.push(ch);
			escaped = true;
			continue;
		}
		if let Some(active) = quote {
			token.push(ch);
			if ch == active {
				quote = None;
			}
			continue;
		}
		if ch == '\'' || ch == '"' {
			token.push(ch);
			quote = Some(ch);
			continue;
		}
		if is_ascii_path_whitespace(ch) {
			if !token.is_empty() {
				tokens.push(Str::from(mem::take(&mut token)));
			}
			continue;
		}
		token.push(ch);
	}
	if escaped || quote.is_some() {
		return None;
	}
	if !token.is_empty() {
		tokens.push(Str::from(token));
	}
	(!tokens.is_empty()).then_some(tokens)
}

const fn is_ascii_path_whitespace(ch: char) -> bool {
	matches!(ch, ' ' | '\t' | '\r' | '\n')
}

fn normalize_path(raw: &str) -> Option<Str> {
	let trimmed = raw.trim();
	let unquoted = match (trimmed.chars().next(), trimmed.chars().last()) {
		(Some(first @ ('\'' | '"')), Some(last)) if first == last && trimmed.len() > 1 => {
			&trimmed[first.len_utf8()..trimmed.len() - last.len_utf8()]
		},
		_ => trimmed,
	};
	if unquoted
		.get(..7)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
	{
		return normalize_file_url(unquoted);
	}
	Some(shell_unescape(unquoted))
}

fn normalize_file_url(url: &str) -> Option<Str> {
	let rest = &url[7..];
	let path = if rest.starts_with('/') {
		rest
	} else {
		let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
		if !host.eq_ignore_ascii_case("localhost") {
			return None;
		}
		if path.is_empty() {
			"/"
		} else {
			return Some(percent_decode(&format!("/{path}")));
		}
	};
	Some(percent_decode(path))
}

fn percent_decode(text: &str) -> Str {
	let bytes = text.as_bytes();
	let mut output = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) =
				(hex::parse_nibble(bytes[index + 1]), hex::parse_nibble(bytes[index + 2]))
		{
			output.push((high << 4) | low);
			index += 3;
		} else {
			output.push(bytes[index]);
			index += 1;
		}
	}
	Str::from_utf8_lossy(&output)
}

fn shell_unescape(text: &str) -> Str {
	let (mut output, text) = if let Some(rest) = text.strip_prefix("\\\\") {
		(String::from("\\\\"), rest)
	} else {
		(String::with_capacity(text.len()), text)
	};
	let mut chars = text.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\\'
			&& let Some(&next) = chars.peek()
			&& (next.is_whitespace() || "\\'\"()[]{}&;<>|?*!$`".contains(next))
		{
			output.push(next);
			chars.next();
		} else {
			output.push(ch);
		}
	}
	Str::from(output)
}

fn is_explicit_path(path: &str) -> bool {
	if has_raw_anchor(path)
		|| path.starts_with("./")
		|| path.starts_with("../")
		|| path.starts_with(".\\")
		|| path.starts_with("..\\")
	{
		return true;
	}
	if has_uri_scheme(path) {
		return false;
	}
	path.contains('\\')
}

fn has_uri_scheme(path: &str) -> bool {
	let Some((scheme, _)) = path.split_once(':') else {
		return false;
	};
	!scheme.is_empty()
		&& scheme.as_bytes()[0].is_ascii_alphabetic()
		&& scheme
			.as_bytes()
			.iter()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

const fn is_windows_drive_path(path: &str) -> bool {
	let bytes = path.as_bytes();
	bytes.len() >= 3
		&& bytes[0].is_ascii_alphabetic()
		&& bytes[1] == b':'
		&& matches!(bytes[2], b'/' | b'\\')
}

fn whole_text_attachment_path(text: &str) -> Option<Str> {
	if text.contains('\r')
		|| text.contains('\n')
		|| !has_raw_anchor(text)
		|| classify_attachment_path(text).is_none()
		|| has_interior_anchor(text)
		|| has_complete_media_token_before_whitespace(text)
	{
		return None;
	}
	let path = normalize_path(text)?;
	(is_explicit_path(&path) && classify_attachment_path(&path).is_some()).then_some(path)
}

fn has_raw_anchor(path: &str) -> bool {
	path.starts_with('/')
		|| path.starts_with("~/")
		|| path
			.get(..7)
			.is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
		|| path.starts_with("\\\\")
		|| is_windows_drive_path(path)
}

fn has_complete_media_token_before_whitespace(text: &str) -> bool {
	let mut escaped = false;
	for (index, ch) in text.char_indices() {
		if ch == '\\' {
			escaped = !escaped;
			continue;
		}
		if is_ascii_path_whitespace(ch)
			&& !escaped
			&& classify_attachment_path(text[..index].trim_end()).is_some()
		{
			return true;
		}
		escaped = false;
	}
	false
}

fn has_interior_anchor(text: &str) -> bool {
	let mut escaped = false;
	let chars: Vec<char> = text.chars().collect();
	for index in 0..chars.len() {
		let ch = chars[index];
		if ch == '\\' {
			escaped = !escaped;
			continue;
		}
		if is_ascii_path_whitespace(ch) && !escaped {
			let suffix: String = chars[index + 1..].iter().collect();
			if has_raw_anchor(&suffix)
				|| suffix.starts_with("./")
				|| suffix.starts_with("../")
				|| suffix.starts_with(".\\")
				|| suffix.starts_with("..\\")
			{
				return true;
			}
		}
		escaped = false;
	}
	false
}

/// Smart clipboard content, preferring image data over paths and text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Clipboard {
	/// Plain clipboard text.
	Text(String),
	/// Encoded clipboard image.
	Image(PastedImage),
	/// Local paths copied by a file manager.
	Paths(Vec<Str>),
}

/// Typed result of reading the system clipboard.
///
/// Non-payload outcomes stay distinct through the background-reader and host
/// boundaries so presentation can explain the failure without guessing from
/// an absent value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClipboardReadOutcome {
	/// A supported clipboard payload.
	Payload(Clipboard),
	/// The clipboard contains no data.
	Empty,
	/// The operating system refused clipboard access.
	PermissionDenied,
	/// The clipboard contains data, but not in a supported representation.
	UnsupportedFormat,
	/// The backend could not complete the read.
	ReadFailure,
}

/// Typed result of writing the system clipboard.
///
/// Write outcomes remain distinct through detached host workers so the actor
/// can acknowledge a completed copy or explain why it did not land.
#[must_use]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClipboardWriteOutcome {
	/// A native or platform clipboard backend accepted the text.
	Success,
	/// The operating system refused clipboard access.
	PermissionDenied,
	/// No clipboard backend is available in this environment.
	Unavailable,
	/// An available backend failed to write the text.
	WriteFailure,
}

impl ClipboardWriteOutcome {
	const fn fallback(self, next: Self) -> Self {
		match (self, next) {
			(Self::Success, _) | (_, Self::Success) => Self::Success,
			(Self::PermissionDenied, _) | (_, Self::PermissionDenied) => Self::PermissionDenied,
			(Self::WriteFailure, _) | (_, Self::WriteFailure) => Self::WriteFailure,
			(Self::Unavailable, Self::Unavailable) => Self::Unavailable,
		}
	}
}

/// Reads smart clipboard content, preferring previewable file paths, then image
/// data, remaining file paths, and text.
///
/// macOS Finder `Cmd+C` on an image or video file advertises BOTH a
/// `public.file-url` representation and a generated file-icon bitmap, and
/// `arboard::get_image()` succeeds with the icon — so a file URL resolving to
/// previewable media wins over the co-advertised bitmap. Pure bitmap
/// pasteboards and non-media file URLs still fall through to the image path.
/// [`read_file_urls`] is a no-op off Darwin.
pub fn read_clipboard() -> ClipboardReadOutcome {
	smart_clipboard(read_file_urls(), read_clipboard_image, read_clipboard_text)
		.map_or_else(|| classify_clipboard_miss(ClipboardRead::Smart), ClipboardReadOutcome::Payload)
}

/// Pure ordering core of [`read_clipboard`], separated for tests.
fn smart_clipboard(
	file_urls: Option<Vec<Str>>,
	read_image: impl FnOnce() -> Option<PastedImage>,
	read_text: impl FnOnce() -> Option<String>,
) -> Option<Clipboard> {
	let file_urls = match file_urls {
		Some(paths) => {
			// The authoritative media file bytes beat Finder's co-advertised
			// icon bitmap. Mixed Finder selections attach only previewable
			// media, preserving their source order.
			let previewable = paths
				.iter()
				.filter(|path| classify_attachment_path(path).is_some())
				.cloned()
				.collect::<Vec<_>>();
			if !previewable.is_empty() {
				return Some(Clipboard::Paths(previewable));
			}
			Some(paths)
		},
		None => None,
	};
	if let Some(image) = read_image() {
		return Some(Clipboard::Image(image));
	}
	if let Some(paths) = file_urls {
		return Some(Clipboard::Paths(paths));
	}
	let text = read_text()?;
	(!text.is_empty()).then_some(Clipboard::Text(text))
}

/// Scope of one background clipboard read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClipboardRead {
	/// Smart content: copied file paths, then image, then text
	/// ([`read_clipboard`]).
	Smart,
	/// Plain text only ([`read_clipboard_text`]) — the Ctrl+Shift+V
	/// verbatim-insert contract, no image or file-URL interpretation.
	Text,
}

impl ClipboardRead {
	/// The read a paste chord requests: [`Key::Paste`] smart,
	/// [`Key::PasteRaw`] text-only, anything else none.
	pub const fn for_key(key: Key) -> Option<Self> {
		match key {
			Key::Paste => Some(Self::Smart),
			Key::PasteRaw => Some(Self::Text),
			_ => None,
		}
	}

	/// Runs the blocking read this scope selects.
	fn read(self) -> ClipboardReadOutcome {
		match self {
			Self::Smart => read_clipboard(),
			Self::Text => read_clipboard_text()
				.filter(|text| !text.is_empty())
				.map_or_else(
					|| classify_clipboard_miss(Self::Text),
					|text| ClipboardReadOutcome::Payload(Clipboard::Text(text)),
				),
		}
	}
}

/// Starts one background clipboard read on a detached thread, delivering
/// the typed result through the returned one-shot channel.
///
/// A channel closed without a value means the reader thread could not be
/// spawned. Callers map that transport failure to
/// [`ClipboardReadOutcome::ReadFailure`] rather than pretending the
/// clipboard was empty.
///
/// The reader is deliberately a detached thread, not a tokio blocking
/// task: a running blocking task cannot be aborted and would stall
/// runtime shutdown behind a wedged native clipboard, while a detached
/// thread dies with the process. Backend subprocesses cap themselves at
/// 5–8 s, but a hung *native* handle can outlive that — pair the receiver
/// with a deadline and drop it to abandon the read.
pub fn spawn_clipboard_read(scope: ClipboardRead) -> Receiver<ClipboardReadOutcome> {
	let (tx, rx) = oneshot::channel();
	// A spawn error drops `tx`, closing the channel: the failure is
	// observable immediately instead of after the caller's deadline.
	let _ = thread::Builder::new()
		.name("omp-tui-clipboard-read".into())
		.spawn(move || {
			let _ = tx.send(scope.read());
		});
	rx
}

/// Reads raw clipboard text.
///
/// Platform CLI bridges run first — they match what the OS itself would
/// paste (`pbpaste`, PowerShell's `Get-Clipboard -Raw`, `wl-paste`) — with
/// the native arboard backend as the fallback when no bridge is installed.
pub fn read_clipboard_text() -> Option<String> {
	if cfg!(target_os = "macos") {
		return capture_text(&["pbpaste"], CLI_TIMEOUT).or_else(native_read_text);
	}
	if cfg!(windows) {
		// PowerShell over arboard: `Get-Clipboard -Raw` survives console
		// codepages that mangled the legacy shell-out path.
		return read_powershell_text().or_else(native_read_text);
	}
	if env::var_os("TERMUX_VERSION").is_some() {
		return capture_text(&["termux-clipboard-get"], CLI_TIMEOUT);
	}
	if is_wsl()
		&& let Some(text) = read_powershell_text()
	{
		return Some(text);
	}
	if env::var_os("WAYLAND_DISPLAY").is_some()
		&& let Some(text) =
			capture_text(&["wl-paste", "--type", "text/plain", "--no-newline"], CLI_TIMEOUT)
	{
		return Some(text);
	}
	if env::var_os("WAYLAND_DISPLAY").is_some() || env::var_os("DISPLAY").is_some() {
		return read_x11_text().or_else(native_read_text);
	}
	None
}

/// Writes clipboard text, native backend first with platform CLI bridges as
/// fallback.
pub fn write_clipboard_text(text: &str) -> ClipboardWriteOutcome {
	let bytes = Some(text.as_bytes());
	let mut outcome = ClipboardWriteOutcome::Unavailable;
	if env::var_os("TERMUX_VERSION").is_some() {
		outcome = outcome.fallback(write_capture(&["termux-clipboard-set"], bytes));
		if outcome == ClipboardWriteOutcome::Success {
			return outcome;
		}
	}
	outcome = outcome.fallback(native_write_text(text));
	if outcome == ClipboardWriteOutcome::Success {
		return outcome;
	}
	if cfg!(target_os = "macos") {
		return outcome.fallback(write_capture(&["pbcopy"], bytes));
	}
	if cfg!(windows) {
		return outcome.fallback(write_capture(&["clip.exe"], bytes));
	}
	if env::var_os("WAYLAND_DISPLAY").is_some() {
		outcome = outcome.fallback(write_capture(&["wl-copy"], bytes));
		if outcome == ClipboardWriteOutcome::Success {
			return outcome;
		}
	}
	if env::var_os("DISPLAY").is_some() {
		outcome = outcome.fallback(write_capture(&["xclip", "-selection", "clipboard", "-i"], bytes));
		if outcome != ClipboardWriteOutcome::Success {
			outcome = outcome.fallback(write_capture(&["xsel", "--clipboard", "--input"], bytes));
		}
	}
	outcome
}

/// Starts one background clipboard write, delivering its typed outcome through
/// the returned one-shot channel.
///
/// A channel closed without a value means the writer thread could not be
/// spawned; callers classify that transport failure as
/// [`ClipboardWriteOutcome::WriteFailure`].
pub fn spawn_clipboard_write(text: Str) -> Receiver<ClipboardWriteOutcome> {
	let (tx, rx) = oneshot::channel();
	let _ = thread::Builder::new()
		.name("omp-tui-clipboard-write".into())
		.spawn(move || {
			let _ = tx.send(write_clipboard_text(&text));
		});
	rx
}

fn read_clipboard_image() -> Option<PastedImage> {
	if env::var_os("TERMUX_VERSION").is_some() {
		return None;
	}
	if is_wsl()
		&& let Some(image) = read_powershell_image()
	{
		return Some(image);
	}
	if cfg!(windows) {
		// arboard rejects the CF_DIBV5 payloads Qt-based screenshot tools
		// (PixPin, Snipaste, ...) put up; PowerShell's
		// `[Clipboard]::GetImage()` reads them fine, so it backs the native
		// path instead of a hand-rolled DIB decoder.
		return native_read_image().or_else(read_powershell_image);
	}
	if cfg!(target_os = "macos") {
		// arboard transcodes whatever representation the pasteboard holds
		// (TIFF included) to RGBA, reaching payloads an AppleScript
		// `«class PNGf»` coercion would miss.
		return native_read_image();
	}
	if env::var_os("WAYLAND_DISPLAY").is_some()
		&& let Some(image) = read_wayland_image()
	{
		// wl-paste first: it hands over the original container bytes
		// (PNG/JPEG/WebP/GIF) without an RGBA round-trip.
		return Some(image);
	}
	if env::var_os("WAYLAND_DISPLAY").is_some() || env::var_os("DISPLAY").is_some() {
		return native_read_image().or_else(read_x11_image);
	}
	None
}

/// Reads an image through arboard, re-encoding the RGBA payload as PNG.
fn native_read_image() -> Option<PastedImage> {
	let mut clipboard = arboard::Clipboard::new().ok()?;
	let image = clipboard.get_image().ok()?;
	encode_rgba_png(&image)
}

/// Reads clipboard text through arboard.
fn native_read_text() -> Option<String> {
	arboard::Clipboard::new().ok()?.get_text().ok()
}

/// Classifies a supported-payload miss without collapsing absence, access
/// refusal, backend failure, and an incompatible representation.
fn classify_clipboard_miss(scope: ClipboardRead) -> ClipboardReadOutcome {
	let probe = if cfg!(target_os = "macos") {
		probe_clipboard_command(&["osascript", "-e", "clipboard info"], scope)
	} else if cfg!(windows) {
		probe_clipboard_command(
			&[
				"powershell.exe",
				"-NoProfile",
				"-NonInteractive",
				"-Sta",
				"-Command",
				POWERSHELL_CLIPBOARD_STATE_SCRIPT,
			],
			scope,
		)
	} else if env::var_os("TERMUX_VERSION").is_some() {
		probe_clipboard_command(&["termux-clipboard-get"], scope)
	} else if is_wsl() {
		probe_clipboard_command(
			&[
				"powershell.exe",
				"-NoProfile",
				"-NonInteractive",
				"-Sta",
				"-Command",
				POWERSHELL_CLIPBOARD_STATE_SCRIPT,
			],
			scope,
		)
	} else if env::var_os("WAYLAND_DISPLAY").is_some() {
		probe_clipboard_command(&["wl-paste", "--list-types"], scope)
	} else if env::var_os("DISPLAY").is_some() {
		probe_clipboard_command(&["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], scope)
	} else {
		None
	};
	probe.unwrap_or_else(probe_native_clipboard)
}

fn probe_clipboard_command(argv: &[&str], scope: ClipboardRead) -> Option<ClipboardReadOutcome> {
	Some(match run_capture_outcome(argv, None, CLI_TIMEOUT) {
		CaptureOutcome::Output(bytes) => {
			let output = String::from_utf8_lossy(&bytes);
			let trimmed = output.trim();
			if trimmed.is_empty() || trimmed == "{}" || trimmed.eq_ignore_ascii_case("EMPTY") {
				ClipboardReadOutcome::Empty
			} else if advertised_format_is_supported(trimmed, scope) {
				// The backend advertised something this read supports, yet
				// the payload path failed to materialize it.
				ClipboardReadOutcome::ReadFailure
			} else {
				ClipboardReadOutcome::UnsupportedFormat
			}
		},
		CaptureOutcome::Empty => ClipboardReadOutcome::Empty,
		CaptureOutcome::PermissionDenied => ClipboardReadOutcome::PermissionDenied,
		CaptureOutcome::Unavailable => return None,
		CaptureOutcome::Failed => ClipboardReadOutcome::ReadFailure,
	})
}

fn advertised_format_is_supported(advertised: &str, scope: ClipboardRead) -> bool {
	let advertised = advertised.to_ascii_lowercase();
	let text = ["text", "utf8", "unicode", "string"]
		.iter()
		.any(|needle| advertised.contains(needle));
	text
		|| scope == ClipboardRead::Smart
			&& [
				"image/",
				"bitmap",
				"png",
				"jpeg",
				"gif",
				"webp",
				"file-url",
				"filedrop",
				"public.file",
			]
			.iter()
			.any(|needle| advertised.contains(needle))
}

fn probe_native_clipboard() -> ClipboardReadOutcome {
	let mut clipboard = match arboard::Clipboard::new() {
		Ok(clipboard) => clipboard,
		Err(error) => return classify_arboard_error(&error),
	};
	match clipboard.get_text() {
		Ok(text) if text.is_empty() => return ClipboardReadOutcome::Empty,
		Ok(_) => return ClipboardReadOutcome::ReadFailure,
		Err(arboard::Error::ContentNotAvailable) => {},
		Err(error) => return classify_arboard_error(&error),
	}
	match clipboard.get_image() {
		Ok(_) => ClipboardReadOutcome::ReadFailure,
		Err(arboard::Error::ContentNotAvailable) => ClipboardReadOutcome::UnsupportedFormat,
		Err(error) => classify_arboard_error(&error),
	}
}

fn classify_arboard_error(error: &arboard::Error) -> ClipboardReadOutcome {
	match error {
		arboard::Error::ConversionFailure => ClipboardReadOutcome::UnsupportedFormat,
		arboard::Error::Unknown { description } if is_permission_diagnostic(description) => {
			ClipboardReadOutcome::PermissionDenied
		},
		arboard::Error::ContentNotAvailable => ClipboardReadOutcome::UnsupportedFormat,
		_ => ClipboardReadOutcome::ReadFailure,
	}
}

fn is_permission_diagnostic(message: &str) -> bool {
	let message = message.to_ascii_lowercase();
	[
		"permission denied",
		"operation not permitted",
		"access is denied",
		"not authorized",
		"not allowed",
	]
	.iter()
	.any(|needle| message.contains(needle))
}

fn is_empty_diagnostic(message: &str) -> bool {
	let message = message.to_ascii_lowercase();
	[
		"clipboard is empty",
		"no selection",
		"content not available",
		"target does not exist",
		"target not available",
	]
	.iter()
	.any(|needle| message.contains(needle))
}

/// Writes text through arboard, keeping the Linux handle alive.
///
/// X11 and Wayland selections are owner-based: the writing process must stay
/// alive to answer `SelectionRequest`s, and arboard serves them from a
/// background thread that lives only as long as some `Clipboard` instance
/// does — a transient handle would empty the selection the moment it drops.
/// One process-lifetime instance keeps that owner thread serving.
#[cfg(target_os = "linux")]
fn native_write_text(text: &str) -> ClipboardWriteOutcome {
	use std::sync::LazyLock;

	use parking_lot::Mutex;

	static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> =
		LazyLock::new(|| Mutex::new(None));
	let mut guard = CLIPBOARD.lock();
	if guard.is_none() {
		match arboard::Clipboard::new() {
			Ok(clipboard) => *guard = Some(clipboard),
			Err(error) => return classify_arboard_write_error(&error),
		}
	}
	guard
		.as_mut()
		.map_or(ClipboardWriteOutcome::Unavailable, |clipboard| {
			clipboard.set_text(text).map_or_else(
				|error| classify_arboard_write_error(&error),
				|()| ClipboardWriteOutcome::Success,
			)
		})
}

/// Writes text through a transient arboard handle.
///
/// macOS and Windows retain clipboard contents after the writer exits, so
/// no owner handle needs to outlive the call.
#[cfg(not(target_os = "linux"))]
fn native_write_text(text: &str) -> ClipboardWriteOutcome {
	let mut clipboard = match arboard::Clipboard::new() {
		Ok(clipboard) => clipboard,
		Err(error) => return classify_arboard_write_error(&error),
	};
	clipboard.set_text(text).map_or_else(
		|error| classify_arboard_write_error(&error),
		|()| ClipboardWriteOutcome::Success,
	)
}

fn classify_arboard_write_error(error: &arboard::Error) -> ClipboardWriteOutcome {
	match error {
		arboard::Error::Unknown { description } if is_permission_diagnostic(description) => {
			ClipboardWriteOutcome::PermissionDenied
		},
		arboard::Error::Unknown { description } if is_unavailable_diagnostic(description) => {
			ClipboardWriteOutcome::Unavailable
		},
		_ => ClipboardWriteOutcome::WriteFailure,
	}
}

fn is_unavailable_diagnostic(message: &str) -> bool {
	let message = message.to_ascii_lowercase();
	[
		"no display",
		"display not set",
		"couldn't connect to display",
		"could not connect to display",
		"wayland connection",
		"x11 connection",
	]
	.iter()
	.any(|needle| message.contains(needle))
}

/// Encodes an arboard RGBA payload as a PNG [`PastedImage`].
fn encode_rgba_png(image: &arboard::ImageData<'_>) -> Option<PastedImage> {
	let width = u32::try_from(image.width).ok()?;
	let height = u32::try_from(image.height).ok()?;
	let expected = image.width.checked_mul(image.height)?.checked_mul(4)?;
	if image.bytes.len() != expected {
		return None;
	}
	let mut bytes = Vec::new();
	let mut encoder = png::Encoder::new(&mut bytes, width, height);
	encoder.set_color(png::ColorType::Rgba);
	encoder.set_depth(png::BitDepth::Eight);
	let mut writer = encoder.write_header().ok()?;
	writer.write_image_data(&image.bytes).ok()?;
	writer.finish().ok()?;
	Some(PastedImage { bytes, format: ImageFormat::Png })
}

fn read_wayland_image() -> Option<PastedImage> {
	let offered = capture_text(&["wl-paste", "--list-types"], CLI_TIMEOUT)?;
	for declared_format in IMAGE_PRIORITY {
		let mime = declared_format.media_type();
		if !offered.lines().any(|line| line.trim() == mime) {
			continue;
		}
		let bytes = run_capture(&["wl-paste", "--type", mime], None, CLI_TIMEOUT)?;
		if !bytes.is_empty() {
			let format = imagefmt::format(&bytes).unwrap_or(declared_format);
			return Some(PastedImage { bytes, format });
		}
	}
	None
}

fn read_x11_image() -> Option<PastedImage> {
	let targets =
		capture_text(&["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], CLI_TIMEOUT)?;
	if !targets
		.split_ascii_whitespace()
		.any(|target| target == "image/png")
	{
		return None;
	}
	let bytes = run_capture(
		&["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
		None,
		CLI_TIMEOUT,
	)?;
	PastedImage::from_bytes(bytes)
}

fn read_x11_text() -> Option<String> {
	capture_text(&["xclip", "-selection", "clipboard", "-o"], CLI_TIMEOUT)
		.or_else(|| capture_text(&["xsel", "--clipboard", "--output"], CLI_TIMEOUT))
}

fn read_powershell_image() -> Option<PastedImage> {
	let output = run_capture(
		&[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Sta",
			"-Command",
			POWERSHELL_IMAGE_SCRIPT,
		],
		None,
		POWERSHELL_TIMEOUT,
	)?;
	let encoded = str::from_utf8(&output).ok()?.trim();
	if encoded.is_empty() {
		return None;
	}
	let bytes = base64::decode(encoded.as_bytes()).into_vec().ok()?;
	PastedImage::from_bytes(bytes)
}

fn read_powershell_text() -> Option<String> {
	let output = run_capture(
		&["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_TEXT_SCRIPT],
		None,
		POWERSHELL_TIMEOUT,
	)?;
	Some(String::from_utf8_lossy(&output).replace("\r\n", "\n"))
}

fn capture_text(argv: &[&str], timeout: Duration) -> Option<String> {
	run_capture(argv, None, timeout).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug)]
enum CaptureOutcome {
	Output(Vec<u8>),
	Empty,
	PermissionDenied,
	Unavailable,
	Failed,
}

fn run_capture(argv: &[&str], stdin: Option<&[u8]>, timeout: Duration) -> Option<Vec<u8>> {
	match run_capture_outcome(argv, stdin, timeout) {
		CaptureOutcome::Output(output) => Some(output),
		_ => None,
	}
}

fn write_capture(argv: &[&str], stdin: Option<&[u8]>) -> ClipboardWriteOutcome {
	match run_capture_outcome(argv, stdin, CLI_TIMEOUT) {
		CaptureOutcome::Output(_) => ClipboardWriteOutcome::Success,
		CaptureOutcome::PermissionDenied => ClipboardWriteOutcome::PermissionDenied,
		CaptureOutcome::Unavailable => ClipboardWriteOutcome::Unavailable,
		CaptureOutcome::Empty | CaptureOutcome::Failed => ClipboardWriteOutcome::WriteFailure,
	}
}

fn run_capture_outcome(argv: &[&str], stdin: Option<&[u8]>, timeout: Duration) -> CaptureOutcome {
	let Some((program, args)) = argv.split_first() else {
		return CaptureOutcome::Failed;
	};
	let mut command = Command::new(program);
	command
		.args(args)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.stdin(if stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		});
	let mut child = match command.spawn() {
		Ok(child) => child,
		Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
			return CaptureOutcome::PermissionDenied;
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return CaptureOutcome::Unavailable;
		},
		Err(_) => return CaptureOutcome::Failed,
	};
	let Some(mut stdout) = child.stdout.take() else {
		return CaptureOutcome::Failed;
	};
	let Some(mut stderr) = child.stderr.take() else {
		return CaptureOutcome::Failed;
	};
	let output_reader = thread::spawn(move || {
		let mut output = Vec::new();
		stdout.read_to_end(&mut output).ok().map(|_| output)
	});
	let error_reader = thread::spawn(move || {
		let mut output = String::new();
		stderr.read_to_string(&mut output).ok().map(|_| output)
	});
	let writer = stdin.map(|input| {
		let input = input.to_vec();
		let mut child_stdin = child.stdin.take().expect("piped stdin was requested");
		thread::spawn(move || child_stdin.write_all(&input).ok())
	});
	let deadline = Instant::now() + timeout;
	let (status, timed_out) = loop {
		match child.try_wait() {
			Ok(Some(status)) => break (Some(status), false),
			Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
			Ok(None) => {
				let _ = child.kill();
				break (child.wait().ok(), true);
			},
			Err(_) => break (None, false),
		}
	};
	if let Some(writer) = writer {
		let _ = writer.join();
	}
	let output = output_reader.join().ok().flatten();
	let diagnostic = error_reader.join().ok().flatten().unwrap_or_default();
	if timed_out || status.is_none() || output.is_none() {
		return CaptureOutcome::Failed;
	}
	if status.is_some_and(|status| status.success()) {
		return CaptureOutcome::Output(output.expect("checked as present"));
	}
	if is_permission_diagnostic(&diagnostic) {
		CaptureOutcome::PermissionDenied
	} else if is_empty_diagnostic(&diagnostic) {
		CaptureOutcome::Empty
	} else {
		CaptureOutcome::Failed
	}
}

fn is_wsl() -> bool {
	cfg!(target_os = "linux")
		&& (env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some())
}

fn read_file_urls() -> Option<Vec<Str>> {
	if !cfg!(target_os = "macos") {
		return None;
	}
	let output =
		run_capture(&["osascript", "-"], Some(MAC_FILE_URL_SCRIPT.as_bytes()), CLI_TIMEOUT)?;
	let output = String::from_utf8_lossy(&output);
	let paths: Vec<_> = output
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.map(Str::new)
		.collect();
	(!paths.is_empty()).then_some(paths)
}

// Returns POSIX paths for the pasteboard's `public.file-url` representation.
// The `«class furl»` guard exists because AppleScript coerces plain text
// through HFS paths and mangles URLs.
const MAC_FILE_URL_SCRIPT: &str = r#"on run
	set output to ""
	try
		if (clipboard info for «class furl») is {} then return output
		set theClip to the clipboard as «class furl»
		if class of theClip is list then
			repeat with anItem in theClip
				try
					set output to output & POSIX path of anItem & linefeed
				end try
			end repeat
		else
			try
				set output to POSIX path of theClip & linefeed
			end try
		end if
	end try
	return output
end run
"#;

const POWERSHELL_CLIPBOARD_STATE_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if (($null -eq $data) -or ($data.GetFormats().Count -eq 0)) {
	[Console]::Out.Write('EMPTY')
} else {
	[Console]::Out.Write(($data.GetFormats() -join [Environment]::NewLine))
}
";

const POWERSHELL_IMAGE_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
	$ms = New-Object System.IO.MemoryStream
	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
	[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
}
";

const POWERSHELL_TEXT_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([string](Get-Clipboard -Raw))
";

#[cfg(test)]
mod tests {
	use super::*;

	fn b64(text: &str) -> String {
		base64::encode(text.as_bytes()).into_string()
	}

	#[test]
	fn clipboard_write_fallback_retains_the_most_actionable_outcome() {
		use ClipboardWriteOutcome::{PermissionDenied, Success, Unavailable, WriteFailure};

		assert_eq!(Unavailable.fallback(Unavailable), Unavailable);
		assert_eq!(Unavailable.fallback(WriteFailure), WriteFailure);
		assert_eq!(WriteFailure.fallback(PermissionDenied), PermissionDenied);
		assert_eq!(PermissionDenied.fallback(Success), Success);
		assert_eq!(Success.fallback(WriteFailure), Success);
	}

	fn offer(events: &mut PasteEvents, mime: &str) {
		assert_eq!(
			events.handle_osc(&format!("5522;type=read:status=DATA:mime={}", b64(mime))),
			PasteProgress::Consumed
		);
	}

	/// Drives one complete text conversation and returns the final step.
	fn complete_text_read(events: &mut PasteEvents, text: &str) -> PasteProgress {
		events.handle_osc("5522;type=read:status=OK");
		offer(events, "text/plain");
		events.handle_osc("5522;type=read:status=DONE");
		events.handle_osc(&format!(
			"5522;type=read:status=DATA:mime={};{}",
			b64("text/plain"),
			b64(text)
		));
		events.handle_osc("5522;type=read:status=DONE")
	}

	#[test]
	fn stale_reading_state_resets_so_the_next_offer_is_not_wedged() {
		let mut events = PasteEvents::default();
		let start = Instant::now();
		// Offer completes its listing and we request the payload …
		events.handle_osc_at("5522;type=read:status=OK", start);
		events
			.handle_osc_at(&format!("5522;type=read:status=DATA:mime={}", b64("text/plain")), start);
		assert!(matches!(
			events.handle_osc_at("5522;type=read:status=DONE", start),
			PasteProgress::Reply(_)
		));
		// … but the final DONE never arrives. Without staleness recovery the
		// `Reading` phase would swallow every future OK forever.
		let later = start + READ_INACTIVITY_TIMEOUT;
		events.handle_osc_at("5522;type=read:status=OK", later);
		events
			.handle_osc_at(&format!("5522;type=read:status=DATA:mime={}", b64("text/plain")), later);
		assert!(
			matches!(
				events.handle_osc_at("5522;type=read:status=DONE", later),
				PasteProgress::Reply(_)
			),
			"the fresh offer lists and requests again"
		);
		events.handle_osc_at(
			&format!("5522;type=read:status=DATA:mime={};{}", b64("text/plain"), b64("back")),
			later,
		);
		assert_eq!(
			events.handle_osc_at("5522;type=read:status=DONE", later),
			PasteProgress::Done(Pasted::Text(sf!("back")))
		);
	}

	#[test]
	fn oversized_transfer_is_dropped_and_the_machine_recovers() {
		let mut events = PasteEvents::default();
		events.handle_osc("5522;type=read:status=OK");
		offer(&mut events, "text/plain");
		events.handle_osc("5522;type=read:status=DONE");
		let huge = "Q".repeat(MAX_READ_PAYLOAD_BYTES + 1);
		events.handle_osc(&format!("5522;type=read:status=DATA:mime={};{huge}", b64("text/plain")));
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Consumed,
			"a transfer past the cap is dropped whole"
		);
		assert_eq!(
			complete_text_read(&mut events, "next"),
			PasteProgress::Done(Pasted::Text(sf!("next")))
		);
	}

	#[test]
	fn spec_listing_selects_png_and_reads_matching_chunks() {
		let mut events = PasteEvents::default();
		assert_eq!(events.handle_osc("5522;type=read:status=OK"), PasteProgress::Consumed);
		offer(&mut events, "text/plain");
		offer(&mut events, "image/png");
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Reply(format!("\x1b]5522;type=read:mime={}\x07", b64("image/png")))
		);
		let png = b"\x89PNG\r\n\x1a\nrest";
		let encoded = base64::encode(png).into_string();
		let split = encoded.len() / 2;
		let wrong =
			format!("5522;type=read:status=DATA:mime={};{}", b64("image/jpeg"), b64("ignored"));
		events.handle_osc(&wrong);
		for chunk in [&encoded[..split], &encoded[split..]] {
			events
				.handle_osc(&format!("5522;type=read:status=DATA:mime={};{chunk}", b64("image/png")));
		}
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Done(Pasted::Image(PastedImage {
				bytes:  png.to_vec(),
				format: ImageFormat::Png,
			}))
		);
	}

	#[test]
	fn kitty_dot_listing_preserves_offer_metadata() {
		let mut events = PasteEvents::default();
		events.handle_osc("5522;type=read:status=OK:pw=secret:loc=primary");
		events.handle_osc(&format!(
			"5522;type=read:status=DATA:mime={};{}",
			b64("."),
			b64("text/plain image/gif")
		));
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Reply(format!(
				"\x1b]5522;type=read:loc=primary:pw=secret:name={};{}\x07",
				PASTE_EVENT_NAME_BASE64,
				b64("image/gif")
			))
		);
	}

	#[test]
	fn text_and_empty_reads_complete_as_expected() {
		let mut events = PasteEvents::default();
		events.handle_osc("5522;type=read:status=OK");
		offer(&mut events, "text/plain");
		events.handle_osc("5522;type=read:status=DONE");
		events.handle_osc(&format!(
			"5522;type=read:status=DATA:mime={};{}",
			b64("text/plain"),
			b64("hello")
		));
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Done(Pasted::Text(sf!("hello")))
		);

		events.handle_osc("5522;type=read:status=OK");
		offer(&mut events, "text/plain");
		events.handle_osc("5522;type=read:status=DONE");
		assert_eq!(events.handle_osc("5522;type=read:status=DONE"), PasteProgress::Consumed);
	}

	#[test]
	fn padded_chunks_decode_independently() {
		// Terminals pad every DATA packet's base64 in its own right:
		// b64("a") + b64("b") carries interior `==` padding that a
		// concatenated-string decode would reject or truncate at.
		let mut events = PasteEvents::default();
		events.handle_osc("5522;type=read:status=OK");
		offer(&mut events, "text/plain");
		events.handle_osc("5522;type=read:status=DONE");
		let mime = b64("text/plain");
		assert_eq!(b64("a"), "YQ==");
		for chunk in ["YQ==", "Yg=="] {
			events.handle_osc(&format!("5522;type=read:status=DATA:mime={mime};{chunk}"));
		}
		assert_eq!(
			events.handle_osc("5522;type=read:status=DONE"),
			PasteProgress::Done(Pasted::Text(sf!("ab")))
		);
	}

	#[test]
	fn errors_reset_and_unrelated_osc_is_not_mine() {
		let mut events = PasteEvents::default();
		events.handle_osc("5522;type=read:status=OK");
		offer(&mut events, "text/plain");
		events.handle_osc("5522;type=read:status=ERROR");
		assert_eq!(events.handle_osc("5522;type=read:status=DONE"), PasteProgress::Consumed);
		assert_eq!(events.handle_osc("52;c;abc"), PasteProgress::NotMine);
	}

	#[test]
	fn classifies_explicit_dropped_paths_without_reordering() {
		let cases: &[(&str, &[&str])] = &[
			("/tmp/a.png", &["/tmp/a.png"]),
			("./images/a.png", &["./images/a.png"]),
			("../images/a.png", &["../images/a.png"]),
			("'.\\images\\a.png'", &[".\\images\\a.png"]),
			("'/tmp/a b.png'", &["/tmp/a b.png"]),
			("\"/tmp/a b.png\"", &["/tmp/a b.png"]),
			("/tmp/a\\ b.png", &["/tmp/a b.png"]),
			("file:///tmp/a%20b.png", &["/tmp/a b.png"]),
			("file://localhost/tmp/a.png", &["/tmp/a.png"]),
			("'/tmp/a b.png' /tmp/c.gif", &["/tmp/a b.png", "/tmp/c.gif"]),
			("C:\\Users\\me\\a.png", &["C:\\Users\\me\\a.png"]),
			("\\\\server\\share\\a.png", &["\\\\server\\share\\a.png"]),
			("/tmp/first.png C:\\Users\\me\\second.mov \\\\srv\\share\\third.webp", &[
				"/tmp/first.png",
				"C:\\Users\\me\\second.mov",
				"\\\\srv\\share\\third.webp",
			]),
		];
		for (text, expected) in cases {
			assert_eq!(dropped_paths(text).as_slice(), *expected, "{text:?}");
		}
	}

	#[test]
	fn whole_text_fallback_recovers_one_anchored_spaced_media_path() {
		for (text, expected) in [
			(
				"/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45\u{202f}PM.png",
				"/Users/me/Desktop/Screenshot 2026-06-25 at 1.23.45\u{202f}PM.png",
			),
			(
				"C:\\Users\\me\\My Pictures\\launch cut.MOV",
				"C:\\Users\\me\\My Pictures\\launch cut.MOV",
			),
			(
				"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
				"~/Pictures/Cleanshot 2026-06-25 at 12.00.png",
			),
			("/tmp/odd dir\\ /sub/a b.png", "/tmp/odd dir /sub/a b.png"),
		] {
			assert_eq!(dropped_paths(text).as_slice(), [expected], "{text:?}");
		}
	}

	#[test]
	fn rejects_non_paths_and_ambiguous_paths() {
		for text in [
			"plain prose",
			"icon.png",
			"api/file/icon/867d45144217eec6d3c5805fd5a2d548.png",
			"/tmp/a.png relative.png",
			"http://example.com/a.png",
			"file://example.com/a.png",
			"/tmp/a.png /tmp/b shot.png",
			"/tmp/a.png\n/tmp/b shot.png",
			"/tmp/a.png ./b shot.png",
			"C:\\Users\\me\\a.png .\\b shot.png",
			"\\\\srv\\share\\a.png \\\\srv\\share\\b shot.png",
		] {
			assert!(dropped_paths(text).is_empty(), "accepted {text:?}");
		}
	}

	#[test]
	fn preserves_explicit_home_path_for_the_consumer_to_resolve() {
		assert_eq!(dropped_paths("~/image.png").as_slice(), ["~/image.png"]);
	}

	#[test]
	fn classifies_previewable_image_and_video_extensions() {
		for path in ["a.PNG", "a.jpg", "a.JPEG", "a.Gif", "a.webp"] {
			assert_eq!(classify_attachment_path(path), Some(PastedPathKind::Image));
		}
		for (path, mime) in [
			("a.mp4", "video/mp4"),
			("a.MOV", "video/quicktime"),
			("a.mkv", "video/x-matroska"),
			("a.webm", "video/webm"),
			("a.m4v", "video/x-m4v"),
			("a.avi", "video/x-msvideo"),
			("a.wmv", "video/x-ms-wmv"),
		] {
			assert_eq!(classify_attachment_path(path), Some(PastedPathKind::Video));
			assert_eq!(video_media_type(path), Some(mime));
		}
		for path in ["a.bmp", "a.ppm", "png", "a.png.txt", "a.mp4.txt"] {
			assert_eq!(classify_attachment_path(path), None);
		}
	}

	#[test]
	fn image_extensions_are_exact_and_case_insensitive() {
		for path in ["a.PNG", "a.jpg", "a.JPEG", "a.Gif", "a.webp"] {
			assert!(is_image_path(path));
		}
		for path in ["a.bmp", "a.ppm", "png", "a.png.txt"] {
			assert!(!is_image_path(path));
		}
	}

	#[test]
	fn pasted_image_sniffs_all_supported_formats() {
		let cases: &[(&[u8], ImageFormat)] = &[
			(b"\x89PNG\r\n\x1a\n", ImageFormat::Png),
			(&[0xff, 0xd8], ImageFormat::Jpeg),
			(b"GIF87a", ImageFormat::Gif),
			(b"RIFF\0\0\0\0WEBP", ImageFormat::Webp),
		];
		for (bytes, format) in cases {
			assert_eq!(PastedImage::from_bytes(bytes.to_vec()).unwrap().format, *format);
		}
		assert_eq!(PastedImage::from_bytes(b"garbage".to_vec()), None);
	}

	fn icon_bitmap() -> PastedImage {
		// Stands in for Finder's generated file-icon bitmap that
		// `arboard::get_image()` returns alongside a `public.file-url`.
		PastedImage::from_bytes(b"\x89PNG\r\n\x1a\nicon".to_vec()).unwrap()
	}

	#[test]
	fn previewable_file_url_wins_over_co_advertised_icon_bitmap() {
		// Finder advertises both the authoritative file URL and a
		// generated icon bitmap. Image and video files must both beat the icon.
		for path in ["/Users/me/Desktop/screenshot.png", "/Users/me/Desktop/launch.mov"] {
			let clipboard = smart_clipboard(
				Some(vec![sf!(path)]),
				|| Some(icon_bitmap()),
				|| unreachable!("text is never consulted when a media path resolves"),
			);
			assert_eq!(clipboard, Some(Clipboard::Paths(vec![sf!(path)])));
		}
		let clipboard = smart_clipboard(
			Some(vec![sf!("/tmp/first.png"), sf!("/tmp/notes.txt"), sf!("/tmp/second.webm")]),
			|| Some(icon_bitmap()),
			|| unreachable!("previewable file URLs win"),
		);
		assert_eq!(
			clipboard,
			Some(Clipboard::Paths(vec![sf!("/tmp/first.png"), sf!("/tmp/second.webm")]))
		);
	}

	#[test]
	fn pure_bitmap_pasteboard_still_attaches_the_image() {
		let clipboard = smart_clipboard(None, || Some(icon_bitmap()), || None);
		assert_eq!(clipboard, Some(Clipboard::Image(icon_bitmap())));
	}

	#[test]
	fn non_image_file_url_falls_to_the_bitmap_then_to_paths() {
		// A non-image Finder selection: the bitmap representation wins …
		let clipboard = smart_clipboard(
			Some(vec![sf!("/Users/me/Documents/report.pdf")]),
			|| Some(icon_bitmap()),
			|| None,
		);
		assert_eq!(clipboard, Some(Clipboard::Image(icon_bitmap())));
		// … and without a bitmap the copied paths still paste.
		let clipboard =
			smart_clipboard(Some(vec![sf!("/Users/me/Documents/report.pdf")]), || None, || None);
		assert_eq!(clipboard, Some(Clipboard::Paths(vec![sf!("/Users/me/Documents/report.pdf")])));
	}

	#[test]
	fn empty_clipboard_falls_to_text_and_rejects_empty_text() {
		assert_eq!(
			smart_clipboard(None, || None, || Some("hello".to_owned())),
			Some(Clipboard::Text("hello".to_owned()))
		);
		assert_eq!(smart_clipboard(None, || None, || Some(String::new())), None);
		assert_eq!(smart_clipboard(None, || None, || None), None);
	}

	#[test]
	fn advertised_clipboard_formats_distinguish_failure_from_unsupported_data() {
		for text in ["public.utf8-plain-text", "UTF8_STRING", "UnicodeText"] {
			assert!(advertised_format_is_supported(text, ClipboardRead::Text), "{text}");
			assert!(advertised_format_is_supported(text, ClipboardRead::Smart), "{text}");
		}
		for media in ["image/png", "Bitmap", "FileDrop", "public.file-url"] {
			assert!(advertised_format_is_supported(media, ClipboardRead::Smart), "{media}");
			assert!(!advertised_format_is_supported(media, ClipboardRead::Text), "{media}");
		}
		assert!(!advertised_format_is_supported("application/pdf", ClipboardRead::Smart));
	}

	#[test]
	fn backend_diagnostics_classify_permission_and_empty_without_overlap() {
		for denied in
			["Permission denied", "Operation not permitted", "Access is denied", "not authorized"]
		{
			assert!(is_permission_diagnostic(denied), "{denied}");
			assert!(!is_empty_diagnostic(denied), "{denied}");
		}
		for empty in ["clipboard is empty", "No selection", "target not available"] {
			assert!(is_empty_diagnostic(empty), "{empty}");
			assert!(!is_permission_diagnostic(empty), "{empty}");
		}
	}
}
