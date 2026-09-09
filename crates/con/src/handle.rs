//! Typed static handles produced by the declaration macros.

use std::marker::PhantomData;

use crate::{ConResult, ConType, Ctx, SetSource, VarSpec, spec::ActionSpec};

/// Typed handle to a registered console variable.
///
/// Produced by [`var!`](crate::var); the handle is only a name + type
/// binding, the value itself lives in each [`Ctx`].
pub struct CVar<T: ConType> {
	spec: &'static VarSpec,
	_ty:  PhantomData<fn() -> T>,
}

impl<T: ConType> CVar<T> {
	/// Wraps a static spec. Used by [`var!`](crate::var).
	#[must_use]
	pub const fn new(spec: &'static VarSpec) -> Self {
		Self { spec, _ty: PhantomData }
	}

	/// The underlying spec.
	#[must_use]
	pub const fn spec(&self) -> &'static VarSpec {
		self.spec
	}

	/// Full console name.
	#[must_use]
	pub const fn name(&self) -> &'static str {
		self.spec.name
	}

	/// Current value.
	///
	/// # Panics
	/// When the variable is not registered in `ctx` (an
	/// [`isolated`](crate::CtxBuilder::isolated) context that never
	/// registered it).
	#[must_use]
	pub fn get(&self, ctx: &Ctx) -> T {
		match self.try_get(ctx) {
			Ok(v) => v,
			Err(err) => panic!("cvar `{}`: {err}", self.spec.name),
		}
	}

	/// Current value, surfacing lookup errors.
	pub fn try_get(&self, ctx: &Ctx) -> ConResult<T> {
		ctx.get_typed(self.spec.name)
	}

	/// Sets the value with host provenance (bypasses `READONLY`/`UNSAFE`).
	pub fn set(&self, ctx: &Ctx, value: T) -> ConResult<()> {
		ctx.set_value(self.spec.name, value.into_value(), SetSource::Code)
	}

	/// Restores the default.
	pub fn reset(&self, ctx: &Ctx) -> ConResult<()> {
		ctx.reset(self.spec.name)
	}
}

/// Handle to a held-input action (`+name` / `-name` command pair).
///
/// Produced by [`action!`](crate::action). Multiple keys may hold one
/// action; it stays active until every press is released.
pub struct Action {
	spec: &'static ActionSpec,
}

impl Action {
	/// Wraps a static spec. Used by [`action!`](crate::action).
	#[must_use]
	pub const fn new(spec: &'static ActionSpec) -> Self {
		Self { spec }
	}

	/// Base name (without `+`/`-`).
	#[must_use]
	pub const fn name(&self) -> &'static str {
		self.spec.name
	}

	/// Number of concurrent holds.
	#[must_use]
	pub fn presses(&self, ctx: &Ctx) -> u32 {
		ctx.action_presses(self.spec.name)
	}

	/// Whether at least one press is held.
	#[must_use]
	pub fn is_active(&self, ctx: &Ctx) -> bool {
		self.presses(ctx) > 0
	}
}
