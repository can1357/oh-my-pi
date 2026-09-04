//! Bridge between the process console and the journal-backed `<meta><con>`
//! component (ADR 0012 `SESSION` flag, ADR 0003 one session tree).
//!
//! Composition hydrates the console's session layer from the opened
//! journal, then every committed `SESSION` write the console publishes is
//! folded back into the journal as a `patch@1` on `<meta><con>`: at the
//! next turn boundary through a kernel [`LiveComponent`], and at process
//! exit through [`ConJournal::flush`]. Resume restores the values, rewind
//! re-derives them from the live chain, and nothing keeps convar state
//! outside the tree.

use std::sync::Arc;

use omp_agent::{LiveComponent, LiveComponentError};
use omp_con::{Ctx, Value};
use omp_core::{FastHashMap, Str};
use omp_dom::{Dom, Op, Txn};
use omp_journal::{Entry, Kind, KindName};
use omp_session::{
	Session, SessionError,
	components::con::{ConWrite, con_write_txn, con_writes},
};
use parking_lot::Mutex;

/// Provenance recorded on journaled session writes.
const ORIGIN: &str = "session";

/// The one console-to-journal channel for a composed session.
pub struct ConJournal {
	ctx:     Arc<Ctx>,
	writes:  flume::Receiver<(Str, Value)>,
	/// Writes observed but not yet journaled, last value per name.
	pending: Mutex<FastHashMap<Str, Value>>,
}

impl ConJournal {
	/// Restores the journal's `<meta><con>` values into `ctx`'s session
	/// layer, then subscribes to the console's later `SESSION` writes.
	///
	/// A journaled name this build no longer registers is skipped with a
	/// warning rather than aborting composition: cfg and journal data from
	/// older builds is user data (ADR 0013).
	pub fn attach(ctx: Arc<Ctx>, dom: &Dom) -> Self {
		hydrate(&ctx, dom);
		let writes = ctx.subscribe_session_writes();
		Self { ctx, writes, pending: Mutex::new(FastHashMap::default()) }
	}

	/// Re-derives the session layer after the tree changed underneath the
	/// console (rewind, session switch): names no longer on the live chain
	/// are cleared, the rest are restored, and pending writes are dropped
	/// because they described the abandoned branch.
	pub fn resync(&self, dom: &Dom) {
		let live = con_writes(dom);
		let stale = self
			.ctx
			.session_writes()
			.filter(|(name, _)| !live.iter().any(|write| write.name == *name))
			.map(|(name, _)| name)
			.collect::<Vec<_>>();
		for name in stale {
			if let Err(error) = self.ctx.clear_session_write(name.as_str()) {
				tracing::warn!(%name, %error, "session convar could not be cleared on resync");
			}
		}
		hydrate(&self.ctx, dom);
		self.pending.lock().clear();
		while self.writes.try_recv().is_ok() {}
	}

	/// Drains the console channel into the pending map.
	fn collect(&self) {
		let mut pending = self.pending.lock();
		while let Ok((name, value)) = self.writes.try_recv() {
			pending.insert(name, value);
		}
	}

	/// DOM operations that bring `<meta><con>` up to date with every write
	/// committed since the last flush; writes already reflected in the tree
	/// (a restore echo, an idempotent set) produce nothing.
	#[must_use]
	pub fn pending_ops(&self, dom: &Dom, cause: omp_journal::EntryId) -> Vec<Op> {
		self.collect();
		let mut pending = self.pending.lock();
		if pending.is_empty() {
			return Vec::new();
		}
		let current = con_writes(dom);
		let mut ops = Vec::new();
		for (name, value) in pending.drain() {
			let write = ConWrite {
				name:   name.clone(),
				value:  Str::new(value.to_string()),
				origin: Str::new_static(ORIGIN),
			};
			if current
				.iter()
				.any(|existing| existing.name == write.name && existing.value == write.value)
			{
				continue;
			}
			match con_write_txn(dom, cause, &write) {
				Ok(txn) => ops.extend(txn.ops),
				Err(error) => {
					tracing::warn!(%name, %error, "session convar write could not be journaled");
				},
			}
		}
		ops
	}

	/// Journals every pending write now (process exit, session switch).
	pub fn flush(&self, session: &mut Session) -> Result<(), SessionError> {
		let Some(cause) = session.head() else {
			return Ok(());
		};
		let ops = self.pending_ops(session.dom(), cause);
		if ops.is_empty() {
			return Ok(());
		}
		session.patch(Txn { cause, label: Some(Str::new_static("con.session")), ops })?;
		Ok(())
	}

	/// The kernel-side reducer that journals pending writes at every turn
	/// boundary (before the request is projected, so the journaled value
	/// and the value the kernel reads agree).
	#[must_use]
	pub fn live_component(self: &Arc<Self>) -> Box<dyn LiveComponent> {
		Box::new(TurnBoundary(Arc::clone(self)))
	}
}

fn hydrate(ctx: &Ctx, dom: &Dom) {
	for write in con_writes(dom) {
		if let Err(error) = ctx.restore_session_write(write.name.as_str(), write.value.as_str()) {
			tracing::warn!(name = %write.name, %error, "journaled session convar not restored");
		}
	}
}

impl omp_agent::SessionStateBridge for ConJournal {
	fn flush(&self, session: &mut Session) -> Result<(), SessionError> {
		ConJournal::flush(self, session)
	}

	fn resync(&self, dom: &Dom) {
		ConJournal::resync(self, dom);
	}
}

struct TurnBoundary(Arc<ConJournal>);

impl LiveComponent for TurnBoundary {
	fn id(&self) -> &str {
		"con"
	}

	fn interested(&self, kind: &Kind) -> bool {
		*kind == Kind::known(KindName::TurnStart)
	}

	fn reduce(&self, entry: &Entry, dom: &Dom) -> Result<Vec<Op>, LiveComponentError> {
		Ok(self.0.pending_ops(dom, entry.id))
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_session::{ComponentRegistry, Session, components::con::con_writes};

	use super::ConJournal;

	fn open(path: &std::path::Path) -> Session {
		if path.exists() {
			Session::open(path, ComponentRegistry::standard()).expect("session opens")
		} else {
			Session::create(path, ComponentRegistry::standard()).expect("session creates")
		}
	}

	/// ADR 0012 `SESSION`: a value set on the console is journaled, survives
	/// a reopen into a fresh console, and never touches the archive layer.
	#[test]
	fn session_writes_round_trip_through_the_journal() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("con.oms");
		let ctx = Arc::new(Ctx::new());
		let mut session = open(&path);
		let journal = Arc::new(ConJournal::attach(Arc::clone(&ctx), session.dom()));
		ctx.run("ai_fastmode 1").expect("session write");
		ctx.run("ai_thinking low").expect("session write");
		assert!(con_writes(session.dom()).is_empty(), "nothing journaled before a flush");
		journal.flush(&mut session).expect("flush journals");
		let names = con_writes(session.dom())
			.into_iter()
			.map(|write| (write.name, write.value))
			.collect::<Vec<_>>();
		assert!(names.contains(&("ai_fastmode".into(), "true".into())), "{names:?}");
		assert!(names.contains(&("ai_thinking".into(), "low".into())), "{names:?}");
		// An idempotent second flush journals nothing.
		let head = session.head();
		journal.flush(&mut session).expect("no-op flush");
		assert_eq!(session.head(), head);
		drop(session);

		let restored = Arc::new(Ctx::new());
		let reopened = open(&path);
		let rejournal = ConJournal::attach(Arc::clone(&restored), reopened.dom());
		assert!(omp_agent::AI_FASTMODE.get(&restored));
		assert_eq!(omp_agent::AI_THINKING.get(&restored), "low");
		assert!(
			restored
				.session_writes()
				.any(|(name, _)| name == "ai_fastmode"),
			"restored into the session layer, not the archive"
		);
		// The restore echo is not a new write.
		let cause = reopened.head().expect("head");
		assert!(rejournal.pending_ops(reopened.dom(), cause).is_empty());
	}

	/// ADR 0004: rewinding past the write re-derives the console from the
	/// live chain, so the value falls off with the branch.
	#[test]
	fn resync_after_rewind_drops_values_that_left_the_live_chain() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("rewind.oms");
		let ctx = Arc::new(Ctx::new());
		let mut session = open(&path);
		let journal = ConJournal::attach(Arc::clone(&ctx), session.dom());
		let before = session.head().expect("genesis head");
		ctx.run("ai_fastmode 1").expect("session write");
		journal.flush(&mut session).expect("flush");
		assert!(omp_agent::AI_FASTMODE.get(&ctx));
		session.rewind(before).expect("rewind to genesis");
		omp_agent::SessionStateBridge::resync(&journal, session.dom());
		assert!(!omp_agent::AI_FASTMODE.get(&ctx), "the rewound write is gone");
		assert!(!ctx.session_writes().any(|(name, _)| name == "ai_fastmode"));
	}

	/// The kernel reducer journals pending writes at the turn boundary.
	#[test]
	fn live_component_journals_at_turn_start() {
		let directory = tempfile::tempdir().expect("tempdir");
		let path = directory.path().join("turn.oms");
		let ctx = Arc::new(Ctx::new());
		let mut session = open(&path);
		let journal = Arc::new(ConJournal::attach(Arc::clone(&ctx), session.dom()));
		let component = journal.live_component();
		ctx.run("ai_fastmode 1").expect("session write");
		let turn = session.begin_turn().expect("turn");
		let entry = session.entry(turn).cloned().expect("turn entry");
		assert!(component.interested(&entry.kind));
		let ops = component.reduce(&entry, session.dom()).expect("reduce");
		assert!(!ops.is_empty());
		session
			.patch(omp_dom::Txn { cause: turn, label: None, ops })
			.expect("patch");
		assert!(
			con_writes(session.dom())
				.iter()
				.any(|write| write.name == "ai_fastmode" && write.value == "true")
		);
	}
}
