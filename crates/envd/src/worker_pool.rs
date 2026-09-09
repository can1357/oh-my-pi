//! Named-worker supervision and generation-fenced worker DATA transport.

use std::{
	collections::BTreeMap,
	io::Read,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use async_trait::async_trait;
use flume::{Receiver, Sender};
use omp_core::{CowBytes, Str, encoding::hex};
use omp_env::WorkerLease;
use omp_journal::blob::{self, BlobStage, BlobStore};
use omp_proto::{env::v1::WorkerData, thread::v1};
use omp_tools::edit::SnapshotFault;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{
	blobs::{BlobError, BlobHost},
	exthost::control::{
		ControlAuthority, ControlConnectionIdentity, ControlEffect, ControlProtocolError,
		ControlRequestContext,
	},
};

/// Largest tunnel header accepted before any buffer allocation.
pub const MAX_TUNNEL_HEADER_BYTES: usize = 64 * 1024;
/// Largest number of out-of-band buffers accepted in one tunnel frame.
pub const MAX_TUNNEL_BUFFERS: usize = 64;
/// Largest individual tunnel buffer accepted by the supervisor.
pub const MAX_TUNNEL_BUFFER_BYTES: usize = 256 * 1024;
/// Production per-layer live named-worker ceiling.
pub const DEFAULT_WORKER_LAYER_CEILING: u64 = 8;
/// Production concurrent named-worker spawn ceiling.
pub const DEFAULT_MAX_CONCURRENT_SPAWNS: u64 = 4;

/// A decoded worker tunnel frame that preserves its received byte ownership.
#[derive(Clone)]
pub struct TunnelFrame {
	/// Encoded protocol header, never rebuilt by the tunnel.
	pub header:  CowBytes<'static>,
	/// Out-of-band buffers referenced by the header.
	pub buffers: Vec<CowBytes<'static>>,
}

/// Worker transport framing failure.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum TunnelError {
	/// The header length exceeded the fixed pre-allocation limit.
	#[error("worker tunnel header exceeds {MAX_TUNNEL_HEADER_BYTES} bytes")]
	HeaderTooLarge,
	/// The out-of-band buffer count exceeded the fixed pre-allocation limit.
	#[error("worker tunnel has more than {MAX_TUNNEL_BUFFERS} buffers")]
	TooManyBuffers,
	/// A buffer length exceeded the fixed pre-allocation limit.
	#[error("worker tunnel buffer exceeds {MAX_TUNNEL_BUFFER_BYTES} bytes")]
	BufferTooLarge,
	/// The transport ended before a complete frame arrived.
	#[error("worker tunnel frame is truncated")]
	Truncated,
}

impl TunnelFrame {
	/// Decodes a bounded tunnel frame without allocating from untrusted lengths.
	///
	/// The frame is `hlen:u32`, `nbufs:u16`, header bytes, then repeated
	/// `len:u32, bytes` buffers. Bounds are checked before reserving or copying.
	pub fn decode(data: CowBytes<'static>) -> Result<Self, TunnelError> {
		let bytes = &*data;
		if bytes.len() < 6 {
			return Err(TunnelError::Truncated);
		}
		let header_len = usize::try_from(u32::from_be_bytes(bytes[..4].try_into().expect("length")))
			.expect("u32 always fits usize on supported targets");
		let buffer_count = usize::from(u16::from_be_bytes(bytes[4..6].try_into().expect("count")));
		if header_len > MAX_TUNNEL_HEADER_BYTES {
			return Err(TunnelError::HeaderTooLarge);
		}
		if buffer_count > MAX_TUNNEL_BUFFERS {
			return Err(TunnelError::TooManyBuffers);
		}
		let mut offset = 6usize
			.checked_add(header_len)
			.ok_or(TunnelError::Truncated)?;
		if offset > bytes.len() {
			return Err(TunnelError::Truncated);
		}
		let header = CowBytes::owned(bytes::Bytes::copy_from_slice(&bytes[6..offset]));
		let mut buffers = Vec::with_capacity(buffer_count);
		for _ in 0..buffer_count {
			let length_end = offset.checked_add(4).ok_or(TunnelError::Truncated)?;
			let length = bytes
				.get(offset..length_end)
				.ok_or(TunnelError::Truncated)?;
			let length = usize::try_from(u32::from_be_bytes(length.try_into().expect("length")))
				.expect("u32 always fits usize on supported targets");
			if length > MAX_TUNNEL_BUFFER_BYTES {
				return Err(TunnelError::BufferTooLarge);
			}
			offset = length_end;
			let end = offset.checked_add(length).ok_or(TunnelError::Truncated)?;
			let buffer = bytes.get(offset..end).ok_or(TunnelError::Truncated)?;
			buffers.push(CowBytes::owned(bytes::Bytes::copy_from_slice(buffer)));
			offset = end;
		}
		if offset != bytes.len() {
			return Err(TunnelError::Truncated);
		}

		Ok(Self { header, buffers })
	}
}
/// The sole environment-side minting authority for spilled worker payloads.
///
/// Remote-frame diversion uses [`Self::put_reader`]; streamed verdicts use
/// [`Self::begin_verdict`] and [`Self::finish_verdict`]. Both paths delegate to
/// the same [`BlobHost`] authority.
#[derive(Clone, Debug)]
pub struct SpillDiverter {
	host: BlobHost,
}

/// A value that can spill a verdict through the environment blob authority.
pub trait VerdictSpill {
	/// Stores an out-of-band verdict payload and returns a hash-only wire blob.
	///
	/// # Errors
	/// Returns the blob-store error if durable placement fails.
	fn spill_verdict(&self, reader: impl Read) -> Result<v1::Blob, blob::Error>;
}

impl SpillDiverter {
	/// Binds the diverter to the Environment's unique blob store.
	pub const fn new(host: BlobHost) -> Self {
		Self { host }
	}

	/// Opens the single staged writer used for an incremental worker verdict.
	///
	/// # Errors
	/// Returns the blob-host error if the temporary stage cannot be created.
	pub fn begin_verdict(&self) -> Result<BlobStage, BlobError> {
		self.host.begin_worker_verdict()
	}

	/// Finishes a staged worker verdict and returns its hash-only wire identity.
	///
	/// # Errors
	/// Returns the blob-host error if synchronization, retention, or atomic
	/// placement fails.
	pub fn finish_verdict(&self, stage: BlobStage) -> Result<v1::Blob, BlobError> {
		let id = self.host.finish_worker_verdict(stage)?;
		Ok(v1::Blob { hash: id.hash.to_vec().into(), size: id.size, ..v1::Blob::default() })
	}

	/// Borrows the underlying store for validation reads after staged placement.
	pub(crate) fn store(&self) -> &BlobStore {
		self.host.worker_verdict_store()
	}

	/// Streams one out-of-band buffer into the blob store without rebuilding it.
	///
	/// # Errors
	/// Returns the blob-store error if durable placement fails.
	pub fn put_reader(&self, reader: impl Read) -> Result<v1::Blob, blob::Error> {
		let reference = self.host.store().put_reader(reader)?;
		Ok(v1::Blob {
			hash: reference.hash.as_bytes().to_vec().into(),
			size: reference.size,
			..v1::Blob::default()
		})
	}
}

impl omp_tools::edit::EditSnapshotStore for SpillDiverter {
	async fn store_snapshot(&self, bytes: bytes::Bytes) -> Result<omp_tool::BlobRef, SnapshotFault> {
		let blob = self
			.put_reader(bytes.as_ref())
			.map_err(|_| SnapshotFault::Store)?;
		let hash: &[u8; 32] = blob
			.hash
			.as_ref()
			.try_into()
			.map_err(|_| SnapshotFault::Store)?;
		Ok(omp_tool::BlobRef {
			hash:       Str::from(hex::encode_n(hash).as_str()),
			media_type: Str::new_static("application/octet-stream"),
			byte_len:   blob.size,
		})
	}
}

impl VerdictSpill for SpillDiverter {
	fn spill_verdict(&self, reader: impl Read) -> Result<v1::Blob, blob::Error> {
		self.put_reader(reader)
	}
}

/// A named worker key. Environment placement is deliberately included so a
/// moved device cannot retain the identity of its former worker.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct WorkerKey {
	/// Extension owning the worker.
	pub extension: Str,
	/// Declared worker name.
	pub name:      Str,
	/// Resolved placement site identity.
	pub site:      Str,
}

/// Supervisor failures exposed to worker routing.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum WorkerUnavailable {
	/// The per-layer live-worker ceiling refused an immediate spawn.
	#[error("worker unavailable: layer live-worker ceiling reached")]
	LayerCeiling,
	/// The global concurrent-spawn ceiling refused an immediate spawn.
	#[error("worker unavailable: concurrent spawn ceiling reached")]
	SpawnCeiling,
	/// A generation-fenced request targeted a retired worker.
	#[error("worker unavailable: stale generation")]
	StaleGeneration,
}

/// One worker selected for dispatch.
#[derive(Clone, Debug)]
pub struct WorkerRoute {
	/// Stable worker identity including placement site.
	pub key:        WorkerKey,
	/// Current generation, which fences every DATA frame.
	pub generation: u64,
}

/// A non-streaming placed-device dispatch admitted to one worker generation.
#[derive(Clone, Debug)]
pub struct WorkerDispatch {
	/// The generation that owns this call.
	pub route:    WorkerRoute,
	/// Final arguments delivered without extension-host reserialization.
	pub args:     bytes::Bytes,
	/// Supervisor-enforced execution deadline.
	pub deadline: Duration,
}

/// One DATA frame accepted at the sole generation-fencing demultiplex point.
#[derive(Clone)]
pub struct AcceptedWorkerData {
	/// Worker identity.
	pub route:   WorkerRoute,
	/// Protocol/stderr channel selected by the worker.
	pub channel: u32,
	/// Payload ownership without a parse-and-rebuild pass.
	pub data:    CowBytes<'static>,
}

/// Named-worker actor commands. Data uses a bounded lane; lifecycle uses the
/// unbounded lease lane so cancellation cannot be blocked behind payload bytes.
#[derive(Debug)]
pub enum WorkerCommand {
	/// Open or coalesce a worker route.
	Open(WorkerKey),
	/// Send a bounded DATA frame to the named-worker demultiplexer.
	Data(WorkerData),
	/// Stop exactly one generation.
	Terminate {
		/// Supervised worker name.
		name:       Str,
		/// Generation whose processes are terminated.
		generation: u64,
	},
}
/// Exponential restart scheduling with the required healthy-uptime reset.
#[derive(Clone, Debug)]
pub struct RestartBackoff {
	next:      Duration,
	maximum:   Duration,
	healthy:   Duration,
	last_boot: Instant,
}

impl RestartBackoff {
	/// Starts a one-second to thirty-second restart schedule.
	pub fn new() -> Self {
		Self {
			next:      Duration::from_secs(1),
			maximum:   Duration::from_secs(30),
			healthy:   Duration::from_secs(30),
			last_boot: Instant::now(),
		}
	}

	/// Records a failure and returns the delay before its replacement spawn.
	pub fn failed(&mut self) -> Duration {
		if self.last_boot.elapsed() >= self.healthy {
			self.next = Duration::from_secs(1);
		}
		let delay = self.next;
		self.next = self.next.saturating_mul(2).min(self.maximum);
		delay
	}

	/// Starts the healthy-uptime window for a replacement generation.
	pub fn booted(&mut self) {
		self.last_boot = Instant::now();
	}
}

impl Default for RestartBackoff {
	fn default() -> Self {
		Self::new()
	}
}

/// In-process named-worker routing state.
#[derive(Debug)]
pub struct WorkerSupervisor {
	workers:         Mutex<BTreeMap<Str, WorkerRoute>>,
	processes:       Mutex<BTreeMap<(Str, u64), SupervisedWorkerProcess>>,
	process_changed: Notify,
	layer_live:      AtomicU64,
	layer_ceiling:   u64,
	spawn_live:      AtomicU64,
	spawn_ceiling:   u64,
	stale_frames:    AtomicU64,
	terminate_tx:    Sender<(Str, u64)>,
	terminate_rx:    Receiver<(Str, u64)>,
}

impl WorkerSupervisor {
	/// Creates a supervisor with immediate-refusal worker and spawn ceilings.
	pub fn new(layer_ceiling: u64, spawn_ceiling: u64) -> Self {
		let (terminate_tx, terminate_rx) = flume::unbounded();
		Self {
			workers: Mutex::new(BTreeMap::new()),
			processes: Mutex::new(BTreeMap::new()),
			process_changed: Notify::new(),
			layer_live: AtomicU64::new(0),
			layer_ceiling,
			spawn_live: AtomicU64::new(0),
			spawn_ceiling,
			stale_frames: AtomicU64::new(0),
			terminate_tx,
			terminate_rx,
		}
	}

	/// Opens a named route or refuses immediately when a ceiling is exhausted.
	pub fn open(&self, key: WorkerKey) -> Result<(WorkerRoute, WorkerLease), WorkerUnavailable> {
		if let Some(route) = self.workers.lock().get(&key.name).cloned() {
			if route.key != key {
				return Err(WorkerUnavailable::StaleGeneration);
			}
			let lease =
				WorkerLease::new(route.key.name.clone(), route.generation, self.terminate_tx.clone());
			return Ok((route, lease));
		}
		if !reserve(&self.layer_live, self.layer_ceiling) {
			tracing::warn!(
				extension = %key.extension,
				worker = %key.name,
				site = %key.site,
				layer_live = self.layer_live.load(Ordering::Acquire),
				layer_ceiling = self.layer_ceiling,
				"worker spawn denied by layer capacity",
			);
			return Err(WorkerUnavailable::LayerCeiling);
		}
		if !reserve(&self.spawn_live, self.spawn_ceiling) {
			self.layer_live.fetch_sub(1, Ordering::AcqRel);
			tracing::warn!(
				extension = %key.extension,
				worker = %key.name,
				site = %key.site,
				spawn_live = self.spawn_live.load(Ordering::Acquire),
				spawn_ceiling = self.spawn_ceiling,
				"worker spawn denied by concurrent capacity",
			);
			return Err(WorkerUnavailable::SpawnCeiling);
		}
		let route = WorkerRoute { key: key.clone(), generation: 1 };
		self.workers.lock().insert(key.name.clone(), route.clone());
		self.spawn_live.fetch_sub(1, Ordering::AcqRel);
		tracing::debug!(
			extension = %route.key.extension,
			worker = %route.key.name,
			site = %route.key.site,
			generation = route.generation,
			layer_live = self.layer_live.load(Ordering::Acquire),
			"worker route opened",
		);
		let lease = WorkerLease::new(key.name, route.generation, self.terminate_tx.clone());
		Ok((route, lease))
	}

	/// Admits a final non-streaming device call to the current named worker.
	///
	/// The returned generation is fenced at response demultiplexing; callers
	/// must never accept a response from a replacement generation.
	pub async fn dispatch(
		&self,
		key: WorkerKey,
		args: bytes::Bytes,
		deadline: Duration,
	) -> Result<WorkerDispatch, WorkerUnavailable> {
		let (route, lease) = self.open(key)?;
		lease.relinquish();
		Ok(WorkerDispatch { route, args, deadline })
	}

	/// Closes exactly one current generation and releases its layer slot.
	pub fn close(&self, name: &str, generation: u64) -> bool {
		let mut workers = self.workers.lock();
		if workers
			.get(name)
			.is_none_or(|route| route.generation != generation)
		{
			return false;
		}
		workers.remove(name);
		if self
			.processes
			.lock()
			.remove(&(Str::from(name), generation))
			.is_some()
		{
			self.process_changed.notify_waiters();
		}
		let layer_live = self
			.layer_live
			.fetch_sub(1, Ordering::AcqRel)
			.saturating_sub(1);
		tracing::debug!(worker = %name, generation, layer_live, "worker route closed");
		true
	}

	/// Retires exactly one generation and makes its replacement generation
	/// current. Late DATA is rejected at [`Self::demux`].
	pub fn replace(&self, name: &str, generation: u64) -> Option<WorkerRoute> {
		let mut workers = self.workers.lock();
		let route = workers.get_mut(name)?;
		if route.generation != generation {
			return None;
		}
		route.generation = route.generation.checked_add(1)?;
		tracing::debug!(
			extension = %route.key.extension,
			worker = %route.key.name,
			site = %route.key.site,
			previous_generation = generation,
			generation = route.generation,
			"worker route replaced",
		);
		Some(route.clone())
	}

	/// Returns the current route for a named worker.
	pub fn route(&self, name: &str) -> Option<WorkerRoute> {
		self.workers.lock().get(name).cloned()
	}

	/// Returns a stable snapshot for a worker-list response.
	pub fn routes(&self) -> Vec<WorkerRoute> {
		self.workers.lock().values().cloned().collect()
	}

	/// Accepts DATA only when its named generation is still current.
	pub fn demux(&self, frame: WorkerData) -> Result<AcceptedWorkerData, WorkerUnavailable> {
		let route = self.workers.lock().get(frame.name.as_str()).cloned();
		let Some(route) = route.filter(|route| route.generation == frame.generation) else {
			self.stale_frames.fetch_add(1, Ordering::Relaxed);
			return Err(WorkerUnavailable::StaleGeneration);
		};
		Ok(AcceptedWorkerData { route, channel: frame.channel, data: CowBytes::owned(frame.data) })
	}

	/// Returns and drains one drop-triggered termination request.
	pub fn try_termination(&self) -> Option<(Str, u64)> {
		self.terminate_rx.try_recv().ok()
	}

	/// Returns the number of DATA frames rejected by the sole generation fence.
	/// Returns a route only when it belongs to the authenticated extension and
	/// selected site.
	pub fn route_scoped(&self, extension: &str, name: &str, site: &str) -> Option<WorkerRoute> {
		self
			.workers
			.lock()
			.get(name)
			.filter(|route| route.key.extension == extension && route.key.site == site)
			.cloned()
	}

	/// Returns only routes owned by one authenticated extension.
	pub fn routes_for_extension(&self, extension: &str) -> Vec<WorkerRoute> {
		self
			.workers
			.lock()
			.values()
			.filter(|route| route.key.extension == extension)
			.cloned()
			.collect()
	}

	/// Closes one generation without granting access to another extension's
	/// same-named route.
	pub fn close_scoped(&self, extension: &str, name: &str, site: &str, generation: u64) -> bool {
		let mut workers = self.workers.lock();
		if workers.get(name).is_none_or(|route| {
			route.key.extension != extension
				|| route.key.site != site
				|| route.generation != generation
		}) {
			return false;
		}
		workers.remove(name);
		if self
			.processes
			.lock()
			.remove(&(Str::from(name), generation))
			.is_some()
		{
			self.process_changed.notify_waiters();
		}
		let layer_live = self
			.layer_live
			.fetch_sub(1, Ordering::AcqRel)
			.saturating_sub(1);
		tracing::debug!(
			extension = %extension,
			worker = %name,
			site = %site,
			generation,
			layer_live,
			"worker route closed",
		);
		true
	}

	/// Replaces one authenticated extension generation.
	pub fn replace_scoped(
		&self,
		extension: &str,
		name: &str,
		site: &str,
		generation: u64,
	) -> Option<WorkerRoute> {
		let mut workers = self.workers.lock();
		let route = workers.get_mut(name)?;
		if route.key.extension != extension
			|| route.key.site != site
			|| route.generation != generation
		{
			return None;
		}
		route.generation = route.generation.checked_add(1)?;
		tracing::debug!(
			extension = %extension,
			worker = %name,
			site = %site,
			previous_generation = generation,
			generation = route.generation,
			"worker route replaced",
		);
		Some(route.clone())
	}

	/// Returns the cumulative number of worker frames rejected for a stale
	/// generation.
	pub fn stale_frame_count(&self) -> u64 {
		self.stale_frames.load(Ordering::Relaxed)
	}
}
/// Manifest capability required to create or administer named workers.
pub const WORKERS_MANAGE_CAPABILITY: &str = "workers.manage";

/// Typed site declaration retained by the existing worker process owner.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerSite {
	/// `env`, `local`, or `attached`.
	pub kind:    Str,
	/// Attached process name.
	#[serde(default)]
	pub process: Option<Str>,
	/// Process-specific readiness declaration.
	#[serde(default)]
	pub ready:   Option<Value>,
}

impl Default for WorkerSite {
	fn default() -> Self {
		Self { kind: Str::new_static("env"), process: None, ready: None }
	}
}

/// Process-owned observation of one exact named-worker generation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkerObservation {
	/// Worker name.
	pub name:            Str,
	/// Generation fence.
	pub generation:      u64,
	/// `spawning`, `booting`, `ready`, `draining`, `evicted`, or `failed`.
	pub state:           Str,
	/// Actual placement site.
	pub site:            WorkerSite,
	/// Process id when local.
	pub pid:             Option<u32>,
	/// Spawn clock in epoch milliseconds.
	pub spawned_at_ms:   u64,
	/// Last call clock in epoch milliseconds.
	pub last_call_at_ms: Option<u64>,
	/// Completed call count.
	pub calls:           u64,
	/// Active call count.
	pub in_flight:       u64,
	/// Cached code object count.
	pub code_cached:     u64,
	/// Enforced resource names.
	pub enforced:        Vec<Str>,
	/// Stable process failure, when any.
	pub fault:           Option<Str>,
}

/// Authenticated socket endpoint borrowed from the existing worker process.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkerSessionEndpoint {
	/// Exact worker generation.
	pub generation: u64,
	/// `unix` or `tcp`.
	pub family:     Str,
	/// Unix path or `[host, port]`.
	pub address:    Value,
	/// Optional process-minted authentication key.
	pub authkey:    Option<bytes::Bytes>,
}

/// Process-owned state published into the named-worker supervisor.
///
/// The process launcher is the only producer. CONTROL reads and removes these
/// generation-fenced records instead of maintaining a second worker index.
#[derive(Clone, Debug)]
pub struct SupervisedWorkerProcess {
	/// Exact live observation.
	pub observation: WorkerObservation,
	/// Authenticated endpoint minted by that process, when it supports sessions.
	pub endpoint:    Option<WorkerSessionEndpoint>,
	/// Process-lifetime cancellation owned by the existing launcher.
	pub cancel:      CancellationToken,
	/// Completion signal cancelled by the launcher after process exit.
	pub terminated:  CancellationToken,
}

impl WorkerSupervisor {
	/// Publishes one process-launch result into the authoritative route.
	pub fn publish_process(
		&self,
		route: &WorkerRoute,
		process: SupervisedWorkerProcess,
	) -> Result<(), WorkerUnavailable> {
		if self
			.route_scoped(
				route.key.extension.as_str(),
				route.key.name.as_str(),
				route.key.site.as_str(),
			)
			.is_none_or(|current| current.generation != route.generation)
			|| process.observation.name != route.key.name
			|| process.observation.generation != route.generation
			|| process
				.endpoint
				.as_ref()
				.is_some_and(|endpoint| endpoint.generation != route.generation)
		{
			return Err(WorkerUnavailable::StaleGeneration);
		}
		self
			.processes
			.lock()
			.insert((route.key.name.clone(), route.generation), process);
		self.process_changed.notify_waiters();
		Ok(())
	}

	/// Removes one exact process record after the launcher has terminated it.
	pub fn retire_process(&self, route: &WorkerRoute) -> bool {
		let removed = self
			.processes
			.lock()
			.remove(&(route.key.name.clone(), route.generation))
			.is_some();
		if removed {
			self.process_changed.notify_waiters();
		}
		removed
	}

	fn process(&self, route: &WorkerRoute) -> Option<SupervisedWorkerProcess> {
		self
			.processes
			.lock()
			.get(&(route.key.name.clone(), route.generation))
			.cloned()
	}
}

/// Typed worker owner rejection.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WorkerControlFailure {
	/// Connection identity or generation changed.
	#[error("worker authority belongs to a stale connection generation")]
	StaleConnection,
	/// Manifest capability was not granted.
	#[error("worker capability denied")]
	Capability,
	/// Request is illegal in the current invocation phase.
	#[error("worker operation is illegal in the current invocation phase")]
	Phase,
	/// Worker name or generation is absent.
	#[error("worker generation was evicted")]
	Evicted,
	/// Supervisor capacity refused an immediate spawn.
	#[error("worker supervisor is at capacity")]
	Capacity,
	/// Worker process failed.
	#[error("worker process failed: {0}")]
	Process(Str),
	/// Request arguments are malformed.
	#[error("worker request is malformed: {0}")]
	Invalid(Str),
}

impl WorkerControlFailure {
	fn protocol(&self) -> ControlProtocolError {
		let code = match self {
			Self::StaleConnection | Self::Evicted => "StaleGeneration",
			Self::Capability => "PermissionDenied",
			Self::Phase => "InvalidPhase",
			Self::Capacity => "WorkerUnavailable",
			Self::Process(_) => "WorkerUnavailable",
			Self::Invalid(_) => "InvalidArguments",
		};
		ControlProtocolError::new(code, Str::from(self.to_string()))
			.retryable(matches!(self, Self::Capacity | Self::Process(_)))
	}
}

/// Existing placed-worker process boundary. The CONTROL owner owns namespace
/// and generations but delegates process spawn, health, stop, and socket
/// minting to this runtime.
#[async_trait]
pub trait WorkerProcessAuthority: Send + Sync + 'static {
	/// Ensures one already-admitted route has a live process.
	async fn ensure(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure>;
	/// Observes one exact process generation.
	async fn observe(&self, route: &WorkerRoute) -> Result<WorkerObservation, WorkerControlFailure>;
	/// Waits for readiness.
	async fn warm(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure>;
	/// Drains and terminates exactly one process generation.
	async fn stop(
		&self,
		route: &WorkerRoute,
		grace: Duration,
		cancel: CancellationToken,
	) -> Result<(), WorkerControlFailure>;
	/// Borrows a process-owned authenticated session endpoint.
	async fn session(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerSessionEndpoint, WorkerControlFailure>;
}

#[async_trait]
impl WorkerProcessAuthority for WorkerSupervisor {
	async fn ensure(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure> {
		if cancel.is_cancelled() {
			return Err(WorkerControlFailure::Process(Str::new_static("worker request cancelled")));
		}
		self
			.process(route)
			.map(|process| process.observation)
			.ok_or(WorkerControlFailure::Evicted)
	}

	async fn observe(&self, route: &WorkerRoute) -> Result<WorkerObservation, WorkerControlFailure> {
		self
			.process(route)
			.map(|process| process.observation)
			.ok_or(WorkerControlFailure::Evicted)
	}

	async fn warm(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure> {
		loop {
			let changed = self.process_changed.notified();
			let observation = self.observe(route).await?;
			if observation.state == "ready" {
				return Ok(observation);
			}
			if let Some(fault) = observation.fault {
				return Err(WorkerControlFailure::Process(fault));
			}
			tokio::select! {
				() = changed => {},
				() = cancel.cancelled() => {
					return Err(WorkerControlFailure::Process(Str::new_static(
						"worker request cancelled",
					)));
				},
			}
		}
	}

	async fn stop(
		&self,
		route: &WorkerRoute,
		grace: Duration,
		cancel: CancellationToken,
	) -> Result<(), WorkerControlFailure> {
		if cancel.is_cancelled() {
			return Err(WorkerControlFailure::Process(Str::new_static("worker request cancelled")));
		}
		let process = self.process(route).ok_or(WorkerControlFailure::Evicted)?;
		process.cancel.cancel();
		tokio::select! {
			() = process.terminated.cancelled() => {},
			() = tokio::time::sleep(grace) => {},
			() = cancel.cancelled() => {
				return Err(WorkerControlFailure::Process(Str::new_static(
					"worker request cancelled",
				)));
			},
		}
		if self.retire_process(route) {
			Ok(())
		} else {
			Err(WorkerControlFailure::Evicted)
		}
	}

	async fn session(
		&self,
		route: &WorkerRoute,
		cancel: CancellationToken,
	) -> Result<WorkerSessionEndpoint, WorkerControlFailure> {
		if cancel.is_cancelled() {
			return Err(WorkerControlFailure::Process(Str::new_static("worker request cancelled")));
		}
		self
			.process(route)
			.ok_or(WorkerControlFailure::Evicted)?
			.endpoint
			.ok_or_else(|| {
				WorkerControlFailure::Process(Str::new_static(
					"worker does not expose an authenticated session endpoint",
				))
			})
	}
}

/// Authoritative named-worker CONTROL owner for one extension connection.
pub struct WorkerControlOwner {
	identity:   Arc<ControlConnectionIdentity>,
	supervisor: Arc<WorkerSupervisor>,
	processes:  Arc<dyn WorkerProcessAuthority>,
}

impl WorkerControlOwner {
	/// Binds a worker namespace to one authenticated extension generation.
	pub fn new(
		identity: Arc<ControlConnectionIdentity>,
		supervisor: Arc<WorkerSupervisor>,
		processes: Arc<dyn WorkerProcessAuthority>,
	) -> Self {
		Self { identity, supervisor, processes }
	}

	fn validate(
		&self,
		context: &ControlRequestContext,
		mutate: bool,
	) -> Result<(), WorkerControlFailure> {
		let connection = &context.connection;
		if connection.extension != self.identity.extension
			|| connection.artifact_digest != self.identity.artifact_digest
			|| connection.host_generation != self.identity.host_generation
			|| connection.session_generation != self.identity.session_generation
			|| connection.capabilities != self.identity.capabilities
		{
			return Err(WorkerControlFailure::StaleConnection);
		}
		if !self
			.identity
			.capabilities
			.contains(WORKERS_MANAGE_CAPABILITY)
		{
			return Err(WorkerControlFailure::Capability);
		}
		let invocation = context
			.invocation
			.as_ref()
			.ok_or(WorkerControlFailure::Phase)?;
		if invocation.lifecycle != omp_core::LifecyclePhase::Active
			|| (mutate
				&& !invocation
					.phase
					.allows_operation(omp_core::InvocationPhase::EffectsAuthorized))
			|| (!mutate && invocation.phase.is_terminal())
		{
			return Err(WorkerControlFailure::Phase);
		}
		Ok(())
	}

	fn route(
		&self,
		name: &str,
		generation: Option<u64>,
	) -> Result<WorkerRoute, WorkerControlFailure> {
		let route = self
			.supervisor
			.route_scoped(self.identity.extension.as_str(), name, "env")
			.ok_or(WorkerControlFailure::Evicted)?;
		if generation.is_some_and(|expected| expected != route.generation) {
			return Err(WorkerControlFailure::Evicted);
		}
		Ok(route)
	}

	fn observation(
		route: &WorkerRoute,
		observation: WorkerObservation,
	) -> Result<WorkerObservation, WorkerControlFailure> {
		if observation.name == route.key.name && observation.generation == route.generation {
			Ok(observation)
		} else {
			Err(WorkerControlFailure::StaleConnection)
		}
	}
}

struct CancelWorkerRequest(CancellationToken);

impl Drop for CancelWorkerRequest {
	fn drop(&mut self) {
		self.0.cancel();
	}
}

#[async_trait]
impl ControlAuthority for WorkerControlOwner {
	fn handles(&self, operation: &str) -> bool {
		operation.starts_with("omp.workers.")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		let mutate = matches!(
			operation,
			"omp.workers.get"
				| "omp.workers.warm"
				| "omp.workers.stop"
				| "omp.workers.evict"
				| "omp.workers.restart"
				| "omp.workers.session"
		);
		if !matches!(
			operation,
			"omp.workers.get"
				| "omp.workers.list"
				| "omp.workers.info"
				| "omp.workers.warm"
				| "omp.workers.stop"
				| "omp.workers.evict"
				| "omp.workers.restart"
				| "omp.workers.session"
		) {
			return Err(ControlProtocolError::new("UnknownOperation", "unknown worker operation"));
		}
		self
			.validate(context, mutate)
			.map_err(|error| error.protocol())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		mut arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		let cancel = CancellationToken::new();
		let _cancel_on_drop = CancelWorkerRequest(cancel.clone());
		match operation.as_str() {
			"omp.workers.get" => {
				let name = worker_name(&mut arguments)?;
				let key = WorkerKey {
					extension: self.identity.extension.clone(),
					name:      Str::from(name.as_str()),
					site:      Str::new_static("env"),
				};
				let (route, lease) = self.supervisor.open(key).map_err(|error| match error {
					WorkerUnavailable::LayerCeiling | WorkerUnavailable::SpawnCeiling => {
						WorkerControlFailure::Capacity.protocol()
					},
					WorkerUnavailable::StaleGeneration => WorkerControlFailure::Evicted.protocol(),
				})?;
				lease.relinquish();
				let observation = match self.processes.ensure(&route, cancel).await {
					Ok(observation) => {
						Self::observation(&route, observation).map_err(|error| error.protocol())?
					},
					Err(error) => {
						self.supervisor.close_scoped(
							self.identity.extension.as_str(),
							route.key.name.as_str(),
							route.key.site.as_str(),
							route.generation,
						);
						return Err(error.protocol());
					},
				};
				serde_json::to_value(observation).map_err(worker_serialization)
			},
			"omp.workers.list" => {
				let mut observations = Vec::new();
				for route in self
					.supervisor
					.routes_for_extension(self.identity.extension.as_str())
				{
					let observation = self
						.processes
						.observe(&route)
						.await
						.map_err(|error| error.protocol())?;
					observations
						.push(Self::observation(&route, observation).map_err(|error| error.protocol())?);
				}
				serde_json::to_value(observations).map_err(worker_serialization)
			},
			"omp.workers.info" => {
				let name = worker_name(&mut arguments)?;
				let generation = worker_generation(&mut arguments)?;
				let route = self
					.route(&name, Some(generation))
					.map_err(|error| error.protocol())?;
				let observation = self
					.processes
					.observe(&route)
					.await
					.map_err(|error| error.protocol())?;
				serde_json::to_value(
					Self::observation(&route, observation).map_err(|error| error.protocol())?,
				)
				.map_err(worker_serialization)
			},
			"omp.workers.warm" => {
				let name = worker_name(&mut arguments)?;
				let generation = worker_generation(&mut arguments)?;
				let route = self
					.route(&name, Some(generation))
					.map_err(|error| error.protocol())?;
				let observation = self
					.processes
					.warm(&route, cancel)
					.await
					.map_err(|error| error.protocol())?;
				Ok(Value::String(
					Self::observation(&route, observation)
						.map_err(|error| error.protocol())?
						.state
						.to_string(),
				))
			},
			"omp.workers.stop" => {
				let name = worker_name(&mut arguments)?;
				let generation = worker_generation(&mut arguments)?;
				let grace = worker_grace(&mut arguments)?;
				let route = self
					.route(&name, Some(generation))
					.map_err(|error| error.protocol())?;
				self
					.processes
					.stop(&route, grace, cancel)
					.await
					.map_err(|error| error.protocol())?;
				self.supervisor.close_scoped(
					self.identity.extension.as_str(),
					&name,
					"env",
					generation,
				);
				Ok(Value::Null)
			},
			"omp.workers.evict" => {
				let name = worker_name(&mut arguments)?;
				let grace = worker_grace(&mut arguments)?;
				let Some(route) =
					self
						.supervisor
						.route_scoped(self.identity.extension.as_str(), &name, "env")
				else {
					return Ok(Value::Bool(false));
				};
				self
					.processes
					.stop(&route, grace, cancel)
					.await
					.map_err(|error| error.protocol())?;
				Ok(Value::Bool(self.supervisor.close_scoped(
					self.identity.extension.as_str(),
					&name,
					"env",
					route.generation,
				)))
			},
			"omp.workers.restart" => {
				let name = worker_name(&mut arguments)?;
				let grace = worker_grace(&mut arguments)?;
				let route = self.route(&name, None).map_err(|error| error.protocol())?;
				self
					.processes
					.stop(&route, grace, cancel.clone())
					.await
					.map_err(|error| error.protocol())?;
				let replacement = self
					.supervisor
					.replace_scoped(self.identity.extension.as_str(), &name, "env", route.generation)
					.ok_or_else(|| WorkerControlFailure::Evicted.protocol())?;
				let observation = self
					.processes
					.ensure(&replacement, cancel)
					.await
					.map_err(|error| error.protocol())?;
				serde_json::to_value(
					Self::observation(&replacement, observation).map_err(|error| error.protocol())?,
				)
				.map_err(worker_serialization)
			},
			"omp.workers.session" => {
				let name = worker_name(&mut arguments)?;
				let generation = worker_generation(&mut arguments)?;
				let route = self
					.route(&name, Some(generation))
					.map_err(|error| error.protocol())?;
				let endpoint = self
					.processes
					.session(&route, cancel)
					.await
					.map_err(|error| error.protocol())?;
				if endpoint.generation != generation {
					return Err(WorkerControlFailure::Evicted.protocol());
				}
				Ok(json!({
					"generation": endpoint.generation,
					"family": endpoint.family,
					"address": endpoint.address,
					"authkey_base64": endpoint.authkey.map(|key| omp_core::base64::encode(&key).to_string()),
				}))
			},
			_ => unreachable!("authorize rejects unknown worker operations"),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self
			.validate(&context, false)
			.map_err(|error| error.protocol())?;
		Err(ControlProtocolError::new("UnsupportedEffect", "worker authority accepts requests only"))
	}
}

fn worker_name(
	arguments: &mut serde_json::Map<String, Value>,
) -> Result<String, ControlProtocolError> {
	arguments
		.remove("name")
		.and_then(|value| value.as_str().map(ToOwned::to_owned))
		.filter(|name| {
			!name.is_empty()
				&& name
					.chars()
					.all(|character| character.is_alphanumeric() || "._-".contains(character))
		})
		.ok_or_else(|| {
			WorkerControlFailure::Invalid(Str::new_static("invalid worker name")).protocol()
		})
}

fn worker_generation(
	arguments: &mut serde_json::Map<String, Value>,
) -> Result<u64, ControlProtocolError> {
	arguments
		.remove("generation")
		.and_then(|value| value.as_u64())
		.filter(|generation| *generation != 0)
		.ok_or_else(|| {
			WorkerControlFailure::Invalid(Str::new_static("generation is required")).protocol()
		})
}

fn worker_grace(
	arguments: &mut serde_json::Map<String, Value>,
) -> Result<Duration, ControlProtocolError> {
	let seconds = arguments
		.remove("grace")
		.and_then(|value| value.as_f64())
		.unwrap_or(5.0);
	if !seconds.is_finite() || seconds < 0.0 {
		return Err(
			WorkerControlFailure::Invalid(Str::new_static("grace must be non-negative")).protocol(),
		);
	}
	Ok(Duration::from_secs_f64(seconds))
}

fn worker_serialization(error: serde_json::Error) -> ControlProtocolError {
	ControlProtocolError::new("WorkerProtocol", Str::from(error.to_string()))
}

fn reserve(counter: &AtomicU64, limit: u64) -> bool {
	counter
		.try_update(Ordering::AcqRel, Ordering::Acquire, |current| {
			(current < limit).then_some(current + 1)
		})
		.is_ok()
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn codec_refuses_header_before_allocation() {
		let mut bytes = Vec::new();
		bytes.extend_from_slice(
			&u32::try_from(MAX_TUNNEL_HEADER_BYTES + 1)
				.unwrap()
				.to_be_bytes(),
		);
		bytes.extend_from_slice(&0u16.to_be_bytes());
		assert!(matches!(
			TunnelFrame::decode(CowBytes::owned(bytes.into())),
			Err(TunnelError::HeaderTooLarge)
		));
	}

	#[test]
	fn codec_refuses_buffer_count_before_allocation() {
		let mut bytes = Vec::new();
		bytes.extend_from_slice(&0u32.to_be_bytes());
		bytes.extend_from_slice(&u16::try_from(MAX_TUNNEL_BUFFERS + 1).unwrap().to_be_bytes());
		assert!(matches!(
			TunnelFrame::decode(CowBytes::owned(bytes.into())),
			Err(TunnelError::TooManyBuffers)
		));
	}

	#[test]
	fn stale_generation_never_delivers() {
		let supervisor = WorkerSupervisor::new(1, 1);
		let (route, _lease) = supervisor
			.open(WorkerKey { extension: sf!("x"), name: sf!("w"), site: sf!("env") })
			.unwrap();
		let frame = WorkerData {
			name: route.key.name.to_string(),
			generation: route.generation + 1,
			channel: 0,
			data: Vec::new().into(),
			..WorkerData::default()
		};
		assert!(matches!(supervisor.demux(frame), Err(WorkerUnavailable::StaleGeneration)));
		assert_eq!(supervisor.stale_frame_count(), 1);
	}

	#[test]
	fn lease_drop_queues_termination() {
		let supervisor = WorkerSupervisor::new(1, 1);
		let (route, lease) = supervisor
			.open(WorkerKey { extension: sf!("x"), name: sf!("w"), site: sf!("env") })
			.unwrap();
		drop(lease);
		assert_eq!(supervisor.try_termination(), Some((route.key.name, route.generation)));
	}

	#[test]
	fn ceiling_refuses_without_queueing() {
		let supervisor = WorkerSupervisor::new(1, 1);
		let _ = supervisor
			.open(WorkerKey { extension: sf!("x"), name: sf!("a"), site: sf!("env") })
			.unwrap();
		assert!(matches!(
			supervisor.open(WorkerKey {
				extension: sf!("x"),
				name:      sf!("b"),
				site:      sf!("env"),
			}),
			Err(WorkerUnavailable::LayerCeiling)
		));
	}
}
