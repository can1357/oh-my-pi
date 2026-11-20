//! Engine events folded into real command state and bounded replay history.
//!
//! Canonical engine syntax, assignments and attributed output feed native
//! Raw/Pseudo presentation without a frontend parser or shell runtime reducer.
//!
//! A [`RunTrace`] is an [`EventSink`] attached to one run
//! ([`RunOptions::events`](crate::session::RunOptions::events)); it folds
//! every event under a mutex and bumps [`RunTrace::version`]. A poller that
//! sees a new version takes [`RunTrace::snapshot`] (or
//! [`RunTrace::snapshot_json`]), the persisted trace model. Presentation
//! borrows the locked native model through [`RunTrace::presentation_json`].
//! Node offsets are relative to their compiled unit; a located unit's
//! offset and byte length select its source from the original script.

pub mod history;
mod nodes;
pub mod syntax;
pub mod viz;

use std::{
	collections::{HashMap, HashSet, VecDeque, hash_map::Entry},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use bstr::{BString, ByteSlice};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

use crate::bash::{
	event::{Event, EventData, EventKind, EventMask, EventSink, NodeKind, RedirInfo, ResolvedKind},
	ids::{RunId, UnitId, Vpid},
	ir::NodeInfo,
	text,
};

/// Snapshot format version.
const VERSION: u8 = 1;
/// Longest argument or assignment value kept.
const ARG_BYTES: usize = 256;
/// Most arguments or assignments kept.
const ARG_ITEMS: usize = 64;
/// Diagnostics kept (the newest).
const DIAGS: usize = 8;

/// A statement's state, derived at snapshot time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
	/// Not reached yet.
	#[default]
	Pending,
	/// Started, not finished.
	Running,
	/// Finished with status 0.
	Ok,
	/// Finished with a non-zero status.
	Fail,
	/// Never reached, and the run is over.
	Skipped,
}

/// One syntax node of a unit and what it did.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Node {
	/// Kind.
	pub k:       NodeKind,
	/// First byte, relative to the unit source.
	pub lo:      u32,
	/// One past the last byte.
	pub hi:      u32,
	/// Parent node (absent for a root).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub p:       Option<u32>,
	/// Derived state.
	pub state:   State,
	/// `CmdStart` count.
	#[serde(skip_serializing_if = "is_zero_u32")]
	pub runs:    u32,
	/// `CmdStart` minus `CmdEnd`.
	#[serde(skip_serializing_if = "is_zero_u32")]
	pub live:    u32,
	/// Status of the last `CmdEnd`.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub st:      Option<i32>,
	/// `CmdEnd`s with a non-zero status.
	#[serde(skip_serializing_if = "is_zero_u32")]
	pub fails:   u32,
	/// Sum of `dur_ns` over the ended runs.
	#[serde(skip_serializing_if = "is_zero_u64")]
	pub ns:      u64,
	/// Run clock at the last `CmdStart`.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub at:      Option<u64>,
	/// Last `CmdExpanded` argv (truncated).
	#[serde(skip_serializing_if = "Vec::is_empty", serialize_with = "text::list")]
	pub argv:    Vec<BString>,
	/// Full argument count when `argv` was cut.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub argc:    Option<u32>,
	/// Last `CmdExpanded` assignments (truncated).
	#[serde(skip_serializing_if = "Vec::is_empty", serialize_with = "text::pairs")]
	pub env:     Vec<(BString, BString)>,
	/// Last `CmdExpanded` resolution.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub res:     Option<ResolvedKind>,
	/// Last `CmdExpanded` redirections.
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub redirs:  Vec<RedirInfo>,
	/// Pipestatus of the last `CmdEnd`.
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub pipe:    Vec<i32>,
	/// Last `IterStart` number.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub iter:    Option<u32>,
	/// `LoopEnd` iterations.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub iters:   Option<u32>,
	/// Last `Branch` decision.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub taken:   Option<bool>,
	/// Backgrounded.
	#[serde(skip_serializing_if = "std::ops::Not::not")]
	pub bg:      bool,
	/// Last `Spawn` pid.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub pid:     Option<u32>,
	/// Actual final command completion clock and retained trace revision.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub end_ns:  Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub end_seq: Option<u64>,
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde `skip_serializing_if` signature")]
const fn is_zero_u32(v: &u32) -> bool {
	*v == 0
}

#[expect(clippy::trivially_copy_pass_by_ref, reason = "serde `skip_serializing_if` signature")]
const fn is_zero_u64(v: &u64) -> bool {
	*v == 0
}

impl Default for Node {
	fn default() -> Self {
		Self::new(NodeKind::Simple, 0, 0, None)
	}
}

impl Node {
	/// A node that did nothing yet.
	const fn new(k: NodeKind, lo: u32, hi: u32, p: Option<u32>) -> Self {
		Self {
			k,
			lo,
			hi,
			p,
			state: State::Pending,
			runs: 0,
			live: 0,
			st: None,
			fails: 0,
			ns: 0,
			at: None,
			argv: Vec::new(),
			argc: None,
			env: Vec::new(),
			res: None,
			redirs: Vec::new(),
			pipe: Vec::new(),
			iter: None,
			iters: None,
			taken: None,
			bg: false,
			pid: None,
			end_ns: None,
			end_seq: None,
		}
	}

	const fn of(info: &NodeInfo, p: Option<u32>) -> Self {
		Self::new(info.kind, info.lo, info.hi, p)
	}
}

/// A compiled unit of the run.
///
/// Serialized as `{at?, line, bytes, source?, nodes, syntax?, projection?}`;
/// located units slice the original script instead of repeating their source.
#[derive(Clone, Debug)]
pub struct Unit {
	/// Byte offset in the script (absent when the script does not contain
	/// the unit: `eval`, a nested shell, a trap).
	pub at:         Option<u32>,
	/// 1-based script line.
	pub line:       u32,
	/// Exact source byte length, including here-document bodies.
	pub bytes:      u32,
	/// Unit bytes (unlocated units only; located ones slice the script).
	pub source:     Option<BString>,
	/// Nodes by id.
	pub nodes:      Vec<Node>,
	/// Opaque serialized canonical native syntax, shared in memory.
	pub syntax:     Option<Arc<syntax::UnitSyntax>>,
	/// Compiler-known wrapper bytes removed at the presentation boundary.
	pub projection: u32,
	/// The script a callout (`timeout`, `git`, `xargs`, …) submitted to run
	/// its operands: host-generated, so the calling command stands for it.
	pub callout:    bool,
}

impl Serialize for Unit {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		let mut st = s.serialize_struct("Unit", 5)?;
		if let Some(at) = self.at {
			st.serialize_field("at", &at)?;
		}
		st.serialize_field("line", &self.line)?;
		st.serialize_field("bytes", &self.bytes)?;
		if let Some(source) = &self.source {
			st.serialize_field("source", &text::Text(source))?;
		}
		st.serialize_field("nodes", &self.nodes)?;
		if let Some(syntax) = &self.syntax {
			st.serialize_field("syntax", syntax.as_ref())?;
		}
		if self.projection != 0 {
			st.serialize_field("projection", &self.projection)?;
		}
		if self.callout {
			st.serialize_field("callout", &true)?;
		}
		st.end()
	}
}

/// A diagnostic the run printed.
#[derive(Clone, Debug, Serialize)]
pub struct Diag {
	/// Catalog code.
	pub code:    &'static str,
	/// Message.
	#[serde(serialize_with = "text::bytes")]
	pub message: BString,
}

/// The model at one moment.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
	/// Format version.
	pub v:                 u8,
	/// Semantic/output revision, including assignments and coalesced bytes.
	pub seq:               u64,
	/// `RunEnd` status (absent while running).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub status:            Option<i32>,
	/// Actual root vproc, retained even when the root `RunStart` was trimmed.
	#[serde(rename = "rootVpid", skip_serializing_if = "Option::is_none")]
	pub root_vpid:         Option<Vpid>,
	/// Logical-call clock at the last folded event (segments share one origin).
	pub t_ns:              u64,
	/// The command text.
	#[serde(serialize_with = "text::bytes")]
	pub script:            BString,
	/// Units in announce order.
	pub units:             Vec<Unit>,
	/// The newest diagnostics.
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub diags:             Vec<Diag>,
	/// Bounded, ordered journal for replay and per-producer output.
	pub history:           Vec<history::HistoryEvent>,
	/// At least one journal entry/output byte was evicted by the caps.
	#[serde(rename = "historyTruncated", skip_serializing_if = "std::ops::Not::not")]
	pub history_truncated: bool,
}

/// A unit as the fold keeps it.
#[derive(Clone, Debug)]
struct UnitState {
	segment:     Option<u32>,
	/// Native source-context identity shared by a definition and its body units.
	family:      Option<UnitId>,
	id:          Option<UnitId>,
	at:          Option<u32>,
	line:        u32,
	source:      BString,
	syntax:      Option<Arc<syntax::UnitSyntax>>,
	projection:  u32,
	nodes:       Vec<Node>,
	/// Statement children per node (parents are in `nodes`).
	kids:        Vec<Vec<u32>>,
	/// Built from events alone, never announced: no node table.
	placeholder: bool,
	/// See [`Unit::callout`].
	callout:     bool,
}

#[derive(Debug)]
struct Inner {
	script:       BString,
	seq:          u64,
	status:       Option<i32>,
	t_ns:         u64,
	/// `t_ns` of the root `RunStart`, never a nested run's start.
	origin:       Option<u64>,
	run:          Option<RunId>,
	root_vpid:    Option<Vpid>,
	/// Exact membership learned from engine fork events, each marked when
	/// it runs a callout's script ([`Unit::callout`]): the callout's
	/// subshell, or a fork of it. Engine forks emit `run: None`;
	/// API-created subshells have their own `RunId`.
	vpids:        HashMap<Vpid, bool>,
	vpid_order:   VecDeque<Vpid>,
	runs:         HashSet<RunId>,
	run_order:    VecDeque<RunId>,
	units:        Vec<UnitState>,
	by_id:        HashMap<Vpid, HashMap<(Option<u32>, UnitId), u32>>,
	diags:        Vec<Diag>,
	journal:      history::Journal,
	segment:      Option<SegmentState>,
	next_segment: u32,
	viz_cache:    viz::printer::Cache,
}

/// Exact original byte region of one minimizer-planned segment. The
/// wrapper prefix is compiler-known (`{ `), never found by source search.
#[derive(Clone, Copy, Debug)]
pub struct SegmentSource {
	/// Original outer script byte offset from the authoritative AST span.
	pub at:     u32,
	/// Original segment byte length, before host-added wrappers.
	pub len:    u32,
	/// Known bytes prepended by the execution wrapper (zero or two).
	pub prefix: u32,
}

#[derive(Debug)]
struct SegmentState {
	index:  u32,
	source: SegmentSource,
	mapped: Option<UnitId>,
}

struct SegmentObserver {
	trace:  Arc<RunTrace>,
	index:  u32,
	source: SegmentSource,
}

impl EventSink for SegmentObserver {
	fn mask(&self) -> EventMask {
		self.trace.mask()
	}

	fn run_submitted(&self, run: RunId) {
		let mut inner = self.trace.inner.lock();
		inner.run = Some(run);
		inner.status = None;
		inner.root_vpid = None;
		inner.vpids.clear();
		inner.vpid_order.clear();
		inner.runs.clear();
		inner.run_order.clear();
		inner.segment = Some(SegmentState { index: self.index, source: self.source, mapped: None });
	}

	fn event(&self, event: &Event<'_>) {
		self.trace.event(event);
	}

	fn output(&self, tag: Option<crate::bash::ids::CmdTag>, t_ns: u64, fd: i32, bytes: &[u8]) {
		self.trace.output(tag, t_ns, fd, bytes);
	}

	fn output_end(&self, t_ns: u64, fd: i32) {
		self.trace.output_end(t_ns, fd);
	}
}

/// The events of one run folded into a drawable model.
#[derive(Debug)]
pub struct RunTrace {
	inner:   Mutex<Inner>,
	version: AtomicU64,
}

impl RunTrace {
	/// An empty trace of `script` (the command text about to run).
	pub fn new(script: impl Into<BString>) -> Self {
		Self {
			inner:   Mutex::new(Inner {
				script:       script.into(),
				seq:          0,
				status:       None,
				t_ns:         0,
				origin:       None,
				run:          None,
				root_vpid:    None,
				vpids:        HashMap::new(),
				vpid_order:   VecDeque::new(),
				runs:         HashSet::new(),
				run_order:    VecDeque::new(),
				units:        Vec::new(),
				by_id:        HashMap::new(),
				diags:        Vec::new(),
				journal:      history::Journal::default(),
				segment:      None,
				next_segment: 0,
				viz_cache:    viz::printer::Cache::default(),
			}),
			version: AtomicU64::new(0),
		}
	}

	/// Observe one actual segmented submission using its exact AST region.
	/// The shell driver still executes/minimizes each segment normally.
	pub fn segment(self: &Arc<Self>, source: SegmentSource) -> Arc<dyn EventSink> {
		let mut inner = self.inner.lock();
		let index = inner.next_segment;
		inner.next_segment += 1;
		drop(inner);
		Arc::new(SegmentObserver { trace: Arc::clone(self), index, source })
	}

	/// Publish logical completion after the segmented driver has its real
	/// outcome and drained output. Real segment `RunEnds` remain in history.
	pub fn finish_segments(&self, status: i32) {
		let mut inner = self.inner.lock();
		inner.status = Some(status);
		let root = inner.root_vpid;
		for entry in inner.journal.entries.iter_mut().rev() {
			if entry.vpid == root && matches!(entry.data, history::HistoryData::RunEnd { .. }) {
				entry.logical_end = true;
				entry.logical_status = Some(status);
				break;
			}
		}
		inner.seq += 1;
		self.version.store(inner.seq, Ordering::Release);
	}

	/// Semantic/output revision: unchanged ⇒ the snapshot is unchanged.
	pub fn version(&self) -> u64 {
		self.version.load(Ordering::Acquire)
	}

	/// The model now.
	pub fn snapshot(&self) -> Snapshot {
		let mut inner = self.inner.lock();
		inner.snapshot()
	}

	/// Present the live native syntax and journal while borrowing the locked
	/// model.
	pub fn presentation_json(&self, options: &viz::Options) -> Result<String, viz::VizError> {
		viz::live(&self.inner.lock(), options)
	}

	/// [`Self::snapshot`] as JSON.
	pub fn snapshot_json(&self) -> String {
		let mut inner = self.inner.lock();
		let ended = inner.status.is_some();
		for unit in &mut inner.units {
			derive_states(&mut unit.nodes, &unit.kids, ended);
		}
		serde_json::to_string(&SnapshotJson(&inner)).expect("the snapshot serializes")
	}
}

impl EventSink for RunTrace {
	fn run_submitted(&self, run: RunId) {
		let mut inner = self.inner.lock();
		if inner.run.is_none() {
			inner.run = Some(run);
		}
	}

	fn mask(&self) -> EventMask {
		EventMask::NONE
			.with(EventKind::UnitCompiled)
			.with(EventKind::RunStart)
			.with(EventKind::RunEnd)
			.with(EventKind::CmdStart)
			.with(EventKind::CmdExpanded)
			.with(EventKind::CmdEnd)
			.with(EventKind::Pipeline)
			.with(EventKind::Branch)
			.with(EventKind::IterStart)
			.with(EventKind::LoopEnd)
			.with(EventKind::Background)
			.with(EventKind::Subshell)
			.with(EventKind::FuncEnter)
			.with(EventKind::FuncExit)
			.with(EventKind::Spawn)
			.with(EventKind::Diag)
			.with(EventKind::ErrExit)
			.with(EventKind::Exit)
			.with(EventKind::Assign)
	}

	fn event(&self, ev: &Event<'_>) {
		let mut inner = self.inner.lock();
		if inner.origin.is_none() {
			if !matches!(ev.data, EventData::RunStart { .. })
				|| ev.run().is_none()
				|| inner.run.is_some_and(|run| Some(run) != ev.run())
			{
				return;
			}
			inner.run = ev.run();
			inner.root_vpid = Some(ev.vpid);
			inner.vpids.insert(ev.vpid, false);
		} else {
			if ev.run() == inner.run && matches!(ev.data, EventData::RunStart { .. }) {
				inner.root_vpid = Some(ev.vpid);
				inner.vpids.insert(ev.vpid, false);
			}
			match ev.run() {
				Some(id) if Some(id) == inner.run || inner.runs.contains(&id) => {},
				Some(id)
					if matches!(ev.data, EventData::RunStart { .. })
						&& Some(ev.vpid) != inner.root_vpid
						&& let Some(callout) = inner.vpids.get_mut(&ev.vpid) =>
				{
					// Only callouts submit scripts on descendant runs
					// (`ShellApi::run_subshell`).
					*callout = true;
					inner.descendant_run(id);
				},
				None if inner.vpids.contains_key(&ev.vpid) => {},
				_ => return,
			}
		}
		inner.descendants(ev);
		inner.fold(ev);
		self.version.store(inner.seq, Ordering::Release);
	}

	fn output(&self, tag: Option<crate::bash::ids::CmdTag>, t_ns: u64, fd: i32, bytes: &[u8]) {
		if bytes.is_empty() {
			return;
		}
		let mut inner = self.inner.lock();
		// The writer is bound to this capture generation. Child vprocs'
		// genuine engine tags carry run=0 (their run queue is empty), so
		// comparing tag.run with the root RunId would discard their bytes.
		inner.seq += 1;
		inner.t_ns = t_ns.saturating_sub(inner.origin.unwrap_or(t_ns));
		let seq = inner.seq;
		let t = inner.t_ns;
		let segment = inner.segment_index();
		inner.journal.output(seq, t, tag, fd, bytes, segment);
		self.version.store(seq, Ordering::Release);
	}

	fn output_end(&self, t_ns: u64, fd: i32) {
		let mut inner = self.inner.lock();
		let seq = inner.seq + 1;
		let t = t_ns.saturating_sub(inner.origin.unwrap_or(t_ns));
		if inner.journal.finish_output(seq, t, fd) {
			inner.seq = seq;
			inner.t_ns = t;
			self.version.store(seq, Ordering::Release);
		}
	}
}

impl Inner {
	/// Learn only explicit engine lineage; never infer ownership from output.
	/// A fork inherits its parent's callout mark.
	fn descendants(&mut self, ev: &Event<'_>) {
		let callout = self.vpids.get(&ev.vpid) == Some(&true);
		match ev.data {
			EventData::Subshell { child } | EventData::Background { pid: child, .. } => {
				self.descendant(child, callout);
			},
			EventData::Pipeline { stages } => {
				for &child in stages {
					self.descendant(child, callout);
				}
			},
			_ => {},
		}
	}

	fn descendant(&mut self, child: Vpid, callout: bool) {
		if let Entry::Vacant(entry) = self.vpids.entry(child) {
			entry.insert(callout);
			self.vpid_order.push_back(child);
			if self.vpid_order.len() > history::HISTORY_EVENTS
				&& let Some(old) = self.vpid_order.pop_front()
			{
				self.vpids.remove(&old);
				self.by_id.remove(&old);
				self.journal.truncated = true;
			}
		}
	}

	fn descendant_run(&mut self, run: RunId) {
		if self.runs.insert(run) {
			self.run_order.push_back(run);
			if self.run_order.len() > history::HISTORY_EVENTS
				&& let Some(old) = self.run_order.pop_front()
			{
				self.runs.remove(&old);
				self.journal.truncated = true;
			}
		}
	}

	fn segment_index(&self) -> Option<u32> {
		self.segment.as_ref().map(|segment| segment.index)
	}

	fn unit_key(&self, id: UnitId) -> (Option<u32>, UnitId) {
		(self.segment_index(), id)
	}

	fn unit_index(&self, vpid: Vpid, id: UnitId) -> Option<u32> {
		self.by_id.get(&vpid)?.get(&self.unit_key(id)).copied()
	}

	fn fold(&mut self, ev: &Event<'_>) {
		self.seq += 1;
		let root = ev.run() == self.run;
		if root && self.origin.is_none() && matches!(ev.data, EventData::RunStart { .. }) {
			self.origin = Some(ev.t_ns);
		}
		let t = ev.t_ns.saturating_sub(self.origin.unwrap_or(ev.t_ns));
		self.t_ns = t;
		match ev.data {
			EventData::RunEnd { status } if root && self.segment.is_none() => {
				self.status = Some(status);
			},
			EventData::UnitCompiled(cu) => {
				let parent = cu.parent.and_then(|origin| {
					let span = origin.span;
					let index = self.unit_index(origin.vpid, span.unit)?;
					let unit = self.units.get(index as usize)?;
					Some(syntax::SourceParent {
						unit: index,
						node: origin.node,
						lo:   span.lo.checked_sub(unit.projection)?,
						hi:   span.hi.checked_sub(unit.projection)?,
					})
				});
				let syntax = cu.unit.trace_syntax.get().map(|syntax| {
					parent
						.map_or_else(|| Arc::clone(syntax), |parent| Arc::new(syntax.with_parent(parent)))
				});
				// A fork of a callout's subshell re-announces the callout's
				// units; a function body they reach keeps its definition's unit.
				let callout = cu.parent.is_none()
					&& cu.unit.root.is_none()
					&& self.vpids.get(&ev.vpid) == Some(&true);
				self.announce(
					cu.id(),
					ev.vpid,
					UnitId(*cu.unit.source_hasher().finalize().as_bytes()),
					cu.unit.root.is_some(),
					cu.line,
					&cu.unit.source,
					cu.nodes(),
					syntax,
					root && Some(ev.vpid) == self.root_vpid,
					callout,
				);
			},
			EventData::Diag { code, message } => {
				if self.diags.len() == DIAGS {
					self.diags.remove(0);
				}
				self.diags.push(Diag { code, message: message.into() });
			},
			_ => self.fold_node(ev, t),
		}
		if let Some(data) = history::HistoryData::of(ev) {
			let mut node = ev
				.node()
				.and_then(|node| {
					self
						.unit_index(ev.vpid, node.unit)
						.map(|u| (u, node.node.0))
				})
				.filter(|&(u, n)| {
					self
						.units
						.get(u as usize)
						.and_then(|unit| unit.nodes.get(n as usize))
						.is_some_and(|node| node.hi > node.lo)
				});
			let command = ev.command_tag();
			if matches!(ev.data, EventData::Assign { .. })
				&& !node.is_some_and(|(u, n)| {
					self
						.units
						.get(u as usize)
						.and_then(|unit| unit.nodes.get(n as usize))
						.is_some_and(|node| node.hi > node.lo && node.k != NodeKind::Word)
				}) {
				// The exact execution tag, not source proximity, is the only
				// fallback for a setter whose own node has no valid span.
				node = command
					.and_then(|tag| self.journal.producer(tag))
					.filter(|&(u, n)| {
						self
							.units
							.get(u as usize)
							.and_then(|unit| unit.nodes.get(n as usize))
							.is_some_and(|node| node.hi > node.lo && node.k != NodeKind::Word)
					});
			}
			if matches!(
				ev.data,
				EventData::CmdStart { node_kind: NodeKind::Simple } | EventData::CmdExpanded { .. }
			) && let (Some(tag), Some((u, n))) = (command, node)
			{
				self.journal.bind(tag, u, n);
			}
			self.journal.push(history::HistoryEvent {
				seq: self.seq,
				t_ns: t,
				event_seq: Some(ev.seq),
				segment: self.segment_index(),
				logical_end: false,
				logical_status: None,
				vpid: Some(ev.vpid),
				u: node.map(|p| p.0),
				n: node.map(|p| p.1),
				command,
				data,
			});
		}
	}

	/// A node event at run clock `t`.
	fn fold_node(&mut self, ev: &Event<'_>, t: u64) {
		let seq = self.seq;
		let Some(slot) = self.node_of(ev) else {
			return;
		};
		let n = slot.node;
		match ev.data {
			EventData::CmdStart { node_kind } => {
				if slot.kind_unset {
					n.k = node_kind;
				}
				n.runs += 1;
				n.live += 1;
				n.at = Some(t);
			},
			EventData::CmdExpanded { argv, assigns, redirs, resolved } => {
				n.argv = argv.iter().take(ARG_ITEMS).map(cut).collect();
				n.argc = (argv.len() > ARG_ITEMS).then_some(argv.len() as u32);
				n.env = assigns
					.iter()
					.take(ARG_ITEMS)
					.map(|(k, v)| (k.clone(), cut(v)))
					.collect();
				n.res = Some(resolved);
				n.redirs = redirs.to_vec();
			},
			EventData::CmdEnd { status, dur_ns, pipestatus } => {
				n.live = n.live.saturating_sub(1);
				n.st = Some(status);
				n.fails += u32::from(status != 0);
				n.ns += dur_ns;
				n.pipe = pipestatus.to_vec();
				n.end_ns = Some(t);
				n.end_seq = Some(seq);
			},
			EventData::Pipeline { .. } if slot.kind_unset => n.k = NodeKind::Pipeline,
			EventData::Branch { taken, .. } => n.taken = Some(taken),
			EventData::IterStart { n: iter, .. } => n.iter = Some(iter),
			EventData::LoopEnd { iterations } => n.iters = Some(iterations),
			EventData::Spawn { pid, .. } => n.pid = Some(pid),
			EventData::Background { .. } => {
				let (u, id) = (slot.unit, slot.id);
				self.background(u, id);
			},
			_ => {},
		}
	}

	/// Node `id` of unit `u` was backgrounded. The event names the and-or
	/// list; the line shows its lone statement (`layout` unwraps
	/// single-operand lists), so flag the chain down to it as well.
	fn background(&mut self, u: usize, mut id: usize) {
		let unit = &mut self.units[u];
		loop {
			let node = &mut unit.nodes[id];
			node.bg = true;
			let (lo, hi) = (node.lo, node.hi);
			match unit.kids.get(id).map(Vec::as_slice) {
				Some(&[k]) if unit.nodes[k as usize].lo == lo && unit.nodes[k as usize].hi == hi => {
					id = k as usize;
				},
				_ => break,
			}
		}
	}

	/// The node record of a node event; a placeholder unit and node when
	/// the unit was never announced to this trace.
	fn node_of(&mut self, ev: &Event<'_>) -> Option<NodeSlot<'_>> {
		let nref = ev.node()?;
		let span = ev.span()?;
		let key = self.unit_key(nref.unit);
		let u = if let Some(u) = self.unit_index(ev.vpid, nref.unit) {
			u as usize
		} else {
			let u = self.units.len();
			self.units.push(UnitState {
				segment:     self.segment_index(),
				family:      None,
				id:          Some(nref.unit),
				at:          None,
				line:        span.line,
				source:      BString::default(),
				syntax:      None,
				projection:  0,
				nodes:       Vec::new(),
				kids:        Vec::new(),
				placeholder: true,
				callout:     false,
			});
			self.by_id.entry(ev.vpid).or_default().insert(key, u as u32);
			u
		};
		let unit = &mut self.units[u];
		let id = nref.node.0 as usize;
		let kind_unset = if unit.placeholder && id >= unit.nodes.len() {
			unit
				.nodes
				.resize_with(id + 1, || Node::new(NodeKind::Simple, 0, 0, None));
			let node = &mut unit.nodes[id];
			node.lo = span.lo;
			node.hi = span.hi;
			true
		} else {
			false
		};
		let node = unit.nodes.get_mut(id)?;
		Some(NodeSlot { node, unit: u, id, kind_unset })
	}

	/// A unit was compiled: locate it in the script or merge
	/// it into the entry announced earlier for the same source (a function
	/// body re-announced with the full node table).
	fn announce(
		&mut self,
		id: UnitId,
		vpid: Vpid,
		family: UnitId,
		function: bool,
		mut line: u32,
		mut source: &[u8],
		nodes: &[NodeInfo],
		syntax: Option<Arc<syntax::UnitSyntax>>,
		root: bool,
		callout: bool,
	) {
		let mut mapped_nodes = Vec::new();
		let mut exact_at = None;
		let mut projection = 0;
		if let Some(segment) = self.segment.as_mut()
			&& (segment.mapped == Some(family) || (root && segment.mapped.is_none()))
		{
			let prefix = segment.source.prefix;
			let end = prefix.saturating_add(segment.source.len);
			let original = self.script.get(
				segment.source.at as usize
					..segment.source.at.saturating_add(segment.source.len) as usize,
			);
			if source.get(prefix as usize..end as usize) == original && original.is_some() {
				segment.mapped = Some(family);
				projection = prefix;
				source = &source[prefix as usize..end as usize];
				exact_at = Some(segment.source.at);
				line = self.script[..segment.source.at as usize]
					.split(|&byte| byte == b'\n')
					.count() as u32;
				mapped_nodes = nodes.to_vec();
				for node in &mut mapped_nodes {
					if prefix <= node.lo && node.hi <= end {
						node.lo -= prefix;
						node.hi -= prefix;
					} else {
						node.lo = 0;
						node.hi = 0;
					}
				}
			}
		}
		let nodes = if exact_at.is_some() {
			mapped_nodes.as_slice()
		} else {
			nodes
		};
		let segment = self.segment_index();
		let key = self.unit_key(id);
		let parents = nodes::parents(nodes);
		let existing = self
			.unit_index(vpid, id)
			.map(|u| u as usize)
			.filter(|&u| {
				self.units[u].placeholder
					|| self.units[u]
						.syntax
						.as_ref()
						.and_then(|syntax| syntax.parent)
						== syntax.as_ref().and_then(|syntax| syntax.parent)
			})
			.or_else(|| {
				self.units.iter().position(|unit| {
					unit.segment == segment
						&& !unit.placeholder
						&& unit.line == line
						&& (unit.id == Some(id) && unit.callout == callout
							|| function && unit.family == Some(family))
						&& unit.syntax.as_ref().and_then(|syntax| syntax.parent)
							== syntax.as_ref().and_then(|syntax| syntax.parent)
				})
			});
		if let Some(u) = existing {
			let unit = &mut self.units[u];
			if let Some(syntax) = syntax
				&& unit.syntax.as_ref().is_none_or(|existing| {
					!existing.shares_tree(&syntax)
						&& (existing.parent.is_none() || syntax.parent.is_some())
						&& !(existing.tree.kind == syntax::RootKind::List
							&& syntax.tree.kind == syntax::RootKind::Command)
				}) {
				unit.syntax = Some(syntax);
			}
			unit.projection = projection;
			if let Some(at) = exact_at {
				unit.at = Some(at);
			}
			unit.family = Some(family);
			let mut changed = unit.placeholder;
			if unit.placeholder {
				unit.source = source.into();
				unit.line = line;
				unit.placeholder = false;
				unit.callout = callout;
			}
			for (i, info) in nodes.iter().enumerate() {
				match unit.nodes.get_mut(i) {
					Some(node) if info.hi > info.lo => {
						// Deferred tables already have their final length.
						// Materialization fills previously empty slots without
						// growing it; never overwrite known spans with another
						// deferred function body's empty placeholder entries.
						if (node.k, node.lo, node.hi) != (info.kind, info.lo, info.hi) {
							node.k = info.kind;
							node.lo = info.lo;
							node.hi = info.hi;
							node.p = parents[i].or(node.p);
							changed = true;
						}
					},
					Some(_) => {},
					None => {
						unit.nodes.push(Node::of(info, parents[i]));
						changed = true;
					},
				}
			}
			if changed {
				let merged: Vec<NodeInfo> = unit
					.nodes
					.iter()
					.map(|node| NodeInfo {
						kind: node.k,
						lo:   node.lo,
						hi:   node.hi,
						line: 0,
						col:  1,
					})
					.collect();
				let merged_parents = nodes::parents(&merged);
				for (node, parent) in unit.nodes.iter_mut().zip(&merged_parents) {
					node.p = *parent;
				}
				unit.kids = nodes::statement_children(&merged, &merged_parents);
			}
			self.by_id.entry(vpid).or_default().insert(key, u as u32);
			return;
		}
		let at = exact_at.or_else(|| {
			if self.segment.is_none() && root {
				self.locate(line, source)
			} else {
				None
			}
		});
		self.units.push(UnitState {
			segment,
			family: Some(family),
			id: Some(id),
			at,
			line,
			source: BString::from(source),
			syntax,
			projection,
			nodes: nodes
				.iter()
				.zip(&parents)
				.map(|(info, p)| Node::of(info, *p))
				.collect(),
			kids: nodes::statement_children(nodes, &parents),
			placeholder: false,
			callout,
		});
		self
			.by_id
			.entry(vpid)
			.or_default()
			.insert(key, self.units.len() as u32 - 1);
	}

	/// Where `source` (announced for script line `line`) lies in the
	/// script: from the line's start, else past the last located unit;
	/// never inside another located unit (an `eval` string quoted in its
	/// command).
	fn locate(&self, line: u32, source: &[u8]) -> Option<u32> {
		if source.is_empty() {
			return None;
		}
		let script = self.script.as_slice();
		let line_start = script
			.split_inclusive(|&c| c == b'\n')
			.scan(0usize, |pos, l| {
				let start = *pos;
				*pos += l.len();
				Some(start)
			})
			.nth(line.saturating_sub(1) as usize);
		let end = self
			.units
			.iter()
			.filter_map(|u| Some(u.at? as usize + u.source.len()))
			.max()
			.unwrap_or(0);
		let find = |from: usize| {
			let at = from + script[from..].find(source)?;
			let free = self
				.units
				.iter()
				.filter_map(|u| Some((u.at? as usize, u.source.len())))
				.all(|(a, len)| at + source.len() <= a || a + len <= at);
			free.then_some(at as u32)
		};
		line_start
			.and_then(find)
			.or_else(|| find(end.min(script.len())))
	}

	fn snapshot(&mut self) -> Snapshot {
		let ended = self.status.is_some();
		for unit in &mut self.units {
			derive_states(&mut unit.nodes, &unit.kids, ended);
		}
		Snapshot {
			v:                 VERSION,
			seq:               self.seq,
			status:            self.status,
			root_vpid:         self.root_vpid,
			t_ns:              self.t_ns,
			script:            self.script.clone(),
			units:             self
				.units
				.iter()
				.map(|unit| Unit {
					at:         unit.at,
					line:       unit.line,
					bytes:      unit.source.len() as u32,
					source:     unit.at.is_none().then(|| unit.source.clone()),
					nodes:      unit.nodes.clone(),
					syntax:     unit.syntax.clone(),
					projection: unit.projection,
					callout:    unit.callout,
				})
				.collect(),
			diags:             self.diags.clone(),
			history:           self.journal.entries.iter().cloned().collect(),
			history_truncated: self.journal.truncated,
		}
	}
}

/// Borrowed JSON view: polling never clones the retained journal/output.
struct SnapshotJson<'a>(&'a Inner);

impl Serialize for SnapshotJson<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let inner = self.0;
		let mut out = serializer.serialize_struct("Snapshot", 10)?;
		out.serialize_field("v", &VERSION)?;
		out.serialize_field("seq", &inner.seq)?;
		if let Some(status) = inner.status {
			out.serialize_field("status", &status)?;
		}
		if let Some(vpid) = inner.root_vpid {
			out.serialize_field("rootVpid", &vpid)?;
		}
		out.serialize_field("t_ns", &inner.t_ns)?;
		out.serialize_field("script", &text::Text(&inner.script))?;
		out.serialize_field("units", &UnitsJson(&inner.units))?;
		if !inner.diags.is_empty() {
			out.serialize_field("diags", &inner.diags)?;
		}
		out.serialize_field("history", &inner.journal.entries)?;
		if inner.journal.truncated {
			out.serialize_field("historyTruncated", &true)?;
		}
		out.end()
	}
}

struct UnitsJson<'a>(&'a [UnitState]);

impl Serialize for UnitsJson<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.collect_seq(self.0.iter().map(|unit| UnitJson { unit }))
	}
}

struct UnitJson<'a> {
	unit: &'a UnitState,
}

impl Serialize for UnitJson<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let unit = self.unit;
		let mut out = serializer.serialize_struct("Unit", 5)?;
		if let Some(at) = unit.at {
			out.serialize_field("at", &at)?;
		}
		out.serialize_field("line", &unit.line)?;
		out.serialize_field("bytes", &(unit.source.len() as u32))?;
		if unit.at.is_none() {
			out.serialize_field("source", &text::Text(&unit.source))?;
		}
		out.serialize_field("nodes", &unit.nodes)?;
		if let Some(syntax) = &unit.syntax {
			out.serialize_field("syntax", syntax.as_ref())?;
		}
		if unit.projection != 0 {
			out.serialize_field("projection", &unit.projection)?;
		}
		if unit.callout {
			out.serialize_field("callout", &true)?;
		}
		out.end()
	}
}

/// A node record, where it is, and whether its kind is still the
/// placeholder default.
struct NodeSlot<'a> {
	node:       &'a mut Node,
	unit:       usize,
	id:         usize,
	kind_unset: bool,
}

/// `a` cut to [`ARG_BYTES`].
fn cut(a: &BString) -> BString {
	BString::from(text::cut(a, ARG_BYTES))
}

/// Every node's state, children before parents: its own runs, else the
/// last statement child that ran, else `skipped` once the run ended.
fn derive_states(nodes: &mut [Node], kids: &[Vec<u32>], ended: bool) {
	for i in (0..nodes.len()).rev() {
		let n = &nodes[i];
		let state = if n.live > 0 {
			State::Running
		} else if n.runs > 0 {
			if n.st.is_some_and(|st| st != 0) {
				State::Fail
			} else {
				State::Ok
			}
		} else {
			let children = kids.get(i).map_or(&[][..], Vec::as_slice);
			if children
				.iter()
				.any(|&k| nodes[k as usize].state == State::Running)
			{
				State::Running
			} else if let Some(ran) = children
				.iter()
				.rev()
				.map(|&k| nodes[k as usize].state)
				.find(|s| matches!(s, State::Ok | State::Fail))
			{
				ran
			} else if ended {
				State::Skipped
			} else {
				State::Pending
			}
		};
		nodes[i].state = state;
	}
}
