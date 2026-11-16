//! Stdin bytes → keys, pastes, and terminal reports.
//!
//! [`InputParser`] is the whole input side of the terminal engine. It is
//! sans-IO: the host pushes each stdin read in with [`InputParser::feed`]
//! together with its clock reading, drains the produced [`Input`]s, and calls
//! [`InputParser::tick`] when [`InputParser::deadline`] comes due.
//!
//! # Pipeline
//!
//! 1. Incremental UTF-8 decoding (a read may split a code point), then the
//!    cooked-typeahead Enter fix for the first read after attach.
//! 2. [`win32`]: under win32-input-mode, paste markers the console host sent as
//!    individual key records are restored before the splitter looks for them.
//! 3. [`split`]: the buffered text is cut into complete sequences (one scalar
//!    of text, or one whole escape sequence) and pastes, holding partial
//!    escapes across reads.
//! 4. [`reports`]: each sequence is decoded (win32 key records), matched
//!    against the terminal → host reports, reassembled when a flush tore a
//!    report apart, and otherwise forwarded as a key.
//! 5. `altgr` (Windows): `AltGr` text the console host dropped under the kitty
//!    keyboard protocol is recovered from the active layout before any
//!    keybinding sees an Alt chord.
//!
//! # Timers
//!
//! Every timeout is a deadline. Timeouts that JS acted on one event-loop turn
//! late (a zero-delay timer armed from the expiry callback, so a tail already
//! queued on stdin wins against a stalled loop's overdue timer) keep that
//! shape: [`InputParser::tick`] advances such a timeout **one stage per call**
//! — the first call past the timeout only marks it expired and reports a
//! deadline that is already due; the host re-arms a zero-delay timer, delivers
//! any stdin read that was waiting, and the next `tick` acts. The host must
//! therefore re-arm its timer for a due deadline rather than call `tick` in a
//! loop.

#[cfg(any(windows, test))]
mod altgr;
mod paste;
mod reports;
mod scan;
mod split;
mod win32;

use std::{borrow::Cow, mem};

use self::{
	reports::Reassembler,
	split::{Split, Splitter, SplitterOptions},
	win32::Win32PasteMarkerNormalizer,
};
use super::types::{Input, Millis};

/// A timeout whose expiry is acted on one host turn later.
///
/// When the event loop stalls past the timeout while the input the timeout
/// was waiting for is already queued on stdin, the host's overdue timer runs
/// before that read is delivered. Acting straight from the expiry would tear
/// the held sequence apart; the deferral lets the read arrive (and cancel the
/// timeout) first.
#[derive(Clone, Copy, Debug, Default)]
struct Deferred {
	due:      Option<Millis>,
	/// Set once `due` has passed: the instant the expiry was observed.
	deferred: Option<Millis>,
}

impl Deferred {
	const fn arm(&mut self, at: Millis) {
		self.due = Some(at);
		self.deferred = None;
	}

	const fn clear(&mut self) {
		self.due = None;
		self.deferred = None;
	}

	/// The timeout already expired and only waits out the deferral.
	const fn is_deferred(&self) -> bool {
		self.deferred.is_some()
	}

	/// When [`Self::poll`] next changes state; already due while deferred.
	const fn deadline(&self) -> Option<Millis> {
		match self.deferred {
			Some(at) => Some(at),
			None => self.due,
		}
	}

	/// Advance one stage. Returns `true` when the deferral elapsed and the
	/// caller acts now.
	fn poll(&mut self, now: Millis) -> bool {
		if self.deferred.take().is_some() {
			return true;
		}
		if self.due.is_some_and(|due| now >= due) {
			self.due = None;
			self.deferred = Some(now);
		}
		false
	}
}

/// Session state the parser's recognition depends on. The session owns the
/// truth; the engine copies it in with [`InputParser::set_context`] after
/// every call that can change it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputContext {
	/// DEC 2048 is enabled: reassemble `CSI 48;…t` reports split across reads
	/// and hold a CSI introducer that was flushed alone.
	pub in_band_resize:        bool,
	/// An OSC 11 query is in flight: OSC 11 replies are reassembled and
	/// reported only meanwhile; otherwise they pass through as input.
	pub osc11_pending:         bool,
	/// An OSC 99 capability probe is in flight (same gating as OSC 11).
	pub osc99_pending:         bool,
	/// win32-input-mode (`CSI ? 9001 h`) was requested: decode key records,
	/// reassemble relayed VT text, and restore record-encoded paste markers.
	pub win32_input:           bool,
	/// The kitty keyboard protocol is active: ESC arrives as `CSI 27 u`, so a
	/// dangling escape is always a split sequence (held, not flushed as a
	/// key) and `ESC ]`/`ESC P`/`ESC _` always open a string, never an Alt
	/// chord.
	pub kitty_active:          bool,
	/// Kitty is active on a native Windows `ConPTY` host: translate Alt chords
	/// that are really `AltGr` text.
	pub kitty_conpty_altgr:    bool,
	/// The terminal confirmed bracketed paste (DEC 2004): an unmarked
	/// multiline burst is then an input-method commit unless the host reports
	/// a stalled event loop for the read that carried it.
	pub raw_paste_stall_probe: bool,
}

/// Restore the submit Enter of keystrokes the kernel buffered in cooked mode
/// before raw input attached (#17820). The tty's ICRNL folds Enter into LF,
/// which the editor reads as Shift+Enter, so a prompt typed or written during
/// startup never submitted. The line break ending the typeahead (its ESC-free
/// prefix; probe replies may follow in the same read) is the Enter that
/// submits it; earlier breaks stay line breaks of the draft. CRLF (a Windows
/// console line) is left alone.
///
/// Returns `None` when `data` needs no change.
fn restore_cooked_enter(data: &str) -> Option<String> {
	let end = data.find('\x1b').unwrap_or(data.len());
	let typeahead = &data.as_bytes()[..end];
	if !typeahead.ends_with(b"\n") || typeahead.ends_with(b"\r\n") {
		return None;
	}
	let mut restored = String::with_capacity(data.len());
	restored.push_str(&data[..end - 1]);
	restored.push('\r');
	restored.push_str(&data[end..]);
	Some(restored)
}

/// Decode one stdin read, carrying a code point split across reads in
/// `pending`. Invalid bytes become U+FFFD.
fn decode_utf8<'a>(pending: &mut Vec<u8>, bytes: &'a [u8]) -> Cow<'a, str> {
	if pending.is_empty()
		&& let Ok(text) = str::from_utf8(bytes)
	{
		return Cow::Borrowed(text);
	}
	let joined;
	let mut rest = if pending.is_empty() {
		bytes
	} else {
		let mut held = mem::take(pending);
		held.extend_from_slice(bytes);
		joined = held;
		joined.as_slice()
	};
	let mut text = String::with_capacity(rest.len());
	loop {
		match str::from_utf8(rest) {
			Ok(valid) => {
				text.push_str(valid);
				break;
			},
			Err(error) => {
				let (valid, invalid) = rest.split_at(error.valid_up_to());
				if let Ok(valid) = str::from_utf8(valid) {
					text.push_str(valid);
				}
				let Some(length) = error.error_len() else {
					// The read ends inside a code point: wait for its tail.
					pending.extend_from_slice(invalid);
					break;
				};
				text.push(char::REPLACEMENT_CHARACTER);
				rest = &invalid[length..];
			},
		}
	}
	Cow::Owned(text)
}

/// Turns raw stdin bytes into [`Input`]s: keys, pastes, and terminal reports.
pub struct InputParser {
	context:          InputContext,
	/// Set when raw input attaches over a cooked tty: the next read starts
	/// with whatever the kernel line-buffered meanwhile. See
	/// [`restore_cooked_enter`].
	cooked_typeahead: bool,
	/// Head of a code point the last read ended inside.
	utf8_pending:     Vec<u8>,
	normalizer:       Win32PasteMarkerNormalizer,
	splitter:         Splitter,
	reassembler:      Reassembler,
	#[cfg(windows)]
	altgr_host:       altgr::Win32AltGrHost,
	/// Input released by [`Self::set_context`], which has no output; drained
	/// by the next call that does.
	backlog:          Vec<Input>,
	/// Scratch for splitter output.
	splits:           Vec<Split>,
	/// Clock of the latest call, for calls that carry none.
	last_now:         Millis,
}

impl Default for InputParser {
	fn default() -> Self {
		Self::new()
	}
}

impl InputParser {
	/// Create a parser with nothing buffered and an all-off [`InputContext`].
	pub fn new() -> Self {
		Self {
			context:                    InputContext::default(),
			cooked_typeahead:           false,
			utf8_pending:               Vec::new(),
			normalizer:                 Win32PasteMarkerNormalizer::default(),
			splitter:                   Splitter::new(SplitterOptions::default()),
			reassembler:                Reassembler::default(),
			#[cfg(windows)]
			altgr_host:                 altgr::Win32AltGrHost::default(),
			backlog:                    Vec::new(),
			splits:                     Vec::new(),
			last_now:                   0.0,
		}
	}

	/// Update the session-dependent recognition state.
	///
	/// Turning `win32_input` off retires the win32 decoder: the input it still
	/// holds (an incomplete record-encoded paste marker, a relayed ESC waiting
	/// for its tail) belongs to the user and is delivered by the next
	/// [`Self::feed`], [`Self::tick`], or [`Self::release_pending`] —
	/// [`Self::deadline`] is due at once while it waits.
	pub fn set_context(&mut self, context: InputContext) {
		if self.context.win32_input && !context.win32_input {
			let mut backlog = mem::take(&mut self.backlog);
			self.release_win32(self.last_now, &mut backlog);
			self.backlog = backlog;
		} else if !self.context.win32_input && context.win32_input {
			self.normalizer = Win32PasteMarkerNormalizer::default();
			self.reassembler.restart_win32_decoder();
		}
		// A resolved or restarted query leaves no fragment behind.
		if self.context.osc11_pending != context.osc11_pending {
			self.reassembler.clear_background_color_reply();
		}
		if self.context.osc99_pending != context.osc99_pending {
			self.reassembler.clear_notification_reply();
		}
		self.splitter.set_kitty_active(context.kitty_active);
		self.context = context;
	}

	/// Raw input just attached. `cooked_typeahead` says the tty was cooked
	/// until now, so the next read restores the submit Enter of what the
	/// kernel line-buffered (see [`restore_cooked_enter`]).
	pub const fn note_attach(&mut self, cooked_typeahead: bool) {
		self.cooked_typeahead = cooked_typeahead;
	}

	/// Parse one stdin read.
	///
	/// `loop_stalled` is the host's event-loop stall verdict for this read; it
	/// is consulted only for unmarked multiline bursts once
	/// [`InputContext::raw_paste_stall_probe`] is set.
	pub fn feed(&mut self, now: Millis, bytes: &[u8], loop_stalled: bool, out: &mut Vec<Input>) {
		self.last_now = now;
		out.append(&mut self.backlog);
		let decoded = decode_utf8(&mut self.utf8_pending, bytes);
		if decoded.is_empty() {
			return;
		}
		let restored;
		let data = if mem::take(&mut self.cooked_typeahead)
			&& let Some(text) = restore_cooked_enter(&decoded)
		{
			restored = text;
			restored.as_str()
		} else {
			&*decoded
		};
		let stalled = self.context.raw_paste_stall_probe && loop_stalled;
		if self.context.win32_input {
			let normalized = self.normalizer.process(now, data);
			if !normalized.is_empty() {
				self.split(now, &normalized, stalled, out);
			}
		} else {
			self.split(now, data, stalled, out);
		}
	}

	/// Fire due timers: flush held partials, time out pastes and abandoned
	/// strings, release held relayed input. One stage per call for deferred
	/// timeouts (see the module docs).
	pub fn tick(&mut self, now: Millis, out: &mut Vec<Input>) {
		self.last_now = now;
		out.append(&mut self.backlog);
		if let Some(raw) = self.normalizer.tick(now) {
			if !raw.is_empty() {
				self.split(now, &raw, false, out);
			}
			// The normalizer's expiry already spent the ESC wait; release the
			// decoder's hold at once instead of starting a second window. A held
			// string keeps its own longer timer: releasing it here would type the
			// rest of it as text.
			if !self.reassembler.has_pending_win32_string() {
				self.release_win32_pending(now, out);
			}
		}
		let mut splits = mem::take(&mut self.splits);
		self.splitter.tick(now, &mut splits);
		self.deliver(now, &mut splits, out);
		self.splits = splits;

		let start = out.len();
		self.reassembler.tick(now, &mut self.context, out);
		self.recover_altgr(now, &mut out[start..]);
	}

	/// Earliest instant [`Self::tick`] has work to do, if any. A value at or
	/// before the host's clock means "as soon as the event loop turns".
	pub fn deadline(&self) -> Option<Millis> {
		[
			(!self.backlog.is_empty()).then_some(self.last_now),
			self.normalizer.deadline(),
			self.splitter.deadline(),
			self.reassembler.deadline(),
		]
		.into_iter()
		.flatten()
		.reduce(Millis::min)
	}

	/// True while a bracketed paste is being received. The session skips its
	/// per-read DEC 2004 reassertion meanwhile: the host is plainly in
	/// bracketed-paste mode, and per-key reads would turn one paste into
	/// thousands of writes (#15757).
	pub const fn pasting(&self) -> bool {
		self.splitter.pasting()
	}

	/// Deliver the input win32-input-mode decoding still holds (an incomplete
	/// record-encoded paste marker, relayed VT text waiting for its tail) as
	/// keys. Call it while the context still has `win32_input` set, right
	/// before the mode is turned off or the terminal stops; after
	/// [`Self::set_context`] already retired the decoder it only drains what
	/// that released.
	pub fn release_pending(&mut self, out: &mut Vec<Input>) {
		out.append(&mut self.backlog);
		if self.context.win32_input {
			self.release_win32(self.last_now, out);
		}
	}

	/// Drop a held CSI introducer and the pending in-band terminator. The
	/// session calls this when an input drain ends: a report head captured
	/// while no handler could claim its body is stale once the TTY is handed
	/// back.
	pub const fn discard_report_head(&mut self) {
		self.reassembler.discard_report_head();
	}

	/// Forget everything buffered (partial sequences, pastes, reassembly
	/// fragments, timers) without delivering it. The context is kept.
	pub fn reset(&mut self) {
		self.cooked_typeahead = false;
		self.utf8_pending.clear();
		self.normalizer = Win32PasteMarkerNormalizer::default();
		self.splitter.clear();
		self.reassembler.reset();
		self.backlog.clear();
	}

	/// Run text through the splitter and everything it emits through the
	/// sequence handler.
	fn split(&mut self, now: Millis, data: &str, stalled: bool, out: &mut Vec<Input>) {
		let mut splits = mem::take(&mut self.splits);
		self.splitter.process(now, data, stalled, &mut splits);
		self.deliver(now, &mut splits, out);
		self.splits = splits;
	}

	fn deliver(&mut self, now: Millis, splits: &mut Vec<Split>, out: &mut Vec<Input>) {
		for split in splits.drain(..) {
			match split {
				Split::Data(sequence) => {
					let start = out.len();
					self
						.reassembler
						.handle(now, &mut self.context, sequence, out);
					self.recover_altgr(now, &mut out[start..]);
				},
				// An Enter that shared the paste's stdin read rides along so paste
				// and submit reach the component focused right now, not one the
				// paste itself is about to open. Under win32-input-mode the console
				// host encodes pasted line breaks as key records; decode them as
				// text (#14065). tmux extended-keys passthrough re-encodes pasted
				// control bytes as Ctrl+<letter> key sequences; decode those too,
				// so components receive the text the user copied.
				Split::Paste { text, enter } => {
					let text = if self.context.win32_input {
						self.reassembler.decode_win32_paste(text)
					} else {
						text
					};
					let decoded = match paste::decode_reencoded_controls(&text) {
						Cow::Owned(decoded) => Some(decoded),
						Cow::Borrowed(_) => None,
					};
					let text = decoded.unwrap_or(text);
					out.push(Input::Paste { text, enter });
				},
			}
		}
	}

	/// Retire what win32-input-mode decoding holds, delivering it as input.
	fn release_win32(&mut self, now: Millis, out: &mut Vec<Input>) {
		let raw = self.normalizer.flush();
		if !raw.is_empty() {
			self.split(now, &raw, false, out);
		}
		// Held input still belongs to the user (e.g. Escape before a late kitty
		// reply).
		self.release_win32_pending(now, out);
	}

	fn release_win32_pending(&mut self, now: Millis, out: &mut Vec<Input>) {
		let start = out.len();
		self
			.reassembler
			.release_win32_pending(now, &mut self.context, out);
		self.recover_altgr(now, &mut out[start..]);
	}

	/// Windows console hosts drop `AltGr` text under kitty (AltGr+F → `CSI
	/// 102;3u`); recover it from the active layout before any keybinding sees
	/// an Alt chord.
	#[allow(
		clippy::missing_const_for_fn,
		clippy::needless_pass_by_ref_mut,
		reason = "Windows mutates the AltGr host state; the lints only see the non-Windows body, \
		          which is cfg'd out"
	)]
	fn recover_altgr(&mut self, now: Millis, inputs: &mut [Input]) {
		if !self.context.kitty_conpty_altgr {
			return;
		}
		#[cfg(windows)]
		for input in inputs {
			if let Input::Key(sequence) = input
				&& let Some(text) = altgr::translate_altgr_sequence(sequence, now, &mut self.altgr_host)
			{
				*sequence = text;
			}
		}
		#[cfg(not(windows))]
		let _ = (now, inputs);
	}
}

#[cfg(test)]
mod tests;
