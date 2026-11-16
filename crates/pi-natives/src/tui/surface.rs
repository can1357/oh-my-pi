//! The Tern Surface Protocol handshake: whether frames go to a TSP surface
//! or to the row renderer.
//!
//! The session resolves the `hello` probe ([`Event::TspHello`]); this module
//! decides what the outcome means for the screen and tells the host only the
//! surface transitions ([`Event::NativeSurface`]), whose `NativeBackend`
//! (describe/reconcile) stays in JS:
//!
//! - **Optimistic start**: when the environment names Tern
//!   (`TERM_PROGRAM=tern`, [`Facts::tsp_expected`](super::types::Facts)) the
//!   surface goes live at start on assumed capabilities, before the reply. The
//!   reply confirms it; a null or unsupported hello revokes it, and so does no
//!   reply within [`CONFIRM_MS`] — unless the deadline fired after an
//!   event-loop stall, possibly with the reply already queued on stdin, which
//!   re-arms it for [`CONFIRM_GRACE_MS`] so input gets a turn first.
//! - **Probe hold**: elsewhere the first paint waits (up to 300 ms, see
//!   [`Screen::set_native_probe_hold`]) for the outstanding probe, so a TSP
//!   terminal never sees a row paint it would have to erase.
//! - **Adoption**: a reply arriving later — after a deferred-input attach, or
//!   after a revoke — switches to a fresh surface.
//!
//! Both start-time behaviors arm only for the input attach of a start (before
//! the host's first render request), as the host's `start()` did.

use super::{
	screen::{RenderRequest, Screen},
	types::{Event, Millis},
};
use crate::term::Device;

/// How long an optimistic surface waits for the `hello` reply.
const CONFIRM_MS: Millis = 1000.0;
/// A confirm deadline that fires this late ran after an event-loop stall:
/// re-arm for this long so input gets a turn before giving up.
const CONFIRM_GRACE_MS: Millis = 100.0;

/// Handshake state of one engine; see the [module docs](self).
#[derive(Debug, Default)]
pub struct Handshake {
	/// The environment names Tern: a no-TSP outcome is worth a log line.
	tern_pane:       bool,
	/// The environment names Tern and the probe will run: a start opens the
	/// surface optimistically.
	tsp_expected:    bool,
	/// Between `start` and the host's first render request: an input attach
	/// now is the start's, which may hold the first paint or open the
	/// surface optimistically.
	starting:        bool,
	/// Frames go to the surface.
	live:            bool,
	/// The live surface runs on assumed capabilities until the reply
	/// confirms it by `confirm_at`.
	confirm_at:      Option<Millis>,
	/// This handshake holds the screen's first paint.
	probe_hold:      bool,
	/// The classic-renderer fallback of a Tern pane was reported.
	fallback_logged: bool,
}

impl Handshake {
	pub fn new(tern_pane: bool, tsp_expected: bool) -> Self {
		Self { tern_pane, tsp_expected, ..Self::default() }
	}

	/// A session (re)starts: the next input attach is the start's.
	pub const fn start(&mut self) {
		self.starting = true;
	}

	/// The host asked for a frame: an input attach from now on is a deferred
	/// one, after the first paint.
	pub const fn note_render_request(&mut self) {
		self.starting = false;
	}

	/// Input attached and the capability probes went out. On a start's
	/// attach with the `hello` probe outstanding, open the surface on
	/// assumed capabilities (Tern expected) or hold the first paint.
	pub fn note_attach(
		&mut self,
		now: Millis,
		probe_pending: bool,
		screen: &mut Screen,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		if !self.starting || !probe_pending || self.live {
			return;
		}
		if self.tsp_expected {
			self.open(now, None, screen, device, out);
			self.confirm_at = Some(now + CONFIRM_MS);
		} else {
			self.probe_hold = true;
			screen.set_native_probe_hold(now, true);
		}
	}

	/// The `hello` probe resolved: the reply's JSON body, or `None` (`reason`
	/// says why there is no TSP).
	pub fn resolve(
		&mut self,
		now: Millis,
		hello: Option<String>,
		reason: Option<String>,
		screen: &mut Screen,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		let held = std::mem::take(&mut self.probe_hold);
		if hello.is_none() && self.tern_pane && !self.fallback_logged {
			// A Tern pane that ends up on the classic renderer says why, once.
			self.fallback_logged = true;
			out.push(Event::TspFallback {
				reason: reason.unwrap_or_else(|| "no TSP hello reply".to_owned()),
			});
		}
		if self.confirm_at.is_some() {
			match hello {
				None => self.revoke(
					now,
					"the DA1 sentinel came before a TSP hello reply, or the reply's version is \
					 unsupported"
						.to_owned(),
					screen,
					device,
					out,
				),
				Some(hello) => {
					self.confirm_at = None;
					out.push(Event::NativeSurface { live: true, hello: Some(hello), reason: None });
				},
			}
			return;
		}
		// The surface goes live before the hold is released: releasing a hold
		// that is still active repaints the rows, which a live surface must
		// never see. Without a surface that repaint is the first paint.
		if let Some(hello) = hello
			&& !self.live
		{
			self.open(now, Some(hello), screen, device, out);
		}
		if held {
			screen.set_native_probe_hold(now, false);
		}
	}

	/// Frames go to the surface.
	pub const fn live(&self) -> bool {
		self.live
	}

	/// The environment names Tern and the `hello` probe runs.
	pub const fn tsp_expected(&self) -> bool {
		self.tsp_expected
	}

	/// The confirm deadline, while an optimistic surface awaits its reply.
	pub const fn deadline(&self) -> Option<Millis> {
		self.confirm_at
	}

	/// Fire the confirm deadline when due.
	pub fn tick(
		&mut self,
		now: Millis,
		screen: &mut Screen,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		let Some(due) = self.confirm_at.filter(|&due| now >= due) else {
			return;
		};
		if now - due > CONFIRM_GRACE_MS {
			self.confirm_at = Some(now + CONFIRM_GRACE_MS);
			return;
		}
		self.revoke(now, format!("no TSP hello reply within {CONFIRM_MS} ms"), screen, device, out);
	}

	/// The session stops: rows own the screen again (the host closes its
	/// backend itself) and a restart starts the handshake over.
	pub fn stop(&mut self, now: Millis, screen: &mut Screen, device: &mut Device) {
		self.starting = false;
		self.confirm_at = None;
		self.probe_hold = false;
		if std::mem::take(&mut self.live) {
			screen.set_native_surface(now, false, device);
		}
	}

	/// Switch to the surface. The handshake may land after the row renderer
	/// painted (deferred input): the screen leaves the alternate screen if
	/// borrowed and erases the painted viewport so the surface opens where the
	/// rows began.
	fn open(
		&mut self,
		now: Millis,
		hello: Option<String>,
		screen: &mut Screen,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		screen.set_native_surface(now, true, device);
		self.live = true;
		out.push(Event::NativeSurface { live: true, hello, reason: None });
	}

	/// The optimistic surface was never confirmed: close it without keeping
	/// anything and repaint every row. A reply that still arrives later
	/// switches to a fresh surface the usual way.
	fn revoke(
		&mut self,
		now: Millis,
		reason: String,
		screen: &mut Screen,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		self.confirm_at = None;
		self.live = false;
		screen.set_native_surface(now, false, device);
		screen.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
		out.push(Event::NativeSurface { live: false, hello: None, reason: Some(reason) });
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::tui::profile::{EngineHost, Env, Host, Platform, engine_facts};

	const HELLO: &str = r#"{"r":"hello","v":1,"term":"tern","kinds":["rows"]}"#;

	struct Rig {
		handshake: Handshake,
		screen:    Screen,
		device:    Device,
		events:    Vec<Event>,
	}

	impl Rig {
		fn new(tern_pane: bool, tsp_expected: bool) -> Self {
			let host = EngineHost {
				host:                   Host {
					platform:     Platform::Linux,
					test_runtime: true,
					stdout_tty:   true,
				},
				headless:               false,
				stdin_tty:              true,
				conpty:                 Some(false),
				native_windows_console: Some(false),
				tsp_expected:           Some(false),
				tsp_query:              String::new(),
				tsp_version:            1,
				frame_interval_ms:      16.0,
			};
			let facts = engine_facts(&Env::default(), &host);
			let mut handshake = Handshake::new(tern_pane, tsp_expected);
			handshake.start();
			Self {
				handshake,
				screen: Screen::new(&facts),
				device: Device::capture(),
				events: Vec::new(),
			}
		}

		fn attach(&mut self, now: Millis) {
			self.handshake.note_attach(
				now,
				true,
				&mut self.screen,
				&mut self.device,
				&mut self.events,
			);
		}

		fn resolve(&mut self, now: Millis, hello: Option<&str>) {
			self.handshake.resolve(
				now,
				hello.map(str::to_owned),
				Some("why".to_owned()),
				&mut self.screen,
				&mut self.device,
				&mut self.events,
			);
		}

		fn tick(&mut self, now: Millis) {
			self
				.handshake
				.tick(now, &mut self.screen, &mut self.device, &mut self.events);
		}

		/// Surface transitions since the last call: `(live, hello, reason)`.
		fn transitions(&mut self) -> Vec<(bool, Option<String>, bool)> {
			self
				.events
				.drain(..)
				.filter_map(|event| match event {
					Event::NativeSurface { live, hello, reason } => {
						Some((live, hello, reason.is_some()))
					},
					_ => None,
				})
				.collect()
		}
	}

	#[test]
	fn optimistic_surface_opens_at_start_and_the_reply_confirms_it() {
		let mut rig = Rig::new(true, true);
		rig.attach(0.0);
		assert_eq!(rig.transitions(), [(true, None, false)]);
		assert_eq!(rig.handshake.deadline(), Some(CONFIRM_MS));
		rig.resolve(10.0, Some(HELLO));
		assert_eq!(rig.transitions(), [(true, Some(HELLO.to_owned()), false)]);
		assert_eq!(rig.handshake.deadline(), None);
	}

	#[test]
	fn optimistic_surface_is_revoked_by_a_null_hello_and_a_later_reply_adopts_a_fresh_one() {
		let mut rig = Rig::new(false, true);
		rig.attach(0.0);
		rig.transitions();
		rig.resolve(5.0, None);
		assert_eq!(rig.transitions(), [(false, None, true)]);
		assert_eq!(rig.handshake.deadline(), None);
		rig.resolve(50.0, Some(HELLO));
		assert_eq!(rig.transitions(), [(true, Some(HELLO.to_owned()), false)]);
	}

	#[test]
	fn confirm_deadline_revokes_unless_it_fired_after_a_stall() {
		let mut rig = Rig::new(false, true);
		rig.attach(0.0);
		rig.transitions();
		rig.tick(999.0);
		assert!(rig.transitions().is_empty());
		rig.tick(1000.0);
		assert_eq!(rig.transitions(), [(false, None, true)]);

		let mut stalled = Rig::new(false, true);
		stalled.attach(0.0);
		stalled.transitions();
		// The loop stalled past the deadline: input gets a grace turn first.
		stalled.tick(3000.0);
		assert!(stalled.transitions().is_empty());
		assert_eq!(stalled.handshake.deadline(), Some(3000.0 + CONFIRM_GRACE_MS));
		stalled.resolve(3001.0, Some(HELLO));
		assert_eq!(stalled.transitions(), [(true, Some(HELLO.to_owned()), false)]);
		// The grace deadline that fires on time does revoke.
		let mut late = Rig::new(false, true);
		late.attach(0.0);
		late.tick(3000.0);
		late.transitions();
		late.tick(3000.0 + CONFIRM_GRACE_MS);
		assert_eq!(late.transitions(), [(false, None, true)]);
	}

	#[test]
	fn a_start_without_tern_holds_the_first_paint_until_the_probe_resolves() {
		let mut rig = Rig::new(false, false);
		rig.attach(0.0);
		assert!(rig.transitions().is_empty());
		assert_eq!(rig.screen.deadline(), Some(300.0));
		rig.resolve(20.0, None);
		assert!(rig.transitions().is_empty());
		// The released hold forces the first paint now.
		assert_eq!(rig.screen.deadline(), Some(20.0));

		let mut tsp = Rig::new(false, false);
		tsp.attach(0.0);
		tsp.resolve(20.0, Some(HELLO));
		assert_eq!(tsp.transitions(), [(true, Some(HELLO.to_owned()), false)]);
		// A live surface paints no rows: nothing left to do.
		assert_eq!(tsp.screen.deadline(), None);
	}

	#[test]
	fn a_deferred_attach_neither_holds_nor_opens_but_adopts_a_reply() {
		let mut rig = Rig::new(false, true);
		rig.handshake.note_render_request();
		rig.attach(0.0);
		assert!(rig.transitions().is_empty());
		assert_eq!(rig.handshake.deadline(), None);
		assert_eq!(rig.screen.deadline(), None);
		rig.resolve(500.0, Some(HELLO));
		assert_eq!(rig.transitions(), [(true, Some(HELLO.to_owned()), false)]);
	}

	#[test]
	fn a_tern_pane_reports_its_classic_renderer_fallback_once() {
		let fallbacks = |rig: &Rig| {
			rig.events
				.iter()
				.filter(|event| matches!(event, Event::TspFallback { reason } if reason == "why"))
				.count()
		};
		let mut rig = Rig::new(true, false);
		rig.resolve(0.0, None);
		rig.resolve(1.0, None);
		assert_eq!(fallbacks(&rig), 1);
		let mut elsewhere = Rig::new(false, false);
		elsewhere.resolve(0.0, None);
		assert_eq!(fallbacks(&elsewhere), 0);
	}
}
