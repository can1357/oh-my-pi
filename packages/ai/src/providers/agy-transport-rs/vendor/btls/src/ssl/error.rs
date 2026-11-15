use crate::ffi;
use crate::x509::X509VerifyError;
use libc::c_int;
use openssl_macros::corresponds;
use std::error;
use std::error::Error as StdError;
use std::ffi::CStr;
use std::fmt;
use std::io;

use crate::error::ErrorStack;
use crate::ssl::MidHandshakeSslStream;

/// `SSL_ERROR_*` error code returned from SSL functions.
///
/// This is different than [packed error codes](crate::error::Error).
#[derive(Copy, Clone, PartialEq, Eq)]
pub struct ErrorCode(c_int);

impl ErrorCode {
    /// No error.
    pub const NONE: ErrorCode = ErrorCode(ffi::SSL_ERROR_NONE);

    /// The SSL session has been closed.
    pub const ZERO_RETURN: ErrorCode = ErrorCode(ffi::SSL_ERROR_ZERO_RETURN);

    /// An attempt to read data from the underlying socket returned `WouldBlock`.
    ///
    /// Wait for read readiness and retry the operation.
    pub const WANT_READ: ErrorCode = ErrorCode(ffi::SSL_ERROR_WANT_READ);

    /// An attempt to write data to the underlying socket returned `WouldBlock`.
    ///
    /// Wait for write readiness and retry the operation.
    pub const WANT_WRITE: ErrorCode = ErrorCode(ffi::SSL_ERROR_WANT_WRITE);

    pub const WANT_X509_LOOKUP: ErrorCode = ErrorCode(ffi::SSL_ERROR_WANT_X509_LOOKUP);

    pub const PENDING_SESSION: ErrorCode = ErrorCode(ffi::SSL_ERROR_PENDING_SESSION);

    pub const PENDING_CERTIFICATE: ErrorCode = ErrorCode(ffi::SSL_ERROR_PENDING_CERTIFICATE);

    pub const WANT_CERTIFICATE_VERIFY: ErrorCode =
        ErrorCode(ffi::SSL_ERROR_WANT_CERTIFICATE_VERIFY);

    pub const WANT_PRIVATE_KEY_OPERATION: ErrorCode =
        ErrorCode(ffi::SSL_ERROR_WANT_PRIVATE_KEY_OPERATION);

    pub const PENDING_TICKET: ErrorCode = ErrorCode(ffi::SSL_ERROR_PENDING_TICKET);

    /// A non-recoverable IO error occurred.
    pub const SYSCALL: ErrorCode = ErrorCode(ffi::SSL_ERROR_SYSCALL);

    /// An error occurred in the SSL library.
    pub const SSL: ErrorCode = ErrorCode(ffi::SSL_ERROR_SSL);

    /// Wrap an `SSL_ERROR_*` error code.
    ///
    /// This is different than [packed error codes](crate::error::Error).
    #[must_use]
    #[inline]
    #[cfg_attr(debug_assertions, track_caller)]
    pub fn from_raw(raw: c_int) -> ErrorCode {
        let code = ErrorCode(raw);
        debug_assert!(
            raw < 64 || code.description().is_some(),
            "{raw} is not an SSL_ERROR_* code"
        );
        code
    }

    /// An `SSL_ERROR_*` error code.
    ///
    /// This is different than [packed error codes](crate::error::Error).
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_int {
        self.0
    }

    #[corresponds(SSL_error_description)]
    #[must_use]
    pub fn description(self) -> Option<&'static str> {
        unsafe {
            let msg = ffi::SSL_error_description(self.0);
            if msg.is_null() {
                return None;
            }
            CStr::from_ptr(msg).to_str().ok()
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.description().unwrap_or("error"), self.0)
    }
}

impl fmt::Debug for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

#[derive(Debug)]
pub(crate) enum InnerError {
    Io(io::Error),
    Ssl(ErrorStack),
}

/// A general SSL error, based on [`SSL_ERROR_*` error codes](ErrorCode).
#[derive(Debug)]
pub struct Error {
    pub(crate) code: ErrorCode,
    pub(crate) cause: Option<InnerError>,
}

impl Error {
    /// An `SSL_ERROR_*` error code.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    #[must_use]
    pub fn io_error(&self) -> Option<&io::Error> {
        match self.cause {
            Some(InnerError::Io(ref e)) => Some(e),
            _ => None,
        }
    }

    pub fn into_io_error(self) -> Result<io::Error, Error> {
        match self.cause {
            Some(InnerError::Io(e)) => Ok(e),
            _ => Err(self),
        }
    }

    /// Stack of [library-specific errors](crate::error::Error), if available.
    #[must_use]
    pub fn ssl_error(&self) -> Option<&ErrorStack> {
        match self.cause {
            Some(InnerError::Ssl(ref e)) => Some(e),
            _ => None,
        }
    }

    #[must_use]
    pub fn would_block(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::WANT_READ
                | ErrorCode::WANT_WRITE
                | ErrorCode::WANT_X509_LOOKUP
                | ErrorCode::PENDING_SESSION
                | ErrorCode::PENDING_CERTIFICATE
                | ErrorCode::WANT_PRIVATE_KEY_OPERATION
                | ErrorCode::WANT_CERTIFICATE_VERIFY
                | ErrorCode::PENDING_TICKET
        )
    }
}

impl From<ErrorStack> for Error {
    fn from(e: ErrorStack) -> Error {
        Error {
            code: ErrorCode::SSL,
            cause: Some(InnerError::Ssl(e)),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        let msg = match self.code {
            ErrorCode::ZERO_RETURN => "the SSL session has been shut down",
            ErrorCode::WANT_READ => match self.io_error() {
                Some(_) => "a nonblocking read call would have blocked",
                None => "the operation should be retried",
            },
            ErrorCode::WANT_WRITE => match self.io_error() {
                Some(_) => "a nonblocking write call would have blocked",
                None => "the operation should be retried",
            },
            ErrorCode::SYSCALL => match self.io_error() {
                Some(err) => return err.fmt(fmt),
                None => "unexpected EOF",
            },
            ErrorCode::SSL => match self.ssl_error() {
                Some(err) => return err.fmt(fmt),
                None => "unknown BoringSSL error",
            },
            ErrorCode(code) => return code.fmt(fmt),
        };
        fmt.write_str(msg)
    }
}

impl error::Error for Error {
    fn source(&self) -> Option<&(dyn error::Error + 'static)> {
        match self.cause {
            Some(InnerError::Io(ref e)) => Some(e),
            Some(InnerError::Ssl(ref e)) => Some(e),
            None => None,
        }
    }
}

/// An error or intermediate state after a TLS handshake attempt.
// FIXME overhaul
#[derive(Debug)]
pub enum HandshakeError<S> {
    /// Setup failed.
    SetupFailure(ErrorStack),
    /// The handshake failed.
    Failure(MidHandshakeSslStream<S>),
    /// The handshake encountered a `WouldBlock` error midway through.
    ///
    /// This error will never be returned for blocking streams.
    WouldBlock(MidHandshakeSslStream<S>),
}

impl<S: fmt::Debug> StdError for HandshakeError<S> {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match *self {
            HandshakeError::SetupFailure(ref e) => Some(e),
            HandshakeError::Failure(ref s) | HandshakeError::WouldBlock(ref s) => Some(s.error()),
        }
    }
}

impl<S> fmt::Display for HandshakeError<S> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match *self {
            HandshakeError::SetupFailure(ref e) => {
                write!(f, "TLS stream setup failed {e}")
            }
            HandshakeError::Failure(ref s) => fmt_mid_handshake_error(s, f, "TLS handshake failed"),
            HandshakeError::WouldBlock(ref s) => {
                fmt_mid_handshake_error(s, f, "TLS handshake interrupted")
            }
        }
    }
}

fn fmt_mid_handshake_error(
    s: &MidHandshakeSslStream<impl Sized>,
    f: &mut fmt::Formatter,
    prefix: &str,
) -> fmt::Result {
    if !s.ssl().ssl_context().has_x509_support() {
        write!(f, "{}", prefix)?;
        return write!(f, " {}", s.error());
    }

    match s.ssl().verify_result() {
        // INVALID_CALL is returned if no verification took place,
        // such as before a cert is sent.
        Ok(()) | Err(X509VerifyError::INVALID_CALL) => write!(f, "{prefix}")?,
        Err(verify) => write!(f, "{prefix}: cert verification failed - {verify}")?,
    }

    write!(f, " {}", s.error())
}

impl<S> From<ErrorStack> for HandshakeError<S> {
    fn from(e: ErrorStack) -> HandshakeError<S> {
        HandshakeError::SetupFailure(e)
    }
}
