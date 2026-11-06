//! Reduction of the real bounded trace journal. Node keys never come from
//! source matching.
use std::collections::{HashMap, HashSet};

use bstr::{BStr, BString, ByteSlice};

use super::{
	model::{NodeKey, Options, Timeline, Watch},
	printer::Cache,
};
use crate::bash::{
	event::{AssignScope, Construct, NodeKind, RedirInfo, ResolvedKind},
	ids::{CmdTag, Vpid},
	syntax::NodeId,
	trace::{
		self,
		history::{HistoryData, HistoryEvent},
		syntax::UnitSyntax,
	},
};

pub(crate) trait VizSource {
	fn script(&self) -> &BStr;
	fn unit_count(&self) -> usize;
	fn unit(&self, index: usize) -> Option<SourceUnit<'_>>;
	fn cache(&self) -> &Cache;
}
pub(crate) struct SourceUnit<'a> {
	pub index:      u32,
	pub source:     &'a BStr,
	pub at:         Option<u32>,
	pub line:       u32,
	pub syntax:     Option<&'a UnitSyntax>,
	pub projection: u32,
	pub nodes:      &'a [trace::Node],
	/// See [`trace::Unit::callout`].
	pub callout:    bool,
}
#[derive(Debug)]
pub(crate) struct Observation<'a> {
	pub state:          trace::State,
	pub status:         Option<i32>,
	pub duration_ns:    u64,
	pub runs:           u32,
	pub iteration:      Option<u32>,
	pub iterations:     Option<u32>,
	pub taken:          Option<bool>,
	pub argv:           &'a [BString],
	pub env:            &'a [(BString, BString)],
	pub resolved:       Option<ResolvedKind>,
	pub redirs:         &'a [RedirInfo],
	pub pid:            Option<u32>,
	pub pipeline:       &'a [i32],
	pub executed_at_ns: Option<u64>,
	pub execution_seq:  Option<u64>,
	live:               u32,
}
impl Default for Observation<'_> {
	fn default() -> Self {
		Self {
			state:          trace::State::Pending,
			status:         None,
			duration_ns:    0,
			runs:           0,
			iteration:      None,
			iterations:     None,
			taken:          None,
			argv:           &[],
			env:            &[],
			resolved:       None,
			redirs:         &[],
			pid:            None,
			pipeline:       &[],
			executed_at_ns: None,
			execution_seq:  None,
			live:           0,
		}
	}
}
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Binding {
	GlobalRoot,
	Process(AssignScope, Vpid),
	UnlocatedLocal,
	Env(CmdTag),
	Iteration(Option<Vpid>, u64),
	Unknown(AssignScope, u64),
}
impl Binding {
	fn identity(self) -> Option<String> {
		match self {
			Self::GlobalRoot => Some("global".into()),
			Self::Process(AssignScope::Local, pid) => Some(format!("local:{}:binding:unknown", pid.0)),
			Self::UnlocatedLocal => Some("local:process:unknown:binding:unknown".into()),
			Self::Process(scope, pid) => Some(format!("{}:{}", scope_name(scope), pid.0)),
			Self::Env(command) => {
				Some(format!("env:{}:{}:{}", command.run.0, command.vpid.0, command.seq))
			},
			Self::Iteration(Some(pid), _) => Some(format!("iteration:{}", pid.0)),
			Self::Iteration(None, seq) => Some(format!("iteration:unknown:{seq}")),
			Self::Unknown(..) => None,
		}
	}
}
struct Setter<'a> {
	name:        &'a BString,
	value:       &'a BString,
	full_length: Option<u32>,
	scope:       Option<AssignScope>,
	binding:     Binding,
	node:        Option<NodeKey>,
	seq:         u64,
}
const fn scope_name(scope: AssignScope) -> &'static str {
	match scope {
		AssignScope::Global => "global",
		AssignScope::Local => "local",
		AssignScope::Env => "env",
		AssignScope::Subshell => "subshell",
	}
}

pub(crate) struct Runtime<'a> {
	observations:  HashMap<NodeKey, Observation<'a>>,
	active:        HashSet<NodeKey>,
	branches:      HashMap<NodeKey, (bool, i32)>,
	watches:       Vec<Watch>,
	pub output:    String,
	pub timeline:  Timeline,
	pub running:   bool,
	pub executing: bool,
	pub message:   Option<String>,
}
impl<'a> Runtime<'a> {
	pub fn observation(&self, key: NodeKey) -> Option<&Observation<'a>> {
		self.observations.get(&key)
	}

	pub fn active(&self, key: NodeKey) -> bool {
		self.active.contains(&key)
	}

	pub fn watches(&self) -> &[Watch] {
		&self.watches
	}

	pub fn branch(&self, key: NodeKey) -> Option<bool> {
		self.branches.get(&key).map(|&(taken, _)| taken)
	}

	pub fn branch_status(&self, key: NodeKey) -> Option<i32> {
		self.branches.get(&key).map(|&(_, status)| status)
	}

	pub(super) fn reduce<I>(
		source: &'a impl VizSource,
		history: I,
		options: &Options,
		status: Option<i32>,
		root_vpid: Option<Vpid>,
		t_ns: u64,
		truncated: bool,
	) -> Self
	where
		I: Iterator<Item = &'a HistoryEvent> + Clone + ExactSizeIterator,
	{
		let length = history.len();
		let root_vpid = root_vpid.or_else(|| {
			(!truncated)
				.then(|| {
					history
						.clone()
						.find(|event| matches!(event.data, HistoryData::RunStart))
						.and_then(|event| event.vpid)
				})
				.flatten()
		});
		let cursor = if let Some(seq) = options.cursor_seq {
			history.clone().take_while(|ev| ev.seq <= seq).count()
		} else {
			options.cursor.unwrap_or(length).min(length)
		};
		let replay = options.cursor.is_some() || options.cursor_seq.is_some();
		let duration = history.clone().last().map_or(t_ns, |ev| ev.t_ns.max(t_ns));
		let mut result = Self {
			observations: HashMap::new(),
			active:       HashSet::new(),
			branches:     HashMap::new(),
			watches:      Vec::new(),
			output:       String::new(),
			timeline:     Timeline {
				length,
				cursor,
				elapsed_ns: 0,
				duration_ns: duration,
				trimmed: truncated.then_some(true),
			},
			running:      false,
			executing:    status.is_none(),
			message:      None,
		};
		let mut setters: HashMap<(Binding, &'a [u8]), Setter<'a>> = HashMap::new();
		let mut producers: HashMap<CmdTag, NodeKey> = HashMap::new();
		let mut frames: HashMap<Vpid, Vec<u64>> = HashMap::new();
		let analysis = super::printer::analyzed(source);
		let mut next_arm: HashMap<(Option<Vpid>, Option<u64>, NodeKey), usize> = HashMap::new();
		let mut ended = false;
		let mut previous: Option<&HistoryEvent> = None;
		for event in history.take(cursor) {
			result.timeline.elapsed_ns = event.t_ns;
			let key = event
				.u
				.zip(event.n)
				.map(|(u, n)| NodeKey::engine(u, NodeId(n)));
			if let Some(key) = key {
				let observation = result.observations.entry(key).or_default();
				match &event.data {
					HistoryData::CmdStart => {
						observation.runs += 1;
						observation.live += 1;
						observation.state = trace::State::Running;
					},
					HistoryData::CmdExpanded { argv, assigns, resolved, redirs } => {
						observation.argv = argv;
						observation.env = assigns;
						observation.resolved = Some(*resolved);
						observation.redirs = redirs;
					},
					HistoryData::CmdEnd { status, dur_ns, pipestatus } => {
						observation.live = observation.live.saturating_sub(1);
						observation.status = Some(*status);
						observation.duration_ns += dur_ns;
						observation.pipeline = pipestatus;
						observation.executed_at_ns = Some(event.t_ns);
						observation.execution_seq = Some(event.seq);
						observation.state = if observation.live > 0 {
							trace::State::Running
						} else if *status == 0 {
							trace::State::Ok
						} else {
							trace::State::Fail
						};
					},
					HistoryData::Branch { taken, .. } => observation.taken = Some(*taken),
					HistoryData::IterStart { iteration, .. } => observation.iteration = Some(*iteration),
					HistoryData::LoopEnd { iterations } => observation.iterations = Some(*iterations),
					HistoryData::Spawn { pid, .. } | HistoryData::Background { pid } => {
						observation.pid = Some(*pid);
					},
					_ => {},
				}
				if (matches!(event.data, HistoryData::CmdExpanded { .. })
					|| (matches!(event.data, HistoryData::CmdStart)
						&& source
							.unit(key.unit as usize)
							.and_then(|unit| unit.nodes.get(key.node.0 as usize))
							.is_some_and(|n| n.k == NodeKind::Simple)))
					&& let Some(command) = event.command
				{
					producers.insert(command, key);
				}
			}
			match &event.data {
				HistoryData::Branch { construct, taken, status } => {
					if let Some(owner) = key
						&& let Some(conditions) = analysis.branch_conditions.get(&owner)
					{
						let frame = event
							.vpid
							.and_then(|pid| frames.get(&pid))
							.and_then(|frames| frames.last())
							.copied();
						let activation = (event.vpid, frame, owner);
						let arm = match construct {
							Construct::If => {
								next_arm.insert(activation, 1);
								Some(0)
							},
							Construct::Elif => next_arm.get_mut(&activation).map(|next| {
								let arm = *next;
								*next += 1;
								arm
							}),
							Construct::While | Construct::Until => Some(0),
							_ => None,
						};
						if let Some(condition) = arm.and_then(|arm| conditions.get(arm)) {
							result.branches.insert(*condition, (*taken, *status));
						}
					}
				},
				HistoryData::Output { text, .. } => result.output.push_str(&text.to_str_lossy()),
				HistoryData::RunStart if root_event(event, root_vpid) => {
					ended = false;
					result.executing = true;
				},
				HistoryData::RunEnd { .. }
					if root_event(event, root_vpid)
						&& (event.segment.is_none() || event.logical_end) =>
				{
					ended = true;
					result.executing = false;
				},
				HistoryData::FuncEnter { .. } => {
					if let Some(vpid) = event.vpid {
						frames.entry(vpid).or_default().push(event.seq);
					}
				},
				HistoryData::FuncExit { .. } => {
					if let Some(vpid) = event.vpid
						&& let Some(stack) = frames.get_mut(&vpid)
					{
						stack.pop();
					}
				},
				HistoryData::IterStart { name, value, .. } if !name.is_empty() => {
					let committed = previous.is_some_and(|previous| {
						previous.vpid == event.vpid && matches!(&previous.data, HistoryData::Assign { name: assigned, value: observed, .. } if assigned == name && observed == value)
					});
					if !committed {
						let location = setter_key(
							source,
							&analysis,
							key,
							event
								.command
								.and_then(|command| producers.get(&command).copied()),
						);
						let binding = Binding::Iteration(
							event.vpid,
							if event.vpid.is_some() { 0 } else { event.seq },
						);
						setters.insert((binding, name.as_slice()), Setter {
							name,
							value,
							full_length: None,
							scope: None,
							binding,
							node: location,
							seq: event.seq,
						});
					}
				},
				HistoryData::Assign { name, value, full_len, scope } => {
					let vpid = event
						.vpid
						.or_else(|| event.command.map(|command| command.vpid));
					// Unknown provenance stays explicitly unknown, never root/global
					// by guess.
					let binding = match scope {
						AssignScope::Global if vpid.is_some() && vpid == root_vpid => {
							Some(Binding::GlobalRoot)
						},
						AssignScope::Global | AssignScope::Subshell => {
							vpid.map(|pid| Binding::Process(*scope, pid))
						},
						// Assign reports a category, not the dynamic-scope binding owner.
						AssignScope::Local => {
							Some(vpid.map_or(Binding::UnlocatedLocal, |pid| Binding::Process(*scope, pid)))
						},
						AssignScope::Env => event.command.map(Binding::Env),
					}
					.unwrap_or(Binding::Unknown(*scope, event.seq));
					let node = setter_key(
						source,
						&analysis,
						key,
						event
							.command
							.and_then(|command| producers.get(&command).copied()),
					);
					setters.insert((binding, name.as_slice()), Setter {
						name,
						value,
						full_length: u32::try_from(*full_len).ok(),
						scope: Some(*scope),
						binding,
						node,
						seq: event.seq,
					});
				},
				_ => {},
			}
			previous = Some(event);
		}
		if !replay {
			result.timeline.elapsed_ns = result.timeline.elapsed_ns.max(t_ns);
			ended = status.is_some() || ended;
			result.executing = !ended;
			for u in 0..source.unit_count() {
				let Some(unit) = source.unit(u) else { continue };
				for (n, node) in unit.nodes.iter().enumerate() {
					let key = NodeKey::engine(u as u32, NodeId(n as u32));
					let previous = result.observations.remove(&key).unwrap_or_default();
					result.observations.insert(key, Observation {
						state:          if node.live > 0 {
							trace::State::Running
						} else if let Some(status) = node.st {
							if status == 0 {
								trace::State::Ok
							} else {
								trace::State::Fail
							}
						} else if ended {
							trace::State::Skipped
						} else {
							trace::State::Pending
						},
						status:         node.st,
						duration_ns:    node.ns,
						runs:           node.runs,
						iteration:      node.iter,
						iterations:     node.iters,
						taken:          node.taken,
						argv:           &node.argv,
						env:            &node.env,
						resolved:       node.res,
						redirs:         &node.redirs,
						pid:            node.pid,
						pipeline:       &node.pipe,
						executed_at_ns: node.end_ns.or(previous.executed_at_ns),
						execution_seq:  node.end_seq.or(previous.execution_seq),
						live:           node.live,
					});
				}
			}
		}
		for u in 0..source.unit_count() {
			let Some(unit) = source.unit(u) else { continue };
			for (n, node) in unit.nodes.iter().enumerate() {
				let key = NodeKey::engine(u as u32, NodeId(n as u32));
				let observation = result.observations.entry(key).or_default();
				if ended && observation.state == trace::State::Pending {
					observation.state = trace::State::Skipped;
				}
				if observation.live > 0
					&& node.hi > node.lo
					&& observation.resolved != Some(ResolvedKind::Function)
					&& matches!(node.k, NodeKind::Simple | NodeKind::Arith | NodeKind::Cond)
				{
					result.active.insert(key);
				}
			}
		}
		// A substitution can run a leaf inside another leaf. Only deepest actual
		// leaves light up.
		let active: Vec<_> = result.active.iter().copied().collect();
		for leaf in &active {
			let mut parent = analysis.parents.get(leaf).copied();
			for _ in 0..analysis.parents.len() {
				let Some(key) = parent else { break };
				result.active.remove(&key);
				parent = analysis.parents.get(&key).copied();
			}
		}
		for leaf in &active {
			let mut unit = source.unit(leaf.unit as usize);
			for _ in 0..source.unit_count() {
				let Some(parent) = unit
					.as_ref()
					.and_then(|unit| unit.syntax)
					.and_then(|syntax| syntax.parent)
				else {
					break;
				};
				let Some(parent_unit) = source.unit(parent.unit as usize) else {
					break;
				};
				let word = NodeKey::engine(parent.unit, NodeId(parent.node));
				let mut node = analysis.owners.get(&word).copied();
				for _ in 0..=analysis.parents.len() {
					let Some(key) = node else { break };
					result.active.remove(&key);
					node = analysis.parents.get(&key).copied();
				}
				unit = Some(parent_unit);
			}
		}
		result.running = !result.active.is_empty();
		result.watches = setters
			.into_values()
			.map(|setter| Watch {
				name:        setter.name.to_str_lossy().into_owned(),
				value:       setter.value.to_str_lossy().into_owned(),
				full_length: setter.full_length,
				scope:       setter.scope.map(|scope| scope_name(scope).into()),
				scope_id:    setter.binding.identity(),
				node:        setter.node,
				range:       setter
					.node
					.and_then(|key| setter_range(source, &analysis, key)),
				setter_seq:  Some(setter.seq),
			})
			.collect();
		result.watches.sort_by_key(|watch| watch.setter_seq);
		if replay && length == 0 {
			result.message = Some("Replay unavailable: this trace has no retained history".into());
		}
		result
	}
}
fn root_event(event: &HistoryEvent, root: Option<Vpid>) -> bool {
	event.vpid == root
}
fn setter_key(
	source: &impl VizSource,
	analysis: &super::analysis::Analysis,
	key: Option<NodeKey>,
	command: Option<NodeKey>,
) -> Option<NodeKey> {
	let valid = |key: NodeKey| {
		source
			.unit(key.unit as usize)
			.and_then(|unit| unit.nodes.get(key.node.0 as usize))
			.is_some_and(|node| node.hi > node.lo && node.k != NodeKind::Word)
	};
	key.filter(|&key| valid(key))
		.or_else(|| {
			key.and_then(|key| analysis.owners.get(&key).copied())
				.filter(|&key| valid(key))
		})
		.or_else(|| command.filter(|&key| valid(key)))
}
fn setter_range(
	source: &impl VizSource,
	analysis: &super::analysis::Analysis,
	key: NodeKey,
) -> Option<[u32; 2]> {
	let unit = source.unit(key.unit as usize)?;
	let span = *analysis.spans.get(&key)?;
	super::printer::source_map(source, &unit).range(span)
}
