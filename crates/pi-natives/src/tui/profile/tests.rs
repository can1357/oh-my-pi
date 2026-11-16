//! Detection and capability policy against explicit environments. tmux
//! queries never run here: the cases either sit outside tmux or pass the test
//! runtime flag, and the end-to-end tmux cases (fake `tmux` on `PATH`) live in
//! the pi-tui tests.

use super::*;

const TEST: bool = true;

fn id(pairs: &[(&str, &str)]) -> TerminalId {
	detect_terminal_id(&Env::of(pairs), TEST)
}

fn info(id: TerminalId) -> TerminalInfo {
	terminal_info(id, Platform::Linux, &Env::default())
}

fn sync(pairs: &[(&str, &str)], id: TerminalId) -> bool {
	sync_output_default(&Env::of(pairs), id)
}

fn links(pairs: &[(&str, &str)], id: TerminalId) -> bool {
	hyperlinks_default(&Env::of(pairs), id, Platform::Linux)
}

fn underline(id: TerminalId, pairs: &[(&str, &str)]) -> bool {
	styled_underlines(id, &Env::of(pairs))
}

fn image(id: TerminalId, pairs: &[(&str, &str)]) -> Option<ImageProtocol> {
	resolve_image_protocol(id, &Env::of(pairs), Platform::Linux, true)
}

use TerminalId::{
	Alacritty, Base, Ghostty, Iterm2, Kitty, Monstar, Orca, Otty, Rex, Rio, Tern, TrueColor, Vscode,
	Warp, Wezterm,
};

#[test]
fn detects_terminals_from_their_markers() {
	assert_eq!(id(&[("TERM_PROGRAM", "rio"), ("COLORTERM", "truecolor")]), Rio);
	assert_eq!(
		id(&[("TERM_PROGRAM", "tern"), ("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]),
		Tern
	);
	assert_eq!(id(&[("TERM_PROGRAM", "WarpTerminal"), ("COLORTERM", "truecolor")]), Warp);
	assert_eq!(id(&[("TERM", "monstar"), ("COLORTERM", "truecolor")]), Monstar);
	assert_eq!(
		id(&[
			("TERM_PROGRAM", "otty"),
			("TERM_PROGRAM_VERSION", "1.5.1"),
			("TERM", "xterm-256color")
		]),
		Otty
	);
	assert_eq!(id(&[("TERM_PROGRAM", "iTerm.app")]), Iterm2);
	assert_eq!(id(&[("KITTY_WINDOW_ID", "1"), ("TERM_PROGRAM", "ghostty")]), Kitty);
	// Apple Terminal advertises no id marker.
	assert_eq!(id(&[("TERM_PROGRAM", "Apple_Terminal")]), Base);
	assert_eq!(id(&[]), Base);
}

#[test]
fn inherited_rex_session_and_vte_fall_back_to_true_color() {
	// Any program launched from a Rex pane inherits REX_SESSION, including
	// emulators omp does not recognize; Rex itself sets TERM_PROGRAM=rex.
	let vte = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("VTE_VERSION", "8400")];
	assert_eq!(id(&[("REX_SESSION", "s1"), vte[0], vte[1], vte[2]]), TrueColor);
	// VTE OSC 9 is ConEmu progress, not a notification protocol.
	assert_eq!(id(&[("TERM_PROGRAM", ""), vte[0], vte[1], vte[2]]), TrueColor);
}

#[test]
fn notify_protocol_names_round_trip() {
	for protocol in [NotifyProtocol::Bell, NotifyProtocol::Osc99, NotifyProtocol::Osc9] {
		assert_eq!(NotifyProtocol::parse(protocol.as_str()), Some(protocol));
	}
	assert_eq!(NotifyProtocol::parse("osc777"), None);
}

#[test]
fn static_capabilities() {
	// Rio: kitty graphics, verified hyperlinks, BEL (its Windows toast needs an
	// AUMID registration it does not create).
	assert_eq!(info(Rio).image_protocol, Some(ImageProtocol::Kitty));
	assert!(info(Rio).true_color && info(Rio).hyperlinks);
	assert_eq!(info(Rio).notify, NotifyProtocol::Bell);
	// Monstar routes notifications through OSC 9, whose D-Bus toast can focus
	// the window.
	assert_eq!(info(Monstar).notify, NotifyProtocol::Osc9);
	// Otty: kitty graphics, OSC 8, OSC 99; unverified capabilities stay off.
	let otty = info(Otty);
	assert_eq!(otty.image_protocol, Some(ImageProtocol::Kitty));
	assert!(otty.true_color && otty.hyperlinks && !otty.deccara && !otty.text_sizing);
	assert_eq!(otty.notify, NotifyProtocol::Osc99);
	// OSC 66 text sizing is Kitty-only.
	assert!(info(Kitty).text_sizing);
	for other in [Ghostty, Wezterm, Iterm2, Vscode, Alacritty, Warp, Base, TrueColor] {
		assert!(!info(other).text_sizing, "{other:?}");
	}
}

#[test]
fn hangul_jamo_width_matches_the_terminal() {
	let width = |pairs: &[(&str, &str)]| info(id(pairs)).hangul_jamo_width;
	assert_eq!(width(&[("GHOSTTY_RESOURCES_DIR", "/Applications/Ghostty.app")]), Some(2));
	assert_eq!(width(&[("TERM_PROGRAM", "ghostty")]), Some(2));
	// Ghostty identified only via TERM (env-filtered shells).
	assert_eq!(width(&[("TERM", "xterm-ghostty")]), Some(2));
	assert_eq!(width(&[("TERM_PROGRAM", "WarpTerminal")]), Some(1));
	assert_eq!(
		width(&[("TERM_PROGRAM", "Orca"), ("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]),
		Some(2)
	);
	assert_eq!(width(&[("TERM_PROGRAM", "iTerm.app")]), None);
	assert_eq!(width(&[("TERM_PROGRAM", "Apple_Terminal")]), None);
	assert_eq!(width(&[]), None);
}

#[test]
fn rex_gets_kitty_graphics_and_links_directly_and_over_ssh() {
	for env in
		[&[("TERM_PROGRAM", "rex"), ("TERM", "xterm-256color"), ("COLORTERM", "truecolor")][..], &[
			("TERM", "xterm-rex"),
			("COLORTERM", "truecolor"),
			("SSH_CONNECTION", "client 1 server 22"),
		]] {
		assert_eq!(id(env), Rex);
		assert_eq!(image(Rex, env), Some(ImageProtocol::Kitty));
		assert!(links(env, Rex));
	}
}

#[test]
fn iterm2_over_ssh_survives_through_lc_terminal() {
	// #12419: only LC_TERMINAL/LC_TERMINAL_VERSION survive the SSH hop.
	let ssh = [
		("TERM", "xterm-256color"),
		("COLORTERM", "truecolor"),
		("LC_TERMINAL", "iTerm2"),
		("LC_TERMINAL_VERSION", "3.6.11"),
		("SSH_CONNECTION", "client 1 server 22"),
	];
	assert_eq!(id(&ssh), Iterm2);
	assert_eq!(image(Iterm2, &ssh), Some(ImageProtocol::Iterm2));
	assert!(links(&ssh, Iterm2));
	assert_eq!(info(Iterm2).notify, NotifyProtocol::Osc9);

	// Inside a multiplexer the OSC 1337 payload has no passthrough envelope.
	let mut tmux = ssh.to_vec();
	tmux[0] = ("TERM", "tmux-256color");
	tmux.push(("TMUX", "/tmp/tmux-1000/default,4242,0"));
	assert_ne!(id(&tmux), Iterm2);
	let profile = Profile::detect(&Env::of(&tmux), Host {
		platform:     Platform::Linux,
		test_runtime: TEST,
		stdout_tty:   true,
	});
	assert_ne!(profile.image_protocol, Some(ImageProtocol::Iterm2));
}

#[test]
fn styled_underlines_only_on_proven_terminals_outside_multiplexers() {
	for terminal in [Kitty, Ghostty, Monstar, Wezterm] {
		assert!(underline(terminal, &[]), "{terminal:?}");
	}
	for terminal in [Base, TrueColor, Vscode, Alacritty, Warp, Orca] {
		assert!(!underline(terminal, &[]), "{terminal:?}");
	}
	assert!(!underline(Iterm2, &[("TERM_PROGRAM_VERSION", "2.1.4")]));
	assert!(!underline(Iterm2, &[("TERM_PROGRAM_VERSION", "3.4.0")]));
	assert!(underline(Iterm2, &[("TERM_PROGRAM_VERSION", "3.5.0")]));
	assert!(underline(Iterm2, &[("TERM_PROGRAM_VERSION", "4.0.0")]));
	assert!(!underline(Iterm2, &[]));
	// Over SSH the version arrives as LC_TERMINAL_VERSION.
	assert!(underline(Iterm2, &[("LC_TERMINAL_VERSION", "3.6.11")]));
	assert!(!underline(Iterm2, &[("LC_TERMINAL_VERSION", "3.4.0")]));
	// A multiplexer in the path drops colon-form SGR even when a proven id
	// leaks.
	assert!(!underline(Kitty, &[("TMUX", "/tmp/tmux-1000/default,1,0")]));
	assert!(!underline(Ghostty, &[("STY", "1234.pts-0.host")]));
	assert!(!underline(Wezterm, &[("TERM", "screen-256color")]));
	assert!(!underline(Iterm2, &[("TERM_PROGRAM_VERSION", "3.5.0"), ("ZELLIJ", "0")]));
}

#[test]
fn deccara_is_kitty_only_outside_multiplexers_and_honors_its_kill_switch() {
	assert!(rectangular_sgr(Kitty, &Env::default()));
	assert!(!rectangular_sgr(Ghostty, &Env::default()));
	for other in [Wezterm, Iterm2, Alacritty, Base, TrueColor] {
		assert!(!rectangular_sgr(other, &Env::default()), "{other:?}");
	}
	for marker in [
		("TMUX", "/tmp/tmux-1000/default,123,0"),
		("STY", "1234.pts-0"),
		("ZELLIJ", "0"),
		("CMUX_SURFACE_ID", "surface"),
		("TERM", "tmux-256color"),
		("TERM", "screen.xterm"),
	] {
		assert!(!rectangular_sgr(Kitty, &Env::of(&[marker])), "{marker:?}");
	}
	assert!(!rectangular_sgr(Kitty, &Env::of(&[("PI_NO_DECCARA", "1")])));
	assert!(!rectangular_sgr(Kitty, &Env::of(&[("PI_NO_DECCARA", "true")])));
	assert!(rectangular_sgr(Kitty, &Env::of(&[("PI_NO_DECCARA", "0")])));
	assert!(rectangular_sgr(Kitty, &Env::of(&[("PI_NO_DECCARA", "FALSE")])));
}

#[test]
fn sync_output_user_override() {
	let over = |pairs: &[(&str, &str)]| sync_output_override(&Env::of(pairs));
	assert_eq!(over(&[]), None);
	assert_eq!(over(&[("TERM", "xterm-256color")]), None);
	assert_eq!(over(&[("PI_NO_SYNC_OUTPUT", "1")]), Some(false));
	assert_eq!(over(&[("PI_TUI_SYNC_OUTPUT", "0")]), Some(false));
	assert_eq!(over(&[("PI_FORCE_SYNC_OUTPUT", "1")]), Some(true));
	assert_eq!(over(&[("PI_TUI_SYNC_OUTPUT", "1")]), Some(true));
	assert_eq!(over(&[("PI_NO_SYNC_OUTPUT", "1"), ("PI_FORCE_SYNC_OUTPUT", "1")]), Some(false));
	assert_eq!(over(&[("PI_TUI_SYNC_OUTPUT", "0"), ("PI_FORCE_SYNC_OUTPUT", "1")]), Some(false));
}

#[test]
fn sync_output_defaults() {
	for terminal in [Kitty, Ghostty, Monstar, Wezterm, Iterm2, Alacritty, Vscode] {
		assert!(sync(&[], terminal), "{terminal:?}");
	}
	// WT_SESSION unless TERM_PROGRAM names another host.
	assert!(sync(&[("WT_SESSION", "abc")], TrueColor));
	assert!(sync(&[("WT_SESSION", "abc"), ("TERM_PROGRAM", "Windows_Terminal")], TrueColor));
	assert!(!sync(&[("WT_SESSION", "0"), ("TERM_PROGRAM", "Tabby")], TrueColor));
	// TERM_FEATURES `Sy` survives SSH and multiplexers.
	assert!(sync(&[("TERM_FEATURES", "ClSyTc")], Base));
	assert!(sync(&[("TERM_FEATURES", "ClSyTc"), ("SSH_CONNECTION", "1 2 3 4")], Base));
	assert!(sync(&[("TERM_FEATURES", "ClSyTc"), ("TMUX", "1")], Base));
	assert!(!sync(&[("TERM_FEATURES", "ClTc")], Base));
	// SSH does not disable recognized terminals.
	assert!(sync(&[("SSH_CONNECTION", "1 2 3 4")], Iterm2));
	assert!(sync(&[("SSH_TTY", "/dev/pts/3")], Kitty));
	// Risky multiplexers stay off even when an inner id leaks.
	assert!(!sync(&[("TMUX", "1")], Kitty));
	assert!(!sync(&[("ZELLIJ", "0")], Ghostty));
	assert!(!sync(&[("STY", "x")], Wezterm));
	assert!(!sync(&[("CMUX_WORKSPACE_ID", "workspace")], Wezterm));
	assert!(!sync(&[("TERM", "tmux-256color")], Iterm2));
	assert!(!sync(&[("TERM", "screen-256color")], Kitty));
	// Herdr's pane VTE honors DEC 2026 whatever identity leaks.
	for terminal in [Kitty, Ghostty, TrueColor, Base] {
		assert!(sync(&[("HERDR_ENV", "1")], terminal));
	}
	assert!(sync(&[("HERDR_PANE_ID", "p1"), ("TMUX", "1")], Kitty));
	assert!(sync(&[("HERDR_PANE_ID", "p1"), ("STY", "x")], Base));
	assert!(sync(&[("HERDR_PANE_ID", "p1"), ("ZELLIJ", "0")], Base));
	assert!(!sync(&[("HERDR_SOCKET_PATH", "/tmp/x"), ("TMUX", "1")], Kitty));
	assert!(!sync(&[("HERDR_ENV", "1"), ("PI_NO_SYNC_OUTPUT", "1")], Ghostty));
	assert!(!sync(&[("HERDR_ENV", "1"), ("PI_TUI_SYNC_OUTPUT", "0")], Kitty));
	// Unknown profiles stay off; Warp too.
	for env in [&[("VTE_VERSION", "6800")][..], &[("TERM", "xterm-256color")], &[]] {
		assert!(!sync(env, Base));
	}
	assert!(!sync(&[], TrueColor));
	assert!(!sync(&[], Warp));
	// User overrides beat every heuristic.
	assert!(!sync(&[("PI_NO_SYNC_OUTPUT", "1")], Kitty));
	assert!(!sync(&[("PI_TUI_SYNC_OUTPUT", "0")], Ghostty));
	assert!(!sync(
		&[("PI_NO_SYNC_OUTPUT", "1"), ("WT_SESSION", "abc"), ("TERM_FEATURES", "Sy")],
		Kitty
	));
	assert!(sync(&[("PI_FORCE_SYNC_OUTPUT", "1")], Base));
	assert!(sync(&[("PI_TUI_SYNC_OUTPUT", "1"), ("TMUX", "1")], Base));
	assert!(sync(&[("PI_FORCE_SYNC_OUTPUT", "1"), ("SSH_CONNECTION", "1 2 3 4")], Base));
}

#[test]
fn hyperlinks_user_override() {
	let over = |pairs: &[(&str, &str)]| hyperlinks_override(&Env::of(pairs));
	assert_eq!(over(&[]), None);
	assert_eq!(over(&[("TERM", "xterm-256color")]), None);
	assert_eq!(over(&[("PI_FORCE_HYPERLINKS", "1")]), Some(true));
	assert_eq!(over(&[("PI_NO_HYPERLINKS", "1")]), Some(false));
	assert_eq!(over(&[("PI_NO_HYPERLINKS", "1"), ("PI_FORCE_HYPERLINKS", "1")]), Some(false));
	// Only the canonical `1` toggles them.
	assert_eq!(over(&[("PI_FORCE_HYPERLINKS", "true")]), None);
	assert_eq!(over(&[("PI_FORCE_HYPERLINKS", "0")]), None);
	assert_eq!(over(&[("PI_NO_HYPERLINKS", "0")]), None);
}

#[test]
fn hyperlink_defaults() {
	let tmux = ("TMUX", "/tmp/tmux-1000/default,1,0");
	let sty = ("STY", "1234.pts-0.host");
	let tmux_at = |version| [tmux, ("TERM_PROGRAM", "tmux"), ("TERM_PROGRAM_VERSION", version)];
	for terminal in [Kitty, Ghostty, Wezterm, Iterm2, Alacritty, Vscode] {
		assert!(links(&[], terminal), "{terminal:?}");
	}
	assert!(!links(&[], Base));
	assert!(!links(&[], TrueColor));
	// GNU screen never forwards OSC 8.
	assert!(!links(&[sty], Wezterm));
	assert!(!links(&[("TERM", "screen-256color")], Kitty));
	// TMUX is authoritative even with tmux's historical screen-family TERM.
	assert!(links(
		&[
			tmux,
			("TERM", "screen-256color"),
			("TERM_PROGRAM", "tmux"),
			("TERM_PROGRAM_VERSION", "3.4")
		],
		Wezterm
	));
	assert!(!links(
		&[tmux, ("TERM", "screen"), ("TERM_PROGRAM", "tmux"), ("TERM_PROGRAM_VERSION", "3.3a")],
		Wezterm
	));
	// A screen layer vetoes a nested tmux.
	let [a, b, c] = tmux_at("3.4");
	assert!(!links(&[sty, a, b, c], Wezterm));
	let [a, b, c] = tmux_at("3.5a");
	assert!(!links(&[sty, a, ("TERM", "screen-256color"), b, c], Kitty));
	// tmux without a version, or older than 3.4, stays off.
	assert!(!links(&[tmux], Wezterm));
	assert!(!links(&[("TERM", "tmux-256color")], Wezterm));
	assert!(!links(&tmux_at("3.3a"), Wezterm));
	assert!(!links(&tmux_at("2.9"), Kitty));
	assert!(links(&tmux_at("3.4"), Wezterm));
	assert!(links(&tmux_at("3.5a"), Wezterm));
	assert!(links(&tmux_at("4.0"), Kitty));
	// The static per-terminal flag still applies.
	assert!(!links(&tmux_at("3.5a"), Base));
	// Herdr renders OSC 8 itself.
	assert!(links(&[("HERDR_ENV", "1"), ("TERM", "xterm-256color")], Base));
	assert!(links(&[("HERDR_PANE_ID", "w1:p1"), ("TERM", "xterm-256color")], Base));
	// Nested screen/tmux keep their own rules.
	assert!(!links(&[("HERDR_ENV", "1"), sty], Base));
	assert!(!links(&[("HERDR_ENV", "1"), tmux], Base));
	assert!(!links(&[("HERDR_ENV", "1"), ("PI_NO_HYPERLINKS", "1")], Base));
	// Zellij has no policy and a stale screen TERM is not a session.
	assert!(links(&[("HERDR_ENV", "1"), ("ZELLIJ", "0")], Base));
	assert!(links(&[("HERDR_ENV", "1"), ("TERM", "screen-256color")], Base));
	let [a, b, c] = tmux_at("3.4");
	assert!(links(&[("HERDR_ENV", "1"), a, b, c], Kitty));
	let [a, b, c] = tmux_at("3.3a");
	assert!(!links(&[("HERDR_ENV", "1"), a, b, c], Kitty));
	let [a, b, c] = tmux_at("3.4");
	assert!(!links(&[("HERDR_ENV", "1"), a, b, c, sty], Kitty));
	// A multiplexer TERM under a session without a policy.
	assert!(!links(&[("ZELLIJ", "0"), ("TERM", "screen-256color")], Kitty));
	assert!(links(&[("ZELLIJ", "0"), ("TERM", "xterm-256color")], Kitty));
	// Overrides beat every heuristic.
	assert!(!links(&[("PI_NO_HYPERLINKS", "1")], Kitty));
	let [a, b, c] = tmux_at("3.5a");
	assert!(!links(&[("PI_NO_HYPERLINKS", "1"), a, b, c], Wezterm));
	assert!(links(&[("PI_FORCE_HYPERLINKS", "1")], Base));
	assert!(links(&[("PI_FORCE_HYPERLINKS", "1"), ("TMUX", "1")], Wezterm));
	assert!(links(&[("PI_FORCE_HYPERLINKS", "1"), ("STY", "1.pts-0")], Kitty));
	// Warp renders OSC 8 as text unless forced.
	assert!(!links(&[], Warp));
	assert!(links(&[("PI_FORCE_HYPERLINKS", "1")], Warp));
}

#[test]
fn warp_drops_kitty_graphics_on_windows_hosts() {
	let warp = |platform, pairs: &[(&str, &str)]| terminal_info(Warp, platform, &Env::of(pairs));
	assert_eq!(warp(Platform::Darwin, &[]).image_protocol, Some(ImageProtocol::Kitty));
	assert_eq!(warp(Platform::Linux, &[]).image_protocol, Some(ImageProtocol::Kitty));
	assert_eq!(warp(Platform::Win32, &[]).image_protocol, None);
	// Bun reports linux inside WSL, where the renderer is Warp for Windows.
	assert_eq!(warp(Platform::Linux, &[("WSL_DISTRO_NAME", "Ubuntu")]).image_protocol, None);
	assert_eq!(warp(Platform::Linux, &[("WSL_INTEROP", "/run/WSL/1_interop")]).image_protocol, None);
	let linux = warp(Platform::Linux, &[]);
	assert!(linux.true_color && !linux.hyperlinks && !linux.deccara && !linux.text_sizing);
	assert_eq!(linux.notify, NotifyProtocol::Osc9);
	assert_eq!(resolve_image_protocol(Warp, &Env::default(), Platform::Win32, true), None);
}

#[test]
fn image_protocol_resolution() {
	// Otty speaks kitty graphics.
	assert_eq!(
		image(Otty, &[("TERM_PROGRAM", "otty"), ("TERM", "xterm-256color")]),
		Some(ImageProtocol::Kitty)
	);
	// Unknown tmux clients are left to the SIXEL probe.
	let tmux = [
		("TMUX", "/tmp/tmux/default,1,0"),
		("TERM_PROGRAM", "tmux"),
		("TERM", "tmux-256color"),
		("COLORTERM", "truecolor"),
	];
	assert_eq!(image(id(&tmux), &tmux), None);
	assert_eq!(image(Base, &[tmux[0], tmux[1], ("TERM", "screen-256color")]), None);
	assert_eq!(image(Base, &[("TERM", "tmux-256color")]), None);
	// The GNU screen fallback, real TTYs only, never for VS Code/Alacritty.
	assert_eq!(image(Base, &[("TERM", "screen-256color")]), Some(ImageProtocol::Kitty));
	assert_eq!(
		resolve_image_protocol(
			Base,
			&Env::of(&[("TERM", "screen-256color")]),
			Platform::Linux,
			false
		),
		None
	);
	assert_eq!(image(Vscode, &[("TERM", "screen-256color")]), None);
	// Paseo's xterm.js renderer draws no Kitty graphics, fallback included.
	assert_eq!(image(Base, &[("TERM", "screen-256color"), ("PASEO_TERMINAL_ID", "term-1")]), None);
	assert_eq!(image(Kitty, &[("TERM_PROGRAM", "kitty"), ("PASEO_TERMINAL_ID", "term-1")]), None);
	assert_eq!(image(Kitty, &[("TERM_PROGRAM", "kitty")]), Some(ImageProtocol::Kitty));
	// Herdr owns the grid: a leaked Ghostty identity cannot enable graphics.
	for marker in [("HERDR_ENV", "1"), ("HERDR_PANE_ID", "p1")] {
		let env = [
			("COLORTERM", "truecolor"),
			("GHOSTTY_RESOURCES_DIR", "/usr/share/ghostty"),
			marker,
			("TERM", "xterm-256color"),
			("TERM_PROGRAM", "ghostty"),
		];
		assert_eq!(id(&env), Ghostty);
		assert_eq!(image(Ghostty, &env), None);
	}
}

#[test]
fn forced_image_protocol_values() {
	let forced = |value| forced_image_protocol(&Env::of(&[("PI_FORCE_IMAGE_PROTOCOL", value)]));
	assert_eq!(forced_image_protocol(&Env::default()), None);
	assert_eq!(forced(""), None);
	assert_eq!(forced(" Kitty "), Some(ForcedImageProtocol::On(ImageProtocol::Kitty)));
	assert_eq!(forced("iterm"), Some(ForcedImageProtocol::On(ImageProtocol::Iterm2)));
	assert_eq!(forced("sixel"), Some(ForcedImageProtocol::On(ImageProtocol::Sixel)));
	assert_eq!(forced("off"), Some(ForcedImageProtocol::Off));
	assert_eq!(forced("bogus"), Some(ForcedImageProtocol::Off));
}

#[test]
fn kitty_placeholders() {
	let placeholders =
		|terminal, pairs: &[(&str, &str)]| kitty_unicode_placeholders(terminal, &Env::of(pairs));
	for terminal in [Kitty, Ghostty, Monstar, Otty, Rio, Tern] {
		assert!(placeholders(terminal, &[]), "{terminal:?}");
	}
	assert!(!placeholders(Wezterm, &[]));
	assert!(!placeholders(Warp, &[]));
	assert!(!placeholders(Kitty, &[("PI_NO_KITTY_PLACEHOLDERS", "yes")]));
	assert!(!placeholders(Kitty, &[("PI_KITTY_PLACEHOLDERS", "off")]));
	assert!(placeholders(Wezterm, &[("PI_KITTY_PLACEHOLDERS", "1")]));
	assert!(placeholders(Base, &[("TMUX", "1"), ("PI_FORCE_IMAGE_PROTOCOL", "kitty")]));
	assert!(!placeholders(Ghostty, &[("HERDR_ENV", "1")]));
	assert!(placeholders(Ghostty, &[("HERDR_ENV", "1"), ("PI_FORCE_IMAGE_PROTOCOL", "kitty")]));
	for terminal in [Base, Iterm2, Alacritty] {
		assert!(!placeholders(terminal, &[]), "{terminal:?}");
	}
	for terminal in [Rio, Otty] {
		assert!(!placeholders(terminal, &[("PI_NO_KITTY_PLACEHOLDERS", "1")]));
		assert!(!placeholders(terminal, &[("HERDR_ENV", "1")]));
	}
	// Explicit Kitty through a multiplexer uses the scroll-aware placeholders.
	let tmux = ("TMUX", "/tmp/tmux-1000/default,1,0");
	assert!(placeholders(Wezterm, &[tmux, ("PI_FORCE_IMAGE_PROTOCOL", "kitty")]));
	// The automatic fallback stays conservative when the outer terminal is
	// unknown, while a detected capable terminal still needs placeholders under
	// a pane.
	assert!(!placeholders(Base, &[tmux]));
	assert!(placeholders(Ghostty, &[tmux]));
	assert!(placeholders(Monstar, &[tmux]));
	// Leaked identities inside Herdr need an explicit opt-in.
	let leaked = [("HERDR_ENV", "1"), ("GHOSTTY_RESOURCES_DIR", "/usr/share/ghostty")];
	assert!(!placeholders(Ghostty, &leaked));
	assert!(placeholders(Ghostty, &[leaked[0], leaked[1], ("PI_KITTY_PLACEHOLDERS", "1")]));
	assert!(!placeholders(Ghostty, &[("HERDR_PANE_ID", "p1"), leaked[1]]));
	assert!(!placeholders(Ghostty, &[("HERDR_PANE_ID", "p1"), tmux]));
	// Opt-outs.
	assert!(!placeholders(Ghostty, &[("PI_NO_KITTY_PLACEHOLDERS", "true")]));
	assert!(!placeholders(Kitty, &[
		("PI_NO_KITTY_PLACEHOLDERS", "1"),
		("PI_KITTY_PLACEHOLDERS", "1")
	]));
	assert!(!placeholders(Kitty, &[("PI_KITTY_PLACEHOLDERS", "0")]));
	assert!(!placeholders(Ghostty, &[("PI_KITTY_PLACEHOLDERS", "off")]));
}

#[test]
fn tsp_probe_decisions() {
	let skip = |pairs: &[(&str, &str)]| tsp_probe_skip_reason(&Env::of(pairs), false);
	let expected = |pairs: &[(&str, &str)]| tsp_expected(&Env::of(pairs), false, false);
	assert_eq!(skip(&[("PI_TUI_NATIVE", "0")]).as_deref(), Some("PI_TUI_NATIVE=0"));
	assert_eq!(skip(&[]), None);
	assert!(expected(&[("TERM_PROGRAM", "tern")]));
	assert!(!expected(&[("TERM_PROGRAM", "iTerm.app")]));
	assert!(!tsp_expected(&Env::of(&[("TERM_PROGRAM", "tern")]), true, false));
	// A rewritten screen TERM in a Tern pane is not a session.
	assert!(expected(&[("TERM_PROGRAM", "tern"), ("TERM", "screen-256color")]));
	let screen = [("TERM_PROGRAM", "tern"), ("TERM", "screen-256color"), ("STY", "4242.pts-0.host")];
	assert_eq!(skip(&screen).as_deref(), Some("inside a screen session, which swallows APC"));
	assert!(!expected(&screen));
	assert!(
		skip(&[("TERM_PROGRAM", "tern"), ("DEVENV_RELOAD_FILE", "/p/.devenv/reload-env.sh")])
			.is_some_and(|reason| reason.contains("devenv"))
	);
	// Without Tern's identity a screen TERM still stands for a stripped session.
	assert!(skip(&[("TERM", "screen-256color")]).is_some());
	// PI_TUI_NATIVE=1 forces the probe past a multiplexer, never the optimistic
	// surface.
	let forced = [("TERM_PROGRAM", "tern"), ("ZELLIJ", "0"), ("PI_TUI_NATIVE", "1")];
	assert_eq!(skip(&forced), None);
	assert!(!expected(&forced));
	// The test runtime skips unless a test opts in.
	assert_eq!(tsp_probe_skip_reason(&Env::default(), true).as_deref(), Some("bun test runtime"));
	assert_eq!(tsp_probe_skip_reason(&Env::of(&[("PI_TUI_TSP_PROBE", "1")]), true), None);
}

fn engine_host(stdin_tty: bool) -> EngineHost {
	EngineHost {
		host: Host { platform: Platform::Linux, test_runtime: TEST, stdout_tty: true },
		headless: true,
		stdin_tty,
		conpty: Some(false),
		native_windows_console: None,
		tsp_expected: None,
		tsp_query: "<hello>".to_owned(),
		tsp_version: 1,
		frame_interval_ms: 16.0,
	}
}

#[test]
fn polls_appearance_only_under_native_windows_terminal() {
	let polls = |platform, pairs: &[(&str, &str)]| {
		let mut host = engine_host(true);
		host.host.platform = platform;
		engine_facts(&Env::of(pairs), &host).poll_appearance
	};
	let wt = ("WT_SESSION", "test-wt-session");
	// #5091: Windows Terminal never notifies through Mode 2031.
	assert!(polls(Platform::Win32, &[wt, ("TERM_PROGRAM", "Windows_Terminal")]));
	assert!(polls(Platform::Win32, &[wt]));
	// #3297: a periodic probe wipes the text selection elsewhere.
	assert!(!polls(Platform::Win32, &[]));
	assert!(!polls(Platform::Win32, &[wt, ("TERM_PROGRAM", "Tabby")]));
	assert!(!polls(Platform::Linux, &[]));
	assert!(!polls(Platform::Linux, &[wt, ("WSL_INTEROP", "/run/WSL/1_interop")]));
}

#[test]
fn engine_facts_follow_the_environment() {
	let direct = engine_facts(
		&Env::of(&[("TERM_PROGRAM", "ghostty"), ("PI_HARDWARE_CURSOR", "yes")]),
		&engine_host(true),
	);
	assert_eq!(direct.terminal_id, "ghostty");
	assert_eq!(direct.image_protocol, Some(ImageProtocol::Kitty));
	assert!(direct.synchronized_output && !direct.synchronized_output_override);
	assert!(direct.progress_keepalive && direct.show_hardware_cursor && direct.sgr_coalesce);
	assert!(!direct.probe_sixel_graphics && direct.probe_glyph.is_none() && !direct.probe_osc99);
	assert_eq!(direct.resize_scrollback, ResizeScrollback::Preserve);
	assert!(
		matches!(&direct.probe_tsp, TspProbe::Skip { reason: Some(reason) } if reason == "bun test runtime")
	);

	let env = Env::of(&[
		("TMUX", "/tmp/tmux-1000/default,1,0"),
		("TERM", "tmux-256color"),
		("PI_TUI_GLYPH_PROTOCOL_PROBE", "1"),
		("PI_TUI_RESIZE_SCROLLBACK", "rebuild"),
		("PI_TUI_RESIZE_IN_PLACE", "true"),
		("PI_NO_SGR_COALESCE", "1"),
	]);
	let tmux = engine_facts(&env, &engine_host(true));
	assert!(tmux.inside_multiplexer && tmux.tmux_passthrough && tmux.gates_bracketed_paste);
	assert!(tmux.multiplexer.expands_rep_padding && tmux.multiplexer.grows_before_sigwinch);
	assert_eq!(
		tmux
			.background_cache
			.as_ref()
			.map(|cache| (cache.passthrough_query.as_str(), cache.settle_ms)),
		Some(("\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\", 100.0))
	);
	// The glyph probe never runs inside a multiplexer, even when opted in.
	assert!(tmux.probe_glyph.is_none());
	assert!(!tmux.synchronized_output && !tmux.sgr_coalesce);
	assert_eq!(tmux.resize_scrollback, ResizeScrollback::Rebuild);
	assert_eq!(tmux.resize_in_place, Some(true));
	// No static protocol: XTSMGRAPHICS runs on real TTYs.
	assert!(tmux.probe_sixel_graphics);
	assert!(!engine_facts(&env, &engine_host(false)).probe_sixel_graphics);
	let forced = Env::of(&[("TMUX", "1"), ("PI_FORCE_IMAGE_PROTOCOL", "off")]);
	assert!(!engine_facts(&forced, &engine_host(true)).probe_sixel_graphics);

	let glyph = engine_facts(&Env::of(&[("PI_TUI_GLYPH_PROTOCOL_PROBE", "1")]), &engine_host(true));
	assert!(glyph.probe_glyph.is_some());
	let killed = Env::of(&[("PI_TUI_GLYPH_PROTOCOL_PROBE", "1"), ("PI_NO_GLYPH_PROTOCOL", "1")]);
	assert!(
		engine_facts(&killed, &engine_host(true))
			.probe_glyph
			.is_none()
	);

	let herdr = engine_facts(&Env::of(&[("HERDR_ENV", "1")]), &engine_host(true));
	assert!(herdr.honors_synchronized_output && herdr.synchronized_output);
	let kitty = Env::of(&[("KITTY_WINDOW_ID", "1"), ("PI_TUI_OSC99_PROBE", "1")]);
	assert!(engine_facts(&kitty, &engine_host(true)).probe_osc99);
}
