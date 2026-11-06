//! The state-store seam: the shell's persistent state lives in host objects
//! (for example JS objects in a host's heap).
//!
//! **The store is the state, not a copy of it.** Every table is authoritative
//! in the store at all times: the engine keeps no copy of store data and
//! writes each change through with [`StateStore::apply`] when it makes it.
//! Records: global variables (with their attributes and export flags), the
//! root shell's function-local scopes and their variables, functions,
//! aliases, options, traps, jobs, child processes, the directory stack,
//! `hash` entries and the miscellaneous scalars (cwd, umask, `$?`, `$!`,
//! `PIPESTATUS`, positional parameters, counters, …). Only execution
//! position (frames, partial words, pipe bytes, subshell overlays, pending
//! calls) stays in the engine and reaches the store as the `Frames` blob
//! of [`Shell::externalize`](crate::bash::Shell::externalize).
//!
//! Granularity: a record is written by the engine call that changes it,
//! before that call returns. Most are written at the change; the root
//! vproc's `$?`, `PIPESTATUS`, `$!`, job table, `getopts` progress and
//! `ulimit` values (fields the interpreter updates in place) are written
//! at the end of the `step` that changed them, the one returning a
//! [`Step::Call`](crate::bash::Step::Call) included. Inside a
//! [`Host`](crate::bash::Host) callback during a step they may still show the
//! values from the start of that step (events carry the statuses
//! themselves).
//!
//! **One store holds one shell.** Keys carry no shell id: a second, fresh
//! shell needs its own store object.
//!
//! The engine calls the store only inside `create`, `restore`, `step`,
//! `complete`, `api` and `externalize`; no user JS runs during a store call.
//! A store may cache what it reads (a JS-object store keeps
//! decoded records) only if every write the engine does not make bumps
//! [`StateStore::epoch`]: the engine compares it at every entry point and
//! drops what it derived from the store (option bits, the locale, the
//! root's working directory) when it changed.

use std::{hash::BuildHasher, ops::Deref};

use bstr::{BStr, BString};
use hashbrown::{DefaultHashBuilder, HashTable};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bash::{
	ids::{JobId, ModeId, UnitId, Vpid},
	signal::Signal,
	zshopt::{ZshOpt, ZshOpts},
};

/// Persistent shell state, record by record.
///
/// Implemented by `MemStore` (the reference, `mem-store` feature) and any
/// host-provided store; called by the engine only (see the module
/// docs for the contract; `crate::testkit::store_conformance` checks an
/// implementation).
pub trait StateStore {
	/// Read one record, borrowed: the engine holds no copy of store data, so
	/// reads must not allocate on a hit.
	///
	/// # Errors
	/// [`StoreError`] when the backend fails or a record cannot be decoded.
	fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError>;
	/// Whether some root scope may hold a local `name` ([`Key::Local`]).
	/// A store that indexes local names answers `false` for a name no scope
	/// declares, and a lookup then goes straight to the global; the default
	/// `true` makes it read each scope that may bind one.
	fn may_have_local(&mut self, _name: &[u8]) -> bool {
		true
	}

	/// Install a scalar default whose host lookup can wait until observation.
	///
	/// Return `true` only when the store accepted the initializer. Reads,
	/// scans and snapshots must observe its memoized result as an ordinary
	/// variable; replacement or deletion must discard it. Stores that do
	/// not support deferred defaults return `false`, and the caller writes
	/// the value eagerly instead.
	///
	/// # Errors
	/// [`StoreError`] when the backend fails.
	fn defer_scalar(
		&mut self,
		_name: &[u8],
		_attrs: Attrs,
		_initializer: fn() -> Option<BString>,
	) -> Result<bool, StoreError> {
		Ok(false)
	}
	/// Visit every record of a table in no particular order (`set`,
	/// `declare -p`, environment build, restore).
	///
	/// # Errors
	/// [`StoreError`] when the backend fails or a record cannot be decoded.
	fn scan(&mut self, table: Table, f: &mut dyn FnMut(Key<'_>, &Record)) -> Result<(), StoreError>;
	/// Apply one change now (write-through). See [`Change`] for what each
	/// variant requires of the record it touches.
	///
	/// # Errors
	/// [`StoreError::Shape`] when a variant's precondition does not hold,
	/// [`StoreError::Backend`] when the backend fails.
	fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError>;
	/// Store a blob (frames, IR units).
	///
	/// # Errors
	/// [`StoreError::Backend`] when the backend fails.
	fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError>;
	/// Read a blob.
	///
	/// # Errors
	/// [`StoreError::Backend`] when the backend fails.
	fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError>;
	/// Delete a blob.
	///
	/// # Errors
	/// [`StoreError::Backend`] when the backend fails.
	fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError>;
	/// Generation counter of writes the engine did not make: the embedder
	/// bumps it on every such write (a TS tool setting a variable, a heap
	/// restore). Never bumped by [`StateStore::apply`].
	fn epoch(&self) -> u64;
}

/// Failure of a [`StateStore`] backend.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
	/// The backend failed (a JS exception, an I/O error, …).
	#[error("state store backend failed")]
	Backend(#[source] Box<dyn std::error::Error + Send + Sync>),
	/// A record has a shape the engine cannot use.
	#[error("state store record in table {table} has an unexpected shape")]
	Shape {
		/// Table of the record.
		table: Table,
	},
	/// A serialized store image could not be decoded.
	#[error("state store image is corrupt")]
	Image(#[source] postcard::Error),
	/// A blob the engine writes (a compiled unit) could not be encoded.
	#[error("state store blob could not be encoded")]
	Encode(#[source] postcard::Error),
}

/// Record tables.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	PartialOrd,
	Ord,
	Serialize,
	Deserialize,
	strum::VariantNames,
	strum::EnumIter,
)]
#[strum(serialize_all = "snake_case")]
pub enum Table {
	/// Global variables.
	Var,
	/// Functions.
	Func,
	/// Aliases.
	Alias,
	/// `set -o` and `shopt` options.
	Opt,
	/// Traps.
	Trap,
	/// Jobs.
	Job,
	/// Processes (vpids with their OS pids).
	Proc,
	/// `pushd`/`popd` stack.
	DirStack,
	/// `hash` table.
	CmdHash,
	/// Everything else (cwd, umask, `$?`, `$0`, positional parameters, …).
	Misc,
	/// The root shell's function and temporary-environment scopes, outermost
	/// first ([`Record::Scope`]).
	Scope,
	/// Variables of those scopes ([`Record::Var`] or [`Record::Unset`]).
	Local,
	/// zsh options ([`Key::ZshOpt`], [`Record::Opt`]).
	ZshOpt,
	/// zsh global and suffix aliases ([`Key::ZshAlias`],
	/// [`Record::Alias`]); regular aliases are [`Table::Alias`] in every
	/// dialect.
	ZshAlias,
}

crate::bash::packed_names::packed_names!(Table, Display);

/// Record key (borrowed).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Key<'a> {
	/// Global variable.
	Var(&'a BStr),
	/// Function.
	Func(&'a BStr),
	/// Alias.
	Alias(&'a BStr),
	/// Option.
	Opt(OptId),
	/// Trap.
	Trap(TrapKey),
	/// Job.
	Job(JobId),
	/// Process.
	Proc(Vpid),
	/// The directory stack (one record).
	DirStack,
	/// `hash` entry.
	CmdHash(&'a BStr),
	/// Miscellaneous scalar state.
	Misc(MiscKey),
	/// Scope `depth` of the root shell (0 = outermost).
	Scope(u32),
	/// Variable `name` of the root shell's scope `depth`.
	Local {
		/// Scope index (0 = outermost).
		depth: u32,
		/// Variable name.
		name:  &'a BStr,
	},
	/// A zsh mode option (absent: the `zsh` emulation default). The env
	/// options zsh shares with bash ([`ZshOpt::env_twin`]) are never
	/// stored here but under [`Key::Opt`].
	ZshOpt(ZshOpt),
	/// A zsh global (`alias -g`) or suffix (`alias -s`) alias.
	ZshAlias {
		/// `alias -s`: `name` is a file suffix.
		suffix: bool,
		/// Alias name or suffix.
		name:   &'a BStr,
	},
}

impl Key<'_> {
	/// Table of this key.
	pub const fn table(&self) -> Table {
		match self {
			Self::Var(_) => Table::Var,
			Self::Func(_) => Table::Func,
			Self::Alias(_) => Table::Alias,
			Self::Opt(_) => Table::Opt,
			Self::Trap(_) => Table::Trap,
			Self::Job(_) => Table::Job,
			Self::Proc(_) => Table::Proc,
			Self::DirStack => Table::DirStack,
			Self::CmdHash(_) => Table::CmdHash,
			Self::Misc(_) => Table::Misc,
			Self::Scope(_) => Table::Scope,
			Self::Local { .. } => Table::Local,
			Self::ZshOpt(_) => Table::ZshOpt,
			Self::ZshAlias { .. } => Table::ZshAlias,
		}
	}

	/// Owned copy.
	pub fn to_buf(&self) -> KeyBuf {
		match *self {
			Self::Var(n) => KeyBuf::Var(n.into()),
			Self::Func(n) => KeyBuf::Func(n.into()),
			Self::Alias(n) => KeyBuf::Alias(n.into()),
			Self::Opt(o) => KeyBuf::Opt(o),
			Self::Trap(t) => KeyBuf::Trap(t),
			Self::Job(j) => KeyBuf::Job(j),
			Self::Proc(p) => KeyBuf::Proc(p),
			Self::DirStack => KeyBuf::DirStack,
			Self::CmdHash(n) => KeyBuf::CmdHash(n.into()),
			Self::Misc(m) => KeyBuf::Misc(m),
			Self::Scope(d) => KeyBuf::Scope(d),
			Self::Local { depth, name } => KeyBuf::Local { depth, name: name.into() },
			Self::ZshOpt(o) => KeyBuf::ZshOpt(o),
			Self::ZshAlias { suffix, name } => KeyBuf::ZshAlias { suffix, name: name.into() },
		}
	}
}

/// Lets the engine's record cache look up a [`KeyBuf`] by borrowed [`Key`]
/// without allocating. Sound because both enums derive `Hash` over the same
/// variants in the same order, and `BStr`/`BString` hash as their bytes
/// (`key_hashes_match_key_buf` checks it).
impl hashbrown::Equivalent<KeyBuf> for Key<'_> {
	fn equivalent(&self, key: &KeyBuf) -> bool {
		*self == key.as_key()
	}
}

/// Record key (owned), ordered by table first.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum KeyBuf {
	/// See [`Key::Var`].
	Var(BString),
	/// See [`Key::Func`].
	Func(BString),
	/// See [`Key::Alias`].
	Alias(BString),
	/// See [`Key::Opt`].
	Opt(OptId),
	/// See [`Key::Trap`].
	Trap(TrapKey),
	/// See [`Key::Job`].
	Job(JobId),
	/// See [`Key::Proc`].
	Proc(Vpid),
	/// See [`Key::DirStack`].
	DirStack,
	/// See [`Key::CmdHash`].
	CmdHash(BString),
	/// See [`Key::Misc`].
	Misc(MiscKey),
	/// See [`Key::Scope`].
	Scope(u32),
	/// See [`Key::Local`].
	Local {
		/// Scope index.
		depth: u32,
		/// Variable name.
		name:  BString,
	},
	/// See [`Key::ZshOpt`].
	ZshOpt(ZshOpt),
	/// See [`Key::ZshAlias`].
	ZshAlias {
		/// `alias -s`.
		suffix: bool,
		/// Alias name or suffix.
		name:   BString,
	},
}

impl KeyBuf {
	/// Borrowed view.
	pub fn as_key(&self) -> Key<'_> {
		match self {
			Self::Var(n) => Key::Var(BStr::new(n)),
			Self::Func(n) => Key::Func(BStr::new(n)),
			Self::Alias(n) => Key::Alias(BStr::new(n)),
			Self::Opt(o) => Key::Opt(*o),
			Self::Trap(t) => Key::Trap(*t),
			Self::Job(j) => Key::Job(*j),
			Self::Proc(p) => Key::Proc(*p),
			Self::DirStack => Key::DirStack,
			Self::CmdHash(n) => Key::CmdHash(BStr::new(n)),
			Self::Misc(m) => Key::Misc(*m),
			Self::Scope(d) => Key::Scope(*d),
			Self::Local { depth, name } => Key::Local { depth: *depth, name: BStr::new(name) },
			Self::ZshOpt(o) => Key::ZshOpt(*o),
			Self::ZshAlias { suffix, name } => {
				Key::ZshAlias { suffix: *suffix, name: BStr::new(name) }
			},
		}
	}
}

/// A stored record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Record {
	/// A variable: global ([`Key::Var`]) or local to a root scope
	/// ([`Key::Local`]).
	Var(Var),
	/// A local declared in a root scope that holds no variable (`local x`
	/// unset by `unset x` from an inner function): it hides the outer ones.
	/// Only under [`Key::Local`].
	Unset,
	/// A scope of the root shell ([`Key::Scope`]).
	Scope {
		/// The function it belongs to; `None` for the temporary environment
		/// of a builtin or function call (`IFS=: read …`).
		func:       Option<BString>,
		/// The call's positional parameters; `None`: the outer ones apply.
		positional: Option<Vec<BString>>,
		/// What a call into zsh-dialect code or a mode-switching call
		/// restores when it returns; `None` for a bash call within the bash
		/// dialect.
		zsh:        Option<Box<ZshScope>>,
	},
	/// A function.
	Func {
		/// Mode it was defined in: its body's grammar, and the mode a call
		/// from the other dialect switches to.
		mode:   ModeId,
		/// zsh sticky emulation: set when it was defined while `emulate
		/// MODE -c` ran; a call applies it (zsh `doshfunc`).
		sticky: Option<Box<Sticky>>,
		/// Canonical `declare -f` text, alias-free and materialized on first
		/// read.
		source: crate::bash::ir::FuncText,
		/// Compiled body.
		unit:   UnitId,
		/// `-t`, `-x`.
		attrs:  Attrs,
		/// The file it was defined in (bash's `source_file`: its
		/// `BASH_SOURCE` entry when called, `declare -F` under `extdebug`).
		file:   BString,
	},
	/// An alias' replacement text.
	Alias(BString),
	/// An option's state.
	Opt(bool),
	/// A trap.
	Trap {
		/// Mode the trap was set in.
		mode:   ModeId,
		/// Action text; empty means "ignore".
		action: BString,
	},
	/// A job of the root shell's job table.
	Job(Job),
	/// A child vproc of the shell (subshell, pipeline stage, background job,
	/// substitution), from its start until its exit status is collected.
	Proc {
		/// The vproc that started it.
		parent: Option<Vpid>,
		/// Exit status once it finished; `None` while it runs.
		status: Option<i32>,
	},
	/// The directory stack.
	DirStack(Vec<BString>),
	/// A `hash` entry.
	CmdHash {
		/// The command's path.
		path: BString,
		/// Lookups that found it (bash's `hits` column).
		hits: u32,
	},
	/// A scalar [`MiscKey`] value.
	Misc(BString),
	/// A list-valued [`MiscKey`] value (positional parameters, `enable`
	/// lists, history, …).
	Words(Vec<BString>),
}

/// zsh sticky emulation (zsh `struct emulation_options`): the emulation
/// and the options `emulate MODE [-R] [-o OPT|+o OPT]… -c` named, applied
/// on entry to a function defined while it ran.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Sticky {
	/// The emulation.
	pub mode: ModeId,
	/// `emulate -R`: every non-special option reset, not only the
	/// emulation-relevant ones.
	pub full: bool,
	/// Options `-o` turned on.
	pub on:   Vec<ZshOpt>,
	/// Options `+o` turned off.
	pub off:  Vec<ZshOpt>,
}

/// What a zsh-dialect or mode-switching function call restores when it
/// returns (zsh `funcsave`), kept with its scope ([`Record::Scope`] for
/// the root shell, the scope image for a subshell).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZshScope {
	/// The caller's mode.
	pub mode:            ModeId,
	/// Every zsh option at entry, env options included: restored on return
	/// under `localoptions` or after a sticky switch.
	pub opts:            ZshOpts,
	/// The caller's sticky emulation (zsh's global `sticky`).
	pub sticky:          Option<Sticky>,
	/// The call applied a sticky emulation: options, mode and sticky come
	/// back unconditionally.
	pub restore_sticky:  bool,
	/// Traps as they were before this call first changed them, for
	/// `localtraps` (`None`: unset then).
	pub traps:           Vec<(TrapKey, Option<Record>)>,
	/// [`LossyKind`] bits already reported through `Diag::ModeLossy` during
	/// this call (one report per kind per crossing).
	pub lossy:           u8,
	/// The pattern features `disable -p` had turned off at entry
	/// ([`MiscKey::ZshPatDisables`]), restored on return under
	/// `localpatterns` (zsh `startpatternscope`/`endpatternscope`).
	pub pat_disables:    Vec<BString>,
	/// A zsh function call (`runshfunc`): `$_` comes back on return, as it
	/// was at entry ([`Self::underscore`]).
	#[serde(default)]
	pub keep_underscore: bool,
	/// `$_` ([`MiscKey::LastArg`]) at entry, `None` when unset.
	#[serde(default)]
	pub underscore:      Option<BString>,
	/// The computed specials made local in this scope
	/// ([`Attrs::ZSH_LOCAL_SPECIAL`]), whose values come back on return.
	#[serde(default)]
	pub specials:        Vec<BString>,
}

/// Kinds of lossy mode crossing (`Diag::ModeLossy`), as bits
/// of [`ZshScope::lossy`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, strum::IntoStaticStr)]
pub enum LossyKind {
	/// zsh code made a sparse (bash) array dense: its gaps became empty
	/// elements.
	SparseGaps = 1,
	/// bash code wrote a variable whose zsh-only attributes (float,
	/// padding, unique, hide) it does not apply.
	ZshAttrs   = 2,
	/// zsh code used a name that a zsh special shadows while a bash
	/// variable of that name is set.
	Shadowed   = 4,
}

impl LossyKind {
	/// Its bit.
	pub const fn bit(self) -> u8 {
		self as u8
	}
}

/// A variable: attributes and value. The engine's own variable type too
/// (function scopes and subshell overlays hold them).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Var {
	/// `declare` attributes.
	pub attrs: Attrs,
	/// Value.
	pub value: VarValue,
}

/// One entry of the job table (bash's `JOB`): `jobs`, `fg`, `bg`, `wait`,
/// `kill %n` and `$!` read it; the root shell's entries are
/// [`Record::Job`]s keyed by [`Job::id`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
	/// Identity in the scheduler and the store key.
	pub id:        JobId,
	/// `%n`.
	pub number:    u32,
	/// The job's root vproc (its process group leader for `jobs -p`, `$!`).
	pub vpid:      Vpid,
	/// The command as bash prints it (`jobs`, `fg`, `bg`).
	pub text:      BString,
	/// State.
	pub state:     JobState,
	/// Started while `set -m` was on (bash `J_JOBCONTROL`): only these can
	/// be moved by `fg`/`bg`.
	pub control:   bool,
	/// The current state was reported (bash `J_NOTIFIED`): `jobs -n` skips
	/// the job until its state changes.
	pub notified:  bool,
	/// `disown -h`: kept, but marked not to get a `SIGHUP` (bash
	/// `J_NOHUP`).
	pub nohup:     bool,
	/// Copied from the parent shell into a command substitution (or a
	/// `jobs` pipeline stage): listed, but not a child of this vproc. Never
	/// set in the root shell's table.
	pub inherited: bool,
	/// Working directory it started in (`(wd: …)` when it differs).
	pub wd:        BString,
	/// The OS pid of the program the job runs, once it spawned it: bash's
	/// subshell for an asynchronous simple command `exec`s the program, so
	/// a job whose lone command is an external (or whose body `exec`s one)
	/// is known by that program's pid (`$!`, `jobs -l`/`-p`; `kill`, `wait`
	/// and `disown` accept it). `None` for a compound job, a builtin, a
	/// function, a failed spawn, and while the job has not decided yet.
	pub os_pid:    Option<u32>,
}

impl Job {
	/// The pid `jobs -l`/`-p` and the diagnostics show for the job: its
	/// program's OS pid ([`Job::os_pid`]), else its vproc's virtual pid.
	pub const fn pid(&self) -> u32 {
		match self.os_pid {
			Some(pid) => pid,
			None => self.vpid.0,
		}
	}

	/// `pid` names this job: its virtual pid or its program's OS pid.
	pub const fn named_by(&self, pid: u32) -> bool {
		self.vpid.0 == pid || matches!(self.os_pid, Some(os) if os == pid)
	}
}

/// A variable's value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum VarValue {
	/// Scalar.
	Str(BString),
	/// Indexed array, sorted by index, sparse.
	Indexed(Vec<(i64, BString)>),
	/// Associative array in bash iteration order.
	Assoc(AssocArray),
}

/// Ordered associative entries with a hash index over their keys.
///
/// Only the ordered entries are serialized, so snapshots retain the same
/// representation and rebuilding the index never changes iteration order.
#[derive(Clone, Debug, Default)]
pub struct AssocArray(Box<AssocData>);

#[derive(Clone, Debug, Default)]
struct AssocData {
	entries: Vec<(BString, BString)>,
	index:   HashTable<usize>,
	hasher:  DefaultHashBuilder,
}

impl AssocArray {
	fn position(&self, key: &[u8]) -> Option<usize> {
		let hash = self.0.hasher.hash_one(key);
		self
			.0
			.index
			.find(hash, |&i| self.0.entries[i].0.as_slice() == key)
			.copied()
	}

	/// The value belonging to `key`.
	pub fn get(&self, key: &[u8]) -> Option<&BString> {
		self.position(key).map(|i| &self.0.entries[i].1)
	}

	/// The mutable value belonging to `key`, without exposing mutable keys.
	pub fn get_mut(&mut self, key: &[u8]) -> Option<&mut BString> {
		let i = self.position(key)?;
		Some(&mut self.0.entries[i].1)
	}

	/// The mutable value at `key`, inserting an empty value when absent.
	pub fn value_mut(&mut self, key: &[u8]) -> &mut BString {
		let data = &mut *self.0;
		let hash = data.hasher.hash_one(key);
		let i = if let Some(&i) = data
			.index
			.find(hash, |&i| data.entries[i].0.as_slice() == key)
		{
			i
		} else {
			let i = data.entries.len();
			data.entries.push((BString::from(key), BString::default()));
			data
				.index
				.insert_unique(hash, i, |&i| data.hasher.hash_one(data.entries[i].0.as_slice()));
			i
		};
		&mut data.entries[i].1
	}

	/// Insert a value, retaining the position of an existing key.
	pub fn insert(&mut self, key: BString, value: BString) {
		if let Some(dst) = self.get_mut(&key) {
			*dst = value;
		} else {
			let data = &mut *self.0;
			let hash = data.hasher.hash_one(key.as_slice());
			let i = data.entries.len();
			data.entries.push((key, value));
			data
				.index
				.insert_unique(hash, i, |&i| data.hasher.hash_one(data.entries[i].0.as_slice()));
		}
	}

	/// Remove one key without changing the relative order of other entries.
	pub fn remove(&mut self, key: &[u8]) {
		if let Some(i) = self.position(key) {
			self.0.entries.remove(i);
			self.reindex();
		}
	}

	fn reindex(&mut self) {
		let data = &mut *self.0;
		data.index.clear();
		data
			.index
			.reserve(data.entries.len(), |&i| data.hasher.hash_one(data.entries[i].0.as_slice()));
		for (i, (key, _)) in data.entries.iter().enumerate() {
			let hash = data.hasher.hash_one(key.as_slice());
			if data
				.index
				.find(hash, |&i| data.entries[i].0 == *key)
				.is_none()
			{
				data
					.index
					.insert_unique(hash, i, |&i| data.hasher.hash_one(data.entries[i].0.as_slice()));
			}
		}
	}
}

impl Deref for AssocArray {
	type Target = [(BString, BString)];

	fn deref(&self) -> &Self::Target {
		&self.0.entries
	}
}

impl PartialEq for AssocArray {
	fn eq(&self, other: &Self) -> bool {
		self.0.entries == other.0.entries
	}
}

impl Eq for AssocArray {}

impl From<Vec<(BString, BString)>> for AssocArray {
	fn from(entries: Vec<(BString, BString)>) -> Self {
		let mut result = Self(Box::new(AssocData { entries, ..AssocData::default() }));
		result.reindex();
		result
	}
}

impl FromIterator<(BString, BString)> for AssocArray {
	fn from_iter<T: IntoIterator<Item = (BString, BString)>>(iter: T) -> Self {
		iter.into_iter().collect::<Vec<_>>().into()
	}
}

impl Serialize for AssocArray {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		self.0.entries.serialize(serializer)
	}
}

impl<'de> Deserialize<'de> for AssocArray {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		Vec::deserialize(deserializer).map(Self::from)
	}
}

/// `declare`/`typeset` attributes, bash's and zsh's.
///
/// zsh's width and base/precision fields (`typeset -L 5`, `-i 16`, `-F
/// 3`) are packed beside the flags, in 53 bits so a JS number holds them
/// exactly. The serialized form is a varint
/// (postcard), so images written when this was 16 bits still decode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Attrs(u64);

impl Attrs {
	/// `-A`
	pub const ASSOC: Self = Self(1 << 1);
	/// `-c` (capitalize)
	pub const CAPITALIZE: Self = Self(1 << 5);
	/// `-x`
	pub const EXPORT: Self = Self(1 << 8);
	/// Bits of the flags (below the packed fields).
	const FLAG_MASK: u64 = 0xff_ffff | (0x1f << 48);
	/// `-a`
	pub const INDEXED: Self = Self(1);
	/// `-i`
	pub const INTEGER: Self = Self(1 << 2);
	/// Declared but unset (bash's `att_invisible`): `declare -i x` on a new
	/// name. Expansion, `-v` and listings see no variable; assignments see
	/// its attributes, and any value assignment clears the bit.
	pub const INVISIBLE: Self = Self(1 << 10);
	/// `-l`
	pub const LOWER: Self = Self(1 << 3);
	/// `-n`
	pub const NAMEREF: Self = Self(1 << 6);
	/// No attributes.
	pub const NONE: Self = Self(0);
	/// `-r`
	pub const READONLY: Self = Self(1 << 7);
	/// An associative array whose bash hash table has the default 128
	/// buckets rather than 1024 (a scalar converted by `declare -A`); only
	/// its iteration order differs.
	pub const SMALL_HASH: Self = Self(1 << 11);
	/// A function call's prefix assignment, not a local (`a=7 f`): `local
	/// x` clears it and `declare -p` never shows it.
	pub const TEMP: Self = Self(1 << 12);
	/// `-t`
	pub const TRACE: Self = Self(1 << 9);
	/// `-u`
	pub const UPPER: Self = Self(1 << 4);
	/// zsh function `PM_ABSPATH_USED`: loaded from a directory named by an
	/// absolute path (`autoload /dir/name`, or inherited from such a
	/// caller); a bare `autoload name` it runs looks in that directory
	/// first. Shares its bit with the variable-only [`Self::ZSH_FLOAT_F`].
	pub const ZSH_ABSPATH_USED: Self = Self(1 << 14);
	/// zsh function `autoload -d` (`PM_CUR_FPATH`): a definition not in
	/// its load directory is looked for in `$fpath` too. Shares its bit
	/// with the variable-only [`Self::ZSH_FLOAT_E`].
	pub const ZSH_CUR_FPATH: Self = Self(1 << 13);
	/// zsh `PM_DEFAULTED` beside [`Self::INVISIBLE`]: named by `typeset`
	/// under `TYPESET_TO_UNSET` and not set yet (listed by name); an
	/// invisible variable without it was unset (`unset` clears zsh's
	/// `PM_DECLARED`).
	pub const ZSH_DEFAULTED: Self = Self(1 << 51);
	/// zsh `-E`: float, scientific output.
	pub const ZSH_FLOAT_E: Self = Self(1 << 13);
	/// zsh `-F`: float, fixed output.
	pub const ZSH_FLOAT_F: Self = Self(1 << 14);
	/// zsh `-h`: hide a special's specialness in a local.
	pub const ZSH_HIDE: Self = Self(1 << 20);
	/// zsh `-H`: hide the value in listings.
	pub const ZSH_HIDEVAL: Self = Self(1 << 21);
	/// zsh function `-k` (ksh-style autoload text).
	pub const ZSH_KSHSTORED: Self = Self(1 << 48);
	/// zsh `-L`: left-justify to the width.
	pub const ZSH_LEFT: Self = Self(1 << 15);
	/// zsh on a variable: the binding of a computed special made local
	/// (`local SECONDS`, zsh `typeset_single`'s `newspecial`); the special
	/// stays itself and the variable holds its value from before, put
	/// back when the scope ends. Shares its bit with the function-only
	/// [`Self::ZSH_TRACE_ONCE`].
	pub const ZSH_LOCAL_SPECIAL: Self = Self(1 << 50);
	/// Every zsh-only attribute (bash writes do not apply them).
	pub const ZSH_ONLY: Self = Self(0x3f_e000);
	/// zsh/param/private on a variable: a private parameter (`private`,
	/// `local -P`), visible only in the function scope binding it, not in
	/// the functions that function calls. Shares its bit with the
	/// function-only [`Self::ZSH_UNALIASED`] (every flag bit is taken; a
	/// variable and a function never carry each other's attributes).
	pub const ZSH_PRIVATE: Self = Self(1 << 23);
	/// zsh `-R`: right-justify with blanks.
	pub const ZSH_RIGHT_B: Self = Self(1 << 16);
	/// zsh `-Z`: right-justify with zeros.
	pub const ZSH_RIGHT_Z: Self = Self(1 << 17);
	/// zsh `-T`: tied scalar/array pair.
	pub const ZSH_TIED: Self = Self(1 << 19);
	/// zsh function `-T`: traced for one call.
	pub const ZSH_TRACE_ONCE: Self = Self(1 << 50);
	/// zsh function `-U`: aliases not expanded when it is loaded.
	pub const ZSH_UNALIASED: Self = Self(1 << 23);
	/// zsh function not loaded yet (zsh `PM_UNDEFINED`: an `autoload`
	/// stub whose body comes from `$fpath` at the first call).
	pub const ZSH_UNDEFINED: Self = Self(1 << 22);
	/// zsh `-U`: keep the first occurrence of each array element.
	pub const ZSH_UNIQUE: Self = Self(1 << 18);
	/// zsh function `-W` (`PM_WARNNESTED`): `WARN_NESTED_VAR` is on while
	/// it runs (and in the anonymous functions it calls).
	pub const ZSH_WARN_NESTED: Self = Self(1 << 52);
	/// zsh function `-z` (zsh-style autoload text).
	pub const ZSH_ZSHSTORED: Self = Self(1 << 49);

	/// Union.
	pub const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Difference.
	pub const fn without(self, other: Self) -> Self {
		Self(self.0 & !other.0)
	}

	/// Whether every attribute of `other` is set.
	pub const fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}

	/// Raw bits (flags and the packed fields), for serialization.
	pub const fn bits(self) -> u64 {
		self.0
	}

	/// Attributes from [`Self::bits`]; `None` when bits above the 53 a JS
	/// number holds are set.
	pub const fn from_bits(bits: u64) -> Option<Self> {
		if bits >> 53 == 0 {
			Some(Self(bits))
		} else {
			None
		}
	}

	/// The flags only (no width or base).
	pub const fn flags(self) -> Self {
		Self(self.0 & Self::FLAG_MASK)
	}

	/// zsh width (`-L N`, `-R N`, `-Z N`; 0 = unset).
	#[expect(clippy::cast_possible_truncation, reason = "the width field is 16 bits")]
	pub const fn width(self) -> u16 {
		(self.0 >> 32) as u16
	}

	/// With zsh width `w`.
	pub const fn with_width(self, w: u16) -> Self {
		Self((self.0 & !(0xffff << 32)) | ((w as u64) << 32))
	}

	/// zsh base of an integer (`-i N`) or precision of a float (`-E N`,
	/// `-F N`); 0 = default.
	#[expect(clippy::cast_possible_truncation, reason = "the base field is 8 bits")]
	pub const fn base(self) -> u8 {
		(self.0 >> 24) as u8
	}

	/// With zsh base or precision `b`.
	pub const fn with_base(self, b: u8) -> Self {
		Self((self.0 & !(0xff << 24)) | ((b as u64) << 24))
	}
}

// `VarValue` is 32 B (three 24-byte `Vec` variants: the capacity niche cannot
// hold the other two, so it has a tag) and `Var` was 40 B with the 16-bit
// `Attrs` already; the 64-bit `Attrs` fills that padding.
#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<Var>() == 40, "Var stays 40 bytes (zero cost)");
// Every store slot holds a `Record`: bash paths copy and probe it on every
// variable access (88 B before zsh support; `Func` grew by `Attrs` and the
// boxed sticky emulation).
#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<Record>() <= 104, "Record grew (zero cost)");

/// A job's state (bash `JOB_STATE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum JobState {
	/// Running.
	Running,
	/// Stopped by this signal (`STOP`, `TSTP`, `TTIN`, `TTOU`) or a pause.
	Stopped(Signal),
	/// Finished with this status (128 + n for a death by signal n).
	Done(i32),
}

/// Trap slot: a signal or a bash pseudo-signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TrapKey {
	/// A real signal.
	Signal(Signal),
	/// `EXIT`
	Exit,
	/// `ERR`
	Err,
	/// `DEBUG`
	Debug,
	/// `RETURN`
	Return,
}

/// Miscellaneous scalar and list state.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	PartialOrd,
	Ord,
	Serialize,
	Deserialize,
	strum::VariantNames,
	strum::EnumString,
)]
#[strum(serialize_all = "snake_case")]
pub enum MiscKey {
	/// Root working directory.
	Cwd,
	/// `umask` as octal text.
	Umask,
	/// `$0`.
	Argv0,
	/// `$$` (persisted so it survives restores into other processes).
	ShellPid,
	/// `$?` after the last top-level command.
	Status,
	/// `$!`: the child's vpid in decimal, then `:` and its program's OS pid
	/// once it is known by one ([`Job::os_pid`]).
	LastBg,
	/// `$_`.
	LastArg,
	/// Current mode name.
	Mode,
	/// Positional parameters (`Record::Words`).
	Positional,
	/// zsh `typeset -T` ties (`Record::Words` of flat triples: scalar name,
	/// array name, separator). A triple counts only while both variables
	/// carry `Attrs::ZSH_TIED`; the built-in ties (`path`/`PATH`, …) are not
	/// stored.
	ZshTies,
	/// zsh `disable -a`: regular aliases disabled (`Record::Words`).
	ZshDisabledAliases,
	/// zsh `disable -s`: suffix aliases disabled (`Record::Words`).
	ZshDisabledSuffixAliases,
	/// zsh `disable -f`: functions disabled (`Record::Words`).
	ZshDisabledFuncs,
	/// zsh `disable -r`: reserved words disabled, parsed as plain words
	/// (`Record::Words`).
	ZshDisabledReswords,
	/// zsh `disable -p`: pattern operators disabled, by zsh's names (`*(`,
	/// `<`, `^`, …; `Record::Words`).
	ZshPatDisables,
	/// Interactive shell (`1`/`0`).
	Interactive,
	/// `$0` once a script assigned `BASH_ARGV0`; diagnostics keep the
	/// shell's name ([`MiscKey::Argv0`]), as bash's do.
	Dollar0,
	/// How the running top-level script was given, for `$-`: `c` (a `-c`
	/// string), `s` (standard input) or empty (a file); written when a run
	/// starts, inherited by subshells.
	RunOrigin,
	/// Builtins `enable -n` disabled (`Record::Words`).
	DisabledBuiltins,
	/// Loadable builtins `enable -f` loaded (`Record::Words`).
	LoadedBuiltins,
	/// The `history` list (`Record::Words`, oldest first).
	History,
	/// The `history` list's numbering (`Record::Words`): the first entry's
	/// number (bash's `history_base`) and `1` when the last entry is the
	/// current input line, which `history -s` replaces.
	HistoryCounts,
	/// bash: the start time of each `history` entry (`Record::Words` of
	/// decimal seconds, parallel to [`MiscKey::History`]; empty: unknown).
	HistoryTimes,
	/// zsh: the history events, oldest first (`Record::Misc`, postcard).
	ZshHistory,
	/// zsh: the rest of the history state (`Record::Misc`, postcard).
	ZshHistoryState,
	/// zsh: the event being read (`chline` and its state; `Record::Misc`,
	/// postcard); absent between events.
	ZshHistoryLine,
	/// zsh: the `fc -p` history stack (`Record::Words`, one postcard level
	/// each, bottom first).
	ZshHistoryStack,
	/// Environment strings whose names are not identifiers (`v[0]=x`),
	/// as `name=value` (`Record::Words`): bash passes them on to the
	/// commands it runs.
	ForeignEnv,
	/// Signals ignored when a script run as a new shell (`ENOEXEC`) started
	/// (`Record::Words` of signal names): bash will not trap or reset them.
	HardIgnored,
	/// zsh: signals whose `''` trap is the one recorded when the shell
	/// started with them ignored (`QUIT`, zsh `init_signals`'s
	/// `ZSIG_IGNORED` without trap text; `Record::Words` of signal names):
	/// `localtraps` does not bring it back.
	ZshEntryIgnored,
	/// The vpid of the in-engine nested shell (`bash`/`sh` run through
	/// `Resolved::SelfShell`) whose state a vproc's overlay holds: that
	/// vproc is the nested shell itself, its children are its subshells.
	NestedShell,
	/// `$BASH_SUBSHELL` of a child vproc (decimal; its parent's plus one,
	/// zero in a nested shell), kept in the vproc's overlay.
	Subshell,
	/// `~/.bash_logout` ran (bash's `sourced_logout`): a login shell's
	/// `exit` sources it once.
	LoggedOut,
	/// `PIPESTATUS` of the root shell's last pipeline (`Record::Words`,
	/// decimal statuses).
	PipeStatus,
	/// The current job (`%+`), by number; absent when there is none.
	JobCurrent,
	/// The previous job (`%-`), by number; absent when there is none.
	JobPrevious,
	/// `SIGCHLD` trap runs owed (decimal); absent when zero.
	ChldOwed,
	/// The next [`JobId`] (decimal).
	NextJob,
	/// The next vpid (decimal).
	NextVpid,
	/// `$RANDOM` generator state, `seed:last` (decimal).
	Random,
	/// The host clock reading `$SECONDS` counts from (decimal ns).
	StartNs,
	/// `getopts` progress between calls (`Record::Words` of three fields,
	/// each empty when unset and `=`-prefixed otherwise: the `OPTIND` text
	/// the last call stored, `arg:offset` of the next option letter, the
	/// scope holding `OPTIND`); absent when there is no progress.
	Getopts,
	/// `ulimit` values set in the root shell (`Record::Words`, one
	/// `resource:soft:hard` per limit, `-` for unlimited/unset).
	Rlimits,
	/// zsh's named directory table (`Record::Words`): the table's growth
	/// count (decimal), then one name and one value per entry in zsh's
	/// iteration order, the value being a flags byte (`ND_USERNAME`,
	/// `ND_NOABBREV`) followed by the directory
	/// ([`crate::bash::vm::zsh::nameddir`]).
	ZshNamedDirs,
	/// bash's `current_command_number` (decimal; absent: 1), the prompt's
	/// `\#`: an interactive reader adds one per top-level command it runs.
	BashCommandNumber,
	/// zsh's `txtattrmask` (decimal): the text attributes prompt escapes
	/// (`%B`, `%F{…}`, …) left set, which later expansions re-apply.
	ZshTxtAttr,
	/// zsh's module tables (`modulestab`, autoloadable builtins,
	/// conditions, math functions and parameters) when they differ from
	/// the ones zsh boots with (`Record::Misc`, postcard;
	/// [`crate::bash::vm::builtins::zsh_module`]).
	ZshModules,
	/// zsh/mathfunc's `signgam`: the sign of Γ the last `lgamma()` left
	/// (`Record::Misc`, decimal; absent: 0).
	ZshSigngam,
	/// zsh/net/tcp's session table (`ztcp_sessions`, `Record::Words`):
	/// one entry per session in creation order, `FD TYPE LOCALIP LOCALPORT
	/// PEERIP PEERPORT` with `TYPE` one of `L` (listener), `I` (inbound),
	/// `O` (outbound), `Z` (zftp) ([`crate::bash::vm::builtins`]'s
	/// `zsh_mod_tcp`).
	ZshTcpSessions,
	/// zsh's `procsubstpid`: the vproc id of the last process
	/// substitution (`Record::Misc`, decimal; absent: 0).
	ZshProcsubstPid,
	/// The C `errno` the last failing zsh module builtin left
	/// (`syserror` without arguments; `Record::Misc`, decimal; absent: 0).
	ZshErrno,
	/// zsh/rlimits' `current_limits` where they differ from the host's:
	/// what `limit -s`/`ulimit` applied to the shell (`Record::Words`,
	/// `resource:soft:hard`, `-` for unlimited).
	ZshRlimits,
	/// zsh/sched's events (`Record::Words`, `time flags command` per
	/// event, in order).
	ZshSched,
	/// zsh/watch's last login table and check times (`Record::Words`).
	ZshWatch,
	/// zsh/zprof's profile; present exactly while zsh/zprof is loaded
	/// (`Record::Words`).
	ZshZprof,
	/// zsh/example's parameters `exint`, `exstr`, `exarr`
	/// (`Record::Words`).
	ZshExample,
	/// zsh/zutil's style table (`zstyle`; `Record::Misc`, postcard of
	/// `zsh_mod_zutil::StyleTab`).
	ZshStyles,
	/// zsh/zutil builtins waiting for shell code they pushed (`zstyle -e`
	/// values, `zregexparse` guards and actions): their progress by frame
	/// depth (`Record::Misc`, postcard).
	ZshCodePending,
	/// An error ended the last `ScriptKind::Code` frame (zsh's `errflag`
	/// after `execode`); the builtin that pushed it takes it
	/// (`Record::Misc`).
	ZshCodeError,
	/// zsh/pcre's compiled pattern (`pcre_compile`): `Record::Words` of
	/// the PCRE option bits (decimal) and the pattern; absent when none
	/// was compiled or the last compile failed
	/// ([`crate::bash::vm::builtins::zsh_mod_pcre`]).
	ZshPcre,
	/// zsh/zftp's sessions and connection state between commands
	/// (`Record::Misc`, postcard;
	/// [`crate::bash::vm::builtins::zsh_mod_zftp`]).
	Zftp,
	/// zsh/zftp's status files shared with subshells (zsh's `zfstatfd`;
	/// `Record::Misc`, postcard), kept in the root store.
	ZftpStatus,
	/// The terminal ncurses holds for zsh/terminfo and zsh/termcap
	/// (`cur_term`: the last `$TERM` set up successfully, or the exported
	/// `TERM` when a module booted), whose capabilities `${(k)terminfo}`
	/// and `${(k)termcap}` list (`Record::Misc`: a byte telling how ncurses
	/// set it up, `S` `setupterm` only, `T` `tgetent`, `F` `tgetent` then a
	/// failed one, then the terminal name;
	/// [`crate::bash::vm::builtins::zsh_mod_terminfo`]).
	ZshCurTerm,
	/// `unset mapfile` left zsh/mapfile's special unset (zsh's `PM_UNSET`)
	/// until the next assignment to it or a module unload (`Record::Misc`,
	/// `1`; [`crate::bash::vm::builtins::zsh_mod_mapfile`]).
	ZshMapfileUnset,
	/// zsh/computil's `compdescribe` state between `-i`/`-I` and the `-g`
	/// calls (`cd_state`; `Record::Misc`, postcard;
	/// `crate::bash::vm::zle::comp::computil`).
	ZshCompDescribe,
	/// zsh/computil's `comparguments` state (`ca_laststate` and its
	/// definitions; `Record::Misc`, postcard).
	ZshCompArguments,
	/// zsh/computil's `compvalues` state (`cv_laststate` and its
	/// definitions; `Record::Misc`, postcard).
	ZshCompValues,
	/// zsh/computil's tag sets by function level (`comptags`,
	/// `lasttaglevel`; `Record::Misc`, postcard).
	ZshCompTags,
	/// zsh/compctl's definitions (`compctltab`, the pattern compctls, the
	/// `-C`/`-D`/`-T` compctls and the global matchers; `Record::Misc`,
	/// postcard; `crate::bash::vm::zle::comp::compctl`).
	ZshCompctl,
	/// zsh's type of `SECONDS` (`setsecondstype`; `Record::Misc`): `i`, `E`
	/// or `F`, then the base or precision (decimal); absent: an integer.
	ZshSecondsType,
	/// zsh started emulating sh or ksh (`Record::Misc` `1`; absent: it did
	/// not): `createparamtable` left out the zsh-only specials and tied
	/// none of the colon arrays (`special_params_sh`).
	ZshStartedSh,
	/// zsh's user-defined math functions (`functions -M`; zsh's
	/// `MFF_USERFUNC` entries of `mathfuncs`; `Record::Words`): five words
	/// per function, newest first as zsh lists them: the name, `s` for a
	/// string function (`-Ms`) or empty, the fewest and most arguments
	/// (decimal, -1 for no limit), and the shell function it calls (empty:
	/// the same name) ([`crate::bash::vm::zsh::arith`]).
	ZshMathFuncs,
	/// The `PATH` whose directories zsh's command table holds every
	/// command of (zsh `pathchecked` at the end of `path`, after
	/// `fillcmdnamtable`; `Record::Misc`); absent once the table was
	/// emptied (`PATH` assigned, `hash -r`).
	ZshPathChecked,
	/// `tool` for a shell created with [`crate::bash::Profile::Tool`]
	/// (`Record::Misc`); absent for a user's shell. Nested shells see the
	/// root's record.
	Profile,
}

crate::bash::packed_names::packed_names!(MiscKey);

/// One write-through operation ([`StateStore::apply`]).
///
/// The fine-grained variants exist so scalar appends and keyed array writes
/// cost the changed bytes, not a rewrite of the whole record. Stores must
/// apply append deltas directly to their authoritative value, without
/// joining a copy first.
#[derive(Debug)]
pub enum Change<'a> {
	/// Insert or replace a record (moved in). The key's table must match
	/// the record: [`Record::Var`] under [`Key::Var`], [`Record::Var`] or
	/// [`Record::Unset`] under [`Key::Local`], [`Record::Scope`] under
	/// [`Key::Scope`], none of those three under any other key; a
	/// [`Key::Local`] of a depth with no [`Key::Scope`] record is a shape
	/// error, and so is a [`Key::Scope`] beyond the top one plus one.
	/// [`Key::ZshOpt`] takes only [`Record::Opt`] and never an env option
	/// ([`ZshOpt::env_twin`]: those live under [`Key::Opt`]);
	/// [`Key::ZshAlias`] takes only [`Record::Alias`].
	Put(Key<'a>, Record),
	/// Delete a record (absent: no effect). Deleting [`Key::Scope`] `d`
	/// also deletes every [`Key::Local`] of depth `d`; scopes are pushed
	/// and popped in stack order.
	Del(Key<'a>),
	/// Replace the value of an existing scalar variable (a [`Record::Var`]
	/// holding [`VarValue::Str`]), keeping its attributes.
	SetScalar(Key<'a>, &'a BStr),
	/// Append bytes to an existing scalar variable, keeping its attributes
	/// and reusing its value buffer.
	AppendScalar(Key<'a>, &'a BStr),
	/// Set one element of an existing array variable, keeping its
	/// attributes: [`Elem::Index`] of a [`VarValue::Indexed`] (kept sorted
	/// by index), [`Elem::Key`] of a [`VarValue::Assoc`] (a new key goes
	/// last, an existing one keeps its place).
	SetElem(Key<'a>, Elem<'a>, &'a BStr),
	/// Append bytes to an existing array element, or insert the bytes as a
	/// new element when absent. Shape, ordering and attributes follow
	/// [`Change::SetElem`]; existing value buffers are reused.
	AppendElem(Key<'a>, Elem<'a>, &'a BStr),
	/// Remove one element of an existing array variable (absent: no
	/// effect); the others keep their order.
	DelElem(Key<'a>, Elem<'a>),
}

/// An element of an array variable ([`Change::SetElem`],
/// [`Change::DelElem`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Elem<'a> {
	/// Index of an indexed array.
	Index(i64),
	/// Key of an associative array.
	Key(&'a BStr),
}

/// Blob slots.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum BlobSlot {
	/// The current externalized frames.
	Frames,
	/// A compiled IR unit.
	Unit(UnitId),
}

/// Options persisted in [`Table::Opt`]: `set -o` names and `shopt` names.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	PartialOrd,
	Ord,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
	strum::VariantArray,
	strum::EnumIter,
)]
#[strum(serialize_all = "snake_case")]
#[expect(missing_docs, reason = "each variant is the bash option of the same name")]
pub enum OptId {
	// set -o
	Allexport,
	Braceexpand,
	Emacs,
	Errexit,
	Errtrace,
	Functrace,
	Hashall,
	Histexpand,
	History,
	Ignoreeof,
	#[strum(serialize = "interactive-comments")]
	InteractiveCommentsSet,
	Keyword,
	Monitor,
	Noclobber,
	Noexec,
	Noglob,
	Nolog,
	Notify,
	Nounset,
	Onecmd,
	Physical,
	Pipefail,
	Posix,
	Privileged,
	Verbose,
	Vi,
	Xtrace,
	// shopt
	ArrayExpandOnce,
	AssocExpandOnce,
	Autocd,
	BashSourceFullpath,
	CdableVars,
	Cdspell,
	Checkhash,
	Checkjobs,
	Checkwinsize,
	Cmdhist,
	CompleteFullquote,
	Direxpand,
	Dirspell,
	Dotglob,
	Execfail,
	ExpandAliases,
	Extdebug,
	Extglob,
	Extquote,
	Failglob,
	ForceFignore,
	Globasciiranges,
	Globskipdots,
	Globstar,
	GnuErrfmt,
	Histappend,
	Histreedit,
	Histverify,
	Hostcomplete,
	Huponexit,
	InheritErrexit,
	InteractiveComments,
	Lastpipe,
	Lithist,
	LocalvarInherit,
	LocalvarUnset,
	LoginShell,
	Mailwarn,
	NoEmptyCmdCompletion,
	Nocaseglob,
	Nocasematch,
	NoexpandTranslation,
	Nullglob,
	PatsubReplacement,
	Progcomp,
	ProgcompAlias,
	Promptvars,
	RestrictedShell,
	ShiftVerbose,
	Sourcepath,
	VarredirClose,
	XpgEcho,
	// shopt compatibility levels (kept last so earlier discriminants stay
	// stable; listings sort by name). Recorded only: this engine runs at
	// the default level.
	#[strum(serialize = "compat31")]
	Compat31,
	#[strum(serialize = "compat32")]
	Compat32,
	#[strum(serialize = "compat40")]
	Compat40,
	#[strum(serialize = "compat41")]
	Compat41,
	#[strum(serialize = "compat42")]
	Compat42,
	#[strum(serialize = "compat43")]
	Compat43,
	#[strum(serialize = "compat44")]
	Compat44,
}

crate::bash::packed_names::packed_names!(OptId, Display);

/// Which builtin reports an option.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OptKind {
	/// `set -o`.
	Set,
	/// `shopt`.
	Shopt,
}

impl OptId {
	/// `set -o` or `shopt`.
	pub const fn kind(self) -> OptKind {
		if (self as u8) <= (Self::Xtrace as u8) {
			OptKind::Set
		} else {
			OptKind::Shopt
		}
	}

	/// Default of a non-interactive bash 5.3.
	pub const fn default_on(self) -> bool {
		matches!(
			self,
			Self::Braceexpand
				| Self::Hashall
				| Self::InteractiveCommentsSet
				| Self::Checkwinsize
				| Self::Cmdhist
				| Self::CompleteFullquote
				| Self::Extquote
				| Self::ForceFignore
				| Self::Globasciiranges
				| Self::Globskipdots
				| Self::Hostcomplete
				| Self::InteractiveComments
				| Self::PatsubReplacement
				| Self::Progcomp
				| Self::Promptvars
				| Self::Sourcepath
		)
	}

	/// The `set` flag letter shown in `$-`.
	pub const fn flag(self) -> Option<u8> {
		Some(match self {
			Self::Allexport => b'a',
			Self::Notify => b'b',
			Self::Errexit => b'e',
			Self::Noglob => b'f',
			Self::Hashall => b'h',
			Self::Keyword => b'k',
			Self::Monitor => b'm',
			Self::Noexec => b'n',
			Self::Privileged => b'p',
			Self::Onecmd => b't',
			Self::Nounset => b'u',
			Self::Verbose => b'v',
			Self::Xtrace => b'x',
			Self::Braceexpand => b'B',
			Self::Noclobber => b'C',
			Self::Errtrace => b'E',
			Self::Histexpand => b'H',
			Self::Physical => b'P',
			Self::Functrace => b'T',
			_ => return None,
		})
	}

	/// The option named `name` (`set -o` or `shopt` spelling).
	pub fn from_name(name: &[u8]) -> Option<Self> {
		std::str::from_utf8(name).ok()?.parse().ok()
	}
}

#[cfg(test)]
mod tests {
	use std::hash::BuildHasher;

	use bstr::{BStr, BString};

	use super::{AssocArray, Attrs, Key, KeyBuf, MiscKey, OptId, TrapKey};
	use crate::bash::{
		ids::{JobId, Vpid},
		zshopt::ZshOpt,
	};

	#[test]
	fn assoc_index_preserves_order_clone_and_snapshot_representation() {
		let entries: Vec<_> = (0..256)
			.map(|i| (BString::from(format!("k{i}")), BString::from(format!("v{i}"))))
			.collect();
		let mut array = AssocArray::from(entries.clone());
		assert_eq!(&*array, entries.as_slice());
		let encoded = postcard::to_allocvec(&array).unwrap();
		assert_eq!(encoded, postcard::to_allocvec(&entries).unwrap());
		let restored: AssocArray = postcard::from_bytes(&encoded).unwrap();
		for (k, v) in &entries {
			assert_eq!(restored.get(k), Some(v));
		}
		let copy = array.clone();
		array.insert("k5".into(), "changed".into());
		assert_eq!(array[5].0, BString::from("k5"));
		array.remove(b"k3");
		array.insert("k3".into(), "last".into());
		assert_eq!(array.last().unwrap().0, BString::from("k3"));
		for (k, v) in array.iter() {
			assert_eq!(array.get(k), Some(v));
		}
		assert_eq!(&*copy, entries.as_slice());
		assert_eq!(array.get(b"missing"), None);
		array.value_mut(b"k5").extend_from_slice(b"+");
		array.value_mut(b"new").extend_from_slice(b"new");
		assert_eq!(array.get(b"k5"), Some(&BString::from("changed+")));
		assert_eq!(array.last().unwrap().0, BString::from("new"));
		let duplicates = vec![
			(BString::from("k"), BString::from("first")),
			(BString::from("k"), BString::from("second")),
		];
		let mut duplicates = AssocArray::from(duplicates);
		assert_eq!(duplicates.get(b"k"), Some(&BString::from("first")));
		duplicates.remove(b"k");
		assert_eq!(duplicates.get(b"k"), Some(&BString::from("second")));
	}

	/// A borrowed key must hash like its owned form, or cache lookups by
	/// `Key` miss entries inserted as `KeyBuf` and load stale store records.
	#[test]
	fn key_hashes_match_key_buf() {
		let s = hashbrown::DefaultHashBuilder::default();
		let keys = [
			Key::Var(BStr::new("PATH")),
			Key::Func(BStr::new("f")),
			Key::Alias(BStr::new("ll")),
			Key::Opt(OptId::Errexit),
			Key::Trap(TrapKey::Exit),
			Key::Job(JobId(3)),
			Key::Proc(Vpid(7)),
			Key::DirStack,
			Key::CmdHash(BStr::new("ls")),
			Key::Misc(MiscKey::Umask),
			Key::Scope(2),
			Key::Local { depth: 1, name: BStr::new("x") },
			Key::ZshOpt(ZshOpt::Extendedglob),
			Key::ZshAlias { suffix: true, name: BStr::new("txt") },
		];
		for key in keys {
			assert_eq!(s.hash_one(key), s.hash_one(key.to_buf()), "{key:?}");
		}
		// Same bytes under different tables stay distinct.
		assert_ne!(s.hash_one(Key::Var(BStr::new("x"))), s.hash_one(KeyBuf::Func("x".into())));
	}

	/// zsh's packed width and base fields stay apart from the flags and
	/// from each other, and the whole word fits a JS number.
	#[test]
	fn attrs_pack_width_and_base_beside_the_flags() {
		let a = Attrs::ZSH_RIGHT_Z
			.with(Attrs::INTEGER)
			.with_width(65535)
			.with_base(16);
		assert_eq!(a.width(), 65535);
		assert_eq!(a.base(), 16);
		assert_eq!(a.flags(), Attrs::ZSH_RIGHT_Z.with(Attrs::INTEGER));
		assert_eq!(a.with_width(3).base(), 16);
		assert_eq!(Attrs::from_bits(a.bits()), Some(a));
		assert_eq!(Attrs::from_bits(1 << 53), None);
		assert!(Attrs::ZSH_ONLY.contains(Attrs::ZSH_FLOAT_F.with(Attrs::ZSH_HIDEVAL)));
		assert!(!Attrs::ZSH_ONLY.contains(Attrs::TEMP));
	}

	/// An image written while `Attrs` was 16 bits (a postcard varint) reads
	/// back unchanged now that it is 64.
	#[test]
	fn attrs_decode_from_the_16_bit_encoding() {
		let old = postcard::to_allocvec(&0x1abc_u16).expect("encodes");
		let new: Attrs = postcard::from_bytes(&old).expect("decodes");
		assert_eq!(new.bits(), 0x1abc);
	}
}
