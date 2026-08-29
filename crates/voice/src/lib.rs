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

/// Codex DeviceCheck attestation envelopes.
pub mod attestation;
pub mod audio;
pub mod coordinator;
mod device;
#[cfg(all(feature = "realtime-media", not(target_os = "android")))]
pub mod live;
/// Fence-aware enhanced-speech rewriting.
pub mod rewrite;
/// Streaming Markdown-to-speech segmentation.
pub mod segmentation;
/// Realtime SDP and sideband transport.
#[cfg(all(feature = "realtime-transport", not(target_os = "android")))]
pub mod transport;
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
pub enum VoiceError {
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
	/// The realtime media peer failed to initialize or process media.
	#[error("realtime voice transport failed: {source}")]
	RealtimeTransport {
		/// Typed transport diagnostic.
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

impl VoiceError {
	#[cfg(feature = "native-audio")]
	pub(crate) fn backend(message: String) -> Self {
		Self::Backend { source: Arc::new(io::Error::other(message)) }
	}
}
#[cfg(feature = "realtime-media")]
impl From<String> for VoiceError {
	fn from(message: String) -> Self {
		Self::RealtimeTransport { source: Arc::new(io::Error::other(message)) }
	}
}

/// Result type for voice audio operations.
pub type VoiceResult<T> = result::Result<T, VoiceError>;
