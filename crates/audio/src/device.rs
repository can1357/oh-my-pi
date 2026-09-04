//! Direct native audio-device discovery, permission, hot-plug, and stream
//! backends.
//!
//! Backends invoke callbacks on their own realtime threads, and guarantee that
//! an externally initiated `stop` waits out any in-flight callback. Queue depth
//! varies by backend and stream configuration; [`playback_drain_periods`]
//! reports the bound used by playback drain accounting.

#[cfg(all(feature = "native-audio", target_os = "macos"))]
mod coreaudio;
#[cfg(all(feature = "native-audio", target_os = "macos"))]
use coreaudio as imp;

#[cfg(all(feature = "native-audio", target_os = "windows"))]
mod wasapi;
#[cfg(all(feature = "native-audio", target_os = "windows"))]
use wasapi as imp;

#[cfg(all(feature = "native-audio", target_os = "linux"))]
mod linux;
#[cfg(all(feature = "native-audio", target_os = "linux"))]
use linux as imp;

#[cfg(not(all(
	feature = "native-audio",
	any(target_os = "macos", target_os = "windows", target_os = "linux")
)))]
mod unsupported {

	use std::env::consts;

	use super::{CaptureSink, DeviceConfig, DeviceSnapshot, MicrophonePermission, PlaybackFill};
	use crate::{VoiceError, VoiceResult};

	pub(super) fn snapshot() -> VoiceResult<DeviceSnapshot> {
		Err(VoiceError::UnsupportedPlatform { platform: consts::OS })
	}

	pub(super) const fn microphone_permission() -> MicrophonePermission {
		MicrophonePermission::Unavailable
	}

	pub(super) async fn request_microphone_permission() -> VoiceResult<MicrophonePermission> {
		Ok(MicrophonePermission::Unavailable)
	}

	pub(super) struct PlaybackDevice;

	impl PlaybackDevice {
		pub(super) fn start(config: DeviceConfig, _fill: PlaybackFill) -> VoiceResult<Self> {
			let _ = config.period_samples();

			Err(VoiceError::UnsupportedPlatform { platform: consts::OS })
		}

		pub(super) fn stop(&mut self) -> VoiceResult<()> {
			Ok(())
		}
	}

	pub(super) struct CaptureDevice;

	impl CaptureDevice {
		pub(super) fn start(config: DeviceConfig, _sink: CaptureSink) -> VoiceResult<Self> {
			let _ = config.period_samples();

			Err(VoiceError::UnsupportedPlatform { platform: consts::OS })
		}

		pub(super) fn stop(&mut self) -> VoiceResult<()> {
			Ok(())
		}
	}
}
use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::Duration,
};

use flume::Receiver;
use omp_core::Str;
#[cfg(not(all(
	feature = "native-audio",
	any(target_os = "macos", target_os = "windows", target_os = "linux")
)))]
use unsupported as imp;

#[cfg(feature = "native-audio")]
use crate::VoiceError;
use crate::VoiceResult;

#[cfg(all(
	feature = "native-audio",
	any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub(super) type BackendResult<T> = Result<T, String>;

pub(super) type PlaybackFill = Box<dyn FnMut(&mut [f32]) + Send + 'static>;
pub(super) type CaptureSink = Box<dyn FnMut(&[f32]) + Send + 'static>;

/// One real platform audio endpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioDevice {
	/// Stable platform identity suitable for archival selection.
	pub id:         Str,
	/// Human-readable platform label.
	pub label:      Str,
	/// Whether the operating system currently uses this endpoint by default.
	pub is_default: bool,
}

/// Current microphone authorization state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MicrophonePermission {
	/// The platform cannot report microphone authorization.
	Unknown,
	/// An authorization request is currently awaiting the user.
	Requesting,
	/// Microphone capture is authorized.
	Granted,
	/// The user denied microphone capture.
	Denied,
	/// Device policy prevents microphone capture.
	Restricted,
	/// Native microphone capture is unavailable on this target.
	Unavailable,
}

/// One atomic observation of real platform endpoints and microphone permission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceSnapshot {
	/// Present microphone endpoints.
	pub input:                 Vec<AudioDevice>,
	/// Present speaker endpoints.
	pub output:                Vec<AudioDevice>,
	/// Current operating-system microphone authorization.
	pub microphone_permission: MicrophonePermission,
}

/// Enumerates real platform audio endpoints and observes microphone permission.
pub fn snapshot() -> VoiceResult<DeviceSnapshot> {
	#[cfg(all(
		feature = "native-audio",
		any(target_os = "macos", target_os = "windows", target_os = "linux")
	))]
	{
		imp::snapshot().map_err(VoiceError::backend)
	}
	#[cfg(not(all(
		feature = "native-audio",
		any(target_os = "macos", target_os = "windows", target_os = "linux")
	)))]
	{
		imp::snapshot()
	}
}

/// Returns the latest operating-system microphone authorization without
/// prompting.
#[must_use]
pub fn microphone_permission() -> MicrophonePermission {
	imp::microphone_permission()
}

/// Requests microphone authorization through the native platform prompt.
pub async fn request_microphone_permission() -> VoiceResult<MicrophonePermission> {
	#[cfg(all(
		feature = "native-audio",
		any(target_os = "macos", target_os = "windows", target_os = "linux")
	))]
	{
		imp::request_microphone_permission()
			.await
			.map_err(VoiceError::backend)
	}
	#[cfg(not(all(
		feature = "native-audio",
		any(target_os = "macos", target_os = "windows", target_os = "linux")
	)))]
	{
		imp::request_microphone_permission().await
	}
}

/// Hot-plug observer backed by repeated real platform enumeration.
pub struct DeviceWatcher {
	receiver: Receiver<VoiceResult<DeviceSnapshot>>,
	stop:     Arc<AtomicBool>,
	thread:   Option<thread::JoinHandle<()>>,
}

impl DeviceWatcher {
	/// Waits for the first snapshot and every subsequent endpoint or permission
	/// change.
	pub async fn changed(&mut self) -> Option<VoiceResult<DeviceSnapshot>> {
		self.receiver.recv_async().await.ok()
	}
}

impl Drop for DeviceWatcher {
	fn drop(&mut self) {
		self.stop.store(true, Ordering::Release);
		if let Some(thread) = self.thread.take() {
			thread.thread().unpark();
			let _ = thread.join();
		}
	}
}

/// Starts a hot-plug observer. Every delivered row came from native
/// enumeration.
pub fn watch() -> VoiceResult<DeviceWatcher> {
	let initial = snapshot()?;
	let (sender, receiver) = flume::unbounded();
	let stop = Arc::new(AtomicBool::new(false));
	let thread_stop = Arc::clone(&stop);
	let thread = thread::Builder::new()
		.name("omp-audio-devices".to_owned())
		.spawn(move || {
			let mut previous = initial.clone();
			let mut failed = false;
			let _ = sender.send(Ok(initial));
			while !thread_stop.load(Ordering::Acquire) {
				thread::park_timeout(Duration::from_secs(1));
				if thread_stop.load(Ordering::Acquire) {
					break;
				}
				match snapshot() {
					Ok(next) if next != previous || failed => {
						previous = next.clone();
						failed = false;
						if sender.send(Ok(next)).is_err() {
							break;
						}
					},
					Ok(_) => {},
					Err(error) if !failed => {
						failed = true;
						if sender.send(Err(error)).is_err() {
							break;
						}
					},
					Err(_) => {},
				}
			}
		})
		.map_err(|source| VoiceError::Backend { source: Arc::new(source) })?;
	Ok(DeviceWatcher { receiver, stop, thread: Some(thread) })
}

#[derive(Clone)]
pub(super) struct DeviceConfig {
	pub(super) sample_rate: u32,
	pub(super) period_ms:   u32,
	pub(super) device_id:   Option<Str>,
}

impl DeviceConfig {
	pub(super) fn period_samples(&self) -> usize {
		((self.sample_rate as usize * self.period_ms as usize) / 1000).max(1)
	}
}

pub(super) struct PlaybackDevice {
	inner: imp::PlaybackDevice,
}

impl PlaybackDevice {
	pub(super) fn start(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		#[cfg(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		))]
		let inner = imp::PlaybackDevice::start(config, fill).map_err(VoiceError::backend)?;
		#[cfg(not(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		)))]
		let inner = imp::PlaybackDevice::start(config, fill)?;
		Ok(Self { inner })
	}

	pub(super) fn stop(&mut self) -> VoiceResult<()> {
		#[cfg(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		))]
		return self.inner.stop().map_err(VoiceError::backend);
		#[cfg(not(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		)))]
		self.inner.stop()
	}
}

/// Returns the maximum number of callback periods queued by the playback
/// backend for this stream configuration.
#[cfg(all(feature = "native-audio", target_os = "linux"))]
pub(super) fn playback_drain_periods(config: DeviceConfig) -> u32 {
	imp::playback_drain_periods(config)
}

/// Returns the fixed playback queue depth used by non-PulseAudio backends.
#[cfg(not(all(feature = "native-audio", target_os = "linux")))]
pub(super) fn playback_drain_periods(_config: DeviceConfig) -> u32 {
	3
}

pub(super) struct CaptureDevice {
	inner: imp::CaptureDevice,
}

impl CaptureDevice {
	pub(super) fn start(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		#[cfg(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		))]
		let inner = imp::CaptureDevice::start(config, sink).map_err(VoiceError::backend)?;
		#[cfg(not(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		)))]
		let inner = imp::CaptureDevice::start(config, sink)?;
		Ok(Self { inner })
	}

	pub(super) fn stop(&mut self) -> VoiceResult<()> {
		#[cfg(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		))]
		return self.inner.stop().map_err(VoiceError::backend);
		#[cfg(not(all(
			feature = "native-audio",
			any(target_os = "macos", target_os = "windows", target_os = "linux")
		)))]
		self.inner.stop()
	}
}
