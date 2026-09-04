//! Terminal identity, graphics capability detection, and runtime probing.
//!
//! Environment detection supplies a conservative fallback. [`probe_terminal`]
//! can refine it from replies emitted by the terminal itself without losing
//! application input that arrives during negotiation.

use std::{
	borrow, env,
	io::{self, IsTerminal as _, Read, Write},
	str, thread,
	time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
	fs::{self, OpenOptions},
	os::fd::AsFd as _,
};

#[cfg(unix)]
use nix::{
	fcntl::{FcntlArg, OFlag, fcntl},
	poll::{PollFd, PollFlags, PollTimeout, poll},
	sys::termios::{SetArg, cfmakeraw, tcgetattr, tcsetattr},
};
use strum::Display;

#[cfg(unix)]
use crate::tty::open;
use crate::{Charset, Graphics, escape::esc, tty::overridden};

const FORCE_IMAGE_PROTOCOL: &str = "OMP_FORCE_IMAGE_PROTOCOL";
/// Explicit glyph-tier override: `ascii`, `unicode`, or `nerd`.
const FORCE_CHARSET: &str = "OMP_TUI_CHARSET";

/// Terminal emulator identity inferred from environment markers.
#[derive(Clone, Copy, Debug, Display, Eq, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum TerminalId {
	/// No recognized emulator and no true-color advertisement.
	Base,
	/// An unknown emulator advertising 24-bit color.
	#[strum(to_string = "trueColor")]
	TrueColor,
	/// Kitty.
	Kitty,
	/// Ghostty.
	Ghostty,
	/// `WezTerm`.
	Wezterm,
	/// iTerm2.
	Iterm2,
	/// Visual Studio Code's integrated terminal.
	Vscode,
	/// Alacritty.
	Alacritty,
	/// Warp.
	Warp,
	/// Orca.
	Orca,
}

impl TerminalId {
	/// Stable identifier used by pi-tui's terminal capability table.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Base => "base",
			Self::TrueColor => "trueColor",
			Self::Kitty => "kitty",
			Self::Ghostty => "ghostty",
			Self::Wezterm => "wezterm",
			Self::Iterm2 => "iterm2",
			Self::Vscode => "vscode",
			Self::Alacritty => "alacritty",
			Self::Warp => "warp",
			Self::Orca => "orca",
		}
	}
}

/// Host platform distinctions that affect terminal graphics support.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalPlatform {
	/// Microsoft Windows.
	Windows,
	/// Linux, including WSL when its environment markers are absent.
	Linux,
	/// macOS.
	MacOs,
	/// Any other host platform.
	Other,
}

impl TerminalPlatform {
	const fn current() -> Self {
		#[cfg(target_os = "windows")]
		return Self::Windows;
		#[cfg(target_os = "linux")]
		return Self::Linux;
		#[cfg(target_os = "macos")]
		return Self::MacOs;
		#[allow(unreachable_code, reason = "supported platforms return above")]
		Self::Other
	}
}

/// Terminal notification protocol selected from emulator identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotifyProtocol {
	/// Audible or visual terminal bell.
	Bell,
	/// OSC 9 desktop notification.
	Osc9,
	/// Kitty OSC 99 desktop notification.
	Osc99,
}

/// Graphics-related terminal capabilities resolved for the current process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalCaps {
	/// Detected terminal emulator.
	pub id: TerminalId,
	/// Whether the terminal supports 24-bit RGB SGR colors.
	pub true_color: bool,
	/// Glyph capability tier inferred from the emulator (`OMP_TUI_CHARSET`
	/// overrides).
	pub charset: Charset,
	/// Safe image rendering mode.
	pub graphics: Graphics,
	/// Whether Kitty Unicode placeholders are trusted for this terminal.
	pub kitty_placeholders: bool,
	/// Pixel width and height of one terminal cell, when reported.
	pub cell_px: Option<(u16, u16)>,
	/// Number of SIXEL color registers reported by XTSMGRAPHICS.
	pub sixel_color_registers: Option<u16>,
	/// Whether DEC synchronized output mode 2026 is supported.
	pub sync_output: bool,
	/// Kitty keyboard protocol flags reported by the terminal.
	pub kitty_keyboard: Option<u8>,
	/// Whether cleared viewport content can be moved to native scrollback.
	pub screen_to_scrollback: bool,
	/// Whether rows scrolled out of a top-anchored DECSTBM region enter
	/// native scrollback.
	pub margin_scrollback: bool,
	/// Whether OSC 8 hyperlinks are supported.
	pub hyperlinks: bool,
	/// Whether Kitty OSC 66 text sizing is supported.
	pub text_sizing: bool,
	/// Whether Kitty-style DECCARA rectangular SGR is supported.
	pub deccara: bool,
	/// Notification protocol selected for this terminal.
	pub notify: NotifyProtocol,
	/// Whether a Kitty OSC 99 capability reply confirmed rich notifications.
	pub osc99_confirmed: bool,
	/// Terminal background color normalized to 16-bit RGB components.
	pub background: Option<(u16, u16, u16)>,
	/// Whether DEC mode 2031 appearance notifications are supported.
	pub appearance_notifications: bool,
	/// Whether DEC mode 2048 in-band resize notifications are supported.
	pub in_band_resize: bool,
	/// Whether DEC mode 5522 enhanced paste offers are supported.
	pub paste_events: bool,
	/// Whether xterm mode 1010 was set and may be temporarily disabled.
	pub xterm_scroll_to_bottom_on_output: bool,
	/// Whether xterm mode 1011 was set and may be temporarily disabled.
	pub xterm_scroll_to_bottom_on_key_press: bool,
	/// Hangul Compatibility Jamo width, or zero for the platform default.
	pub jamo_width: u8,
	/// Whether the process is inside tmux.
	pub inside_tmux: bool,
	/// Whether a tmux, screen, Zellij, Herdr, or cmux marker was detected.
	pub inside_multiplexer: bool,
	sync_output_override: Option<bool>,
}

impl TerminalCaps {
	/// Resolves an explicit override, runtime replies, and environment fallback.
	///
	/// Explicit overrides win unchanged. A probe that received at least one
	/// recognizable reply supersedes environment protocol guesses. tmux can
	/// carry Kitty APC and SIXEL DCS through passthrough; other multiplexers
	/// conservatively disable non-forced graphics.
	pub fn resolve(
		mut env_caps: Self,
		probe: Option<&ProbeResults>,
		forced: Option<Graphics>,
	) -> Self {
		let graphics_forced = forced.is_some();
		if let Some(graphics) = forced {
			env_caps.graphics = graphics;
			env_caps.kitty_placeholders = graphics == Graphics::KittyPlaceholders;
		}
		let mut probe_overrode_graphics = false;
		if let Some(probe) = probe {
			env_caps.cell_px = probe.cell_px.or(env_caps.cell_px);
			env_caps.sixel_color_registers = probe
				.sixel_color_registers
				.or(env_caps.sixel_color_registers);
			if env_caps.sync_output_override.is_none()
				&& let Some(sync_output) = probe.sync_output
			{
				env_caps.sync_output = sync_output;
			}
			if let Some(kitty_keyboard) = probe.kitty_keyboard {
				env_caps.kitty_keyboard = Some(kitty_keyboard);
			}
			env_caps.background = probe.background.or(env_caps.background);
			env_caps.osc99_confirmed |= probe.osc99_confirmed;
			env_caps.appearance_notifications |= probe.appearance_notifications;
			env_caps.in_band_resize |= probe.in_band_resize;
			env_caps.paste_events |= probe.paste_events;
			env_caps.xterm_scroll_to_bottom_on_output = probe.xterm_scroll_to_bottom_on_output;
			env_caps.xterm_scroll_to_bottom_on_key_press = probe.xterm_scroll_to_bottom_on_key_press;
			if !graphics_forced {
				if probe.kitty_graphics == Some(true) {
					probe_overrode_graphics = true;
					env_caps.graphics = if env_caps.kitty_placeholders {
						Graphics::KittyPlaceholders
					} else {
						Graphics::KittyDirect
					};
				} else if probe.supports_sixel() {
					probe_overrode_graphics = true;
					env_caps.graphics = Graphics::Sixel;
				} else if probe.da1_attributes.is_some() {
					probe_overrode_graphics = true;
					env_caps.graphics = Graphics::Cells;
				}
			}
		}
		if probe_overrode_graphics && env_caps.inside_multiplexer && !env_caps.inside_tmux {
			env_caps.graphics = Graphics::Cells;
			env_caps.kitty_placeholders = false;
		}
		env_caps
	}
}

/// Replies collected by a runtime graphics capability probe.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProbeResults {
	/// Whether a Kitty graphics reply was received and reported success.
	pub kitty_graphics: Option<bool>,
	/// Pixel width and height of one terminal cell.
	pub cell_px: Option<(u16, u16)>,
	/// Number of SIXEL color registers reported by XTSMGRAPHICS.
	pub sixel_color_registers: Option<u16>,
	/// XTSMGRAPHICS status for the color-register query (`0` means success).
	pub sixel_status: Option<u16>,
	/// Primary Device Attributes reported by DA1.
	pub da1_attributes: Option<Vec<u16>>,
	/// Whether DECRQM reported synchronized output mode 2026 as supported.
	pub sync_output: Option<bool>,
	/// Kitty keyboard protocol flags reported by the terminal.
	pub kitty_keyboard: Option<u8>,
	/// Terminal background color normalized to 16-bit RGB components.
	pub background: Option<(u16, u16, u16)>,
	/// Whether Kitty OSC 99 capability probing confirmed rich notifications.
	pub osc99_confirmed: bool,
	/// Whether DEC mode 2031 was already set before the session.
	pub appearance_notifications_set: bool,
	/// Whether DECRQM reported DEC mode 2031 as supported.
	pub appearance_notifications: bool,
	/// Whether DEC mode 2048 was already set before the session.
	pub in_band_resize_set: bool,
	/// Whether DECRQM reported DEC mode 2048 as supported.
	pub in_band_resize: bool,
	/// Whether DECRQM reported DEC mode 5522 (kitty enhanced paste) as settable.
	pub paste_events: bool,
	/// Whether DECRQM reported ANSI insert mode 4 as set and changeable.
	pub insert_mode_set: bool,
	/// Whether DECRQM reported ANSI new-line mode 20 as set and changeable.
	pub newline_mode_set: bool,
	/// Whether DECRQM reported xterm mode 1010 as set and changeable.
	///
	/// Status 3 is permanently set, so it is deliberately not changed.
	pub xterm_scroll_to_bottom_on_output: bool,
	/// Whether DECRQM reported xterm mode 1011 as set and changeable.
	///
	/// Status 3 is permanently set, so it is deliberately not changed.
	pub xterm_scroll_to_bottom_on_key_press: bool,
	/// Non-probe bytes read while negotiation was active, in original order.
	pub preserved_input: Vec<u8>,
	/// Whether negotiation ended at the deadline rather than at the DA1 fence.
	pub timed_out: bool,
}

impl ProbeResults {
	/// Whether DA1 or XTSMGRAPHICS advertised SIXEL support.
	pub fn supports_sixel(&self) -> bool {
		self
			.da1_attributes
			.as_ref()
			.is_some_and(|attributes| attributes.contains(&4))
			|| (self.sixel_status == Some(0)
				&& self
					.sixel_color_registers
					.is_some_and(|registers| registers > 0))
	}
}

/// Incremental demultiplexer for startup probe replies and application input.
#[derive(Debug, Default)]
pub struct ProbeParser {
	pending:  Vec<u8>,
	results:  ProbeResults,
	complete: bool,
}

impl ProbeParser {
	/// Creates an empty parser.
	pub fn new() -> Self {
		Self::default()
	}

	/// Feeds raw terminal bytes into the parser.
	///
	/// Complete probe replies are consumed. All other complete byte sequences
	/// are appended to `preserved` in their original order.
	pub fn feed(&mut self, bytes: &[u8], preserved: &mut Vec<u8>) {
		self.pending.extend_from_slice(bytes);
		let mut cursor = 0;
		while cursor < self.pending.len() {
			if self.pending[cursor] != 0x1b {
				preserved.push(self.pending[cursor]);
				cursor += 1;
				continue;
			}
			if cursor + 1 == self.pending.len() {
				break;
			}
			match self.pending[cursor + 1] {
				b'_' => {
					if cursor + 2 == self.pending.len() {
						break;
					}
					if self.pending[cursor + 2] != b'G' {
						preserved.push(0x1b);
						cursor += 1;
						continue;
					}
					let Some(relative_end) = self.pending[cursor + 3..]
						.windows(2)
						.position(|window| window == b"\x1b\\")
					else {
						break;
					};
					let end = cursor + 3 + relative_end;
					let sequence = self.pending[cursor + 3..end].to_vec();
					if !self.parse_kitty(&sequence) {
						preserved.extend_from_slice(&self.pending[cursor..end + 2]);
					}
					cursor = end + 2;
				},
				b'[' => {
					let Some(relative_end) = self.pending[cursor + 2..]
						.iter()
						.position(|byte| (0x40..=0x7e).contains(byte))
					else {
						break;
					};
					let end = cursor + 2 + relative_end;
					let sequence = self.pending[cursor + 2..=end].to_vec();
					if !self.parse_csi(&sequence) {
						preserved.extend_from_slice(&self.pending[cursor..=end]);
					}
					cursor = end + 1;
				},
				b']' => {
					let mut terminator = None;
					let mut index = cursor + 2;
					while index < self.pending.len() {
						if self.pending[index] == 0x07 {
							terminator = Some((index, 1));
							break;
						}
						if self.pending[index] == 0x1b && self.pending.get(index + 1) == Some(&b'\\') {
							terminator = Some((index, 2));
							break;
						}
						index += 1;
					}
					let Some((end, terminator_len)) = terminator else {
						break;
					};
					let payload = self.pending[cursor + 2..end].to_vec();
					if !self.parse_osc(&payload) {
						preserved.extend_from_slice(&self.pending[cursor..end + terminator_len]);
					}
					cursor = end + terminator_len;
				},
				_ => {
					preserved.push(0x1b);
					cursor += 1;
				},
			}
		}
		self.pending.drain(..cursor);
	}

	/// Returns whether the DA1 fence has been consumed.
	pub const fn is_complete(&self) -> bool {
		self.complete
	}

	/// Returns probe results accumulated so far.
	pub const fn results(&self) -> &ProbeResults {
		&self.results
	}

	/// Flushes an incomplete or unrecognized suffix as application input.
	pub fn finish(&mut self, preserved: &mut Vec<u8>) {
		preserved.append(&mut self.pending);
	}

	fn parse_kitty(&mut self, payload: &[u8]) -> bool {
		let Some(separator) = payload.iter().position(|byte| *byte == b';') else {
			return false;
		};
		if !payload[..separator]
			.split(|byte| *byte == b',')
			.any(|parameter| parameter == b"i=31")
		{
			return false;
		}
		self.results.kitty_graphics = Some(&payload[separator + 1..] == b"OK");
		true
	}

	fn parse_osc(&mut self, payload: &[u8]) -> bool {
		if let Some(color) = payload.strip_prefix(b"11;").and_then(parse_osc11_color) {
			self.results.background = Some(color);
			return true;
		}
		let Some(payload) = payload.strip_prefix(b"99;") else {
			return false;
		};
		let Some(separator) = payload.iter().position(|byte| *byte == b';') else {
			return false;
		};
		let metadata = &payload[..separator];
		if key_value(metadata, b"i") != Some(OSC99_PROBE_ID)
			|| key_value(metadata, b"p") != Some(b"?")
		{
			return false;
		}
		let Some(types) = key_value(&payload[separator + 1..], b"p") else {
			return true;
		};
		self.results.osc99_confirmed = types
			.split(|byte| *byte == b',')
			.any(|kind| kind == b"title");
		true
	}

	fn parse_csi(&mut self, sequence: &[u8]) -> bool {
		let Some((&final_byte, body)) = sequence.split_last() else {
			return false;
		};
		match final_byte {
			b'S' => {
				let Some(parameters) = body.strip_prefix(b"?2;") else {
					return false;
				};
				let mut fields = parameters.split(|byte| *byte == b';');
				let Some(status) = fields.next().and_then(parse_u16) else {
					return false;
				};
				// Reply shape `CSI ? 2 ; Ps ; Pv S`: per xterm ctlseqs Ps is
				// the status (0 = success) and Pv the maximum SIXEL geometry,
				// which foot 1.27 reports as two parts (`…;0;1692;432S`) and a
				// terminal without SIXEL reports as zero. Any positive part
				// proves a usable geometry; oversized parts saturate instead
				// of rejecting the reply.
				let mut geometry = None;
				for field in fields {
					let Some(value) = parse_u16_saturating(field) else {
						return false;
					};
					geometry = Some(geometry.unwrap_or(0).max(value));
				}
				let Some(geometry) = geometry else {
					return false;
				};
				self.results.sixel_status = Some(status);
				self.results.sixel_color_registers = Some(geometry);
				true
			},
			b't' => {
				let Some(parameters) = body.strip_prefix(b"6;") else {
					return false;
				};
				let mut fields = parameters.split(|byte| *byte == b';');
				let Some(height) = fields.next().and_then(parse_u16) else {
					return false;
				};
				let Some(width) = fields.next().and_then(parse_u16) else {
					return false;
				};
				self.results.cell_px = Some((width, height));
				true
			},
			b'c' => {
				let Some(parameters) = body.strip_prefix(b"?") else {
					return false;
				};
				let attributes = parameters
					.split(|byte| *byte == b';')
					.filter(|field| !field.is_empty())
					.map(parse_u16)
					.collect::<Option<Vec<_>>>();
				let Some(attributes) = attributes else {
					return false;
				};
				self.results.da1_attributes = Some(attributes);
				self.complete = true;
				true
			},
			b'y' => {
				let (private, parameters) = match body.strip_prefix(b"?") {
					Some(parameters) => (true, parameters),
					None => (false, body),
				};
				let Some(parameters) = parameters.strip_suffix(b"$") else {
					return false;
				};
				let mut fields = parameters.split(|byte| *byte == b';');
				let Some(mode) = fields.next().and_then(parse_u16) else {
					return false;
				};
				let Some(status) = fields.next().and_then(parse_u16) else {
					return false;
				};
				if fields.next().is_some() {
					return false;
				}
				match (private, mode) {
					(false, 4) => self.results.insert_mode_set = status == 1,
					(false, 20) => self.results.newline_mode_set = status == 1,
					(true, 1010) => {
						self.results.xterm_scroll_to_bottom_on_output = status == 1;
					},
					(true, 1011) => {
						self.results.xterm_scroll_to_bottom_on_key_press = status == 1;
					},
					(true, 2026) => self.results.sync_output = Some(matches!(status, 1 | 2)),
					(true, mode @ (2031 | 2048)) => {
						let supported = matches!(status, 1..=3);
						let set = matches!(status, 1 | 3);
						if mode == 2031 {
							self.results.appearance_notifications = supported;
							self.results.appearance_notifications_set = set;
						} else {
							self.results.in_band_resize = supported;
							self.results.in_band_resize_set = set;
						}
					},
					(true, 5522) => self.results.paste_events = matches!(status, 1 | 2),
					_ => return false,
				}
				true
			},
			b'u' => {
				let Some(flags) = body
					.strip_prefix(b"?")
					.and_then(parse_u16)
					.and_then(|flags| u8::try_from(flags).ok())
				else {
					return false;
				};
				self.results.kitty_keyboard = Some(flags);
				true
			},
			_ => false,
		}
	}

	fn into_results(mut self, preserved: Vec<u8>, timed_out: bool) -> ProbeResults {
		self.results.preserved_input = preserved;
		self.results.timed_out = timed_out;
		self.results
	}
}

fn parse_u16(bytes: &[u8]) -> Option<u16> {
	(!bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit))
		.then(|| str::from_utf8(bytes).ok()?.parse().ok())
		.flatten()
}

/// Parses an all-digit field, saturating values beyond `u16::MAX`.
fn parse_u16_saturating(bytes: &[u8]) -> Option<u16> {
	if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let mut value = 0_u32;
	for byte in bytes {
		value = value
			.saturating_mul(10)
			.saturating_add(u32::from(byte - b'0'));
	}
	Some(u16::try_from(value).unwrap_or(u16::MAX))
}

const OSC99_PROBE_ID: &[u8] = b"omp-tui";

fn key_value<'a>(section: &'a [u8], key: &[u8]) -> Option<&'a [u8]> {
	section.split(|byte| *byte == b':').find_map(|field| {
		let separator = field.iter().position(|byte| *byte == b'=')?;
		(&field[..separator] == key).then_some(&field[separator + 1..])
	})
}

fn parse_osc11_color(payload: &[u8]) -> Option<(u16, u16, u16)> {
	let components = payload
		.strip_prefix(b"rgb:")
		.or_else(|| payload.strip_prefix(b"rgba:"))?;
	let mut components = components.split(|byte| *byte == b'/');
	let red = components.next().and_then(parse_hex_component)?;
	let green = components.next().and_then(parse_hex_component)?;
	let blue = components.next().and_then(parse_hex_component)?;
	components.next().is_none().then_some((red, green, blue))
}

fn parse_hex_component(component: &[u8]) -> Option<u16> {
	if !(1..=4).contains(&component.len()) || !component.iter().all(u8::is_ascii_hexdigit) {
		return None;
	}
	let value = u32::from_str_radix(str::from_utf8(component).ok()?, 16).ok()?;
	let maximum = 16_u32.pow(u32::try_from(component.len()).ok()?) - 1;
	u16::try_from(value * u32::from(u16::MAX) / maximum).ok()
}

const PROBE_BATCH: &[u8] = esc!(
	kitty_graphics_query,
	sixel_color_registers_query,
	cell_pixels_query,
	background_color_query,
	osc99_query,
	?insert_mode,
	?newline_mode,
	?scroll_on_output,
	?scroll_on_key_press,
	?sync_output,
	?appearance_notifications,
	?in_band_resize,
	?paste_events,
	kitty_keyboard_query,
	primary_device_attributes_query,
)
.as_bytes();
const PROBE_BATCH_NO_OSC99: &[u8] = esc!(
	kitty_graphics_query,
	sixel_color_registers_query,
	cell_pixels_query,
	background_color_query,
	?insert_mode,
	?newline_mode,
	?scroll_on_output,
	?scroll_on_key_press,
	?sync_output,
	?appearance_notifications,
	?in_band_resize,
	?paste_events,
	kitty_keyboard_query,
	primary_device_attributes_query,
)
.as_bytes();

fn materialize_probe_batch(inside_tmux: bool, include_osc99: bool) -> borrow::Cow<'static, [u8]> {
	let batch = if include_osc99 {
		PROBE_BATCH
	} else {
		PROBE_BATCH_NO_OSC99
	};
	if !inside_tmux {
		return borrow::Cow::Borrowed(batch);
	}
	let mut wrapped = Vec::with_capacity(batch.len() + 16);
	wrapped.extend_from_slice(esc!(dcs, "tmux;").as_bytes());
	for byte in batch {
		wrapped.push(*byte);
		if *byte == 0x1b {
			wrapped.extend_from_slice(esc!(escape).as_bytes());
		}
	}
	wrapped.extend_from_slice(esc!(st).as_bytes());
	borrow::Cow::Owned(wrapped)
}

/// Performs a blocking startup capability probe.
///
/// The terminal must already be in raw mode. To make the deadline effective,
/// `tty` must return [`io::ErrorKind::WouldBlock`] or
/// [`io::ErrorKind::TimedOut`] while no input is available. Returned
/// [`ProbeResults::preserved_input`] must be delivered to the application's
/// normal input pipeline before newly read input. Terminal I/O errors end the
/// probe conservatively and leave environment fallback resolution available.
pub fn probe_terminal(tty: &mut (impl Read + Write), timeout: Duration) -> ProbeResults {
	let caps = detect();
	let batch = materialize_probe_batch(
		caps.inside_tmux,
		caps.notify == NotifyProtocol::Osc99 && !caps.inside_multiplexer,
	);
	if tty.write_all(&batch).and_then(|()| tty.flush()).is_err() {
		return ProbeResults { timed_out: true, ..ProbeResults::default() };
	}
	let deadline = Instant::now() + timeout;
	let mut parser = ProbeParser::new();
	let mut preserved = Vec::new();
	let mut buffer = [0; 256];
	while !parser.is_complete() && Instant::now() < deadline {
		match tty.read(&mut buffer) {
			Ok(0) => break,
			Ok(read) => parser.feed(&buffer[..read], &mut preserved),
			Err(error)
				if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) =>
			{
				thread::sleep(Duration::from_millis(1));
			},
			Err(_) => break,
		}
	}

	let timed_out = !parser.is_complete();
	parser.finish(&mut preserved);
	parser.into_results(preserved, timed_out)
}
/// Negotiates terminal graphics capabilities while preserving every
/// non-probe byte received during the probe window.
///
/// On Unix this opens `/dev/tty`, temporarily applies raw non-blocking mode,
/// and restores both termios and descriptor flags before returning. If the
/// controlling terminal is unavailable, environment capabilities and an empty
/// probe result are returned.
pub fn negotiate(timeout: Duration) -> (TerminalCaps, ProbeResults) {
	#[cfg(not(unix))]
	let _ = timeout;
	let env_caps = detect();
	let forced = forced_graphics_from_environment(env_caps);
	#[cfg(unix)]
	let probe = probe_controlling_terminal(
		timeout,
		env_caps.inside_tmux,
		env_caps.notify == NotifyProtocol::Osc99 && !env_caps.inside_multiplexer,
	);
	#[cfg(not(unix))]
	let probe: Option<ProbeResults> = None;
	let caps = TerminalCaps::resolve(env_caps, probe.as_ref(), forced);
	(caps, probe.unwrap_or_default())
}
/// [`negotiate`] on the blocking pool, for tokio hosts.
///
/// # Panics
/// Panics outside a tokio runtime.
pub async fn negotiate_async(timeout: Duration) -> (TerminalCaps, ProbeResults) {
	tokio::task::spawn_blocking(move || negotiate(timeout))
		.await
		.unwrap_or_else(|_| (detect(), ProbeResults::default()))
}

fn forced_graphics_from_environment(caps: TerminalCaps) -> Option<Graphics> {
	let vars = |name: &str| env::var(name).ok();
	forced_protocol(&vars).map(|protocol| match protocol {
		ForcedProtocol::Force(ImageProtocol::Kitty) if caps.kitty_placeholders => {
			Graphics::KittyPlaceholders
		},
		ForcedProtocol::Force(ImageProtocol::Kitty) => Graphics::KittyDirect,
		ForcedProtocol::Force(ImageProtocol::Sixel) => Graphics::Sixel,
		ForcedProtocol::Force(ImageProtocol::Iterm2) => Graphics::Iterm2,
		ForcedProtocol::Disable => Graphics::Cells,
	})
}

#[cfg(unix)]
fn probe_controlling_terminal(
	timeout: Duration,
	inside_tmux: bool,
	include_osc99: bool,
) -> Option<ProbeResults> {
	let mut tty = open(OpenOptions::new().read(true).write(true)).ok()?;
	let original_termios = tcgetattr(&tty).ok()?;
	let mut raw_termios = original_termios.clone();
	cfmakeraw(&mut raw_termios);
	tcsetattr(&tty, SetArg::TCSANOW, &raw_termios).ok()?;
	let Ok(original_flags) = fcntl(&tty, FcntlArg::F_GETFL) else {
		let _ = tcsetattr(&tty, SetArg::TCSANOW, &original_termios);
		return None;
	};
	let flags = OFlag::from_bits_truncate(original_flags);
	if fcntl(&tty, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).is_err() {
		let _ = tcsetattr(&tty, SetArg::TCSANOW, &original_termios);
		return None;
	}

	let result = probe_polled(&mut tty, timeout, inside_tmux, include_osc99);
	let _ = fcntl(&tty, FcntlArg::F_SETFL(flags));
	let _ = tcsetattr(&tty, SetArg::TCSANOW, &original_termios);
	Some(result)
}

#[cfg(unix)]
fn probe_polled(
	tty: &mut fs::File,
	timeout: Duration,
	inside_tmux: bool,
	include_osc99: bool,
) -> ProbeResults {
	let batch = materialize_probe_batch(inside_tmux, include_osc99);
	if tty.write_all(&batch).and_then(|()| tty.flush()).is_err() {
		return ProbeResults { timed_out: true, ..ProbeResults::default() };
	}
	let deadline = Instant::now() + timeout;
	let mut parser = ProbeParser::new();
	let mut preserved = Vec::new();
	let mut buffer = [0; 256];
	while !parser.is_complete() {
		let remaining = deadline.saturating_duration_since(Instant::now());
		if remaining.is_zero() {
			break;
		}
		let mut descriptors = [PollFd::new(tty.as_fd(), PollFlags::POLLIN)];
		let poll_timeout = PollTimeout::try_from(remaining).unwrap_or(PollTimeout::MAX);
		match poll(&mut descriptors, poll_timeout) {
			Ok(0) | Err(_) => break,
			Ok(_) => match tty.read(&mut buffer) {
				Ok(0) => break,
				Ok(read) => parser.feed(&buffer[..read], &mut preserved),
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => {},
				Err(_) => break,
			},
		}
	}
	let timed_out = !parser.is_complete();
	parser.finish(&mut preserved);
	parser.into_results(preserved, timed_out)
}

/// Detects terminal graphics capabilities from the process environment.
pub fn detect() -> TerminalCaps {
	detect_with(
		&|name| env::var(name).ok(),
		TerminalPlatform::current(),
		io::stdout().is_terminal() || overridden(),
	)
}

/// Detects terminal graphics capabilities from an injectable environment.
///
/// This testable core models an interactive standard output; [`detect`] uses
/// the real stdout TTY state for pi-tui's fallback-protocol gate. Empty strings
/// have the same meaning as absent variables, matching JavaScript truthiness.
pub fn detect_from(
	vars: &impl Fn(&str) -> Option<String>,
	platform: TerminalPlatform,
) -> TerminalCaps {
	detect_with(vars, platform, true)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ImageProtocol {
	Kitty,
	Iterm2,
	Sixel,
}

fn value(vars: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
	vars(name).filter(|value| !value.is_empty())
}

fn detect_terminal_id(vars: &impl Fn(&str) -> Option<String>) -> TerminalId {
	for (marker, id) in [
		("KITTY_WINDOW_ID", TerminalId::Kitty),
		("GHOSTTY_RESOURCES_DIR", TerminalId::Ghostty),
		("WEZTERM_PANE", TerminalId::Wezterm),
		("ITERM_SESSION_ID", TerminalId::Iterm2),
		("VSCODE_PID", TerminalId::Vscode),
		("ALACRITTY_WINDOW_ID", TerminalId::Alacritty),
	] {
		if value(vars, marker).is_some() {
			return id;
		}
	}
	if let Some(program) = value(vars, "TERM_PROGRAM") {
		for (name, id) in [
			("kitty", TerminalId::Kitty),
			("ghostty", TerminalId::Ghostty),
			("wezterm", TerminalId::Wezterm),
			("iterm.app", TerminalId::Iterm2),
			("vscode", TerminalId::Vscode),
			("alacritty", TerminalId::Alacritty),
			("warpterminal", TerminalId::Warp),
			("orca", TerminalId::Orca),
			("apple_terminal", TerminalId::Base),
		] {
			if program.eq_ignore_ascii_case(name) {
				return id;
			}
		}
	}
	if value(vars, "TERM").is_some_and(|term| term.to_ascii_lowercase().contains("ghostty")) {
		return TerminalId::Ghostty;
	}
	if value(vars, "COLORTERM").is_some_and(|color| {
		color.eq_ignore_ascii_case("truecolor") || color.eq_ignore_ascii_case("24bit")
	}) {
		return TerminalId::TrueColor;
	}
	TerminalId::Base
}

/// Infers the glyph tier: an explicit `OMP_TUI_CHARSET` wins, a dumb or
/// absent `TERM` degrades to ASCII, emulators that bundle a Nerd Font
/// symbol fallback (glyphs render regardless of the user's configured
/// font) get the Nerd tier, and everything else keeps plain Unicode.
fn detect_charset(vars: &impl Fn(&str) -> Option<String>, id: TerminalId) -> Charset {
	if let Some(forced) = value(vars, FORCE_CHARSET) {
		match forced.trim().to_ascii_lowercase().as_str() {
			"ascii" => return Charset::Ascii,
			"unicode" => return Charset::Unicode,
			"nerd" | "nerdfont" | "nerd-font" => return Charset::NerdFont,
			_ => {},
		}
	}
	if value(vars, "TERM").is_none_or(|term| term.eq_ignore_ascii_case("dumb")) {
		return Charset::Ascii;
	}
	match id {
		TerminalId::Kitty | TerminalId::Ghostty | TerminalId::Wezterm | TerminalId::Warp => {
			Charset::NerdFont
		},
		TerminalId::Base
		| TerminalId::TrueColor
		| TerminalId::Iterm2
		| TerminalId::Vscode
		| TerminalId::Alacritty => Charset::Unicode,
		TerminalId::Orca => Charset::Unicode,
	}
}

fn inside_multiplexer(vars: &impl Fn(&str) -> Option<String>) -> bool {
	if ["TMUX", "STY", "ZELLIJ"]
		.into_iter()
		.any(|name| value(vars, name).is_some())
		|| value(vars, "HERDR_ENV").is_some_and(|value| value == "1")
		|| ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_REMOTE_TRANSPORT"]
			.into_iter()
			.any(|name| value(vars, name).is_some())
	{
		return true;
	}
	value(vars, "TERM").is_some_and(|term| {
		let term = term.to_ascii_lowercase();
		term.starts_with("tmux") || term.starts_with("screen")
	})
}

enum ForcedProtocol {
	Force(ImageProtocol),
	Disable,
}

fn forced_protocol(vars: &impl Fn(&str) -> Option<String>) -> Option<ForcedProtocol> {
	let raw = value(vars, FORCE_IMAGE_PROTOCOL)?;
	let raw = raw.trim().to_ascii_lowercase();
	if raw.is_empty() {
		return None;
	}
	Some(match raw.as_str() {
		"kitty" => ForcedProtocol::Force(ImageProtocol::Kitty),
		"iterm2" | "iterm" => ForcedProtocol::Force(ImageProtocol::Iterm2),
		"sixel" => ForcedProtocol::Force(ImageProtocol::Sixel),
		_ => ForcedProtocol::Disable,
	})
}

fn windows_terminal_sixel(
	vars: &impl Fn(&str) -> Option<String>,
	platform: TerminalPlatform,
) -> bool {
	if platform != TerminalPlatform::Windows || value(vars, "WT_SESSION").is_none() {
		return false;
	}
	if value(vars, "TERM_PROGRAM")
		.is_some_and(|program| !program.eq_ignore_ascii_case("windows_terminal"))
	{
		return false;
	}
	let Some(version) = value(vars, "TERM_PROGRAM_VERSION") else {
		return false;
	};
	let mut parts = version.trim().split('.');
	let major = parts
		.next()
		.filter(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
		.and_then(|part| part.parse::<u32>().ok());
	let minor = parts.next().and_then(|part| {
		let digits = part.bytes().take_while(u8::is_ascii_digit).count();
		(digits > 0)
			.then(|| part[..digits].parse::<u32>().ok())
			.flatten()
	});
	let (Some(major), Some(minor)) = (major, minor) else {
		return false;
	};
	major > 1 || (major == 1 && minor >= 22)
}

fn warp_protocol(
	vars: &impl Fn(&str) -> Option<String>,
	platform: TerminalPlatform,
) -> Option<ImageProtocol> {
	let windows_host = platform == TerminalPlatform::Windows
		|| (platform == TerminalPlatform::Linux
			&& (value(vars, "WSL_DISTRO_NAME").is_some() || value(vars, "WSL_INTEROP").is_some()));
	(!windows_host).then_some(ImageProtocol::Kitty)
}

fn fallback_protocol(
	vars: &impl Fn(&str) -> Option<String>,
	id: TerminalId,
	tty: bool,
) -> Option<ImageProtocol> {
	if !tty || matches!(id, TerminalId::Vscode | TerminalId::Alacritty) {
		return None;
	}
	let term = value(vars, "TERM")?.to_ascii_lowercase();
	(term.contains("screen") || term.contains("tmux") || term.contains("ghostty"))
		.then_some(ImageProtocol::Kitty)
}

fn default_protocol(
	vars: &impl Fn(&str) -> Option<String>,
	platform: TerminalPlatform,
	id: TerminalId,
	tty: bool,
) -> Option<ImageProtocol> {
	let known = match id {
		TerminalId::Kitty | TerminalId::Ghostty | TerminalId::Wezterm => Some(ImageProtocol::Kitty),
		TerminalId::Iterm2 => Some(ImageProtocol::Iterm2),
		TerminalId::Warp => warp_protocol(vars, platform),
		TerminalId::Base | TerminalId::TrueColor | TerminalId::Vscode | TerminalId::Alacritty => None,
		TerminalId::Orca => None,
	};
	let protocol = known.or_else(|| fallback_protocol(vars, id, tty));
	if value(vars, "PASEO_TERMINAL_ID").is_some() && matches!(protocol, Some(ImageProtocol::Kitty)) {
		// Paseo advertises Kitty from its xterm.js-backed PTYs but supports
		// neither Kitty APC graphics nor Unicode placeholders. Apply this
		// after fallback resolution so tmux cannot restore Kitty passthrough.
		None
	} else {
		protocol
	}
}

fn enabled(raw: &str) -> bool {
	matches!(raw.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on" | "yes" | "y")
}

fn disabled(raw: &str) -> bool {
	matches!(raw.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no" | "n")
}

/// Whether Kitty Unicode placeholders are trusted for this environment.
///
/// Kitty and Ghostty render `U=1` placements, tmux included — inside tmux
/// placeholders are in fact the only mode that works, because the outer
/// terminal cannot track pane scroll state for cursor-positioned
/// placements. A forced kitty protocol opts unknown terminals in there
/// (matching `timg -pk`); `OMP_KITTY_PLACEHOLDERS=1` opts in anywhere and
/// `OMP_NO_KITTY_PLACEHOLDERS=1` is a hard opt-out. Detection follows the
/// terminal capability probe.
fn kitty_placeholders(
	vars: &impl Fn(&str) -> Option<String>,
	id: TerminalId,
	inside_tmux: bool,
) -> bool {
	if value(vars, "OMP_NO_KITTY_PLACEHOLDERS").is_some_and(|raw| enabled(&raw)) {
		return false;
	}
	if let Some(raw) = value(vars, "OMP_KITTY_PLACEHOLDERS") {
		if enabled(&raw) {
			return true;
		}
		if disabled(&raw) {
			return false;
		}
	}
	if inside_tmux
		&& value(vars, FORCE_IMAGE_PROTOCOL)
			.is_some_and(|raw| raw.trim().eq_ignore_ascii_case("kitty"))
	{
		return true;
	}
	matches!(id, TerminalId::Kitty | TerminalId::Ghostty)
}

fn synchronized_output_override(vars: &impl Fn(&str) -> Option<String>) -> Option<bool> {
	if value(vars, "OMP_NO_SYNC_OUTPUT").is_some()
		|| value(vars, "OMP_SYNC_OUTPUT").is_some_and(|raw| raw == "0")
	{
		return Some(false);
	}
	if value(vars, "OMP_FORCE_SYNC_OUTPUT").is_some_and(|raw| raw == "1")
		|| value(vars, "OMP_SYNC_OUTPUT").is_some_and(|raw| raw == "1")
	{
		return Some(true);
	}
	None
}

fn synchronized_output_default(
	vars: &impl Fn(&str) -> Option<String>,
	id: TerminalId,
	inside_multiplexer: bool,
) -> bool {
	if let Some(overridden) = synchronized_output_override(vars) {
		return overridden;
	}
	if value(vars, "TERM_FEATURES").is_some_and(|features| features.contains("Sy"))
		|| value(vars, "WT_SESSION").is_some()
	{
		return true;
	}
	if inside_multiplexer {
		return false;
	}
	matches!(
		id,
		TerminalId::Kitty
			| TerminalId::Ghostty
			| TerminalId::Wezterm
			| TerminalId::Iterm2
			| TerminalId::Vscode
			| TerminalId::Alacritty
	)
}

const fn terminal_feature_table(id: TerminalId) -> (bool, bool, bool, bool) {
	match id {
		TerminalId::Kitty => (true, true, true, true),
		TerminalId::Ghostty
		| TerminalId::Wezterm
		| TerminalId::Iterm2
		| TerminalId::Vscode
		| TerminalId::Alacritty => (true, false, false, false),
		TerminalId::Base | TerminalId::TrueColor | TerminalId::Warp => (false, false, false, false),
		TerminalId::Orca => (false, false, false, false),
	}
}

/// Terminals whose source verifiably moves rows scrolled out of a
/// top-anchored DECSTBM region into native scrollback: kitty (`INDEX_UP`,
/// `margin_top == 0`), ghostty (`Terminal.index`, `top == 0`), `WezTerm`
/// (`scroll_region.start == 0`), iTerm2 (`scrollTop == 0` with the default
/// scrollback-with-region profile), Alacritty (`region.start == 0`), and
/// xterm.js/VS Code (`scrollTop === 0`).
const fn margin_scrollback_default(id: TerminalId) -> bool {
	!matches!(id, TerminalId::Base | TerminalId::TrueColor | TerminalId::Warp | TerminalId::Orca)
}

fn parse_major_minor(version: &str) -> Option<(u32, u32)> {
	let version = version.trim();
	let separator = version.find('.')?;
	let major = &version[..separator];
	let minor = version[separator + 1..]
		.bytes()
		.take_while(u8::is_ascii_digit)
		.count();
	if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) || minor == 0 {
		return None;
	}
	Some((major.parse().ok()?, version[separator + 1..separator + 1 + minor].parse().ok()?))
}

fn hyperlinks_default(vars: &impl Fn(&str) -> Option<String>, static_capability: bool) -> bool {
	if value(vars, "OMP_NO_HYPERLINKS").is_some_and(|raw| raw == "1") {
		return false;
	}
	if value(vars, "OMP_FORCE_HYPERLINKS").is_some_and(|raw| raw == "1") {
		return true;
	}
	if !static_capability || value(vars, "STY").is_some() {
		return false;
	}
	if value(vars, "TMUX").is_some() {
		if !value(vars, "TERM_PROGRAM").is_some_and(|program| program.eq_ignore_ascii_case("tmux")) {
			return false;
		}
		return value(vars, "TERM_PROGRAM_VERSION")
			.as_deref()
			.and_then(parse_major_minor)
			.is_some_and(|(major, minor)| major > 3 || (major == 3 && minor >= 4));
	}
	!value(vars, "TERM").is_some_and(|term| {
		let term = term.to_ascii_lowercase();
		term.starts_with("screen") || term.starts_with("tmux")
	})
}

const fn notification_protocol(id: TerminalId) -> NotifyProtocol {
	match id {
		TerminalId::Kitty => NotifyProtocol::Osc99,
		TerminalId::Ghostty | TerminalId::Wezterm | TerminalId::Iterm2 | TerminalId::Warp => {
			NotifyProtocol::Osc9
		},
		TerminalId::Base | TerminalId::TrueColor | TerminalId::Vscode | TerminalId::Alacritty => {
			NotifyProtocol::Bell
		},
		TerminalId::Orca => NotifyProtocol::Bell,
	}
}

const fn jamo_width(id: TerminalId) -> u8 {
	match id {
		TerminalId::Ghostty => 2,
		TerminalId::Warp => 1,
		TerminalId::Orca => 2,
		_ => 0,
	}
}

fn detect_with(
	vars: &impl Fn(&str) -> Option<String>,
	platform: TerminalPlatform,
	tty: bool,
) -> TerminalCaps {
	let id = detect_terminal_id(vars);
	let true_color = id != TerminalId::Base || value(vars, "WT_SESSION").is_some();
	let inside_tmux = value(vars, "TMUX").is_some()
		|| value(vars, "TERM").is_some_and(|term| term.to_ascii_lowercase().starts_with("tmux"));
	let inside_multiplexer = inside_multiplexer(vars);
	let sync_output_override = synchronized_output_override(vars);
	let sync_output = synchronized_output_default(vars, id, inside_multiplexer);
	let (static_hyperlinks, screen_to_scrollback, text_sizing, deccara) = terminal_feature_table(id);
	let margin_scrollback = inside_tmux || (margin_scrollback_default(id) && !inside_multiplexer);
	let hyperlinks = hyperlinks_default(vars, static_hyperlinks);
	let notify = notification_protocol(id);
	let jamo_width = jamo_width(id);
	let forced = forced_protocol(vars);
	let protocol = match forced {
		Some(ForcedProtocol::Force(protocol)) => Some(protocol),
		Some(ForcedProtocol::Disable) => None,
		None => default_protocol(vars, platform, id, tty)
			.or_else(|| windows_terminal_sixel(vars, platform).then_some(ImageProtocol::Sixel)),
	};
	let placeholders = kitty_placeholders(vars, id, inside_tmux);
	let graphics = match protocol {
		Some(ImageProtocol::Kitty) if placeholders => Graphics::KittyPlaceholders,
		Some(ImageProtocol::Kitty) => Graphics::KittyDirect,
		Some(ImageProtocol::Sixel) => Graphics::Sixel,
		Some(ImageProtocol::Iterm2) => Graphics::Iterm2,
		None => Graphics::Cells,
	};
	let graphics = if forced.is_none() && inside_multiplexer && !inside_tmux {
		Graphics::Cells
	} else {
		graphics
	};
	TerminalCaps {
		id,
		true_color,
		charset: detect_charset(vars, id),
		graphics,
		kitty_placeholders: placeholders && graphics == Graphics::KittyPlaceholders,
		cell_px: None,
		sixel_color_registers: None,
		sync_output,
		kitty_keyboard: None,
		screen_to_scrollback,
		margin_scrollback,
		hyperlinks,
		text_sizing,
		deccara,
		notify,
		osc99_confirmed: false,
		background: None,
		appearance_notifications: false,
		in_band_resize: false,
		paste_events: false,
		xterm_scroll_to_bottom_on_output: false,
		xterm_scroll_to_bottom_on_key_press: false,
		jamo_width,
		inside_tmux,
		inside_multiplexer,
		sync_output_override,
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		io::{self, Read, Write},
		time::{Duration, Instant},
	};

	use super::{
		NotifyProtocol, ProbeParser, ProbeResults, TerminalCaps, TerminalPlatform,
		detect as detect_runtime, detect_from, materialize_probe_batch, probe_terminal,
	};
	use crate::{Color, Graphics, InputDecoder, InputEvent, Key, TerminalId, Theme, UiContext};

	fn detect(entries: &[(&str, &str)], platform: TerminalPlatform) -> TerminalCaps {
		let vars = entries.iter().copied().collect::<HashMap<_, _>>();
		detect_from(&|name| vars.get(name).map(|value| (*value).to_owned()), platform)
	}

	fn parse(chunks: impl IntoIterator<Item = Vec<u8>>) -> (ProbeResults, Vec<u8>) {
		let mut parser = ProbeParser::new();
		let mut preserved = Vec::new();
		for chunk in chunks {
			parser.feed(&chunk, &mut preserved);
		}
		parser.finish(&mut preserved);
		(parser.results().clone(), preserved)
	}

	#[test]
	fn charset_follows_terminal_identity_and_env_override() {
		use crate::Charset;
		// Emulators bundling Nerd Font symbol fallbacks get the nerd tier.
		let ghostty = detect(
			&[("TERM", "xterm-ghostty"), ("GHOSTTY_RESOURCES_DIR", "/r")],
			TerminalPlatform::Other,
		);
		assert_eq!(ghostty.charset, Charset::NerdFont);
		// Unknown emulators stay at plain Unicode.
		let base = detect(&[("TERM", "xterm-256color")], TerminalPlatform::Other);
		assert_eq!(base.charset, Charset::Unicode);
		// A dumb or absent TERM degrades to ASCII.
		assert_eq!(detect(&[], TerminalPlatform::Other).charset, Charset::Ascii);
		assert_eq!(detect(&[("TERM", "dumb")], TerminalPlatform::Other).charset, Charset::Ascii);
		// The explicit override beats every heuristic.
		let forced = detect(
			&[("TERM", "xterm-ghostty"), ("OMP_TUI_CHARSET", "ascii")],
			TerminalPlatform::Other,
		);
		assert_eq!(forced.charset, Charset::Ascii);
		// Context threading: apply_terminal_caps adopts the tier.
		let ctx = UiContext::default().with_terminal_caps(&ghostty);
		assert_eq!(ctx.charset, Charset::NerdFont);
	}

	#[test]
	fn apple_terminal_quantizes_theme_colors_to_indexed_sgr() {
		let caps = detect(
			&[
				("TERM_PROGRAM", "Apple_Terminal"),
				("TERM", "xterm-256color"),
				("COLORTERM", "truecolor"),
			],
			TerminalPlatform::MacOs,
		);
		assert_eq!(caps.id, TerminalId::Base);
		assert!(!caps.true_color);

		let context = UiContext {
			theme: Theme { accent: Color::Rgb(0xf5, 0xe0, 0xac), ..Theme::default() },
			..UiContext::default()
		}
		.with_terminal_caps(&caps);
		assert_eq!(context.theme.accent, Color::Indexed(223));
	}
	#[test]
	fn orca_uses_wide_hangul_compatibility_jamo_only_for_orca() {
		let orca = detect(
			&[("TERM_PROGRAM", "Orca"), ("TERM", "xterm-256color"), ("COLORTERM", "truecolor")],
			TerminalPlatform::MacOs,
		);
		assert_eq!(orca.id, TerminalId::Orca);
		assert_eq!(orca.jamo_width, 2);
		let iterm = detect(
			&[("TERM_PROGRAM", "iTerm.app"), ("TERM", "xterm-256color")],
			TerminalPlatform::MacOs,
		);
		assert_eq!(iterm.jamo_width, 0);
	}

	#[test]
	fn parser_extracts_full_response_set() {
		let responses = concat!(
			"\x1b_Gi=31;OK\x1b\\\x1b[?2;1;256S\x1b[6;20;10t",
			"\x1b]11;rgb:1/345/abcd\x07",
			"\x1b]99;i=omp-tui:p=?;p=title,body;\x1b\\",
			"\x1b[4;1$y\x1b[20;2$y",
			"\x1b[?1010;1$y\x1b[?1011;2$y\x1b[?2026;2$y\x1b[?2031;1$y\x1b[?2048;2$y",
			"\x1b[?5522;2$y",
			"\x1b[?5u\x1b[?1;2;4c",
		)
		.as_bytes()
		.to_vec();
		let (results, preserved) = parse([responses]);
		assert_eq!(results.kitty_graphics, Some(true));
		assert_eq!(results.sixel_color_registers, Some(256));
		assert_eq!(results.sixel_status, Some(1));
		assert_eq!(results.cell_px, Some((10, 20)));
		assert_eq!(results.da1_attributes, Some(vec![1, 2, 4]));
		assert_eq!(results.sync_output, Some(true));
		assert_eq!(results.kitty_keyboard, Some(5));
		assert_eq!(results.background, Some((0x1111, 0x3453, 0xabcd)));
		assert!(results.osc99_confirmed);
		assert!(results.insert_mode_set);
		assert!(!results.newline_mode_set);
		assert!(results.appearance_notifications);
		assert!(results.appearance_notifications_set);
		assert!(results.in_band_resize);
		assert!(!results.in_band_resize_set);
		assert!(results.paste_events);
		assert!(results.xterm_scroll_to_bottom_on_output);
		assert!(!results.xterm_scroll_to_bottom_on_key_press);
		assert!(results.supports_sixel());
		assert!(preserved.is_empty());
	}

	#[test]
	fn parser_accepts_every_response_split_one_byte_at_a_time() {
		let responses = concat!(
			"\x1b_Gi=31;OK\x1b\\\x1b[?2;1;1024S\x1b[6;18;9t",
			"\x1b]11;rgba:11/22/33\x1b\\\x1b[4;2$y\x1b[20;1$y",
			"\x1b[?2031;2$y\x1b[?2048;1$y\x1b[?5522;2$y\x1b[?1;4c",
		)
		.as_bytes();
		let (results, preserved) = parse(responses.iter().map(|byte| vec![*byte]));
		assert_eq!(results.kitty_graphics, Some(true));
		assert_eq!(results.sixel_color_registers, Some(1024));
		assert_eq!(results.cell_px, Some((9, 18)));
		assert_eq!(results.background, Some((0x1111, 0x2222, 0x3333)));
		assert!(!results.insert_mode_set);
		assert!(results.newline_mode_set);
		assert!(results.appearance_notifications);
		assert!(!results.appearance_notifications_set);
		assert!(results.in_band_resize);
		assert!(results.in_band_resize_set);
		assert!(results.paste_events);
		assert!(results.supports_sixel());
		assert!(preserved.is_empty());
	}

	#[test]
	fn parser_preserves_interleaved_keystrokes_in_order() {
		let bytes = b"x\x1b_Gi=31;OK\x1b\\\x1b[A\x1b[6;18;9tyz\x1b[?1c";
		let (results, preserved) = parse(bytes.iter().map(|byte| vec![*byte]));
		assert_eq!(preserved, b"x\x1b[Ayz");
		let mut decoder = InputDecoder::new();
		let mut events = Vec::new();
		decoder.feed(&preserved, Instant::now(), &mut events);
		assert_eq!(events, [
			InputEvent::Key(Key::Char('x')),
			InputEvent::Key(Key::Up),
			InputEvent::Key(Key::Char('y')),
			InputEvent::Key(Key::Char('z')),
		]);
		assert!(results.da1_attributes.is_some());
	}

	#[test]
	fn da1_attribute_four_enables_sixel() {
		let (results, _) = parse([b"\x1b[?62;4;22c".to_vec()]);
		assert!(results.supports_sixel());
	}

	#[test]
	fn xtsmgraphics_geometry_reply_gates_sixel_on_status_and_geometry() {
		// XTSMGRAPHICS item 2 reply captured from foot 1.27: status 0
		// (success) plus the terminal's maximum SIXEL geometry in pixels.
		let (results, preserved) = parse([b"\x1b[?2;0;1692;432S".to_vec()]);
		assert_eq!(results.sixel_status, Some(0));
		assert_eq!(results.sixel_color_registers, Some(1692));
		assert!(results.supports_sixel());
		assert!(preserved.is_empty());

		// Status 0 with a zero maximum geometry means no SIXEL support.
		let (results, _) = parse([b"\x1b[?2;0;0;0S".to_vec()]);
		assert!(!results.supports_sixel());

		// A non-zero status is an error reply even with a plausible geometry.
		let (results, _) = parse([b"\x1b[?2;3;1000;1000S".to_vec()]);
		assert!(!results.supports_sixel());

		// Oversized geometry parts saturate instead of rejecting the reply.
		let (results, preserved) = parse([b"\x1b[?2;0;100000S".to_vec()]);
		assert_eq!(results.sixel_color_registers, Some(u16::MAX));
		assert!(results.supports_sixel());
		assert!(preserved.is_empty());
	}

	#[test]
	fn probe_detects_sixel_on_terminals_without_identifying_environment() {
		// Regression: a SIXEL-capable terminal that exports no
		// identifying variable (foot sets TERM=foot and COLORTERM=truecolor
		// only) resolved the trueColor row and rendered every image as the
		// `[Image: …]` text card. The runtime probe must upgrade it.
		let foot = detect(&[("TERM", "foot"), ("COLORTERM", "truecolor")], TerminalPlatform::Linux);
		assert_eq!(foot.graphics, Graphics::Cells);
		let (probe, _) = parse([b"\x1b[?2;0;1692;432S\x1b[?62;4c".to_vec()]);
		assert_eq!(TerminalCaps::resolve(foot, Some(&probe), None).graphics, Graphics::Sixel);
		// An explicit force — including the `off` kill switch resolved to
		// [`Graphics::Cells`] — wins over the probe.
		assert_eq!(
			TerminalCaps::resolve(foot, Some(&probe), Some(Graphics::Cells)).graphics,
			Graphics::Cells
		);
	}

	#[test]
	fn synchronized_output_probe_refines_defaults_without_demoting_on_no_reply() {
		let kitty = detect(&[("KITTY_WINDOW_ID", "1")], TerminalPlatform::Linux);
		assert!(kitty.sync_output);
		assert!(
			TerminalCaps::resolve(kitty, Some(&ProbeResults::default()), None).sync_output,
			"an absent DECRPM reply must preserve the positive environment default"
		);
		let unsupported = ProbeResults { sync_output: Some(false), ..ProbeResults::default() };
		assert!(!TerminalCaps::resolve(kitty, Some(&unsupported), None).sync_output);

		let base = detect(&[], TerminalPlatform::Linux);
		assert!(!base.sync_output);
		for status in [1, 2] {
			let response = format!("\x1b[?2026;{status}$y").into_bytes();
			let (probe, preserved) = parse([response]);
			assert_eq!(probe.sync_output, Some(true));
			assert!(preserved.is_empty());
			assert!(TerminalCaps::resolve(base, Some(&probe), None).sync_output);
		}
		for status in [0, 3, 4] {
			let response = format!("\x1b[?2026;{status}$y").into_bytes();
			let (probe, preserved) = parse([response]);
			assert_eq!(probe.sync_output, Some(false));
			assert!(preserved.is_empty());
		}
	}

	#[test]
	fn ansi_mode_probes_only_record_set_changeable_modes() {
		for mode in [4, 20] {
			for status in 0..=4 {
				let response = format!("\x1b[{mode};{status}$y").into_bytes();
				let (probe, preserved) = parse([response]);
				assert!(preserved.is_empty());
				assert_eq!(
					probe.insert_mode_set,
					mode == 4 && status == 1,
					"mode {mode}, status {status}"
				);
				assert_eq!(
					probe.newline_mode_set,
					mode == 20 && status == 1,
					"mode {mode}, status {status}"
				);
			}
		}
	}

	#[test]
	fn notification_mode_probes_preserve_support_and_prior_state() {
		for mode in [2031, 2048] {
			for status in 0..=4 {
				let response = format!("\x1b[?{mode};{status}$y").into_bytes();
				let (probe, preserved) = parse([response]);
				let supported = matches!(status, 1..=3);
				let set = matches!(status, 1 | 3);
				assert!(preserved.is_empty());
				assert_eq!(
					probe.appearance_notifications,
					mode == 2031 && supported,
					"mode {mode}, status {status}"
				);
				assert_eq!(
					probe.appearance_notifications_set,
					mode == 2031 && set,
					"mode {mode}, status {status}"
				);
				assert_eq!(
					probe.in_band_resize,
					mode == 2048 && supported,
					"mode {mode}, status {status}"
				);
				assert_eq!(
					probe.in_band_resize_set,
					mode == 2048 && set,
					"mode {mode}, status {status}"
				);
			}
		}
	}

	#[test]
	fn xterm_scroll_to_bottom_probes_only_record_set_changeable_modes() {
		for mode in [1010, 1011] {
			for status in [1, 2, 3, 4] {
				let response = format!("\x1b[?{mode};{status}$y").into_bytes();
				let (probe, preserved) = parse([response]);
				assert!(preserved.is_empty());
				assert_eq!(
					probe.xterm_scroll_to_bottom_on_output,
					mode == 1010 && status == 1,
					"mode {mode}, status {status}"
				);
				assert_eq!(
					probe.xterm_scroll_to_bottom_on_key_press,
					mode == 1011 && status == 1,
					"mode {mode}, status {status}"
				);
			}
		}
	}

	#[test]
	fn kitty_keyboard_flags_parse_across_chunk_boundaries() {
		let (probe, preserved) = parse(b"\x1b[?13u".iter().map(|byte| vec![*byte]));
		assert_eq!(probe.kitty_keyboard, Some(13));
		assert!(preserved.is_empty());
		let base = detect(&[], TerminalPlatform::Linux);
		assert_eq!(TerminalCaps::resolve(base, Some(&probe), None).kitty_keyboard, Some(13));
	}

	#[test]
	fn synchronized_output_environment_override_precedes_probe() {
		let positive_probe = ProbeResults { sync_output: Some(true), ..ProbeResults::default() };
		let negative_probe = ProbeResults { sync_output: Some(false), ..ProbeResults::default() };

		for variables in [
			&[("KITTY_WINDOW_ID", "1"), ("OMP_NO_SYNC_OUTPUT", "1")][..],
			&[("KITTY_WINDOW_ID", "1"), ("OMP_SYNC_OUTPUT", "0")][..],
			&[
				("KITTY_WINDOW_ID", "1"),
				("OMP_NO_SYNC_OUTPUT", "anything"),
				("OMP_FORCE_SYNC_OUTPUT", "1"),
			][..],
		] {
			let caps = detect(variables, TerminalPlatform::Linux);
			assert!(!caps.sync_output);
			assert!(!TerminalCaps::resolve(caps, Some(&positive_probe), None).sync_output);
		}
		for variables in [&[("OMP_FORCE_SYNC_OUTPUT", "1")][..], &[("OMP_SYNC_OUTPUT", "1")][..]] {
			let caps = detect(variables, TerminalPlatform::Linux);
			assert!(caps.sync_output);
			assert!(TerminalCaps::resolve(caps, Some(&negative_probe), None).sync_output);
		}
	}

	#[test]
	fn hyperlink_policy_matches_overrides_and_multiplexer_gates() {
		assert!(detect(&[("GHOSTTY_RESOURCES_DIR", "1")], TerminalPlatform::Linux).hyperlinks);
		assert!(
			!detect(
				&[
					("GHOSTTY_RESOURCES_DIR", "1"),
					("OMP_NO_HYPERLINKS", "1"),
					("OMP_FORCE_HYPERLINKS", "1"),
				],
				TerminalPlatform::Linux,
			)
			.hyperlinks
		);
		assert!(
			detect(&[("OMP_FORCE_HYPERLINKS", "1")], TerminalPlatform::Linux).hyperlinks,
			"force-on may upgrade the conservative base table"
		);
		assert!(
			!detect(&[("GHOSTTY_RESOURCES_DIR", "1"), ("STY", "screen")], TerminalPlatform::Linux,)
				.hyperlinks
		);
		for (version, expected) in [("3.3a", false), ("3.4", true), ("4.0", true)] {
			assert_eq!(
				detect(
					&[
						("GHOSTTY_RESOURCES_DIR", "1"),
						("TMUX", "/tmp/tmux"),
						("TERM", "screen-256color"),
						("TERM_PROGRAM", "tmux"),
						("TERM_PROGRAM_VERSION", version),
					],
					TerminalPlatform::Linux,
				)
				.hyperlinks,
				expected
			);
		}
		assert!(
			!detect(
				&[("GHOSTTY_RESOURCES_DIR", "1"), ("TERM", "tmux-256color")],
				TerminalPlatform::Linux,
			)
			.hyperlinks
		);
	}

	#[test]
	fn terminal_capability_matrix_matches_pi() {
		let cases = [
			(
				&[("KITTY_WINDOW_ID", "1")][..],
				(true, None, true, true, true, true, true, NotifyProtocol::Osc99, 0),
			),
			(
				&[("GHOSTTY_RESOURCES_DIR", "1")][..],
				(true, None, false, true, true, false, false, NotifyProtocol::Osc9, 2),
			),
			(
				&[("WEZTERM_PANE", "1")][..],
				(true, None, false, true, true, false, false, NotifyProtocol::Osc9, 0),
			),
			(
				&[("ITERM_SESSION_ID", "1")][..],
				(true, None, false, true, true, false, false, NotifyProtocol::Osc9, 0),
			),
			(
				&[("ALACRITTY_WINDOW_ID", "1")][..],
				(true, None, false, true, true, false, false, NotifyProtocol::Bell, 0),
			),
			(
				&[("VSCODE_PID", "1")][..],
				(true, None, false, true, true, false, false, NotifyProtocol::Bell, 0),
			),
			(
				&[("TERM_PROGRAM", "WarpTerminal")][..],
				(false, None, false, false, false, false, false, NotifyProtocol::Osc9, 1),
			),
			(&[][..], (false, None, false, false, false, false, false, NotifyProtocol::Bell, 0)),
		];
		for (variables, expected) in cases {
			let caps = detect(variables, TerminalPlatform::MacOs);
			assert_eq!(
				(
					caps.sync_output,
					caps.kitty_keyboard,
					caps.screen_to_scrollback,
					caps.margin_scrollback,
					caps.hyperlinks,
					caps.text_sizing,
					caps.deccara,
					caps.notify,
					caps.jamo_width,
				),
				expected,
				"capabilities for {:?}",
				caps.id
			);
			assert!(!caps.osc99_confirmed);
			assert_eq!(caps.background, None);
			assert!(!caps.appearance_notifications);
			assert!(!caps.in_band_resize);
		}
		assert_eq!(
			detect(&[("TERM_PROGRAM", "WarpTerminal")], TerminalPlatform::MacOs).graphics,
			Graphics::KittyDirect
		);
		assert_eq!(
			detect(&[("TERM_PROGRAM", "WarpTerminal")], TerminalPlatform::Windows).graphics,
			Graphics::Cells
		);
		assert_eq!(
			detect(&[("ITERM_SESSION_ID", "1")], TerminalPlatform::MacOs).graphics,
			Graphics::Iterm2
		);
	}

	#[test]
	fn margin_scrollback_prefers_tmux_and_gates_other_multiplexers() {
		assert!(detect(&[("TMUX", "/tmp/sock,1,0")], TerminalPlatform::MacOs).margin_scrollback);
		assert!(
			detect(
				&[("TMUX", "/tmp/sock,1,0"), ("TERM_PROGRAM", "WarpTerminal")],
				TerminalPlatform::MacOs
			)
			.margin_scrollback
		);
		assert!(
			!detect(&[("ZELLIJ", "1"), ("GHOSTTY_RESOURCES_DIR", "1")], TerminalPlatform::MacOs)
				.margin_scrollback
		);
	}

	#[test]
	fn additional_probe_results_refine_terminal_caps() {
		let probe = ProbeResults {
			background: Some((0x1111, 0x2222, 0x3333)),
			osc99_confirmed: true,
			appearance_notifications: true,
			in_band_resize: true,
			paste_events: true,
			xterm_scroll_to_bottom_on_output: true,
			xterm_scroll_to_bottom_on_key_press: true,
			..ProbeResults::default()
		};
		let caps = TerminalCaps::resolve(
			detect(&[("KITTY_WINDOW_ID", "1")], TerminalPlatform::Linux),
			Some(&probe),
			None,
		);
		assert_eq!(caps.background, probe.background);
		assert!(caps.osc99_confirmed);
		assert!(caps.appearance_notifications);
		assert!(caps.in_band_resize);
		assert!(caps.paste_events);
		assert!(caps.xterm_scroll_to_bottom_on_output);
		assert!(caps.xterm_scroll_to_bottom_on_key_press);
	}

	#[test]
	fn osc99_probe_is_omitted_inside_multiplexers() {
		let direct = materialize_probe_batch(false, true);
		assert!(
			direct
				.windows(b"]99;".len())
				.any(|window| window == b"]99;")
		);
		assert!(
			direct
				.windows(b"\x1b[?5522$p".len())
				.any(|window| window == b"\x1b[?5522$p")
		);
		for batch in [materialize_probe_batch(true, false), materialize_probe_batch(false, false)] {
			assert!(!batch.windows(b"]99;".len()).any(|window| window == b"]99;"));
		}
	}

	#[test]
	fn runtime_precedence_is_forced_then_probe_then_environment() {
		let env = detect(&[("KITTY_WINDOW_ID", "1")], TerminalPlatform::Linux);
		assert_eq!(env.graphics, Graphics::KittyPlaceholders);
		let no_sixel = ProbeResults { da1_attributes: Some(vec![1, 2]), ..ProbeResults::default() };
		assert_eq!(TerminalCaps::resolve(env, Some(&no_sixel), None).graphics, Graphics::Cells);
		assert_eq!(
			TerminalCaps::resolve(env, Some(&no_sixel), Some(Graphics::Sixel)).graphics,
			Graphics::Sixel
		);
	}

	#[test]
	fn inconclusive_probe_keeps_fallback_but_conclusive_sixel_results_override() {
		let ghostty = detect(&[("GHOSTTY_RESOURCES_DIR", "1")], TerminalPlatform::Linux);
		let cell_only = ProbeResults { cell_px: Some((9, 18)), ..ProbeResults::default() };
		let resolved = TerminalCaps::resolve(ghostty, Some(&cell_only), None);
		assert_eq!(resolved.graphics, Graphics::KittyPlaceholders);
		assert_eq!(resolved.cell_px, Some((9, 18)));

		let windows_terminal = detect(
			&[
				("WT_SESSION", "id"),
				("TERM_PROGRAM", "Windows_Terminal"),
				("TERM_PROGRAM_VERSION", "1.22.0"),
			],
			TerminalPlatform::Windows,
		);
		assert_eq!(windows_terminal.graphics, Graphics::Sixel);
		let da1_negative =
			ProbeResults { da1_attributes: Some(vec![1, 2]), ..ProbeResults::default() };
		assert_eq!(
			TerminalCaps::resolve(windows_terminal, Some(&da1_negative), None).graphics,
			Graphics::Cells
		);

		let xtsm_positive = ProbeResults {
			sixel_status: Some(0),
			sixel_color_registers: Some(256),
			..ProbeResults::default()
		};
		let base = detect(&[], TerminalPlatform::Linux);
		assert_eq!(TerminalCaps::resolve(base, Some(&xtsm_positive), None).graphics, Graphics::Sixel);
	}

	#[test]
	fn tmux_carries_probed_kitty_but_zellij_degrades_it() {
		let kitty = ProbeResults { kitty_graphics: Some(true), ..ProbeResults::default() };
		let tmux =
			detect(&[("TMUX", "/tmp/tmux"), ("TERM", "tmux-256color")], TerminalPlatform::Linux);
		let resolved = TerminalCaps::resolve(tmux, Some(&kitty), None);
		assert!(resolved.inside_tmux);
		assert_eq!(resolved.graphics, Graphics::KittyDirect);

		let zellij = detect(&[("ZELLIJ", "1"), ("WEZTERM_PANE", "1")], TerminalPlatform::Linux);
		assert_eq!(TerminalCaps::resolve(zellij, Some(&kitty), None).graphics, Graphics::Cells);
		assert_eq!(
			TerminalCaps::resolve(zellij, Some(&kitty), Some(Graphics::KittyDirect)).graphics,
			Graphics::KittyDirect
		);
		let env_forced =
			detect(&[("ZELLIJ", "1"), ("OMP_FORCE_IMAGE_PROTOCOL", "kitty")], TerminalPlatform::Linux);
		assert_eq!(TerminalCaps::resolve(env_forced, None, None).graphics, Graphics::KittyDirect);
	}

	#[test]
	fn zero_response_timeout_keeps_environment_fallback_and_emits_one_batch() {
		#[derive(Default)]
		struct EmptyTty(Vec<u8>);
		impl Read for EmptyTty {
			fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
				Err(io::ErrorKind::WouldBlock.into())
			}
		}
		impl Write for EmptyTty {
			fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
				self.0.extend_from_slice(bytes);
				Ok(bytes.len())
			}

			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}

		let mut tty = EmptyTty::default();
		let probe = probe_terminal(&mut tty, Duration::from_millis(2));
		assert!(probe.timed_out);
		assert!(probe.preserved_input.is_empty());
		let detected = detect_runtime();
		assert_eq!(
			tty.0,
			materialize_probe_batch(
				detected.inside_tmux,
				detected.notify == NotifyProtocol::Osc99 && !detected.inside_multiplexer,
			)
			.as_ref()
		);
		let env = detect(&[("GHOSTTY_RESOURCES_DIR", "1")], TerminalPlatform::Linux);
		assert_eq!(TerminalCaps::resolve(env, Some(&probe), None).graphics, env.graphics);
	}

	#[test]
	fn direct_and_placeholder_environment_table_matches_pi() {
		for marker in ["GHOSTTY_RESOURCES_DIR", "KITTY_WINDOW_ID"] {
			assert_eq!(
				detect(&[(marker, "1")], TerminalPlatform::Linux).graphics,
				Graphics::KittyPlaceholders
			);
		}
		assert_eq!(
			detect(&[("WEZTERM_PANE", "1")], TerminalPlatform::Linux).graphics,
			Graphics::KittyDirect
		);
		assert_eq!(
			detect(&[("ITERM_SESSION_ID", "1")], TerminalPlatform::Linux).graphics,
			Graphics::Iterm2
		);
		assert_eq!(
			detect(&[("TERM_PROGRAM", "WarpTerminal")], TerminalPlatform::MacOs).graphics,
			Graphics::KittyDirect
		);
	}

	#[test]
	fn paseo_embedder_disables_direct_placeholder_and_tmux_fallback_graphics() {
		assert_eq!(
			detect(
				&[("TERM_PROGRAM", "kitty"), ("PASEO_TERMINAL_ID", "term-1")],
				TerminalPlatform::Linux,
			)
			.graphics,
			Graphics::Cells
		);
		assert_eq!(
			detect(
				&[
					("TERM_PROGRAM", "kitty"),
					("PASEO_TERMINAL_ID", "term-1"),
					("OMP_NO_KITTY_PLACEHOLDERS", "1"),
				],
				TerminalPlatform::Linux,
			)
			.graphics,
			Graphics::Cells
		);
		assert_eq!(
			detect(
				&[
					("TERM_PROGRAM", "kitty"),
					("PASEO_TERMINAL_ID", "term-1"),
					("TMUX", "/tmp/tmux"),
					("TERM", "tmux-256color"),
				],
				TerminalPlatform::Linux,
			)
			.graphics,
			Graphics::Cells
		);
		assert_eq!(
			detect(
				&[("PASEO_TERMINAL_ID", "term-1"), ("TERM", "tmux-256color")],
				TerminalPlatform::Linux,
			)
			.graphics,
			Graphics::Cells
		);
		assert_eq!(
			detect(&[("TERM", "tmux-256color")], TerminalPlatform::Linux).graphics,
			Graphics::KittyDirect,
			"the tmux fallback remains available outside Paseo"
		);
	}

	#[test]
	fn tmux_placeholder_matrix_matches_pi() {
		// Kitty/Ghostty render placeholders through tmux passthrough; direct
		// cursor-positioned placements are what tmux cannot carry.
		let ghostty_tmux: &[(&str, &str)] =
			&[("GHOSTTY_RESOURCES_DIR", "1"), ("TMUX", "/tmp/tmux"), ("TERM", "tmux-256color")];
		let caps = detect(ghostty_tmux, TerminalPlatform::Linux);
		assert!(caps.inside_tmux);
		assert_eq!(caps.graphics, Graphics::KittyPlaceholders);

		// Unknown terminals in tmux can force the OMP kitty protocol to use
		// placeholders, matching the equivalent `timg -pk` behavior.
		let forced_unknown: &[(&str, &str)] =
			&[("TMUX", "/tmp/tmux"), ("TERM", "tmux-256color"), ("OMP_FORCE_IMAGE_PROTOCOL", "kitty")];
		let caps = detect(forced_unknown, TerminalPlatform::Linux);
		assert_eq!(caps.graphics, Graphics::KittyPlaceholders);

		// The hard opt-out still wins for known-broken builds.
		let opted_out: &[(&str, &str)] = &[
			("GHOSTTY_RESOURCES_DIR", "1"),
			("TMUX", "/tmp/tmux"),
			("TERM", "tmux-256color"),
			("OMP_NO_KITTY_PLACEHOLDERS", "1"),
		];
		let caps = detect(opted_out, TerminalPlatform::Linux);
		assert_ne!(caps.graphics, Graphics::KittyPlaceholders);
	}
}
