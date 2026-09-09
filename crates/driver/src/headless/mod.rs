//! Journal-first non-interactive session assembly shared by app modes.

pub mod ask;
mod file_mentions;
pub mod gateway;
mod goal;
pub mod kernel;
mod todo;

pub use ask::{AskReply, AskRoute};
pub use kernel::{KernelOptions, compose_kernel};
use omp_core::Str;

/// Typed failure while composing a journal-first headless session.
#[derive(Debug, thiserror::Error)]
pub enum HeadlessError {
	/// Filesystem state could not be prepared or inspected.
	#[error("headless session filesystem operation failed")]
	Io(#[from] std::io::Error),
	/// The project environment could not attach.
	#[error("project environment attachment failed")]
	Environment(#[from] omp_envd::EnvdError),
	/// Frozen Python extension registrations were invalid.
	#[error("Python extension registration failed")]
	PythonExtension(#[from] omp_envd::exthost::PyExtensionError),
	/// An invocation extension setting override was invalid.
	#[error("extension setting override failed")]
	ExtensionSetting(#[from] omp_ext::ExtensionError),
	/// Native Python extension discovery or admission failed.
	#[error("native extension admission failed")]
	NativeExtension(#[from] crate::discovery::native::NativeExtensionError),
	/// The user configuration root could not be resolved.
	#[error("user configuration root could not be resolved")]
	ConfigRoot(#[from] omp_core::dirs::DataDirError),
	/// Catalog, inference, or credential composition failed.
	#[error("production inference composition failed")]
	Registry(#[from] crate::registry::RegistryError),
	/// The environment tool bridge already had a different inference owner.
	#[error("environment inference binding failed")]
	InferenceBridge(#[from] crate::bridges::InferenceBridgeError),
	/// The authenticated eval parent could not be bound.
	#[error("eval parent binding failed")]
	EvalParent(#[from] omp_envd::eval::BridgeHostError),
	/// A child-specific yield schema could not be compiled.
	#[error("child yield schema composition failed")]
	YieldSchema(#[from] omp_tools::yield_tool::SchemaContractError),
	/// A child-specific yield tool could not be installed.
	#[error("child yield registry composition failed")]
	YieldRegistry(#[from] omp_tool::RegistryError),
	/// Journal-backed session creation or replay failed.
	#[error("session journal operation failed")]
	Session(#[from] omp_session::SessionError),
	/// Artifact storage could not be opened.
	#[error("artifact storage operation failed")]
	Blob(#[from] omp_journal::blob::Error),
	/// `sv_interrupt_grace` does not fit the platform timer.
	#[error("configured interrupt grace is not representable")]
	InterruptGrace(#[from] omp_core::DurationError),
	/// The requested model selector was not present in the catalog.
	#[error("unknown model `{selector}`")]
	UnknownModel {
		/// Requested selector.
		selector: Str,
	},
	/// Continue mode found no durable session for the project.
	#[error("no durable headless session exists for this project")]
	NoSession,
	/// A child composition lost its authenticated parent endpoint.
	#[error("parent session `{parent}` is not live")]
	ParentSessionUnavailable {
		/// Stable id or routing name supplied by the spawning host.
		parent: Str,
	},
}
