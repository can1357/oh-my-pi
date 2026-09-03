//! In-house default-device audio backends.
//!
//! One backend per platform, each implementing the same two devices against
//! the OS audio API directly: `CoreAudio` `AudioQueue` on macOS, shared-mode
//! WASAPI with automatic format conversion on Windows, and the `PulseAudio`
//! simple API with an ALSA fallback (both loaded via `dlopen`) on Linux.
//! Every backend delegates format conversion, channel mixing, and resampling
//! to the OS so the engine keeps a single mono `f32` contract at the
//! requested logical sample rate.
//!
//! # Contract
//! - [`PlaybackDevice::start`] opens the default speaker and invokes `fill`
//!   with a mono `f32` buffer roughly every [`DeviceConfig::period_ms`]. The
//!   callback runs on a backend-owned audio thread and must not block. Queue
//!   depth varies by backend and stream config; [`playback_drain_periods`]
//!   reports the bound used by the engine's drain accounting.
//! - [`CaptureDevice::start`] opens the default microphone and invokes `sink`
//!   with non-empty mono `f32` chunks at the requested sample rate, also from a
//!   backend-owned thread.
//! - `stop` is idempotent, callable from any thread, and guarantees no callback
//!   is running or will run after it returns — except when invoked from within
//!   a device callback itself: the calling thread cannot await its own
//!   cessation, so backends defer teardown to another thread and the
//!   post-return guarantee applies only to external callers. The engine never
//!   stops from callbacks; the carve-out exists for contract soundness, not for
//!   use. Dropping a device stops it.

#[cfg(target_os = "macos")]
mod coreaudio;
#[cfg(target_os = "macos")]
use coreaudio as imp;

#[cfg(target_os = "windows")]
mod wasapi;
#[cfg(target_os = "windows")]
use wasapi as imp;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use unsupported as imp;

use crate::VoiceResult;

/// Render callback: fill the whole output buffer with mono `f32` samples.
pub type PlaybackFill = Box<dyn FnMut(&mut [f32]) + Send + 'static>;

/// Capture callback: consume a non-empty chunk of mono `f32` samples.
pub type CaptureSink = Box<dyn FnMut(&[f32]) + Send + 'static>;

/// Stream parameters shared by both device directions.
#[derive(Clone, Copy)]
pub struct DeviceConfig {
	/// Logical client-side sample rate in Hz; the OS converts to hardware.
	pub sample_rate: u32,
	/// Target callback period in milliseconds.
	pub period_ms:   u32,
}

impl DeviceConfig {
	/// Samples per callback period at the logical rate (never zero).
	pub fn period_samples(self) -> usize {
		((self.sample_rate as usize * self.period_ms as usize) / 1000).max(1)
	}
}

/// Running default-speaker playback stream driven by a fill callback.
pub struct PlaybackDevice {
	inner: imp::PlaybackDevice,
}

impl PlaybackDevice {
	/// Open and start the default speaker; `fill` runs on the audio thread.
	pub fn start(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		Ok(Self { inner: imp::PlaybackDevice::start(config, fill)? })
	}

	/// Stop playback and release the device. Idempotent; no callback runs
	/// after this returns.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.inner.stop()
	}
}

/// Periods of audio a backend may hold queued OS-side for a playback stream
/// opened with this config, before a fill callback observing no new data
/// can be trusted as genuine drain rather than an in-flight refill. Fixed
/// at three for backends with a hardware/API-enforced queue depth
/// (`CoreAudio` `AudioQueue` buffer count, WASAPI padding cap); `PulseAudio`
/// scales this with the widened remote/`PULSE_LATENCY_MSEC` backlog before
/// the stream even opens (see `linux::playback_drain_periods`).
#[cfg(target_os = "linux")]
pub fn playback_drain_periods(config: DeviceConfig) -> u32 {
	imp::playback_drain_periods(config)
}

#[cfg(not(target_os = "linux"))]
pub const fn playback_drain_periods(_config: DeviceConfig) -> u32 {
	3
}

/// Running default-microphone capture stream driven by a sink callback.
pub struct CaptureDevice {
	inner: imp::CaptureDevice,
}

impl CaptureDevice {
	/// Open and start the default microphone; `sink` runs on the audio thread.
	pub fn start(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		Ok(Self { inner: imp::CaptureDevice::start(config, sink)? })
	}

	/// Stop capture and release the device. Idempotent; no callback runs
	/// after this returns.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.inner.stop()
	}
}
