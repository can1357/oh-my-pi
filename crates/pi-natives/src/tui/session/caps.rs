//! Capability probes that resolve to a single answer: OSC 99 notification
//! capabilities, OSC 7501 program status, the Glyph Protocol handshake, the
//! Tern Surface Protocol `hello`, SIXEL support, and the cell size in pixels.

use std::sync::atomic::{AtomicU32, Ordering};

use super::{
	Session,
	glyph::{GlyphReply, parse_glyph_reply},
	probe::Owner,
};
use crate::{
	term::Device,
	tui::types::{Event, ImageProtocol, Millis, TspProbe},
};

/// OSC 99 probe identifiers are unique per process, so a reply to an earlier
/// session's probe on the same terminal never resolves a later one.
static NEXT_OSC99_PROBE_ID: AtomicU32 = AtomicU32::new(1);

/// How long XTSMGRAPHICS may go unanswered before the probe is abandoned.
const SIXEL_GRAPHICS_TIMEOUT_MS: Millis = 250.0;

const TSP_PREFIX: &str = "\x1b_tsp;";
const ST: &str = "\x1b\\";

/// Glyph Protocol handshake phase: `Support` awaits the `s` reply, `Confirm`
/// awaits the `q` coverage reply sent after the bundle was written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum GlyphPhase {
	#[default]
	Idle,
	Support,
	Confirm,
}

/// Probe state for the single-answer capabilities.
#[derive(Default)]
pub(super) struct Caps {
	/// Numeric suffix of the outstanding OSC 99 probe's identifier.
	pub(super) osc99_pending:    Option<u32>,
	osc99_supported:             bool,
	program_status_pending:      bool,
	program_status:              Option<bool>,
	pub(super) glyph_phase:      GlyphPhase,
	/// Whether the latest DA1 reply advertised SIXEL (attribute 4). A missing
	/// attribute does not rule out support discovered through XTSMGRAPHICS.
	pub(super) sixel_advertised: Option<bool>,
	/// Deadline of an outstanding XTSMGRAPHICS query.
	sixel_graphics_at:           Option<Millis>,
	/// True while the `hello` probe awaits its reply or DA1 sentinel.
	pub(super) tsp_pending:      bool,
	/// The terminal answered `hello` with the version this session speaks.
	pub(super) tsp_hello:        bool,
	/// Hello deadline inside tmux, where no DA1 sentinel can end the probe.
	tsp_timeout_at:              Option<Millis>,
	/// This tmux pane's APC titles are off for TSP and must be restored.
	tsp_tmux_pane_gated:         bool,
	/// Cell size last reported to the host.
	cell_size:                   Option<(u32, u32)>,
}

impl Caps {
	pub(super) fn deadline(&self) -> Option<Millis> {
		[self.sixel_graphics_at, self.tsp_timeout_at]
			.into_iter()
			.flatten()
			.reduce(f64::min)
	}
}

/// The value of the last `key=value` part of a `:`-separated OSC 99 section.
/// OSC 99 keys are a single character.
fn osc99_value(section: &str, key: char) -> Option<&str> {
	section
		.split(':')
		.filter_map(|part| part.strip_prefix(key)?.strip_prefix('='))
		.next_back()
}

/// A `hello` reply: its JSON body and the protocol version it names.
pub(super) struct TspHello<'a> {
	json:    &'a str,
	version: f64,
}

/// One `key=value` parameter segment of a TSP message
/// (`[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*`).
fn tsp_param(segment: &str) -> Option<(&str, &str)> {
	let (key, value) = segment.split_once('=')?;
	let valid = !key.is_empty()
		&& key
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
		&& value
			.bytes()
			.all(|byte| matches!(byte, 0x21..=0x3a | 0x3c..=0x7e));
	valid.then_some((key, value))
}

/// Decode a complete, unchunked `ESC _ tsp ; r [; k=v]* ; <json> ESC \` whose
/// body is a well-formed `hello` reply. `None` for every other message
/// (events, `blobs` replies, chunks, malformed input).
fn parse_tsp_hello(sequence: &str) -> Option<TspHello<'_>> {
	let inner = sequence.strip_prefix(TSP_PREFIX)?.strip_suffix(ST)?;
	let (verb, mut rest) = inner.split_once(';')?;
	if verb != "r" {
		return None;
	}
	// A segment is a parameter only when another `;` follows it; the body is
	// the rest.
	while let Some((segment, tail)) = rest.split_once(';') {
		let Some((key, value)) = tsp_param(segment) else {
			break;
		};
		// `m=1`: more chunks follow; the reader reassembles those.
		if key == "m" && value == "1" {
			return None;
		}
		rest = tail;
	}
	let value: serde_json::Value = serde_json::from_str(rest).ok()?;
	let reply = value.as_object()?;
	if reply.get("r")?.as_str()? != "hello" || !reply.get("term")?.is_string() {
		return None;
	}
	if !reply
		.get("kinds")?
		.as_array()?
		.iter()
		.all(serde_json::Value::is_string)
	{
		return None;
	}
	Some(TspHello { json: rest, version: reply.get("v")?.as_f64()? })
}

impl Session {
	/// Query OSC 99 notification capabilities (Kitty). The query uses the same
	/// DA1 sentinel FIFO as OSC 11/DECRQM so unsupported terminals resolve
	/// without leaking probe bytes to application input.
	///
	/// The host never asks for the probe inside a terminal multiplexer:
	/// tmux/screen forward the passthrough-wrapped `p=?` query to the outer
	/// terminal, but cannot route the capability reply back to the pane that
	/// sent it (tmux/tmux#4386, tmux/tmux#3964), so the reply leaks into the
	/// pane as literal text and its bytes perturb input (issue #5582 — the
	/// notification sibling of the graphics-probe leak #5381). Rich
	/// notifications fall back to the single-line OSC 99 form until
	/// confirmation, and delivery still uses the passthrough/BEL path (#3395).
	/// So the probe is always sent directly to the terminal.
	pub(super) fn query_osc99(&mut self, device: &mut Device) {
		self.caps.osc99_pending = None;
		if self.link.dead || !self.facts.probe_osc99 {
			return;
		}
		let id = NEXT_OSC99_PROBE_ID.fetch_add(1, Ordering::Relaxed);
		self.caps.osc99_pending = Some(id);
		self.probes.push_back(Owner::Osc99(id));
		let query = format!("\x1b]99;i=omp-probe-{id}:p=?;\x1b\\");
		self.link.send(device, |batch| {
			batch.text(&query).query_device_attributes();
		});
	}

	/// OSC 99 capability reply: `meta` must name the outstanding probe.
	pub(super) fn handle_notification_caps(
		&mut self,
		meta: &str,
		payload: &str,
		out: &mut Vec<Event>,
	) {
		let Some(id) = self.caps.osc99_pending else {
			return;
		};
		if osc99_value(meta, 'i') != Some(format!("omp-probe-{id}").as_str())
			|| osc99_value(meta, 'p') != Some("?")
		{
			return;
		}
		let titles = osc99_value(payload, 'p')
			.is_some_and(|types| types.split(',').any(|kind| kind == "title"));
		self.resolve_osc99(id, titles, out);
	}

	pub(super) fn resolve_osc99(&mut self, id: u32, supported: bool, out: &mut Vec<Event>) {
		if self.caps.osc99_pending != Some(id) {
			return;
		}
		self.caps.osc99_pending = None;
		self.caps.osc99_supported = supported;
		out.push(Event::Osc99 { supported });
	}

	/// Query OSC 7501 program-status support. Support requires an actual
	/// terminal reply; merely writing a report does not establish that a
	/// status record exists to protect.
	///
	/// The host never asks for the probe inside a multiplexer: those can
	/// consume the query or leak its reply into the pane, so their outer
	/// terminal's support is not assumed to reach this process.
	pub(super) fn query_program_status(&mut self, device: &mut Device) {
		self.caps.program_status_pending = false;
		self.caps.program_status = None;
		if self.link.dead || !self.facts.probe_program_status {
			return;
		}
		self.caps.program_status_pending = true;
		self.probes.push_back(Owner::ProgramStatus);
		self.link.send(device, |batch| {
			batch.text("\x1b]7501;?\x1b\\").query_device_attributes();
		});
	}

	/// OSC 7501 feature reply: supported unless it lists `states` without
	/// both `working` and `blocked`.
	pub(super) fn handle_program_status(&mut self, states: Option<&[String]>, out: &mut Vec<Event>) {
		let has = |name: &str| states.is_none_or(|states| states.iter().any(|state| state == name));
		self.resolve_program_status(has("working") && has("blocked"), out);
	}

	pub(super) fn resolve_program_status(&mut self, supported: bool, out: &mut Vec<Event>) {
		if !self.caps.program_status_pending {
			return;
		}
		self.caps.program_status_pending = false;
		self.publish_program_status(supported, out);
	}

	fn publish_program_status(&mut self, supported: bool, out: &mut Vec<Event>) {
		if self.caps.program_status == Some(supported) {
			return;
		}
		self.caps.program_status = Some(supported);
		out.push(Event::ProgramStatus { supported });
	}

	/// Glyph Protocol support query (`s` verb), same DA1 sentinel FIFO. A
	/// reply triggers the bundled icon registration so the nerd symbol preset
	/// renders without a patched font installed.
	///
	/// The host leaves the probe out under its kill switch (the registration
	/// shadows a system Nerd Font at render time) and inside a multiplexer:
	/// same rule as the OSC 99 probe, tmux/screen cannot route the APC reply
	/// back to the sending pane, so it would leak as literal text.
	pub(super) fn query_glyph(&mut self, device: &mut Device) {
		self.caps.glyph_phase = GlyphPhase::Idle;
		if self.link.dead {
			return;
		}
		let Some(probe) = &self.facts.probe_glyph else {
			return;
		};
		self.caps.glyph_phase = GlyphPhase::Support;
		self.probes.push_back(Owner::Glyph(GlyphPhase::Support));
		self.link.send(device, |batch| {
			batch.text(&probe.support_query).query_device_attributes();
		});
	}

	/// Glyph Protocol APC reply (`ESC _ 25a1 ; … ESC \`). The parser swallows
	/// these for the whole session, not just while the probe is outstanding:
	/// an APC is exclusively terminal->host data, and registrations use
	/// `reply=0`, so any late `r`/`c` acknowledgement must never reach the
	/// composer.
	pub(super) fn handle_glyph_reply(
		&mut self,
		sequence: &str,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		let Some(reply) = parse_glyph_reply(sequence) else {
			log::debug!("Glyph Protocol: unparsable reply {sequence:?}");
			return;
		};
		match &reply {
			GlyphReply::Support { formats } if self.caps.glyph_phase == GlyphPhase::Support => {
				// Every bundled payload is `fmt=glyf`; a terminal that recognises
				// the protocol but advertises no formats would reject each
				// registration.
				let probe = self
					.facts
					.probe_glyph
					.as_ref()
					.filter(|_| formats.contains(&"glyf") && !self.link.dead);
				let Some(probe) = probe else {
					self.resolve_glyph(false, out);
					return;
				};
				// Registrations are fire-and-forget (`reply=0`); the coverage
				// query that follows them is the success check — the terminal
				// processes the stream in order, so a `glossary` answer proves
				// the bundle landed.
				self.caps.glyph_phase = GlyphPhase::Confirm;
				self.probes.push_back(Owner::Glyph(GlyphPhase::Confirm));
				self.link.send(device, |batch| {
					batch
						.text(&probe.registrations_and_confirm)
						.query_device_attributes();
				});
			},
			GlyphReply::Coverage { cp, coverage }
				if self.caps.glyph_phase == GlyphPhase::Confirm
					&& self
						.facts
						.probe_glyph
						.as_ref()
						.is_some_and(|probe| i64::from(probe.confirm_codepoint) == *cp) =>
			{
				let confirmed = coverage.contains(&"glossary");
				if !confirmed {
					log::warn!(
						"Glyph Protocol: registered codepoint {cp:x} not served from glossary \
						 ({coverage:?})"
					);
				}
				self.resolve_glyph(confirmed, out);
			},
			// Registrations are sent with `reply=0`, so this is a terminal that
			// ignored the reply gate or a stray acknowledgement: keep it out of
			// input.
			GlyphReply::Registered { status, .. } | GlyphReply::Cleared { status, .. }
				if *status != 0 =>
			{
				log::warn!("Glyph Protocol: registration rejected: {reply:?}");
			},
			_ => {},
		}
	}

	/// Finish the handshake in either phase and report it once. `supported`
	/// is true only after the bundled icons were written and the terminal
	/// confirmed (via a `q` coverage query) that a registered codepoint is
	/// served from its glossary, so a host can safely repaint — or switch to
	/// the nerd preset.
	pub(super) fn resolve_glyph(&mut self, supported: bool, out: &mut Vec<Event>) {
		if self.caps.glyph_phase == GlyphPhase::Idle {
			return;
		}
		self.caps.glyph_phase = GlyphPhase::Idle;
		out.push(Event::Glyph { supported });
	}

	/// Tern Surface Protocol `hello`, same DA1 sentinel FIFO. A reply switches
	/// the host to describing its UI instead of painting rows.
	pub(super) fn query_tsp(&mut self, now: Millis, device: &mut Device, out: &mut Vec<Event>) {
		self.caps.tsp_pending = false;
		self.caps.tsp_hello = false;
		if self.link.dead {
			return;
		}
		match &self.facts.probe_tsp {
			TspProbe::Skip { reason } => {
				out.push(Event::TspHello { json: None, reason: reason.clone() });
			},
			TspProbe::Direct { query, .. } => {
				self.caps.tsp_pending = true;
				self.probes.push_back(Owner::Tsp);
				self.link.send(device, |batch| {
					batch.text(query).query_device_attributes();
				});
			},
			TspProbe::Tmux { query, timeout_ms, .. } => {
				// tmux answers DA1 itself, ahead of any reply: wait for the reply
				// instead.
				self.caps.tsp_pending = true;
				self.caps.tsp_tmux_pane_gated = true;
				out.push(Event::TmuxApcTitles { enabled: false });
				self.caps.tsp_timeout_at = Some(now + timeout_ms);
				self.link.send(device, |batch| {
					batch.text(query);
				});
			},
		}
	}

	/// Tern Surface Protocol APC (the parser already converted OSC 877
	/// framing): the hello reply resolves the probe; events and every other
	/// reply (`blobs`) go to the host whole, which routes them to the native
	/// backend before key matching.
	pub(super) fn handle_tsp_message(&mut self, sequence: String, out: &mut Vec<Event>) {
		if let Some(hello) = parse_tsp_hello(&sequence) {
			self.resolve_tsp(Ok(hello), out);
		} else if self.drain.is_none() {
			out.push(Event::Key(sequence));
		}
	}

	/// Resolve the `hello` probe; an `Err` says why there is no TSP.
	pub(super) fn resolve_tsp(&mut self, hello: Result<TspHello<'_>, String>, out: &mut Vec<Event>) {
		if !self.caps.tsp_pending {
			return;
		}
		self.caps.tsp_pending = false;
		let version = match self.facts.probe_tsp {
			TspProbe::Direct { version, .. } | TspProbe::Tmux { version, .. } => Some(version),
			TspProbe::Skip { .. } => None,
		};
		let hello = hello.and_then(|hello| {
			if version.is_some_and(|version| f64::from(version) == hello.version) {
				Ok(hello)
			} else {
				log::warn!("TSP: unsupported protocol version {}", hello.version);
				Err(format!("unsupported protocol version {}", hello.version))
			}
		});
		match hello {
			Ok(hello) => {
				self.caps.tsp_timeout_at = None;
				self.caps.tsp_hello = true;
				out.push(Event::TspHello { json: Some(hello.json.to_owned()), reason: None });
			},
			Err(reason) => {
				self.end_tsp_tmux_pane(out);
				out.push(Event::TspHello { json: None, reason: Some(reason) });
			},
		}
	}

	/// Hand APC titles back to tmux once this pane stops speaking TSP.
	fn end_tsp_tmux_pane(&mut self, out: &mut Vec<Event>) {
		self.caps.tsp_timeout_at = None;
		if self.caps.tsp_tmux_pane_gated {
			self.caps.tsp_tmux_pane_gated = false;
			out.push(Event::TmuxApcTitles { enabled: true });
		}
	}

	/// Probe SIXEL through XTSMGRAPHICS.
	///
	/// The host asks for the probe only without a statically known protocol
	/// (Kitty/iTerm2 terminals) or an explicit forced choice — including its
	/// `off` kill switch — which win over the probe, without a Tern surface
	/// (live, or about to open optimistically at start), which sends images
	/// through TSP, and only on ttys.
	pub(super) fn query_sixel_graphics(&mut self, now: Millis, device: &mut Device) {
		if self.image_protocol.is_some() || !self.facts.probe_sixel_graphics || self.link.dead {
			return;
		}
		self.caps.sixel_graphics_at = Some(now + SIXEL_GRAPHICS_TIMEOUT_MS);
		// XTSMGRAPHICS item 2 reports the maximum SIXEL geometry. DA1 attribute
		// 4 arrives through the sentinel replies instead, which are consumed so
		// they cannot leak into application input.
		self.link.send(device, |batch| {
			batch.text("\x1b[?2;1;0S");
		});
	}

	/// XTSMGRAPHICS reply `CSI ? 2 ; Ps ; Pv S`: per xterm ctlseqs Ps is the
	/// status (0 = success, 1..3 = error/failure) and Pv the maximum SIXEL
	/// geometry, which a terminal without SIXEL reports as zero; `supported`
	/// is success with non-zero geometry. An already-requested reply keeps
	/// being consumed until it arrives or times out, even though DA1 may have
	/// established support meanwhile.
	pub(super) fn handle_sixel_graphics(&mut self, supported: bool, out: &mut Vec<Event>) {
		if self.caps.sixel_graphics_at.take().is_some() && supported {
			out.push(Event::Sixel { supported: true, graphics: true });
		}
	}

	/// Query the terminal for its cell size in pixels.
	pub(super) fn query_cell_size(&self, device: &mut Device) {
		// Only query if terminal supports images (cell size is only used for
		// image rendering).
		let Some(protocol) = self.image_protocol else {
			return;
		};
		self.link.send(device, |batch| {
			// CSI 16 t; response format: CSI 6 ; height ; width t
			batch.text("\x1b[16t");
			// iTerm2 never answers CSI 16 t. Without a size, rows reserved for an
			// image and crops of a partly scrolled one assume 9x18 cells and
			// land offset.
			if protocol == ImageProtocol::Iterm2 {
				batch.text("\x1b]1337;ReportCellSize\x1b\\");
			}
		});
	}

	/// The host adopted (or dropped) an inline image protocol. A protocol
	/// discovered mid-session (SIXEL through a probe) makes the cell size
	/// matter, so it is queried then.
	pub fn set_image_protocol(&mut self, protocol: Option<ImageProtocol>, device: &mut Device) {
		let discovered = self.image_protocol.is_none() && protocol.is_some();
		self.image_protocol = protocol;
		if discovered && self.active {
			self.query_cell_size(device);
		}
	}

	/// Report a cell size in pixels. An `explicit` reply to a cell-size query
	/// is always reported (a zero dimension is swallowed); sizes derived from
	/// in-band resize reports only when they change.
	pub(super) fn report_cell_size(
		&mut self,
		width_px: u32,
		height_px: u32,
		explicit: bool,
		out: &mut Vec<Event>,
	) {
		if width_px == 0 || height_px == 0 {
			return;
		}
		if !explicit && self.caps.cell_size == Some((width_px, height_px)) {
			return;
		}
		self.caps.cell_size = Some((width_px, height_px));
		out.push(Event::CellSize { width_px, height_px });
	}

	pub(super) fn tick_caps(&mut self, now: Millis, out: &mut Vec<Event>) {
		if let TspProbe::Tmux { timeout_ms, .. } = self.facts.probe_tsp
			&& super::fired(&mut self.caps.tsp_timeout_at, now)
		{
			self.resolve_tsp(Err(format!("no hello reply through tmux within {timeout_ms} ms")), out);
		}
		if self.caps.sixel_graphics_at.is_some_and(|at| at <= now) {
			// XTSMGRAPHICS went unanswered: no SIXEL through this probe.
			self.caps.sixel_graphics_at = None;
		}
	}

	/// Teardown: forget every probe; returns the events that release what the
	/// host still holds for the previous terminal.
	pub(super) fn reset_caps(&mut self, out: &mut Vec<Event>) {
		if self.caps.osc99_supported {
			out.push(Event::Osc99 { supported: false });
		}
		// A resumed session may own a different terminal: release the previous
		// receiver's support until the next probe answers.
		if self.caps.program_status == Some(true) {
			self.publish_program_status(false, out);
		}
		self.end_tsp_tmux_pane(out);
		self.caps = Caps::default();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn osc99_sections_keep_single_character_keys_only() {
		assert_eq!(osc99_value("i=omp-probe-1:p=?", 'i'), Some("omp-probe-1"));
		assert_eq!(osc99_value("i=omp-probe-1:p=?", 'p'), Some("?"));
		assert_eq!(osc99_value("id=7:p=title,body", 'i'), None);
		assert_eq!(osc99_value("p=title:p=body", 'p'), Some("body"));
		assert_eq!(osc99_value("", 'p'), None);
	}

	#[test]
	fn tsp_hello_requires_a_complete_unchunked_reply() {
		let body = r#"{"r":"hello","v":1,"term":"tern","kinds":["rows"]}"#;
		let message = format!("\x1b_tsp;r;{body}\x1b\\");
		let hello = parse_tsp_hello(&message).unwrap();
		assert_eq!(hello.json, body);
		assert_eq!(hello.version, 1.0);
		// Parameters precede the body.
		let message = format!("\x1b_tsp;r;c=4;{body}\x1b\\");
		let hello = parse_tsp_hello(&message).unwrap();
		assert_eq!(hello.json, body);
		// A chunk with more to come is the reader's to reassemble.
		assert!(parse_tsp_hello(&format!("\x1b_tsp;r;c=4;m=1;{body}\x1b\\")).is_none());
		// Events, other replies, malformed bodies, missing fields, no terminator.
		assert!(parse_tsp_hello("\x1b_tsp;e;{\"ev\":\"ack\",\"s\":1}\x1b\\").is_none());
		assert!(parse_tsp_hello("\x1b_tsp;r;{\"r\":\"blobs\",\"have\":[]}\x1b\\").is_none());
		assert!(parse_tsp_hello("\x1b_tsp;r;{\"r\":\"hello\",\"v\":1}\x1b\\").is_none());
		assert!(parse_tsp_hello("\x1b_tsp;r;{not json\x1b\\").is_none());
		assert!(parse_tsp_hello(&format!("\x1b_tsp;r;{body}")).is_none());
		assert!(parse_tsp_hello("\x1b_tsp;r\x1b\\").is_none());
	}
}
