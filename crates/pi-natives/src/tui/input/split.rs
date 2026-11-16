//! Splits buffered stdin text into complete sequences and pastes.
//!
//! This is necessary because stdin reads can arrive in partial chunks,
//! especially for escape sequences like mouse events. Without buffering,
//! partial sequences can be misinterpreted as regular keypresses.
//!
//! For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
//! - Read 1: `\x1b`
//! - Read 2: `[<35`
//! - Read 3: `;20;5m`
//!
//! The buffer accumulates these until a complete sequence is detected.
//!
//! Based on code from `OpenTUI` (<https://github.com/anomalyco/opentui>)
//! MIT License - Copyright (c) 2025 opentui

use std::{mem, ops::Range};

use super::{
	Deferred,
	scan::{Scan, single_scalar},
};
use crate::tui::types::Millis;

const ESC: u8 = 0x1b;
/// Terminal bracketed-paste open marker wrapping pasted input.
pub(super) const BRACKETED_PASTE_START: &str = "\x1b[200~";
/// Terminal bracketed-paste close marker wrapping pasted input.
pub(super) const BRACKETED_PASTE_END: &str = "\x1b[201~";
/// Every Tern Surface Protocol message starts with this (`ESC _ tsp ;`).
pub(super) const TSP_PREFIX: &str = "\x1b_tsp;";
/// TSP input framing through `ConPTY`, whose input parser discards APC.
pub(super) const TSP_OSC_PREFIX: &str = "\x1b]877;tsp;";

// 50ms balances two failure modes: a bare ESC keypress on legacy
// terminals waits this long before it is delivered, while a CSI key
// escape split across stdin reads (laggy ssh/tmux links) leaks as
// literal typed text if the flush fires between the fragments. 10ms
// proved too tight for split escapes (#1238 covered only probe replies).
const FLUSH_TIMEOUT_MS: Millis = 50.0;
// Paste-mode recovery bounds: a lost/corrupted end marker (ssh/tmux
// truncation) must not hang input forever or grow memory unboundedly.
const PASTE_INACTIVITY_TIMEOUT_MS: Millis = 1000.0;
const PASTE_MAX_BYTES: usize = 64 * 1024 * 1024;
// A buggy double-report (CSI-u event plus the bare printable for the same
// keypress) arrives in the same terminal write; a bare char that shows up
// later than this window is a real keystroke and must not be swallowed.
const KITTY_PRINTABLE_DEDUP_WINDOW_MS: Millis = 25.0;
// Upper bound on how long an unambiguous partial is held past the flush
// timeout before being delivered raw anyway (terminal died mid-sequence).
// This is also the worst-case added latency for a partial that never
// completes (e.g. a bare ESC delivered while the kitty-active flag is
// stale); keep it small.
const PARTIAL_HOLD_MAX_MS: Millis = 150.0;
// Escape-sequence length caps. `resolve_escape_end` scans within these bounds
// only, so a malformed CSI (missing final byte in `0x40-0x7E`) or a
// terminator-less OSC/DCS/APC cannot force `extract_complete_sequences` to
// re-inspect a growing prefix on every `process()` call — a single call
// stays bounded work, and a streamed run of garbage bytes is flushed as
// raw sequences instead of accumulated forever (issue #4073 case A).
//
// CSI is intentionally tight: real CSI keys, mouse reports, and DECRQM
// replies are always well under 4 KiB. OSC/DCS/APC allow much larger
// payloads (kitty OSC 5522 clipboard reads, Sixel DCS, kitty graphics APC),
// so the string-terminator cap is generous.
const MAX_CSI_BYTES: usize = 4096;
const MAX_STRING_SEQ_BYTES: usize = 16 * 1024 * 1024;
// Torn-string discard bounds. When a capped OSC/DCS/APC
// partial is dropped, the bytes that follow are mid-string payload (base64
// clipboard data, Sixel, …) up to the next ST/BEL. Replaying them as
// keystrokes types kilobytes of garbage into the focused component (kitty
// OSC 5522 image paste spam), so discard mode swallows the tail until a
// terminator — bounded by a byte budget for a terminator-less stream and an
// inactivity watchdog for a stream that simply stops.
const STRING_DISCARD_MAX_BYTES: usize = 2 * MAX_STRING_SEQ_BYTES;
const STRING_DISCARD_INACTIVITY_MS: Millis = 1000.0;
// A pending string head is abandoned after this long without terminal-shaped
// progress. Generous: a slow clipboard owner or SSH link may stall a packet
// for a while, and abandoning a live packet types nothing but loses it.
const STRING_ABANDON_MS: Millis = 5000.0;
// How long an abandoned head stays dormant waiting for a late tail. Bounded
// so a stale packet cannot absorb unrelated multi-byte input later on; a
// resumed head that is abandoned again is dropped for good.
const STRING_DORMANT_MS: Millis = 10_000.0;
// Raw-paste classification holds CR/LF-bearing, ESC-free input briefly so
// adjacent stdin reads from one unmarked paste can be considered together.
// Fixed from the first break-bearing read (not an inactivity debounce): normal
// Enter latency and candidate memory remain bounded even under a continuous
// stream. Ten milliseconds spans adjacent PTY reads without becoming
// perceptible.
const RAW_PASTE_CLASSIFICATION_TIMEOUT_MS: Millis = 10.0;
const OSC5522_PREFIX: &[u8] = b"\x1b]5522;";
// Kitty clipboard metadata (`type=read:status=DATA:mime=…:pw=…:id=…`) is
// short; bounding the `;` search keeps a malformed packet O(n).
const MAX_OSC5522_METADATA: usize = 1024;

/// One event produced by the [`Splitter`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Split {
	/// One complete sequence: a single scalar of text, or a whole escape
	/// sequence (or what was flushed of one).
	Data(String),
	/// A completed bracketed (or heuristically classified) paste. `enter`
	/// carries an Enter keypress that shared the paste's stdin read, so paste
	/// and submit reach the same focused component before a paste-triggered
	/// overlay can take focus.
	Paste { text: String, enter: Option<String> },
}

/// Timing and size bounds of a [`Splitter`].
#[derive(Clone, Copy, Debug)]
pub(super) struct SplitterOptions {
	/// Maximum time to wait for sequence completion. After this time, a
	/// genuinely incomplete escape is flushed.
	pub timeout_ms:          Millis,
	/// Maximum extra time an unambiguous escape partial — an SGR mouse
	/// prefix, or any dangling escape while the kitty keyboard protocol is
	/// active — is held past `timeout_ms` waiting for its tail.
	pub partial_hold_max_ms: Millis,
	/// Paste-mode inactivity watchdog. If no input arrives for this long
	/// while waiting for the bracketed-paste end marker, the paste is assumed
	/// truncated: accumulated bytes are delivered and input recovers.
	pub paste_timeout_ms:    Millis,
	/// Paste-mode byte cap. Exceeding it aborts paste mode the same way,
	/// bounding memory when the end marker never arrives.
	pub paste_byte_limit:    usize,
}

impl Default for SplitterOptions {
	fn default() -> Self {
		Self {
			timeout_ms:          FLUSH_TIMEOUT_MS,
			partial_hold_max_ms: PARTIAL_HOLD_MAX_MS,
			paste_timeout_ms:    PASTE_INACTIVITY_TIMEOUT_MS,
			paste_byte_limit:    PASTE_MAX_BYTES,
		}
	}
}

/// Whether `text` has two completed logical line breaks (three line segments).
///
/// A single Enter may be batched with surrounding keystrokes in one stdin
/// read, so one break is ambiguous and must stay on the key path. CRLF counts
/// as one logical break. Content after the second break completes the third
/// segment; until then the classification window keeps buffering.
fn is_raw_multiline_burst(text: &str) -> bool {
	let bytes = text.as_bytes();
	let mut breaks = 0;
	let mut index = 0;
	while index < bytes.len() {
		match bytes[index] {
			b'\r' => {
				breaks += 1;
				if bytes.get(index + 1) == Some(&b'\n') {
					index += 1;
				}
			},
			b'\n' => breaks += 1,
			_ if breaks >= 2 => return true,
			_ => {},
		}
		index += 1;
	}
	false
}

/// Whether a classified raw burst ends with an Enter typed after the pasted
/// text: a final CR when every earlier break is LF. An unmarked paste encodes
/// its breaks one way (terminals send CR, automation writes LF), so a lone CR
/// after LF-delimited text is the submit key a stall batched into the same
/// read (#17820). It rides along with the paste like a bracketed paste's
/// trailing Enter.
fn ends_with_typed_enter(text: &str) -> bool {
	text.len() > 1 && text.ends_with('\r') && !text[..text.len() - 1].contains('\r')
}

fn is_paste_report(text: &str) -> bool {
	text.starts_with("\x1b_") || text.starts_with(TSP_OSC_PREFIX)
}

/// Where the escape sequence starting at some position ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EscapeEnd {
	/// Complete sequence; exclusive end index.
	Complete(usize),
	/// Incomplete, still under the per-type cap; buffer for more.
	Incomplete,
	/// Incomplete and the prefix already spans the per-type cap; the caller
	/// cap-flushes CSI as raw bytes; string types (OSC/DCS/APC) are dropped
	/// and their tail discarded.
	Capped,
	/// An OSC/DCS/APC interrupted by a byte its payload cannot contain; the
	/// index is that byte's.
	Aborted(usize),
}

/// Resolve an OSC/DCS/APC string sequence by its grammar, not by time. A
/// string ends at ST (`ESC \`), or BEL for OSC. Its payload never contains
/// another control byte or escape, and an OSC 5522 payload (after the
/// metadata `;`) is strict base64. So a slow terminal — a clipboard owner
/// serving a paste lazily — just extends the wait, while a keypress that
/// cannot be payload (Enter, Backspace, Esc, arrows, space) proves the
/// terminal abandoned the string: the caller drops the head and parses that
/// key normally. Neither half of a stalled packet is ever typed as text.
///
/// The scan is bounded to `[search_from, scan_limit)`; `resume_search_from -
/// 1` keeps a one-byte overlap so an `ESC \` split across chunks is still
/// found.
fn resolve_string_end(
	bytes: &[u8],
	pos: usize,
	resume_search_from: usize,
	bel_terminates: bool,
) -> EscapeEnd {
	let length = bytes.len();
	let search_from = (pos + 2).max(resume_search_from.saturating_sub(1));
	let scan_limit = length.min(pos + MAX_STRING_SEQ_BYTES);
	let base64_from = if bel_terminates {
		osc5522_payload_start(bytes, pos, scan_limit)
	} else {
		None
	};
	// ECMA-48 §8.3.27: a DCS command string may carry BS..CR (0x08-0x0D).
	let dcs = bytes.get(pos + 1) == Some(&b'P');
	let mut index = search_from;
	while index < scan_limit {
		let code = bytes[index];
		if code == ESC {
			// A lone trailing ESC may open ST; re-examined next call.
			if index + 1 == scan_limit {
				break;
			}
			if bytes[index + 1] == b'\\' {
				return EscapeEnd::Complete(index + 2);
			}
			return EscapeEnd::Aborted(index);
		}
		if code == 0x07 && bel_terminates {
			return EscapeEnd::Complete(index + 1);
		}
		if (code < 0x20 || code == 0x7f) && !(dcs && (0x08..=0x0d).contains(&code)) {
			return EscapeEnd::Aborted(index);
		}
		if base64_from.is_some_and(|from| index >= from) && !is_base64_code(code) {
			return EscapeEnd::Aborted(index);
		}
		index += 1;
	}
	if length - pos >= MAX_STRING_SEQ_BYTES {
		EscapeEnd::Capped
	} else {
		EscapeEnd::Incomplete
	}
}

/// Index where an OSC 5522 packet's base64 payload starts, if (yet) known.
fn osc5522_payload_start(bytes: &[u8], pos: usize, scan_limit: usize) -> Option<usize> {
	if !bytes[pos..].starts_with(OSC5522_PREFIX) {
		return None;
	}
	let start = pos + OSC5522_PREFIX.len();
	let metadata_end = scan_limit.min(start + MAX_OSC5522_METADATA);
	let separator = bytes
		.get(start..metadata_end)?
		.iter()
		.position(|&byte| byte == b';')?;
	Some(start + separator + 1)
}

const fn is_base64_code(code: u8) -> bool {
	code.is_ascii_alphanumeric() || matches!(code, b'+' | b'/' | b'=')
}

/// SGR mouse report bodies live between `<` and the terminating `M`/`m`
/// (`<digits;digits;digits[Mm]`). Checked only when the trailing byte is a
/// valid terminator, so it runs at most once per resolved report.
fn is_sgr_mouse_report(payload: &[u8]) -> bool {
	let [b'<', body @ .., b'M' | b'm'] = payload else {
		return false;
	};
	let mut fields = 0;
	for field in body.split(|&byte| byte == b';') {
		if field.is_empty() || !field.iter().all(u8::is_ascii_digit) {
			return false;
		}
		fields += 1;
	}
	fields == 3
}

/// Resolve the exclusive-end index of the escape sequence starting at `pos`
/// (`buffer.as_bytes()[pos]` must be ESC). `resume_search_from` is honored
/// only for OSC/DCS/APC — it lets a chunked payload skip the prefix that a
/// prior `process()` call already searched, so a large OSC 5522 image paste
/// stays O(total) instead of O(total²).
///
/// Meta-ESC (`\x1b\x1b…`) is not resolved here; the outer loop handles the
/// disambiguation shared with the flush timer and the SGR mouse split. This
/// helper returns [`EscapeEnd::Incomplete`] when the first byte after ESC is
/// another ESC.
fn resolve_escape_end(buffer: &str, pos: usize, resume_search_from: usize) -> EscapeEnd {
	let bytes = buffer.as_bytes();
	let length = bytes.len();
	let Some(&next) = bytes.get(pos + 1) else {
		return EscapeEnd::Incomplete;
	};

	match next {
		// Meta-ESC handled by the caller.
		ESC => EscapeEnd::Incomplete,
		b'[' => {
			// CSI: ESC [ ... final byte in 0x40-0x7E.
			let Some(&first) = bytes.get(pos + 2) else {
				return EscapeEnd::Incomplete;
			};
			// Old-style X10 mouse: ESC [ M + 3 arbitrary characters.
			if first == b'M' {
				let mut end = pos + 3;
				let mut body = buffer[end..].chars();
				for _ in 0..3 {
					// Fewer than three characters buffered is always under
					// MAX_CSI_BYTES, so this is a plain "wait for more", never
					// a cap flush.
					let Some(scalar) = body.next() else {
						return EscapeEnd::Incomplete;
					};
					end += scalar.len_utf8();
				}
				return EscapeEnd::Complete(end);
			}
			let cap_end = length.min(pos + MAX_CSI_BYTES);
			let is_sgr_mouse = first == b'<';
			// No resume hint for CSI: `extract_complete_sequences` records
			// hints only for OSC/DCS/APC. A partial CSI rescans from its
			// head, bounded by the tight MAX_CSI_BYTES cap.
			for index in pos + 2..cap_end {
				let code = bytes[index];
				if !(0x40..=0x7e).contains(&code) {
					continue;
				}
				if !is_sgr_mouse {
					return EscapeEnd::Complete(index + 1);
				}
				// SGR mouse only terminates on M/m. Any other final byte, or
				// a malformed body ending in M/m, keeps scanning for a real
				// terminator. Bounded by `cap_end`.
				if matches!(code, b'M' | b'm') && is_sgr_mouse_report(&bytes[pos + 2..=index]) {
					return EscapeEnd::Complete(index + 1);
				}
			}
			if length - pos >= MAX_CSI_BYTES {
				EscapeEnd::Capped
			} else {
				EscapeEnd::Incomplete
			}
		},
		// OSC: ESC ] ... BEL or ST (ESC \).
		b']' => resolve_string_end(bytes, pos, resume_search_from, true),
		// DCS / APC: ESC P/_ ... ST (ESC \).
		b'P' | b'_' => resolve_string_end(bytes, pos, resume_search_from, false),
		// SS3: ESC O + 1 char.
		b'O' => buffer[pos + 2..]
			.chars()
			.next()
			.map_or(EscapeEnd::Incomplete, |scalar| EscapeEnd::Complete(pos + 2 + scalar.len_utf8())),
		// Meta chord: ESC + 1 char.
		_ => buffer[pos + 1..]
			.chars()
			.next()
			.map_or(EscapeEnd::Incomplete, |scalar| EscapeEnd::Complete(pos + 1 + scalar.len_utf8())),
	}
}

/// Codepoint of an unmodified kitty CSI-u printable key
/// (`CSI codepoint [: shifted [: base]] u`).
fn parse_unmodified_kitty_printable_codepoint(sequence: &str) -> Option<u32> {
	let mut scan = Scan::new(sequence);
	if !scan.eat("\x1b[") {
		return None;
	}
	let codepoint = scan.number()?;
	if scan.eat(":") {
		scan.take_while(|byte| byte.is_ascii_digit());
		if scan.eat(":") {
			scan.digits()?;
		}
	}
	(scan.eat("u") && scan.at_end() && codepoint >= 32).then_some(codepoint)
}

/// The Enter keypress that immediately follows a bracketed-paste end marker
/// in the same stdin read: legacy CR/LF, or the kitty CSI-u encoding with no
/// modifier. Nothing else qualifies — any other trailing byte takes the
/// normal data route.
fn leading_enter(input: &str) -> Option<&str> {
	if input.starts_with(['\r', '\n']) {
		return Some(&input[..1]);
	}
	let mut scan = Scan::new(input);
	if !scan.eat("\x1b[13") {
		return None;
	}
	scan.eat(";1");
	scan.eat("u").then(|| &input[..scan.pos()])
}

/// Outcome of one [`extract_complete_sequences`] pass; the sequences
/// themselves are byte ranges pushed into the caller's scratch vector.
struct Extraction {
	/// Start of the unconsumed remainder (`buffer.len()` when there is none).
	remainder:          usize,
	/// Where the next pass resumes the string-terminator search.
	resume_search_from: usize,
	/// A capped OSC/DCS/APC starts here: it and everything after it is junk.
	discard_from:       Option<usize>,
	/// The buffered string head at offset 0 was abandoned (see
	/// [`resolve_string_end`]).
	aborted_head:       bool,
}

/// Split accumulated buffer into complete sequences.
fn extract_complete_sequences(
	buffer: &str,
	resume_search_from: usize,
	sequences: &mut Vec<Range<usize>>,
) -> Extraction {
	let bytes = buffer.as_bytes();
	let length = bytes.len();
	let mut pos = 0;
	let mut aborted_head = false;

	// Index-based scanning: this is the input hot path. Slicing the remaining
	// buffer per iteration would make plain-text bursts O(n²) — a 100KB
	// non-bracketed paste must stay O(n).
	//
	// `resume_search_from` applies only when the buffer starts with an
	// incomplete OSC/DCS/APC we buffered on the previous call; once any
	// bytes are consumed (pos advances past the leading escape), the hint no
	// longer maps to the current buffer offsets and is discarded.
	let mut hint = resume_search_from;

	while pos < length {
		if bytes[pos] != ESC {
			// Not an escape sequence - take one Unicode scalar.
			let width = buffer[pos..].chars().next().map_or(1, char::len_utf8);
			sequences.push(pos..pos + width);
			pos += width;
			hint = 0;
			continue;
		}

		// `\x1b\x1b` is one of three things — see the branches below.
		// Kept in the outer loop because it interacts with flush timing
		// (bare `\x1b\x1b` is held for the timer chain) and with the SGR
		// mouse split that splits `\x1b\x1b[<…` into `\x1b` + `\x1b[<…`.
		if bytes.get(pos + 1) == Some(&ESC) {
			let Some(&third) = bytes.get(pos + 2) else {
				//   Two real Esc keypresses bursted by terminal input batching:
				//   when the buffer ends here, hold the partial for the flush
				//   window so cases 1/2 can still arrive; if no follower
				//   arrives, the flush splits the held remainder into two ESC
				//   events (#3857).
				return Extraction {
					remainder: pos,
					resume_search_from: 0,
					discard_from: None,
					aborted_head,
				};
			};
			if third != b'[' && third != b'O' {
				//   ESC followed by a legacy Alt chord (`\x1bd`, `\x1b\x7f`, …):
				//   emit the first ESC, then restart at the second ESC so
				//   downstream parsing still sees the Alt chord as one
				//   keypress (#3860 review).
				sequences.push(pos..pos + 1);
				pos += 1;
				hint = 0;
				continue;
			}
			//   ESC prefixing CSI/SS3 (meta-CSI, held Esc joined by a follower):
			//   resolve the inner escape's end from `pos + 1`. Consuming two
			//   bytes here would tear the follower and leak its tail as typed
			//   text (settings search filling with "[B" or "[<35;22;17M").
			match resolve_escape_end(buffer, pos + 1, 0) {
				// `third` is CSI/SS3 here, never a string type, so the
				// aborted outcome cannot occur; it waits like a partial.
				EscapeEnd::Incomplete | EscapeEnd::Aborted(_) => {
					return Extraction {
						remainder: pos,
						resume_search_from: 0,
						discard_from: None,
						aborted_head,
					};
				},
				EscapeEnd::Capped => {
					let flush_end = buffer.floor_char_boundary(length.min(pos + MAX_CSI_BYTES));
					sequences.push(pos..flush_end);
					pos = flush_end;
				},
				EscapeEnd::Complete(inner_end) => {
					// ESC + SGR mouse is never a meta chord: alt-modified mouse
					// reports carry the modifier in the button bits, not an ESC
					// prefix. Deliver the bare ESC and the report separately.
					if third == b'[' && bytes.get(pos + 3) == Some(&b'<') {
						sequences.push(pos..pos + 1);
						sequences.push(pos + 1..inner_end);
					} else {
						sequences.push(pos..inner_end);
					}
					pos = inner_end;
				},
			}
			hint = 0;
			continue;
		}

		// Single ESC — resolve directly. Hint carries over from the previous
		// call only when we are still on the buffered escape (pos == 0).
		match resolve_escape_end(buffer, pos, if pos == 0 { hint } else { 0 }) {
			EscapeEnd::Aborted(at) => {
				// The terminal abandoned this string: drop the head (protocol
				// data, never keys) and parse the interrupting byte normally.
				if pos == 0 {
					aborted_head = true;
				}
				pos = at;
			},
			EscapeEnd::Incomplete => {
				// Buffer for more. When this is the leading OSC/DCS/APC,
				// remember how far we scanned so the next `process()` call
				// resumes from there instead of rescanning the whole buffer.
				let string_head = matches!(bytes.get(pos + 1), Some(b']' | b'P' | b'_'));
				return Extraction {
					remainder: pos,
					resume_search_from: if pos == 0 && string_head { length } else { 0 },
					discard_from: None,
					aborted_head,
				};
			},
			EscapeEnd::Capped => {
				if matches!(bytes.get(pos + 1), Some(b']' | b'P' | b'_')) {
					// Unterminated string sequence at the cap (issue #4073 case A):
					// the head is junk and everything after it is mid-string
					// payload. Hand both to the caller's discard mode instead of
					// flushing the payload as per-character typed text.
					return Extraction {
						remainder:          length,
						resume_search_from: 0,
						discard_from:       Some(pos),
						aborted_head:       false,
					};
				}
				let flush_end = buffer.floor_char_boundary(length.min(pos + MAX_CSI_BYTES));
				sequences.push(pos..flush_end);
				pos = flush_end;
			},
			EscapeEnd::Complete(end) => {
				sequences.push(pos..end);
				pos = end;
			},
		}
		hint = 0;
	}

	Extraction { remainder: length, resume_search_from: 0, discard_from: None, aborted_head }
}

/// Torn-string discard state: swallowing mid-string bytes until ST/BEL.
#[derive(Clone, Copy, Debug)]
struct StringDiscard {
	bytes:    usize,
	/// A trailing ESC is held across reads so a split `ESC \` is detected.
	esc_held: bool,
	/// Inactivity watchdog: recovers a stream that stops without terminating.
	watchdog: Millis,
}

/// Buffers stdin text and emits complete sequences ([`Split::Data`]) and
/// pastes ([`Split::Paste`]). Handles partial escape sequences that arrive
/// across multiple reads.
pub(super) struct Splitter {
	options:                 SplitterOptions,
	buffer:                  String,
	/// Flush timeout plus its zero-delay deferral: when the event loop stalls
	/// past the timeout (heavy render) while the tail of a split escape is
	/// already queued on stdin, the host's expired timer runs before the read
	/// that delivers the tail — flushing straight from the timer would tear
	/// the sequence apart and leak the tail as typed text. The deferral acts
	/// one host turn later, after stdin has had a chance to deliver the
	/// pending chunk to `process()` and cancel it.
	flush:                   Deferred,
	partial_hold_start:      Option<Millis>,
	paste_mode:              bool,
	paste_text:              String,
	paste_watchdog:          Option<Millis>,
	pending_kitty_printable: Option<(u32, Millis)>,
	escape_search_offset:    usize,
	raw_paste_candidate:     String,
	raw_paste_timer:         Option<Millis>,
	string_discard:          Option<StringDiscard>,
	// Pending string head bookkeeping (see `track_string_read`): when the head
	// last made terminal-shaped progress (`None` = no head tracked), keys typed
	// while it stalled with their buffer offsets, and the abandonment deadline.
	string_progress:         Option<Millis>,
	string_typed_keys:       Vec<(usize, String)>,
	string_abandon:          Option<Millis>,
	// An abandoned string head, kept so a late terminal-shaped tail still
	// completes it instead of being typed (see `resume_dormant_string`).
	dormant_string:          Option<String>,
	dormant_until:           Millis,
	// The pending head was resumed from dormancy; abandoning it again drops it.
	string_resumed:          bool,
	kitty_active:            bool,
	/// Scratch for [`extract_complete_sequences`] ranges.
	ranges:                  Vec<Range<usize>>,
}

impl Splitter {
	pub(super) fn new(options: SplitterOptions) -> Self {
		Self {
			options,
			buffer: String::new(),
			flush: Deferred::default(),
			partial_hold_start: None,
			paste_mode: false,
			paste_text: String::new(),
			paste_watchdog: None,
			pending_kitty_printable: None,
			escape_search_offset: 0,
			raw_paste_candidate: String::new(),
			raw_paste_timer: None,
			string_discard: None,
			string_progress: None,
			string_typed_keys: Vec::new(),
			string_abandon: None,
			dormant_string: None,
			dormant_until: 0.0,
			string_resumed: false,
			kitty_active: false,
			ranges: Vec::new(),
		}
	}

	/// Whether the kitty keyboard protocol is active: the ESC key then arrives
	/// as `\x1b[27u` and alt-chords as CSI-u, so a bare `\x1b` (or any
	/// unterminated escape) is always a split sequence, never a key.
	pub(super) const fn set_kitty_active(&mut self, active: bool) {
		self.kitty_active = active;
	}

	/// Whether a bracketed paste has started and its end marker has not
	/// arrived. The session skips its per-read DEC 2004 reassertion meanwhile:
	/// the host is evidently in bracketed-paste mode, and a paste delivered one
	/// key record per read would otherwise cost one terminal write per pasted
	/// key (#15757).
	pub(super) const fn pasting(&self) -> bool {
		self.paste_mode
	}

	/// Feed one stdin read.
	///
	/// `stalled` gates unbracketed raw-paste classification on event-loop
	/// responsiveness. The host reports it once DECRQM confirms bracketed-paste
	/// (mode 2004) support: a genuine paste then always arrives wrapped, so an
	/// unmarked multiline burst is either an input-method commit — IME,
	/// dictation, and emoji commits are typed input, never bracketed (#13344) —
	/// or keystrokes an event-loop stall batched into one read (#12540). A
	/// burst classified while `stalled` is replayed as the original keys so
	/// every Enter submits; otherwise it is delivered as one paste.
	#[allow(
		clippy::iter_with_drain,
		reason = "`drain(..)` keeps the ranges allocation, which is handed back to `self.ranges` \
		          for reuse"
	)]
	pub(super) fn process(&mut self, now: Millis, data: &str, stalled: bool, out: &mut Vec<Split>) {
		let mut data = data;
		if self.string_discard.is_some() {
			// Mid torn-string: swallow payload up to the terminator; only what
			// follows the terminator re-enters normal parsing.
			data = self.consume_string_discard(now, data);
		}
		if data.is_empty() {
			return;
		}
		if self.paste_mode {
			self.consume_paste_chunk(now, data, stalled, out);
			return;
		}
		if self.dormant_string.is_some() && self.buffer.is_empty() {
			if now < self.dormant_until {
				self.resume_dormant_string(data);
			} else {
				self.dormant_string = None;
			}
		}
		if self.buffer_is_string_head() {
			self.track_string_read(now, data);
		}

		if self.flush.is_deferred() && self.is_fresh_escape_after_deferred_flush(data) {
			// The buffered partial already hit its flush timeout. A new escape is
			// a fresh sequence, not a tail; flush the stale partial first so the
			// new sequence can be parsed from a clean buffer.
			self.flush.clear();
			self.flush_expired(now, out);
		} else {
			// Cancel any pending flush — new data may complete the buffered
			// partial.
			self.flush.clear();
		}

		if !self.raw_paste_candidate.is_empty() {
			if data.contains('\x1b') {
				// Escape-bearing input cannot belong to an unmarked raw paste.
				// Replay the ambiguous prefix as keys before parsing the escape.
				self.flush_raw_paste_candidate(now, out);
			} else {
				self.raw_paste_candidate.push_str(data);
				if is_raw_multiline_burst(&self.raw_paste_candidate) {
					self.classify_raw_paste_candidate(now, stalled, out);
				}
				return;
			}
		}

		if self.buffer.is_empty() && !data.contains('\x1b') && data.contains(['\r', '\n']) {
			// Hold the first break-bearing read briefly. A split raw paste can
			// then accumulate enough logical lines to classify; an ordinary
			// Enter is replayed unchanged when the fixed window expires.
			self.raw_paste_candidate.push_str(data);
			if is_raw_multiline_burst(data) {
				self.classify_raw_paste_candidate(now, stalled, out);
			} else if self.raw_paste_timer.is_none() {
				// One fixed window from the first break-bearing raw read.
				self.raw_paste_timer = Some(now + RAW_PASTE_CLASSIFICATION_TIMEOUT_MS);
			}
			return;
		}

		self.buffer.push_str(data);

		if let Some(start_index) = self.buffer.find(BRACKETED_PASTE_START) {
			// Keys typed while a string head stalled precede the paste.
			self.emit_string_typed_keys(now, out);
			let buffer = mem::take(&mut self.buffer);
			if start_index > 0 {
				self.emit_sequences_of(now, &buffer[..start_index], out);
			}

			self.escape_search_offset = 0;
			self.pending_kitty_printable = None;
			self.paste_mode = true;
			self.paste_text.clear();
			self.consume_paste_chunk(
				now,
				&buffer[start_index + BRACKETED_PASTE_START.len()..],
				stalled,
				out,
			);
			return;
		}

		let mut ranges = mem::take(&mut self.ranges);
		ranges.clear();
		let result = extract_complete_sequences(&self.buffer, self.escape_search_offset, &mut ranges);
		let mut buffer = mem::take(&mut self.buffer);
		if let Some(discard_from) = result.discard_from {
			self.escape_search_offset = 0;
			self.take_string_typed_keys();
			for range in ranges.drain(..) {
				self.emit_data_sequence(now, &buffer[range], out);
			}
			self.ranges = ranges;
			self.enter_string_discard(now);
			let after = self.consume_string_discard(now, &buffer[discard_from..]);
			if !after.is_empty() {
				self.process(now, after, stalled, out);
			}
			return;
		}
		self.escape_search_offset = result.resume_search_from;

		// An abandoned string head hands back the keys typed while it stalled;
		// they precede the byte that aborted it.
		if result.aborted_head {
			self.emit_string_typed_keys(now, out);
		}
		for range in ranges.drain(..) {
			self.emit_data_sequence(now, &buffer[range], out);
		}
		self.ranges = ranges;
		buffer.drain(..result.remainder);
		self.buffer = buffer;

		// A string head waits for its terminator, an aborting byte, or the
		// abandonment bound (`track_string_read`), never the key flush window.
		if self.buffer_is_string_head() {
			if self.string_progress.is_none() {
				self.dormant_string = None;
				self.string_resumed = false;
				self.note_string_progress(now);
			}
			self.partial_hold_start = None;
		} else {
			self.take_string_typed_keys();
			if self.buffer.is_empty() {
				self.partial_hold_start = None;
			} else {
				self.flush.arm(now + self.options.timeout_ms);
			}
		}
	}

	/// Fire due timers. The flush timeout advances one stage per call (see
	/// [`Deferred`]).
	pub(super) fn tick(&mut self, now: Millis, out: &mut Vec<Split>) {
		if self
			.string_discard
			.is_some_and(|discard| now >= discard.watchdog)
		{
			self.string_discard = None;
		}
		if self.paste_watchdog.is_some_and(|at| now >= at) {
			self.paste_watchdog = None;
			self.abort_paste(now, false, out);
		}
		if self.raw_paste_timer.is_some_and(|at| now >= at) {
			self.flush_raw_paste_candidate(now, out);
		}
		if self.string_abandon.is_some_and(|at| now >= at) {
			self.abandon_string_head(now, out);
		}
		if self.flush.poll(now) {
			self.flush_expired(now, out);
		}
	}

	/// Earliest instant [`Self::tick`] has work to do.
	pub(super) fn deadline(&self) -> Option<Millis> {
		[
			self.string_discard.map(|discard| discard.watchdog),
			self.paste_watchdog,
			self.raw_paste_timer,
			self.string_abandon,
			self.flush.deadline(),
		]
		.into_iter()
		.flatten()
		.reduce(Millis::min)
	}

	/// Drop every buffered byte and timer without emitting.
	pub(super) fn clear(&mut self) {
		self.flush.clear();
		self.paste_watchdog = None;
		self.raw_paste_timer = None;
		self.string_discard = None;
		self.take_string_typed_keys();
		self.dormant_string = None;
		self.string_resumed = false;
		self.buffer.clear();
		self.raw_paste_candidate.clear();
		self.paste_mode = false;
		self.paste_text.clear();
		self.pending_kitty_printable = None;
		self.partial_hold_start = None;
		self.escape_search_offset = 0;
	}

	/// Accumulate pasted text while routing APC and `ConPTY` TSP reports through
	/// the data path. Only an undecided escape suffix stays in the input
	/// buffer, so text chunks are joined once and string scans resume where the
	/// last read ended.
	fn consume_paste_chunk(
		&mut self,
		now: Millis,
		chunk: &str,
		stalled: bool,
		out: &mut Vec<Split>,
	) {
		let held = mem::take(&mut self.buffer);
		let joined;
		let input = if held.is_empty() {
			chunk
		} else {
			joined = held + chunk;
			joined.as_str()
		};
		let search_offset = mem::take(&mut self.escape_search_offset);
		let previous_bytes = self.paste_text.len();
		let mut text_start = 0;
		let mut search_from = 0;

		while search_from < input.len() {
			let Some(found) = input[search_from..].find('\x1b') else {
				break;
			};
			let escape = search_from + found;
			let tail = &input[escape..];

			if let Some(after) = tail.strip_prefix(BRACKETED_PASTE_END) {
				self.paste_text.push_str(&input[text_start..escape]);
				self.finish_paste(now, after, stalled, out);
				return;
			}
			if tail.len() < TSP_OSC_PREFIX.len()
				&& (BRACKETED_PASTE_END.starts_with(tail) || TSP_OSC_PREFIX.starts_with(tail))
			{
				self.paste_text.push_str(&input[text_start..escape]);
				self.buffer.push_str(tail);
				text_start = input.len();
				break;
			}
			if !is_paste_report(tail) {
				search_from = escape + 1;
				continue;
			}

			self.paste_text.push_str(&input[text_start..escape]);
			match resolve_escape_end(input, escape, if escape == 0 { search_offset } else { 0 }) {
				EscapeEnd::Incomplete => {
					self.buffer.push_str(tail);
					self.escape_search_offset = tail.len();
					text_start = input.len();
					break;
				},
				EscapeEnd::Capped => {
					self.enter_string_discard(now);
					let rest = self.consume_string_discard(now, tail);
					self.consume_paste_chunk(now, rest, stalled, out);
					return;
				},
				EscapeEnd::Aborted(at) => search_from = at,
				EscapeEnd::Complete(end) => {
					self.emit_data_sequence(now, &input[escape..end], out);
					search_from = end;
				},
			}
			text_start = search_from;
		}

		self.paste_text.push_str(&input[text_start..]);
		let pending_text = if is_paste_report(&self.buffer) {
			0
		} else {
			self.buffer.len()
		};
		if self.paste_text.len() + pending_text > self.options.paste_byte_limit {
			self.abort_paste(now, stalled, out);
		} else if self.paste_watchdog.is_none()
			|| self.paste_text.len() != previous_bytes
			|| pending_text > 0
		{
			// Terminal replies do not keep a paste with a lost end marker alive.
			self.paste_watchdog = Some(now + self.options.paste_timeout_ms);
		}
	}

	fn finish_paste(&mut self, now: Millis, remaining: &str, stalled: bool, out: &mut Vec<Split>) {
		let text = mem::take(&mut self.paste_text);
		self.paste_watchdog = None;
		self.paste_mode = false;
		self.pending_kitty_printable = None;

		// Keep paste-and-Enter on the same focus owner if the paste opens an
		// overlay.
		let enter = leading_enter(remaining);
		out.push(Split::Paste { text, enter: enter.map(str::to_owned) });
		let rest = &remaining[enter.map_or(0, str::len)..];
		if !rest.is_empty() {
			self.process(now, rest, stalled, out);
		}
	}

	/// Recover from a paste whose end marker never arrived (dropped or
	/// corrupted in transit, or past the byte cap): exit paste mode and deliver
	/// the accumulated bytes as a paste, so they are neither lost, replayed as
	/// keystrokes, nor accumulated forever while input appears dead.
	fn abort_paste(&mut self, now: Millis, stalled: bool, out: &mut Vec<Split>) {
		let pending = mem::take(&mut self.buffer);
		self.escape_search_offset = 0;
		let reply = is_paste_report(&pending);
		if !reply {
			self.paste_text.push_str(&pending);
		}
		self.finish_paste(now, "", stalled, out);
		// A reply split across paste recovery still belongs to the terminal.
		if reply {
			self.process(now, &pending, stalled, out);
		}
	}

	fn take_raw_paste_candidate(&mut self) -> String {
		self.raw_paste_timer = None;
		mem::take(&mut self.raw_paste_candidate)
	}

	/// Deliver a classified raw multiline burst: one paste, or the original
	/// keys when the stall probe says a blocked loop batched typed input.
	fn classify_raw_paste_candidate(&mut self, now: Millis, stalled: bool, out: &mut Vec<Split>) {
		if stalled {
			self.flush_raw_paste_candidate(now, out);
			return;
		}
		let mut text = self.take_raw_paste_candidate();
		self.pending_kitty_printable = None;
		let enter = ends_with_typed_enter(&text).then(|| {
			text.pop();
			"\r".to_owned()
		});
		out.push(Split::Paste { text, enter });
	}

	/// Replay an ambiguous raw candidate as the original per-key data events.
	fn flush_raw_paste_candidate(&mut self, now: Millis, out: &mut Vec<Split>) {
		let content = self.take_raw_paste_candidate();
		self.emit_sequences_of(now, &content, out);
	}

	/// Emit every complete sequence of `text` (a self-contained run that is not
	/// the input buffer).
	fn emit_sequences_of(&mut self, now: Millis, text: &str, out: &mut Vec<Split>) {
		if text.is_empty() {
			return;
		}
		let mut ranges = Vec::new();
		extract_complete_sequences(text, 0, &mut ranges);
		for range in ranges {
			self.emit_data_sequence(now, &text[range], out);
		}
	}

	fn emit_data_sequence(&mut self, now: Millis, sequence: &str, out: &mut Vec<Split>) {
		if let Some(scalar) = single_scalar(sequence)
			&& let Some((codepoint, at)) = self.pending_kitty_printable
			&& u32::from(scalar) == codepoint
			&& now - at <= KITTY_PRINTABLE_DEDUP_WINDOW_MS
		{
			self.pending_kitty_printable = None;
			return;
		}

		self.pending_kitty_printable =
			parse_unmodified_kitty_printable_codepoint(sequence).map(|codepoint| (codepoint, now));
		out.push(Split::Data(sequence.to_owned()));
	}

	/// A deferred flush means the current buffer already waited for the
	/// incomplete-sequence timeout. If the next chunk starts a fresh escape, do
	/// not merge it into the stale partial. Keep ESC-backslash as a
	/// continuation for OSC/DCS/APC string terminators (`ST`).
	fn is_fresh_escape_after_deferred_flush(&self, data: &str) -> bool {
		if !data.starts_with('\x1b') || self.buffer.is_empty() {
			return false;
		}
		let string_buffered = ["\x1b]", "\x1bP", "\x1b_"]
			.iter()
			.any(|introducer| self.buffer.starts_with(*introducer));
		!(data.starts_with("\x1b\\") && string_buffered)
	}

	/// Whether the dangling partial cannot be a finished keypress and is worth
	/// holding for its tail instead of flushing:
	/// - SGR mouse prefixes (`\x1b[<…`) — no keyboard sequence starts with
	///   `\x1b[<`, so a buffer still matching this is always the head of a split
	///   mouse report. Flushing it on timeout would deliver the tail as literal
	///   typed text to whatever component is focused (fullscreen overlays enable
	///   any-motion tracking, so report floods plus render stalls make the split
	///   routine — see the settings search leaking `[<35;8;16M`).
	/// - Any partial while the kitty keyboard protocol is active — the ESC key
	///   arrives as `\x1b[27u` and alt-chords as CSI-u, so a bare `\x1b` (or any
	///   unterminated escape) is always a split sequence, never a key.
	fn should_hold_partial(&self) -> bool {
		let sgr_mouse_partial = self.buffer.strip_prefix("\x1b[<").is_some_and(|body| {
			body
				.bytes()
				.all(|byte| byte.is_ascii_digit() || byte == b';')
		});
		sgr_mouse_partial || self.kitty_active
	}

	/// Whether the buffer is the head of an OSC/DCS/APC string: terminal
	/// protocol data (OSC 5522 clipboard read, graphics reply), never a key.
	/// Without the kitty keyboard protocol `\x1b]`/`\x1bP`/`\x1b_` may be
	/// Alt+]/Alt+P/Alt+_, alone or batched with the next keys, so a head counts
	/// only while it follows the opening of a reply omp actually receives
	/// ([`is_legacy_string_reply_opener`]); the moment it diverges it falls
	/// back to the key flush timer.
	fn buffer_is_string_head(&self) -> bool {
		let bytes = self.buffer.as_bytes();
		if bytes.first() != Some(&ESC) || !matches!(bytes.get(1), Some(b']' | b'P' | b'_')) {
			return false;
		}
		self.kitty_active || (bytes.len() > 2 && is_legacy_string_reply_opener(bytes))
	}

	/// Classify a read arriving while a string head is pending. Chunk
	/// boundaries do not follow terminal writes (SSH, tmux), so no read is ever
	/// torn out of the string: every byte stays payload until the terminator
	/// completes it or an impossible byte aborts it, and every read refreshes
	/// the abandonment bound so a slow transfer is never abandoned while it
	/// still streams.
	///
	/// Typing and terminal payload are indistinguishable by their bytes; when
	/// in doubt the string wins, because typed base64 is the failure this
	/// exists to prevent. Only a lone printable key arriving after the flush
	/// window passed without a read — the shape of typing — is remembered: a
	/// head that completes keeps it as payload, one that is abandoned (aborting
	/// byte, or [`STRING_ABANDON_MS`] without reads) replays it. Multi-byte
	/// reads, even keys an event-loop stall batched together, stay protocol
	/// data.
	fn track_string_read(&mut self, now: Millis, data: &str) {
		let stalled = self
			.string_progress
			.is_none_or(|at| now - at >= self.options.timeout_ms);
		self.note_string_progress(now);
		let Some(scalar) = single_scalar(data) else {
			return;
		};
		if !stalled || scalar < ' ' || scalar == '\x7f' {
			return;
		}
		// Only a key the string would keep as payload: a terminator completes
		// it, and an impossible byte aborts it and is delivered by the parser.
		let head_length = self.buffer.len();
		let bel_terminates = self.buffer.as_bytes().get(1) == Some(&b']');
		self.buffer.push_str(data);
		let end = resolve_string_end(self.buffer.as_bytes(), 0, head_length, bel_terminates);
		self.buffer.truncate(head_length);
		if end == EscapeEnd::Incomplete {
			self.string_typed_keys.push((head_length, data.to_owned()));
		}
	}

	const fn note_string_progress(&mut self, now: Millis) {
		self.string_progress = Some(now);
		self.string_abandon = Some(now + STRING_ABANDON_MS);
	}

	/// The abandonment bound passed without a read: retire the pending head.
	fn abandon_string_head(&mut self, now: Millis, out: &mut Vec<Split>) {
		self.string_abandon = None;
		if !self.buffer_is_string_head() {
			self.take_string_typed_keys();
			return;
		}
		// The replayed keys are not payload: cut them from the dormant head
		// so a late tail completes the packet the terminal actually sent.
		let mut dormant = mem::take(&mut self.buffer);
		for (at, key) in self.string_typed_keys.iter().rev() {
			let end = at + key.len();
			if dormant.is_char_boundary(*at) && dormant.is_char_boundary(end) {
				dormant.replace_range(*at..end, "");
			}
		}
		if self.string_resumed {
			self.dormant_string = None;
		} else {
			self.dormant_string = Some(dormant);
			self.dormant_until = now + STRING_DORMANT_MS;
		}
		self.escape_search_offset = 0;
		self.emit_string_typed_keys(now, out);
	}

	/// End string head tracking; returns the keys typed while it stalled.
	fn take_string_typed_keys(&mut self) -> Vec<(usize, String)> {
		if self.string_progress.take().is_none() {
			return Vec::new();
		}
		self.string_abandon = None;
		mem::take(&mut self.string_typed_keys)
	}

	/// End string head tracking and replay the keys typed while it stalled.
	fn emit_string_typed_keys(&mut self, now: Millis, out: &mut Vec<Split>) {
		for (_, key) in self.take_string_typed_keys() {
			self.emit_sequences_of(now, &key, out);
		}
	}

	/// Re-attach a late tail to an abandoned string head. A read that
	/// completes the head (even a lone BEL, or `\` after a held ESC), a lone
	/// ESC under the kitty keyboard protocol (never a key there, so it opens a
	/// split ST), or a multi-byte read that continues its grammar (strict
	/// base64 for OSC 5522) resumes the head, as protocol data like any
	/// multi-byte read. Other lone printable keys pass through as typing and
	/// keep the head dormant; anything else means input moved on.
	fn resume_dormant_string(&mut self, data: &str) {
		let Some(mut head) = self.dormant_string.take() else {
			return;
		};
		let head_length = head.len();
		let bel_terminates = head.as_bytes().get(1) == Some(&b']');
		head.push_str(data);
		let end = resolve_string_end(head.as_bytes(), 0, head_length, bel_terminates);
		head.truncate(head_length);
		let held_st = data == "\x1b" && self.kitty_active;
		if !matches!(end, EscapeEnd::Complete(_))
			&& !held_st
			&& let Some(scalar) = single_scalar(data)
		{
			if scalar >= ' ' && scalar != '\x7f' {
				self.dormant_string = Some(head);
			}
			return;
		}
		if matches!(end, EscapeEnd::Aborted(_)) {
			return;
		}
		self.buffer = head;
		self.escape_search_offset = head_length;
		self.string_resumed = true;
	}

	/// Timeout-driven flush: hold unambiguous partials (bounded), else deliver.
	fn flush_expired(&mut self, now: Millis, out: &mut Vec<Split>) {
		if self.buffer.is_empty() {
			self.partial_hold_start = None;
			return;
		}
		if self.should_hold_partial() {
			let start = *self.partial_hold_start.get_or_insert(now);
			if now - start < self.options.partial_hold_max_ms {
				self.flush.arm(now + self.options.timeout_ms);
				return;
			}
		}
		self.partial_hold_start = None;
		for sequence in self.drain_buffered() {
			self.emit_data_sequence(now, &sequence, out);
		}
	}

	/// Take everything buffered as sequences, ending all key-path holds.
	fn drain_buffered(&mut self) -> Vec<String> {
		self.flush.clear();

		let raw_candidate = self.take_raw_paste_candidate();
		let mut sequences = Vec::new();
		if !raw_candidate.is_empty() {
			let mut ranges = Vec::new();
			extract_complete_sequences(&raw_candidate, 0, &mut ranges);
			sequences.extend(
				ranges
					.into_iter()
					.map(|range| raw_candidate[range].to_owned()),
			);
		}

		if self.buffer.is_empty() {
			self.pending_kitty_printable = None;
			return sequences;
		}

		let string_head = self.buffer_is_string_head();
		let buffered = mem::take(&mut self.buffer);
		self.escape_search_offset = 0;
		self.pending_kitty_printable = None;
		// Bare double-ESC remainder (no disambiguating "[" / "O" arrived in
		// time): two real Esc keypresses bursted by terminal batching, not a
		// meta-CSI/SS3 prefix. Key parsing recognizes nothing in the combined
		// chunk, so a single emission swallows the double-escape gesture (#3857).
		// Mirror the inline split in `extract_complete_sequences` and deliver two
		// ESC events.
		if buffered == "\x1b\x1b" {
			sequences.push("\x1b".to_owned());
			sequences.push("\x1b".to_owned());
		} else if string_head {
			// Unterminated OSC/DCS/APC head: protocol data, never delivered as a
			// key. Its tracking ends with it so the next head starts fresh.
			self.take_string_typed_keys();
		} else {
			sequences.push(buffered);
		}
		sequences
	}

	/// Enter torn-string discard: swallow mid-string bytes until ST/BEL.
	const fn enter_string_discard(&mut self, now: Millis) {
		self.string_discard = Some(StringDiscard {
			bytes:    0,
			esc_held: false,
			watchdog: now + STRING_DISCARD_INACTIVITY_MS,
		});
	}

	/// Swallow mid-string bytes; returns the input remaining after the string
	/// terminator (empty while still inside the torn string). A trailing ESC is
	/// held across calls so an `ESC \` split between reads is still detected.
	/// The byte budget bounds a terminator-less stream; the inactivity watchdog
	/// recovers a stream that stops without ever terminating.
	fn consume_string_discard<'a>(&mut self, now: Millis, data: &'a str) -> &'a str {
		// Taken out while scanning: every early return below leaves discard
		// mode, and only the swallowed-everything path restores it.
		let Some(mut discard) = self.string_discard.take() else {
			return data;
		};
		let bytes = data.as_bytes();
		if mem::take(&mut discard.esc_held) && bytes.first() == Some(&b'\\') {
			return &data[1..];
		}
		for (index, &code) in bytes.iter().enumerate() {
			if code == 0x07 {
				return &data[index + 1..];
			}
			if code == ESC {
				if index + 1 == bytes.len() {
					discard.esc_held = true;
					break;
				}
				if bytes[index + 1] == b'\\' {
					return &data[index + 2..];
				}
			}
		}
		discard.bytes += bytes.len();
		if discard.bytes <= STRING_DISCARD_MAX_BYTES {
			discard.watchdog = now + STRING_DISCARD_INACTIVITY_MS;
			self.string_discard = Some(discard);
		}
		""
	}
}

/// Openings of the string replies omp receives, matched while still partial
/// (each alternative accepts any prefix of its opener) so a legacy Alt chord
/// that diverges is recognized as soon as it does:
/// - OSC: numeric command then `;` (`\x1b]11;`, `\x1b]5522;`).
/// - DCS: DECRQSS/XTGETTCAP `\x1bP1$r` / `\x1bP1+r`, XTVERSION `\x1bP>|`, DA3
///   `\x1bP!|`.
/// - APC: kitty graphics `\x1b_G`, TSP `\x1b_tsp;`, Glyph Protocol
///   `\x1b_25a1;`.
///
/// `bytes` starts with `ESC` and one of `]`, `P`, `_`, followed by at least
/// one more byte.
fn is_legacy_string_reply_opener(bytes: &[u8]) -> bool {
	let rest = &bytes[2..];
	// Either the whole opener, or a proper prefix of it that ends the buffer.
	let opens =
		|opener: &[u8]| !rest.is_empty() && (rest.starts_with(opener) || opener.starts_with(rest));
	match bytes[1] {
		b']' => {
			let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
			digits > 0 && matches!(rest.get(digits), None | Some(b';'))
		},
		b'P' => match rest {
			[digit, tail @ ..] if digit.is_ascii_digit() => {
				matches!(tail, [] | [b'$' | b'+'] | [b'$' | b'+', b'r', ..])
			},
			[b'>' | b'!'] | [b'>' | b'!', b'|', ..] => true,
			_ => false,
		},
		b'_' => rest.first() == Some(&b'G') || opens(b"tsp;") || opens(b"25a1;"),
		_ => false,
	}
}

#[cfg(test)]
impl Splitter {
	/// Everything currently held (raw-paste candidate, then the input buffer).
	fn buffered(&self) -> String {
		format!("{}{}", self.raw_paste_candidate, self.buffer)
	}

	/// Explicit flush, as the host does when it tears the reader down.
	fn flush_now(&mut self) -> Vec<String> {
		self.drain_buffered()
	}
}

#[cfg(test)]
mod tests;
