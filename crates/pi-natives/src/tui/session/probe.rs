//! The unified DA1 sentinel FIFO.
//!
//! Every response-eliciting probe is followed by DA1 (Primary Device
//! Attributes, `CSI c`). Terminals process sequences in order, so a DA1 reply
//! that arrives before the probe's own reply proves the terminal does not
//! answer that probe; this avoids indefinite hangs without timers. Technique
//! used by Neovim, bat, fish, and terminal-colorsaurus. Each sentinel written
//! pushes its owner here, and each DA1 reply resolves the oldest one.

use super::{Session, caps::GlyphPhase};
use crate::{
	term::Device,
	tui::types::{Event, Millis},
};

/// Owner of an outstanding DA1 sentinel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Owner {
	Keyboard,
	Osc11,
	PrivateMode(u32),
	ProgramStatus,
	/// The numeric suffix of the probe's `omp-probe-N` identifier.
	Osc99(u32),
	Glyph(GlyphPhase),
	Tsp,
	/// The `drain_input` call that sent it.
	Drain(u32),
}

impl Session {
	/// DA1 reply: resolve the oldest outstanding sentinel.
	///
	/// The reply is swallowed regardless of whether an earlier
	/// capability-specific response already succeeded. `CSI ? … c` is
	/// exclusively a terminal->host report, so it is swallowed even with no
	/// outstanding sentinel — a reply that arrives after the FIFO drains (slow
	/// SSH/PTY links) must never reach the composer as literal text (#8542).
	pub(super) fn handle_device_attributes(
		&mut self,
		now: Millis,
		sixel: bool,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		// Publish graphics support without forwarding DA1 bytes to application
		// input or changing ownership of the existing probe sentinel.
		if self.caps.sixel_advertised != Some(sixel) {
			self.caps.sixel_advertised = Some(sixel);
			out.push(Event::Sixel { supported: sixel, graphics: false });
		}
		let Some(owner) = self.probes.pop_front() else {
			// Late/unowned reply: nothing to resolve, just drop the bytes.
			return;
		};
		match owner {
			Owner::Osc11 => self.handle_osc11_sentinel(now, device),
			Owner::PrivateMode(mode) => {
				// DA1 beat the DECRPM reply. The terminal cannot report this
				// capability, but may still implement it; keep that distinction
				// so static terminal detection is not incorrectly downgraded.
				self.resolve_private_mode(now, mode, false, false, None, device, out);
			},
			Owner::Keyboard => {
				// Keyboard probe sentinel: kitty reply never arrived → fall back
				// to modifyOtherKeys only where the resolved terminal is known
				// enough to tolerate it.
				self.keyboard.fallback_at = None;
				self.enable_keyboard_fallback(device);
			},
			Owner::ProgramStatus => self.resolve_program_status(false, out),
			Owner::Osc99(id) => self.resolve_osc99(id, false, out),
			Owner::Glyph(phase) => {
				// The support-phase sentinel is answered after the `s` reply that
				// already advanced the handshake; only a sentinel from the phase
				// still awaiting its reply means that reply never came.
				if phase == self.caps.glyph_phase {
					self.resolve_glyph(false, out);
				}
			},
			Owner::Drain(id) => self.answer_drain_sentinel(id),
			Owner::Tsp => {
				// DA1 before any `tsp;r` reply: the terminal doesn't speak TSP.
				self.resolve_tsp(
					Err(
						"DA1 was answered before a hello reply: the terminal, or a layer in between, \
						 dropped the APC query"
							.to_owned(),
					),
					out,
				);
			},
		}
	}
}
