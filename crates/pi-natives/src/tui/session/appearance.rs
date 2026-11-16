//! Terminal appearance (dark/light) detection.
//!
//! Detection uses the OSC 11 background color query, with DEC Mode 2031 as a
//! change trigger. Terminals without Mode 2031 (macOS Terminal.app, Warp, VS
//! Code's built-in, older Alacritty/WezTerm) detect the appearance once at
//! startup and pick up later OS theme changes on next launch. Earlier builds
//! polled OSC 11 every 30 s for those terminals, but each poll's OSC 11/DA1
//! write wiped the user's active text selection on several of them (#3297).
//! Native Windows Terminal gets a scoped fallback poll after DECRQM confirms
//! 2031 is unsupported.

use super::{Session, probe::Owner};
use crate::{
	term::Device,
	tui::types::{Event, Millis},
};

/// OSC 11 background color query (BEL terminated).
const OSC11_QUERY: &str = "\x1b]11;?\x07";
/// Coalesces rapid Mode 2031 notifications during a transition (Neovim
/// convention).
const MODE_2031_DEBOUNCE_MS: Millis = 100.0;
const WINDOWS_TERMINAL_OSC11_POLL_MS: Millis = 30_000.0;

/// An OSC 11 query waiting for the in-flight cycle to drain.
struct Queued {
	/// Refresh the multiplexer's background cache first.
	cache: bool,
	token: Option<u32>,
}

/// OSC 11 query cycle and the detected appearance.
pub(super) struct Appearance {
	/// The last detected appearance, or `None` if not yet known.
	pub(super) dark:    Option<bool>,
	/// A query awaits its reply (or the DA1 sentinel that rules one out).
	pub(super) pending: bool,
	/// Request identity of the in-flight query, propagated to its report.
	active_token:       Option<u32>,
	queued:             Option<Queued>,
	next_token:         u32,
	/// When the direct query follows a passthrough cache refresh.
	cache_refresh_at:   Option<Millis>,
	debounce_at:        Option<Millis>,
	/// Next Windows Terminal fallback poll.
	poll_at:            Option<Millis>,
}

impl Default for Appearance {
	fn default() -> Self {
		Self {
			dark:             None,
			pending:          false,
			active_token:     None,
			queued:           None,
			next_token:       1,
			cache_refresh_at: None,
			debounce_at:      None,
			poll_at:          None,
		}
	}
}

impl Appearance {
	pub(super) fn deadline(&self) -> Option<Millis> {
		[self.cache_refresh_at, self.debounce_at, self.poll_at]
			.into_iter()
			.flatten()
			.reduce(f64::min)
	}

	/// Teardown: forget the cycle and the detected appearance. Request tokens
	/// keep counting so a token is never reissued to the same host.
	pub(super) fn reset(&mut self) {
		*self = Self { next_token: self.next_token, ..Self::default() };
	}
}

impl Session {
	/// Start a bounded OSC 11 background-color refresh cycle, driving
	/// [`Event::Appearance`] through the same DA1-sentinel FIFO,
	/// pending/queued gating, and dedup used at startup and on Mode 2031
	/// notifications. Invoked on the user's explicit display-reset gesture so
	/// terminals without end-to-end Mode 2031 notifications pick up a
	/// light/dark switch without a restart. No periodic probes are armed.
	///
	/// Inside a multiplexer that answers OSC 11 from a cache (tmux), only this
	/// explicit path first passes an OSC 11 query to the outer terminal, waits
	/// briefly for the multiplexer to consume the response into its cache,
	/// then reads that cache with a direct query. The outer query deliberately
	/// has no DA1 sentinel: multiplexers can decode a fragmented DA1 response
	/// as a key sequence and leak the remaining bytes into the editor. Startup
	/// and Mode 2031 probes remain direct.
	///
	/// A caller-provided token is propagated unchanged to the report and
	/// returned when the request is accepted, so callers can establish
	/// ownership before a response is dispatched. `None` while inactive or
	/// after the terminal died.
	pub fn refresh_appearance(
		&mut self,
		now: Millis,
		token: Option<u32>,
		device: &mut Device,
	) -> Option<u32> {
		if !self.active || self.link.dead {
			return None;
		}
		let token = token.unwrap_or(self.appearance.next_token);
		if token >= self.appearance.next_token {
			self.appearance.next_token = token.saturating_add(1);
		}
		let cache = self.facts.background_cache.is_some();
		self.query_background_color(now, cache, Some(token), device);
		Some(token)
	}

	/// Send the OSC 11 background color query followed by a DA1 sentinel. DA1
	/// avoids indefinite hangs: if its reply arrives before the OSC 11 reply,
	/// the terminal does not support OSC 11.
	pub(super) fn query_background_color(
		&mut self,
		now: Millis,
		cache: bool,
		token: Option<u32>,
		device: &mut Device,
	) {
		if self.link.dead {
			return;
		}
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// add a second sentinel, and the old DA1 arrival would then prematurely
		// clear the new query's pending state. Preserve a requested cache
		// refresh when coalescing direct and explicit queries, and retain the
		// latest explicit request identity across automatic queries.
		if self.appearance.pending || self.probes.contains(&Owner::Osc11) {
			let queued = self.appearance.queued.take();
			self.appearance.queued = Some(Queued {
				cache: cache || queued.as_ref().is_some_and(|queued| queued.cache),
				token: token.or_else(|| queued.and_then(|queued| queued.token)),
			});
			return;
		}
		self.start_osc11_query(now, cache, token, device);
	}

	fn start_osc11_query(
		&mut self,
		now: Millis,
		cache: bool,
		token: Option<u32>,
		device: &mut Device,
	) {
		self.appearance.pending = true;
		self.appearance.active_token = token;
		if cache && let Some(cache) = &self.facts.background_cache {
			self.appearance.cache_refresh_at = Some(now + cache.settle_ms);
			self.link.send(device, |batch| {
				batch.text(&cache.passthrough_query);
			});
			return;
		}
		self.start_direct_osc11_query(device);
	}

	fn start_direct_osc11_query(&mut self, device: &mut Device) {
		self.probes.push_back(Owner::Osc11);
		self.link.send(device, |batch| {
			batch.text(OSC11_QUERY).query_device_attributes(); // DA1 sentinel
		});
	}

	/// The DA1 sentinel of an OSC 11 query was answered.
	pub(super) fn handle_osc11_sentinel(&mut self, now: Millis, device: &mut Device) {
		if self.appearance.pending {
			// DA1 arrived before OSC 11 response: terminal doesn't support OSC 11.
			self.appearance.pending = false;
			self.appearance.active_token = None;
		}
		// Start a queued OSC 11 query once the prior cycle is fully drained.
		if !self.appearance.pending
			&& !self.probes.contains(&Owner::Osc11)
			&& !self.link.dead
			&& let Some(queued) = self.appearance.queued.take()
		{
			self.start_osc11_query(now, queued.cache, queued.token, device);
		}
	}

	/// OSC 11 reply (channels normalized to `0.0..=1.0` from 1- to 4-digit
	/// `XParseColor` hex components): classify by BT.601 luminance.
	pub(super) fn handle_background_color(&mut self, r: f64, g: f64, b: f64, out: &mut Vec<Event>) {
		// A reply nobody is waiting for (its DA1 sentinel won, or a stale cycle)
		// is terminal->host data all the same: it is dropped, never typed.
		if !self.appearance.pending {
			return;
		}
		self.appearance.pending = false;
		let token = self.appearance.active_token.take();
		let channel = |value: f64| (value * 255.0).round() as u32;
		let rgb = (channel(r) << 16) | (channel(g) << 8) | channel(b);
		#[allow(
			clippy::suboptimal_flops,
			reason = "a fused multiply-add rounds differently and could flip a mid-gray \
			          classification"
		)]
		let luminance = 0.299 * r + 0.587 * g + 0.114 * b;
		let dark = luminance < 0.5;
		let changed = self.appearance.dark != Some(dark);
		self.appearance.dark = Some(dark);
		out.push(Event::Appearance { dark, rgb, token, changed });
	}

	/// Mode 2031 change notification: re-query OSC 11 with a 100 ms debounce.
	/// The notification only says the appearance changed; the actual
	/// background color comes from OSC 11 (following Neovim convention).
	pub(super) fn handle_appearance_changed(&mut self, now: Millis) {
		self.appearance.debounce_at = Some(now + MODE_2031_DEBOUNCE_MS);
	}

	/// DECRQM resolved Mode 2031: native Windows Terminal polls OSC 11 when the
	/// terminal cannot push appearance changes.
	pub(super) fn sync_appearance_polling(&mut self, now: Millis, mode_2031_supported: bool) {
		if mode_2031_supported || !self.facts.poll_appearance || self.link.dead {
			self.appearance.poll_at = None;
		} else if self.appearance.poll_at.is_none() {
			self.appearance.poll_at = Some(now + WINDOWS_TERMINAL_OSC11_POLL_MS);
		}
	}

	pub(super) fn tick_appearance(&mut self, now: Millis, device: &mut Device) {
		if super::fired(&mut self.appearance.cache_refresh_at, now)
			&& !self.link.dead
			&& self.appearance.pending
		{
			self.start_direct_osc11_query(device);
		}
		if super::fired(&mut self.appearance.debounce_at, now) {
			self.query_background_color(now, false, None, device);
		}
		if self.appearance.poll_at.is_some_and(|at| at <= now) {
			self.appearance.poll_at = Some(now + WINDOWS_TERMINAL_OSC11_POLL_MS);
			self.query_background_color(now, false, None, device);
		}
	}
}
