//! Terminal profile: which terminal and multiplexers host the process and
//! what they support.
//!
//! Every decision reads an explicit [`Env`] (the JS host passes `Bun.env` or a
//! test's override object) so detection stays deterministic. The JS host
//! keeps a plain-data snapshot of [`Profile`] (`TERMINAL`) because components
//! read it per render; the engine builds its own [`Facts`] from the same
//! policy ([`engine_facts`]).
//!
//! - [`multiplexer`]: multiplexer registry and classification.
//! - [`tmux`]: tmux client queries and pane side effects.
//! - [`notify`]: notification formats and delivery.
//! - [`glyph`]: Glyph Protocol bundle and handshake payloads.

pub mod glyph;
pub(crate) mod js;
pub mod multiplexer;
pub mod notify;
pub mod tmux;

use std::collections::HashMap;

use self::multiplexer::{HyperlinkPolicy, Multiplexer};
use super::types::{
	BackgroundCache, Facts, ImageProtocol, Millis, MultiplexerFacts, ResizeScrollback, TspProbe,
};

/// A process environment: variable name → value. Unset and empty differ only
/// where the JS policy compared values; [`Env::set`] is JS truthiness.
#[derive(Clone, Debug, Default)]
pub struct Env(HashMap<String, String>);

impl Env {
	pub const fn new(vars: HashMap<String, String>) -> Self {
		Self(vars)
	}

	pub fn get(&self, key: &str) -> Option<&str> {
		self.0.get(key).map(String::as_str)
	}

	/// Set and non-empty.
	pub fn set(&self, key: &str) -> bool {
		self.get(key).is_some_and(|value| !value.is_empty())
	}

	/// Case-insensitive equality of a variable with `expected`.
	fn is(&self, key: &str, expected: &str) -> bool {
		self
			.get(key)
			.is_some_and(|value| value.eq_ignore_ascii_case(expected))
	}

	/// Boolean-ish flag (`1`, `y`, `yes`, `true`, `on` in lower or upper case),
	/// `$flag` in pi-utils.
	fn flag(&self, key: &str) -> bool {
		matches!(self.get(key), Some("1" | "Y" | "y" | "TRUE" | "true" | "YES" | "yes" | "ON" | "on"))
	}

	pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
		self
			.0
			.iter()
			.map(|(key, value)| (key.as_str(), value.as_str()))
	}

	#[cfg(test)]
	pub fn of(pairs: &[(&str, &str)]) -> Self {
		Self(
			pairs
				.iter()
				.map(|&(key, value)| (key.to_owned(), value.to_owned()))
				.collect(),
		)
	}
}

/// The OS the process runs on (`process.platform`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
	Linux,
	Darwin,
	Win32,
	Other,
}

impl Platform {
	/// The platform named by Node's `process.platform`, falling back to the
	/// compile target when JS passes none. JS passes it so detection follows a
	/// test's simulated platform exactly as the JS implementation did.
	pub fn from_node(platform: Option<&str>) -> Self {
		match platform {
			Some("linux") => Self::Linux,
			Some("darwin") => Self::Darwin,
			Some("win32") => Self::Win32,
			Some(_) => Self::Other,
			None => Self::current(),
		}
	}

	pub const fn current() -> Self {
		if cfg!(windows) {
			Self::Win32
		} else if cfg!(target_os = "macos") {
			Self::Darwin
		} else if cfg!(target_os = "linux") {
			Self::Linux
		} else {
			Self::Other
		}
	}
}

/// WSL reports `linux`, so the only reliable signal is the
/// `WSL_DISTRO_NAME`/`WSL_INTEROP` variables the interop layer injects.
fn is_wsl(platform: Platform, env: &Env) -> bool {
	platform == Platform::Linux && (env.set("WSL_DISTRO_NAME") || env.set("WSL_INTEROP"))
}

/// Terminals omp recognizes, plus the two fallback profiles.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalId {
	Kitty,
	Ghostty,
	Wezterm,
	Iterm2,
	Vscode,
	Alacritty,
	Warp,
	Orca,
	Otty,
	Rio,
	Tern,
	Monstar,
	Rex,
	Base,
	TrueColor,
}

impl TerminalId {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Kitty => "kitty",
			Self::Ghostty => "ghostty",
			Self::Wezterm => "wezterm",
			Self::Iterm2 => "iterm2",
			Self::Vscode => "vscode",
			Self::Alacritty => "alacritty",
			Self::Warp => "warp",
			Self::Orca => "orca",
			Self::Otty => "otty",
			Self::Rio => "rio",
			Self::Tern => "tern",
			Self::Monstar => "monstar",
			Self::Rex => "rex",
			Self::Base => "base",
			Self::TrueColor => "trueColor",
		}
	}

	/// The terminal a `TERM_PROGRAM` value (or tmux client name) names.
	fn from_program(program: &str) -> Option<Self> {
		const PROGRAMS: [(&str, TerminalId); 14] = [
			("kitty", TerminalId::Kitty),
			("ghostty", TerminalId::Ghostty),
			("wezterm", TerminalId::Wezterm),
			("iterm.app", TerminalId::Iterm2),
			("iterm2", TerminalId::Iterm2),
			("vscode", TerminalId::Vscode),
			("alacritty", TerminalId::Alacritty),
			("warpterminal", TerminalId::Warp),
			("orca", TerminalId::Orca),
			("otty", TerminalId::Otty),
			("rio", TerminalId::Rio),
			("tern", TerminalId::Tern),
			("monstar", TerminalId::Monstar),
			("rex", TerminalId::Rex),
		];
		PROGRAMS
			.iter()
			.find(|(name, _)| program.eq_ignore_ascii_case(name))
			.map(|&(_, id)| id)
	}
}

/// How the terminal surfaces a notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyProtocol {
	Bell,
	Osc99,
	Osc9,
}

impl NotifyProtocol {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Bell => "bell",
			Self::Osc99 => "osc99",
			Self::Osc9 => "osc9",
		}
	}

	pub fn parse(name: &str) -> Option<Self> {
		[Self::Bell, Self::Osc99, Self::Osc9]
			.into_iter()
			.find(|protocol| protocol.as_str() == name)
	}
}

/// Static capabilities of a terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalInfo {
	pub image_protocol:       Option<ImageProtocol>,
	pub true_color:           bool,
	pub hyperlinks:           bool,
	pub notify:               NotifyProtocol,
	pub deccara:              bool,
	pub screen_to_scrollback: bool,
	/// Renders the Kitty OSC 66 text-sizing protocol (scaled spans). Kitty
	/// only.
	pub text_sizing:          bool,
	/// Hangul Compatibility Jamo (U+3131..=U+318E) cell width. Ghostty and Orca
	/// follow UAX#11 (2 cells); Warp paints 1; `None` keeps the platform
	/// default (macOS narrow, otherwise UAX#11).
	pub hangul_jamo_width:    Option<u8>,
}

impl TerminalInfo {
	const fn new(
		image_protocol: Option<ImageProtocol>,
		true_color: bool,
		hyperlinks: bool,
		notify: NotifyProtocol,
	) -> Self {
		Self {
			image_protocol,
			true_color,
			hyperlinks,
			notify,
			deccara: false,
			screen_to_scrollback: false,
			text_sizing: false,
			hangul_jamo_width: None,
		}
	}
}

/// Static capabilities of `id`. Warp's image protocol depends on the host
/// platform (see [`warp_image_protocol`]).
pub fn terminal_info(id: TerminalId, platform: Platform, env: &Env) -> TerminalInfo {
	use ImageProtocol::{Iterm2, Kitty};
	use NotifyProtocol::{Bell, Osc9, Osc99};
	let info = TerminalInfo::new;
	match id {
		// Fallback terminals.
		TerminalId::Base => info(None, false, false, Bell),
		TerminalId::TrueColor => info(None, true, false, Bell),
		// Recognized terminals.
		TerminalId::Kitty => TerminalInfo {
			deccara: true,
			screen_to_scrollback: true,
			text_sizing: true,
			..info(Some(Kitty), true, true, Osc99)
		},
		TerminalId::Ghostty => {
			TerminalInfo { hangul_jamo_width: Some(2), ..info(Some(Kitty), true, true, Osc9) }
		},
		TerminalId::Wezterm => info(Some(Kitty), true, true, Osc9),
		TerminalId::Iterm2 => info(Some(Iterm2), true, true, Osc9),
		TerminalId::Vscode | TerminalId::Alacritty => info(None, true, true, Bell),
		TerminalId::Orca => {
			TerminalInfo { hangul_jamo_width: Some(2), ..info(None, true, false, Bell) }
		},
		// Warp identifies via TERM_PROGRAM=WarpTerminal and ships the Kitty
		// graphics protocol on macOS/Linux (direct placement only — no Unicode
		// placeholders). It does not honor OSC 8 yet (the escape renders as
		// visible text), so hyperlinks stay off, but it does support OSC 9
		// notifications.
		TerminalId::Warp => TerminalInfo {
			hangul_jamo_width: Some(1),
			..info(warp_image_protocol(platform, env), true, false, Osc9)
		},
		// Otty (appmakes, macOS) identifies via TERM_PROGRAM=otty. Its
		// documented Kitty implementation covers direct and virtual (U+10EEEE
		// placeholder) placement, and it honors OSC 8 hyperlinks and OSC 99
		// notifications (docs.otty.sh terminal comparison). Sixel is not
		// implemented, DECCARA and OSC 66 text sizing are unverified, so those
		// stay on conservative defaults; synchronized output is left to the
		// runtime DECRQM probe.
		TerminalId::Otty => info(Some(Kitty), true, true, Osc99),
		// rio publishes its supported escape sequences at
		// rioterm.com/docs/escape-sequence-support: OSC 8 hyperlinks are opened
		// via the hints system (Alt+click on Windows/Linux) — live-verified on
		// rio 0.5.28/Win11 26100 where an OSC 8 span Alt+click opened the
		// target URL in the browser, and an OSC 52 clipboard query
		// round-tripped. Kitty graphics direct placement plus U=1 Unicode
		// placeholders verified by the reporter (#12205). Notifications stay on
		// BEL: rio parses OSC 9/777 into its own notifier, but its Windows path
		// raises an unpackaged WinRT toast with AppId "Rio" that Windows
		// silently drops without a registered AUMID shortcut — observed as a
		// no-op live — so flipping it would only remove the D-Bus fallback for
		// Linux rio users. DECCARA, screen-to-scrollback, OSC 99, and OSC 66
		// text sizing are outside rio's supported set and keep the conservative
		// defaults.
		TerminalId::Rio => info(Some(Kitty), true, true, Bell),
		// Rex (Superlogical's terminal) identifies via TERM_PROGRAM=rex, or
		// TERM=xterm-rex over SSH. It renders Kitty graphics and OSC 8
		// hyperlinks — a link opens on command-click, and Settings > Terminal
		// > Links only decides whether an `ssh://`-style link that launches
		// another app asks first — so links are on. Notifications keep the BEL
		// default.
		TerminalId::Rex => info(Some(Kitty), true, true, Bell),
		// Tern (Stencil's terminal, `stencil-term`) sets TERM_PROGRAM=tern and
		// implements Kitty graphics (Unicode placeholders included), OSC 8 and
		// OSC 9/99 notifications. Whether omp renders natively (Tern Surface
		// Protocol) is decided by the `hello` handshake alone, never by this
		// identity.
		TerminalId::Tern => info(Some(Kitty), true, true, Osc99),
		// Monstar (rockorager/monstar) is a Wayland terminal built on
		// libghostty. It sets TERM=monstar and answers XTVERSION with `monstar
		// <version>`. It documents Kitty graphics with Unicode placeholders,
		// OSC 8 hyperlinks, and synchronized output. libghostty reports Hangul
		// Jamo as 2 cells, and the Monstar renderer draws curly underlines in
		// the SGR 58 underline color, so the id-keyed allowlists treat Monstar
		// like Ghostty. Monstar clears OSC 9;4 progress after 15 s without an
		// update, so it also gets the Ghostty progress keepalive. The Ghostty
		// initial image delay stays Ghostty-only: it works around a Ghostty app
		// startup race, not libghostty. Monstar turns OSC 9 into a D-Bus
		// notification with a default action; activating it focuses the
		// Monstar window. The BEL path uses omp's own `notify-send` fallback
		// instead, which cannot focus a window.
		TerminalId::Monstar => {
			TerminalInfo { hangul_jamo_width: Some(2), ..info(Some(Kitty), true, true, Osc9) }
		},
	}
}

/// Resolve terminal identity from environment markers used by common
/// emulators. Inside tmux the attached client's recorded terminal names are
/// consulted (never in the test runtime).
pub fn detect_terminal_id(env: &Env, test_runtime: bool) -> TerminalId {
	const MARKERS: [(&str, TerminalId); 6] = [
		("KITTY_WINDOW_ID", TerminalId::Kitty),
		("GHOSTTY_RESOURCES_DIR", TerminalId::Ghostty),
		("WEZTERM_PANE", TerminalId::Wezterm),
		("ITERM_SESSION_ID", TerminalId::Iterm2),
		("VSCODE_PID", TerminalId::Vscode),
		("ALACRITTY_WINDOW_ID", TerminalId::Alacritty),
	];
	if let Some(&(_, id)) = MARKERS.iter().find(|(key, _)| env.set(key)) {
		return id;
	}
	if let Some(id) = env.get("TERM_PROGRAM").and_then(TerminalId::from_program) {
		return id;
	}

	// iTerm2 sets `LC_TERMINAL=iTerm2` (plus `LC_TERMINAL_VERSION`) in the
	// local session precisely so it survives SSH: openssh/mosh forward `LC_*`
	// to the remote host, while `ITERM_SESSION_ID` and `TERM_PROGRAM` are
	// stripped. Its own shell integration says the same: "TERM_PROGRAM is set
	// by the local terminal but not forwarded over SSH. LC_TERMINAL is set by
	// iTerm2 and may be forwarded over SSH." Without this branch the remote
	// session falls to the true-color profile and loses the iTerm2
	// inline-image protocol, OSC 8 hyperlinks and OSC 9 notifications
	// (#12419).
	//
	// Gated on the absence of a multiplexer: iTerm2's OSC 1337 encoder is the
	// only image encoder that does not wrap its payload in a tmux passthrough
	// envelope, so inside a multiplexer the sequence would be swallowed by the
	// multiplexer instead of reaching the outer terminal. The multiplexer path
	// resolves the outer client on its own.
	if env.is("LC_TERMINAL", "iTerm2") && !multiplexer::is_inside_any(env) {
		return TerminalId::Iterm2;
	}

	// tmux >= 3.2 replaces the pane's identity with `TERM_PROGRAM=tmux`. Its
	// server still holds the attached client's terminal-type reply and TERM.
	if let Some(id) = tmux::client_terminal_names(env, test_runtime)
		.iter()
		.find_map(|program| TerminalId::from_program(program))
	{
		return id;
	}

	let term = env.get("TERM").unwrap_or_default();
	if term.to_ascii_lowercase().contains("ghostty") {
		return TerminalId::Ghostty;
	}
	if term.eq_ignore_ascii_case("monstar") {
		return TerminalId::Monstar;
	}
	if term.eq_ignore_ascii_case("xterm-rex") {
		return TerminalId::Rex;
	}
	if env.is("COLORTERM", "truecolor") || env.is("COLORTERM", "24bit") {
		return TerminalId::TrueColor;
	}
	TerminalId::Base
}

/// Whether the process runs in an SSH session, so the terminal emulator is
/// remote and host-local input/keyboard modes cannot be assumed.
pub fn is_ssh(env: &Env) -> bool {
	env.set("SSH_CONNECTION") || env.set("SSH_TTY") || env.set("SSH_CLIENT")
}

/// An explicit `PI_FORCE_IMAGE_PROTOCOL` choice. A runtime capability probe
/// must not override it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForcedImageProtocol {
	/// The `off`/`none` kill switch (and any unrecognized value).
	Off,
	On(ImageProtocol),
}

impl ForcedImageProtocol {
	pub const fn protocol(self) -> Option<ImageProtocol> {
		match self {
			Self::Off => None,
			Self::On(protocol) => Some(protocol),
		}
	}
}

/// `PI_FORCE_IMAGE_PROTOCOL`, or `None` when unset.
pub fn forced_image_protocol(env: &Env) -> Option<ForcedImageProtocol> {
	let raw = env
		.get("PI_FORCE_IMAGE_PROTOCOL")?
		.trim()
		.to_ascii_lowercase();
	match raw.as_str() {
		"" => None,
		"kitty" => Some(ForcedImageProtocol::On(ImageProtocol::Kitty)),
		"iterm2" | "iterm" => Some(ForcedImageProtocol::On(ImageProtocol::Iterm2)),
		"sixel" => Some(ForcedImageProtocol::On(ImageProtocol::Sixel)),
		_ => Some(ForcedImageProtocol::Off),
	}
}

/// Leading `major.minor` of a version string.
fn major_minor(version: Option<&str>) -> Option<(u32, u32)> {
	let version = version?.trim();
	let (major, rest) = version.split_once('.')?;
	let minor_len = rest.bytes().take_while(u8::is_ascii_digit).count();
	if major.is_empty() || !major.bytes().all(|b| b.is_ascii_digit()) || minor_len == 0 {
		return None;
	}
	Some((major.parse().ok()?, rest[..minor_len].parse().ok()?))
}

/// Explicit user override for DEC 2026 synchronized output: `Some(false)`
/// for an opt-out, `Some(true)` for a force-on, `None` without a preference.
/// Shared by the static default and the runtime DECRQM probe so both honor
/// the same precedence — an opt-out beats a force-on.
pub fn sync_output_override(env: &Env) -> Option<bool> {
	if env.set("PI_NO_SYNC_OUTPUT") || env.get("PI_TUI_SYNC_OUTPUT") == Some("0") {
		return Some(false);
	}
	if env.get("PI_FORCE_SYNC_OUTPUT") == Some("1") || env.get("PI_TUI_SYNC_OUTPUT") == Some("1") {
		return Some(true);
	}
	None
}

/// Windows Terminal (`WT_SESSION`) whose identity `TERM_PROGRAM` does not
/// contradict.
fn windows_terminal(env: &Env) -> bool {
	env.set("WT_SESSION") && (!env.set("TERM_PROGRAM") || env.is("TERM_PROGRAM", "windows_terminal"))
}

/// Whether DEC 2026 synchronized-output wrappers start enabled.
///
/// Policy (highest precedence first):
///   1. Explicit user override (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0` off,
///      `PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1` on).
///   2. Positive `TERM_FEATURES` advertisement (`Sy`) — survives SSH/mux
///      wrapping. `TERM_FEATURES` is a run of capitalized two-letter codes, so
///      a case-sensitive substring match cannot straddle a code boundary.
///   3. Windows Terminal (1.24+) via `WT_SESSION`, on native win32 and the
///      WSL/SSH-fronted host alike.
///   4. A multiplexer session whose pane VTE honors DEC 2026 regardless of its
///      DECRQM reply (Herdr's libghostty pane). Such a multiplexer still owns
///      the grid, so leaked kitty/ghostty identities cannot enable placeholder
///      graphics, but leaving sync off lets CUP-diff paints and split write(2)
///      chunks composite as dirty-row patches — the live viewport tears.
///   5. Known direct terminals with confirmed support. SSH does *not* disable —
///      DEC 2026 passes through SSH when the outer terminal honors it.
///   6. Everything else starts off, including risky multiplexers (older
///      tmux/screen synchronized-output handling is flaky and a mux may not
///      pass DEC 2026 to the outer host, even when an inner terminal id leaks
///      through); the runtime DECRQM probe upgrades any of them when the
///      terminal reports `?2026` supported.
pub fn sync_output_default(env: &Env, id: TerminalId) -> bool {
	if let Some(forced) = sync_output_override(env) {
		return forced;
	}
	if env
		.get("TERM_FEATURES")
		.is_some_and(|features| features.contains("Sy"))
		|| windows_terminal(env)
	{
		return true;
	}
	if multiplexer::sessions(env).any(|module| module.honors_synchronized_output) {
		return true;
	}
	if multiplexer::is_inside_any(env) {
		return false;
	}
	// VTE family, GNU screen, Apple Terminal, Warp, legacy native console host
	// (no WT_SESSION), and bare/unknown xterm profiles stay off until the
	// DECRQM probe proves support.
	matches!(
		id,
		TerminalId::Kitty
			| TerminalId::Ghostty
			| TerminalId::Monstar
			| TerminalId::Wezterm
			| TerminalId::Iterm2
			| TerminalId::Alacritty
			| TerminalId::Vscode
	)
}

/// Whether the terminal applies Kitty-style DECCARA rectangular SGR changes
/// (`CSI Pt ; Pl ; Pb ; Pr ; <sgr> $ r`) extended to background color, so
/// large filled regions can be painted as rectangles instead of
/// background-padded strings on every row.
///
/// Verified against terminal sources rather than terminfo, because a bare
/// `Cara`/DECCARA terminfo capability does not imply the Kitty SGR-background
/// extension:
/// - Kitty implements it for *all* SGR attributes including background (kitty
///   `docs/deccara.rst` and the `test_deccara` parser test).
/// - Ghostty does NOT: its `CSI $ r` dispatch falls through to an "unknown CSI"
///   warning (ghostty-org/ghostty#632). Enabling it there would silently drop
///   panel backgrounds.
///
/// Disabled under multiplexers — screen-coordinate rectangle protocols are not
/// safe to assume through one — and via the `PI_NO_DECCARA` kill switch.
pub fn rectangular_sgr(id: TerminalId, env: &Env) -> bool {
	if id != TerminalId::Kitty {
		return false;
	}
	if let Some(kill) = env.get("PI_NO_DECCARA")
		&& !kill.is_empty()
		&& kill != "0"
		&& !kill.eq_ignore_ascii_case("false")
	{
		return false;
	}
	!multiplexer::is_inside_any(env)
}

/// Whether the terminal implements colon-subparameter SGR styled underlines
/// — `CSI 4 : 3 m` (curly) plus `CSI 58` / `CSI 59` underline color — as
/// opposed to only the legacy `CSI 4 m` / `CSI 24 m` on/off underline.
///
/// An underline-style capability, not a color depth, so it is keyed on the
/// detected terminal, never on `TERM`/`COLORTERM`. kitty, Ghostty, `WezTerm`,
/// and iTerm2 (>= 3.5) implement the full pair. Apple Terminal does NOT: it
/// renders `CSI 4 : 0 m` (the reset half) as a solid black background that
/// persists to end of line, and ignores SGR 58/59 — so it, along with every
/// other unproven terminal, gets the flat underline. Disabled under any
/// multiplexer: GNU screen and older tmux drop colon-form SGR, and the outer
/// terminal's id leaks into the session env, so a proven id is not proof the
/// bytes survive.
pub fn styled_underlines(id: TerminalId, env: &Env) -> bool {
	if multiplexer::is_inside_any(env) {
		return false;
	}
	match id {
		TerminalId::Kitty | TerminalId::Ghostty | TerminalId::Monstar | TerminalId::Wezterm => true,
		// The full curly-and-colored pair did not ship together until iTerm2
		// 3.5, so 3.0–3.4 would receive the colon reset they cannot render.
		// `LC_TERMINAL_VERSION` carries the same version over SSH, where
		// `TERM_PROGRAM_VERSION` is stripped.
		TerminalId::Iterm2 => major_minor(env.get("TERM_PROGRAM_VERSION"))
			.or_else(|| major_minor(env.get("LC_TERMINAL_VERSION")))
			.is_some_and(|version| version >= (3, 5)),
		_ => false,
	}
}

/// Explicit user override for OSC 8 hyperlinks; opt-out beats force-on.
/// Only the literal `1` toggles either.
pub fn hyperlinks_override(env: &Env) -> Option<bool> {
	if env.get("PI_NO_HYPERLINKS") == Some("1") {
		return Some(false);
	}
	if env.get("PI_FORCE_HYPERLINKS") == Some("1") {
		return Some(true);
	}
	None
}

/// Whether OSC 8 hyperlinks start enabled.
///
/// Policy (highest precedence first):
///   1. Explicit user override; opt-out wins ties.
///   2. Every multiplexer session with a hyperlink policy renders OSC 8 itself
///      (Herdr): on, whatever the hidden outer terminal supports.
///   3. Terminals without static hyperlink support stay off.
///   4. A session that never forwards OSC 8 (GNU screen's `STY`) anywhere in
///      the path: off.
///   5. Forwarding sessions (`TMUX`): on when every one self-reports at least
///      its forwarding version via `TERM_PROGRAM` / `TERM_PROGRAM_VERSION`
///      (tmux 3.4). Checked before the TERM heuristic because tmux's historical
///      `default-terminal` is `screen-256color`.
///   6. TERM naming a multiplexer whose session markers were stripped: off.
///   7. Otherwise the static terminal capability.
pub fn hyperlinks_default(env: &Env, id: TerminalId, platform: Platform) -> bool {
	if let Some(forced) = hyperlinks_override(env) {
		return forced;
	}
	let policies: Vec<_> = multiplexer::sessions(env)
		.filter_map(|module| module.hyperlinks)
		.collect();
	if !policies.is_empty()
		&& policies
			.iter()
			.all(|policy| *policy == HyperlinkPolicy::Render)
	{
		return true;
	}
	if !terminal_info(id, platform, env).hyperlinks || policies.contains(&HyperlinkPolicy::Drop) {
		return false;
	}
	let mut forwarders = policies.iter().filter_map(|policy| match *policy {
		HyperlinkPolicy::Forward { term_program, major, minor } => Some((term_program, major, minor)),
		_ => None,
	});
	if let Some(first) = forwarders.next() {
		let program = env.get("TERM_PROGRAM").map(str::to_ascii_lowercase);
		let version = major_minor(env.get("TERM_PROGRAM_VERSION"));
		return std::iter::once(first)
			.chain(forwarders)
			.all(|(term_program, major, minor)| {
				program.as_deref() == Some(term_program)
					&& version.is_some_and(|version| version >= (major, minor))
			});
	}
	multiplexer::for_term(env).is_none()
}

/// Warp implements the Kitty graphics protocol only on macOS/Linux; its
/// Windows build (including Warp-hosted WSL shells) renders the same APC
/// sequences as visible garbage.
fn warp_image_protocol(platform: Platform, env: &Env) -> Option<ImageProtocol> {
	let windows_host = platform == Platform::Win32 || is_wsl(platform, env);
	(!windows_host).then_some(ImageProtocol::Kitty)
}

/// Paseo (getpaseo/paseo) hardcodes `TERM_PROGRAM=kitty` into every PTY
/// while its xterm.js renderer implements neither Kitty graphics nor Unicode
/// placeholders — trusting the advertisement turns image previews into
/// literal PUA garbage (getpaseo/paseo#3850). Paseo injects
/// `PASEO_TERMINAL_ID` into every terminal it hosts.
fn paseo_embedder(env: &Env) -> bool {
	env.set("PASEO_TERMINAL_ID")
}

/// Image protocol for a non-forced runtime: static per-terminal support (with
/// Warp's platform carve-out), then the multiplexer fallback (a real TTY
/// only), then host carve-outs.
pub fn resolve_image_protocol(
	id: TerminalId,
	env: &Env,
	platform: Platform,
	tty: bool,
) -> Option<ImageProtocol> {
	let mut protocol = terminal_info(id, platform, env).image_protocol;
	if protocol.is_none() && tty && !matches!(id, TerminalId::Vscode | TerminalId::Alacritty) {
		let term = env.get("TERM").unwrap_or_default().to_ascii_lowercase();
		// tmux TERM names the pane, not the attached client's graphics support:
		// unknown clients stay unselected so the runtime SIXEL probe can run.
		if !env.set("TMUX")
			&& !term.contains("tmux")
			&& (term.contains("screen") || term.contains("ghostty"))
		{
			protocol = Some(ImageProtocol::Kitty);
		}
	}
	// Paseo's renderer draws neither Kitty APC nor placeholders — applied after
	// the multiplexer fallback so tmux/screen inside a Paseo pane cannot restore
	// Kitty.
	if protocol.is_some() && paseo_embedder(env) {
		return None;
	}
	// Some multiplexers own the pane grid without exposing whether the attached
	// client renders graphics (Herdr's experimental Kitty renderer). Outer-
	// terminal identity variables can leak into the pane, so only the explicit
	// protocol override is safe.
	if protocol.is_some() && multiplexer::sessions(env).any(|module| module.images_require_override)
	{
		return None;
	}
	// Kitty graphics reach a tmux client only through the DCS passthrough
	// envelope, which tmux drops unless `allow-passthrough` is enabled. A Kitty
	// client identity alone would otherwise send images into the void.
	if protocol == Some(ImageProtocol::Kitty)
		&& env.set("TMUX")
		&& !tmux::pane_allows_passthrough(env)
	{
		return None;
	}
	protocol
}

/// Whether the terminal renders Kitty Unicode placeholders (`U=1` + U+10EEEE
/// with row/column diacritics).
///
/// Kitty, Ghostty, Monstar, Otty, Rio and Tern honor placeholder placement;
/// other Kitty-protocol paths (wezterm, the tmux/screen fallback) draw the
/// cells as literal PUA glyphs — the "ASCII artifact + laggy scrolling" of
/// #1877. A multiplexer cannot use cursor-positioned placements because the
/// outer terminal does not know pane scroll/reflow state, so an explicit
/// `PI_FORCE_IMAGE_PROTOCOL=kitty` opts into placeholders under any
/// multiplexer — matching `timg -pk`. Automatic placeholders stay off inside
/// multiplexers whose pane marker does not prove that a Kitty renderer is
/// enabled (Herdr's is experimental). `PI_NO_KITTY_PLACEHOLDERS=1` and
/// `PI_KITTY_PLACEHOLDERS=0` are hard opt-outs; `PI_KITTY_PLACEHOLDERS=1` opts
/// in anywhere else.
pub fn kitty_unicode_placeholders(id: TerminalId, env: &Env) -> bool {
	let toggle = |key| env.get(key).map(|value| value.trim().to_ascii_lowercase());
	let on = |value: &str| matches!(value, "1" | "true" | "on" | "yes" | "y");
	if toggle("PI_NO_KITTY_PLACEHOLDERS").is_some_and(|value| on(&value)) {
		return false;
	}
	match toggle("PI_KITTY_PLACEHOLDERS").as_deref() {
		Some(value) if on(value) => return true,
		Some("0" | "false" | "off" | "no" | "n") => return false,
		_ => {},
	}
	if multiplexer::is_inside_any(env)
		&& toggle("PI_FORCE_IMAGE_PROTOCOL").as_deref() == Some("kitty")
	{
		return true;
	}
	if multiplexer::sessions(env).any(|module| module.images_require_override) {
		return false;
	}
	matches!(
		id,
		TerminalId::Kitty
			| TerminalId::Ghostty
			| TerminalId::Monstar
			| TerminalId::Otty
			| TerminalId::Rio
			| TerminalId::Tern
	)
}

/// The resolved terminal profile the JS `TERMINAL` snapshot is filled from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
	pub id: TerminalId,
	pub info: TerminalInfo,
	/// The active image protocol: `PI_FORCE_IMAGE_PROTOCOL` when set, else
	/// [`resolve_image_protocol`].
	pub image_protocol: Option<ImageProtocol>,
	pub image_protocol_forced: bool,
	pub hyperlinks: bool,
	/// DECCARA rectangular-SGR fills, forced off in the test runtime so the
	/// xterm.js-backed virtual terminal (which ignores DECCARA) exercises the
	/// padded-string fallback.
	pub deccara: bool,
	pub styled_underlines: bool,
	pub kitty_unicode_placeholders: bool,
	pub ssh: bool,
	pub multiplexer: Option<Multiplexer>,
	pub inside_multiplexer: bool,
	/// Inside a tmux session: sequences for the outer terminal need the
	/// passthrough envelope.
	pub tmux: bool,
}

/// Process facts JS knows and the environment does not.
#[derive(Clone, Copy, Debug)]
pub struct Host {
	pub platform:     Platform,
	/// Bun is running a test entrypoint (`isBunTestRuntime`).
	pub test_runtime: bool,
	pub stdout_tty:   bool,
}

impl Profile {
	pub fn detect(env: &Env, host: Host) -> Self {
		let id = detect_terminal_id(env, host.test_runtime);
		let info = terminal_info(id, host.platform, env);
		let forced = forced_image_protocol(env);
		let classified = multiplexer::classify(env);
		Self {
			id,
			info,
			image_protocol: forced.map_or_else(
				|| resolve_image_protocol(id, env, host.platform, host.stdout_tty),
				ForcedImageProtocol::protocol,
			),
			image_protocol_forced: forced.is_some(),
			hyperlinks: hyperlinks_default(env, id, host.platform),
			deccara: rectangular_sgr(id, env) && !host.test_runtime,
			styled_underlines: styled_underlines(id, env),
			kitty_unicode_placeholders: kitty_unicode_placeholders(id, env),
			ssh: is_ssh(env),
			multiplexer: classified.map(|module| module.id),
			inside_multiplexer: classified.is_some_and(|module| module.owns_screen_grid),
			tmux: Multiplexer::Tmux.is_inside(env),
		}
	}
}

/// Tern names itself in `TERM_PROGRAM`; a multiplexer started in a Tern pane
/// may leave it behind.
pub fn tern_pane(env: &Env) -> bool {
	env.is("TERM_PROGRAM", "tern")
}

/// Why a TSP `hello` cannot reach the terminal from this environment, or
/// `None` when nothing in between is known to drop APC.
///
/// In a Tern pane only a multiplexer's session marker counts: Tern sets
/// `TERM=xterm-kitty`, so a `screen*`/`tmux*` TERM next to
/// `TERM_PROGRAM=tern` without a marker was rewritten (shell rc, dev shell,
/// `.env`), not set by a multiplexer. Elsewhere the TERM fallback keeps
/// classifying sessions whose markers were stripped.
///
/// devenv (2.0+) runs `devenv shell` in its own PTY and redraws the pane from
/// a terminal emulator to keep its reload status line: it forwards DA1 to the
/// real terminal but drops APC, so the DA1 reply always wins. It exports
/// `DEVENV_RELOAD_FILE` only into that reloading shell; `devenv shell
/// --no-reload` runs the shell on the real terminal.
fn tsp_path_blocker(env: &Env) -> Option<String> {
	let module = if tern_pane(env) {
		multiplexer::sessions(env).find(|module| module.owns_screen_grid)
	} else {
		multiplexer::classify(env)
	};
	if let Some(module) = module.filter(|module| module.owns_screen_grid) {
		return Some(format!("inside a {} session, which swallows APC", module.id.as_str()));
	}
	env.set("DEVENV_RELOAD_FILE").then(|| {
		"inside devenv's reloading shell, which redraws the pane and drops APC; `devenv shell \
		 --no-reload` avoids it"
			.to_owned()
	})
}

/// Why the TSP `hello` probe does not run, or `None` when it does.
pub fn tsp_probe_skip_reason(env: &Env, test_runtime: bool) -> Option<String> {
	let native = env.get("PI_TUI_NATIVE");
	if native == Some("0") {
		return Some("PI_TUI_NATIVE=0".to_owned());
	}
	// tmux makes APC bodies the pane title unless the hosting terminal asked
	// for TSP through `@tern-tsp`: no override may force the probe there.
	if Multiplexer::Tmux.is_inside(env) {
		return (!tmux::session_speaks_tsp(env))
			.then(|| "inside a tmux session without the @tern-tsp option".to_owned());
	}
	if native == Some("1") {
		return None;
	}
	// The reply could never arrive.
	if let Some(blocker) = tsp_path_blocker(env) {
		return Some(blocker);
	}
	(test_runtime && env.get("PI_TUI_TSP_PROBE") != Some("1")).then(|| "bun test runtime".to_owned())
}

/// Whether the environment names a Tern Surface Protocol terminal
/// (`TERM_PROGRAM=tern`) and the `hello` probe will run. A multiplexer or
/// relay started from Tern can leave `TERM_PROGRAM=tern` behind while
/// swallowing APC, even when `PI_TUI_NATIVE=1` forces the probe.
pub fn tsp_expected(env: &Env, headless: bool, test_runtime: bool) -> bool {
	tern_pane(env)
		&& tsp_path_blocker(env).is_none()
		&& !headless
		&& tsp_probe_skip_reason(env, test_runtime).is_none()
}

/// How long a TSP hello waits for its reply inside tmux, which answers DA1
/// itself.
const TSP_TMUX_HELLO_TIMEOUT_MS: Millis = 1000.0;

/// OSC 11 background color query (BEL terminated), the payload a
/// multiplexer's passthrough wrapper carries to the outer terminal to refresh
/// its cache.
const OSC11_QUERY: &str = "\x1b]11;?\x07";

/// What the engine's host knows beyond the environment.
pub struct EngineHost {
	pub host:                   Host,
	pub headless:               bool,
	pub stdin_tty:              bool,
	/// Force `ConPTY` hosting on or off; defaults to win32 or WSL.
	pub conpty:                 Option<bool>,
	/// stdin is a native Windows console handle; defaults to win32.
	pub native_windows_console: Option<bool>,
	/// Force [`tsp_expected`] (test harnesses).
	pub tsp_expected:           Option<bool>,
	/// The TSP `hello` query and protocol version (the host owns TSP encoding).
	pub tsp_query:              String,
	pub tsp_version:            u32,
	pub frame_interval_ms:      Millis,
}

/// The engine facts for `env`: terminal identity and image protocol, `ConPTY`
/// and multiplexer hosting, env overrides (`PI_TUI_RESIZE_IN_PLACE`,
/// `PI_TUI_RESIZE_SCROLLBACK`, `PI_NO_SGR_COALESCE`, `PI_HARDWARE_CURSOR`,
/// `PI_TUI_NATIVE`, `PI_NO_GLYPH_PROTOCOL`, the probe opt-ins of the test
/// runtime), and which capability probes run at input attach.
pub fn engine_facts(env: &Env, input: &EngineHost) -> Facts {
	let Host { platform, test_runtime, stdout_tty } = input.host;
	let profile = Profile::detect(env, input.host);
	let classified = multiplexer::classify(env);
	let inside = profile.inside_multiplexer;
	// Test runtimes probe only when a test opts in through `key=1`.
	let probe_allowed = |key: &str| !test_runtime || env.get(key) == Some("1");
	let tsp_expected = input
		.tsp_expected
		.unwrap_or_else(|| tsp_expected(env, input.headless, test_runtime));
	let probe_tsp = match tsp_probe_skip_reason(env, test_runtime) {
		Some(reason) => TspProbe::Skip { reason: Some(reason) },
		// tmux answers DA1 itself, ahead of any reply: wait for the reply
		// instead.
		None if profile.tmux => TspProbe::Tmux {
			query:      input.tsp_query.clone(),
			version:    input.tsp_version,
			timeout_ms: TSP_TMUX_HELLO_TIMEOUT_MS,
		},
		None => TspProbe::Direct { query: input.tsp_query.clone(), version: input.tsp_version },
	};
	Facts {
		terminal_id: profile.id.as_str().to_owned(),
		image_protocol: profile.image_protocol,
		conpty: input
			.conpty
			.unwrap_or_else(|| platform == Platform::Win32 || is_wsl(platform, env)),
		native_windows_console: input
			.native_windows_console
			.unwrap_or(platform == Platform::Win32),
		ssh: profile.ssh,
		inside_multiplexer: inside,
		tmux_passthrough: profile.tmux,
		multiplexer: classified.map_or_else(MultiplexerFacts::default, |module| MultiplexerFacts {
			expands_rep_padding:                  module.expands_rep_padding,
			expires_synchronized_output:          module.expires_synchronized_output,
			alt_restore_ends_synchronized_output: module.alt_restore_ends_synchronized_output,
			grows_before_sigwinch:                module.grows_before_sigwinch,
		}),
		gates_bracketed_paste: multiplexer::sessions(env).any(|module| module.gates_bracketed_paste)
			|| classified.is_some_and(|module| module.gates_bracketed_paste),
		honors_synchronized_output: multiplexer::sessions(env)
			.any(|module| module.honors_synchronized_output),
		background_cache: multiplexer::sessions(env).find_map(|module| {
			module.background_color_cache.map(|cache| BackgroundCache {
				passthrough_query: (cache.passthrough)(OSC11_QUERY),
				settle_ms:         cache.settle_ms,
			})
		}),
		warp: env.is("TERM_PROGRAM", "warpterminal"),
		// `1|true` forces in-place resize (no alt-buffer borrow); `0|false`
		// forces the alt-buffer path even on Warp. Unset defers to Warp
		// detection: Warp re-reports its size on CSI ?1049h / CSI ?1049l, which
		// the resize alt-borrow turns into a flicker loop.
		resize_in_place: match env.get("PI_TUI_RESIZE_IN_PLACE") {
			Some("1" | "true") => Some(true),
			Some("0" | "false") => Some(false),
			_ => None,
		},
		// Until the host configures it.
		resize_scrollback: match env.get("PI_TUI_RESIZE_SCROLLBACK") {
			Some("append") => ResizeScrollback::Append,
			Some("rebuild") => ResizeScrollback::Rebuild,
			_ => ResizeScrollback::Preserve,
		},
		synchronized_output: sync_output_default(env, profile.id),
		synchronized_output_override: sync_output_override(env).is_some(),
		show_hardware_cursor: env.flag("PI_HARDWARE_CURSOR"),
		sgr_coalesce: !env.flag("PI_NO_SGR_COALESCE"),
		// Ghostty and Monstar expire OSC 9;4 state without a heartbeat.
		// Persistent hosts such as Windows Terminal restart their indeterminate
		// animation on every write.
		progress_keepalive: matches!(profile.id, TerminalId::Ghostty | TerminalId::Monstar),
		poll_appearance: platform == Platform::Win32 && windows_terminal(env),
		// Never probe OSC 99 inside a multiplexer. tmux/screen forward the
		// passthrough-wrapped `p=?` query to the outer terminal, but cannot
		// route the capability reply back to the pane that sent it
		// (tmux/tmux#4386, tmux/tmux#3964), so the reply leaks into the pane as
		// literal text and its bytes perturb input (#5582). Rich notifications
		// fall back to the single-line OSC 99 form until confirmation (#3395).
		probe_osc99: profile.info.notify == NotifyProtocol::Osc99
			&& !inside
			&& probe_allowed("PI_TUI_OSC99_PROBE"),
		// Multiplexers can consume the query or leak its reply into the pane.
		probe_program_status: !inside && probe_allowed("PI_TUI_PROGRAM_STATUS_PROBE"),
		// `PI_NO_GLYPH_PROTOCOL=1` keeps the terminal's own font coverage (tofu
		// included) — the registration shadows a system Nerd Font at render
		// time. Same multiplexer rule as the OSC 99 probe: the APC reply would
		// leak as literal text.
		probe_glyph: (env.get("PI_NO_GLYPH_PROTOCOL") != Some("1")
			&& !inside
			&& probe_allowed("PI_TUI_GLYPH_PROTOCOL_PROBE"))
		.then(glyph::probe),
		probe_tsp,
		tsp_expected,
		// A statically known protocol (Kitty/iTerm2 terminals) or an explicit
		// PI_FORCE_IMAGE_PROTOCOL choice — including its `off` kill switch —
		// wins over the XTSMGRAPHICS probe, and a Tern surface sends images
		// through TSP.
		probe_sixel_graphics: profile.image_protocol.is_none()
			&& !tsp_expected
			&& !profile.image_protocol_forced
			&& input.stdin_tty
			&& stdout_tty,
		frame_interval_ms: input.frame_interval_ms,
	}
}

#[cfg(test)]
mod tests;
