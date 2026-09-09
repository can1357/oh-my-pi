//! Typed client boundary for the `omp.env.v1` environment protocol.
//!
//! The crate correlates requests and streams server events over decoded frame
//! channels. It intentionally contains no filesystem, process, document,
//! workspace, blob-store, or tool-host implementation: those resources live
//! behind the environment service in both in-process and remote deployments.

mod admit;
pub mod build_id;
mod bundle;
mod client;
mod guard;
pub mod partition;
pub mod project_state;
#[cfg(windows)]
pub mod windows;

pub use admit::Admitter;
pub use bundle::{
	AirgapBundle, BundleEntry, BundleError, BundleFile, BundleManifest, pack_bundle, pull_bundle,
	push_bundle, unpack_bundle,
};
pub use client::{
	AcpRequest, ActiveExecControl, BlobDownload, BlobDownloadEvent, BlobUpload, ClientError,
	DapStream, DapStreamEvent, DataScope, DataStream, DataStreamItem, DocumentEvents, DocumentLease,
	DocumentRead, EnvClient, ExecEvent, ExecRun, ExtensionEnvClient, InProcessEnvTransport,
	Invocation, InvocationEvent, InvocationGrant, InvocationPrincipal, LspEvents, LspStreamEvent,
	McpSubscription, McpSubscriptionEvent, ProcessAttachment, ProcessAttachmentEvent, RequestStream,
	ResourceCompletionEvent, ResourceCompletionStream, ResumableBlobTransfer, SearchEvent,
	SearchStream, StreamLost, TransactionId, TransactionOutcome, VerifiedBlobTransfer, WalkEvent,
	WalkStream, WorkerEnvClient,
};
pub use guard::{RunGuard, WorkerLease};
/// Generated blob protocol messages accepted by scoped blob operations.
pub use omp_proto::blob::v1 as blob_frame;
/// Generated document protocol messages accepted by DATA document operations.
pub use omp_proto::document::v1 as document_frame;
/// Generated `omp.env.v1` wire frames used at transport boundaries.
pub use omp_proto::env::v1 as frame;
/// Protobuf codec trait used by UDS framing consumers.
pub use omp_proto::prost;
pub use partition::{FramePipe, PartitionError, PartitionedEnvTransport, in_process_frames};
/// Wire schema revision required by extension-host requests.
pub const SCHEMA_REV: u32 = omp_proto::SCHEMA_REV;
