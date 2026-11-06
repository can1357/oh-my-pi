//! Cross-platform microphone capture and streaming speaker playback.
//!
//! The per-platform backends in [`crate::device`] own device access, format
//! conversion, channel mixing, and resampling. The engine exposes one stable
//! mono `f32` contract: the N-API classes in pi-natives adapt it to
//! TypeScript, and [`crate::live`] shares [`PlaybackStream`] for remote-audio
//! rendering.

use std::sync::{
	Arc,
	atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
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
// Output ramps to silence over this long when the queue runs dry and back
// up when audio resumes, so a producer stall is a soft dropout instead of a
// waveform step (a click). Short enough to stay inaudible as a fade.
const PLAYBACK_FADE_MS: usize = 5;

/// Shared render-time state for one playback device: gain, queue depth,
/// drain, stop.
///
/// Held as an `Arc` by both the stream and its N-API wrapper so
/// [`PlaybackState::wait_for_drain`] can outlive the stream lock.
pub struct PlaybackState {
	gain_bits: AtomicU32,
	/// Samples written but not yet taken by the renderer. Writers add before
	/// sending, so this never undercounts what the channel holds.
	queued:    AtomicUsize,
	drained:   AtomicBool,
	stopped:   AtomicBool,
	notify:    Notify,
}

impl PlaybackState {
	fn new() -> Self {
		Self {
			gain_bits: AtomicU32::new(1.0f32.to_bits()),
			queued:    AtomicUsize::new(0),
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
		self.state.queued.fetch_add(samples.len(), Ordering::AcqRel);
		if self.tx.send(samples.to_vec()).is_err() {
			self.state.queued.fetch_sub(samples.len(), Ordering::AcqRel);
			return Err("Native audio playback is closed".to_owned());
		}
		Ok(())
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
	///
	/// `jitter_buffer_ms` of audio is held back before playback starts and
	/// again after every underrun, so a network-paced producer survives
	/// arrival jitter as one short rebuffer instead of a hole in every late
	/// period. Partial bursts play after one reserve's worth of device
	/// callbacks even while the producer remains connected. Zero plays
	/// samples as soon as they are queued. Either way, output fades out when
	/// the queue runs dry and fades back in when audio resumes.
	pub fn start(sample_rate: u32, jitter_buffer_ms: u32) -> VoiceResult<Self> {
		let sample_rate = audio_sample_rate(sample_rate)?;
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded::<Vec<f32>>();
		let config = DeviceConfig { sample_rate, period_ms: PLAYBACK_PERIOD_MS };
		let mut renderer = Renderer::new(
			rx,
			Arc::clone(&state),
			(playback_drain_periods(config) as usize) + PLAYBACK_DRAIN_MARGIN_CALLBACKS,
			sample_rate as usize * jitter_buffer_ms as usize / 1000,
			sample_rate as usize * PLAYBACK_FADE_MS / 1000,
		);
		let device = PlaybackDevice::start(config, Box::new(move |output| renderer.fill(output)))
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

/// Render-thread side of a [`PlaybackStream`]: moves queued chunks into
/// device buffers, holds back the jitter reserve, ramps the edges of every
/// gap, and detects drain.
///
/// Travels inside the device fill callback; dropping it (worker exit on
/// device loss, stop) marks the stream stopped so `wait_for_drain` waiters
/// wake instead of outliving the render path.
struct Renderer {
	rx:                  flume::Receiver<Vec<f32>>,
	state:               Arc<PlaybackState>,
	current:             Vec<f32>,
	cursor:              usize,
	empty_callbacks:     usize,
	drain_callbacks:     usize,
	/// Samples that must be queued before output (re)starts; zero disables.
	reserve:             usize,
	buffering:           bool,
	buffering_callbacks: usize,
	/// Ramp length in samples for both gap edges; zero disables ramping.
	fade:                usize,
	/// Queued audio reached the previous output sample.
	sounding:            bool,
	/// Last sample handed to the device, where a fade-out starts from.
	last:                f32,
	/// Samples of fade-in already applied since audio resumed.
	fade_in:             usize,
	/// Level the running fade-out decays from, and samples it has left.
	tail_level:          f32,
	tail_left:           usize,
}

impl Renderer {
	const fn new(
		rx: flume::Receiver<Vec<f32>>,
		state: Arc<PlaybackState>,
		drain_callbacks: usize,
		reserve: usize,
		fade: usize,
	) -> Self {
		Self {
			rx,
			state,
			current: Vec::new(),
			cursor: 0,
			empty_callbacks: 0,
			drain_callbacks,
			reserve,
			buffering: reserve > 0,
			buffering_callbacks: 0,
			fade,
			sounding: false,
			last: 0.0,
			fade_in: 0,
			tail_level: 0.0,
			tail_left: 0,
		}
	}

	/// Fill one device buffer, fading to silence when the queue runs dry.
	fn fill(&mut self, output: &mut [f32]) {
		output.fill(0.0);
		if output.is_empty() || self.state.stopped.load(Ordering::Acquire) {
			return;
		}
		let written = self.play(output);
		if written < output.len() {
			if self.sounding {
				// Audio stopped mid-waveform: decay from the last emitted sample
				// instead of stepping to zero.
				self.sounding = false;
				self.tail_level = if written > 0 {
					output[written - 1]
				} else {
					self.last
				};
				self.tail_left = self.fade;
			}
			for sample in &mut output[written..] {
				if self.tail_left == 0 {
					break;
				}
				self.tail_left -= 1;
				*sample = self.tail_level * self.tail_left as f32 / self.fade as f32;
			}
		}
		self.last = output[output.len() - 1];
	}

	/// Copy queued audio into the front of `output`; returns how many
	/// samples it wrote before the reserve held output back or the queue ran
	/// dry.
	fn play(&mut self, output: &mut [f32]) -> usize {
		if self.buffering {
			let queued = self.state.queued.load(Ordering::Acquire);
			if queued == 0 {
				// Silence before a burst must not consume its rebuffer window.
				self.buffering_callbacks = 0;
			} else {
				self.buffering_callbacks += 1;
			}
			// A connected live writer stays open between turns. Once a burst
			// has waited one reserve of callback periods, play even its short
			// tail instead of holding it for the next turn.
			if queued < self.reserve
				&& !self.rx.is_disconnected()
				&& (queued == 0 || self.buffering_callbacks < self.reserve.div_ceil(output.len()))
			{
				return 0;
			}
			self.buffering = false;
			self.buffering_callbacks = 0;
		}

		let gain = self.state.gain();
		let mut output_offset = 0;
		while output_offset < output.len() {
			if self.cursor == self.current.len() {
				match self.rx.try_recv() {
					Ok(next) => {
						self.state.queued.fetch_sub(next.len(), Ordering::AcqRel);
						self.current = next;
						self.cursor = 0;
						self.empty_callbacks = 0;
						continue;
					},
					Err(TryRecvError::Empty) => {
						// Underrun: rebuild the reserve before resuming.
						self.empty_callbacks = 0;
						self.buffering = self.reserve > 0;
						self.buffering_callbacks = 0;
						break;
					},
					Err(TryRecvError::Disconnected) => {
						self.empty_callbacks += 1;
						if self.empty_callbacks >= self.drain_callbacks {
							self.state.mark_drained();
						}
						break;
					},
				}
			}

			let count = (self.current.len() - self.cursor).min(output.len() - output_offset);
			let source = &self.current[self.cursor..self.cursor + count];
			let destination = &mut output[output_offset..output_offset + count];
			if gain == 1.0 {
				destination.copy_from_slice(source);
			} else {
				for (destination, source) in destination.iter_mut().zip(source) {
					*destination = *source * gain;
				}
			}
			if !self.sounding {
				self.sounding = true;
				self.fade_in = 0;
			}
			self.ramp(destination);
			self.cursor += count;
			output_offset += count;
		}
		output_offset
	}

	/// Fade freshly resumed audio in and mix any still-running fade-out over
	/// it, so a short gap neither steps up nor drops the old tail abruptly.
	fn ramp(&mut self, audio: &mut [f32]) {
		for sample in audio {
			if self.fade_in >= self.fade && self.tail_left == 0 {
				return;
			}
			if self.fade_in < self.fade {
				self.fade_in += 1;
				*sample *= self.fade_in as f32 / self.fade as f32;
			}
			if self.tail_left > 0 {
				self.tail_left -= 1;
				*sample += self.tail_level * self.tail_left as f32 / self.fade as f32;
			}
		}
	}
}

impl Drop for Renderer {
	fn drop(&mut self) {
		self.state.mark_stopped();
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

	/// Renderer plus its writer; `fade` zero keeps sample values exact for
	/// tests that assert queue and reserve mechanics.
	fn renderer(drain_callbacks: usize, reserve: usize, fade: usize) -> (PlaybackWriter, Renderer) {
		let state = Arc::new(PlaybackState::new());
		let (tx, rx) = flume::unbounded();
		let writer = PlaybackWriter { tx, state: Arc::clone(&state) };
		(writer, Renderer::new(rx, state, drain_callbacks, reserve, fade))
	}

	#[test]
	fn playback_preserves_chunk_order_and_applies_render_gain() {
		let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, 0, 0);
		renderer.state.set_gain(0.5);
		writer.write(&[1.0, -1.0]).expect("stream is open");
		writer.write(&[0.5, -0.5]).expect("stream is open");
		drop(writer);
		let mut output = [9.0; 5];

		renderer.fill(&mut output);

		assert_eq!(output, [0.5, -0.5, 0.25, -0.25, 0.0]);
		assert!(!renderer.state.drained.load(Ordering::Acquire));
		let mut silence = [1.0; 2];
		while renderer.empty_callbacks < LOCAL_DRAIN_CALLBACKS {
			silence.fill(1.0);
			renderer.fill(&mut silence);
			assert_eq!(silence, [0.0, 0.0]);
			assert_eq!(
				renderer.state.drained.load(Ordering::Acquire),
				renderer.empty_callbacks >= LOCAL_DRAIN_CALLBACKS
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
		let widened_drain_callbacks = LOCAL_DRAIN_CALLBACKS * 4;
		let (writer, mut renderer) = renderer(widened_drain_callbacks, 0, 0);
		drop(writer);
		let mut output = [0.0; 2];

		for _ in 0..LOCAL_DRAIN_CALLBACKS {
			renderer.fill(&mut output);
		}
		assert!(
			!renderer.state.drained.load(Ordering::Acquire),
			"drained after only the local margin despite a widened backlog"
		);

		while renderer.empty_callbacks < widened_drain_callbacks {
			renderer.fill(&mut output);
		}
		assert!(renderer.state.drained.load(Ordering::Acquire));
	}

	#[test]
	fn jitter_reserve_holds_output_at_start_and_after_underrun() {
		let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, 4, 0);
		let mut output = [9.0; 2];

		writer.write(&[1.0; 3]).expect("stream is open");
		renderer.fill(&mut output);
		assert_eq!(output, [0.0, 0.0], "started below the reserve");
		writer.write(&[2.0]).expect("stream is open");
		renderer.fill(&mut output);
		assert_eq!(output, [1.0, 1.0]);
		renderer.fill(&mut output);
		assert_eq!(output, [1.0, 2.0]);

		renderer.fill(&mut output);
		assert_eq!(output, [0.0, 0.0]);
		writer.write(&[3.0; 3]).expect("stream is open");
		renderer.fill(&mut output);
		assert_eq!(output, [0.0, 0.0], "resumed below the reserve after an underrun");
		writer.write(&[4.0]).expect("stream is open");
		renderer.fill(&mut output);
		assert_eq!(output, [3.0, 3.0]);
	}

	#[test]
	fn closed_writer_plays_tail_shorter_than_reserve() {
		let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, 4, 0);
		writer.write(&[1.0]).expect("stream is open");
		drop(writer);
		let mut output = [9.0; 2];

		renderer.fill(&mut output);

		assert_eq!(output, [1.0, 0.0]);
	}

	/// Live keeps its writer connected across turns. A short final frame
	/// must reach the speaker without waiting for the next assistant turn.
	#[test]
	fn connected_live_writer_releases_short_turns() {
		let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, 6, 0);
		let mut output = [9.0; 2];

		for _ in 0..5 {
			renderer.fill(&mut output);
		}
		writer.write(&[1.0; 2]).expect("live writer is connected");
		for _ in 0..2 {
			renderer.fill(&mut output);
			assert_eq!(output, [0.0; 2], "short turn waits for jitter reserve");
		}
		renderer.fill(&mut output);
		assert_eq!(output, [1.0; 2], "short turn plays without closing the writer");

		renderer.fill(&mut output);
		writer
			.write(&[2.0; 2])
			.expect("next turn uses the same writer");
		for _ in 0..2 {
			renderer.fill(&mut output);
			assert_eq!(output, [0.0; 2], "next turn waits for its own reserve");
		}
		renderer.fill(&mut output);
		assert_eq!(output, [2.0; 2], "next turn does not inherit stale audio");
	}

	/// Regression guard for #17114: live speech arrives as 20 ms Opus frames
	/// paced by the network. Without a reserve, every packet landing after
	/// its 20 ms device callback zero-filled a period mid-word (crackle).
	#[test]
	fn live_jitter_reserve_absorbs_network_jitter_without_dropouts() {
		const SAMPLE_RATE: usize = 48_000;
		const FRAME: usize = SAMPLE_RATE / 50;
		const PERIOD_US: u64 = 20_000;
		let reserve = SAMPLE_RATE * crate::live::OUTPUT_JITTER_BUFFER_MS as usize / 1000;
		let mut seed: u64 = 17_114;
		let mut random = move |modulo: u64| {
			seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
			(seed >> 33) % modulo
		};

		// Sweep the packet-vs-callback phase across one device period.
		for phase in (0..PERIOD_US).step_by(1_000) {
			// 5 s utterance: one frame per 20 ms, 0-4 ms delay variation plus
			// 5% spikes of 10-30 ms; packets stay in order.
			let mut latest = 0;
			let arrivals: Vec<u64> = (0..250)
				.map(|frame| {
					let spike = if random(100) < 5 {
						10_000 + random(20_000)
					} else {
						0
					};
					latest = (phase + frame * PERIOD_US + random(4_000) + spike).max(latest);
					latest
				})
				.collect();
			let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, reserve, 0);
			let total = arrivals.len() * FRAME;
			// Last packet arrives by ~5.04 s; one extra second of callbacks is
			// ample for the reserve and any rebuffer, and keeps a renderer that
			// strands the tail failing instead of spinning forever.
			let deadline = arrivals[arrivals.len() - 1] / PERIOD_US + 50;
			let mut delivered = 0;
			let mut played = 0;
			let mut output = [0.0; FRAME];
			for callback in 0..=deadline {
				let now = callback * PERIOD_US;
				while delivered < arrivals.len() && arrivals[delivered] <= now {
					writer.write(&[0.5; FRAME]).expect("stream is open");
					delivered += 1;
				}
				renderer.fill(&mut output);
				let audible = output.iter().filter(|sample| **sample != 0.0).count();
				if played > 0 && played < total {
					assert_eq!(audible, FRAME, "dropout mid-utterance at phase {phase} µs, {now} µs");
				}
				played += audible;
				if played == total {
					break;
				}
			}
			assert_eq!(
				played, total,
				"utterance not fully played by callback {deadline} at phase {phase} µs"
			);
		}
	}

	/// Regression guard for #17295: a network stall mid-word must fade to
	/// silence and back instead of stepping the waveform (heard as a click).
	#[test]
	fn underrun_ramps_waveform_instead_of_stepping() {
		const SAMPLE_RATE: usize = 48_000;
		const FRAME: usize = SAMPLE_RATE / 50;
		const AMPLITUDE: f32 = 0.5;
		const HZ: f32 = 440.0;
		// Largest step the tone itself takes between adjacent samples.
		let natural = AMPLITUDE * std::f32::consts::TAU * HZ / SAMPLE_RATE as f32;
		let live_reserve = SAMPLE_RATE * crate::live::OUTPUT_JITTER_BUFFER_MS as usize / 1000;
		let fade = SAMPLE_RATE * PLAYBACK_FADE_MS / 1000;
		// Live on macOS/Windows (stall lands on a callback boundary), live on
		// Linux (stall lands mid-callback), and reserve-free local playback
		// (resumes on the very next callback).
		for (reserve, period) in [(live_reserve, FRAME), (live_reserve, 2_400), (0, FRAME)] {
			let (writer, mut renderer) = renderer(LOCAL_DRAIN_CALLBACKS, reserve, fade);
			let mut sent = 0;
			let mut played = Vec::new();
			let mut output = vec![0.0; period];
			for callback in 0..20 {
				// One 20 ms frame stays ahead of the device; frames 6-10 stall
				// for 100 ms, so speech stops and resumes mid-cycle.
				while sent <= (callback + 1) * period / FRAME {
					if !(6..11).contains(&sent) {
						let samples: Vec<f32> = (sent * FRAME..(sent + 1) * FRAME)
							.map(|sample| {
								let phase = std::f32::consts::TAU * HZ * sample as f32 / SAMPLE_RATE as f32;
								AMPLITUDE * phase.sin()
							})
							.collect();
						writer.write(&samples).expect("stream is open");
					}
					sent += 1;
				}
				renderer.fill(&mut output);
				played.extend_from_slice(&output);
			}

			let first = played
				.iter()
				.position(|sample| *sample != 0.0)
				.expect("speech plays");
			let last = played
				.iter()
				.rposition(|sample| *sample != 0.0)
				.expect("speech plays");
			let silent = played[first..last]
				.iter()
				.filter(|sample| **sample == 0.0)
				.count();
			assert!(silent >= FRAME, "stall never underran (reserve {reserve}, period {period})");
			let step = played
				.windows(2)
				.map(|pair| (pair[1] - pair[0]).abs())
				.fold(0.0, f32::max);
			assert!(
				step <= natural * 1.5,
				"waveform stepped by {step}, tone steps at most {natural} (reserve {reserve}, period \
				 {period})"
			);
		}
	}

	#[test]
	fn opt_in_default_playback_initializes_and_stops() {
		if env::var_os("OMP_NATIVE_AUDIO_PLAYBACK_TEST").is_none() {
			return;
		}

		let mut stream = PlaybackStream::start(16_000, 0).expect("default playback device starts");
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
