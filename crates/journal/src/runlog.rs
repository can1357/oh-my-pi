//! The record vocabulary and writer of an ADW run journal (ADR 0051 S1 to S3).
//!
//! A run journal is a normal journal file whose vocabulary is widened with the
//! [`vocabulary`] kinds. The first record is always [`RunStart`]; every later
//! entry names the previous one in `by`, so the file is a linear chain, and a
//! finished run (a [`RunDone`] or [`RunHalt`] record) accepts nothing more.

use std::path::Path;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
	Entry, EntryDraft, EntryId, Journal, JournalError, Kind, KindError, Vocabulary,
	data::GENESIS_VERSION, idempotency::IdempotencyKey, kind::JOURNAL,
};

/// `adw.run.start@1`: the first record of a run journal.
pub const RUN_START: &str = "adw.run.start";
/// `adw.phase.dispatch@1`: a phase attempt was committed to run, before it
/// started.
pub const PHASE_DISPATCH: &str = "adw.phase.dispatch";
/// `adw.phase.settle@1`: a phase attempt finished and its result was decided.
pub const PHASE_SETTLE: &str = "adw.phase.settle";
/// `adw.phase.uncertain@1`: recovery found a dispatch with no settle.
pub const PHASE_UNCERTAIN: &str = "adw.phase.uncertain";
/// `adw.run.halt@1`: the run stopped without finishing.
pub const RUN_HALT: &str = "adw.run.halt";
/// `adw.run.done@1`: the run reached a terminal outcome.
pub const RUN_DONE: &str = "adw.run.done";

/// The kinds a run journal registers.
///
/// # Panics
///
/// Never in practice: every name is a valid constant and none is in the closed
/// set.
#[must_use]
pub fn vocabulary() -> Vocabulary {
	[RUN_START, PHASE_DISPATCH, PHASE_SETTLE, PHASE_UNCERTAIN, RUN_HALT, RUN_DONE]
		.into_iter()
		.fold(Vocabulary::builtin(), |vocabulary, name| {
			vocabulary
				.with(Kind::new(name, 1).expect("constant run kind names are valid"))
				.expect("run kinds are outside the closed set")
		})
}

/// Payload of `adw.run.start@1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunStart {
	/// The run id (a ULID).
	pub run:                 Str,
	/// The workflow name.
	pub workflow:            Str,
	/// Digest of the workflow definition; resume refuses a different one.
	pub workflow_digest:     Str,
	/// Digest of the run's inputs (the empty-string digest in v1).
	pub input_digest:        Str,
	/// The per-phase attempt budget.
	pub max_attempts:        u32,
	/// The model selector the run was started with.
	pub model:               Str,
	/// Whether the operator passed the model explicitly.
	pub model_explicit:      bool,
	/// The execution policy for code phases.
	pub exec_policy:         Str,
	/// Whether a remote code phase may fall back to local execution.
	pub exec_fallback_local: bool,
	/// Whether the workspace was trusted when the run started.
	pub workspace_trusted:   bool,
	/// Canonical project root.
	pub workspace_root:      Str,
	/// Git HEAD of the root, when it is a work tree.
	pub workspace_head:      Option<Str>,
	/// Creation time in the controller's canonical representation.
	pub created:             Str,
}

/// An input version a dispatched attempt consumed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputVersion {
	/// The producing phase.
	pub phase:   Str,
	/// The accepted version of its output.
	pub version: u32,
}

/// An external effect a dispatched attempt may perform, with its idempotency
/// key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectKey {
	/// The effect name, for example `pr.create`.
	pub effect: Str,
	/// The key that makes the effect safe to retry or reconcile.
	pub key:    IdempotencyKey,
}

/// Payload of `adw.phase.dispatch@1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhaseDispatch {
	/// The phase.
	pub phase:    Str,
	/// The 1-based attempt ordinal.
	pub attempt:  u32,
	/// The input versions the attempt consumed.
	pub inputs:   Vec<InputVersion>,
	/// The executor assigned: `native` or a delegated executor id.
	pub executor: Str,
	/// The posture the host resolved for this phase, as its kebab-case scopes.
	pub posture:  Str,
	/// The effects the attempt may perform, with their keys.
	pub effects:  Vec<EffectKey>,
}

/// How a phase attempt ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettleStatus {
	/// The phase met its acceptance condition.
	Accepted,
	/// The phase completed but did not meet it.
	Rejected,
	/// The phase's host stopped before it produced a result.
	Failed,
}

/// Payload of `adw.phase.settle@1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhaseSettle {
	/// The phase.
	pub phase:       Str,
	/// The attempt ordinal.
	pub attempt:     u32,
	/// How the attempt ended.
	pub status:      SettleStatus,
	/// Verbatim feedback of a rejection; empty otherwise.
	pub feedback:    Str,
	/// Verdict decision recorded by the judge (e.g. "accept", "reject",
	/// "needs-human"). Absent when the settle was created before verdict
	/// tracking was added.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub verdict:     Option<Str>,
	/// Whether the judge route differs from the producer route (independent
	/// review). Absent when not applicable.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub independent: Option<bool>,
}

/// Payload of `adw.phase.uncertain@1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhaseUncertain {
	/// The phase.
	pub phase:   Str,
	/// The attempt ordinal.
	pub attempt: u32,
	/// Why recovery could not decide the attempt.
	pub reason:  Str,
}

/// Payload of `adw.run.halt@1`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunHalt {
	/// Why the run stopped. A halted run can be resumed (ADR 0051 R6).
	pub reason: Str,
}

/// Payload of `adw.run.done@1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunDone {
	/// Whether every phase was accepted.
	pub accepted: bool,
}

/// One record of a run journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunRecord {
	/// The run began.
	Start(RunStart),
	/// An attempt was committed to run.
	Dispatch(PhaseDispatch),
	/// An attempt finished.
	Settle(PhaseSettle),
	/// Recovery could not decide an attempt.
	Uncertain(PhaseUncertain),
	/// The run stopped without finishing; resume may continue it.
	Halt(RunHalt),
	/// The run reached a terminal outcome.
	Done(RunDone),
}

impl RunRecord {
	/// The journal kind and single-line JSON payload of this record.
	///
	/// # Errors
	///
	/// [`RunLogError::Json`] when the payload cannot be serialized.
	pub fn encode(&self) -> Result<(Kind, Str), RunLogError> {
		let (name, json) = match self {
			Self::Start(payload) => (RUN_START, serde_json::to_string(payload)?),
			Self::Dispatch(payload) => (PHASE_DISPATCH, serde_json::to_string(payload)?),
			Self::Settle(payload) => (PHASE_SETTLE, serde_json::to_string(payload)?),
			Self::Uncertain(payload) => (PHASE_UNCERTAIN, serde_json::to_string(payload)?),
			Self::Halt(payload) => (RUN_HALT, serde_json::to_string(payload)?),
			Self::Done(payload) => (RUN_DONE, serde_json::to_string(payload)?),
		};
		Ok((Kind::new(name, 1)?, Str::new(json)))
	}

	/// Reads one journal entry as a run record.
	///
	/// # Errors
	///
	/// [`RunLogError::UnexpectedKind`] for a kind that is not a run record, and
	/// [`RunLogError::Json`] for a payload that does not parse.
	pub fn decode(entry: &Entry) -> Result<Self, RunLogError> {
		let data = entry.data.as_str();
		Ok(match entry.kind.name.as_str() {
			RUN_START => Self::Start(serde_json::from_str(data)?),
			PHASE_DISPATCH => Self::Dispatch(serde_json::from_str(data)?),
			PHASE_SETTLE => Self::Settle(serde_json::from_str(data)?),
			PHASE_UNCERTAIN => Self::Uncertain(serde_json::from_str(data)?),
			RUN_HALT => Self::Halt(serde_json::from_str(data)?),
			RUN_DONE => Self::Done(serde_json::from_str(data)?),
			_ => return Err(RunLogError::UnexpectedKind { kind: entry.kind.clone() }),
		})
	}

	/// Whether this record ends the run for good.
	///
	/// Only [`RunRecord::Done`] does: a halt (cancellation, a failed host,
	/// a blocked phase) leaves the run resumable (ADR 0051 R6).
	#[must_use]
	pub const fn is_terminal(&self) -> bool {
		matches!(self, Self::Done(_))
	}
}

/// Why a run journal could not be created, read or extended.
#[derive(Debug, Error)]
pub enum RunLogError {
	/// The underlying journal failed.
	#[error("run journal failed")]
	Journal(#[from] JournalError),
	/// A record kind name was invalid.
	#[error("run record kind is invalid")]
	Kind(#[from] KindError),
	/// A record payload did not serialize or parse.
	#[error("run record payload is invalid")]
	Json(#[from] serde_json::Error),
	/// An entry is not a run record.
	#[error("entry kind {kind} is not a run record")]
	UnexpectedKind {
		/// The offending kind.
		kind: Kind,
	},
	/// The first record is not [`RunStart`], or the journal is empty.
	#[error("a run journal must begin with a start record")]
	MissingStart,
	/// Resume was asked for a different workflow definition than the run
	/// recorded.
	#[error("workflow digest differs: the run recorded {recorded}, resume has {expected}")]
	DigestMismatch {
		/// The digest in the journal.
		recorded: Str,
		/// The digest the caller holds.
		expected: Str,
	},
	/// A record was appended after the run finished.
	#[error("the run is finished and accepts no more records")]
	Finished,
}

/// A run journal open for appending.
#[derive(Debug)]
pub struct RunLog {
	journal:  Journal,
	last:     EntryId,
	finished: bool,
}

impl RunLog {
	/// Creates a run journal at `path` holding the genesis and `start`.
	///
	/// # Errors
	///
	/// [`RunLogError`] when the file exists or a record cannot be written.
	pub fn create(path: impl AsRef<Path>, start: RunStart) -> Result<Self, RunLogError> {
		let mut journal = Journal::create_with(path, vocabulary())?;
		let genesis = serde_json::to_string(&crate::data::Genesis {
			version: GENESIS_VERSION,
			cwd:     start.workspace_root.clone(),
			created: start.created.clone(),
		})?;
		let genesis = journal.append(EntryDraft {
			kind:  Kind::new(JOURNAL, 1)?,
			by:    None,
			prior: None,
			label: None,
			data:  Str::new(genesis),
		})?;
		let mut log = Self { journal, last: genesis.id, finished: false };
		log.append(&RunRecord::Start(start))?;
		Ok(log)
	}

	/// Opens an existing run journal for appending and returns its records.
	///
	/// Refuses a journal that does not begin with a start record, and one whose
	/// recorded workflow digest differs from `expected_digest`.
	///
	/// # Errors
	///
	/// [`RunLogError`] as described above, or when the journal cannot be opened.
	pub fn open(
		path: impl AsRef<Path>,
		expected_digest: &str,
	) -> Result<(Self, Vec<RunRecord>), RunLogError> {
		let (journal, entries) = Journal::open_with(path, vocabulary())?;
		let records = decode_records(&entries)?;
		check_start(&records, expected_digest)?;
		let last = entries
			.last()
			.map(|entry| entry.id)
			.ok_or(RunLogError::MissingStart)?;
		let finished = records.last().is_some_and(RunRecord::is_terminal);
		Ok((Self { journal, last, finished }, records))
	}

	/// Reads a run journal without locking it or truncating a torn tail.
	///
	/// # Errors
	///
	/// [`RunLogError`] when the journal cannot be read or holds a non-run
	/// record.
	pub fn read(path: impl AsRef<Path>) -> Result<Vec<RunRecord>, RunLogError> {
		decode_records(&Journal::scan_with(path, &vocabulary())?)
	}

	/// Appends one record, chained to the previous entry.
	///
	/// # Errors
	///
	/// [`RunLogError::Finished`] after a terminal record, or a journal failure.
	pub fn append(&mut self, record: &RunRecord) -> Result<EntryId, RunLogError> {
		if self.finished {
			return Err(RunLogError::Finished);
		}
		let (kind, data) = record.encode()?;
		let entry = self.journal.append(EntryDraft {
			kind,
			by: Some(self.last),
			prior: None,
			label: None,
			data,
		})?;
		self.last = entry.id;
		self.finished = record.is_terminal();
		Ok(entry.id)
	}
}

fn decode_records(entries: &[Entry]) -> Result<Vec<RunRecord>, RunLogError> {
	entries
		.iter()
		.filter(|entry| !(entry.kind.name.as_str() == JOURNAL && entry.kind.rev == 1))
		.map(RunRecord::decode)
		.collect()
}

fn check_start(records: &[RunRecord], expected_digest: &str) -> Result<(), RunLogError> {
	let Some(RunRecord::Start(start)) = records.first() else {
		return Err(RunLogError::MissingStart);
	};
	if start.workflow_digest.as_str() != expected_digest {
		return Err(RunLogError::DigestMismatch {
			recorded: start.workflow_digest.clone(),
			expected: Str::new(expected_digest),
		});
	}
	Ok(())
}
