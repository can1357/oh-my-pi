//! Bounded replay journal. Output is observed only after a visible write
//! succeeds.

use std::collections::{HashMap, VecDeque};

use bstr::BString;
use serde::{Deserialize, Serialize};

use super::{ARG_ITEMS, cut};
use crate::bash::{
	event::{AssignScope, Construct, Event, EventData, RedirInfo, ResolvedKind},
	ids::{CmdTag, Vpid},
	text,
};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct OutputOrigin {
	segment: Option<u32>,
	command: Option<CmdTag>,
	u:       Option<u32>,
	n:       Option<u32>,
	t_ns:    u64,
}

impl OutputOrigin {
	fn same_producer(self, other: Self) -> bool {
		self.segment == other.segment
			&& self.command == other.command
			&& self.u == other.u
			&& self.n == other.n
	}
}

/// At most one incomplete UTF-8 scalar per final visible stream.
#[derive(Debug, Default)]
struct PendingText {
	bytes:   [u8; 4],
	origins: [OutputOrigin; 4],
	len:     usize,
}

impl PendingText {
	const fn push(&mut self, byte: u8, origin: OutputOrigin) {
		self.bytes[self.len] = byte;
		self.origins[self.len] = origin;
		self.len += 1;
	}

	fn consume(&mut self, count: usize) {
		self.bytes.copy_within(count..self.len, 0);
		self.origins.copy_within(count..self.len, 0);
		self.len -= count;
	}
}

/// Maximum retained semantic/output entries.
pub const HISTORY_EVENTS: usize = 20_000;
/// Maximum retained output bytes, across all entries.
pub const HISTORY_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// Maximum retained payload bytes (semantic data and output combined).
pub const HISTORY_BYTES: usize = 8 * 1024 * 1024;

fn bounded(bytes: &[u8]) -> BString {
	text::cut(bytes, super::ARG_BYTES).into()
}
/// Maximum coalesced output entry, limiting a single replay step.
const OUTPUT_CHUNK: usize = 16 * 1024;

/// One replay entry. `t_ns` preserves measured engine/host deltas from
/// `RunStart`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEvent {
	/// Trace revision at this entry's most recent change.
	pub seq:            u64,
	/// Measured engine/host nanoseconds since `RunStart`, without estimated
	/// durations.
	pub t_ns:           u64,
	/// Engine event sequence; absent on output callbacks.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub event_seq:      Option<u64>,
	/// Actual segmented submission index, absent for a single session run.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub segment:        Option<u32>,
	/// This real root `RunEnd` is the finalized logical call boundary.
	#[serde(rename = "logicalEnd", skip_serializing_if = "std::ops::Not::not")]
	#[serde(default)]
	pub logical_end:    bool,
	/// Actual host completion status after segment output/close draining.
	#[serde(rename = "logicalStatus", skip_serializing_if = "Option::is_none")]
	pub logical_status: Option<i32>,
	/// Snapshot unit index; absent when the producer is unknown.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub u:              Option<u32>,
	/// Unit-local AST node id; absent when the producer is unknown.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub n:              Option<u32>,
	/// Precise execution identity, including repeated invocations of one node.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub command:        Option<CmdTag>,
	/// Actual emitting vproc; output lacks it only when no producer is known.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub vpid:           Option<Vpid>,
	/// Kind-specific replay payload.
	#[serde(flatten)]
	pub data:           HistoryData,
}

/// Exact byte provenance when one decoded scalar spans multiple producers.
/// Such an Output has no single primary u/n/command rather than guessing.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputContributor {
	/// Original callback timestamp, relative to the root `RunStart`.
	pub t_ns:    u64,
	/// Actual byte fragment (at most four bytes across all contributors).
	pub bytes:   Vec<u8>,
	/// Actual execution identity, absent only for shell-level output.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub command: Option<CmdTag>,
	/// Producer vproc, if known.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub vpid:    Option<Vpid>,
	/// Snapshot unit index, if known.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub u:       Option<u32>,
	/// Producer node, if known.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub n:       Option<u32>,
}

/// Owned, bounded copies of semantic event payloads.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum HistoryData {
	/// Run entered.
	RunStart,
	/// Run ended.
	RunEnd { status: i32 },
	/// Command entered.
	CmdStart,
	/// Expanded simple command.
	CmdExpanded {
		#[serde(serialize_with = "text::list")]
		argv:     Vec<BString>,
		#[serde(serialize_with = "text::pairs")]
		assigns:  Vec<(BString, BString)>,
		resolved: ResolvedKind,
		redirs:   Vec<RedirInfo>,
	},
	/// Command ended.
	CmdEnd { status: i32, dur_ns: u64, pipestatus: Vec<i32> },
	/// Pipeline entered.
	Pipeline,
	/// Branch decision.
	Branch { construct: Construct, taken: bool, status: i32 },
	/// Loop iteration and loop variable.
	IterStart {
		iteration: u32,
		#[serde(serialize_with = "text::bytes")]
		name:      BString,
		#[serde(serialize_with = "text::bytes")]
		value:     BString,
	},
	/// Loop completed.
	LoopEnd { iterations: u32 },
	/// Background job entered.
	Background { pid: u32 },
	/// Function entered.
	FuncEnter {
		#[serde(serialize_with = "text::bytes")]
		name: BString,
		#[serde(serialize_with = "text::list")]
		argv: Vec<BString>,
	},
	/// Function returned.
	FuncExit {
		#[serde(serialize_with = "text::bytes")]
		name:   BString,
		status: i32,
	},
	/// Variable assignment, with the engine's truncation metadata and scope.
	Assign {
		#[serde(serialize_with = "text::bytes")]
		name:     BString,
		#[serde(serialize_with = "text::bytes")]
		value:    BString,
		full_len: usize,
		scope:    AssignScope,
	},
	/// Successfully forwarded visible output.
	Output {
		#[serde(serialize_with = "text::bytes")]
		text:         BString,
		fd:           i32,
		#[serde(default, skip_serializing_if = "Vec::is_empty")]
		contributors: Vec<OutputContributor>,
	},
	/// Engine diagnostic.
	Diag {
		#[serde(serialize_with = "text::bytes")]
		text: BString,
	},
	/// Explicit shell exit.
	Exit { status: i32 },
	/// Errexit termination.
	ErrExit { status: i32 },
	/// External process started.
	Spawn {
		pid:  u32,
		#[serde(serialize_with = "text::list")]
		argv: Vec<BString>,
	},
}

impl HistoryData {
	pub(super) fn of(ev: &Event<'_>) -> Option<Self> {
		Some(match ev.data {
			EventData::RunStart { .. } => Self::RunStart,
			EventData::RunEnd { status } => Self::RunEnd { status },
			EventData::CmdStart { .. } => Self::CmdStart,
			EventData::CmdExpanded { argv, assigns, redirs, resolved } => Self::CmdExpanded {
				argv: argv.iter().take(ARG_ITEMS).map(cut).collect(),
				assigns: assigns
					.iter()
					.take(ARG_ITEMS)
					.map(|(k, v)| (cut(k), cut(v)))
					.collect(),
				redirs: redirs
					.iter()
					.take(ARG_ITEMS)
					.map(|r| RedirInfo { fd: r.fd, op: r.op, target: cut(&r.target) })
					.collect(),
				resolved,
			},
			EventData::CmdEnd { status, dur_ns, pipestatus } => Self::CmdEnd {
				status,
				dur_ns,
				pipestatus: pipestatus.iter().take(ARG_ITEMS).copied().collect(),
			},
			EventData::Pipeline { .. } => Self::Pipeline,
			EventData::Branch { construct, taken, status } => {
				Self::Branch { construct, taken, status }
			},
			EventData::IterStart { n, var, value } => {
				Self::IterStart { iteration: n, name: var.into(), value: bounded(value) }
			},
			EventData::LoopEnd { iterations } => Self::LoopEnd { iterations },
			EventData::Background { pid, .. } => Self::Background { pid: pid.0 },
			EventData::FuncEnter { name, args, .. } => Self::FuncEnter {
				name: name.into(),
				argv: args.iter().take(ARG_ITEMS).map(cut).collect(),
			},
			EventData::FuncExit { name, status } => Self::FuncExit { name: name.into(), status },
			EventData::Assign { name, value, full_len, scope } => {
				Self::Assign { name: name.into(), value: value.into(), full_len, scope }
			},
			EventData::Diag { message, .. } => Self::Diag { text: bounded(message) },
			EventData::Exit { status } => Self::Exit { status },
			EventData::ErrExit { status } => Self::ErrExit { status },
			EventData::Spawn { pid, argv } => {
				Self::Spawn { pid, argv: argv.iter().take(ARG_ITEMS).map(cut).collect() }
			},
			_ => return None,
		})
	}

	fn retained_bytes(&self) -> usize {
		let payload = match self {
			Self::CmdExpanded { argv, assigns, redirs, .. } => {
				argv.iter().map(|v| v.len()).sum::<usize>()
					+ assigns
						.iter()
						.map(|(k, v)| k.len() + v.len())
						.sum::<usize>()
					+ redirs.iter().map(|r| r.target.len()).sum::<usize>()
			},
			Self::FuncEnter { name, argv } => name.len() + argv.iter().map(|v| v.len()).sum::<usize>(),
			Self::Spawn { argv, .. } => argv.iter().map(|v| v.len()).sum(),
			Self::Assign { name, value, .. } | Self::IterStart { name, value, .. } => {
				name.len() + value.len()
			},
			Self::FuncExit { name, .. } => name.len(),
			Self::Output { text, contributors, .. } => {
				text.len()
					+ contributors
						.iter()
						.map(|entry| size_of::<OutputContributor>() + entry.bytes.len())
						.sum::<usize>()
			},
			Self::Diag { text } => text.len(),
			Self::CmdEnd { pipestatus, .. } => pipestatus.len() * size_of::<i32>(),
			_ => 0,
		};
		size_of::<HistoryEvent>() + payload
	}

	fn output_len(&self) -> usize {
		match self {
			Self::Output { text, .. } => text.len(),
			_ => 0,
		}
	}
}

#[derive(Debug, Default)]
pub(super) struct Journal {
	pub entries:    VecDeque<HistoryEvent>,
	pub truncated:  bool,
	output_bytes:   usize,
	retained_bytes: usize,
	producers:      HashMap<CmdTag, (u32, u32)>,
	producer_order: VecDeque<CmdTag>,
	pending_text:   HashMap<i32, PendingText>,
}

impl Journal {
	/// Exact CmdStart/CmdExpanded binding for this execution, never inferred.
	pub fn producer(&self, tag: CmdTag) -> Option<(u32, u32)> {
		self.producers.get(&tag).copied()
	}

	pub fn bind(&mut self, tag: CmdTag, u: u32, n: u32) {
		if self.producers.insert(tag, (u, n)).is_none() {
			self.producer_order.push_back(tag);
			if self.producer_order.len() > HISTORY_EVENTS
				&& let Some(old) = self.producer_order.pop_front()
			{
				self.producers.remove(&old);
			}
		}
	}

	pub fn push(&mut self, entry: HistoryEvent) {
		self.output_bytes += entry.data.output_len();
		self.retained_bytes += entry.data.retained_bytes();
		self.entries.push_back(entry);
		self.trim();
	}

	fn trim(&mut self) {
		while self.entries.len() > HISTORY_EVENTS
			|| self.output_bytes > HISTORY_OUTPUT_BYTES
			|| self.retained_bytes > HISTORY_BYTES
		{
			if let Some(old) = self.entries.pop_front() {
				self.output_bytes -= old.data.output_len();
				self.retained_bytes -= old.data.retained_bytes();
				self.truncated = true;
			}
		}
	}

	pub fn output(
		&mut self,
		seq: u64,
		t_ns: u64,
		tag: Option<CmdTag>,
		fd: i32,
		mut bytes: &[u8],
		segment: Option<u32>,
	) {
		let producer = tag.and_then(|command| self.producers.get(&command).copied());
		let origin = OutputOrigin {
			segment,
			command: tag,
			u: producer.map(|p| p.0),
			n: producer.map(|p| p.1),
			t_ns,
		};
		let mut pending = self.pending_text.remove(&fd).unwrap_or_default();
		loop {
			if pending.len != 0 {
				match std::str::from_utf8(&pending.bytes[..pending.len]) {
					Ok(_) => {
						self.output_pending(
							seq,
							t_ns,
							fd,
							&pending,
							pending.len,
							&pending.bytes[..pending.len],
						);
						pending.len = 0;
					},
					Err(error) if error.valid_up_to() != 0 => {
						let count = error.valid_up_to();
						self.output_pending(seq, t_ns, fd, &pending, count, &pending.bytes[..count]);
						pending.consume(count);
					},
					Err(error) => {
						if let Some(count) = error.error_len() {
							self.output_pending(seq, t_ns, fd, &pending, count, "\u{fffd}".as_bytes());
							pending.consume(count);
						} else if let Some((&byte, rest)) = bytes.split_first() {
							pending.push(byte, origin);
							bytes = rest;
						} else {
							break;
						}
					},
				}
				continue;
			}
			if bytes.is_empty() {
				break;
			}
			match std::str::from_utf8(bytes) {
				Ok(_) => {
					self.output_text(seq, t_ns, origin, fd, bytes, Vec::new());
					break;
				},
				Err(error) if error.valid_up_to() != 0 => {
					let count = error.valid_up_to();
					self.output_text(seq, t_ns, origin, fd, &bytes[..count], Vec::new());
					bytes = &bytes[count..];
				},
				Err(error) => {
					if let Some(count) = error.error_len() {
						self.output_text(seq, t_ns, origin, fd, "\u{fffd}".as_bytes(), Vec::new());
						bytes = &bytes[count..];
					} else {
						for &byte in bytes {
							pending.push(byte, origin);
						}
						bytes = &[];
					}
				},
			}
		}
		if pending.len != 0 {
			if self.pending_text.len() == HISTORY_EVENTS
				&& let Some(old) = self.pending_text.keys().next().copied()
			{
				self.pending_text.remove(&old);
				self.truncated = true;
			}
			self.pending_text.insert(fd, pending);
		}
	}

	/// Only a real final-stream EOF releases an incomplete final scalar.
	pub fn finish_output(&mut self, seq: u64, t_ns: u64, fd: i32) -> bool {
		let Some(pending) = self.pending_text.remove(&fd) else {
			return false;
		};
		if pending.len == 0 {
			return false;
		}
		self.output_pending(seq, t_ns, fd, &pending, pending.len, "\u{fffd}".as_bytes());
		true
	}

	fn output_pending(
		&mut self,
		seq: u64,
		t_ns: u64,
		fd: i32,
		pending: &PendingText,
		count: usize,
		text: &[u8],
	) {
		let first = pending.origins[0];
		if pending.origins[..count]
			.iter()
			.all(|origin| first.same_producer(*origin))
		{
			self.output_text(seq, t_ns, first, fd, text, Vec::new());
			return;
		}
		let mut contributors: Vec<OutputContributor> = Vec::new();
		for (&byte, &origin) in pending.bytes[..count].iter().zip(&pending.origins[..count]) {
			if let Some(last) = contributors.last_mut()
				&& last.command == origin.command
				&& last.u == origin.u
				&& last.n == origin.n
				&& last.t_ns == origin.t_ns
			{
				last.bytes.push(byte);
			} else {
				contributors.push(OutputContributor {
					t_ns:    origin.t_ns,
					bytes:   vec![byte],
					command: origin.command,
					vpid:    origin.command.map(|command| command.vpid),
					u:       origin.u,
					n:       origin.n,
				});
			}
		}
		self.output_text(
			seq,
			t_ns,
			OutputOrigin { segment: first.segment, ..OutputOrigin::default() },
			fd,
			text,
			contributors,
		);
	}

	fn output_text(
		&mut self,
		seq: u64,
		t_ns: u64,
		origin: OutputOrigin,
		fd: i32,
		mut bytes: &[u8],
		contributors: Vec<OutputContributor>,
	) {
		if !contributors.is_empty() {
			self.push(HistoryEvent {
				seq,
				t_ns,
				event_seq: None,
				segment: origin.segment,
				logical_end: false,
				logical_status: None,
				u: None,
				n: None,
				command: None,
				vpid: None,
				data: HistoryData::Output { text: bytes.into(), fd, contributors },
			});
			return;
		}
		while !bytes.is_empty() {
			let mut merged = 0;
			if let Some(last) = self.entries.back_mut()
				&& last.segment == origin.segment
				&& last.command == origin.command
				&& last.u == origin.u
				&& last.n == origin.n
				&& let HistoryData::Output { text, fd: previous_fd, contributors } = &mut last.data
				&& contributors.is_empty()
				&& *previous_fd == fd
				&& text.len() < OUTPUT_CHUNK
			{
				let mut count = bytes.len().min(OUTPUT_CHUNK - text.len());
				while count != 0 && count < bytes.len() && bytes[count] & 0xc0 == 0x80 {
					count -= 1;
				}
				if count != 0 {
					text.extend_from_slice(&bytes[..count]);
					self.output_bytes += count;
					self.retained_bytes += count;
					last.seq = seq;
					merged = count;
				}
			}
			if merged != 0 {
				bytes = &bytes[merged..];
				self.trim();
				continue;
			}
			let mut count = bytes.len().min(OUTPUT_CHUNK);
			while count < bytes.len() && bytes[count] & 0xc0 == 0x80 {
				count -= 1;
			}
			self.push(HistoryEvent {
				seq,
				t_ns,
				event_seq: None,
				segment: origin.segment,
				logical_end: false,
				logical_status: None,
				u: origin.u,
				n: origin.n,
				command: origin.command,
				vpid: origin.command.map(|command| command.vpid),
				data: HistoryData::Output { text: bytes[..count].into(), fd, contributors: Vec::new() },
			});
			bytes = &bytes[count..];
		}
	}
}
