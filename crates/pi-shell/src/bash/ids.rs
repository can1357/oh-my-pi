//! Identifiers shared by the engine, its hosts and its events.

use std::fmt;

use serde::{Deserialize, Serialize};

/// AST node id from the syntax crate (preorder index within one unit).
///
/// Named `AstNodeId` here so it never collides with the mesh `NodeId` other
/// parts use.
pub use crate::bash::syntax::NodeId as AstNodeId;

/// One submitted script ([`Shell::submit`](crate::bash::Shell::submit));
/// reported back in [`Step::Done`](crate::bash::Step::Done) and every event of
/// that script.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RunId(pub u64);

/// One host callout returned as [`Step::Call`](crate::bash::Step::Call),
/// answered by [`Shell::complete`](crate::bash::Shell::complete).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CallId(pub u64);

/// Virtual process id (`$BASHPID`).
///
/// Allocated from [`Vpid::BASE`] = 2^30 so it never looks like an OS pid. A
/// background job that is just one external program (`cmd &`, `{ exec cmd; }
/// &`) is known by that program's OS pid instead
/// ([`Job::os_pid`](crate::bash::store::Job::os_pid): `$!`, `jobs -l`), and
/// `kill`, `wait` and `disown` accept either.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Vpid(pub u32);

impl Vpid {
	/// First vpid (`EngineConfig::vpid_base` default).
	pub const BASE: u32 = 1 << 30;
}

/// Job number (`%1`); a pipeline or a single command is one job.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct JobId(pub u32);

/// Compiled unit id: BLAKE3 of (unit bytes, mode, features, alias
/// substitutions). Stable across processes; keys `BlobSlot::Unit`.
///
/// Serialized as 64 lowercase hex digits in human-readable formats (JSON
/// events) and as 32 raw bytes otherwise (frames).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct UnitId(pub [u8; 32]);

impl Serialize for UnitId {
	fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		if s.is_human_readable() {
			s.collect_str(self)
		} else {
			self.0.serialize(s)
		}
	}
}

impl<'de> Deserialize<'de> for UnitId {
	fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		if !d.is_human_readable() {
			return <[u8; 32]>::deserialize(d).map(Self);
		}
		let hex = <std::borrow::Cow<'de, str>>::deserialize(d)?;
		let mut id = [0u8; 32];
		let ok = hex.len() == 64
			&& hex
				.as_bytes()
				.as_chunks::<2>()
				.0
				.iter()
				.zip(&mut id)
				.all(|(pair, out)| {
					std::str::from_utf8(pair)
						.ok()
						.and_then(|p| u8::from_str_radix(p, 16).ok())
						.map(|b| *out = b)
						.is_some()
				});
		if ok {
			Ok(Self(id))
		} else {
			Err(serde::de::Error::custom("unit id is not 64 hex digits"))
		}
	}
}

impl fmt::Display for UnitId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		for b in &self.0 {
			write!(f, "{b:02x}")?;
		}
		Ok(())
	}
}

impl fmt::Debug for UnitId {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "UnitId({self})")
	}
}

/// Host-assigned handle of a host callout
/// ([`Resolved::Tool`](crate::bash::Resolved::Tool)).
///
/// Opaque to the engine; the host maps it back to its registry entry when it
/// runs the [`ToolCall`](crate::bash::ToolCall).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ToolRef(pub u64);

/// Host-assigned handle of a native command run as a
/// [`Task`](crate::bash::Task)
/// ([`Resolved::Native`](crate::bash::Resolved::Native) /
/// [`Resolved::Device`](crate::bash::Resolved::Device)).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NativeRef(pub u64);

/// Output tag of one command execution: hosts attach it to every byte the
/// command writes so a UI aligns output with the event stream.
///
/// (Not `ExecId`: hosts use that name for their environment id.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CmdTag {
	/// Script the command belongs to.
	pub run:  RunId,
	/// Virtual process that runs it.
	pub vpid: Vpid,
	/// Per-shell command sequence number.
	pub seq:  u64,
}

/// Shell emulation mode (sticky `emulate`).
///
/// A mode is an emulation; its [`Dialect`] is the engine personality
/// (grammar, builtin table, special parameters, option table,
/// diagnostics). Every unit, function and trap records the mode it was
/// defined in; each vproc runs in a current mode (`Event::mode`). Bash is
/// the default.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum ModeId {
	/// bash 5.3.
	#[default]
	Bash,
	/// zsh 5.9.
	Zsh,
	/// POSIX `sh` on the bash dialect (bash posix mode): `sh` invocation,
	/// `emulate sh` from bash code.
	Sh,
	/// zsh's ksh emulation (`emulate ksh`).
	Ksh,
	/// zsh's sh emulation (`emulate sh` from zsh code, `zsh --emulate sh`):
	/// the zsh dialect with zsh's sh option defaults.
	#[strum(serialize = "zsh-sh")]
	#[serde(rename = "zsh-sh")]
	ZshSh,
}

crate::bash::packed_names::packed_names!(ModeId, Display);

impl ModeId {
	/// The engine personality this mode runs on.
	pub const fn dialect(self) -> Dialect {
		match self {
			Self::Bash | Self::Sh => Dialect::Bash,
			Self::Zsh | Self::Ksh | Self::ZshSh => Dialect::Zsh,
		}
	}

	/// The emulation's name as `emulate` prints it.
	pub const fn emulation(self) -> &'static str {
		match self {
			Self::Bash => "bash",
			Self::Zsh => "zsh",
			Self::Sh | Self::ZshSh => "sh",
			Self::Ksh => "ksh",
		}
	}

	/// The mode `emulate NAME` selects from code running in `self`'s
	/// dialect (`sh` stays in the current dialect); `None` for an unknown
	/// or unsupported emulation (`csh`).
	pub const fn for_emulate(self, name: &[u8]) -> Option<Self> {
		Some(match name {
			b"bash" => Self::Bash,
			b"zsh" => Self::Zsh,
			b"ksh" => Self::Ksh,
			b"sh" => match self.dialect() {
				Dialect::Bash => Self::Sh,
				Dialect::Zsh => Self::ZshSh,
			},
			_ => return None,
		})
	}
}

/// Engine personality of a [`ModeId`]: which grammar, builtins, option
/// table and diagnostics a mode uses. Mode options never cross a dialect
/// boundary; env options (`errexit`, `xtrace`, …) are shared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
	/// bash 5.3 (modes `bash`, `sh`).
	Bash,
	/// zsh 5.9 (modes `zsh`, `ksh`, `zsh-sh`).
	Zsh,
}

/// Target platform semantics (signal numbers, PATHEXT, …); overridable in
/// tests through `EngineConfig::platform`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum Platform {
	/// Linux (the bash 5.3 oracle platform).
	Linux,
	/// macOS.
	MacOs,
	/// Windows.
	Windows,
}

impl Platform {
	/// The platform this binary was built for.
	pub const fn current() -> Self {
		if cfg!(target_os = "macos") {
			Self::MacOs
		} else if cfg!(windows) {
			Self::Windows
		} else {
			Self::Linux
		}
	}
}

/// Engine-native builtins: the ones that touch interpreter
/// state. Hosts return
/// [`Resolved::Intrinsic`](crate::bash::Resolved::Intrinsic) for them; their
/// names parse with [`str::parse`].
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
	strum::EnumIter,
)]
#[strum(serialize_all = "lowercase")]
#[expect(missing_docs, reason = "each variant is the builtin of the same name")]
pub enum IntrinsicId {
	#[strum(serialize = ":")]
	Colon,
	#[strum(serialize = ".")]
	Dot,
	#[strum(serialize = "[")]
	Bracket,
	Alias,
	Bg,
	Bind,
	Break,
	Builtin,
	Caller,
	Cd,
	Command,
	Compgen,
	Complete,
	Compopt,
	Continue,
	Declare,
	Dirs,
	Disown,
	Echo,
	Emulate,
	Enable,
	Eval,
	Exec,
	Exit,
	Export,
	False,
	Fc,
	Fg,
	Getopts,
	Hash,
	Jobs,
	Kill,
	Let,
	Local,
	Logout,
	Mapfile,
	Readarray,
	Popd,
	Printf,
	Pushd,
	Pwd,
	Read,
	Readonly,
	Return,
	Set,
	Setopt,
	Unsetopt,
	Shift,
	Shopt,
	Source,
	Suspend,
	Test,
	Times,
	Trap,
	True,
	Type,
	Typeset,
	Ulimit,
	Umask,
	Unalias,
	Unset,
	Wait,
	Help,
	/// bash's `examples/loadables/strmatch` builtin, usable once `enable -f
	/// FILE strmatch` loaded it (natively; no object is opened).
	Strmatch,
	History,
	Print,
	Pushln,
	Integer,
	Float,
	Functions,
	Unfunction,
	Autoload,
	Whence,
	Which,
	Where,
	Zmodload,
	Unhash,
	Rehash,
	Disable,
	Chdir,
	Getln,
	Bindkey,
	Vared,
	Zle,
	Compctl,
	Compcall,
	Compadd,
	Compset,
	Comparguments,
	Compdescribe,
	Compfiles,
	Compgroups,
	Compquote,
	Comptags,
	Comptry,
	Compvalues,
}

crate::bash::packed_names::packed_names!(IntrinsicId, Display);

impl IntrinsicId {
	/// The intrinsic named `name`, if any.
	pub fn from_name(name: &[u8]) -> Option<Self> {
		std::str::from_utf8(name).ok()?.parse().ok()
	}

	/// The intrinsic command `name` runs in mode `mode` (each dialect has
	/// its own builtin table): what a host's
	/// [`Host::resolve`](crate::bash::Host::resolve) returns as
	/// [`Resolved::Intrinsic`](crate::bash::Resolved::Intrinsic).
	pub fn lookup(name: &[u8], mode: ModeId) -> Option<Self> {
		Self::from_name(name).filter(|id| id.available_in(mode.dialect()))
	}

	/// Whether the builtin exists in `dialect`: bash-only builtins (`shopt`,
	/// `mapfile`, `caller`, …) are not zsh's, zsh-only ones (`setopt`, …)
	/// not bash's.
	pub const fn available_in(self, dialect: Dialect) -> bool {
		match self {
			Self::Shopt
			| Self::Mapfile
			| Self::Readarray
			| Self::Compgen
			| Self::Complete
			| Self::Compopt
			| Self::Bind
			| Self::Caller
			| Self::Help
			| Self::Strmatch => matches!(dialect, Dialect::Bash),
			Self::Setopt
			| Self::Unsetopt
			| Self::Print
			| Self::Pushln
			| Self::Integer
			| Self::Float
			| Self::Functions
			| Self::Unfunction
			| Self::Autoload
			| Self::Whence
			| Self::Which
			| Self::Where
			| Self::Zmodload
			| Self::Unhash
			| Self::Rehash
			| Self::Disable
			| Self::Chdir
			| Self::Getln
			| Self::Bindkey
			| Self::Vared
			| Self::Zle
			| Self::Compctl
			| Self::Compcall
			| Self::Compadd
			| Self::Compset
			| Self::Comparguments
			| Self::Compdescribe
			| Self::Compfiles
			| Self::Compgroups
			| Self::Compquote
			| Self::Comptags
			| Self::Comptry
			| Self::Compvalues => matches!(dialect, Dialect::Zsh),
			_ => true,
		}
	}
}
