//! Session behavior against a capture device: what each probe writes, how
//! replies and DA1 sentinels resolve it, and which events the host sees.

use std::mem;

use super::Session;
use crate::{
	term::Device,
	tui::types::{
		BackgroundCache, Event, Facts, GlyphProbe, ImageProtocol, Millis, MultiplexerFacts, Report,
		ResizeScrollback, Size, TspProbe,
	},
};

const DA1: &str = "\x1b[c";
const OSC11: &str = "\x1b]11;?\x07\x1b[c";
/// Input-mode normalization, leak guard open, kitty query, OSC 11 query.
const ATTACH_HEAD: &str =
	"\x1b[?2004h\x1b[?1l\x1b>\x1b7\x1b[?7l\x1b[8m\x1b[?u\x1b[c\x1b]11;?\x07\x1b[c";
/// Mode 2031 on, the DECRQM probes, leak guard close.
const ATTACH_TAIL: &str = "\x1b[?2031h\x1b[?2026$p\x1b[c\x1b[?2048$p\x1b[c\x1b[?2031$p\x1b[c\x1b[?\
                           2004$p\x1b[c\x1b[?1010$p\x1b[c\x1b[?1011$p\x1b[c\x1b[28m\x1b[?7h\x1b8";
/// Sentinels an attach with no optional probe leaves outstanding: keyboard,
/// OSC 11, six DECRQM probes.
const BASE_SENTINELS: usize = 8;
const NO_EVENTS: [Event; 0] = [];

const GLYPH_SUPPORT_QUERY: &str = "\x1b_25a1;s\x1b\\";
const GLYPH_SUPPORT_REPLY: &str = "\x1b_25a1;s;fmt=glyf\x1b\\";
const GLYPH_BUNDLE: &str = "\x1b_25a1;r;cp=f0d57;reply=0;AAA=\x1b\\\x1b_25a1;q;cp=f0d57\x1b\\";
const GLYPH_CONFIRM_REPLY: &str = "\x1b_25a1;q;cp=f0d57;status=glossary\x1b\\";

const TSP_QUERY: &str = "\x1b_tsp;q;{\"q\":\"hello\",\"v\":[1],\"app\":\"omp\"}\x1b\\";
const TSP_HELLO_BODY: &str = r#"{"r":"hello","v":1,"term":"tern","kinds":["rows"]}"#;

/// A plain direct terminal: no optional probe, no multiplexer.
fn facts() -> Facts {
	Facts {
		terminal_id: "ghostty".to_owned(),
		image_protocol: None,
		conpty: false,
		native_windows_console: false,
		ssh: false,
		inside_multiplexer: false,
		tmux_passthrough: false,
		multiplexer: MultiplexerFacts::default(),
		gates_bracketed_paste: false,
		honors_synchronized_output: false,
		background_cache: None,
		warp: false,
		resize_in_place: None,
		resize_scrollback: ResizeScrollback::Append,
		synchronized_output: true,
		synchronized_output_override: false,
		show_hardware_cursor: false,
		sgr_coalesce: true,
		progress_keepalive: false,
		poll_appearance: false,
		probe_osc99: false,
		probe_program_status: false,
		probe_glyph: None,
		probe_tsp: TspProbe::Skip { reason: None },
		tsp_expected: false,
		probe_sixel_graphics: false,
		frame_interval_ms: 16.0,
	}
}

fn glyph_facts() -> Facts {
	Facts {
		probe_glyph: Some(GlyphProbe {
			support_query:             GLYPH_SUPPORT_QUERY.to_owned(),
			registrations_and_confirm: GLYPH_BUNDLE.to_owned(),
			confirm_codepoint:         0xf0d57,
		}),
		..facts()
	}
}

fn tsp_facts() -> Facts {
	Facts { probe_tsp: TspProbe::Direct { query: TSP_QUERY.to_owned(), version: 1 }, ..facts() }
}

fn tsp_hello() -> Report {
	Report::Tsp { sequence: format!("\x1b_tsp;r;{TSP_HELLO_BODY}\x1b\\") }
}

struct Rig {
	session: Session,
	device:  Device,
	events:  Vec<Event>,
}

impl Rig {
	/// A started session whose input is not attached yet.
	fn started(facts: &Facts) -> Self {
		let mut device = Device::capture();
		let mut session = Session::new(facts, Size { columns: 80, rows: 24 });
		session.start(&mut device);
		Self { session, device, events: Vec::new() }
	}

	/// Attached at t=0, with the attach output and events already taken.
	fn attached(facts: &Facts) -> Self {
		let mut rig = Self::started(facts);
		rig.session
			.attach_input(0.0, &mut rig.device, &mut rig.events);
		rig.output();
		rig.events();
		rig
	}

	/// Everything written since the last call.
	fn output(&mut self) -> String {
		String::from_utf8(self.device.take_output().concat()).unwrap()
	}

	/// Everything emitted since the last call.
	fn events(&mut self) -> Vec<Event> {
		mem::take(&mut self.events)
	}

	fn report(&mut self, now: Millis, report: Report) -> Option<Report> {
		self
			.session
			.handle_report(now, report, &mut self.device, &mut self.events)
	}

	/// Answer the oldest DA1 sentinel (no SIXEL attribute).
	fn da1(&mut self, now: Millis) {
		self.report(now, Report::DeviceAttributes { sixel: false });
	}

	/// Answer `count` sentinels, then drop what that wrote and emitted.
	fn settle(&mut self, now: Millis, count: usize) {
		for _ in 0..count {
			self.da1(now);
		}
		self.output();
		self.events();
	}

	fn tick(&mut self, now: Millis) {
		self.session.tick(now, &mut self.device, &mut self.events);
	}
}

#[test]
fn attach_normalizes_input_modes_and_probes_inside_the_leak_guard() {
	let mut rig = Rig::started(&facts());
	assert_eq!(rig.output(), "", "start elicits no response");
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), format!("{ATTACH_HEAD}{ATTACH_TAIL}"));
	// A skipped hello resolves at once.
	assert_eq!(rig.events(), [Event::TspHello { json: None, reason: None }]);
	assert!(!rig.session.tsp_probe_pending());
	assert_eq!(rig.session.deadline(), Some(150.0));
}

#[test]
fn optional_probes_ride_the_sentinel_fifo_in_order() {
	let facts = Facts {
		probe_osc99: true,
		probe_program_status: true,
		image_protocol: Some(ImageProtocol::Iterm2),
		..tsp_facts()
	};
	let facts = Facts { probe_glyph: glyph_facts().probe_glyph, ..facts };
	let mut rig = Rig::started(&facts);
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	let output = rig.output();
	let middle = output
		.strip_prefix(ATTACH_HEAD)
		.and_then(|rest| rest.strip_suffix("\x1b[16t\x1b]1337;ReportCellSize\x1b\\"))
		.and_then(|rest| rest.strip_suffix(ATTACH_TAIL))
		.unwrap();
	let osc99 = middle
		.strip_suffix(&format!("\x1b]7501;?\x1b\\{DA1}{GLYPH_SUPPORT_QUERY}{DA1}{TSP_QUERY}{DA1}"))
		.unwrap();
	let id = osc99
		.strip_prefix("\x1b]99;i=omp-probe-")
		.and_then(|rest| rest.strip_suffix(":p=?;\x1b\\\x1b[c"))
		.unwrap();
	assert!(id.parse::<u32>().is_ok(), "{id:?}");
	assert_eq!(rig.events(), NO_EVENTS);
	assert!(rig.session.tsp_probe_pending());
	assert!(rig.session.input_context().osc99_pending);

	// Keyboard and OSC 11 sentinels, then one per optional probe, each
	// resolving its capability as absent.
	rig.settle(1.0, 2);
	rig.da1(1.0);
	assert_eq!(rig.events(), [Event::Osc99 { supported: false }]);
	rig.da1(1.0);
	assert_eq!(rig.events(), [Event::ProgramStatus { supported: false }]);
	rig.da1(1.0);
	assert_eq!(rig.events(), [Event::Glyph { supported: false }]);
	rig.da1(1.0);
	let events = rig.events();
	let [Event::TspHello { json: None, reason: Some(reason) }] = &events[..] else {
		panic!("expected a negative hello");
	};
	assert!(reason.starts_with("DA1 was answered before a hello reply"));
	assert!(!rig.session.tsp_probe_pending());
}

#[test]
fn kitty_reply_pushes_flags_and_cancels_the_fallback() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::KittyKeyboard { flags: 0 });
	assert_eq!(rig.output(), "\x1b[>5u");
	assert_eq!(rig.events(), [Event::KeyboardProtocol { kitty: true }]);
	assert!(rig.session.kitty_active());
	assert!(rig.session.input_context().kitty_active);
	// The keyboard sentinel and the 150 ms timer find nothing left to do.
	rig.da1(2.0);
	rig.tick(200.0);
	assert_eq!(rig.output(), "");
	assert_eq!(rig.events(), [Event::Sixel { supported: false, graphics: false }]);
}

#[test]
fn late_kitty_reply_undoes_the_modify_other_keys_fallback() {
	// Terminals such as Superset/xterm-on-Electron answer DA1 before `CSI ? u`
	// (#2042).
	let mut rig = Rig::attached(&facts());
	rig.da1(1.0);
	assert_eq!(rig.output(), "\x1b[>4;2m");
	rig.report(2.0, Report::KittyKeyboard { flags: 2 });
	assert_eq!(rig.output(), "\x1b[>4;0m\x1b[>7u");
	assert!(rig.session.kitty_active());
}

#[test]
fn keyboard_fallback_fires_after_150ms_without_any_reply() {
	let mut rig = Rig::attached(&facts());
	rig.tick(149.0);
	assert_eq!(rig.output(), "");
	rig.tick(150.0);
	assert_eq!(rig.output(), "\x1b[>4;2m");
	assert_eq!(rig.session.deadline(), None);
	// The sentinel arriving afterwards does not request it twice.
	rig.da1(160.0);
	assert_eq!(rig.output(), "");
}

#[test]
fn keyboard_fallback_follows_the_console_host_and_ssh_rules() {
	let fallback = |facts: Facts| {
		let mut rig = Rig::attached(&facts);
		rig.da1(1.0);
		(rig.output(), rig.session.input_context().win32_input)
	};
	// A native Windows console is certain to answer win32-input-mode.
	let native = Facts { conpty: true, native_windows_console: true, ..facts() };
	assert_eq!(fallback(native), ("\x1b[?9001h".to_owned(), true));
	// A WSL pty may not be relayed by a console host: ask for both.
	let wsl = Facts { conpty: true, ..facts() };
	assert_eq!(fallback(wsl), ("\x1b[?9001h\x1b[>4;2m".to_owned(), true));
	// Under sshd win32-input-mode splits arrow keys (#14034).
	let ssh_conpty = Facts { conpty: true, native_windows_console: true, ssh: true, ..facts() };
	assert_eq!(fallback(ssh_conpty), ("\x1b[>4;2m".to_owned(), false));
	// A remote terminal with no identifying env may not understand the request.
	for id in ["base", "trueColor"] {
		let unknown = Facts { ssh: true, terminal_id: id.to_owned(), ..facts() };
		assert_eq!(fallback(unknown), (String::new(), false));
	}
}

#[test]
fn late_kitty_reply_leaves_win32_input_mode_with_conpty_flags() {
	let mut rig = Rig::attached(&Facts { conpty: true, native_windows_console: true, ..facts() });
	rig.da1(1.0);
	rig.output();
	rig.report(2.0, Report::KittyKeyboard { flags: 0 });
	// ConPTY drops Shift+letter under flag 4 (#1216).
	assert_eq!(rig.output(), "\x1b[?9001l\x1b[>1u");
	let context = rig.session.input_context();
	assert!(!context.win32_input);
	assert!(context.kitty_conpty_altgr);
}

#[test]
fn decrpm_confirms_a_mode_and_the_sentinel_alone_leaves_it_unconfirmed() {
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, 2);
	rig.report(2.0, Report::PrivateMode { mode: 2026, status: 2 });
	assert_eq!(rig.events(), [Event::PrivateMode {
		mode:      2026,
		supported: true,
		confirmed: true,
		status:    Some(2),
	}]);
	// Its own sentinel is a no-op once resolved; first result wins.
	rig.da1(3.0);
	rig.report(3.0, Report::PrivateMode { mode: 2026, status: 0 });
	assert_eq!(rig.events(), NO_EVENTS);
	// DA1 beat the DECRPM reply for 2048: unreported, not ruled out.
	rig.da1(4.0);
	assert_eq!(rig.events(), [Event::PrivateMode {
		mode:      2048,
		supported: false,
		confirmed: false,
		status:    None,
	}]);
	// Explicitly unrecognized.
	rig.report(5.0, Report::PrivateMode { mode: 2031, status: 0 });
	assert_eq!(rig.events(), [Event::PrivateMode {
		mode:      2031,
		supported: false,
		confirmed: true,
		status:    Some(0),
	}]);
	assert_eq!(rig.output(), "");
}

#[test]
fn confirmed_in_band_resize_drives_geometry_and_cell_size() {
	let mut rig = Rig::attached(&facts());
	assert_eq!(rig.session.size(), Size { columns: 80, rows: 24 });
	rig.report(1.0, Report::PrivateMode { mode: 2048, status: 2 });
	assert_eq!(rig.output(), "\x1b[?2048h");
	assert!(rig.session.input_context().in_band_resize);
	rig.events();

	let report =
		Report::InBandResize { rows: 50, columns: 120, height_px: 1000, width_px: 1190 };
	rig.report(2.0, report.clone());
	assert_eq!(rig.events(), [Event::CellSize { width_px: 10, height_px: 20 }, Event::Resize]);
	assert_eq!(rig.session.size(), Size { columns: 120, rows: 50 });
	// The same report again changes nothing.
	rig.report(3.0, report);
	assert_eq!(rig.events(), NO_EVENTS);

	// The OS is authoritative on its own resize: a stale cached dimension is
	// dropped until the next in-band report re-seeds it.
	assert!(rig.session.os_resize(100, 50, &mut rig.device));
	assert_eq!(rig.session.size(), Size { columns: 100, rows: 50 });
	assert!(!rig.session.os_resize(100, 50, &mut rig.device));
	// A partial report updates the dimension it carries, without pixel sizes
	// and without a resize notification.
	rig.report(4.0, Report::InBandResize {
		rows:      0,
		columns:   90,
		height_px: 0,
		width_px:  0,
	});
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.session.size(), Size { columns: 90, rows: 50 });
}

#[test]
fn in_band_geometry_is_ignored_until_the_mode_is_confirmed() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::InBandResize {
		rows:      50,
		columns:   120,
		height_px: 0,
		width_px:  0,
	});
	assert_eq!(rig.session.size(), Size { columns: 80, rows: 24 });
	assert!(rig.session.os_resize(81, 24, &mut rig.device));
	assert_eq!(rig.session.size(), Size { columns: 81, rows: 24 });
}

#[test]
fn scroll_to_bottom_modes_are_reset_only_when_reported_set() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::PrivateMode { mode: 1010, status: 1 });
	assert_eq!(rig.output(), "\x1b[?1010l");
	rig.report(1.0, Report::PrivateMode { mode: 1011, status: 2 });
	assert_eq!(rig.output(), "");
	// The exit restore sets back exactly the one that was reset.
	rig.session.stop(&mut rig.device, &mut rig.events);
	let restore = rig.output();
	assert!(restore.contains("\x1b[?1010h"), "{restore:?}");
	assert!(!restore.contains("\x1b[?1011h"), "{restore:?}");
}

#[test]
fn bracketed_paste_is_reasserted_once_confirmed_but_never_mid_paste() {
	let mut rig = Rig::attached(&facts());
	rig.session.note_input(1.0, false, &mut rig.device);
	rig.session.write("x", &mut rig.device);
	assert_eq!(rig.output(), "x");
	assert!(!rig.session.input_context().raw_paste_stall_probe);

	rig.report(2.0, Report::PrivateMode { mode: 2004, status: 1 });
	assert!(rig.session.input_context().raw_paste_stall_probe);
	rig.session.note_input(3.0, false, &mut rig.device);
	assert_eq!(rig.output(), "\x1b[?2004h");
	// Per-key reads of one paste must not become thousands of writes (#15757).
	rig.session.note_input(3.0, true, &mut rig.device);
	assert_eq!(rig.output(), "");
	rig.session.write("x", &mut rig.device);
	assert_eq!(rig.output(), "\x1b[?2004hx");
	rig.session.write("", &mut rig.device);
	assert_eq!(rig.output(), "");
	rig.session.note_output(&mut rig.device);
	assert_eq!(rig.output(), "\x1b[?2004h");
}

#[test]
fn a_multiplexer_gating_paste_markers_rearms_from_attach() {
	// tmux <= 3.5a gates paste markers on the pane's own mode without
	// answering DECRQM (#15596).
	let mut rig = Rig::attached(&Facts { gates_bracketed_paste: true, ..facts() });
	rig.session.note_input(1.0, false, &mut rig.device);
	assert_eq!(rig.output(), "\x1b[?2004h");
	assert!(!rig.session.input_context().raw_paste_stall_probe);
}

#[test]
fn osc11_reply_classifies_by_luminance_and_dedupes_changes() {
	let mut rig = Rig::attached(&facts());
	assert!(rig.session.input_context().osc11_pending);
	assert_eq!(rig.session.appearance_dark(), None);
	rig.report(1.0, Report::BackgroundColor { r: 0.0, g: 0.2, b: 0.4 });
	assert_eq!(rig.events(), [Event::Appearance {
		dark:    true,
		rgb:     0x00_33_66,
		token:   None,
		changed: true,
	}]);
	assert_eq!(rig.session.appearance_dark(), Some(true));
	assert!(!rig.session.input_context().osc11_pending);
	// A reply nobody awaits is dropped.
	rig.report(2.0, Report::BackgroundColor { r: 1.0, g: 1.0, b: 1.0 });
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.session.appearance_dark(), Some(true));
}

#[test]
fn osc11_sentinel_first_means_no_osc11_support() {
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, 2);
	assert!(!rig.session.input_context().osc11_pending);
	rig.report(2.0, Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 });
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.session.appearance_dark(), None);
}

#[test]
fn refresh_queues_behind_the_outstanding_sentinel_and_keeps_its_token() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 });
	rig.events();
	// The startup query's sentinel is still outstanding: queue, do not write.
	assert_eq!(rig.session.refresh_appearance(2.0, None, &mut rig.device), Some(1));
	// An automatic query coalesces into the queued one without losing the
	// explicit request identity.
	rig.report(2.0, Report::AppearanceChanged);
	rig.tick(102.0);
	assert_eq!(rig.output(), "");
	rig.da1(103.0); // keyboard
	rig.output();
	rig.da1(103.0); // OSC 11: the prior cycle is drained, the queued query starts
	assert_eq!(rig.output(), OSC11);
	rig.events();
	rig.report(104.0, Report::BackgroundColor { r: 1.0, g: 1.0, b: 1.0 });
	assert_eq!(rig.events(), [Event::Appearance {
		dark:    false,
		rgb:     0xff_ff_ff,
		token:   Some(1),
		changed: true,
	}]);

	// Unchanged classification is still reported, flagged as such, with the
	// caller's own token; later automatic tokens continue past it.
	rig.settle(105.0, BASE_SENTINELS - 2 + 1);
	assert_eq!(
		rig.session
			.refresh_appearance(106.0, Some(7), &mut rig.device),
		Some(7)
	);
	assert_eq!(rig.output(), OSC11);
	rig.report(107.0, Report::BackgroundColor { r: 0.8, g: 0.8, b: 0.8 });
	assert_eq!(rig.events(), [Event::Appearance {
		dark:    false,
		rgb:     0xcc_cc_cc,
		token:   Some(7),
		changed: false,
	}]);
	rig.settle(108.0, 1);
	assert_eq!(rig.session.refresh_appearance(109.0, None, &mut rig.device), Some(8));
}

#[test]
fn refresh_is_refused_before_input_attaches() {
	let mut rig = Rig::started(&facts());
	assert_eq!(rig.session.refresh_appearance(1.0, None, &mut rig.device), None);
	assert_eq!(rig.output(), "");
}

#[test]
fn explicit_refresh_updates_a_multiplexer_cache_before_reading_it() {
	let cache =
		BackgroundCache { passthrough_query: "<passthrough>".to_owned(), settle_ms: 40.0 };
	let mut rig = Rig::attached(&Facts { background_cache: Some(cache), ..facts() });
	// The startup probe stays direct.
	rig.settle(1.0, BASE_SENTINELS);
	assert_eq!(rig.session.refresh_appearance(10.0, None, &mut rig.device), Some(1));
	// No DA1 sentinel behind the outer query.
	assert_eq!(rig.output(), "<passthrough>");
	assert_eq!(rig.session.deadline(), Some(50.0));
	rig.tick(49.0);
	assert_eq!(rig.output(), "");
	rig.tick(50.0);
	assert_eq!(rig.output(), OSC11);
	rig.report(51.0, Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 });
	assert_eq!(rig.events(), [Event::Appearance {
		dark:    true,
		rgb:     0,
		token:   Some(1),
		changed: true,
	}]);

	// A reply during the settle window makes the cache read unnecessary.
	rig.settle(52.0, 1);
	rig.session.refresh_appearance(60.0, None, &mut rig.device);
	rig.report(61.0, Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 });
	rig.output();
	rig.tick(100.0);
	assert_eq!(rig.output(), "");
}

#[test]
fn mode_2031_notifications_requery_after_a_100ms_debounce() {
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, BASE_SENTINELS);
	rig.report(10.0, Report::AppearanceChanged);
	rig.report(60.0, Report::AppearanceChanged);
	assert_eq!(rig.session.deadline(), Some(160.0));
	rig.tick(159.0);
	assert_eq!(rig.output(), "");
	rig.tick(160.0);
	assert_eq!(rig.output(), OSC11);
	assert_eq!(rig.session.deadline(), None);
}

#[test]
fn windows_terminal_polls_osc11_only_when_mode_2031_is_unsupported() {
	let mut rig = Rig::attached(&Facts { poll_appearance: true, ..facts() });
	rig.settle(1.0, BASE_SENTINELS);
	// 2031 resolved unsupported by its sentinel at t=1.
	assert_eq!(rig.session.deadline(), Some(30_001.0));
	rig.tick(30_001.0);
	assert_eq!(rig.output(), OSC11);
	assert_eq!(rig.session.deadline(), Some(60_001.0));

	let mut rig = Rig::attached(&Facts { poll_appearance: true, ..facts() });
	rig.report(1.0, Report::PrivateMode { mode: 2031, status: 2 });
	rig.settle(1.0, BASE_SENTINELS);
	assert_eq!(rig.session.deadline(), None);
}

#[test]
fn osc99_reply_must_name_the_probe_and_advertise_titles() {
	let mut rig = Rig::started(&Facts { probe_osc99: true, ..facts() });
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	let output = rig.output();
	let start = output.find("\x1b]99;i=").unwrap() + "\x1b]99;i=".len();
	let id = &output[start..start + output[start..].find(':').unwrap()];
	rig.events();

	let caps =
		|meta: String, payload: &str| Report::NotificationCaps { meta, payload: payload.to_owned() };
	// Someone else's reply resolves nothing.
	rig.report(1.0, caps("i=other:p=?".to_owned(), "p=title,body"));
	assert_eq!(rig.events(), NO_EVENTS);
	assert!(rig.session.input_context().osc99_pending);
	rig.report(2.0, caps(format!("i={id}:p=?"), "a=report:p=title,body:o=always"));
	assert_eq!(rig.events(), [Event::Osc99 { supported: true }]);
	assert!(!rig.session.input_context().osc99_pending);
	// Stopping releases the support the host recorded.
	rig.session.stop(&mut rig.device, &mut rig.events);
	assert_eq!(rig.events(), [Event::Osc99 { supported: false }]);

	let mut rig = Rig::started(&Facts { probe_osc99: true, ..facts() });
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	let output = rig.output();
	let start = output.find("\x1b]99;i=").unwrap() + "\x1b]99;i=".len();
	let id = &output[start..start + output[start..].find(':').unwrap()];
	rig.events();
	rig.report(1.0, caps(format!("i={id}:p=?"), "p=body"));
	assert_eq!(rig.events(), [Event::Osc99 { supported: false }]);
}

#[test]
fn program_status_needs_a_reply_naming_both_states() {
	let probe = Facts { probe_program_status: true, ..facts() };
	let states = |names: &[&str]| Report::ProgramStatus {
		states: Some(names.iter().map(|&name| name.to_owned()).collect()),
	};

	let mut rig = Rig::attached(&probe);
	rig.report(1.0, Report::ProgramStatus { states: None });
	assert_eq!(rig.events(), [Event::ProgramStatus { supported: true }]);
	// The sentinel answered afterwards, and a second reply, change nothing.
	rig.settle(2.0, 3);
	rig.report(3.0, states(&["working"]));
	assert_eq!(rig.events(), NO_EVENTS);
	// A resumed session may own a different terminal: release the support.
	rig.session.stop(&mut rig.device, &mut rig.events);
	assert_eq!(rig.events(), [Event::ProgramStatus { supported: false }]);

	let mut rig = Rig::attached(&probe);
	rig.report(1.0, states(&["working", "blocked", "idle"]));
	assert_eq!(rig.events(), [Event::ProgramStatus { supported: true }]);

	let mut rig = Rig::attached(&probe);
	rig.report(1.0, states(&["working"]));
	assert_eq!(rig.events(), [Event::ProgramStatus { supported: false }]);

	// Unprobed: a reply is swallowed without an answer.
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::ProgramStatus { states: None });
	assert_eq!(rig.events(), NO_EVENTS);
}

#[test]
fn glyph_bundle_is_registered_on_support_and_confirmed_by_the_coverage_query() {
	let mut rig = Rig::started(&glyph_facts());
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	assert!(
		rig.output()
			.contains(&format!("{GLYPH_SUPPORT_QUERY}{DA1}"))
	);
	rig.events();

	rig.report(1.0, Report::Glyph { sequence: GLYPH_SUPPORT_REPLY.to_owned() });
	assert_eq!(rig.output(), format!("{GLYPH_BUNDLE}{DA1}"));
	// Not confirmed yet: the bundle is in flight until the `q` answer lands.
	assert_eq!(rig.events(), NO_EVENTS);

	// The terminal answers the support-phase sentinel next (after the keyboard
	// and OSC 11 ones); that DA1 must not abort the confirmation phase.
	rig.settle(2.0, 3);
	rig.report(3.0, Report::Glyph { sequence: GLYPH_CONFIRM_REPLY.to_owned() });
	assert_eq!(rig.events(), [Event::Glyph { supported: true }]);

	// Confirmation-phase sentinel and a stray acknowledgement: swallowed.
	rig.settle(4.0, BASE_SENTINELS - 2 + 1);
	rig.report(5.0, Report::Glyph { sequence: "\x1b_25a1;r;cp=e0b0;status=0\x1b\\".to_owned() });
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.output(), "");
}

#[test]
fn glyph_handshake_fails_when_the_glossary_does_not_serve_the_codepoint() {
	let mut rig = Rig::attached(&glyph_facts());
	rig.report(1.0, Report::Glyph { sequence: GLYPH_SUPPORT_REPLY.to_owned() });
	rig.report(2.0, Report::Glyph {
		sequence: "\x1b_25a1;q;cp=f0d57;status=system\x1b\\".to_owned(),
	});
	assert_eq!(rig.events(), [Event::Glyph { supported: false }]);
}

#[test]
fn glyph_handshake_fails_when_the_confirmation_sentinel_beats_the_coverage_reply() {
	let mut rig = Rig::attached(&glyph_facts());
	rig.report(1.0, Report::Glyph { sequence: GLYPH_SUPPORT_REPLY.to_owned() });
	// Earlier probes, then the ignored support-phase sentinel, then the
	// DECRQM probes: nothing resolves the handshake yet.
	rig.settle(2.0, BASE_SENTINELS + 1);
	rig.da1(3.0);
	assert_eq!(rig.events(), [Event::Glyph { supported: false }]);
}

#[test]
fn glyph_sentinel_first_means_unsupported_without_writing_the_bundle() {
	let mut rig = Rig::attached(&glyph_facts());
	rig.settle(1.0, 2);
	rig.da1(2.0);
	assert_eq!(rig.events(), [Event::Glyph { supported: false }]);
	// A late reply after the sentinel resolved the probe is ignored.
	rig.report(3.0, Report::Glyph { sequence: GLYPH_SUPPORT_REPLY.to_owned() });
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.output(), "");
}

#[test]
fn glyph_reply_without_glyf_support_is_unsupported() {
	let mut rig = Rig::attached(&glyph_facts());
	rig.report(1.0, Report::Glyph { sequence: "\x1b_25a1;s;fmt=\x1b\\".to_owned() });
	assert_eq!(rig.events(), [Event::Glyph { supported: false }]);
	assert_eq!(rig.output(), "");
}

#[test]
fn tsp_hello_reply_resolves_the_probe_and_other_messages_reach_the_host() {
	let mut rig = Rig::attached(&tsp_facts());
	assert!(rig.session.tsp_probe_pending());
	rig.report(1.0, tsp_hello());
	assert_eq!(rig.events(), [Event::TspHello {
		json:   Some(TSP_HELLO_BODY.to_owned()),
		reason: None,
	}]);
	assert!(!rig.session.tsp_probe_pending());
	// Its sentinel afterwards does not revoke it.
	rig.settle(2.0, 3);
	// Events go to the host whole, in APC form.
	let ack = "\x1b_tsp;e;{\"ev\":\"ack\",\"s\":3}\x1b\\";
	rig.report(3.0, Report::Tsp { sequence: ack.to_owned() });
	assert_eq!(rig.events(), [Event::Key(ack.to_owned())]);
}

#[test]
fn tsp_hello_with_another_protocol_version_is_no_tsp() {
	let mut rig = Rig::attached(&tsp_facts());
	let body = r#"{"r":"hello","v":2,"term":"tern","kinds":[]}"#;
	rig.report(1.0, Report::Tsp { sequence: format!("\x1b_tsp;r;{body}\x1b\\") });
	assert_eq!(rig.events(), [Event::TspHello {
		json:   None,
		reason: Some("unsupported protocol version 2".to_owned()),
	}]);
}

#[test]
fn tsp_inside_tmux_waits_for_the_reply_and_hands_apc_titles_back() {
	let tmux = Facts {
		probe_tsp: TspProbe::Tmux {
			query:      TSP_QUERY.to_owned(),
			version:    1,
			timeout_ms: 1000.0,
		},
		..facts()
	};
	let mut rig = Rig::started(&tmux);
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	// tmux answers DA1 itself: the hello goes out without a sentinel.
	assert_eq!(rig.output(), format!("{ATTACH_HEAD}{TSP_QUERY}{ATTACH_TAIL}"));
	assert_eq!(rig.events(), [Event::TmuxApcTitles { enabled: false }]);
	rig.settle(1.0, BASE_SENTINELS);
	assert!(rig.session.tsp_probe_pending());
	assert_eq!(rig.session.deadline(), Some(1000.0));
	rig.tick(1000.0);
	assert_eq!(rig.events(), [Event::TmuxApcTitles { enabled: true }, Event::TspHello {
		json:   None,
		reason: Some("no hello reply through tmux within 1000 ms".to_owned()),
	}]);

	// A reply in time keeps the pane's APC titles off until the session stops.
	let mut rig = Rig::attached(&tmux);
	rig.report(1.0, tsp_hello());
	assert_eq!(rig.events().len(), 1);
	rig.tick(2000.0);
	assert_eq!(rig.events(), NO_EVENTS);
	rig.session.stop(&mut rig.device, &mut rig.events);
	assert_eq!(rig.events(), [Event::TmuxApcTitles { enabled: true }]);
}

#[test]
fn da1_publishes_sixel_only_when_the_advertisement_changes() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::DeviceAttributes { sixel: true });
	rig.report(1.0, Report::DeviceAttributes { sixel: true });
	rig.report(1.0, Report::DeviceAttributes { sixel: false });
	let sixel: Vec<_> = rig
		.events()
		.into_iter()
		.filter(|event| matches!(event, Event::Sixel { .. }))
		.collect();
	assert_eq!(sixel, [Event::Sixel { supported: true, graphics: false }, Event::Sixel {
		supported: false,
		graphics:  false,
	}]);
}

#[test]
fn a_late_da1_reply_with_no_outstanding_sentinel_is_dropped() {
	// A reply that arrives after the FIFO drains must not resolve anything
	// (#8542).
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, BASE_SENTINELS);
	rig.da1(2.0);
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.output(), "");
}

#[test]
fn xtsmgraphics_probe_reports_sixel_or_times_out() {
	let probe = Facts { probe_sixel_graphics: true, ..facts() };
	let mut rig = Rig::started(&probe);
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	assert!(rig.output().ends_with("\x1b8\x1b[?2;1;0S"));
	rig.events();
	rig.report(1.0, Report::SixelGraphics { supported: true });
	assert_eq!(rig.events(), [Event::Sixel { supported: true, graphics: true }]);
	// The host adopts the protocol: the cell size matters now.
	rig.session
		.set_image_protocol(Some(ImageProtocol::Sixel), &mut rig.device);
	assert_eq!(rig.output(), "\x1b[16t");
	rig.session
		.set_image_protocol(Some(ImageProtocol::Sixel), &mut rig.device);
	assert_eq!(rig.output(), "");

	// A reply after the 250 ms window is swallowed.
	let mut rig = Rig::attached(&probe);
	rig.settle(1.0, BASE_SENTINELS);
	assert_eq!(rig.session.deadline(), Some(250.0));
	rig.tick(250.0);
	assert_eq!(rig.session.deadline(), None);
	rig.report(300.0, Report::SixelGraphics { supported: true });
	assert_eq!(rig.events(), NO_EVENTS);

	// A terminal reporting failure or zero geometry has no SIXEL.
	let mut rig = Rig::attached(&probe);
	rig.report(1.0, Report::SixelGraphics { supported: false });
	assert_eq!(rig.events(), NO_EVENTS);

	// A known protocol wins over the probe.
	let mut rig = Rig::started(&Facts { image_protocol: Some(ImageProtocol::Kitty), ..probe });
	rig.session
		.attach_input(0.0, &mut rig.device, &mut rig.events);
	assert!(rig.output().ends_with("\x1b8\x1b[16t"));
}

#[test]
fn cell_size_replies_are_reported_and_cursor_positions_returned() {
	let mut rig = Rig::attached(&facts());
	assert_eq!(rig.report(1.0, Report::CellSize { height_px: 18, width_px: 9 }), None);
	assert_eq!(rig.events(), [Event::CellSize { width_px: 9, height_px: 18 }]);
	// A degenerate reply is consumed without a report.
	rig.report(2.0, Report::CellSize { height_px: 0, width_px: 9 });
	assert_eq!(rig.events(), NO_EVENTS);
	// The screen owns cursor position reports.
	let cpr = Report::CursorPosition { row: 3, column: 1 };
	assert_eq!(rig.report(3.0, cpr.clone()), Some(cpr));
}

#[test]
fn drain_turns_keyboard_enhancements_off_and_ends_on_idle_or_at_the_cap() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::KittyKeyboard { flags: 0 });
	rig.settle(2.0, BASE_SENTINELS);
	rig.session
		.drain_input(100.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	// No TSP session: no drain sentinel.
	assert_eq!(rig.output(), "\x1b[<u");
	assert_eq!(rig.events(), [Event::KeyboardProtocol { kitty: false }]);
	assert!(rig.session.draining());
	assert!(!rig.session.kitty_active());
	assert_eq!(rig.session.deadline(), Some(150.0));
	// Input keeps the drain open.
	rig.session.note_input(140.0, false, &mut rig.device);
	rig.tick(150.0);
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.session.deadline(), Some(190.0));
	rig.tick(190.0);
	assert_eq!(rig.events(), [Event::InputDrained]);
	assert!(!rig.session.draining());

	// A steady stream is cut off at the cap.
	rig.session
		.drain_input(1000.0, 100.0, 50.0, &mut rig.device, &mut rig.events);
	for now in [1040.0, 1080.0] {
		rig.session.note_input(now, false, &mut rig.device);
		rig.tick(now);
	}
	assert_eq!(rig.events(), NO_EVENTS);
	rig.tick(1100.0);
	assert_eq!(rig.events(), [Event::InputDrained]);
}

#[test]
fn drain_undoes_the_modify_other_keys_and_win32_fallbacks() {
	let mut rig = Rig::attached(&Facts { conpty: true, ..facts() });
	rig.da1(1.0);
	rig.output();
	rig.session
		.drain_input(10.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "\x1b[>4;0m\x1b[?9001l");
	assert!(!rig.session.input_context().win32_input);
}

#[test]
fn drain_waits_for_a_da1_sentinel_under_a_tsp_session() {
	let mut rig = Rig::attached(&tsp_facts());
	rig.report(1.0, tsp_hello());
	rig.settle(2.0, BASE_SENTINELS + 1);
	rig.session
		.drain_input(100.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "\x1b[>4;0m\x1b[c");
	// Idle alone does not end it while the sentinel is unanswered.
	assert_eq!(rig.session.deadline(), Some(1100.0));
	rig.tick(400.0);
	assert!(rig.session.draining());
	// In-flight acknowledgements are swallowed, not delivered.
	rig.session.note_input(410.0, false, &mut rig.device);
	rig.report(410.0, Report::Tsp {
		sequence: "\x1b_tsp;e;{\"ev\":\"ack\",\"s\":9}\x1b\\".to_owned(),
	});
	rig.session.note_input(420.0, false, &mut rig.device);
	rig.da1(420.0);
	assert_eq!(rig.events(), NO_EVENTS);
	assert_eq!(rig.session.deadline(), Some(470.0));
	rig.tick(470.0);
	assert_eq!(rig.events(), [Event::InputDrained]);
}

#[test]
fn drain_queries_no_sentinel_before_any_da1_reply_proved_the_path() {
	// Pending optimistic TSP session, but DA1 has never been answered.
	let mut rig = Rig::attached(&Facts { tsp_expected: true, ..tsp_facts() });
	rig.session
		.drain_input(100.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "");
	// Once a reply was seen, a pending expected session is drained through DA1.
	let mut rig = Rig::attached(&Facts { tsp_expected: true, ..tsp_facts() });
	rig.da1(1.0);
	rig.output();
	rig.session
		.drain_input(100.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "\x1b[>4;0m\x1b[c");
	// Pending without the environment naming a TSP terminal: no sentinel.
	let mut rig = Rig::attached(&tsp_facts());
	rig.da1(1.0);
	rig.output();
	rig.session
		.drain_input(100.0, 1000.0, 50.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "\x1b[>4;0m");
}

#[test]
fn progress_is_written_once_and_kept_alive_only_where_it_expires() {
	let mut rig = Rig::started(&facts());
	rig.session.set_progress(0.0, true, &mut rig.device);
	rig.session.set_progress(1.0, true, &mut rig.device);
	assert_eq!(rig.output(), "\x1b]9;4;3\x07");
	assert_eq!(rig.session.deadline(), None);
	rig.session.set_progress(2.0, false, &mut rig.device);
	assert_eq!(rig.output(), "\x1b]9;4;0;\x07");

	// Ghostty and Monstar expire OSC 9;4 state without a heartbeat.
	let mut rig = Rig::started(&Facts { progress_keepalive: true, ..facts() });
	rig.session.set_progress(0.0, true, &mut rig.device);
	rig.output();
	assert_eq!(rig.session.deadline(), Some(1000.0));
	rig.tick(999.0);
	assert_eq!(rig.output(), "");
	rig.tick(1000.0);
	assert_eq!(rig.output(), "\x1b]9;4;3\x07");
	assert_eq!(rig.session.deadline(), Some(2000.0));
	rig.session.set_progress(1500.0, false, &mut rig.device);
	assert_eq!(rig.session.deadline(), None);
}

#[test]
fn title_and_cursor_ops_go_through_the_device() {
	let mut rig = Rig::started(&facts());
	rig.session.set_title("omp", &mut rig.device);
	rig.session.show_cursor(false, &mut rig.device);
	rig.session.show_cursor(false, &mut rig.device);
	rig.session.show_cursor(true, &mut rig.device);
	rig.session.set_cursor_shape(2, &mut rig.device);
	assert_eq!(rig.output(), "\x1b]0;omp\x07\x1b[?25h\x1b[?25h\x1b[2 q");
	// An OS resize makes cursor visibility unknown again.
	rig.session.os_resize(80, 24, &mut rig.device);
	rig.session.show_cursor(false, &mut rig.device);
	assert_eq!(rig.output(), "\x1b[?25h");
}

#[test]
fn a_stalled_backlog_disconnects_once_and_silences_the_session() {
	const OVERSIZED: f64 = 67_108_865.0; // 64 MiB + 1
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, BASE_SENTINELS);
	rig.session
		.sample_backlog(1000.0, OVERSIZED, &mut rig.events);
	// The armed episode keeps the host's timer running.
	assert_eq!(rig.session.deadline(), Some(1250.0));
	rig.tick(1250.0);
	assert_eq!(rig.session.deadline(), Some(1500.0));
	rig.session
		.sample_backlog(30_000.0, OVERSIZED, &mut rig.events);
	assert_eq!(rig.events(), NO_EVENTS);
	rig.session
		.sample_backlog(61_000.0, OVERSIZED, &mut rig.events);
	assert_eq!(rig.events(), [Event::Disconnected {
		reason: "stdout backlog stalled without draining; PTY consumer stalled".to_owned(),
	}]);
	assert_eq!(rig.session.deadline(), None);
	// Dead: nothing more is written or reported.
	rig.session
		.sample_backlog(200_000.0, OVERSIZED, &mut rig.events);
	rig.session.write("x", &mut rig.device);
	assert_eq!(
		rig.session
			.refresh_appearance(200_000.0, None, &mut rig.device),
		None
	);
	rig.session.stop(&mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), "");
	assert_eq!(rig.events(), NO_EVENTS);
}

#[test]
fn a_draining_backlog_ends_its_episode_without_a_disconnect() {
	let mut rig = Rig::attached(&facts());
	rig.settle(1.0, BASE_SENTINELS);
	rig.session
		.sample_backlog(0.0, 67_108_865.0, &mut rig.events); // 64 MiB + 1
	rig.session
		.sample_backlog(250.0, 256.0 * 1024.0, &mut rig.events);
	assert_eq!(rig.session.deadline(), None);
	assert_eq!(rig.events(), NO_EVENTS);
}

#[test]
fn stop_restores_the_terminal_and_forgets_the_negotiated_state() {
	let mut rig = Rig::attached(&facts());
	rig.report(1.0, Report::KittyKeyboard { flags: 0 });
	rig.report(1.0, Report::PrivateMode { mode: 2048, status: 2 });
	rig.report(1.0, Report::PrivateMode { mode: 2004, status: 1 });
	rig.report(1.0, Report::BackgroundColor { r: 0.0, g: 0.0, b: 0.0 });
	rig.report(2.0, Report::InBandResize {
		rows:      50,
		columns:   120,
		height_px: 0,
		width_px:  0,
	});
	rig.session.set_progress(3.0, true, &mut rig.device);
	rig.output();
	rig.events();

	rig.session.stop(&mut rig.device, &mut rig.events);
	let restore = rig.output();
	for sequence in ["\x1b]9;4;0;\x07", "\x1b[?2004l", "\x1b[?2031l", "\x1b[?2048l", "\x1b[<u"] {
		assert!(restore.contains(sequence), "{sequence:?} missing from {restore:?}");
	}
	assert!(restore.ends_with("\x1b[?25h"), "{restore:?}");
	assert_eq!(rig.events(), [Event::KeyboardProtocol { kitty: false }]);
	assert!(!rig.session.kitty_active());
	assert_eq!(rig.session.appearance_dark(), None);
	assert_eq!(rig.session.size(), Size { columns: 80, rows: 24 });
	assert_eq!(rig.session.deadline(), None);
	let context = rig.session.input_context();
	assert!(!context.in_band_resize && !context.raw_paste_stall_probe && !context.osc11_pending);

	// The restore was the last output: later calls write nothing, and a second
	// stop is a no-op.
	rig.session.write("x", &mut rig.device);
	rig.session.note_input(10.0, false, &mut rig.device);
	rig.session.stop(&mut rig.device, &mut rig.events);
	rig.tick(1000.0);
	assert_eq!(rig.output(), "");
	assert_eq!(rig.events(), NO_EVENTS);

	// A restart probes from scratch; stale sentinels were dropped.
	rig.session.start(&mut rig.device);
	rig.session
		.attach_input(2000.0, &mut rig.device, &mut rig.events);
	assert_eq!(rig.output(), format!("{ATTACH_HEAD}{ATTACH_TAIL}"));
	rig.da1(2001.0);
	assert_eq!(rig.output(), "\x1b[>4;2m");
}
