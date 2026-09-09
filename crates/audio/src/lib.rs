//! Cross-platform audio capture, gapless playback, metering, and ownership
//! coordination for OMP voice features.
//!
//! The crate presents a mono [`f32`] contract at a caller-selected logical
//! sample rate. Platform modules own device access, channel conversion, and
//! resampling. [`coordinator`] owns policy shared by speech-to-text, local
//! text-to-speech, and live voice; provider transports and model inference
//! remain outside this crate.

use std::{io, result, sync::Arc};

use strum::{Display, IntoStaticStr};
use thiserror::Error;

pub mod audio;
pub mod coordinator;
/// Native device discovery, permission, hot-plug observation, and selection.
pub mod device;
/// Streaming Markdown-to-speech segmentation.
pub mod segmentation;
/// Speech-to-text submit-trigger evaluation.
pub mod triggers;
/// Client-side adaptive-energy speech endpointer.
pub mod vad;
/// Canonical PCM16 WAV encoding.
pub mod wav;

/// Direction of a native audio device operation.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum AudioDirection {
	/// Speaker playback.
	Playback,
	/// Microphone capture.
	Capture,
}

/// Errors returned by the voice audio and coordination surfaces.
#[derive(Clone, Debug, Error)]
pub enum AudioError {
	/// The current target has no native audio backend.
	#[error("native audio is not supported on {platform}")]
	UnsupportedPlatform {
		/// Rust target operating-system name.
		platform: &'static str,
	},
	/// The requested logical sample rate is outside the supported range.
	#[error("unsupported audio sample rate {sample_rate} Hz")]
	UnsupportedSampleRate {
		/// Rejected logical sample rate in hertz.
		sample_rate: u32,
	},
	/// A producer attempted to write after playback input was finished.
	#[error("native audio playback is closed")]
	PlaybackClosed,
	/// A non-blocking producer exceeded the bounded speaker queue.
	#[error("native audio playback queue reached its {capacity}-chunk limit")]
	PlaybackBackpressure {
		/// Configured queue capacity.
		capacity: usize,
	},
	/// Playback gain was NaN or infinite.
	#[error("audio playback gain must be finite")]
	NonFiniteGain,
	/// The selected target supports audio, but the requested default device
	/// could not be opened (including headless sessions).
	#[error("default {direction} device is unavailable")]
	DeviceUnavailable {
		/// Device direction that was requested.
		direction: AudioDirection,
		/// Typed backend cause.
		#[source]
		source:    Arc<io::Error>,
	},
	/// A native backend operation failed after a device was opened.
	#[error("native audio backend failed: {source}")]
	Backend {
		/// Native diagnostic retained as a typed source.
		#[source]
		source: Arc<io::Error>,
	},
	/// Live voice could not acquire the shared microphone/TTS authority.
	#[error(transparent)]
	Coordinator {
		/// Typed ownership-policy failure.
		#[from]
		source: coordinator::CoordinatorError,
	},
}

impl AudioError {
	#[cfg(feature = "native-audio")]
	pub(crate) fn backend(message: String) -> Self {
		Self::Backend { source: Arc::new(io::Error::other(message)) }
	}
}

/// Backward-compatible alias for [`AudioError`].
pub type VoiceError = AudioError;

/// Result type for audio operations.
pub type AudioResult<T> = result::Result<T, AudioError>;

/// Backward-compatible alias for [`AudioResult`].
pub type VoiceResult<T> = AudioResult<T>;
