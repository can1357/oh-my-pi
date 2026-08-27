//! Transcript v4's append-only event journal.
//!
//! Line zero is the identity header. Later records are either legacy single
//! events or committed event-group envelopes; indexes address the expanded
//! durable event order. A group becomes visible only when its whole canonical
//! newline-delimited envelope is present, so crash recovery exposes a prefix of
//! committed groups. Malformed legacy lines remain tombstones rather than being
//! dropped; otherwise every later reference would shift. Corrections and
//! navigation are later events, never edits to old bytes. Replay capsules
//! follow the complementary storage rule
//! that every byte exists in exactly one place: neutral data in blocks,
//! provider-only residue in capsules, and large payloads
//! in the content-addressed blob store.

pub mod block;
pub mod capsule;
pub mod codec;
pub mod event;
pub mod import;
pub mod msg;
pub mod patch;
mod raweq;
pub mod reader;
pub mod replay;
pub mod replica;
pub mod types;
pub mod writer;

pub use block::{Block, BlockKind, Replay};
pub use codec::{Error, Header, read_header, read_line, write_header, write_line};
pub use event::{
	ApprovalDecided, ApprovalReason, ApprovalTicketFiled, ChildLifecycleEntry, ChildSessionInit,
	ChildWorkspaceIdentity, Custom, EntryUndecodable, Event, HookOutcome, ItemRecord, JobRegistered,
	JobSettled, Kind, PolicyDecision, PromptRewriteCommit, PromptRewriteIntent, PromptRewriteStage,
	SnapcompactArchive, SupersededCompaction, ToolBatchAuthorized, TurnAbort, TurnInputItem,
	TurnInputRecord, TurnOptionsRecord, TurnReceipt, TurnStart,
};
pub use import::{
	ForeignFormat, ForeignImportError, ForeignImportReport, ForeignSessionInfo, ImportDiagnostic,
	ImportedEntry, ImportedTranscript, import_foreign_session, list_foreign_sessions,
	list_foreign_sessions_in, parse_foreign_jsonl,
};
pub use msg::{
	Content, MAX_PERSISTED_CHARS, Msg, PERSISTENCE_TRUNCATION_NOTICE, UserBlock,
	truncate_persisted_text,
};
pub use patch::Patch;
pub use reader::{
	DiagnosticKind, Entry, LiveLog, LiveSet, Log, ReadCounters, ReadDiagnostic, Reader,
	RefreshReport, RefreshState, VisitReport, load, load_live, visit_batched,
};
pub use types::*;
pub use writer::Writer;
