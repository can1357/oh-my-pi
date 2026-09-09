//! Streaming assistant speech.
//!
//! The [`Vocalizer`] turns the assistant's streaming output into spoken audio
//! as a side effect of the turn. Deltas run through
//! [`SpeakableStream`] — which drops code, tables, and markup and cuts
//! speakable segments the moment a boundary appears — and every ready segment
//! is queued for a background worker that synthesizes it through the host's
//! [`SpeechSynth`] and plays it on one gapless [`PlaybackStream`] per
//! utterance. An idle timer speaks the buffered partial when generation
//! stalls (tool call, thinking block), and [`Vocalizer::clear`] stops
//! playback at once and drops everything queued — wired to a new user
//! message and to the Esc/Ctrl+C interrupt.
//!
//! Mode routing: `assistant` and `all` speak text deltas,
//! `all` also speaks thinking, `yield` speaks nothing live and the whole
//! final message at turn end, `off` speaks nothing. The host reads the mode
//! with [`Vocalizer::mode`] and passes it to every call so the app's
//! `cl_speech_mode` declaration stays the single owner of the setting.
//!
//! Synthesis, queue, rewrite, and playback failures never reach the turn:
//! they remain typed at the vocalizer boundary, are debug-logged by the host,
//! and degrade enhanced speech to deterministic mechanical cleanup.

use std::{
	collections::VecDeque,
	future::Future,
	pin::Pin,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
	},
	time::Duration,
};

use flume::{Receiver, Sender, TrySendError};
use omp_ai::realtime::rewrite::RewriteBlockAccumulator;
use omp_audio::{VoiceError, audio::PlaybackStream, segmentation::SpeakableStream};
use omp_con::{Ctx, Value};
use omp_core::Str;
use parking_lot::Mutex;
use tokio::{sync::Notify, time::Instant};

/// Quiet time on the delta stream before the buffered partial is flushed.
const IDLE_FLUSH: Duration = Duration::from_millis(1000);
/// Maximum sentence/rewrite jobs waiting behind synthesis. A full queue
/// rejects the newest segment rather than allocating without bound.
const JOB_CAPACITY: usize = 32;
/// Completed enhanced blocks after the first are coalesced to amortize tiny
/// model calls while preserving fast time-to-first-audio.
const COALESCE_MIN_CHARS: usize = 400;
/// Maximum raw block characters sent to the auxiliary rewrite model.
const MAX_REWRITE_CHARS: usize = 4_000;
/// Maximum concurrent enhanced rewrite completions; ordered playback waits
/// for the oldest result before admitting a third.
const MAX_REWRITES_IN_FLIGHT: usize = 2;

/// Which assistant channels are vocalized, with `off` for the disabled state.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum SpeechMode {
	/// Speak assistant text as it streams.
	Assistant,
	/// Speak assistant text and thinking as they stream.
	All,
	/// Speak only the final message once the turn ends.
	Yield,
	/// Speech disabled.
	#[default]
	Off,
}

omp_con::con_enum!(SpeechMode);

impl SpeechMode {
	/// Whether streamed text deltas are spoken live.
	const fn speaks_text(self) -> bool {
		matches!(self, Self::Assistant | Self::All)
	}
}

/// Encoded format requested from a synthesis backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SynthFormat {
	/// Little-endian signed PCM16.
	Pcm16,
}

/// Settings captured once when an utterance emits its first segment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SynthConfig {
	/// Provider/model identifier.
	pub model:       Str,
	/// Provider voice identifier.
	pub voice:       Str,
	/// Encoded audio format.
	pub format:      SynthFormat,
	/// Requested logical sample rate.
	pub sample_rate: u32,
}

/// One synthesis or rewrite request with interruption tied to its utterance.
#[derive(Clone)]
pub struct SynthRequest {
	/// Speakable input text.
	pub text:   Str,
	/// Latched utterance settings.
	pub config: SynthConfig,
	/// Cancelled by clear, suspension, a new prompt, or host teardown.
	pub cancel: tokio_util::sync::CancellationToken,
}

/// One synthesized utterance segment: mono PCM at `sample_rate`.
pub struct SynthAudio {
	/// Samples per second.
	pub sample_rate: u32,
	/// Mono `f32` samples in `[-1, 1]`.
	pub samples:     Vec<f32>,
}

/// Typed synthesis boundary failure.
#[derive(Clone, Debug, thiserror::Error)]
pub enum SpeechSynthFailure {
	/// The configured backend rejected or failed the request.
	#[error("speech synthesis backend failed ({code})")]
	Backend {
		/// Stable failure class.
		code: Str,
	},
	/// The response did not contain valid audio in the requested format.
	#[error("speech synthesis returned malformed audio ({bytes} bytes)")]
	MalformedAudio {
		/// Encoded byte count.
		bytes: usize,
	},
	/// The utterance was interrupted.
	#[error("speech synthesis was cancelled")]
	Cancelled,
}

/// Typed vocalizer failure retained for diagnostics without affecting the turn.
#[derive(Clone, Debug, thiserror::Error)]
pub enum VocalizerFailure {
	/// The bounded synthesis queue could not accept another segment.
	#[error("speech synthesis queue reached its {capacity}-segment limit")]
	Backpressure {
		/// Configured queue capacity.
		capacity: usize,
	},
	/// The worker stopped accepting input.
	#[error("speech synthesis worker is unavailable")]
	WorkerClosed,
	/// The synthesis/rewrite backend failed.
	#[error(transparent)]
	Synthesis {
		/// Typed backend failure.
		#[from]
		source: SpeechSynthFailure,
	},
	/// Native speaker playback failed.
	#[error(transparent)]
	Playback {
		/// Typed audio-device failure.
		#[from]
		source: VoiceError,
	},
}

/// Text-to-speech backend supplied by the application.
pub trait SpeechSynth: Send + Sync + 'static {
	/// Captures the effective model, voice, format, and sample rate for a new
	/// utterance. Later setting changes apply to the next utterance.
	fn configuration(&self) -> SynthConfig;

	/// Synthesizes one speakable segment.
	fn synthesize(
		&self,
		request: SynthRequest,
	) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>>;

	/// Rewrites one enhanced-speech block. `Ok(None)` means no rewrite service
	/// is available and the vocalizer must use deterministic mechanical cleanup.
	fn rewrite(
		&self,
		_request: SynthRequest,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, SpeechSynthFailure>> + Send + '_>> {
		Box::pin(async { Ok(None) })
	}
}

/// Worker queue entry; `generation` is compared against the live generation
/// so a [`Vocalizer::clear`] invalidates everything already queued.
enum Job {
	/// Synthesize and play one mechanically segmented sentence.
	Speak { generation: u64, request: SynthRequest },
	/// Rewrite one fence-safe block before sentence segmentation.
	Rewrite { generation: u64, request: SynthRequest },
	/// Utterance end: drain playback and release the speaker.
	End { generation: u64 },
}

impl Job {
	const fn generation(&self) -> u64 {
		match self {
			Self::Speak { generation, .. }
			| Self::Rewrite { generation, .. }
			| Self::End { generation } => *generation,
		}
	}
}

struct EnhancedInput {
	blocks:           RewriteBlockAccumulator,
	pending:          Vec<Str>,
	pending_chars:    usize,
	dispatched_first: bool,
}

impl EnhancedInput {
	fn new() -> Self {
		Self {
			blocks:           RewriteBlockAccumulator::new(),
			pending:          Vec::new(),
			pending_chars:    0,
			dispatched_first: false,
		}
	}

	fn stage(&mut self, blocks: Vec<Str>, force: bool) -> Option<Str> {
		for block in blocks {
			self.pending_chars += block.len();
			self.pending.push(block);
		}
		if self.pending.is_empty()
			|| (!force && self.dispatched_first && self.pending_chars < COALESCE_MIN_CHARS)
		{
			return None;
		}
		self.dispatched_first = true;
		self.pending_chars = 0;
		let mut joined = String::new();
		for block in self.pending.drain(..) {
			if !joined.is_empty() {
				joined.push_str("\n\n");
			}
			joined.push_str(block.as_str());
		}
		if joined.chars().count() > MAX_REWRITE_CHARS {
			let half = MAX_REWRITE_CHARS / 2;
			let start = joined.chars().take(half).collect::<String>();
			let end = joined
				.chars()
				.rev()
				.take(half)
				.collect::<String>()
				.chars()
				.rev()
				.collect::<String>();
			joined.clear();
			joined.push_str(&start);
			joined.push_str("\n… (elided) …\n");
			joined.push_str(&end);
		}
		Some(Str::new(joined))
	}
}

enum InputPipeline {
	Idle,
	Mechanical(SpeakableStream),
	Enhanced(EnhancedInput),
}

/// State shared between the host-side [`Vocalizer`], the synthesis worker,
/// and the idle-flush timer.
struct Shared {
	/// Bumped by `clear`; jobs from older generations are dropped unplayed.
	generation:    AtomicU64,
	/// Generation of the utterance whose playback session is open (`0` when
	/// none); `speaking` while it matches the live generation.
	open:          AtomicU64,
	/// In-flight rewrite count keyed by generation.
	rewrites:      Mutex<(u64, usize)>,
	/// Application synthesis and optional rewrite backend.
	synth:         Arc<dyn SpeechSynth>,
	/// Console settings sampled only when a new utterance starts.
	con:           Arc<Ctx>,
	/// Current playback session and its sample rate.
	playback:      Mutex<Option<(u32, PlaybackStream)>>,
	/// Raw-input pipeline latched when the utterance receives its first delta.
	input:         Mutex<InputPipeline>,
	/// Model/voice/format captured on the first queued job of the utterance.
	configuration: Mutex<Option<SynthConfig>>,
	/// Cancellation scope replaced on every interruption.
	cancel:        Mutex<tokio_util::sync::CancellationToken>,
	/// Render-time gain applied to current and future players.
	gain_bits:     AtomicU32,
	/// Suspended live/PTT scopes reject new speech until resumed.
	suspended:     AtomicBool,
	/// Last classified failure for host diagnostics.
	failure:       Mutex<Option<VocalizerFailure>>,
	/// When the idle timer should speak the buffered partial.
	idle_deadline: Mutex<Option<Instant>>,
	/// Wakes the idle timer on re-arm and on shutdown.
	idle:          Notify,
	/// Set when the owning `Vocalizer` drops; the idle task exits.
	closed:        AtomicBool,
}

impl Shared {
	fn live(&self, generation: u64) -> bool {
		self.generation.load(Ordering::Acquire) == generation
	}

	fn request(&self, text: Str) -> SynthRequest {
		let config = {
			let mut slot = self.configuration.lock();
			slot
				.get_or_insert_with(|| self.synth.configuration())
				.clone()
		};
		SynthRequest { text, config, cancel: self.cancel.lock().clone() }
	}

	fn record_failure(&self, failure: VocalizerFailure) {
		*self.failure.lock() = Some(failure);
	}

	fn begin_rewrite(&self, generation: u64) {
		let mut state = self.rewrites.lock();
		if state.0 == generation {
			state.1 += 1;
		} else {
			*state = (generation, 1);
		}
	}

	fn end_rewrite(&self, generation: u64) {
		let mut state = self.rewrites.lock();
		if state.0 == generation {
			state.1 = state.1.saturating_sub(1);
		}
	}

	fn send(&self, tx: &Sender<Job>, job: Job) -> Result<(), VocalizerFailure> {
		match tx.try_send(job) {
			Ok(()) => Ok(()),
			Err(TrySendError::Full(_)) => {
				let failure = VocalizerFailure::Backpressure { capacity: JOB_CAPACITY };
				self.record_failure(failure.clone());
				Err(failure)
			},
			Err(TrySendError::Disconnected(_)) => {
				let failure = VocalizerFailure::WorkerClosed;
				self.record_failure(failure.clone());
				Err(failure)
			},
		}
	}

	/// Queues ready mechanical segments for the worker.
	fn enqueue(&self, tx: &Sender<Job>, segments: Vec<Str>) -> Result<(), VocalizerFailure> {
		let generation = self.generation.load(Ordering::Acquire);
		for text in segments {
			let request = self.request(text);
			self.send(tx, Job::Speak { generation, request })?;
		}
		Ok(())
	}

	fn enqueue_rewrite(&self, tx: &Sender<Job>, text: Str) -> Result<(), VocalizerFailure> {
		let generation = self.generation.load(Ordering::Acquire);
		let request = self.request(text);
		self.send(tx, Job::Rewrite { generation, request })
	}

	/// Appends synthesized audio to the open session, opening (or reopening
	/// at a new sample rate) the speaker on demand.
	async fn play(&self, generation: u64, audio: SynthAudio) -> Result<(), VocalizerFailure> {
		if audio.samples.is_empty() {
			return Ok(());
		}
		let stale = {
			let mut slot = self.playback.lock();
			match slot.as_mut() {
				Some((rate, stream)) if *rate != audio.sample_rate => {
					stream.finish_input();
					Some(stream.state())
				},
				_ => None,
			}
		};
		if let Some(state) = stale {
			state.wait_for_drain().await;
			self.playback.lock().take();
			if !self.live(generation) {
				return Ok(());
			}
		}
		let writer = {
			let mut slot = self.playback.lock();
			if slot.is_none() {
				let stream = PlaybackStream::start(audio.sample_rate)?;
				stream.set_gain(f32::from_bits(self.gain_bits.load(Ordering::Acquire)))?;
				*slot = Some((audio.sample_rate, stream));
			}
			slot
				.as_ref()
				.map(|(_, stream)| stream.writer())
				.transpose()?
		};
		let Some(writer) = writer else {
			return Err(VocalizerFailure::Playback { source: VoiceError::PlaybackClosed });
		};
		if let Err(source) = writer.write_owned_async(audio.samples).await {
			self.playback.lock().take();
			return Err(VocalizerFailure::Playback { source });
		}
		Ok(())
	}

	/// Finishes the open session and waits until its audio has reached the
	/// speaker (or `clear` aborted it), then releases the device.
	async fn drain(&self) -> Result<(), VocalizerFailure> {
		let state = {
			let mut slot = self.playback.lock();
			slot.as_mut().map(|(_, stream)| {
				stream.finish_input();
				stream.state()
			})
		};
		let Some(state) = state else { return Ok(()) };
		state.wait_for_drain().await;
		if let Some((_, mut stream)) = self.playback.lock().take() {
			stream.stop()?;
		}
		Ok(())
	}

	/// Stops playback immediately and drops the open session.
	fn abort_playback(&self) {
		let open = self.playback.lock().take();
		if let Some((_, mut stream)) = open {
			let _ = stream.abort();
		}
	}
}

/// Synthesis worker: synthesizes queued segments in order and feeds one
/// gapless playback session per utterance, so sequential utterances never
/// overlap. Exits once every sender is gone.
async fn synthesize_and_play(
	generation: u64,
	request: SynthRequest,
	synth: &dyn SpeechSynth,
	shared: &Shared,
) {
	shared.open.store(generation, Ordering::Release);
	match synth.synthesize(request).await {
		Ok(audio) if shared.live(generation) => {
			if let Err(failure) = shared.play(generation, audio).await
				&& shared.live(generation)
			{
				shared.record_failure(failure);
			}
		},
		Ok(_) => {},
		Err(SpeechSynthFailure::Cancelled) if !shared.live(generation) => {},
		Err(source) => shared.record_failure(VocalizerFailure::Synthesis { source }),
	}
}

async fn finish_rewrite(
	generation: u64,
	task: tokio::task::JoinHandle<(SynthRequest, Result<Option<Str>, SpeechSynthFailure>)>,
	rewritten: &mut SpeakableStream,
	synth: &dyn SpeechSynth,
	shared: &Shared,
) {
	let result = task.await;
	shared.end_rewrite(generation);
	let Ok((request, result)) = result else {
		shared.record_failure(VocalizerFailure::WorkerClosed);
		return;
	};
	if !shared.live(generation) {
		return;
	}
	let raw = request.text.clone();
	let text = match result {
		Ok(Some(text)) => text,
		Ok(None) => raw,
		Err(SpeechSynthFailure::Cancelled) if !shared.live(generation) => return,
		Err(source) => {
			shared.record_failure(VocalizerFailure::Synthesis { source });
			raw
		},
	};
	let mut normalized = String::with_capacity(text.len() + 1);
	normalized.push_str(text.as_str());
	if !normalized.ends_with('\n') {
		normalized.push('\n');
	}
	for text in rewritten.push(&normalized) {
		let request =
			SynthRequest { text, config: request.config.clone(), cancel: request.cancel.clone() };
		synthesize_and_play(generation, request, synth, shared).await;
	}
}

async fn worker(rx: Receiver<Job>, synth: Arc<dyn SpeechSynth>, shared: Arc<Shared>) {
	let mut rewritten = SpeakableStream::new();
	let mut rewrites = VecDeque::new();
	let mut last_config: Option<(SynthConfig, tokio_util::sync::CancellationToken)> = None;
	while let Ok(job) = rx.recv_async().await {
		let generation = job.generation();
		if !shared.live(generation) {
			continue;
		}
		match job {
			Job::Speak { request, .. } => {
				last_config = Some((request.config.clone(), request.cancel.clone()));
				synthesize_and_play(generation, request, synth.as_ref(), shared.as_ref()).await;
			},
			Job::Rewrite { request, .. } => {
				last_config = Some((request.config.clone(), request.cancel.clone()));
				if rewrites.len() == MAX_REWRITES_IN_FLIGHT
					&& let Some((generation, task)) = rewrites.pop_front()
				{
					finish_rewrite(generation, task, &mut rewritten, synth.as_ref(), shared.as_ref())
						.await;
				}
				shared.begin_rewrite(generation);
				let backend = Arc::clone(&synth);
				let task_request = request.clone();
				let task = tokio::spawn(async move {
					let result = backend.rewrite(task_request.clone()).await;
					(task_request, result)
				});
				rewrites.push_back((generation, task));
			},
			Job::End { .. } => {
				while let Some((generation, task)) = rewrites.pop_front() {
					finish_rewrite(generation, task, &mut rewritten, synth.as_ref(), shared.as_ref())
						.await;
				}
				if let Some((config, cancel)) = last_config.take() {
					for text in rewritten.flush() {
						let request =
							SynthRequest { text, config: config.clone(), cancel: cancel.clone() };
						synthesize_and_play(generation, request, synth.as_ref(), shared.as_ref()).await;
					}
				}
				rewritten = SpeakableStream::new();
				if let Err(failure) = shared.drain().await {
					shared.record_failure(failure);
				}
				let _ =
					shared
						.open
						.compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire);
			},
		}
	}
	shared.abort_playback();
}

/// Idle-flush timer: when no delta arrives for
/// [`IDLE_FLUSH`], speaks the buffered partial instead of holding it through
/// a tool call or thinking block.
async fn idle_flush(tx: Sender<Job>, shared: Arc<Shared>) {
	while !shared.closed.load(Ordering::Acquire) {
		let deadline = *shared.idle_deadline.lock();
		let Some(at) = deadline else {
			shared.idle.notified().await;
			continue;
		};
		tokio::select! {
			biased;
			() = shared.idle.notified() => {},
			() = tokio::time::sleep_until(at) => {
				let fire = {
					let mut slot = shared.idle_deadline.lock();
					let due = *slot == Some(at);
					if due {
						*slot = None;
					}
					due
				};
				if fire {
					let queued = {
						let mut input = shared.input.lock();
						match &mut *input {
							InputPipeline::Idle => Ok(()),
							InputPipeline::Mechanical(speakable) => {
								shared.enqueue(&tx, speakable.flush_idle())
							},
							InputPipeline::Enhanced(enhanced) => {
								let partial = enhanced.blocks.flush_partial();
								enhanced
									.stage(partial.into_iter().collect(), true)
									.map_or(Ok(()), |text| shared.enqueue_rewrite(&tx, text))
							},
						}
					};
					if let Err(failure) = queued {
						shared.record_failure(failure);
					}
				}
			},
		}
	}
}

/// Streaming assistant vocalizer.
///
/// Every method is non-blocking on the host thread; synthesis and playback
/// run on a worker spawned onto the current tokio runtime, or onto a
/// dedicated thread with its own runtime when none is current.
pub struct Vocalizer {
	shared: Arc<Shared>,
	tx:     Sender<Job>,
	rx:     Receiver<Job>,
}

impl Vocalizer {
	/// Starts the synthesis worker over `synth`.
	#[must_use]
	pub fn new(synth: Arc<dyn SpeechSynth>, con: Arc<Ctx>) -> Self {
		let shared = Arc::new(Shared {
			generation: AtomicU64::new(1),
			open: AtomicU64::new(0),
			rewrites: Mutex::new((0, 0)),
			synth: Arc::clone(&synth),
			con,
			playback: Mutex::new(None),
			input: Mutex::new(InputPipeline::Idle),
			configuration: Mutex::new(None),
			cancel: Mutex::new(tokio_util::sync::CancellationToken::new()),
			gain_bits: AtomicU32::new(1.0_f32.to_bits()),
			suspended: AtomicBool::new(false),
			failure: Mutex::new(None),
			idle_deadline: Mutex::new(None),
			idle: Notify::new(),
			closed: AtomicBool::new(false),
		});
		let (tx, rx) = flume::bounded(JOB_CAPACITY);
		let work = worker(rx.clone(), synth, Arc::clone(&shared));
		let idle = idle_flush(tx.clone(), Arc::clone(&shared));
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			runtime.spawn(work);
			runtime.spawn(idle);
		} else {
			let spawned = std::thread::Builder::new()
				.name("omp-vocalizer".to_owned())
				.spawn(move || {
					let runtime = tokio::runtime::Builder::new_current_thread()
						.enable_time()
						.build();
					match runtime {
						Ok(runtime) => runtime.block_on(async {
							tokio::join!(work, idle);
						}),
						Err(error) => {
							tracing::warn!(error = %error, "vocalizer runtime unavailable; speech disabled");
						},
					}
				});
			if let Err(error) = spawned {
				tracing::warn!(error = %error, "vocalizer thread unavailable; speech disabled");
			}
		}
		Self { shared, tx, rx }
	}

	/// Effective speech mode from the console: `cl_speech_enabled == false`
	/// or an absent/unknown `cl_speech_mode` reads as [`SpeechMode::Off`].
	#[must_use]
	pub fn mode(con: &Ctx) -> SpeechMode {
		if matches!(con.get("cl_speech_enabled"), Some(Value::Bool(false))) {
			return SpeechMode::Off;
		}
		con.get("cl_speech_mode")
			.and_then(|value| value.as_str()?.parse().ok())
			.unwrap_or(SpeechMode::Off)
	}

	/// Streams an assistant text delta in `assistant` and `all` modes.
	pub fn push_text(&mut self, mode: SpeechMode, delta: &str) {
		if mode.speaks_text() {
			self.push_delta(delta);
		}
	}

	/// Streams a thinking delta in `all` mode only.
	pub fn push_thinking(&mut self, mode: SpeechMode, delta: &str) {
		if mode == SpeechMode::All {
			self.push_delta(delta);
		}
	}

	/// Speaks the trailing partial sentence of a completed assistant message.
	/// `yield` waits for
	/// [`turn_ended`](Self::turn_ended). An aborted message must go through
	/// [`clear`](Self::clear) instead, never here.
	pub fn message_completed(&mut self, mode: SpeechMode) {
		if mode.speaks_text() {
			self.flush();
		}
	}

	/// End of turn: `yield` speaks the whole final
	/// message in one shot; every other mode flushes the live buffer.
	pub fn turn_ended(&mut self, mode: SpeechMode, final_text: &str) {
		match mode {
			SpeechMode::Yield => {
				if !final_text.is_empty() {
					self.push_delta(final_text);
					self.flush();
				}
			},
			SpeechMode::Assistant | SpeechMode::All => self.flush(),
			SpeechMode::Off => {},
		}
	}

	/// Drops every queued segment, stops playback at once, and discards the
	/// buffered partial on a new user message or Esc interrupt.
	pub fn clear(&mut self) {
		self.shared.generation.fetch_add(1, Ordering::AcqRel);
		self.disarm_idle();
		self.shared.cancel.lock().cancel();
		*self.shared.cancel.lock() = tokio_util::sync::CancellationToken::new();
		*self.shared.input.lock() = InputPipeline::Idle;
		self.shared.configuration.lock().take();
		self.rx.drain().for_each(drop);
		self.shared.abort_playback();
		self.shared.open.store(0, Ordering::Release);
	}

	/// Silences playback immediately (Esc rung 4); identical to
	/// [`clear`](Self::clear).
	pub fn silence(&mut self) {
		self.clear();
	}

	/// Whether anything is queued, synthesizing, or audible.
	#[must_use]
	pub fn speaking(&self) -> bool {
		let generation = self.shared.generation.load(Ordering::Acquire);
		!self.rx.is_empty() || self.shared.open.load(Ordering::Acquire) == generation || {
			let rewrites = self.shared.rewrites.lock();
			rewrites.0 == generation && rewrites.1 != 0
		}
	}

	fn push_delta(&mut self, delta: &str) {
		if delta.is_empty() || self.shared.suspended.load(Ordering::Acquire) {
			return;
		}
		let queued = {
			let mut input = self.shared.input.lock();
			if matches!(*input, InputPipeline::Idle) {
				let enhanced =
					matches!(self.shared.con.get("cl_speech_enhanced"), Some(Value::Bool(true)));
				*input = if enhanced {
					InputPipeline::Enhanced(EnhancedInput::new())
				} else {
					InputPipeline::Mechanical(SpeakableStream::new())
				};
			}
			match &mut *input {
				InputPipeline::Idle => Ok(()),
				InputPipeline::Mechanical(speakable) => {
					self.shared.enqueue(&self.tx, speakable.push(delta))
				},
				InputPipeline::Enhanced(enhanced) => {
					let blocks = enhanced.blocks.push(delta);
					enhanced
						.stage(blocks, false)
						.map_or(Ok(()), |text| self.shared.enqueue_rewrite(&self.tx, text))
				},
			}
		};
		if let Err(failure) = queued {
			self.shared.record_failure(failure);
			self.clear();
			return;
		}
		*self.shared.idle_deadline.lock() = Some(Instant::now() + IDLE_FLUSH);
		self.shared.idle.notify_one();
	}

	/// Closes the current utterance: drains the trailing partial and ends
	/// the playback session after it.
	fn flush(&mut self) {
		self.disarm_idle();
		let (queued, had_input) = {
			let mut input = self.shared.input.lock();
			let current = std::mem::replace(&mut *input, InputPipeline::Idle);
			match current {
				InputPipeline::Idle => (Ok(()), false),
				InputPipeline::Mechanical(mut speakable) => {
					(self.shared.enqueue(&self.tx, speakable.flush()), true)
				},
				InputPipeline::Enhanced(mut enhanced) => {
					let blocks = enhanced.blocks.flush();
					(
						enhanced
							.stage(blocks, true)
							.map_or(Ok(()), |text| self.shared.enqueue_rewrite(&self.tx, text)),
						true,
					)
				},
			}
		};
		if let Err(failure) = queued {
			self.shared.record_failure(failure);
			self.clear();
			return;
		}
		if !had_input {
			return;
		}
		let generation = self.shared.generation.load(Ordering::Acquire);
		if let Err(failure) = self.shared.send(&self.tx, Job::End { generation }) {
			self.shared.record_failure(failure);
			self.clear();
		}
		self.shared.configuration.lock().take();
	}

	/// Applies a render-time gain to the current player and all future players.
	pub fn set_gain(&mut self, gain: f32) {
		if !gain.is_finite() {
			self
				.shared
				.record_failure(VocalizerFailure::Playback { source: VoiceError::NonFiniteGain });
			return;
		}
		let gain = gain.max(0.0);
		self
			.shared
			.gain_bits
			.store(gain.to_bits(), Ordering::Release);
		if let Some((_, stream)) = self.shared.playback.lock().as_ref()
			&& let Err(source) = stream.set_gain(gain)
		{
			self
				.shared
				.record_failure(VocalizerFailure::Playback { source });
		}
	}

	/// Suppresses new speech and interrupts current playback. Repeated nested
	/// application scopes collapse to the coordinator's effective boolean.
	pub fn set_suspended(&mut self, suspended: bool) {
		let previous = self.shared.suspended.swap(suspended, Ordering::AcqRel);
		if suspended && !previous {
			self.clear();
		}
	}

	/// Takes the most recent classified backend, queue, or playback failure.
	pub fn take_failure(&mut self) -> Option<VocalizerFailure> {
		self.shared.failure.lock().take()
	}

	fn disarm_idle(&self) {
		self.shared.idle_deadline.lock().take();
		self.shared.idle.notify_one();
	}
}

impl Drop for Vocalizer {
	fn drop(&mut self) {
		self.shared.closed.store(true, Ordering::Release);
		self.clear();
	}
}

/// Console user slot weakly referencing the host's vocalizer for
/// `cl_voice_silence` and application audio effects. The console never keeps a
/// speaker or worker alive after the host drops.
pub struct VoiceSlot(pub Weak<Mutex<Vocalizer>>);

/// Attaches `vocalizer` to `con` so `cl_voice_silence` can reach it.
pub fn install(con: &Ctx, vocalizer: Arc<Mutex<Vocalizer>>) {
	con.insert_user(VoiceSlot(Arc::downgrade(&vocalizer)));
}

omp_con::cmd! {
	/// Silence the vocalizer immediately (Esc rung 4).
	cl_voice_silence() = |ctx, _args| {
		if let Some(vocalizer) = ctx
			.user::<VoiceSlot>()
			.and_then(|slot| slot.0.upgrade())
		{
			vocalizer.lock().silence();
		}
		Ok(())
	};
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::AtomicUsize;

	use omp_con::{DynamicVarSpec, TypeSpec, VarFlags};

	use super::*;

	struct FakeSynth {
		log:      Mutex<Vec<Str>>,
		rewrites: Mutex<Vec<Str>>,
	}

	impl FakeSynth {
		fn new() -> Arc<Self> {
			Arc::new(Self { log: Mutex::new(Vec::new()), rewrites: Mutex::new(Vec::new()) })
		}

		fn spoken(&self) -> Vec<Str> {
			self.log.lock().clone()
		}

		/// Yields to the worker until `count` segments were synthesized.
		async fn wait_for(&self, count: usize) {
			let deadline = Instant::now() + Duration::from_secs(3);
			while self.log.lock().len() < count {
				assert!(Instant::now() < deadline, "synth log stalled at {:?}", self.spoken());
				tokio::time::sleep(Duration::from_millis(5)).await;
			}
		}
	}

	struct ConfigSynth {
		calls:   AtomicUsize,
		configs: Mutex<Vec<SynthConfig>>,
	}

	struct SlowSynth;

	impl SpeechSynth for SlowSynth {
		fn configuration(&self) -> SynthConfig {
			SynthConfig {
				model:       Str::new_static("kokoro"),
				voice:       Str::new_static("af_heart"),
				format:      SynthFormat::Pcm16,
				sample_rate: 24_000,
			}
		}

		fn synthesize(
			&self,
			request: SynthRequest,
		) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>> {
			Box::pin(async move {
				request.cancel.cancelled().await;
				Err(SpeechSynthFailure::Cancelled)
			})
		}
	}

	impl SpeechSynth for ConfigSynth {
		fn configuration(&self) -> SynthConfig {
			let call = self.calls.fetch_add(1, Ordering::AcqRel);
			SynthConfig {
				model:       Str::new_static("kokoro"),
				voice:       if call == 0 {
					Str::new_static("af_heart")
				} else {
					Str::new_static("am_puck")
				},
				format:      SynthFormat::Pcm16,
				sample_rate: 24_000,
			}
		}

		fn synthesize(
			&self,
			request: SynthRequest,
		) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>> {
			Box::pin(async move {
				self.configs.lock().push(request.config);
				Ok(SynthAudio { sample_rate: 24_000, samples: Vec::new() })
			})
		}
	}

	impl SpeechSynth for FakeSynth {
		fn configuration(&self) -> SynthConfig {
			SynthConfig {
				model:       Str::new_static("kokoro"),
				voice:       Str::new_static("af_heart"),
				format:      SynthFormat::Pcm16,
				sample_rate: 24_000,
			}
		}

		fn synthesize(
			&self,
			request: SynthRequest,
		) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>> {
			Box::pin(async move {
				self.log.lock().push(request.text);
				Ok(SynthAudio { sample_rate: 24_000, samples: vec![0.0; 240] })
			})
		}

		fn rewrite(
			&self,
			request: SynthRequest,
		) -> Pin<Box<dyn Future<Output = Result<Option<Str>, SpeechSynthFailure>> + Send + '_>> {
			Box::pin(async move {
				self.rewrites.lock().push(request.text.clone());
				Ok(Some(request.text))
			})
		}
	}

	fn test_ctx() -> Arc<Ctx> {
		Arc::new(Ctx::builder().isolated().build())
	}

	fn enhanced_ctx() -> Arc<Ctx> {
		let ctx = test_ctx();
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("cl_speech_enhanced"),
			desc:    Str::new_static("test"),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::NONE,
			meta:    Arc::from([]),
			default: Value::Bool(true),
		})
		.expect("registers enhanced speech");
		ctx
	}

	/// Lets the worker run and playback settle.
	async fn settle(vocalizer: &Vocalizer) {
		let deadline = Instant::now() + Duration::from_secs(3);
		while vocalizer.speaking() && Instant::now() < deadline {
			tokio::time::sleep(Duration::from_millis(5)).await;
		}
		tokio::time::sleep(Duration::from_millis(20)).await;
	}

	fn spoken_contains(spoken: &[Str], needle: &str) -> bool {
		spoken
			.iter()
			.any(|segment| segment.as_str().contains(needle))
	}

	const TEXT: &str = "Hello there, this is a spoken sentence. ";
	const THINKING: &str = "Secret deliberation that stays private. ";

	#[tokio::test]
	async fn assistant_mode_speaks_text_not_thinking() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_text(SpeechMode::Assistant, TEXT);
		vocalizer.push_thinking(SpeechMode::Assistant, THINKING);
		vocalizer.message_completed(SpeechMode::Assistant);
		synth.wait_for(1).await;
		settle(&vocalizer).await;
		let spoken = synth.spoken();
		assert!(spoken_contains(&spoken, "Hello there"), "{spoken:?}");
		assert!(!spoken_contains(&spoken, "Secret"), "{spoken:?}");
	}

	#[tokio::test]
	async fn all_mode_speaks_thinking_too() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_thinking(SpeechMode::All, THINKING);
		vocalizer.push_text(SpeechMode::All, TEXT);
		vocalizer.message_completed(SpeechMode::All);
		synth.wait_for(2).await;
		settle(&vocalizer).await;
		let spoken = synth.spoken();
		assert!(spoken_contains(&spoken, "Secret deliberation"), "{spoken:?}");
		assert!(spoken_contains(&spoken, "Hello there"), "{spoken:?}");
		assert!(!vocalizer.speaking());
	}

	#[tokio::test]
	async fn yield_mode_speaks_only_at_turn_end() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_text(SpeechMode::Yield, TEXT);
		vocalizer.push_thinking(SpeechMode::Yield, THINKING);
		vocalizer.message_completed(SpeechMode::Yield);
		assert!(!vocalizer.speaking());
		settle(&vocalizer).await;
		assert!(synth.spoken().is_empty());
		vocalizer.turn_ended(SpeechMode::Yield, "The final answer is forty-two.");
		synth.wait_for(1).await;
		settle(&vocalizer).await;
		let spoken = synth.spoken();
		assert_eq!(spoken.len(), 1, "{spoken:?}");
		assert!(spoken_contains(&spoken, "final answer is forty-two"), "{spoken:?}");
	}

	#[tokio::test]
	async fn off_mode_speaks_nothing() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_text(SpeechMode::Off, TEXT);
		vocalizer.push_thinking(SpeechMode::Off, THINKING);
		vocalizer.message_completed(SpeechMode::Off);
		vocalizer.turn_ended(SpeechMode::Off, TEXT);
		assert!(!vocalizer.speaking());
		settle(&vocalizer).await;
		assert!(synth.spoken().is_empty());
	}

	#[tokio::test]
	async fn clear_drops_queued_segments_and_bumps_generation() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		let paragraph = "First sentence of a long reply. Second sentence follows it. Third sentence \
		                 keeps going. Fourth sentence is here too. Fifth sentence ends the \
		                 paragraph. ";
		vocalizer.push_text(SpeechMode::Assistant, paragraph);
		assert!(vocalizer.speaking(), "segments are queued before the worker runs");
		let before = vocalizer.shared.generation.load(Ordering::Acquire);
		vocalizer.clear();
		assert_eq!(vocalizer.shared.generation.load(Ordering::Acquire), before + 1);
		assert!(!vocalizer.speaking());
		settle(&vocalizer).await;
		assert!(synth.spoken().is_empty(), "{:?}", synth.spoken());

		vocalizer.push_text(SpeechMode::Assistant, "A fresh sentence after the clear. ");
		vocalizer.message_completed(SpeechMode::Assistant);
		synth.wait_for(1).await;
		settle(&vocalizer).await;
		let spoken = synth.spoken();
		assert_eq!(spoken.len(), 1, "{spoken:?}");
		assert!(spoken_contains(&spoken, "fresh sentence"), "{spoken:?}");
	}

	#[tokio::test]
	async fn message_completed_flushes_partial_sentence() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_text(SpeechMode::Assistant, "Trailing partial");
		tokio::time::sleep(Duration::from_millis(30)).await;
		assert!(synth.spoken().is_empty(), "no boundary yet");
		vocalizer.message_completed(SpeechMode::Assistant);
		synth.wait_for(1).await;
		settle(&vocalizer).await;
		let spoken = synth.spoken();
		assert_eq!(spoken.len(), 1, "{spoken:?}");
		assert!(spoken_contains(&spoken, "Trailing partial"), "{spoken:?}");
		assert!(!vocalizer.speaking());
	}

	#[test]
	fn works_without_a_current_runtime() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.push_text(SpeechMode::Assistant, TEXT);
		vocalizer.message_completed(SpeechMode::Assistant);
		let deadline = std::time::Instant::now() + Duration::from_secs(3);
		while synth.log.lock().is_empty() {
			assert!(std::time::Instant::now() < deadline, "dedicated worker thread never ran");
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(spoken_contains(&synth.spoken(), "Hello there"));
		while vocalizer.speaking() && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(5));
		}
		assert!(!vocalizer.speaking());
	}

	#[tokio::test]
	async fn suspension_stops_current_audio_and_gates_future_segments() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer.set_suspended(true);
		vocalizer.push_text(SpeechMode::Assistant, TEXT);
		vocalizer.message_completed(SpeechMode::Assistant);
		tokio::time::sleep(Duration::from_millis(20)).await;
		assert!(synth.spoken().is_empty());
		vocalizer.set_suspended(false);
		vocalizer.push_text(SpeechMode::Assistant, TEXT);
		vocalizer.message_completed(SpeechMode::Assistant);
		synth.wait_for(1).await;
		assert!(spoken_contains(&synth.spoken(), "Hello there"));
	}

	#[tokio::test]
	async fn bounded_queue_reports_typed_backpressure() {
		let mut vocalizer = Vocalizer::new(Arc::new(SlowSynth), test_ctx());
		let mut text = String::new();
		for index in 0..(JOB_CAPACITY * 3) {
			use std::fmt::Write as _;
			let _ = write!(text, "Sentence number {index} is deliberately long enough to emit. ");
		}
		vocalizer.push_text(SpeechMode::Assistant, &text);
		assert!(matches!(
			vocalizer.take_failure(),
			Some(VocalizerFailure::Backpressure { capacity: JOB_CAPACITY })
		));
		vocalizer.clear();
	}

	#[tokio::test]
	async fn model_voice_and_format_are_latched_per_utterance() {
		let synth =
			Arc::new(ConfigSynth { calls: AtomicUsize::new(0), configs: Mutex::new(Vec::new()) });
		let mut vocalizer = Vocalizer::new(synth.clone(), test_ctx());
		vocalizer
			.push_text(SpeechMode::Assistant, "First complete sentence. Second complete sentence.");
		vocalizer.message_completed(SpeechMode::Assistant);
		let deadline = Instant::now() + Duration::from_secs(3);
		while synth.configs.lock().len() < 2 && Instant::now() < deadline {
			tokio::time::sleep(Duration::from_millis(5)).await;
		}
		let first = synth.configs.lock().clone();
		assert_eq!(first.len(), 2);
		assert_eq!(first[0], first[1]);
		assert_eq!(first[0].voice.as_str(), "af_heart");

		vocalizer.push_text(SpeechMode::Assistant, "Third complete sentence.");
		vocalizer.message_completed(SpeechMode::Assistant);
		while synth.configs.lock().len() < 3 && Instant::now() < deadline {
			tokio::time::sleep(Duration::from_millis(5)).await;
		}
		assert_eq!(synth.configs.lock()[2].voice.as_str(), "am_puck");
	}

	#[tokio::test]
	async fn enhanced_mode_rewrites_fence_safe_blocks_in_order() {
		let synth = FakeSynth::new();
		let mut vocalizer = Vocalizer::new(synth.clone(), enhanced_ctx());
		vocalizer.push_text(
			SpeechMode::Assistant,
			"First paragraph for speech.\n\n```rust\nnever_speak();\n```\n\nSecond paragraph.",
		);
		vocalizer.message_completed(SpeechMode::Assistant);
		synth.wait_for(2).await;
		settle(&vocalizer).await;
		let rewrites = synth.rewrites.lock().clone();
		assert_eq!(rewrites.len(), 2, "{rewrites:?}");
		assert!(rewrites[0].contains("First paragraph"));
		assert!(rewrites[1].contains("Second paragraph"));
		assert!(!rewrites.iter().any(|block| block.contains("never_speak")));
	}

	#[test]
	fn mode_reads_console_var_by_name() {
		let ctx = Ctx::builder().isolated().build();
		assert_eq!(Vocalizer::mode(&ctx), SpeechMode::Off);
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("cl_speech_mode"),
			desc:    Str::new_static("test"),
			ty:      TypeSpec::STR,
			flags:   VarFlags::NONE,
			meta:    Arc::from([]),
			default: Value::Str(Str::new_static("all")),
		})
		.expect("registers");
		assert_eq!(Vocalizer::mode(&ctx), SpeechMode::All);
		ctx.register_dynamic_var(DynamicVarSpec {
			name:    Str::new_static("cl_speech_enabled"),
			desc:    Str::new_static("test"),
			ty:      TypeSpec::BOOL,
			flags:   VarFlags::NONE,
			meta:    Arc::from([]),
			default: Value::Bool(false),
		})
		.expect("registers");
		assert_eq!(Vocalizer::mode(&ctx), SpeechMode::Off);
	}

	#[tokio::test]
	async fn silence_command_is_registered() {
		let synth = FakeSynth::new();
		let vocalizer = Arc::new(Mutex::new(Vocalizer::new(synth.clone(), test_ctx())));
		let ctx = Ctx::new();
		ctx.run("cl_voice_silence").expect("no-op without a slot");
		install(&ctx, Arc::clone(&vocalizer));
		vocalizer
			.lock()
			.push_text(SpeechMode::Assistant, "Queued sentence that will be silenced. ");
		assert!(vocalizer.lock().speaking());
		ctx.run("cl_voice_silence").expect("command runs");
		assert!(!vocalizer.lock().speaking());
		tokio::time::sleep(Duration::from_millis(30)).await;
		assert!(synth.spoken().is_empty());
	}
}
