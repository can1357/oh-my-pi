//! Mono microphone capture and gapless streaming speaker playback.
//!
//! The platform backend performs device-format conversion and resampling. This
//! module owns the stable queue, gain, level, drain, and abort semantics used
//! by higher-level voice features.

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU32, Ordering},
};

use flume::{Receiver, TryRecvError, TrySendError};
use omp_core::Str;
use parking_lot::Mutex;
use tokio::sync::{Notify, watch};

use crate::{
	AudioDirection, VoiceError, VoiceResult,
	device::{CaptureDevice, DeviceConfig, PlaybackDevice, playback_drain_periods},
};

#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
const PLAYBACK_DRAIN_MARGIN_CALLBACKS: usize = 1;
/// Maximum rendered chunks buffered ahead of the native speaker. At a 20 ms
/// callback period this permits short scheduling bursts without unbounded
/// multi-utterance growth.
const PLAYBACK_QUEUE_CAPACITY: usize = 128;

mod level {
	use tokio::sync::watch::Receiver;

	/// A receiver for normalized RMS audio levels in `[0.0, 1.0]`.
	#[derive(Clone, Debug)]
	pub struct AudioLevelStream {
		receiver: Receiver<f32>,
	}

	impl AudioLevelStream {
		pub(super) const fn new(receiver: Receiver<f32>) -> Self {
			Self { receiver }
		}

		/// Return the most recently observed RMS level without waiting.
		pub fn latest(&self) -> f32 {
			*self.receiver.borrow()
		}

		/// Wait for and return the next level, or `None` after the device closes.
		pub async fn next(&mut self) -> Option<f32> {
			self.receiver.changed().await.ok()?;
			let level = *self.receiver.borrow_and_update();
			Some(level)
		}
	}
}

pub use level::AudioLevelStream;

/// Shared playback lifecycle state that may be awaited independently of the
/// device handle.
pub struct PlaybackState {
	gain_bits:  AtomicU32,
	input_gate: Mutex<()>,
	accepting:  AtomicBool,
	drained:    AtomicBool,
	stopped:    AtomicBool,
	notify:     Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits:  AtomicU32::new(1.0_f32.to_bits()),
			input_gate: Mutex::new(()),
			accepting:  AtomicBool::new(true),
			drained:    AtomicBool::new(false),
			stopped:    AtomicBool::new(false),
			notify:     Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	fn finish_input(&self) {
		let _gate = self.input_gate.lock();
		self.accepting.store(false, Ordering::Release);
		self.notify.notify_waiters();
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		let _gate = self.input_gate.lock();
		self.accepting.store(false, Ordering::Release);
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	/// Wait until queued samples have reached the speaker or playback has been
	/// aborted or lost its device.
	pub async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}

	/// Return whether playback input has finished and the backend has flushed
	/// all queued samples.
	pub fn is_drained(&self) -> bool {
		self.drained.load(Ordering::Acquire)
	}

	/// Return whether playback was stopped or lost its render path.
	pub fn is_stopped(&self) -> bool {
		self.stopped.load(Ordering::Acquire)
	}
}

struct FillGuard {
	state: Arc<PlaybackState>,
	level: watch::Sender<f32>,
}

impl Drop for FillGuard {
	fn drop(&mut self) {
		self.state.mark_stopped();
		self.level.send_replace(0.0);
	}
}

/// Cloneable producer endpoint for a running playback stream.
#[derive(Clone)]
pub struct PlaybackWriter {
	tx:    flume::Sender<Vec<f32>>,
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue borrowed mono samples without blocking the caller.
	pub fn write(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		self.write_owned(samples.to_vec())
	}

	/// Queue an owned mono sample buffer without copying it.
	pub fn write_owned(&self, samples: Vec<f32>) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		let _gate = self.state.input_gate.lock();
		if !self.state.accepting.load(Ordering::Acquire) || self.state.stopped.load(Ordering::Acquire)
		{
			return Err(VoiceError::PlaybackClosed);
		}
		match self.tx.try_send(samples) {
			Ok(()) => Ok(()),
			Err(TrySendError::Disconnected(_)) => Err(VoiceError::PlaybackClosed),
			Err(TrySendError::Full(_)) => {
				Err(VoiceError::PlaybackBackpressure { capacity: PLAYBACK_QUEUE_CAPACITY })
			},
		}
	}

	/// Queue an owned mono sample buffer while asynchronously applying bounded
	/// speaker backpressure. Cancellation or device teardown closes the queue.
	pub async fn write_owned_async(&self, samples: Vec<f32>) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		let closed = self.state.notify.notified();
		tokio::pin!(closed);
		closed.as_mut().enable();
		{
			let _gate = self.state.input_gate.lock();
			if !self.state.accepting.load(Ordering::Acquire)
				|| self.state.stopped.load(Ordering::Acquire)
			{
				return Err(VoiceError::PlaybackClosed);
			}
		}
		tokio::select! {
			biased;
			() = &mut closed => Err(VoiceError::PlaybackClosed),
			result = self.tx.send_async(samples) => result.map_err(|_| VoiceError::PlaybackClosed),
		}
	}
}

/// A running speaker stream with one gapless FIFO across every write.
#[must_use]
pub struct PlaybackStream {
	device: Option<PlaybackDevice>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
	levels: AudioLevelStream,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub fn start(sample_rate: u32) -> VoiceResult<Self> {
		Self::start_on(sample_rate, None)
	}

	/// Open and start a stable speaker endpoint, or the system default when
	/// omitted.
	#[tracing::instrument(
		level = "debug",
		name = "device_open",
		skip_all,
		fields(
			audio.direction = "playback",
			audio.sample_rate = sample_rate,
			audio.device_id = device_id.unwrap_or_default()
		)
	)]
	pub fn start_on(sample_rate: u32, device_id: Option<&str>) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate).map_err(|error| {
			tracing::warn!(
				audio.direction = "playback",
				audio.sample_rate = sample_rate,
				error = %error,
				"voice device configuration rejected"
			);
			error
		})?;
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::bounded::<Vec<f32>>(PLAYBACK_QUEUE_CAPACITY);
		let (level_tx, level_rx) = watch::channel(0.0);
		let callback_state = Arc::clone(&state);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let config = DeviceConfig {
			sample_rate,
			period_ms: PLAYBACK_PERIOD_MS,
			device_id: device_id.map(Str::from),
		};
		let drain_callbacks =
			(playback_drain_periods(config.clone()) as usize) + PLAYBACK_DRAIN_MARGIN_CALLBACKS;
		let guard = FillGuard { state: Arc::clone(&state), level: level_tx.clone() };
		let device = PlaybackDevice::start(
			config,
			Box::new(move |output| {
				let _ = &guard;
				fill_playback(
					&rx,
					&mut current,
					&mut cursor,
					output,
					&callback_state,
					&mut empty_callbacks,
					drain_callbacks,
				);
				level_tx.send_replace(rms_level(output));
			}),
		)
		.map_err(|source| {
			let error = unavailable(AudioDirection::Playback, source);
			tracing::warn!(
				audio.direction = "playback",
				error = %error,
				"voice device open failed"
			);
			error
		})?;
		tracing::info!(
			audio.direction = "playback",
			audio.sample_rate = sample_rate,
			"voice device opened"
		);

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { tx, state: Arc::clone(&state) }),
			state,
			levels: AudioLevelStream::new(level_rx),
		})
	}

	/// Clone the producer used to append audio to this stream's FIFO.
	pub fn writer(&self) -> VoiceResult<PlaybackWriter> {
		self.writer.clone().ok_or(VoiceError::PlaybackClosed)
	}

	/// Clone the shared playback lifecycle state.
	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	/// Subscribe to RMS levels measured after render-time gain is applied.
	pub fn levels(&self) -> AudioLevelStream {
		self.levels.clone()
	}

	/// Prevent all writers, including existing clones, from appending more
	/// samples. Already queued audio continues gaplessly.
	pub fn finish_input(&mut self) {
		self.state.finish_input();
		self.writer.take();
	}

	/// Set render-time gain. Changes also affect samples already in the queue;
	/// negative values clamp to silence.
	pub fn set_gain(&self, gain: f32) -> VoiceResult<()> {
		if !gain.is_finite() {
			return Err(VoiceError::NonFiniteGain);
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Finish input, wait until the bounded device FIFO has flushed, then
	/// release the speaker.
	pub async fn drain(&mut self) -> VoiceResult<()> {
		self.finish_input();
		self.state.wait_for_drain().await;
		self.stop_device()
	}

	/// Drop queued audio immediately and release the default speaker.
	pub fn abort(&mut self) -> VoiceResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		self.stop_device()
	}

	/// Stop playback immediately. Equivalent to [`Self::abort`].
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.abort()
	}

	fn stop_device(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		match device.stop() {
			Ok(()) => {
				tracing::info!(audio.direction = "playback", "voice device closed");
				Ok(())
			},
			Err(error) => {
				tracing::warn!(
					audio.direction = "playback",
					error = %error,
					"voice playback stop failed"
				);
				Err(error)
			},
		}
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.abort();
	}
}

/// A running microphone stream delivering non-empty mono `f32` chunks on the
/// backend's realtime thread.
#[must_use]
pub struct CaptureStream {
	device: Option<CaptureDevice>,
	levels: AudioLevelStream,
}

impl CaptureStream {
	/// Open the default microphone at `sample_rate`. `on_audio` runs on the
	/// realtime audio thread and must not block.
	pub fn start<C>(sample_rate: u32, on_audio: C) -> VoiceResult<Self>
	where
		C: FnMut(&[f32]) + Send + 'static,
	{
		Self::start_on(sample_rate, None, on_audio)
	}

	/// Open a stable microphone endpoint, or the system default when omitted.
	///
	/// `on_audio` runs on the realtime audio thread and must not block.
	#[tracing::instrument(
		level = "debug",
		name = "device_open",
		skip_all,
		fields(
			audio.direction = "capture",
			audio.sample_rate = sample_rate,
			audio.device_id = device_id.unwrap_or_default()
		)
	)]
	pub fn start_on<C>(
		sample_rate: u32,
		device_id: Option<&str>,
		mut on_audio: C,
	) -> VoiceResult<Self>
	where
		C: FnMut(&[f32]) + Send + 'static,
	{
		let sample_rate = audio_sample_rate(sample_rate).map_err(|error| {
			tracing::warn!(
				audio.direction = "capture",
				audio.sample_rate = sample_rate,
				error = %error,
				"voice device configuration rejected"
			);
			error
		})?;
		let config = DeviceConfig {
			sample_rate,
			period_ms: CAPTURE_PERIOD_MS,
			device_id: device_id.map(Str::from),
		};
		let (level_tx, level_rx) = watch::channel(0.0);
		let device = CaptureDevice::start(
			config,
			Box::new(move |samples| {
				if !samples.is_empty() {
					level_tx.send_replace(rms_level(samples));
					on_audio(samples);
				}
			}),
		)
		.map_err(|source| {
			let error = unavailable(AudioDirection::Capture, source);
			tracing::warn!(
				audio.direction = "capture",
				error = %error,
				"voice device open failed"
			);
			error
		})?;
		tracing::info!(
			audio.direction = "capture",
			audio.sample_rate = sample_rate,
			"voice device opened"
		);
		Ok(Self { device: Some(device), levels: AudioLevelStream::new(level_rx) })
	}

	/// Subscribe to normalized microphone RMS levels.
	pub fn levels(&self) -> AudioLevelStream {
		self.levels.clone()
	}

	/// Stop capture immediately and release the microphone. Idempotent.
	pub fn stop(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		match device.stop() {
			Ok(()) => {
				tracing::info!(audio.direction = "capture", "voice device closed");
				Ok(())
			},
			Err(error) => {
				tracing::warn!(
					audio.direction = "capture",
					error = %error,
					"voice capture stop failed"
				);
				Err(error)
			},
		}
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

fn audio_sample_rate(sample_rate: u32) -> VoiceResult<u32> {
	if !(8_000..=384_000).contains(&sample_rate) {
		return Err(VoiceError::UnsupportedSampleRate { sample_rate });
	}
	Ok(sample_rate)
}

fn unavailable(direction: AudioDirection, source: VoiceError) -> VoiceError {
	match source {
		VoiceError::UnsupportedPlatform { .. } => source,
		VoiceError::Backend { source } => VoiceError::DeviceUnavailable { direction, source },
		_ => source,
	}
}

fn rms_level(samples: &[f32]) -> f32 {
	if samples.is_empty() {
		return 0.0;
	}
	let sum_squares = samples
		.iter()
		.map(|sample| f64::from(*sample) * f64::from(*sample))
		.sum::<f64>();
	((sum_squares / samples.len() as f64).sqrt() as f32).clamp(0.0, 1.0)
}

fn fill_playback(
	rx: &Receiver<Vec<f32>>,
	current: &mut Vec<f32>,
	cursor: &mut usize,
	output: &mut [f32],
	state: &PlaybackState,
	empty_callbacks: &mut usize,
	drain_callbacks: usize,
) {
	output.fill(0.0);
	if state.stopped.load(Ordering::Acquire) {
		return;
	}

	let gain = state.gain();
	let mut output_offset = 0;
	while output_offset < output.len() {
		if *cursor == current.len() {
			match rx.try_recv() {
				Ok(next) => {
					*current = next;
					*cursor = 0;
					*empty_callbacks = 0;
				},
				Err(TryRecvError::Empty) => {
					if state.accepting.load(Ordering::Acquire) {
						*empty_callbacks = 0;
					} else {
						*empty_callbacks += 1;
					}
					if *empty_callbacks >= drain_callbacks {
						state.mark_drained();
					}
					break;
				},
				Err(TryRecvError::Disconnected) => {
					*empty_callbacks += 1;
					if *empty_callbacks >= drain_callbacks {
						state.mark_drained();
					}
					break;
				},
			}
		}

		let count = (current.len() - *cursor).min(output.len() - output_offset);
		let source = &current[*cursor..*cursor + count];
		let destination = &mut output[output_offset..output_offset + count];
		if gain == 1.0 {
			destination.copy_from_slice(source);
		} else {
			for (destination, source) in destination.iter_mut().zip(source) {
				*destination = *source * gain;
			}
		}
		*cursor += count;
		output_offset += count;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const LOCAL_DRAIN_CALLBACKS: usize = 3 + PLAYBACK_DRAIN_MARGIN_CALLBACKS;

	fn render(
		rx: &Receiver<Vec<f32>>,
		state: &PlaybackState,
		current: &mut Vec<f32>,
		cursor: &mut usize,
		empty: &mut usize,
		output: &mut [f32],
	) {
		fill_playback(rx, current, cursor, output, state, empty, LOCAL_DRAIN_CALLBACKS);
	}

	#[test]
	fn queue_is_gapless_and_gain_applies_at_render_time() {
		let state = PlaybackState::new();
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		tx.send(vec![1.0, -1.0]).unwrap();
		tx.send(vec![0.5, -0.5]).unwrap();
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty = 0;
		let mut output = [9.0; 5];

		render(&rx, &state, &mut current, &mut cursor, &mut empty, &mut output);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
	}

	#[test]
	fn finish_drains_even_when_writer_clones_exist() {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded();
		let writer = PlaybackWriter { tx, state: Arc::clone(&state) };
		let stale_writer = writer.clone();
		writer.write_owned(vec![0.25, 0.5]).unwrap();
		state.finish_input();
		assert!(matches!(stale_writer.write(&[1.0]), Err(VoiceError::PlaybackClosed)));
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty = 0;
		let mut output = [0.0; 2];
		for _ in 0..=LOCAL_DRAIN_CALLBACKS {
			render(&rx, &state, &mut current, &mut cursor, &mut empty, &mut output);
		}
		assert!(state.is_drained());
	}

	#[test]
	fn nonblocking_writer_reports_typed_backpressure() {
		let state = Arc::new(PlaybackState::new());
		let (tx, _rx) = flume::bounded(PLAYBACK_QUEUE_CAPACITY);
		let writer = PlaybackWriter { tx, state };
		for _ in 0..PLAYBACK_QUEUE_CAPACITY {
			writer.write_owned(vec![0.25]).expect("bounded chunk fits");
		}
		assert!(matches!(
			writer.write_owned(vec![0.5]),
			Err(VoiceError::PlaybackBackpressure { capacity: PLAYBACK_QUEUE_CAPACITY })
		));
	}

	#[test]
	fn widened_backlog_is_not_drained_within_local_margin() {
		let state = PlaybackState::new();
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		drop(tx);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty = 0;
		let mut output = [0.0; 2];
		let widened_drain_callbacks = LOCAL_DRAIN_CALLBACKS * 4;

		for _ in 0..LOCAL_DRAIN_CALLBACKS {
			fill_playback(
				&rx,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty,
				widened_drain_callbacks,
			);
		}
		assert!(!state.is_drained());

		while empty < widened_drain_callbacks {
			fill_playback(
				&rx,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty,
				widened_drain_callbacks,
			);
		}
		assert!(state.is_drained());
	}

	#[test]
	fn abort_silences_queued_audio_and_is_idempotent() {
		let state = PlaybackState::new();
		let (tx, rx) = flume::unbounded();
		tx.send(vec![1.0, 1.0]).unwrap();
		state.mark_stopped();
		state.mark_stopped();
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty = 0;
		let mut output = [9.0; 2];
		render(&rx, &state, &mut current, &mut cursor, &mut empty, &mut output);
		assert_eq!(output, [0.0, 0.0]);
		assert!(state.is_stopped());
	}

	#[test]
	fn levels_are_normalized_rms() {
		assert_eq!(rms_level(&[]), 0.0);
		assert!((rms_level(&[0.5, -0.5]) - 0.5).abs() < f32::EPSILON);
		assert_eq!(rms_level(&[2.0, -2.0]), 1.0);
	}

	#[test]
	fn sample_rate_and_gain_reject_invalid_values() {
		assert!(matches!(audio_sample_rate(7_999), Err(VoiceError::UnsupportedSampleRate { .. })));
		let state = PlaybackState::new();
		assert!(!f32::from_bits(state.gain_bits.load(Ordering::Acquire)).is_nan());
	}
}
