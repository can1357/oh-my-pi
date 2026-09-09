//! Environment-owned memory runtime lifecycle and reflection bridging.
//!
//! The host starts and registers the Off/Mnemopi runtime from the immutable
//! VCS snapshot it already owns, and exposes the late-bound bridge the memory
//! device uses to reach the client's inference authority. Prompt sampling and
//! extraction lanes live above the environment, in
//! the higher-level driver memory composition.

use std::{
	fmt,
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
};

use omp_agent::{PromptMemoryInput, PromptMemorySlotInput};
use omp_core::Str;
use omp_memory::{
	MemoryBackend, MemoryRuntime, RuntimeRegistry, config::MnemopiSettings, runtime::RuntimeStart,
	session::SessionMemory,
};
use omp_tools::memory::{ReflectionHost, ReflectionHostError};

use super::vcs::RepositorySnapshot;

/// Failure to bind the app inference authority more than once.
#[derive(Clone, Copy, Debug, thiserror::Error)]
pub enum ReflectionBindingError {
	/// A host was already installed for this environment generation.
	#[error("memory reflection host is already bound")]
	AlreadyBound,
}

/// Late-bound bridge from the environment memory device to Chat's inference
/// authority.
#[derive(Default)]
pub struct ReflectionBridgeHost {
	host: OnceLock<Arc<dyn ReflectionHost>>,
}

impl ReflectionBridgeHost {
	/// Creates an unbound bridge for immutable registry construction.
	pub const fn new() -> Self {
		Self { host: OnceLock::new() }
	}

	/// Installs the one app-owned reflection authority.
	pub fn bind(&self, host: Arc<dyn ReflectionHost>) -> Result<(), ReflectionBindingError> {
		self
			.host
			.set(host)
			.map_err(|_| ReflectionBindingError::AlreadyBound)
	}
}

#[async_trait::async_trait]
impl ReflectionHost for ReflectionBridgeHost {
	async fn reflect(
		&self,
		request: omp_tools::memory::ReflectionRequest,
	) -> Result<Str, ReflectionHostError> {
		let host = self.host.get().ok_or(ReflectionHostError::Unavailable)?;
		host.reflect(request).await
	}
}

impl fmt::Debug for ReflectionBridgeHost {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ReflectionBridgeHost")
			.field("bound", &self.host.get().is_some())
			.finish()
	}
}

/// Registered top-level memory runtime. Dropping it removes only the
/// contextless URL lookup; existing parent/subagent handles keep their shared
/// banks alive.
#[must_use]
pub struct RegisteredMemoryRuntime {
	session_id: Str,
	runtime:    Arc<MemoryRuntime>,
}

impl RegisteredMemoryRuntime {
	/// Borrows the live Off/Mnemopi runtime.
	pub const fn runtime(&self) -> &Arc<MemoryRuntime> {
		&self.runtime
	}

	/// Creates the top-level lifecycle handle shared with subagents.
	pub fn session(&self) -> SessionMemory {
		SessionMemory::top_level(Arc::clone(&self.runtime))
	}

	/// Freezes the runtime's bounded memory contributions into agent-owned
	/// prompt input.
	///
	/// # Errors
	///
	/// Fails when the runtime cannot read its active banks.
	pub fn prompt_snapshot(
		&self,
		compacted_memory: Option<&str>,
		recall_query: Option<&str>,
		token_budget: usize,
	) -> omp_memory::Result<PromptMemoryInput> {
		prompt_snapshot(self.runtime.as_ref(), compacted_memory, recall_query, token_budget)
	}
}

impl Drop for RegisteredMemoryRuntime {
	fn drop(&mut self) {
		RuntimeRegistry::unregister(self.session_id.as_str(), &self.runtime);
	}
}

/// Freezes one runtime's bounded memory slots into agent-owned prompt input.
///
/// # Errors
///
/// Fails when the runtime cannot read its active banks.
pub fn prompt_snapshot(
	runtime: &MemoryRuntime,
	compacted_memory: Option<&str>,
	recall_query: Option<&str>,
	token_budget: usize,
) -> omp_memory::Result<PromptMemoryInput> {
	let snapshot = runtime.prompt_snapshot(compacted_memory, recall_query, token_budget)?;
	Ok(PromptMemoryInput {
		memory:   PromptMemorySlotInput {
			generation: snapshot.memory.generation,
			content:    snapshot.memory.content,
		},
		standing: PromptMemorySlotInput {
			generation: snapshot.standing.generation,
			content:    snapshot.standing.content,
		},
		recall:   PromptMemorySlotInput {
			generation: snapshot.recall.generation,
			content:    snapshot.recall.content,
		},
	})
}

/// Constructs and registers one runtime from native settings and the
/// Environment's immutable VCS snapshot. Memory never probes Git:
/// `snapshot.primary_root` is the sole project-bank identity,
/// with the canonical workspace root used only when the snapshot says no
/// repository exists. `None` is accepted only for the effect-free Off backend.
///
/// # Errors
///
/// Fails when the durable bank cannot be opened for the selected backend.
pub fn start(
	backend: MemoryBackend,
	mnemopi: &MnemopiSettings,
	data_dir: &Path,
	session_id: impl Into<Str>,
	workspace_root: impl Into<PathBuf>,
	snapshot: Option<&RepositorySnapshot>,
) -> omp_memory::Result<RegisteredMemoryRuntime> {
	let session_id = session_id.into();
	let runtime = MemoryRuntime::start(RuntimeStart {
		session_id: session_id.clone(),
		data_dir: data_dir.join("memory"),
		workspace_root: workspace_root.into(),
		canonical_primary_root: snapshot.and_then(|snapshot| snapshot.primary_root.clone()),
		backend,
		mnemopi: mnemopi.clone(),
	})?;
	RuntimeRegistry::register(session_id.clone(), &runtime);
	Ok(RegisteredMemoryRuntime { session_id, runtime })
}
