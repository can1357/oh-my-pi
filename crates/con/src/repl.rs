//! Replication: mirroring `REPLICATED` variables from an authority to
//! replicas.
//!
//! The schema is transport-agnostic: the authority drains dirty replicated
//! vars into [`Patch`] records (serde-serializable), the host ships them,
//! and replicas apply them. Replicas cannot write replicated vars locally —
//! the flag is a trust boundary, exactly like `sv_` in the Source lineage,
//! except enforced by the engine instead of convention.

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::Display;

use crate::{ConError, ConResult, Ctx, Output, RegItem, SetSource, Severity, Value, VarFlags};

/// Which side of the replication relationship a [`Ctx`] plays.
#[derive(Clone, Copy, Debug, Default, Display, Eq, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum Role {
	/// No replication: replicated vars behave like plain vars.
	#[default]
	Standalone,
	/// Owns replicated vars; local changes are drained as patches.
	Authority,
	/// Mirrors the authority; local writes to replicated vars are rejected.
	Replica,
}

/// Read-only local view of authority-owned replicated values.
pub struct Replica {
	ctx: Ctx,
}

impl Replica {
	/// Creates a replica with the full declared registry.
	#[must_use]
	pub fn new() -> Self {
		Self { ctx: Ctx::builder().role(Role::Replica).build() }
	}

	/// Applies a drained authority update batch.
	pub fn apply(&self, patches: Vec<Patch>) -> ConResult<()> {
		self.ctx.apply_replication(patches)
	}

	/// Reads one effective value.
	#[must_use]
	pub fn get(&self, name: &str) -> Option<Value> {
		self.ctx.get(name)
	}

	/// Runs local console input; writes to `REPLICATED` variables are rejected.
	pub fn run(&self, line: &str) -> ConResult<Output> {
		self.ctx.run(line)
	}

	/// Borrows the underlying context for completion and inspection.
	#[must_use]
	pub const fn context(&self) -> &Ctx {
		&self.ctx
	}
}

impl Default for Replica {
	fn default() -> Self {
		Self::new()
	}
}

/// One replicated variable update on the wire.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Patch {
	/// Full variable name.
	pub name:  Str,
	/// New value.
	pub value: Value,
}

impl Ctx {
	/// Drains pending replicated changes (authority only; empty elsewhere).
	///
	/// Each var appears at most once with its latest value; order is
	/// registration order.
	pub fn drain_replication(&self) -> Vec<Patch> {
		if self.role() != Role::Authority {
			return Vec::new();
		}
		self.collect_patches(true)
	}

	/// Full replicated state, for synchronizing a newly joined replica.
	/// Does not consume dirty bits.
	pub fn replication_snapshot(&self) -> Vec<Patch> {
		self.collect_patches(false)
	}

	/// Applies authority patches on a replica.
	///
	/// Unknown names and non-conforming values are reported through the
	/// sink and skipped (the authority may be newer); they never abort the
	/// batch. `on_change` hooks fire; `validate` hooks do not — the
	/// authority already validated.
	pub fn apply_replication(&self, patches: impl IntoIterator<Item = Patch>) -> ConResult<()> {
		if self.role() != Role::Replica {
			return Err(ConError::RoleMismatch { role: self.role() });
		}
		for patch in patches {
			if let Err(err) = self.set_value(patch.name.as_str(), patch.value, SetSource::Replication)
			{
				self.reply_fmt(Severity::Warn, format_args!("replication skipped: {err}"));
			}
		}
		Ok(())
	}

	fn collect_patches(&self, drain: bool) -> Vec<Patch> {
		let mut out = Vec::new();
		for idx in 0..self.item_count() {
			let Some((RegItem::Var(spec), state)) = self.item_at(idx) else {
				continue;
			};
			if !spec.flags.contains(VarFlags::REPLICATED) {
				continue;
			}
			if drain && !state.take_dirty() {
				continue;
			}
			out.push(Patch { name: Str::new_static(spec.name), value: state.value() });
		}
		out
	}
}
