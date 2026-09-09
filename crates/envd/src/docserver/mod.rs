//! Local document authority for an OMP Environment.
//!
//! This module owns the domain model used by filesystem, revision, transaction,
//! watch, and language-server components. Runtime components are exposed only
//! once they have complete implementations.

mod actor;
/// Client-side terminal stream primitives for document protocol consumers.
pub mod client;
/// Concurrent framed protocol connections over a shared Environment.
pub mod connection;
/// Long-lived document authority over standard I/O or a Unix-domain socket.
pub mod daemon;
/// Project-scoped Debug Adapter Protocol registry and selection.
pub mod dap_adapter;
/// Native DAP configuration discovery and provenance-preserving merge.
pub mod dap_config;
/// Bounded framed Debug Adapter Protocol transport engine.
pub mod dap_protocol;
/// Debug session lifecycle, trees, actions, and env-side tiers.
pub mod dap_session;
/// LSP push/pull diagnostic parsing and document-authority filtering.
pub mod diagnostics;
/// New-and-changed-only diagnostic delivery state.
pub mod diagnostics_ledger;
/// Session-scoped lowering of opaque edit-format proposals.
pub mod edit_adapter;
/// Project-scoped authority and connection-local sessions.
pub mod environment;
mod error;
/// Per-document formatting option resolution.
pub mod format_options;
/// Portable Environment filesystem value types.
pub mod fs;
/// Ordered LSP lifecycle, synchronization, and passthrough primitives.
pub mod lsp;
/// Transactional lowering for server-initiated workspace edit requests.
pub mod lsp_apply_edit;
/// Environment-owned executable planning for language servers.
pub mod lsp_binary;
/// Native LSP catalog discovery, validation, merging, and provenance.
pub mod lsp_config;
/// Per-server/workspace singleton client cache and crash backoff.
pub mod lsp_pool;
/// Bounded child-process JSON-RPC transport and production LSP binding startup.
pub mod lsp_process;
/// Project-scoped language-server registry and document synchronization.
pub mod lsp_registry;
/// Workspace-scoped native language-server discovery, startup, and status.
pub mod lsp_supervisor;
/// Actor-aware Environment path operations.
pub mod path_ops;
/// Checked LSP position encoding and text-edit conversion.
pub mod position;
mod protocol;
mod rebase;
/// Compact structural summaries of document content.
pub mod summary;
/// Revision-aware document transaction planning and application.
pub mod transaction;
mod types;
mod watch;
/// Windows owner-only named-pipe transport.
#[cfg(windows)]
pub mod windows;
/// Bounded length-delimited protobuf transport framing.
pub mod wire;
pub use actor::{
	ContentSlice, DocumentEvent, DocumentEventKind, DocumentLocator, DocumentStore, OpenedDocument,
	ReadBody, ReadResult, ReadSelection,
};
pub use dap_adapter::{
	DapAdapterError, DapAdapterId, DapAdapterInfo, DapAdapterRegistry, DapAdapterSpec, DapTransport,
	LaunchAdapterSelection,
};
pub use dap_protocol::{DapInbound, DapProtocol, DapProtocolError, SpawnedDap};
pub use dap_session::{
	DapAction, DapApprovalTier, DapReverseRequestHandler, DapSession, DapSessionError,
	DapSessionRegistry, DapSessionState, DapStopSnapshot,
};
pub use edit_adapter::{
	EditAdapterRegistry, HASHLINE_EDIT_FORMAT, REPLACE_EDIT_FORMAT, TextEditAdapter,
};
pub use environment::{
	Environment, EnvironmentSession, WorkspaceLeaseConflict, WorkspaceLeaseId, WorkspaceLeaseOutcome,
};
pub use error::{Error, RangeKind, Result};
pub use fs::{
	CopyOutcome, DestinationOverwritePolicy, DirectoryEntry, ExistingDirectoryPolicy, FileKind,
	FollowSymlinks, PathMetadata, PortablePermissions, SymlinkTarget, SymlinkTargetForm,
	SymlinkTargetKind,
};
pub use lsp_apply_edit::ApplyWorkspaceEditError;
pub use lsp_process::{
	InboundDispatch, LspPostResponse, LspProcess, LspProcessConfig, LspProcessError,
	LspProcessSelectorConfig, LspTransportSettings, load_lsp_process_configs,
};
pub use lsp_supervisor::{
	LspServerState, LspServerStatusView, NativeLspOptions, NativeLspSupervisor,
};
pub use path_ops::{PathMutationResult, PathService};
pub use rebase::{
	AppliedEdits, ByteEdit, RebaseConflict, apply_edits, canonical_edits, rebase_content,
	rebase_edits, validate_edits,
};
pub use types::{
	AuthorityLock, ByteRange, DocumentHead, DocumentId, DocumentKind, DocumentPresence,
	DocumentSnapshot, EquivalentUriMap, FileFingerprint, FileMetadata, FileUriKey, LanguageId,
	LeaseId, LineRange, Revision, ServerConfig, TransactionId,
};
pub use watch::{ActiveFileWatch, FileWatchEvent, FileWatchKind, classify_event};
