//! Registration descriptors: variables, commands, actions, and their flags.
//!
//! Specs are `'static` const-constructible records so the [`var!`],
//! [`cmd!`], and [`action!`] macros can build them at link time. All
//! callbacks are plain `fn` pointers — stateful handlers reach their state
//! through [`Ctx::user`](crate::Ctx::user).
//!
//! [`var!`]: crate::var
//! [`cmd!`]: crate::cmd
//! [`action!`]: crate::action

use omp_core::Str;

use crate::{Args, ConResult, Ctx, TypeSpec, Value};

/// Behavior flags on a console variable.
///
/// Semantics (persistence, cheat gating, replication) live here — never in
/// the variable's name.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VarFlags(u32);

impl VarFlags {
	/// Persisted by [`Ctx::dump`](crate::Ctx::dump) when diverging from default.
	pub const ARCHIVE: Self = Self(1);
	/// No flags.
	pub const NONE: Self = Self(0);
	/// Every committed change is announced through the reply sink.
	pub const NOTIFY: Self = Self(1 << 3);
	/// Scripts can read but never write; host code still can.
	pub const READONLY: Self = Self(1 << 2);
	/// Authority-owned: mirrored to replicas, locally immutable on them.
	pub const REPLICATED: Self = Self(1 << 4);
	/// Writes belong in the journal-derived `<meta><con>` subtree.
	pub const SESSION: Self = Self(1 << 5);
	/// Script writes require the `sv_cheats` gate to be enabled.
	pub const UNSAFE: Self = Self(1 << 1);

	/// Union of `self` and `other`.
	#[must_use]
	pub const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Whether every flag in `other` is set in `self`.
	#[must_use]
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}
}

/// Post-commit change hook: `(ctx, old, new)`, fired only on actual change.
pub type ChangeHook = fn(&Ctx, &Value, &Value);
/// Pre-commit veto hook; an `Err` reason blocks the write.
pub type ValidateHook = fn(&Ctx, &Value) -> Result<(), Str>;
/// Command entry point.
pub type CmdHandler = fn(&Ctx, &Args<'_>) -> ConResult<()>;
/// Action edge hook, fired on the 0→1 press or 1→0 release transition.
pub type ActionHook = fn(&Ctx);

/// Completion source for a variable value or command argument.
///
/// Independent of what the *type* already implies: enum variants and
/// booleans complete automatically without a hint.
#[derive(Clone, Copy, Debug)]
pub enum Hint {
	/// Nothing beyond type-implied completion.
	None,
	/// Named provider group, resolved against
	/// [`Ctx::register_completer`](crate::Ctx::register_completer) and the
	/// built-in `con::*` groups.
	Group(&'static str),
	/// Static suggested spellings.
	Suggest(&'static [&'static str]),
}

/// Console variable descriptor.
///
/// Built by [`var!`](crate::var); product/plugin registration uses the owned
/// [`DynamicVarSpec`](crate::DynamicVarSpec) instead.
pub struct VarSpec {
	/// Full `::`-separated name, e.g. `sv::gravity`.
	pub name:      &'static str,
	/// Human description (doc comment of the declaration).
	pub desc:      &'static str,
	/// Value type descriptor.
	pub ty:        &'static TypeSpec,
	/// Producer of the default value.
	pub default:   fn() -> Value,
	/// Inclusive numeric lower clamp (`Int`/`Float` kinds).
	pub min:       Option<f64>,
	/// Inclusive numeric upper clamp (`Int`/`Float` kinds).
	pub max:       Option<f64>,
	/// Behavior flags.
	pub flags:     VarFlags,
	/// Value completion hint.
	pub hint:      Hint,
	/// Post-commit change hook.
	pub on_change: Option<ChangeHook>,
	/// Pre-commit veto hook.
	pub validate:  Option<ValidateHook>,
	/// Consumer-owned declaration metadata in declaration order.
	pub meta:      &'static [(&'static str, &'static str)],
}

impl VarSpec {
	/// New spec with no constraints, flags, hints, metadata, or hooks.
	#[must_use]
	pub const fn new(
		name: &'static str,
		desc: &'static str,
		ty: &'static TypeSpec,
		default: fn() -> Value,
	) -> Self {
		Self {
			name,
			desc,
			ty,
			default,
			min: None,
			max: None,
			flags: VarFlags::NONE,
			hint: Hint::None,
			on_change: None,
			validate: None,
			meta: &[],
		}
	}

	/// Sets the inclusive lower clamp.
	#[must_use]
	pub const fn min(mut self, v: f64) -> Self {
		self.min = Some(v);
		self
	}

	/// Sets the inclusive upper clamp.
	#[must_use]
	pub const fn max(mut self, v: f64) -> Self {
		self.max = Some(v);
		self
	}

	/// Adds behavior flags.
	#[must_use]
	pub const fn flag(mut self, flags: VarFlags) -> Self {
		self.flags = self.flags.with(flags);
		self
	}

	/// Sets the completion hint.
	#[must_use]
	pub const fn hint(mut self, hint: Hint) -> Self {
		self.hint = hint;
		self
	}

	/// Installs the post-commit change hook.
	#[must_use]
	pub const fn on_change(mut self, hook: ChangeHook) -> Self {
		self.on_change = Some(hook);
		self
	}

	/// Installs the pre-commit veto hook.
	#[must_use]
	pub const fn validate(mut self, hook: ValidateHook) -> Self {
		self.validate = Some(hook);
		self
	}

	/// Sets consumer-owned declaration metadata.
	#[must_use]
	pub const fn meta(mut self, meta: &'static [(&'static str, &'static str)]) -> Self {
		self.meta = meta;
		self
	}

	/// Returns the first value declared for `key`.
	#[must_use]
	pub fn meta_get(&self, key: &str) -> Option<&'static str> {
		self
			.meta
			.iter()
			.find_map(|&(candidate, value)| (candidate == key).then_some(value))
	}

	/// Iterates every value declared for `key` in declaration order.
	pub fn meta_all<'a>(&'a self, key: &'a str) -> impl Iterator<Item = &'static str> + 'a {
		self
			.meta
			.iter()
			.filter_map(move |&(candidate, value)| (candidate == key).then_some(value))
	}
}

/// Declared command argument (drives help and completion; commands accept
/// surplus trailing arguments beyond the declared list).
pub struct ArgSpec {
	/// Argument display name.
	pub name:     &'static str,
	/// Argument type descriptor.
	pub ty:       &'static TypeSpec,
	/// Whether dispatch fails when the argument is absent.
	pub required: bool,
	/// Completion hint.
	pub hint:     Hint,
}

impl ArgSpec {
	/// New required argument with no hint.
	#[must_use]
	pub const fn new(name: &'static str, ty: &'static TypeSpec) -> Self {
		Self { name, ty, required: true, hint: Hint::None }
	}

	/// Marks the argument optional.
	#[must_use]
	pub const fn optional(mut self) -> Self {
		self.required = false;
		self
	}

	/// Sets the completion hint.
	#[must_use]
	pub const fn hint(mut self, hint: Hint) -> Self {
		self.hint = hint;
		self
	}
}

/// Console command descriptor. Built by [`cmd!`](crate::cmd).
pub struct CmdSpec {
	/// Full `::`-separated name (bare names are reserved for console core).
	pub name:    &'static str,
	/// Human description.
	pub desc:    &'static str,
	/// Declared arguments.
	pub args:    &'static [ArgSpec],
	/// Entry point.
	pub handler: CmdHandler,
}

impl CmdSpec {
	/// New command descriptor.
	#[must_use]
	pub const fn new(
		name: &'static str,
		desc: &'static str,
		args: &'static [ArgSpec],
		handler: CmdHandler,
	) -> Self {
		Self { name, desc, args, handler }
	}
}

/// Held-input action descriptor: registers the `+name` / `-name` command
/// pair. Built by [`action!`](crate::action).
pub struct ActionSpec {
	/// Base name without the `+`/`-` sign.
	pub name:       &'static str,
	/// Human description.
	pub desc:       &'static str,
	/// Fired on the 0→1 press edge.
	pub on_press:   Option<ActionHook>,
	/// Fired on the 1→0 release edge.
	pub on_release: Option<ActionHook>,
}

impl ActionSpec {
	/// New action with no edge hooks.
	#[must_use]
	pub const fn new(name: &'static str, desc: &'static str) -> Self {
		Self { name, desc, on_press: None, on_release: None }
	}

	/// Installs the press-edge hook.
	#[must_use]
	pub const fn on_press(mut self, hook: ActionHook) -> Self {
		self.on_press = Some(hook);
		self
	}

	/// Installs the release-edge hook.
	#[must_use]
	pub const fn on_release(mut self, hook: ActionHook) -> Self {
		self.on_release = Some(hook);
		self
	}
}

/// One link-time registration: a var, command, or action.
///
/// Collected through [`REGISTRY`](crate::REGISTRY) by the declaration macros
/// and folded into every [`Ctx`] at construction.
#[derive(Clone, Copy)]
pub enum RegItem {
	/// Variable registration.
	Var(&'static VarSpec),
	/// Command registration.
	Cmd(&'static CmdSpec),
	/// Action registration.
	Action(&'static ActionSpec),
}

impl RegItem {
	/// Full registered name (actions report their base name).
	#[must_use]
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Var(v) => v.name,
			Self::Cmd(c) => c.name,
			Self::Action(a) => a.name,
		}
	}

	/// Human description.
	#[must_use]
	pub const fn desc(&self) -> &'static str {
		match self {
			Self::Var(v) => v.desc,
			Self::Cmd(c) => c.desc,
			Self::Action(a) => a.desc,
		}
	}
}
