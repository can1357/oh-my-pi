//! Lazy, generation-fenced embedding subprocess supervision.

use std::{
	ffi::OsString,
	path::PathBuf,
	process,
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

use omp_core::Str;
use tokio::{
	io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
	process::{Child, ChildStdin, ChildStdout, Command},
	sync::Mutex,
	time,
};

use super::protocol::{InboundFrame, MAX_FRAME_BYTES, ModelId, OutboundFrame};
use crate::{Error, Result};

/// Worker launch and deadline policy.
#[derive(Clone, Debug)]
pub struct SupervisorConfig {
	/// Executable containing the stdio worker entry point.
	pub executable:      PathBuf,
	/// Arguments selecting the worker entry point.
	pub args:            Vec<OsString>,
	/// Model-load probe deadline.
	pub load_timeout:    Duration,
	/// Steady-state embedding request deadline.
	pub request_timeout: Duration,
}

impl SupervisorConfig {
	/// Creates request deadlines for an executable.
	pub fn new(executable: impl Into<PathBuf>) -> Self {
		Self {
			executable:      executable.into(),
			args:            Vec::new(),
			load_timeout:    Duration::from_mins(10),
			request_timeout: Duration::from_secs(120),
		}
	}
}

/// Lazy single-worker supervisor. Requests serialize because `FastEmbed` model
/// access is serialized; a timeout or protocol fault hard-reaps the child and
/// the next request starts a fresh generation.
pub struct EmbeddingSupervisor {
	config:          SupervisorConfig,
	process:         Mutex<Option<WorkerProcess>>,
	next_generation: AtomicU64,
	next_request:    AtomicU64,
}

impl EmbeddingSupervisor {
	/// Creates an unloaded supervisor without spawning a process.
	pub const fn new(config: SupervisorConfig) -> Self {
		Self {
			config,
			process: Mutex::const_new(None),
			next_generation: AtomicU64::new(1),
			next_request: AtomicU64::new(1),
		}
	}

	/// Starts the worker lazily and probes stdio framing without loading a
	/// model.
	pub async fn ping(&self) -> Result<()> {
		let id = self.request_id();
		let frame = InboundFrame::Ping { id: id.clone() };
		let response = self
			.exchange_one(frame, self.config.request_timeout)
			.await?;
		if matches!(response, OutboundFrame::Pong { id: response_id } if response_id == id) {
			Ok(())
		} else {
			self.reap().await;
			Err(Error::EmbeddingWorker)
		}
	}

	/// Loads or switches a local model. Failed loads are retryable on a later
	/// call.
	pub async fn initialize(&self, model: ModelId, cache_dir: Option<PathBuf>) -> Result<u64> {
		let id = self.request_id();
		let frame = InboundFrame::Init { id: id.clone(), model, cache_dir };
		let response = self.exchange_one(frame, self.config.load_timeout).await?;
		match response {
			OutboundFrame::Ready { id: response_id, generation } if response_id == id => {
				Ok(generation)
			},
			_ => {
				self.reap().await;
				Err(Error::EmbeddingWorker)
			},
		}
	}

	/// Embeds an ordered bounded batch and verifies every streaming row offset
	/// and generation.
	pub async fn embed(
		&self,
		model: ModelId,
		cache_dir: Option<PathBuf>,
		texts: Vec<String>,
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>> {
		let expected_total = texts.len();
		let id = self.request_id();
		let frame = InboundFrame::Embed { id: id.clone(), model, cache_dir, texts, batch_size };
		frame.validate()?;
		let mut guard = self.process.lock().await;
		self.ensure_process(&mut guard).await?;
		let process = guard.as_mut().ok_or(Error::EmbeddingWorker)?;
		let generation = process.generation;
		let future = async {
			process.send(&frame).await?;
			let mut vectors = Vec::with_capacity(expected_total);
			loop {
				match process.receive().await? {
					OutboundFrame::Log { level, message } => {
						tracing::debug!(level = %level, message = %message, "memory embedding worker");
					},
					OutboundFrame::Vectors {
						id: response_id,
						generation: response_generation,
						start,
						total,
						vectors: chunk,
						done,
					} if response_id == id
						&& response_generation == generation
						&& start == vectors.len()
						&& total == expected_total =>
					{
						vectors.extend(chunk);
						if done {
							return if vectors.len() == expected_total {
								Ok(vectors)
							} else {
								Err(Error::EmbeddingWorker)
							};
						}
					},
					_ => return Err(Error::EmbeddingWorker),
				}
			}
		};
		match time::timeout(self.config.request_timeout, future).await {
			Ok(Ok(vectors)) => Ok(vectors),
			Ok(Err(error)) => {
				reap_locked(&mut guard).await;
				Err(error)
			},
			Err(_) => {
				reap_locked(&mut guard).await;
				Err(Error::EmbeddingTimeout)
			},
		}
	}

	/// Hard-reaps the current worker. A later request restarts with a new
	/// generation.
	pub async fn reap(&self) {
		let mut guard = self.process.lock().await;
		reap_locked(&mut guard).await;
	}

	async fn exchange_one(&self, frame: InboundFrame, timeout: Duration) -> Result<OutboundFrame> {
		frame.validate()?;
		let mut guard = self.process.lock().await;
		self.ensure_process(&mut guard).await?;
		let process = guard.as_mut().ok_or(Error::EmbeddingWorker)?;
		let generation = process.generation;
		let future = async {
			process.send(&frame).await?;
			loop {
				let response = process.receive().await?;
				if let OutboundFrame::Log { level, message } = response {
					tracing::debug!(level = %level, message = %message, "memory embedding worker");
					continue;
				}
				if matches!(
					&response,
					OutboundFrame::Ready { generation: response_generation, .. }
						| OutboundFrame::Error { generation: response_generation, .. }
						if *response_generation != generation
				) {
					return Err(Error::EmbeddingWorker);
				}
				return Ok(response);
			}
		};
		match time::timeout(timeout, future).await {
			Ok(Ok(response)) if !matches!(response, OutboundFrame::Error { .. }) => Ok(response),
			Ok(Ok(_) | Err(_)) => {
				reap_locked(&mut guard).await;
				Err(Error::EmbeddingWorker)
			},
			Err(_) => {
				reap_locked(&mut guard).await;
				Err(Error::EmbeddingTimeout)
			},
		}
	}

	async fn ensure_process(&self, slot: &mut Option<WorkerProcess>) -> Result<()> {
		if slot.is_some() {
			return Ok(());
		}
		let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
		*slot = Some(WorkerProcess::spawn(&self.config, generation).await?);
		Ok(())
	}

	fn request_id(&self) -> Str {
		Str::new(format!("memory_{}", self.next_request.fetch_add(1, Ordering::Relaxed)))
	}
}

struct WorkerProcess {
	child:      Child,
	stdin:      ChildStdin,
	stdout:     BufReader<ChildStdout>,
	generation: u64,
}

impl WorkerProcess {
	async fn spawn(config: &SupervisorConfig, generation: u64) -> Result<Self> {
		let mut command = Command::new(&config.executable);
		command
			.args(&config.args)
			.env("OMP_MEMORY_WORKER_GENERATION", generation.to_string())
			.stdin(process::Stdio::piped())
			.stdout(process::Stdio::piped())
			.stderr(process::Stdio::inherit())
			.kill_on_drop(true);
		let mut child = command.spawn()?;
		let stdin = child.stdin.take().ok_or(Error::EmbeddingWorker)?;
		let stdout = child.stdout.take().ok_or(Error::EmbeddingWorker)?;
		Ok(Self { child, stdin, stdout: BufReader::new(stdout), generation })
	}

	async fn send(&mut self, frame: &InboundFrame) -> Result<()> {
		let encoded = serde_json::to_vec(frame)?;
		if encoded.len() > MAX_FRAME_BYTES {
			return Err(Error::InputTooLarge);
		}
		self.stdin.write_all(&encoded).await?;
		self.stdin.write_all(b"\n").await?;
		self.stdin.flush().await?;
		Ok(())
	}

	async fn receive(&mut self) -> Result<OutboundFrame> {
		let mut frame = Vec::new();
		loop {
			let available = self.stdout.fill_buf().await?;
			if available.is_empty() {
				return Err(Error::EmbeddingWorker);
			}
			let newline = available.iter().position(|byte| *byte == b'\n');
			let take = newline.map_or(available.len(), |index| index + 1);
			if frame.len().saturating_add(take) > MAX_FRAME_BYTES + 1 {
				return Err(Error::InputTooLarge);
			}
			frame.extend_from_slice(&available[..take]);
			self.stdout.consume(take);
			if newline.is_some() {
				break;
			}
		}
		if frame.last() == Some(&b'\n') {
			frame.pop();
		}
		let response = serde_json::from_slice::<OutboundFrame>(&frame)?;
		response.validate()?;
		Ok(response)
	}
}

async fn reap_locked(slot: &mut Option<WorkerProcess>) {
	if let Some(mut process) = slot.take() {
		let _ = process.child.start_kill();
		let _ = process.child.wait().await;
	}
}
