//! Execution events: live feedback and the run trace
//! ([`crate::bash::trace`]).
//!
//! Events are emitted synchronously at safepoints through
//! [`Host::event`](crate::bash::Host::event). A kind whose [`EventMask`] bit is
//! off costs one AND per op and allocates nothing. Every event of a script
//! carries its [`RunId`]; node events carry a [`NodeRef`] and a [`SpanRef`]
//! into the unit announced earlier by `UnitCompiled` (built when read:
//! [`Event::node`], [`Event::span`]). `UnitCompiled` carries the unit's
//! node table ([`CompiledUnit`]), so an observer can lay the unit out
//! without re-parsing it. A host that forwards events to a per-run observer
//! does so through an [`EventSink`].
//!
//! Output bytes are not events: hosts tag what commands write with the
//! [`CmdTag`](crate::bash::CmdTag) of the command that produced it.

use std::fmt;

use bstr::{BStr, BString};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

use crate::bash::{
	fs::FsOp,
	ids::{AstNodeId, CallId, JobId, ModeId, NativeRef, RunId, UnitId, Vpid},
	ir::{NodeInfo, Unit},
	signal::{SigTarget, Signal},
	snapshot::{Lost, RestoreReport},
	store::TrapKey,
	text,
	vm::{Run, Vproc},
};

/// One event.
///
/// Built in place at every emission and handed to
/// [`Host::event`](crate::bash::Host::event) by reference, so it stays small
/// (104 bytes on 64-bit targets, guarded below): what the emitter has at hand
/// is a field; what takes a lookup (the script, its mode, the node and its
/// span) is a method that reads the engine state the event borrows, paid
/// only by the hosts that ask. Serialized (JSON events, `obash
/// --events=jsonl`) as `seq`, `t_ns`, `kind`, `run`, `vpid`, `job`, `mode`,
/// `node`, `span` and `data`, the methods' values under their names (`node`
/// and `span` `null` for events without a node).
#[derive(Clone, Copy)]
pub struct Event<'a> {
	/// Per-shell sequence number, continuous across restores.
	pub seq:  u64,
	/// [`Host::now_ns`](crate::bash::Host::now_ns) at emission. Events separated
	/// only by in-engine work (control flow, word expansion without
	/// pathname expansion or substitutions, a call's bookkeeping, a frame's
	/// end) share one reading: a command's `CmdStart` and `CmdExpanded`
	/// carry the previous `CmdEnd`'s, a function's `FuncEnter` its call's
	/// and its `FuncExit` its last command's `CmdEnd`. Every `CmdEnd` reads
	/// the clock.
	pub t_ns: u64,
	/// Kind (also implied by `data`).
	pub kind: EventKind,
	/// Virtual process.
	pub vpid: Vpid,
	/// Job of the process, when it has one.
	pub job:  Option<JobId>,
	/// Kind-specific payload.
	pub data: EventData<'a>,
	/// The emitting vproc's current mode ([`Self::mode`]).
	mode:     ModeId,
	/// Where it was emitted.
	src:      Source<'a>,
}

// Every enabled event is built per emission: a growing `Event` is a cost on
// every command of every traced script (the event overhead row).
#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<Event<'static>>() <= 104, "Event grew past 104 bytes");

/// Where an [`Event`] was emitted, resolved only when a host reads it.
#[derive(Clone, Copy)]
enum Source<'a> {
	/// A script- or shell-level event: the script (`None`: the shell).
	Run(Option<&'a Run>),
	/// The op at `node` of the vproc's current frame (the vproc is borrowed
	/// as it was at emission until the host returns).
	Op {
		/// The emitting vproc.
		vp:   &'a Vproc,
		/// Node of the frame's unit.
		node: u32,
	},
}

/// The origin of events without a script.
static NO_ORIGIN: OriginChain = OriginChain { links: Vec::new() };

impl<'a> Event<'a> {
	/// A script-level event of `run`, or a shell-level one (`run` `None`),
	/// emitted by a vproc in `mode` (the shell's for shell-level events).
	#[inline]
	pub(crate) const fn of_run(
		seq: u64,
		t_ns: u64,
		vpid: Vpid,
		run: Option<&'a Run>,
		mode: ModeId,
		data: EventData<'a>,
	) -> Self {
		let src = Source::Run(run);
		Self { seq, t_ns, kind: data.kind(), vpid, job: None, data, mode, src }
	}

	/// An event of the op at `node` of `vp`'s current frame.
	#[inline]
	pub(crate) const fn of_op(
		seq: u64,
		t_ns: u64,
		vp: &'a Vproc,
		node: u32,
		data: EventData<'a>,
	) -> Self {
		let src = Source::Op { vp, node };
		let mode = vp.mode;
		Self { seq, t_ns, kind: data.kind(), vpid: vp.vpid, job: None, data, mode, src }
	}

	/// Script it belongs to (`None` for shell-level events: `Suspended`,
	/// `Restored`, `Signal`).
	pub fn run(&self) -> Option<RunId> {
		self.script().map(|r| r.id)
	}

	/// Output identity of the simple command active at this safepoint.
	/// Read lazily without enlarging the event or changing its JSON format.
	pub fn command_tag(&self) -> Option<crate::bash::ids::CmdTag> {
		let Source::Op { vp, .. } = self.src else {
			return None;
		};
		vp.frames
			.last()?
			.scratch
			.as_ref()?
			.exec
			.as_ref()
			.map(|exec| exec.tag)
	}

	/// The emitting vproc's mode when it emitted it: inside
	/// a sticky or cross-dialect function call, the callee's (`FuncEnter`
	/// included).
	pub const fn mode(&self) -> ModeId {
		self.mode
	}

	/// Syntax node, for node events.
	pub fn node(&self) -> Option<NodeRef> {
		let (unit, _, node) = self.at()?;
		Some(NodeRef { unit: unit.id, node: AstNodeId(node) })
	}

	/// Source span of [`Self::node`].
	pub fn span(&self) -> Option<SpanRef<'a>> {
		let (unit, info, _) = self.at()?;
		Some(SpanRef {
			unit:   unit.id,
			lo:     info.lo,
			hi:     info.hi,
			line:   unit.line + info.line,
			col:    info.col,
			origin: self.script().map_or(&NO_ORIGIN, |r| &r.chain),
		})
	}

	/// The script, as at emission.
	fn script(&self) -> Option<&'a Run> {
		match self.src {
			Source::Run(run) => run,
			Source::Op { vp, .. } => vp.runs.front(),
		}
	}

	/// The unit, node record and id of a node event (`None` when the frame's
	/// unit has no such node).
	fn at(&self) -> Option<(&'a Unit, &'a NodeInfo, u32)> {
		let Source::Op { vp, node } = self.src else {
			return None;
		};
		let unit = vp.frames.last()?.unit.as_deref()?;
		Some((unit, unit.nodes.get(node as usize)?, node))
	}
}

impl fmt::Debug for Event<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Event")
			.field("seq", &self.seq)
			.field("t_ns", &self.t_ns)
			.field("kind", &self.kind)
			.field("run", &self.run())
			.field("vpid", &self.vpid)
			.field("job", &self.job)
			.field("mode", &self.mode())
			.field("node", &self.node())
			.field("span", &self.span())
			.field("data", &self.data)
			.finish()
	}
}

impl Serialize for Event<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let mut ev = s.serialize_struct("Event", 10)?;
		ev.serialize_field("seq", &self.seq)?;
		ev.serialize_field("t_ns", &self.t_ns)?;
		ev.serialize_field("kind", &self.kind)?;
		ev.serialize_field("run", &self.run())?;
		ev.serialize_field("vpid", &self.vpid)?;
		ev.serialize_field("job", &self.job)?;
		ev.serialize_field("mode", &self.mode())?;
		ev.serialize_field("node", &self.node())?;
		ev.serialize_field("span", &self.span())?;
		ev.serialize_field("data", &self.data)?;
		ev.end()
	}
}

/// A per-run observer of engine events
/// ([`RunOptions::events`](crate::session::RunOptions::events)).
///
/// The host forwards every event of the attached run to it; [`Self::mask`]
/// is the shell's event mask while the run is attached.
pub trait EventSink: Send + Sync {
	/// Kinds the sink wants.
	fn mask(&self) -> EventMask;
	/// One event.
	fn event(&self, ev: &Event<'_>);
	/// Pin the actual root submission before stepping a persistent session.
	/// Descendant submissions are reported by explicit engine lineage instead.
	fn run_submitted(&self, _run: RunId) {}
	/// End of a visible capture generation, after its writer slots close.
	/// Incremental output decoding must finalize here, not at command exit.
	fn output_end(&self, _t_ns: u64, _fd: i32) {}
	/// Successfully forwarded bytes of a run's visible stdout/stderr.
	/// `tag` is absent for shell-level output without an executing command;
	/// `fd` names the final capture stream (merged stderr therefore uses 1).
	/// The clock is the same monotonic clock used by engine events.
	fn output(&self, _tag: Option<crate::bash::ids::CmdTag>, _t_ns: u64, _fd: i32, _bytes: &[u8]) {}
}

/// The payload of `UnitCompiled`: the unit and the script line of its
/// first byte.
///
/// Serialized as `unit` (id), `source` (unit bytes; spans are relative to
/// them), `line` (1-based script line of the first byte), `nodes` (the node
/// table, index = node id, each `{kind, lo, hi, line, col}` with `line`
/// 0-based within the unit), `features` ([`crate::bash::syntax::Features`]
/// bits) and `aliases` (substitutions applied, in order). Re-parsing
/// `source` with `features` and `aliases` reproduces the node ids.
#[derive(Clone, Copy)]
pub struct CompiledUnit<'a> {
	/// The unit.
	pub unit:   &'a Unit,
	/// 1-based script line of the first byte of its source.
	pub line:   u32,
	/// Compiler-known literal origin, when the source was entered natively.
	pub parent: Option<&'a SourceOrigin>,
}

impl CompiledUnit<'_> {
	/// Unit id.
	pub const fn id(&self) -> UnitId {
		self.unit.id
	}

	/// Unit bytes.
	pub fn source(&self) -> &BStr {
		BStr::new(&self.unit.source)
	}

	/// The node table (index = node id).
	pub fn nodes(&self) -> &[NodeInfo] {
		&self.unit.nodes
	}
}

impl fmt::Debug for CompiledUnit<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("CompiledUnit")
			.field("unit", &self.unit.id)
			.field("source", &self.source())
			.field("line", &self.line)
			.field("nodes", &self.unit.nodes.len())
			.field("features", &self.unit.features)
			.field("aliases", &self.unit.aliases)
			.finish()
	}
}

impl Serialize for CompiledUnit<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let mut st = s.serialize_struct("UnitCompiled", 6)?;
		st.serialize_field("unit", &self.unit.id)?;
		st.serialize_field("source", &text::Text(&self.unit.source))?;
		st.serialize_field("line", &self.line)?;
		st.serialize_field("nodes", &self.unit.nodes)?;
		st.serialize_field("features", &self.unit.features)?;
		st.serialize_field("aliases", &Pairs(&self.unit.aliases))?;
		st.end()
	}
}

/// `(name, value)` pairs as two-element arrays (`text::pairs` as a value).
struct Pairs<'a>(&'a [(BString, BString)]);

impl Serialize for Pairs<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		text::pairs(self.0, s)
	}
}

/// A node in a compiled unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeRef {
	/// Unit announced by `UnitCompiled`.
	pub unit: UnitId,
	/// Preorder node id within the unit.
	#[serde(with = "node_id")]
	pub node: AstNodeId,
}

mod node_id {
	use serde::{Deserialize, Deserializer, Serializer};

	use crate::bash::ids::AstNodeId;

	#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde `with` signature")]
	pub fn serialize<S: Serializer>(id: &AstNodeId, s: S) -> Result<S::Ok, S::Error> {
		s.serialize_u32(id.0)
	}

	pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<AstNodeId, D::Error> {
		u32::deserialize(d).map(AstNodeId)
	}
}

/// Source span of a node, relative to its unit's bytes.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct SpanRef<'a> {
	/// Unit.
	pub unit:   UnitId,
	/// First byte, relative to the unit.
	pub lo:     u32,
	/// One past the last byte, relative to the unit.
	pub hi:     u32,
	/// 1-based line in the script.
	pub line:   u32,
	/// 1-based byte column.
	pub col:    u32,
	/// How this code was reached (file → eval → trap …), root first.
	pub origin: &'a OriginChain,
}

/// Owned span (origin links, `Origin::NestedShell`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpanOwned {
	/// Unit.
	pub unit: UnitId,
	/// First byte, relative to the unit.
	pub lo:   u32,
	/// One past the last byte.
	pub hi:   u32,
	/// 1-based line.
	pub line: u32,
	/// 1-based byte column.
	pub col:  u32,
}

/// Exact emitting activation and canonical parent span of native script input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SourceOrigin {
	/// Process owning the parent unit.
	pub vpid: Vpid,
	/// Canonical word id of the source argument in that unit.
	pub node: u32,
	/// Actual literal argument entering this script.
	pub span: SpanOwned,
}

/// Chain of origins from the outermost script to the code running now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginChain {
	/// Links, root first.
	pub links: Vec<OriginLink>,
}

/// One link of an [`OriginChain`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginLink {
	/// What kind of code.
	pub origin: Origin,
	/// Span in the parent link that entered it (`None` for the root).
	pub at:     Option<SpanOwned>,
}

/// Where a script's bytes came from.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Origin {
	/// `-c` string or a host command.
	Command,
	/// A script file.
	File(#[serde(serialize_with = "text::bytes")] BString),
	/// The script on the shell's standard input, read a line at a time as
	/// it runs (`obash < script`): the run's fd 0 supplies the source after
	/// [`Script::source`](crate::bash::Script::source).
	Stdin,
	/// `eval`.
	Eval,
	/// A trap action.
	Trap,
	/// A function body.
	Function(#[serde(serialize_with = "text::bytes")] BString),
	/// `PROMPT_COMMAND`.
	PromptCommand,
	/// Prompt expansion (`${x@P}`).
	Prompt,
	/// A nested `bash -c` run in-engine.
	NestedShell {
		/// Command that started it.
		parent: SpanOwned,
	},
}

/// Event kinds; the discriminant is the [`EventMask`] bit.
///
/// The first sixteen are the node events IR ops can emit.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::VariantNames,
	strum::EnumIter,
)]
#[repr(u8)]
#[expect(missing_docs, reason = "documented on the matching `EventData` variant")]
pub enum EventKind {
	CmdStart,
	CmdExpanded,
	CmdEnd,
	Assign,
	Branch,
	IterStart,
	LoopEnd,
	FuncEnter,
	FuncExit,
	SourceEnter,
	EvalEnter,
	Subshell,
	Pipeline,
	Background,
	Redirect,
	Trap,
	RunStart,
	RunEnd,
	UnitCompiled,
	Exit,
	Spawn,
	Call,
	TaskStart,
	Signal,
	Stopped,
	Continued,
	Blocked,
	Unblocked,
	ErrExit,
	Diag,
	Suspended,
	Restored,
	Lost,
	Custom,
}

crate::bash::packed_names::packed_names!(EventKind, Display);

/// Bitset of enabled [`EventKind`]s (per shell,
/// [`Shell::set_event_mask`](crate::bash::Shell::set_event_mask)).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EventMask(u64);

impl EventMask {
	/// Everything.
	pub const ALL: Self = Self(u64::MAX);
	/// Default: everything except the opt-in kinds `Assign`, `Branch`,
	/// `IterStart` and `LoopEnd` (which fire per variable write or iteration).
	pub const DEFAULT: Self = Self::ALL
		.without(EventKind::Assign)
		.without(EventKind::Branch)
		.without(EventKind::IterStart)
		.without(EventKind::LoopEnd);
	/// Nothing.
	pub const NONE: Self = Self(0);

	/// The mask with only `kind`.
	pub const fn of(kind: EventKind) -> Self {
		Self(1 << kind as u8)
	}

	/// With `kind` added.
	pub const fn with(self, kind: EventKind) -> Self {
		Self(self.0 | (1 << kind as u8))
	}

	/// With `kind` removed.
	pub const fn without(self, kind: EventKind) -> Self {
		Self(self.0 & !(1 << kind as u8))
	}

	/// Whether `kind` is enabled.
	pub const fn contains(self, kind: EventKind) -> bool {
		self.0 & (1 << kind as u8) != 0
	}

	/// Whether any kind of the op-event bits `ev` is enabled (dispatch check).
	pub const fn any_op(self, ev: u16) -> bool {
		self.0 & ev as u64 != 0
	}

	/// Raw bits.
	pub const fn bits(self) -> u64 {
		self.0
	}

	/// Mask from raw bits.
	pub const fn from_bits(bits: u64) -> Self {
		Self(bits)
	}
}

impl Default for EventMask {
	fn default() -> Self {
		Self::DEFAULT
	}
}

/// Kind of syntax node in `CmdStart`.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	strum::VariantNames,
	strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
#[expect(missing_docs, reason = "each variant is the syntax node of the same name")]
pub enum NodeKind {
	AndOr,
	Pipeline,
	Simple,
	Brace,
	Subshell,
	If,
	While,
	Until,
	For,
	ArithFor,
	Select,
	Case,
	Arith,
	Cond,
	FuncDef,
	Coproc,
	Assign,
	Word,
}

crate::bash::packed_names::packed_names!(NodeKind);

/// Construct of a `Branch` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Construct {
	/// `if` condition (taken = then-branch).
	If,
	/// `elif` condition.
	Elif,
	/// `while` condition (taken = another iteration).
	While,
	/// `until` condition (taken = another iteration).
	Until,
	/// `a && b` (taken = `b` runs).
	And,
	/// `a || b` (taken = `b` runs).
	Or,
	/// A `case` arm (taken = it matched).
	CaseArm,
}

crate::bash::packed_names::packed_names!(Construct);

impl Construct {
	/// From the IR operand encoding.
	pub(crate) const fn from_u32(v: u32) -> Self {
		match v {
			0 => Self::If,
			1 => Self::Elif,
			2 => Self::While,
			3 => Self::Until,
			4 => Self::And,
			5 => Self::Or,
			_ => Self::CaseArm,
		}
	}
}

/// How a command resolved, in `CmdExpanded`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
#[expect(missing_docs, reason = "mirrors `Resolved` plus shell functions")]
pub enum ResolvedKind {
	Function,
	Intrinsic,
	Tool,
	Native,
	Device,
	SelfShell,
	External,
	NotFound,
	/// No command word: assignments only.
	None,
}

crate::bash::packed_names::packed_names!(ResolvedKind);

/// Scope of an `Assign` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum AssignScope {
	/// Global (root store).
	Global,
	/// Function-local.
	Local,
	/// Temporary environment of one command.
	Env,
	/// A subshell's copy.
	Subshell,
}

crate::bash::packed_names::packed_names!(AssignScope);

/// Redirection operator in `Redirect` / `CmdExpanded`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::VariantNames)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
#[expect(missing_docs, reason = "mirrors `crate::bash::syntax::RedirOp`")]
pub enum RedirKind {
	In,
	Out,
	Append,
	Clobber,
	ReadWrite,
	DupIn,
	DupOut,
	OutErr,
	AppendErr,
	HereDoc,
	HereString,
	Close,
}

crate::bash::packed_names::packed_names!(RedirKind);

/// One applied redirection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedirInfo {
	/// Target fd.
	pub fd:     i32,
	/// Operator.
	pub op:     RedirKind,
	/// Expanded target (path, fd number, here-string).
	#[serde(serialize_with = "text::bytes")]
	pub target: BString,
}

/// Why a virtual process is not progressing (`Blocked`/`Unblocked`, frames).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WaitKey {
	/// Reading fd (an empty pipe, a slow file).
	Read {
		/// fd number.
		fd: i32,
	},
	/// Writing fd (a full pipe, a slow sink).
	Write {
		/// fd number.
		fd: i32,
	},
	/// Waiting for a virtual process.
	Proc(Vpid),
	/// Waiting for an external process.
	Ext {
		/// OS pid.
		pid: u32,
	},
	/// Waiting for the host to finish launching an external
	/// ([`Host::spawn`](crate::bash::Host::spawn) is pending).
	Spawn {
		/// Absolute path of the program.
		#[serde(serialize_with = "text::bytes")]
		path: BString,
	},
	/// Waiting for a host callout's
	/// [`Shell::complete`](crate::bash::Shell::complete).
	Call(CallId),
	/// Waiting for a native task.
	Task(NativeRef),
	/// Waiting for a pending filesystem operation.
	Fs {
		/// Operation.
		op:   FsOp,
		/// Path it applies to.
		#[serde(serialize_with = "text::bytes")]
		path: BString,
	},
	/// Waiting for a job (`wait %1`).
	Job(JobId),
	/// Waiting for a signal (`wait`, `suspend`).
	Signal,
}

/// Progress or annotation from a host callout
/// ([`ShellApi::emit`](crate::bash::ShellApi::emit)).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CustomEvent {
	/// Event name chosen by the emitter.
	#[serde(serialize_with = "text::bytes")]
	pub name:    BString,
	/// Payload (JSON by convention).
	#[serde(serialize_with = "text::bytes")]
	pub payload: BString,
}

/// Kind-specific event payload.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(untagged)]
pub enum EventData<'a> {
	/// A script starts.
	RunStart {
		/// [`Script::tag`](crate::bash::Script::tag).
		tag:    u64,
		/// Where it came from.
		origin: &'a Origin,
	},
	/// A script finished.
	RunEnd {
		/// Final status.
		status: i32,
	},
	/// A unit was compiled; it precedes every event that references it.
	///
	/// Serialized as `{unit, source, line, nodes, features, aliases}`
	/// ([`CompiledUnit`]).
	UnitCompiled(CompiledUnit<'a>),
	/// A command starts.
	CmdStart {
		/// Node kind.
		node_kind: NodeKind,
	},
	/// A simple command's words are expanded and its name resolved.
	CmdExpanded {
		/// Final argv.
		#[serde(serialize_with = "text::list")]
		argv:     &'a [BString],
		/// Prefix assignments.
		#[serde(serialize_with = "text::pairs")]
		assigns:  &'a [(BString, BString)],
		/// Redirections.
		redirs:   &'a [RedirInfo],
		/// Resolution.
		resolved: ResolvedKind,
	},
	/// A command finished.
	CmdEnd {
		/// Exit status.
		status:     i32,
		/// Wall time from `CmdStart`.
		dur_ns:     u64,
		/// `PIPESTATUS` for pipelines.
		pipestatus: &'a [i32],
	},
	/// A variable was assigned.
	Assign {
		/// Name.
		#[serde(serialize_with = "text::bytes")]
		name:     &'a BStr,
		/// Value, truncated to 256 bytes.
		#[serde(serialize_with = "text::bytes")]
		value:    &'a BStr,
		/// Full value length.
		full_len: usize,
		/// Scope.
		scope:    AssignScope,
	},
	/// A conditional branch was decided.
	Branch {
		/// Construct.
		construct: Construct,
		/// Whether the guarded code runs.
		taken:     bool,
		/// Status that decided it.
		status:    i32,
	},
	/// A loop iteration starts.
	IterStart {
		/// 1-based iteration number.
		n:     u32,
		/// Loop variable (empty for `while`).
		#[serde(serialize_with = "text::bytes")]
		var:   &'a BStr,
		/// Its value.
		#[serde(serialize_with = "text::bytes")]
		value: &'a BStr,
	},
	/// A loop finished.
	LoopEnd {
		/// Iterations run.
		iterations: u32,
	},
	/// A function was entered.
	FuncEnter {
		/// Name.
		#[serde(serialize_with = "text::bytes")]
		name:  &'a BStr,
		/// Arguments.
		#[serde(serialize_with = "text::list")]
		args:  &'a [BString],
		/// Call depth.
		depth: u32,
	},
	/// A function returned.
	FuncExit {
		/// Name.
		#[serde(serialize_with = "text::bytes")]
		name:   &'a BStr,
		/// Status.
		status: i32,
	},
	/// `source` entered a file.
	SourceEnter {
		/// Path.
		#[serde(serialize_with = "text::bytes")]
		path: &'a BStr,
	},
	/// `eval` entered its unit.
	EvalEnter,
	/// The shell or a subshell exits (`exit`).
	Exit {
		/// Status.
		status: i32,
	},
	/// A subshell vproc started.
	Subshell {
		/// Child vpid.
		child: Vpid,
	},
	/// A pipeline started.
	Pipeline {
		/// Stage vpids.
		stages: &'a [Vpid],
	},
	/// A background job started.
	Background {
		/// Job.
		job: JobId,
		/// `$!`.
		pid: Vpid,
	},
	/// An external process was spawned.
	Spawn {
		/// OS pid.
		pid:  u32,
		/// argv.
		#[serde(serialize_with = "text::list")]
		argv: &'a [BString],
	},
	/// A host callout was issued.
	Call {
		/// Call id.
		id:   CallId,
		/// argv.
		#[serde(serialize_with = "text::list")]
		argv: &'a [BString],
	},
	/// A native task was started.
	TaskStart {
		/// Native handle.
		native: NativeRef,
		/// argv.
		#[serde(serialize_with = "text::list")]
		argv:   &'a [BString],
	},
	/// A redirection was applied.
	Redirect {
		/// The redirection.
		redir: &'a RedirInfo,
	},
	/// A trap action runs.
	Trap {
		/// Trap slot.
		trap: TrapKey,
	},
	/// A virtual signal was delivered.
	Signal {
		/// Signal.
		sig:    Signal,
		/// Recipient.
		target: SigTarget,
	},
	/// A job stopped.
	Stopped {
		/// Job, if any.
		job: Option<JobId>,
	},
	/// A job continued.
	Continued {
		/// Job, if any.
		job: Option<JobId>,
	},
	/// A vproc parked.
	Blocked {
		/// What it waits for.
		key: &'a WaitKey,
	},
	/// A vproc resumed.
	Unblocked {
		/// What it waited for.
		key: &'a WaitKey,
	},
	/// `set -e` terminated the shell.
	ErrExit {
		/// Status.
		status: i32,
	},
	/// A diagnostic was printed.
	Diag {
		/// Catalog code ([`Diag`](crate::bash::Diag) variant name).
		code:    &'static str,
		/// Message without the `name: line N: ` prefix.
		#[serde(serialize_with = "text::bytes")]
		message: &'a BStr,
	},
	/// The shell reached `SuspendReady`.
	Suspended,
	/// The shell was restored.
	Restored {
		/// What was restored and lost.
		report: &'a RestoreReport,
	},
	/// Something could not be restored.
	Lost {
		/// What.
		lost: &'a Lost,
	},
	/// Host callout annotation.
	Custom(&'a CustomEvent),
}

impl EventData<'_> {
	/// The kind of this payload.
	pub const fn kind(&self) -> EventKind {
		match self {
			Self::RunStart { .. } => EventKind::RunStart,
			Self::RunEnd { .. } => EventKind::RunEnd,
			Self::UnitCompiled(_) => EventKind::UnitCompiled,
			Self::CmdStart { .. } => EventKind::CmdStart,
			Self::CmdExpanded { .. } => EventKind::CmdExpanded,
			Self::CmdEnd { .. } => EventKind::CmdEnd,
			Self::Assign { .. } => EventKind::Assign,
			Self::Branch { .. } => EventKind::Branch,
			Self::IterStart { .. } => EventKind::IterStart,
			Self::LoopEnd { .. } => EventKind::LoopEnd,
			Self::FuncEnter { .. } => EventKind::FuncEnter,
			Self::FuncExit { .. } => EventKind::FuncExit,
			Self::SourceEnter { .. } => EventKind::SourceEnter,
			Self::EvalEnter => EventKind::EvalEnter,
			Self::Exit { .. } => EventKind::Exit,
			Self::Subshell { .. } => EventKind::Subshell,
			Self::Pipeline { .. } => EventKind::Pipeline,
			Self::Background { .. } => EventKind::Background,
			Self::Spawn { .. } => EventKind::Spawn,
			Self::Call { .. } => EventKind::Call,
			Self::TaskStart { .. } => EventKind::TaskStart,
			Self::Redirect { .. } => EventKind::Redirect,
			Self::Trap { .. } => EventKind::Trap,
			Self::Signal { .. } => EventKind::Signal,
			Self::Stopped { .. } => EventKind::Stopped,
			Self::Continued { .. } => EventKind::Continued,
			Self::Blocked { .. } => EventKind::Blocked,
			Self::Unblocked { .. } => EventKind::Unblocked,
			Self::ErrExit { .. } => EventKind::ErrExit,
			Self::Diag { .. } => EventKind::Diag,
			Self::Suspended => EventKind::Suspended,
			Self::Restored { .. } => EventKind::Restored,
			Self::Lost { .. } => EventKind::Lost,
			Self::Custom(_) => EventKind::Custom,
		}
	}
}
