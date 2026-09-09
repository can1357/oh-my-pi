//! Cross-platform microphone capture and streaming speaker playback.
//!
//! The per-platform backends in [`crate::device`] own device access, format
//! conversion, channel mixing, and resampling. The engine exposes one stable
//! mono `f32` contract: the N-API classes in pi-natives adapt it to
//! TypeScript, and [`crate::live`] shares [`PlaybackStream`] for remote-audio
//! rendering.

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU32, Ordering},
};

use flume::TryRecvError;
use tokio::sync::Notify;

use crate::{
	VoiceResult,
	device::{CaptureDevice, DeviceConfig, PlaybackDevice, playback_drain_periods},
};

// PulseAudio TCP playback stutters with a 20 ms target buffer; 50 ms absorbs
// transport jitter while preserving interactive latency.
#[cfg(target_os = "linux")]
const PLAYBACK_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const PLAYBACK_PERIOD_MS: u32 = 20;
#[cfg(target_os = "linux")]
const CAPTURE_PERIOD_MS: u32 = 50;
#[cfg(not(target_os = "linux"))]
const CAPTURE_PERIOD_MS: u32 = 20;
// Backends queue up to `device::playback_drain_periods` periods (three for
// AudioQueue buffers/WASAPI padding; PulseAudio scales this with the widened
// remote/`PULSE_LATENCY_MSEC` backlog — see that function). Draining needs
// that many silence periods COMMITTED to the OS behind the tail: once the
// last is accepted into the backend's FIFO, everything ahead of it has
// played. The callback that marks drained races teardown — on Linux the
// delivery gate may cancel that callback's own write after `wait_for_drain`
// wakes — so count one extra empty callback: the racy, possibly-uncommitted
// write is always the last one, which is margin rather than accounted flush.
const PLAYBACK_DRAIN_MARGIN_CALLBACKS: usize = 1;

/// Shared render-time state for one playback device: gain, drain, stop.
///
/// Held as an `Arc` by both the stream and its N-API wrapper so
/// [`PlaybackState::wait_for_drain`] can outlive the stream lock.
pub struct PlaybackState {
	gain_bits: AtomicU32,
	drained:   AtomicBool,
	stopped:   AtomicBool,
	notify:    Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits: AtomicU32::new(1.0f32.to_bits()),
			drained:   AtomicBool::new(false),
			stopped:   AtomicBool::new(false),
			notify:    Notify::new(),
		}
	}

	fn gain(&self) -> f32 {
		f32::from_bits(self.gain_bits.load(Ordering::Acquire))
	}

	fn set_gain(&self, gain: f32) {
		self.gain_bits.store(gain.to_bits(), Ordering::Release);
	}

	fn mark_drained(&self) {
		if !self.drained.swap(true, Ordering::AcqRel) {
			self.notify.notify_waiters();
		}
	}

	fn mark_stopped(&self) {
		self.stopped.store(true, Ordering::Release);
		self.notify.notify_waiters();
	}

	/// Resolve once every queued sample reached the speaker (or the stream
	/// stopped). Used by the N-API `AudioPlayback.end()` graceful-close path.
	pub async fn wait_for_drain(&self) {
		loop {
			let notified = self.notify.notified();
			if self.drained.load(Ordering::Acquire) || self.stopped.load(Ordering::Acquire) {
				return;
			}
			notified.await;
		}
	}
}

/// Wakes drain waiters when the backend drops the fill callback (device loss
/// or stop) so `wait_for_drain` can never outlive the render path.
struct FillGuard {
	state: Arc<PlaybackState>,
}

impl Drop for FillGuard {
	fn drop(&mut self) {
		self.state.mark_stopped();
	}
}

/// Producer endpoint for one native playback device. Cloned into the WebRTC
/// remote-audio decoder so it can feed the same speaker stream.
#[derive(Clone)]
pub struct PlaybackWriter {
	tx:    flume::Sender<Vec<f32>>,
	state: Arc<PlaybackState>,
}

impl PlaybackWriter {
	/// Queue mono floating-point samples without blocking the caller.
	pub fn write(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() {
			return Ok(());
		}
		if self.state.stopped.load(Ordering::Acquire) || self.state.drained.load(Ordering::Acquire) {
			return Err("Native audio playback is closed".to_owned());
		}
		self
			.tx
			.send(samples.to_vec())
			.map_err(|_| "Native audio playback is closed".to_owned())
	}
}

/// Running mono playback stream shared by N-API playback and native WebRTC.
pub struct PlaybackStream {
	device: Option<PlaybackDevice>,
	writer: Option<PlaybackWriter>,
	state:  Arc<PlaybackState>,
}

impl PlaybackStream {
	/// Open and start the default speaker at the requested logical sample rate.
	pub fn start(sample_rate: u32) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		let callback_state = Arc::clone(&state);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let config = DeviceConfig { sample_rate, period_ms: PLAYBACK_PERIOD_MS };
		let drain_callbacks =
			(playback_drain_periods(config) as usize) + PLAYBACK_DRAIN_MARGIN_CALLBACKS;
		// The guard travels inside the fill closure: if the backend drops the
		// callback for any reason (worker exit on device loss, stop), waiters
		// blocked in `wait_for_drain` wake instead of hanging forever.
		let guard = FillGuard { state: Arc::clone(&state) };
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
			}),
		)
		.map_err(|error| format!("Failed to open the default speaker: {error}"))?;

		Ok(Self {
			device: Some(device),
			writer: Some(PlaybackWriter { tx, state: Arc::clone(&state) }),
			state,
		})
	}

	/// Clone the producer endpoint used by the remote-audio decoder.
	pub fn writer(&self) -> VoiceResult<PlaybackWriter> {
		self
			.writer
			.clone()
			.ok_or_else(|| "Native audio playback is closed".to_owned())
	}

	/// Shared render-time state, cloned out so callers can await drain after
	/// releasing the stream lock.
	pub fn state(&self) -> Arc<PlaybackState> {
		Arc::clone(&self.state)
	}

	/// Close the producer side so the render callback can detect drain.
	pub fn finish_input(&mut self) {
		self.writer.take();
	}

	/// Scale audio at render time so gain changes affect already queued
	/// samples. Rejects non-finite gains; negative gains clamp to silence.
	pub fn set_gain(&self, gain: f32) -> VoiceResult<()> {
		if !gain.is_finite() {
			return Err("Audio playback gain must be finite".to_owned());
		}
		self.state.set_gain(gain.max(0.0));
		Ok(())
	}

	/// Stop playback immediately and release the default speaker.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.writer.take();
		self.state.mark_stopped();
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Bounds the logical rate to what OS converters accept before device open.
fn audio_sample_rate(sample_rate: u32) -> VoiceResult<u32> {
	if !(8_000..=384_000).contains(&sample_rate) {
		return Err(format!("Unsupported audio sample rate {sample_rate}"));
	}
	Ok(sample_rate)
}

fn fill_playback(
	rx: &flume::Receiver<Vec<f32>>,
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
					*empty_callbacks = 0;
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

/// Running default-microphone capture delivering low-latency mono `f32`
/// chunks to its callback. Wraps the platform device so N-API callers never
/// see backend types.
pub struct CaptureStream {
	device: Option<CaptureDevice>,
}

impl CaptureStream {
	/// Open the default microphone at the requested sample rate. `on_audio`
	/// runs on the realtime audio thread — it must not block.
	pub fn start<C>(sample_rate: u32, mut on_audio: C) -> VoiceResult<Self>
	where
		C: FnMut(&[f32]) + Send + 'static,
	{
		let sample_rate = audio_sample_rate(sample_rate)?;
		let config = DeviceConfig { sample_rate, period_ms: CAPTURE_PERIOD_MS };
		let device = CaptureDevice::start(
			config,
			Box::new(move |samples| {
				if !samples.is_empty() {
					on_audio(samples);
				}
			}),
		)
		.map_err(|error| format!("Failed to open the default microphone: {error}"))?;
		Ok(Self { device: Some(device) })
	}

	/// Stop capture immediately and release the microphone.
	pub fn stop(&mut self) -> VoiceResult<()> {
		let Some(mut device) = self.device.take() else {
			return Ok(());
		};
		device.stop()
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		mem::forget,
		sync::atomic::AtomicUsize,
		thread::sleep,
		time::{Duration, Instant},
	};

	use super::*;

	// Base three-period assumption (`PULSE_BACKLOG_PERIODS` on Linux; fixed
	// for other backends) plus the one callback of teardown-race margin
	// (`PLAYBACK_DRAIN_MARGIN_CALLBACKS`) — what every backend uses for a
	// period-sized local target.
	const LOCAL_DRAIN_CALLBACKS: usize = 3 + PLAYBACK_DRAIN_MARGIN_CALLBACKS;

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let state = PlaybackState::new();
		state.set_gain(0.5);
		let (tx, rx) = flume::unbounded();
		tx.send(vec![1.0, -1.0]).expect("receiver is live");
		tx.send(vec![0.5, -0.5]).expect("receiver is live");
		drop(tx);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [9.0; 5];

		fill_playback(
			&rx,
			&mut current,
			&mut cursor,
			&mut output,
			&state,
			&mut empty_callbacks,
			LOCAL_DRAIN_CALLBACKS,
		);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while empty_callbacks < LOCAL_DRAIN_CALLBACKS {
			silence.fill(1.0);
			fill_playback(
				&rx,
				&mut current,
				&mut cursor,
				&mut silence,
				&state,
				&mut empty_callbacks,
				LOCAL_DRAIN_CALLBACKS,
			);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				state.drained.load(Ordering::Acquire),
				empty_callbacks >= LOCAL_DRAIN_CALLBACKS
			);
		}
	}

	/// Regression guard: a widened playback backlog (remote `PULSE_SERVER` or
	/// `PULSE_LATENCY_MSEC`) must not be declared drained after only the
	/// local three-period margin — queued audio would still be flushing to
	/// the speaker and `AudioPlayback.end()` would clip it. Draining must
	/// wait out the full widened `drain_callbacks` count.
	#[test]
	fn widened_backlog_is_not_drained_within_local_margin() {
		let state = PlaybackState::new();
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		drop(tx);
		let mut current = Vec::new();
		let mut cursor = 0;
		let mut empty_callbacks = 0;
		let mut output = [0.0; 2];
		let widened_drain_callbacks = LOCAL_DRAIN_CALLBACKS * 4;

		for _ in 0..LOCAL_DRAIN_CALLBACKS {
			fill_playback(
				&rx,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty_callbacks,
				widened_drain_callbacks,
			);
		}
		assert!(
			!state.drained.load(Ordering::Acquire),
			"drained after only the local margin despite a widened backlog"
		);

		while empty_callbacks < widened_drain_callbacks {
			fill_playback(
				&rx,
				&mut current,
				&mut cursor,
				&mut output,
				&state,
				&mut empty_callbacks,
				widened_drain_callbacks,
			);
		}
		assert!(state.drained.load(Ordering::Acquire));
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let mut stream = PlaybackStream::start(16_000).expect("default playback device starts");
		stream.stop().expect("default playback device stops");
	}

	#[test]
	fn opt_in_default_capture_receives_frames() {
		if env::var_os("OMP_NATIVE_AUDIO_CAPTURE_TEST").is_none() {
			return;
		}

		let callbacks = Arc::new(AtomicUsize::new(0));
		let callback_count = Arc::clone(&callbacks);
		let mut stream = CaptureStream::start(16_000, move |_samples| {
			callback_count.fetch_add(1, Ordering::Relaxed);
		})
		.expect("default capture device starts");

		let deadline = Instant::now() + Duration::from_secs(5);
		while callbacks.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
			sleep(Duration::from_millis(20));
		}
		if callbacks.load(Ordering::Relaxed) == 0 {
			forget(stream);
			panic!("capture device started but delivered no frames within five seconds");
		}
		stream.stop().expect("capture device stops");
	}
}
