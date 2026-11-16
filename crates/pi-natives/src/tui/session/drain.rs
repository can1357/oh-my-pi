//! Input drain before exit: keeps kitty key-release events (and in-flight
//! TSP acknowledgements) from leaking to the parent shell over slow links.

use super::{Session, probe::Owner};
use crate::{
	term::Device,
	tui::types::{Event, Millis},
};

/// An input drain in progress.
pub(super) struct Drain {
	/// Identifies this drain's DA1 sentinel in the probe FIFO.
	id:                   u32,
	/// Hard stop.
	end:                  Millis,
	/// The drain ends early once no input arrived for this long.
	idle_ms:              Millis,
	pub(super) last_data: Millis,
	/// False while this drain's DA1 sentinel is unanswered.
	sentinel_answered:    bool,
}

impl Drain {
	pub(super) const fn deadline(&self) -> Millis {
		if self.sentinel_answered {
			self.end.min(self.last_data + self.idle_ms)
		} else {
			self.end
		}
	}
}

impl Session {
	/// Drain stdin before exiting to prevent Kitty key release events from
	/// leaking to the parent shell over slow SSH connections. Input arriving
	/// meanwhile is discarded by the engine (see [`draining`](Self::draining));
	/// terminal reports are still consumed. Ends with [`Event::InputDrained`]
	/// after `max_ms`, or earlier once no input arrived within `idle_ms`.
	pub fn drain_input(
		&mut self,
		now: Millis,
		max_ms: Millis,
		idle_ms: Millis,
		device: &mut Device,
		out: &mut Vec<Event>,
	) {
		self.release_keyboard(device, out);
		self.drain_serial = self.drain_serial.wrapping_add(1);
		let mut drain = Drain {
			id: self.drain_serial,
			end: now + max_ms,
			idle_ms,
			last_data: now,
			sentinel_answered: true,
		};
		// For an active or pending optimistic TSP session, the terminal may emit
		// asynchronous frame acknowledgments (`tsp;e;{"ev":"ack",…}`) after the
		// idle window. A DA1 sentinel is processed in FIFO order after
		// everything written before it, so awaiting its reply swallows in-flight
		// acks before handing the terminal back to the shell. Ordinary non-TSP
		// terminals emit no background output acks and must not be queried, or
		// their DA1 reply risks leaking into the shell prompt.
		let tsp_active = self.caps.tsp_hello || (self.caps.tsp_pending && self.facts.tsp_expected);
		if tsp_active && self.caps.sixel_advertised.is_some() && !self.link.dead {
			drain.sentinel_answered = false;
			self.probes.push_back(Owner::Drain(drain.id));
			self.link.send(device, |batch| {
				batch.query_device_attributes();
			});
		}
		self.drain = Some(drain);
	}

	/// True while a drain is in progress: the engine drops keys and pastes
	/// instead of delivering them.
	pub const fn draining(&self) -> bool {
		self.drain.is_some()
	}

	/// The DA1 sentinel of drain `id` was answered. A sentinel outliving its
	/// drain (the hard stop came first) answers nothing.
	pub(super) const fn answer_drain_sentinel(&mut self, id: u32) {
		if let Some(drain) = &mut self.drain
			&& drain.id == id
		{
			drain.sentinel_answered = true;
		}
	}

	pub(super) fn tick_drain(&mut self, now: Millis, out: &mut Vec<Event>) {
		if self
			.drain
			.as_ref()
			.is_some_and(|drain| drain.deadline() <= now)
		{
			self.drain = None;
			out.push(Event::InputDrained);
		}
	}
}
