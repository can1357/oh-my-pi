//! Deterministic client-side energy endpointer for non-streaming ASR engines.

use std::mem;
/// Tunable energy-endpointer thresholds. Durations are milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EndpointerConfig {
	/// Input sample rate.
	pub sample_rate:         u32,
	/// Short-time analysis frame duration.
	pub frame_ms:            u32,
	/// Trailing silence which finalizes a segment.
	pub end_silence_ms:      u32,
	/// Shortest speech run retained as a segment.
	pub min_speech_ms:       u32,
	/// Hard segment cap for pause-free speech.
	pub max_segment_ms:      u32,
	/// Audio retained before detected onset.
	pub pre_roll_ms:         u32,
	/// Cadence for volatile partial previews.
	pub partial_interval_ms: u32,
	/// Speech threshold multiplier over the adaptive floor.
	pub energy_ratio:        f32,
	/// Exponential moving-average weight for non-speech frames.
	pub floor_attack:        f32,
	/// Absolute RMS threshold floor.
	pub min_threshold:       f32,
}

impl Default for EndpointerConfig {
	fn default() -> Self {
		Self {
			sample_rate:         16_000,
			frame_ms:            30,
			end_silence_ms:      600,
			min_speech_ms:       200,
			max_segment_ms:      12_000,
			pre_roll_ms:         240,
			partial_interval_ms: 450,
			energy_ratio:        2.5,
			floor_attack:        0.05,
			min_threshold:       0.008,
		}
	}
}

/// One ordered endpointer output.
#[derive(Clone, Debug, PartialEq)]
pub enum EndpointerEvent {
	/// Volatile audio for an in-progress transcription preview.
	Partial(Vec<f32>),
	/// Final audio which must be decoded and committed once.
	Segment(Vec<f32>),
}

/// Streaming adaptive-energy endpointer with onset pre-roll and silence trim.
#[derive(Debug)]
pub struct StreamEndpointer {
	config:           EndpointerConfig,
	frame_samples:    usize,
	pre_roll_samples: usize,
	leftover:         Vec<f32>,
	in_speech:        bool,
	noise_floor:      f32,
	silence_ms:       u32,
	segment_ms:       u32,
	ms_since_partial: u32,
	partial_dirty:    bool,
	segment:          Vec<f32>,
	pre_roll:         Vec<f32>,
}

impl Default for StreamEndpointer {
	fn default() -> Self {
		Self::new(EndpointerConfig::default())
	}
}

impl StreamEndpointer {
	/// Creates an endpointer. Invalid zero/range values are safely bounded.
	pub fn new(mut config: EndpointerConfig) -> Self {
		config.sample_rate = config.sample_rate.max(1);
		config.frame_ms = config.frame_ms.max(1);
		config.energy_ratio = config.energy_ratio.max(1.0);
		config.floor_attack = config.floor_attack.clamp(0.0, 1.0);
		config.min_threshold = config.min_threshold.max(0.0);
		let frame_samples = ((u64::from(config.sample_rate) * u64::from(config.frame_ms) + 500)
			/ 1_000)
			.max(1) as usize;
		let pre_roll_samples =
			((u64::from(config.sample_rate) * u64::from(config.pre_roll_ms) + 500) / 1_000) as usize;
		Self {
			config,
			frame_samples,
			pre_roll_samples,
			leftover: Vec::new(),
			in_speech: false,
			noise_floor: config.min_threshold,
			silence_ms: 0,
			segment_ms: 0,
			ms_since_partial: 0,
			partial_dirty: false,
			segment: Vec::new(),
			pre_roll: Vec::with_capacity(pre_roll_samples.saturating_add(frame_samples)),
		}
	}

	/// Returns the current adaptive ambient RMS floor.
	pub const fn noise_floor(&self) -> f32 {
		self.noise_floor
	}

	/// Feeds captured mono samples and returns ordered partial/final events.
	pub fn push(&mut self, samples: &[f32]) -> Vec<EndpointerEvent> {
		let mut events = Vec::new();
		if samples.is_empty() {
			return events;
		}
		let mut input = mem::take(&mut self.leftover);
		input.extend_from_slice(samples);
		let whole = input.len() / self.frame_samples * self.frame_samples;
		for offset in (0..whole).step_by(self.frame_samples) {
			self.process_frame(&input[offset..offset + self.frame_samples], &mut events);
		}
		self.leftover.extend_from_slice(&input[whole..]);
		events
	}

	/// Ends capture and commits a sufficiently long trailing segment.
	pub fn flush(&mut self) -> Vec<EndpointerEvent> {
		let mut events = Vec::new();
		if self.in_speech && !self.leftover.is_empty() {
			self.segment.append(&mut self.leftover);
			self.segment_ms = self.segment_duration_ms();
		} else {
			self.leftover.clear();
		}
		if self.in_speech
			&& self.segment_ms.saturating_sub(self.silence_ms) >= self.config.min_speech_ms
		{
			let keep = self.endpoint_keep();
			events.push(EndpointerEvent::Segment(self.segment[..keep].to_vec()));
		}
		self.reset();
		events
	}

	fn process_frame(&mut self, frame: &[f32], events: &mut Vec<EndpointerEvent>) {
		let energy = rms(frame);
		let threshold = self
			.config
			.min_threshold
			.max(self.noise_floor * self.config.energy_ratio);
		let voiced = energy > threshold;
		if !voiced {
			let attack = self.config.floor_attack;
			self.noise_floor = energy.mul_add(attack, self.noise_floor * (1.0 - attack));
		}
		if !self.in_speech {
			if voiced {
				self.begin_segment(frame);
			} else {
				self.pre_roll.extend_from_slice(frame);
				if self.pre_roll.len() > self.pre_roll_samples {
					let drop = self.pre_roll.len() - self.pre_roll_samples;
					self.pre_roll.drain(..drop);
				}
			}
			return;
		}

		self.segment.extend_from_slice(frame);
		self.segment_ms = self.segment_ms.saturating_add(self.config.frame_ms);
		self.ms_since_partial = self.ms_since_partial.saturating_add(self.config.frame_ms);
		if voiced {
			self.silence_ms = 0;
			self.partial_dirty = true;
		} else {
			self.silence_ms = self.silence_ms.saturating_add(self.config.frame_ms);
		}
		if self.silence_ms >= self.config.end_silence_ms {
			self.finalize(events);
		} else if self.segment_ms >= self.config.max_segment_ms {
			events.push(EndpointerEvent::Segment(mem::take(&mut self.segment)));
			self.segment_ms = 0;
			self.silence_ms = 0;
			self.ms_since_partial = 0;
			self.partial_dirty = false;
		} else if self.partial_dirty && self.ms_since_partial >= self.config.partial_interval_ms {
			events.push(EndpointerEvent::Partial(self.segment.clone()));
			self.ms_since_partial = 0;
			self.partial_dirty = false;
		}
	}

	fn begin_segment(&mut self, onset: &[f32]) {
		self.in_speech = true;
		self.segment.clear();
		self.segment.append(&mut self.pre_roll);
		self.segment.extend_from_slice(onset);
		self.silence_ms = 0;
		self.segment_ms = self.segment_duration_ms();
		self.ms_since_partial = 0;
		self.partial_dirty = true;
	}

	fn finalize(&mut self, events: &mut Vec<EndpointerEvent>) {
		if self.segment_ms.saturating_sub(self.silence_ms) >= self.config.min_speech_ms {
			let keep = self.endpoint_keep();
			events.push(EndpointerEvent::Segment(self.segment[..keep].to_vec()));
		}
		self.in_speech = false;
		self.segment.clear();
		self.silence_ms = 0;
		self.segment_ms = 0;
		self.ms_since_partial = 0;
		self.partial_dirty = false;
	}

	fn endpoint_keep(&self) -> usize {
		let drop_ms = self.silence_ms.saturating_sub(120);
		let drop = ((u64::from(self.config.sample_rate) * u64::from(drop_ms) + 500) / 1_000) as usize;
		self.segment.len().saturating_sub(drop)
	}

	fn segment_duration_ms(&self) -> u32 {
		((self.segment.len() as u64 * 1_000) / u64::from(self.config.sample_rate))
			.try_into()
			.unwrap_or(u32::MAX)
	}

	fn reset(&mut self) {
		self.in_speech = false;
		self.segment.clear();
		self.pre_roll.clear();
		self.leftover.clear();
		self.silence_ms = 0;
		self.segment_ms = 0;
		self.ms_since_partial = 0;
		self.partial_dirty = false;
		self.noise_floor = self.config.min_threshold;
	}
}

fn rms(frame: &[f32]) -> f32 {
	if frame.is_empty() {
		return 0.0;
	}
	let sum = frame
		.iter()
		.map(|sample| f64::from(*sample) * f64::from(*sample))
		.sum::<f64>();
	(sum / frame.len() as f64).sqrt() as f32
}
#[cfg(test)]
mod tests {
	use super::{EndpointerConfig, EndpointerEvent, StreamEndpointer};

	#[test]
	fn speech_onset_frame_is_emitted_once_after_pre_roll() {
		let config = EndpointerConfig {
			sample_rate: 1_000,
			frame_ms: 10,
			end_silence_ms: 10,
			min_speech_ms: 10,
			pre_roll_ms: 20,
			..EndpointerConfig::default()
		};
		let mut endpointer = StreamEndpointer::new(config);
		assert!(endpointer.push(&[0.0; 10]).is_empty());
		assert!(endpointer.push(&[0.0; 10]).is_empty());
		assert!(endpointer.push(&[1.0; 10]).is_empty());
		let events = endpointer.push(&[0.0; 10]);
		let [EndpointerEvent::Segment(segment)] = events.as_slice() else {
			panic!("expected one finalized segment");
		};
		assert_eq!(segment.len(), 40);
		assert_eq!(&segment[..20], &[0.0; 20]);
		assert_eq!(&segment[20..30], &[1.0; 10]);
		assert_eq!(&segment[30..], &[0.0; 10]);
	}
}
