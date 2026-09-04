//! Typed command-stream control plane with vars, cfg scripts, key binds,
//! held actions, layered engagement values, persistence, and replication.
//!
//! # Model
//!
//! One flat registry holds variables, commands, and actions. Product names
//! use subsystem prefixes (`ai_*`, `cl_*`, `sv_*`). State is a command that
//! stores its argument: `ai_fastmode 1` sets, bare `ai_fastmode` prints, and
//! a config file is a replayed console session. Persistence ([`Ctx::dump`])
//! emits the minimal script that reconstructs archived state from defaults.
//!
//! Unlike the ancestor, values are typed at the variable ([`ConType`],
//! [`TypeSpec`]): ints, floats, bools, strings, enums (with automatic
//! variant completion), lists, and kv blocks. Scripts stay untyped words;
//! the target's spec decides how they parse.
//!
//! # Example
//!
//! ```
//! use omp_con as con;
//! use omp_core::Str;
//!
//! con::var! {
//! 	/// World gravity (u/s²).
//! 	pub static SV_GRAVITY = sv_gravity: i32 {
//! 		default: 800,
//! 		min: 100,
//! 		max: 2000,
//! 		flags: archive,
//! 	};
//! }
//!
//! con::cmd! {
//! 	/// Says hello.
//! 	sv_greet(?who: Str) = |ctx, args| {
//! 		let who = args.opt::<Str>(0)?.unwrap_or_else(|| Str::new_static("world"));
//! 		ctx.reply(con::Severity::Info, who.as_str());
//! 		Ok(())
//! 	};
//! }
//!
//! let ctx = con::Ctx::new();
//! ctx.run("sv_gravity 600; sv_greet").unwrap();
//! assert_eq!(SV_GRAVITY.get(&ctx), 600);
//! ```

mod builtins;
mod chord;
mod complete;
mod ctx;
mod dump;
mod error;
mod handle;
mod layers;
mod macros;
mod repl;
mod script;
mod spec;
mod value;

pub use builtins::SV_CHEATS;
pub use chord::{ChordError, normalize_chord};
pub use complete::{CompleterFn, Suggestion};
pub use ctx::{
	Args, CfgLoader, CfgSaver, Ctx, CtxBuilder, DynamicCmdHandler, DynamicCmdSpec, DynamicVarSpec,
	ExecOutcome, LoaderFn, ObserverFn, Output, SaverFn, SetSource, Severity, SinkFn, Source,
	VarView,
};
pub use dump::{CFG_HEADER_PREFIX, CFG_SCHEMA_VERSION, DumpOptions};
pub use error::{ConError, ConResult, ConfigIoError, ConfigOperation, ParseError};
pub use handle::{Action, CVar};
pub use layers::{LayerId, Origin, Seed, SetReport};
pub use repl::{Patch, Replica, Role};
pub use script::{Arg, Statement, parse};
pub use spec::{
	ActionHook, ActionSpec, ArgSpec, ChangeHook, CmdHandler, CmdSpec, Hint, RegItem, ValidateHook,
	VarFlags, VarSpec,
};
pub use value::{ConType, Kv, Span, TypeSpec, Value, ValueKind};

/// Link-time registration surface: every [`var!`], [`cmd!`], and
/// [`action!`] expansion contributes one entry, and every non-isolated
/// [`Ctx`] folds the slice at construction. Registration is linking, not a
/// call site.
#[linkme::distributed_slice]
pub static REGISTRY: [RegItem];

#[doc(hidden)]
pub mod __private {
	pub use linkme;
	pub use omp_core::Str;
	pub use strum;
}
