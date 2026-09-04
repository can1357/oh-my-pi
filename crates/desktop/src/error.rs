/// Stable category for a desktop operation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::Display, strum::IntoStaticStr)]
pub enum ErrorCode {
	/// The OS has not granted a required capture, input, or accessibility
	/// permission.
	PermissionDenied,
	/// The backend could not enumerate, capture, compose, or encode the
	/// requested image.
	CaptureFailed,
	/// The backend could not configure or deliver the requested pointer or
	/// keyboard input.
	InputFailed,
	/// This backend cannot reliably deliver input to the requested background
	/// window.
	BackgroundUnavailable,
	/// The requested window, focused window, or its owning application no longer
	/// exists.
	WindowNotFound,
	/// A capture target, display selector, window id, or capture limit is
	/// invalid.
	InvalidTarget,
	/// A key, chord, or modifier specification is malformed or unsupported.
	InvalidKey,
	/// Coordinates cannot be mapped through the latest capture frame.
	InvalidCoordinateFrame,
	/// An accessibility reference has expired and no longer resolves.
	StaleRef,
	/// The selected backend does not provide accessibility operations.
	AxUnsupported,
	/// The accessibility backend failed to inspect or operate on an element.
	AxFailed,
	/// A desktop worker operation exceeded its deadline.
	Timeout,
	/// The desktop session is already closed or its worker closed during
	/// shutdown.
	Closed,
	/// The desktop worker could not start, panicked, or stopped communicating
	/// unexpectedly.
	Internal,
}

/// A desktop operation failure with a stable category and backend-provided
/// detail.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct DesktopError {
	/// Machine-readable category suitable for branching independently of backend
	/// details.
	pub code:    ErrorCode,
	/// Human-readable detail describing the failed operation and its native
	/// cause.
	pub message: String,
}

impl DesktopError {
	pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}

	pub(crate) fn permission_denied(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::PermissionDenied, message)
	}

	pub(crate) fn capture_failed(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::CaptureFailed, message)
	}

	pub(crate) fn input_failed(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::InputFailed, message)
	}

	pub(crate) fn background_unavailable(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::BackgroundUnavailable, message)
	}

	pub(crate) fn window_not_found(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::WindowNotFound, message)
	}

	pub(crate) fn invalid_target(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::InvalidTarget, message)
	}

	pub(crate) fn invalid_key(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::InvalidKey, message)
	}

	pub(crate) fn invalid_coordinate_frame(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::InvalidCoordinateFrame, message)
	}

	pub(crate) fn stale_ref(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::StaleRef, message)
	}

	pub(crate) fn ax_unsupported() -> Self {
		Self::new(ErrorCode::AxUnsupported, "accessibility is unavailable on this backend")
	}

	pub(crate) fn ax_failed(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::AxFailed, message)
	}

	pub(crate) fn timeout(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::Timeout, message)
	}

	pub(crate) fn closed() -> Self {
		Self::new(ErrorCode::Closed, "desktop session is closed")
	}

	pub(crate) fn internal(message: impl Into<String>) -> Self {
		Self::new(ErrorCode::Internal, message)
	}
}

/// Result returned by desktop operations.
pub type DesktopResult<T> = Result<T, DesktopError>;

pub type CoreResult<T> = DesktopResult<T>;
