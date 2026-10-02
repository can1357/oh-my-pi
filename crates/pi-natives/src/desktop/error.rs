use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
	PermissionDenied,
	CaptureFailed,
	InputFailed,
	BackgroundUnavailable,
	WindowNotFound,
	InvalidTarget,
	InvalidKey,
	InvalidCoordinateFrame,
	StaleRef,
	AxUnsupported,
	AxFailed,
	Timeout,
	Closed,
	Internal,
}

impl ErrorCode {
	pub(crate) const fn as_str(self) -> &'static str {
		match self {
			Self::PermissionDenied => "PermissionDenied",
			Self::CaptureFailed => "CaptureFailed",
			Self::InputFailed => "InputFailed",
			Self::BackgroundUnavailable => "BackgroundUnavailable",
			Self::WindowNotFound => "WindowNotFound",
			Self::InvalidTarget => "InvalidTarget",
			Self::InvalidKey => "InvalidKey",
			Self::InvalidCoordinateFrame => "InvalidCoordinateFrame",
			Self::StaleRef => "StaleRef",
			Self::AxUnsupported => "AxUnsupported",
			Self::AxFailed => "AxFailed",
			Self::Timeout => "Timeout",
			Self::Closed => "Closed",
			Self::Internal => "Internal",
		}
	}
}

#[derive(Debug, Clone)]
pub struct DesktopError {
	pub code:    ErrorCode,
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

impl fmt::Display for DesktopError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}: {}", self.code.as_str(), self.message)
	}
}

impl std::error::Error for DesktopError {}

impl From<DesktopError> for napi::Error {
	fn from(error: DesktopError) -> Self {
		Self::from_reason(error.to_string())
	}
}

pub type CoreResult<T> = Result<T, DesktopError>;
