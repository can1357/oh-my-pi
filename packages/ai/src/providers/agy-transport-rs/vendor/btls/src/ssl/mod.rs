//! SSL/TLS support.
//!
//! `SslConnector` and `SslAcceptor` should be used in most cases - they handle
//! configuration of the OpenSSL primitives for you.
//!
//! # Examples
//!
//! To connect as a client to a remote server:
//!
//! ```no_run
//! use btls::ssl::{SslMethod, SslConnector};
//! use std::io::{Read, Write};
//! use std::net::TcpStream;
//!
//! let connector = SslConnector::builder(SslMethod::tls()).unwrap().build();
//!
//! let stream = TcpStream::connect("google.com:443").unwrap();
//! let mut stream = connector.connect("google.com", stream).unwrap();
//!
//! stream.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
//! let mut res = vec![];
//! stream.read_to_end(&mut res).unwrap();
//! println!("{}", String::from_utf8_lossy(&res));
//! ```
//!
//! To accept connections as a server from remote clients:
//!
//! ```no_run
//! use btls::ssl::{SslMethod, SslAcceptor, SslStream, SslFiletype};
//! use std::net::{TcpListener, TcpStream};
//! use std::sync::Arc;
//! use std::thread;
//!
//!
//! let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
//! acceptor.set_private_key_file("key.pem", SslFiletype::PEM).unwrap();
//! acceptor.set_certificate_chain_file("certs.pem").unwrap();
//! acceptor.check_private_key().unwrap();
//! let acceptor = Arc::new(acceptor.build());
//!
//! let listener = TcpListener::bind("0.0.0.0:8443").unwrap();
//!
//! fn handle_client(stream: SslStream<TcpStream>) {
//!     // ...
//! }
//!
//! for stream in listener.incoming() {
//!     match stream {
//!         Ok(stream) => {
//!             let acceptor = acceptor.clone();
//!             thread::spawn(move || {
//!                 let stream = acceptor.accept(stream).unwrap();
//!                 handle_client(stream);
//!             });
//!         }
//!         Err(e) => { /* connection failed */ }
//!     }
//! }
//! ```
use foreign_types::{ForeignType, ForeignTypeRef, Opaque};
use openssl_macros::corresponds;
use std::any::TypeId;
use std::collections::HashMap;
use std::convert::TryInto;
use std::ffi::{c_char, c_int, c_uchar, c_uint};
use std::ffi::{CStr, CString};
use std::fmt;
use std::io;
use std::io::prelude::*;
use std::marker::PhantomData;
use std::mem::{self, ManuallyDrop, MaybeUninit};
use std::ops::Deref;
use std::panic::resume_unwind;
use std::path::Path;
use std::ptr::{self, NonNull};
use std::slice;
use std::str;
use std::sync::{Arc, LazyLock, Mutex};

use crate::dh::DhRef;
use crate::ec::EcKeyRef;
use crate::error::ErrorStack;
use crate::ex_data::Index;
use crate::hmac::HmacCtxRef;
use crate::nid::Nid;
use crate::pkey::{HasPrivate, PKeyRef, Params, Private};
use crate::srtp::{SrtpProtectionProfile, SrtpProtectionProfileRef};
use crate::ssl::bio::BioMethod;
use crate::ssl::callbacks::*;
#[cfg(not(feature = "fips"))]
use crate::ssl::ech::SslEchKeys;
use crate::ssl::error::InnerError;
use crate::stack::{Stack, StackRef, Stackable};
use crate::symm::CipherCtxRef;
use crate::try_int;
use crate::x509::store::{X509Store, X509StoreBuilder, X509StoreBuilderRef, X509StoreRef};
use crate::x509::verify::X509VerifyParamRef;
use crate::x509::{
    X509Name, X509Ref, X509StoreContextRef, X509VerifyError, X509VerifyResult, X509,
};
use crate::{cvt, cvt_0i, cvt_n, cvt_p, init};
use crate::{ffi, free_data_box};

pub use self::async_callbacks::{
    AsyncPrivateKeyMethod, AsyncPrivateKeyMethodError, AsyncSelectCertError, BoxCustomVerifyFinish,
    BoxCustomVerifyFuture, BoxGetSessionFinish, BoxGetSessionFuture, BoxPrivateKeyMethodFinish,
    BoxPrivateKeyMethodFuture, BoxSelectCertFinish, BoxSelectCertFuture, ExDataFuture,
};
pub use self::connector::{
    ConnectConfiguration, SslAcceptor, SslAcceptorBuilder, SslConnector, SslConnectorBuilder,
};
#[cfg(feature = "credential")]
pub use self::credential::{SslCredential, SslCredentialBuilder, SslCredentialRef};
pub use self::ech::SslEchKeysRef;
pub use self::error::{Error, ErrorCode, HandshakeError};

mod async_callbacks;
mod bio;
mod callbacks;
mod connector;
#[cfg(feature = "credential")]
mod credential;
mod ech;
mod error;
mod mut_only;
#[cfg(test)]
mod test;

bitflags! {
    /// Options controlling the behavior of an `SslContext`.
    #[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
    pub struct SslOptions: c_uint {
        /// Disables a countermeasure against an SSLv3/TLSv1.0 vulnerability affecting CBC ciphers.
        const DONT_INSERT_EMPTY_FRAGMENTS = ffi::SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS as _;

        /// A "reasonable default" set of options which enables compatibility flags.
        const ALL = ffi::SSL_OP_ALL as _;

        /// Do not query the MTU.
        ///
        /// Only affects DTLS connections.
        const NO_QUERY_MTU = ffi::SSL_OP_NO_QUERY_MTU as _;

        /// Disables the use of session tickets for session resumption.
        const NO_TICKET = ffi::SSL_OP_NO_TICKET as _;

        /// Always start a new session when performing a renegotiation on the server side.
        const NO_SESSION_RESUMPTION_ON_RENEGOTIATION =
            ffi::SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION as _;

        /// Disables the use of TLS compression.
        const NO_COMPRESSION = ffi::SSL_OP_NO_COMPRESSION as _;

        /// Allow legacy insecure renegotiation with servers or clients that do not support secure
        /// renegotiation.
        const ALLOW_UNSAFE_LEGACY_RENEGOTIATION =
            ffi::SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION as _;

        /// Creates a new key for each session when using ECDHE.
        const SINGLE_ECDH_USE = ffi::SSL_OP_SINGLE_ECDH_USE as _;

        /// Creates a new key for each session when using DHE.
        const SINGLE_DH_USE = ffi::SSL_OP_SINGLE_DH_USE as _;

        /// Use the server's preferences rather than the client's when selecting a cipher.
        ///
        /// This has no effect on the client side.
        const CIPHER_SERVER_PREFERENCE = ffi::SSL_OP_CIPHER_SERVER_PREFERENCE as _;

        /// Disables version rollback attach detection.
        const TLS_ROLLBACK_BUG = ffi::SSL_OP_TLS_ROLLBACK_BUG as _;

        /// Disables the use of SSLv2.
        const NO_SSLV2 = ffi::SSL_OP_NO_SSLv2 as _;

        /// Disables the use of SSLv3.
        const NO_SSLV3 = ffi::SSL_OP_NO_SSLv3 as _;

        /// Disables the use of TLSv1.0.
        const NO_TLSV1 = ffi::SSL_OP_NO_TLSv1 as _;

        /// Disables the use of TLSv1.1.
        const NO_TLSV1_1 = ffi::SSL_OP_NO_TLSv1_1 as _;

        /// Disables the use of TLSv1.2.
        const NO_TLSV1_2 = ffi::SSL_OP_NO_TLSv1_2 as _;

        /// Disables the use of TLSv1.3.
        const NO_TLSV1_3 = ffi::SSL_OP_NO_TLSv1_3 as _;

        /// Disables the use of DTLSv1.0
        const NO_DTLSV1 = ffi::SSL_OP_NO_DTLSv1 as _;

        /// Disables the use of DTLSv1.2.
        const NO_DTLSV1_2 = ffi::SSL_OP_NO_DTLSv1_2 as _;

        /// Disallow all renegotiation in TLSv1.2 and earlier.
        const NO_RENEGOTIATION = ffi::SSL_OP_NO_RENEGOTIATION as _;

        /// Disables PSK with DHE.
        const NO_PSK_DHE_KE = ffi::SSL_OP_NO_PSK_DHE_KE as _;
    }
}

bitflags! {
    /// Options controlling the behavior of an `SslContext`.
    #[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
    pub struct SslMode: c_uint {
        /// Enables "short writes".
        ///
        /// Normally, a write in OpenSSL will always write out all of the requested data, even if it
        /// requires more than one TLS record or write to the underlying stream. This option will
        /// cause a write to return after writing a single TLS record instead.
        const ENABLE_PARTIAL_WRITE = ffi::SSL_MODE_ENABLE_PARTIAL_WRITE as _;

        /// Disables a check that the data buffer has not moved between calls when operating in a
        /// nonblocking context.
        const ACCEPT_MOVING_WRITE_BUFFER = ffi::SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER as _;

        /// Enables automatic retries after TLS session events such as renegotiations or heartbeats.
        ///
        /// By default, OpenSSL will return a `WantRead` error after a renegotiation or heartbeat.
        /// This option will cause OpenSSL to automatically continue processing the requested
        /// operation instead.
        ///
        /// Note that `SslStream::read` and `SslStream::write` will automatically retry regardless
        /// of the state of this option. It only affects `SslStream::ssl_read` and
        /// `SslStream::ssl_write`.
        const AUTO_RETRY = ffi::SSL_MODE_AUTO_RETRY as _;

        /// Disables automatic chain building when verifying a peer's certificate.
        ///
        /// TLS peers are responsible for sending the entire certificate chain from the leaf to a
        /// trusted root, but some will incorrectly not do so. OpenSSL will try to build the chain
        /// out of certificates it knows of, and this option will disable that behavior.
        const NO_AUTO_CHAIN = ffi::SSL_MODE_NO_AUTO_CHAIN as _;

        /// Release memory buffers when the session does not need them.
        ///
        /// This saves ~34 KiB of memory for idle streams.
        const RELEASE_BUFFERS = ffi::SSL_MODE_RELEASE_BUFFERS as _;

        /// Sends the fake `TLS_FALLBACK_SCSV` cipher suite in the ClientHello message of a
        /// handshake.
        ///
        /// This should only be enabled if a client has failed to connect to a server which
        /// attempted to downgrade the protocol version of the session.
        ///
        /// Do not use this unless you know what you're doing!
        const SEND_FALLBACK_SCSV = ffi::SSL_MODE_SEND_FALLBACK_SCSV as _;
    }
}

/// A type specifying the kind of protocol an `SslContext` will speak.
#[derive(Copy, Clone)]
pub struct SslMethod {
    ptr: *const ffi::SSL_METHOD,
    is_x509_method: bool,
}

impl SslMethod {
    /// Support all versions of the TLS protocol.
    #[corresponds(TLS_method)]
    #[must_use]
    pub fn tls() -> Self {
        unsafe {
            Self {
                ptr: ffi::TLS_method(),
                is_x509_method: true,
            }
        }
    }

    /// Same as `tls`, but doesn't create X.509 for certificates.
    ///
    /// # Safety
    ///
    /// BoringSSL will crash if the user calls a function that involves
    /// X.509 certificates with an object configured with this method.
    /// You most probably don't need it.
    #[must_use]
    pub unsafe fn tls_with_buffer() -> Self {
        unsafe {
            Self {
                ptr: ffi::TLS_with_buffers_method(),
                is_x509_method: false,
            }
        }
    }

    /// Support all versions of the DTLS protocol.
    #[corresponds(DTLS_method)]
    #[must_use]
    pub fn dtls() -> Self {
        unsafe {
            Self {
                ptr: ffi::DTLS_method(),
                is_x509_method: true,
            }
        }
    }

    /// Constructs an `SslMethod` from a pointer to the underlying OpenSSL value.
    ///
    /// This method assumes that the `SslMethod` is not configured for X.509
    /// certificates. The user can call `SslMethod::assume_x509_method`
    /// to change that.
    ///
    /// # Safety
    ///
    /// The caller must ensure the pointer is valid.
    #[corresponds(TLS_server_method)]
    #[must_use]
    pub unsafe fn from_ptr(ptr: *const ffi::SSL_METHOD) -> SslMethod {
        SslMethod {
            ptr,
            is_x509_method: false,
        }
    }

    /// Assumes that this `SslMethod` is configured for X.509 certificates.
    ///
    /// # Safety
    ///
    /// BoringSSL will crash if the user calls a function that involves
    /// X.509 certificates with an object configured with this method.
    /// You most probably don't need it.
    pub unsafe fn assume_x509(&mut self) {
        self.is_x509_method = true;
    }

    /// Returns a pointer to the underlying OpenSSL value.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_ptr(&self) -> *const ffi::SSL_METHOD {
        self.ptr
    }
}

unsafe impl Sync for SslMethod {}
unsafe impl Send for SslMethod {}

bitflags! {
    /// Options controlling the behavior of certificate verification.
    #[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
    pub struct SslVerifyMode: i32 {
        /// Verifies that the peer's certificate is trusted.
        ///
        /// On the server side, this will cause OpenSSL to request a certificate from the client.
        const PEER = ffi::SSL_VERIFY_PEER;

        /// Disables verification of the peer's certificate.
        ///
        /// On the server side, this will cause OpenSSL to not request a certificate from the
        /// client. On the client side, the certificate will be checked for validity, but the
        /// negotiation will continue regardless of the result of that check.
        const NONE = ffi::SSL_VERIFY_NONE;

        /// On the server side, abort the handshake if the client did not send a certificate.
        ///
        /// This should be paired with `SSL_VERIFY_PEER`. It has no effect on the client side.
        const FAIL_IF_NO_PEER_CERT = ffi::SSL_VERIFY_FAIL_IF_NO_PEER_CERT;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SslVerifyError {
    Invalid(SslAlert),
    Retry,
}

bitflags! {
    /// Options controlling the behavior of session caching.
    #[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
    pub struct SslSessionCacheMode: c_int {
        /// No session caching for the client or server takes place.
        const OFF = ffi::SSL_SESS_CACHE_OFF;

        /// Enable session caching on the client side.
        ///
        /// OpenSSL has no way of identifying the proper session to reuse automatically, so the
        /// application is responsible for setting it explicitly via [`SslRef::set_session`].
        ///
        /// [`SslRef::set_session`]: struct.SslRef.html#method.set_session
        const CLIENT = ffi::SSL_SESS_CACHE_CLIENT;

        /// Enable session caching on the server side.
        ///
        /// This is the default mode.
        const SERVER = ffi::SSL_SESS_CACHE_SERVER;

        /// Enable session caching on both the client and server side.
        const BOTH = ffi::SSL_SESS_CACHE_BOTH;

        /// Disable automatic removal of expired sessions from the session cache.
        const NO_AUTO_CLEAR = ffi::SSL_SESS_CACHE_NO_AUTO_CLEAR;

        /// Disable use of the internal session cache for session lookups.
        const NO_INTERNAL_LOOKUP = ffi::SSL_SESS_CACHE_NO_INTERNAL_LOOKUP;

        /// Disable use of the internal session cache for session storage.
        const NO_INTERNAL_STORE = ffi::SSL_SESS_CACHE_NO_INTERNAL_STORE;

        /// Disable use of the internal session cache for storage and lookup.
        const NO_INTERNAL = ffi::SSL_SESS_CACHE_NO_INTERNAL;
    }
}

/// An identifier of the format of a certificate or key file.
#[derive(Copy, Clone)]
pub struct SslFiletype(c_int);

impl SslFiletype {
    /// The PEM format.
    ///
    /// This corresponds to `SSL_FILETYPE_PEM`.
    pub const PEM: SslFiletype = SslFiletype(ffi::SSL_FILETYPE_PEM);

    /// The ASN1 format.
    ///
    /// This corresponds to `SSL_FILETYPE_ASN1`.
    pub const ASN1: SslFiletype = SslFiletype(ffi::SSL_FILETYPE_ASN1);

    /// Constructs an `SslFiletype` from a raw OpenSSL value.
    #[must_use]
    pub fn from_raw(raw: c_int) -> SslFiletype {
        SslFiletype(raw)
    }

    /// Returns the raw OpenSSL value represented by this type.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_int {
        self.0
    }
}

/// An identifier of a certificate status type.
#[derive(Copy, Clone)]
pub struct StatusType(c_int);

impl StatusType {
    /// An OSCP status.
    pub const OCSP: StatusType = StatusType(ffi::TLSEXT_STATUSTYPE_ocsp);

    /// Constructs a `StatusType` from a raw OpenSSL value.
    #[must_use]
    pub fn from_raw(raw: c_int) -> StatusType {
        StatusType(raw)
    }

    /// Returns the raw OpenSSL value represented by this type.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_int {
        self.0
    }
}

/// An identifier of a session name type.
#[derive(Copy, Clone)]
pub struct NameType(c_int);

impl NameType {
    /// A host name.
    pub const HOST_NAME: NameType = NameType(ffi::TLSEXT_NAMETYPE_host_name);

    /// Constructs a `StatusType` from a raw OpenSSL value.
    #[must_use]
    pub fn from_raw(raw: c_int) -> StatusType {
        StatusType(raw)
    }

    /// Returns the raw OpenSSL value represented by this type.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_int {
        self.0
    }
}

static INDEXES: LazyLock<Mutex<HashMap<TypeId, c_int>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SSL_INDEXES: LazyLock<Mutex<HashMap<TypeId, c_int>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SESSION_CTX_INDEX: LazyLock<Index<Ssl, SslContext>> =
    LazyLock::new(|| Ssl::new_ex_index().unwrap());
static X509_FLAG_INDEX: LazyLock<Index<SslContext, bool>> =
    LazyLock::new(|| SslContext::new_ex_index().unwrap());

/// An error returned from the SNI callback.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct SniError(c_int);

impl SniError {
    /// Abort the handshake with a fatal alert.
    pub const ALERT_FATAL: SniError = SniError(ffi::SSL_TLSEXT_ERR_ALERT_FATAL);

    /// Send a warning alert to the client and continue the handshake.
    pub const ALERT_WARNING: SniError = SniError(ffi::SSL_TLSEXT_ERR_ALERT_WARNING);

    pub const NOACK: SniError = SniError(ffi::SSL_TLSEXT_ERR_NOACK);
}

/// An SSL/TLS alert.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct SslAlert(c_int);

impl SslAlert {
    pub const CLOSE_NOTIFY: Self = Self(ffi::SSL_AD_CLOSE_NOTIFY);
    pub const UNEXPECTED_MESSAGE: Self = Self(ffi::SSL_AD_UNEXPECTED_MESSAGE);
    pub const BAD_RECORD_MAC: Self = Self(ffi::SSL_AD_BAD_RECORD_MAC);
    pub const DECRYPTION_FAILED: Self = Self(ffi::SSL_AD_DECRYPTION_FAILED);
    pub const RECORD_OVERFLOW: Self = Self(ffi::SSL_AD_RECORD_OVERFLOW);
    pub const DECOMPRESSION_FAILURE: Self = Self(ffi::SSL_AD_DECOMPRESSION_FAILURE);
    pub const HANDSHAKE_FAILURE: Self = Self(ffi::SSL_AD_HANDSHAKE_FAILURE);
    pub const NO_CERTIFICATE: Self = Self(ffi::SSL_AD_NO_CERTIFICATE);
    pub const BAD_CERTIFICATE: Self = Self(ffi::SSL_AD_BAD_CERTIFICATE);
    pub const UNSUPPORTED_CERTIFICATE: Self = Self(ffi::SSL_AD_UNSUPPORTED_CERTIFICATE);
    pub const CERTIFICATE_REVOKED: Self = Self(ffi::SSL_AD_CERTIFICATE_REVOKED);
    pub const CERTIFICATE_EXPIRED: Self = Self(ffi::SSL_AD_CERTIFICATE_EXPIRED);
    pub const CERTIFICATE_UNKNOWN: Self = Self(ffi::SSL_AD_CERTIFICATE_UNKNOWN);
    pub const ILLEGAL_PARAMETER: Self = Self(ffi::SSL_AD_ILLEGAL_PARAMETER);
    pub const UNKNOWN_CA: Self = Self(ffi::SSL_AD_UNKNOWN_CA);
    pub const ACCESS_DENIED: Self = Self(ffi::SSL_AD_ACCESS_DENIED);
    pub const DECODE_ERROR: Self = Self(ffi::SSL_AD_DECODE_ERROR);
    pub const DECRYPT_ERROR: Self = Self(ffi::SSL_AD_DECRYPT_ERROR);
    pub const EXPORT_RESTRICTION: Self = Self(ffi::SSL_AD_EXPORT_RESTRICTION);
    pub const PROTOCOL_VERSION: Self = Self(ffi::SSL_AD_PROTOCOL_VERSION);
    pub const INSUFFICIENT_SECURITY: Self = Self(ffi::SSL_AD_INSUFFICIENT_SECURITY);
    pub const INTERNAL_ERROR: Self = Self(ffi::SSL_AD_INTERNAL_ERROR);
    pub const INAPPROPRIATE_FALLBACK: Self = Self(ffi::SSL_AD_INAPPROPRIATE_FALLBACK);
    pub const USER_CANCELLED: Self = Self(ffi::SSL_AD_USER_CANCELLED);
    pub const NO_RENEGOTIATION: Self = Self(ffi::SSL_AD_NO_RENEGOTIATION);
    pub const MISSING_EXTENSION: Self = Self(ffi::SSL_AD_MISSING_EXTENSION);
    pub const UNSUPPORTED_EXTENSION: Self = Self(ffi::SSL_AD_UNSUPPORTED_EXTENSION);
    pub const CERTIFICATE_UNOBTAINABLE: Self = Self(ffi::SSL_AD_CERTIFICATE_UNOBTAINABLE);
    pub const UNRECOGNIZED_NAME: Self = Self(ffi::SSL_AD_UNRECOGNIZED_NAME);
    pub const BAD_CERTIFICATE_STATUS_RESPONSE: Self =
        Self(ffi::SSL_AD_BAD_CERTIFICATE_STATUS_RESPONSE);
    pub const BAD_CERTIFICATE_HASH_VALUE: Self = Self(ffi::SSL_AD_BAD_CERTIFICATE_HASH_VALUE);
    pub const UNKNOWN_PSK_IDENTITY: Self = Self(ffi::SSL_AD_UNKNOWN_PSK_IDENTITY);
    pub const CERTIFICATE_REQUIRED: Self = Self(ffi::SSL_AD_CERTIFICATE_REQUIRED);
    pub const NO_APPLICATION_PROTOCOL: Self = Self(ffi::SSL_AD_NO_APPLICATION_PROTOCOL);
}

/// An error returned from an ALPN selection callback.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct AlpnError(c_int);

impl AlpnError {
    /// Terminate the handshake with a fatal alert.
    pub const ALERT_FATAL: AlpnError = AlpnError(ffi::SSL_TLSEXT_ERR_ALERT_FATAL);

    /// Do not select a protocol, but continue the handshake.
    pub const NOACK: AlpnError = AlpnError(ffi::SSL_TLSEXT_ERR_NOACK);
}

/// An error returned from a certificate selection callback.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct SelectCertError(ffi::ssl_select_cert_result_t);

impl SelectCertError {
    /// A fatal error occurred and the handshake should be terminated.
    pub const ERROR: Self = Self(ffi::ssl_select_cert_result_t::ssl_select_cert_error);

    /// The operation could not be completed and should be retried later.
    pub const RETRY: Self = Self(ffi::ssl_select_cert_result_t::ssl_select_cert_retry);
}

/// Extension types, to be used with `ClientHello::get_extension`.
///
/// **WARNING**: The current implementation of `From` is unsound, as it's possible to create an
/// ExtensionType that is not defined by the impl. `From` will be deprecated in favor of `TryFrom`
/// in the next major bump of the library.
#[repr(transparent)]
#[derive(Debug, Copy, Clone, Hash, PartialEq, Eq)]
pub struct ExtensionType(u16);

impl ExtensionType {
    pub const SERVER_NAME: Self = Self(ffi::TLSEXT_TYPE_server_name as u16);
    pub const STATUS_REQUEST: Self = Self(ffi::TLSEXT_TYPE_status_request as u16);
    pub const EC_POINT_FORMATS: Self = Self(ffi::TLSEXT_TYPE_ec_point_formats as u16);
    pub const SIGNATURE_ALGORITHMS: Self = Self(ffi::TLSEXT_TYPE_signature_algorithms as u16);
    pub const SRTP: Self = Self(ffi::TLSEXT_TYPE_srtp as u16);
    pub const APPLICATION_LAYER_PROTOCOL_NEGOTIATION: Self =
        Self(ffi::TLSEXT_TYPE_application_layer_protocol_negotiation as u16);
    pub const PADDING: Self = Self(ffi::TLSEXT_TYPE_padding as u16);
    pub const EXTENDED_MASTER_SECRET: Self = Self(ffi::TLSEXT_TYPE_extended_master_secret as u16);
    pub const QUIC_TRANSPORT_PARAMETERS_LEGACY: Self =
        Self(ffi::TLSEXT_TYPE_quic_transport_parameters_legacy as u16);
    pub const QUIC_TRANSPORT_PARAMETERS_STANDARD: Self =
        Self(ffi::TLSEXT_TYPE_quic_transport_parameters_standard as u16);
    pub const CERT_COMPRESSION: Self = Self(ffi::TLSEXT_TYPE_cert_compression as u16);
    pub const SESSION_TICKET: Self = Self(ffi::TLSEXT_TYPE_session_ticket as u16);
    pub const SUPPORTED_GROUPS: Self = Self(ffi::TLSEXT_TYPE_supported_groups as u16);
    pub const PRE_SHARED_KEY: Self = Self(ffi::TLSEXT_TYPE_pre_shared_key as u16);
    pub const EARLY_DATA: Self = Self(ffi::TLSEXT_TYPE_early_data as u16);
    pub const SUPPORTED_VERSIONS: Self = Self(ffi::TLSEXT_TYPE_supported_versions as u16);
    pub const COOKIE: Self = Self(ffi::TLSEXT_TYPE_cookie as u16);
    pub const PSK_KEY_EXCHANGE_MODES: Self = Self(ffi::TLSEXT_TYPE_psk_key_exchange_modes as u16);
    pub const CERTIFICATE_AUTHORITIES: Self = Self(ffi::TLSEXT_TYPE_certificate_authorities as u16);
    pub const SIGNATURE_ALGORITHMS_CERT: Self =
        Self(ffi::TLSEXT_TYPE_signature_algorithms_cert as u16);
    pub const KEY_SHARE: Self = Self(ffi::TLSEXT_TYPE_key_share as u16);
    pub const RENEGOTIATE: Self = Self(ffi::TLSEXT_TYPE_renegotiate as u16);
    pub const DELEGATED_CREDENTIAL: Self = Self(ffi::TLSEXT_TYPE_delegated_credential as u16);
    pub const APPLICATION_SETTINGS: Self = Self(ffi::TLSEXT_TYPE_application_settings as u16);
    pub const APPLICATION_SETTINGS_OLD: Self =
        Self(ffi::TLSEXT_TYPE_application_settings_old as u16);
    pub const ENCRYPTED_CLIENT_HELLO: Self = Self(ffi::TLSEXT_TYPE_encrypted_client_hello as u16);
    pub const CERTIFICATE_TIMESTAMP: Self = Self(ffi::TLSEXT_TYPE_certificate_timestamp as u16);
    pub const NEXT_PROTO_NEG: Self = Self(ffi::TLSEXT_TYPE_next_proto_neg as u16);
    pub const CHANNEL_ID: Self = Self(ffi::TLSEXT_TYPE_channel_id as u16);
    pub const RECORD_SIZE_LIMIT: Self = Self(ffi::TLSEXT_TYPE_record_size_limit as u16);
}

impl From<u16> for ExtensionType {
    fn from(value: u16) -> Self {
        Self(value)
    }
}

/// An SSL/TLS protocol version.
#[derive(Copy, Clone, Hash, PartialEq, Eq)]
pub struct SslVersion(u16);

impl SslVersion {
    /// SSLv3
    pub const SSL3: SslVersion = SslVersion(ffi::SSL3_VERSION as _);

    /// TLSv1.0
    pub const TLS1: SslVersion = SslVersion(ffi::TLS1_VERSION as _);

    /// TLSv1.1
    pub const TLS1_1: SslVersion = SslVersion(ffi::TLS1_1_VERSION as _);

    /// TLSv1.2
    pub const TLS1_2: SslVersion = SslVersion(ffi::TLS1_2_VERSION as _);

    /// TLSv1.3
    pub const TLS1_3: SslVersion = SslVersion(ffi::TLS1_3_VERSION as _);
}

impl TryFrom<u16> for SslVersion {
    type Error = &'static str;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match i32::from(value) {
            ffi::SSL3_VERSION
            | ffi::TLS1_VERSION
            | ffi::TLS1_1_VERSION
            | ffi::TLS1_2_VERSION
            | ffi::TLS1_3_VERSION => Ok(Self(value)),
            _ => Err("Unknown SslVersion"),
        }
    }
}

impl fmt::Debug for SslVersion {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match *self {
            Self::SSL3 => "SSL3",
            Self::TLS1 => "TLS1",
            Self::TLS1_1 => "TLS1_1",
            Self::TLS1_2 => "TLS1_2",
            Self::TLS1_3 => "TLS1_3",
            _ => return write!(f, "{:#06x}", self.0),
        })
    }
}

impl fmt::Display for SslVersion {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match *self {
            Self::SSL3 => "SSLv3",
            Self::TLS1 => "TLSv1",
            Self::TLS1_1 => "TLSv1.1",
            Self::TLS1_2 => "TLSv1.2",
            Self::TLS1_3 => "TLSv1.3",
            _ => return write!(f, "unknown ({:#06x})", self.0),
        })
    }
}

/// A signature verification algorithm.
///
/// **WARNING**: The current implementation of `From` is unsound, as it's possible to create an
/// SslSignatureAlgorithm that is not defined by the impl. `From` will be deprecated in favor of
/// `TryFrom` in the next major bump of the library.
#[repr(transparent)]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct SslSignatureAlgorithm(u16);

impl SslSignatureAlgorithm {
    pub const RSA_PKCS1_SHA1: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PKCS1_SHA1 as _);

    pub const RSA_PKCS1_SHA256: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PKCS1_SHA256 as _);

    pub const RSA_PKCS1_SHA384: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PKCS1_SHA384 as _);

    pub const RSA_PKCS1_SHA512: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PKCS1_SHA512 as _);

    pub const RSA_PKCS1_MD5_SHA1: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PKCS1_MD5_SHA1 as _);

    pub const ECDSA_SHA1: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_ECDSA_SHA1 as _);

    pub const ECDSA_SECP256R1_SHA256: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_ECDSA_SECP256R1_SHA256 as _);

    pub const ECDSA_SECP384R1_SHA384: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_ECDSA_SECP384R1_SHA384 as _);

    pub const ECDSA_SECP521R1_SHA512: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_ECDSA_SECP521R1_SHA512 as _);

    pub const RSA_PSS_RSAE_SHA256: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PSS_RSAE_SHA256 as _);

    pub const RSA_PSS_RSAE_SHA384: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PSS_RSAE_SHA384 as _);

    pub const RSA_PSS_RSAE_SHA512: SslSignatureAlgorithm =
        SslSignatureAlgorithm(ffi::SSL_SIGN_RSA_PSS_RSAE_SHA512 as _);

    pub const ED25519: SslSignatureAlgorithm = SslSignatureAlgorithm(ffi::SSL_SIGN_ED25519 as _);
}

impl From<u16> for SslSignatureAlgorithm {
    fn from(value: u16) -> Self {
        Self(value)
    }
}

/// A TLS key share group.
#[repr(transparent)]
#[derive(Debug, Copy, Clone, Hash, PartialEq, Eq)]
pub struct KeyShare(u16);

impl KeyShare {
    pub const P256: KeyShare = KeyShare(ffi::SSL_GROUP_SECP256R1 as _);

    pub const P384: KeyShare = KeyShare(ffi::SSL_GROUP_SECP384R1 as _);

    pub const P521: KeyShare = KeyShare(ffi::SSL_GROUP_SECP521R1 as _);

    pub const X25519: KeyShare = KeyShare(ffi::SSL_GROUP_X25519 as _);

    pub const X25519_MLKEM768: KeyShare = KeyShare(ffi::SSL_GROUP_X25519_MLKEM768 as _);

    pub const X25519_KYBER768_DRAFT00: KeyShare =
        KeyShare(ffi::SSL_GROUP_X25519_KYBER768_DRAFT00 as _);

    pub const P256_KYBER768_DRAFT00: KeyShare = KeyShare(ffi::SSL_GROUP_P256_KYBER768_DRAFT00 as _);

    pub const MLKEM1024: KeyShare = KeyShare(ffi::SSL_GROUP_MLKEM1024 as _);

    pub const FFDHE2048: KeyShare = KeyShare(ffi::SSL_GROUP_FFDHE2048 as _);

    pub const FFDHE3072: KeyShare = KeyShare(ffi::SSL_GROUP_FFDHE3072 as _);
}

/// A compliance policy.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct CompliancePolicy(ffi::ssl_compliance_policy_t);

impl CompliancePolicy {
    /// Does nothing, however setting this does not undo other policies, so trying to set this is an error.
    #[cfg(not(feature = "legacy-compat-deprecated"))]
    pub const NONE: Self = Self(ffi::ssl_compliance_policy_t::ssl_compliance_policy_none);

    /// Configures a TLS connection to try and be compliant with NIST requirements, but does not guarantee success.
    /// This policy can be called even if Boring is not built with FIPS.
    pub const FIPS_202205: Self =
        Self(ffi::ssl_compliance_policy_t::ssl_compliance_policy_fips_202205);

    /// Partially configures a TLS connection to be compliant with WPA3. Callers must enforce certificate chain requirements themselves.
    /// Use of this policy is less secure than the default and not recommended.
    #[cfg(not(feature = "legacy-compat-deprecated"))]
    pub const WPA3_192_202304: Self =
        Self(ffi::ssl_compliance_policy_t::ssl_compliance_policy_wpa3_192_202304);
}

// IANA assigned identifier of compression algorithm. See https://www.rfc-editor.org/rfc/rfc8879.html#name-compression-algorithms
#[derive(Debug, Copy, Clone, Hash, PartialEq, Eq)]
pub struct CertificateCompressionAlgorithm(u16);

impl CertificateCompressionAlgorithm {
    pub const ZLIB: Self = Self(ffi::TLSEXT_cert_compression_zlib as u16);

    pub const BROTLI: Self = Self(ffi::TLSEXT_cert_compression_brotli as u16);

    pub const ZSTD: Self = Self(ffi::TLSEXT_cert_compression_zstd as u16);
}

/// A standard implementation of protocol selection for Application Layer Protocol Negotiation
/// (ALPN).
///
/// `server` should contain the server's list of supported protocols and `client` the client's. They
/// must both be in the ALPN wire format. See the documentation for
/// [`SslContextBuilder::set_alpn_protos`] for details.
///
/// It will select the first protocol supported by the server which is also supported by the client.
///
/// [`SslContextBuilder::set_alpn_protos`]: struct.SslContextBuilder.html#method.set_alpn_protos
#[corresponds(SSL_select_next_proto)]
#[must_use]
pub fn select_next_proto<'a>(server: &'a [u8], client: &'a [u8]) -> Option<&'a [u8]> {
    if server.is_empty() || client.is_empty() {
        return None;
    }

    unsafe {
        let mut out = ptr::null_mut();
        let mut outlen = 0;
        let r = ffi::SSL_select_next_proto(
            &mut out,
            &mut outlen,
            server.as_ptr(),
            try_int(server.len()).ok()?,
            client.as_ptr(),
            try_int(client.len()).ok()?,
        );

        if r == ffi::OPENSSL_NPN_NEGOTIATED {
            Some(slice::from_raw_parts(out.cast_const(), outlen as usize))
        } else {
            None
        }
    }
}

/// Options controlling the behavior of the info callback.
#[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
pub struct SslInfoCallbackMode(i32);

impl SslInfoCallbackMode {
    /// Signaled for each alert received, warning or fatal.
    pub const READ_ALERT: Self = Self(ffi::SSL_CB_READ_ALERT);

    /// Signaled for each alert sent, warning or fatal.
    pub const WRITE_ALERT: Self = Self(ffi::SSL_CB_WRITE_ALERT);

    /// Signaled when a handshake begins.
    pub const HANDSHAKE_START: Self = Self(ffi::SSL_CB_HANDSHAKE_START);

    /// Signaled when a handshake completes successfully.
    pub const HANDSHAKE_DONE: Self = Self(ffi::SSL_CB_HANDSHAKE_DONE);

    /// Signaled when a handshake progresses to a new state.
    pub const ACCEPT_LOOP: Self = Self(ffi::SSL_CB_ACCEPT_LOOP);

    /// Signaled when the current iteration of the server-side handshake state machine completes.
    pub const ACCEPT_EXIT: Self = Self(ffi::SSL_CB_ACCEPT_EXIT);

    /// Signaled when the current iteration of the client-side handshake state machine completes.
    pub const CONNECT_EXIT: Self = Self(ffi::SSL_CB_CONNECT_EXIT);
}

/// The `value` argument to an info callback. The most-significant byte is the alert level, while
/// the least significant byte is the alert itself.
#[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
pub enum SslInfoCallbackValue {
    /// The unit value (1). Some BoringSSL info callback modes, like ACCEPT_LOOP, always call the
    /// callback with `value` set to the unit value. If the [`SslInfoCallbackValue`] is a
    /// `Unit`, it can safely be disregarded.
    Unit,
    /// An alert. See [`SslInfoCallbackAlert`] for details on how to manipulate the alert. This
    /// variant should only be present if the info callback was called with a `READ_ALERT` or
    /// `WRITE_ALERT` mode.
    Alert(SslInfoCallbackAlert),
}

/// Ticket key callback status.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum TicketKeyCallbackResult {
    /// Abort the handshake.
    Error,

    /// Continue with a full handshake.
    ///
    /// When in decryption mode, this indicates that the peer supplied session ticket was not
    /// recognized. When in encryption mode, this instructs btls to not send a session ticket.
    ///
    /// # Note
    ///
    /// This is a decryption specific status code when using the submoduled BoringSSL.
    Noop,

    /// Resumption callback was successful.
    ///
    /// When in decryption mode, attempt an abbreviated handshake via session resumption. When in
    /// encryption mode, provide a new ticket to the client.
    Success,

    /// Resumption callback was successful. Attempt an abbreviated handshake, and additionally
    /// provide new session tickets to the peer.
    ///
    /// Session resumption short-circuits some security checks of a full-handshake, in exchange for
    /// potential performance gains. For this reason, a session ticket should only be valid for a
    /// limited time. Providing the peer with renewed session tickets allows them to continue
    /// session resumption with the new tickets.
    ///
    /// # Note
    ///
    /// This is a decryption specific status code.
    DecryptSuccessRenew,
}

impl From<TicketKeyCallbackResult> for c_int {
    fn from(value: TicketKeyCallbackResult) -> Self {
        match value {
            TicketKeyCallbackResult::Error => -1,
            TicketKeyCallbackResult::Noop => 0,
            TicketKeyCallbackResult::Success => 1,
            TicketKeyCallbackResult::DecryptSuccessRenew => 2,
        }
    }
}

#[derive(Hash, Copy, Clone, PartialOrd, Ord, Eq, PartialEq, Debug)]
pub struct SslInfoCallbackAlert(c_int);

impl SslInfoCallbackAlert {
    /// The level of the SSL alert.
    #[must_use]
    pub fn alert_level(&self) -> Ssl3AlertLevel {
        let value = self.0 >> 8;
        Ssl3AlertLevel(value)
    }

    /// The value of the SSL alert.
    #[must_use]
    pub fn alert(&self) -> SslAlert {
        let value = self.0 & i32::from(u8::MAX);
        SslAlert(value)
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct Ssl3AlertLevel(c_int);

impl Ssl3AlertLevel {
    pub const WARNING: Ssl3AlertLevel = Self(ffi::SSL3_AL_WARNING);
    pub const FATAL: Ssl3AlertLevel = Self(ffi::SSL3_AL_FATAL);
}

/// A builder for `SslContext`s.
pub struct SslContextBuilder {
    ctx: SslContext,
    /// If it's not shared, it can be exposed as mutable
    has_shared_cert_store: bool,
}

impl SslContextBuilder {
    /// Creates a new `SslContextBuilder`.
    #[corresponds(SSL_CTX_new)]
    pub fn new(method: SslMethod) -> Result<SslContextBuilder, ErrorStack> {
        unsafe {
            init();
            let ctx = cvt_p(ffi::SSL_CTX_new(method.as_ptr()))?;
            let mut builder = SslContextBuilder::from_ptr(ctx);

            if method.is_x509_method {
                builder.ctx.assume_x509();
            }

            Ok(builder)
        }
    }

    /// Creates an `SslContextBuilder` from a pointer to a raw OpenSSL value.
    ///
    /// This method can find out whether `ctx` is configured for X.509 certificates
    /// if `ctx` was itself a context created by this crate. If it was created by
    /// other means and it supports X.509 certificates, the use can call
    /// `SslContextBuilder::assume_x509`.
    ///
    /// # Safety
    ///
    /// The caller must ensure that the pointer is valid and uniquely owned by the builder.
    /// The context must own its cert store exclusively.
    pub unsafe fn from_ptr(ctx: *mut ffi::SSL_CTX) -> Self {
        Self {
            ctx: unsafe { SslContext::from_ptr(ctx) },
            has_shared_cert_store: false,
        }
    }

    /// Assumes that this `SslContextBuilder` is configured for X.509 certificates.
    ///
    /// # Safety
    ///
    /// BoringSSL will crash if the user calls a function that involves
    /// X.509 certificates with an object configured with this method.
    /// You most probably don't need it.
    pub unsafe fn assume_x509(&mut self) {
        unsafe {
            self.ctx.assume_x509();
        }
    }

    /// Returns a pointer to the raw OpenSSL value.
    #[must_use]
    pub fn as_ptr(&self) -> *mut ffi::SSL_CTX {
        self.ctx.as_ptr()
    }

    /// Registers a certificate verification callback that replaces the default verification
    /// process.
    ///
    /// The callback returns true if the certificate chain is valid, and false if not.
    /// A viable verification result value (either `Ok(())` or an `Err(X509VerifyError)`) must be
    /// reflected in the error member of `X509StoreContextRef`, which can be done by calling
    /// `X509StoreContextRef::set_error`. However, the callback's return value determines
    /// whether the chain is accepted or not.
    ///
    /// *Warning*: Providing a complete verification procedure is a complex task. See
    /// [`SSL_CTX_set_cert_verify_callback`](https://docs.openssl.org/master/man3/SSL_CTX_set_cert_verify_callback/#notes)
    /// for more information.
    ///
    // TODO: Add the ability to unset the callback by either adding a new function or wrapping the
    // callback in an `Option`.
    ///
    /// # Panics
    ///
    /// This method panics if this `SslContext` is associated with a RPK context.
    #[corresponds(SSL_CTX_set_cert_verify_callback)]
    pub fn set_cert_verify_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut X509StoreContextRef) -> bool + 'static + Sync + Send,
    {
        self.ctx.check_x509();

        // NOTE(jlarisch): Q: Why don't we wrap the callback in an Arc, since
        // `set_verify_callback` does?
        // A: I don't think that Arc is necessary, and I don't think one is necessary here.
        // There's no way to get a mutable reference to the `Ssl` or `SslContext`, which
        // is what you need to register a new callback.
        // See the NOTE in `ssl_raw_verify` for confirmation.
        self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
        unsafe {
            ffi::SSL_CTX_set_cert_verify_callback(
                self.as_ptr(),
                Some(raw_cert_verify::<F>),
                ptr::null_mut(),
            );
        }
    }

    /// Configures the certificate verification method for new connections.
    #[corresponds(SSL_CTX_set_verify)]
    pub fn set_verify(&mut self, mode: SslVerifyMode) {
        self.ctx.check_x509();

        unsafe {
            ffi::SSL_CTX_set_verify(self.as_ptr(), c_int::from(mode.bits()), None);
        }
    }

    /// Configures the certificate verification method for new connections and
    /// registers a verification callback.
    ///
    /// *Warning*: This callback does not replace the default certificate verification
    /// process and is, instead, called multiple times in the course of that process.
    /// It is very difficult to implement this callback correctly, without inadvertently
    /// relying on implementation details or making incorrect assumptions about when the
    /// callback is called.
    ///
    /// Instead, use [`SslContextBuilder::set_custom_verify_callback`] to customize certificate verification.
    /// Those callbacks can inspect the peer-sent chain, call [`X509StoreContextRef::verify_cert`]
    /// and inspect the result, or perform other operations more straightforwardly.
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    #[corresponds(SSL_CTX_set_verify)]
    pub fn set_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(bool, &mut X509StoreContextRef) -> bool + 'static + Sync + Send,
    {
        self.ctx.check_x509();

        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_verify(
                self.as_ptr(),
                c_int::from(mode.bits()),
                Some(raw_verify::<F>),
            );
        }
    }

    /// Configures certificate verification.
    ///
    /// The callback should return `Ok(())` if the certificate is valid.
    /// If the certificate is invalid, the callback should return `SslVerifyError::Invalid(alert)`.
    /// Some useful alerts include [`SslAlert::CERTIFICATE_EXPIRED`], [`SslAlert::CERTIFICATE_REVOKED`],
    /// [`SslAlert::UNKNOWN_CA`], [`SslAlert::BAD_CERTIFICATE`], [`SslAlert::CERTIFICATE_UNKNOWN`],
    /// and [`SslAlert::INTERNAL_ERROR`]. See RFC 5246 section 7.2.2 for their precise meanings.
    ///
    /// To verify a certificate asynchronously, the callback may return `Err(SslVerifyError::Retry)`.
    /// The handshake will then pause with an error with code [`ErrorCode::WANT_CERTIFICATE_VERIFY`].
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    #[corresponds(SSL_CTX_set_custom_verify)]
    pub fn set_custom_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(&mut SslRef) -> Result<(), SslVerifyError> + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_custom_verify(
                self.as_ptr(),
                c_int::from(mode.bits()),
                Some(raw_custom_verify::<F>),
            );
        }
    }

    /// Configures the server name indication (SNI) callback for new connections.
    ///
    /// SNI is used to allow a single server to handle requests for multiple domains, each of which
    /// has its own certificate chain and configuration.
    ///
    /// Obtain the server name with the `servername` method and then set the corresponding context
    /// with `set_ssl_context`
    ///
    // FIXME tlsext prefix?
    #[corresponds(SSL_CTX_set_tlsext_servername_callback)]
    pub fn set_servername_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, &mut SslAlert) -> Result<(), SniError> + 'static + Sync + Send,
    {
        unsafe {
            // The SNI callback is somewhat unique in that the callback associated with the original
            // context associated with an SSL can be used even if the SSL's context has been swapped
            // out. When that happens, we wouldn't be able to look up the callback's state in the
            // context's ex data. Instead, pass the pointer directly as the servername arg. It's
            // still stored in ex data to manage the lifetime.

            let callback_index = SslContext::cached_ex_index::<F>();

            self.ctx.replace_ex_data(callback_index, callback);
            let callback = self.ctx.ex_data(callback_index).unwrap();

            let arg = std::ptr::from_ref(callback).cast_mut().cast();
            ffi::SSL_CTX_set_tlsext_servername_arg(self.as_ptr(), arg);
            ffi::SSL_CTX_set_tlsext_servername_callback(self.as_ptr(), Some(raw_sni::<F>));
        }
    }

    /// Configures a custom session ticket key callback for session resumption.
    ///
    /// Session Resumption uses the security context (aka. session tickets) of a previous
    /// connection to establish a new connection via an abbreviated handshake. Skipping portions of
    /// a handshake can potentially yield performance gains.
    ///
    /// An attacker that compromises a server's session ticket key can impersonate the server and,
    /// prior to TLS 1.3, retroactively decrypt all application traffic from sessions using that
    /// ticket key. Thus ticket keys must be regularly rotated for forward secrecy.
    ///
    /// CipherCtx and HmacCtx are guaranteed to be initialized.
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    ///
    /// # Safety
    ///
    /// The application is responsible for correctly setting the key_name, iv, encryption context
    /// and hmac context. See the [`SSL_CTX_set_tlsext_ticket_key_cb`] docs for additional info.
    ///
    /// [`SSL_CTX_set_tlsext_ticket_key_cb`]: https://commondatastorage.googleapis.com/chromium-boringssl-docs/ssl.h.html#SSL_CTX_set_tlsext_ticket_key_cb
    #[corresponds(SSL_CTX_set_tlsext_ticket_key_cb)]
    pub unsafe fn set_ticket_key_callback<F>(&mut self, callback: F)
    where
        F: Fn(
                &SslRef,
                &mut [u8; 16],
                &mut [u8; ffi::EVP_MAX_IV_LENGTH as usize],
                &mut CipherCtxRef,
                &mut HmacCtxRef,
                bool,
            ) -> TicketKeyCallbackResult
            + 'static
            + Sync
            + Send,
    {
        self.ctx.check_x509();

        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_tlsext_ticket_key_cb(self.as_ptr(), Some(raw_ticket_key::<F>))
        };
    }

    /// Sets the certificate verification depth.
    ///
    /// If the peer's certificate chain is longer than this value, verification will fail.
    #[corresponds(SSL_CTX_set_verify_depth)]
    pub fn set_verify_depth(&mut self, depth: u32) {
        self.ctx.check_x509();

        unsafe {
            ffi::SSL_CTX_set_verify_depth(self.as_ptr(), depth as c_int);
        }
    }

    /// Sets a custom certificate store for verifying peer certificates.
    #[corresponds(SSL_CTX_set0_verify_cert_store)]
    pub fn set_verify_cert_store(&mut self, cert_store: X509Store) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        unsafe {
            cvt(ffi::SSL_CTX_set0_verify_cert_store(
                self.as_ptr(),
                cert_store.into_ptr(),
            ))
        }
    }

    /// Replaces the context's certificate store, and keeps it immutable.
    ///
    /// This method allows sharing the `X509Store`, but calls to `cert_store_mut` will panic.
    ///
    /// Use [`set_cert_store_builder`] to set a mutable cert store
    /// (there's no way to have both sharing and mutability).
    #[corresponds(SSL_CTX_set_cert_store)]
    pub fn set_cert_store(&mut self, cert_store: X509Store) {
        self.ctx.check_x509();

        self.has_shared_cert_store = true;
        unsafe {
            ffi::SSL_CTX_set_cert_store(self.as_ptr(), cert_store.into_ptr());
        }
    }

    /// Replaces the context's certificate store, and allows mutating the store afterwards.
    #[corresponds(SSL_CTX_set_cert_store)]
    pub fn set_cert_store_builder(&mut self, cert_store: X509StoreBuilder) {
        self.ctx.check_x509();

        self.has_shared_cert_store = false;
        unsafe {
            ffi::SSL_CTX_set_cert_store(self.as_ptr(), cert_store.into_ptr());
        }
    }

    /// Replaces the context's certificate store, and keeps it immutable.
    ///
    /// This method allows sharing the `X509Store`, but calls to `cert_store_mut` will panic.
    #[corresponds(SSL_CTX_set_cert_store)]
    pub fn set_cert_store_ref(&mut self, cert_store: &X509Store) {
        self.set_cert_store(cert_store.to_owned());
    }

    /// Controls read ahead behavior.
    ///
    /// If enabled, OpenSSL will read as much data as is available from the underlying stream,
    /// instead of a single record at a time.
    ///
    /// It has no effect when used with DTLS.
    #[corresponds(SSL_CTX_set_read_ahead)]
    pub fn set_read_ahead(&mut self, read_ahead: bool) {
        unsafe {
            ffi::SSL_CTX_set_read_ahead(self.as_ptr(), c_int::from(read_ahead));
        }
    }

    /// Sets the mode used by the context, returning the new bit-mask after adding mode.
    #[corresponds(SSL_CTX_set_mode)]
    pub fn set_mode(&mut self, mode: SslMode) -> SslMode {
        let bits = unsafe { ffi::SSL_CTX_set_mode(self.as_ptr(), mode.bits()) };
        SslMode::from_bits_retain(bits)
    }

    /// Sets the parameters to be used during ephemeral Diffie-Hellman key exchange.
    #[corresponds(SSL_CTX_set_tmp_dh)]
    pub fn set_tmp_dh(&mut self, dh: &DhRef<Params>) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_set_tmp_dh(self.as_ptr(), dh.as_ptr())) }
    }

    /// Sets the parameters to be used during ephemeral elliptic curve Diffie-Hellman key exchange.
    #[corresponds(SSL_CTX_set_tmp_ecdh)]
    pub fn set_tmp_ecdh(&mut self, key: &EcKeyRef<Params>) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_set_tmp_ecdh(self.as_ptr(), key.as_ptr())) }
    }

    /// Use the default locations of trusted certificates for verification.
    ///
    /// These locations are read from the `SSL_CERT_FILE` and `SSL_CERT_DIR` environment variables
    /// if present, or defaults specified at OpenSSL build time otherwise.
    #[corresponds(SSL_CTX_set_default_verify_paths)]
    pub fn set_default_verify_paths(&mut self) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        unsafe { cvt(ffi::SSL_CTX_set_default_verify_paths(self.as_ptr())) }
    }

    /// Loads trusted root certificates from a file.
    ///
    /// The file should contain a sequence of PEM-formatted CA certificates.
    #[corresponds(SSL_CTX_load_verify_locations)]
    pub fn set_ca_file<P: AsRef<Path>>(&mut self, file: P) -> Result<(), ErrorStack> {
        self.load_verify_locations(Some(file.as_ref()), None)
    }

    /// Loads trusted root certificates from a file and/or a directory.
    #[corresponds(SSL_CTX_load_verify_locations)]
    pub fn load_verify_locations(
        &mut self,
        ca_file: Option<&Path>,
        ca_path: Option<&Path>,
    ) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        let ca_file = ca_file.map(path_to_cstring).transpose()?;
        let ca_path = ca_path.map(path_to_cstring).transpose()?;

        unsafe {
            cvt(ffi::SSL_CTX_load_verify_locations(
                self.as_ptr(),
                ca_file.as_ref().map_or(ptr::null(), |s| s.as_ptr()),
                ca_path.as_ref().map_or(ptr::null(), |s| s.as_ptr()),
            ))
        }
    }

    /// Sets the list of CA names sent to the client.
    ///
    /// The CA certificates must still be added to the trust root - they are not automatically set
    /// as trusted by this method.
    #[corresponds(SSL_CTX_set_client_CA_list)]
    pub fn set_client_ca_list(&mut self, list: Stack<X509Name>) {
        self.ctx.check_x509();

        unsafe {
            ffi::SSL_CTX_set_client_CA_list(self.as_ptr(), list.as_ptr());
            mem::forget(list);
        }
    }

    /// Add the provided CA certificate to the list sent by the server to the client when
    /// requesting client-side TLS authentication.
    #[corresponds(SSL_CTX_add_client_CA)]
    pub fn add_client_ca(&mut self, cacert: &X509Ref) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        unsafe { cvt(ffi::SSL_CTX_add_client_CA(self.as_ptr(), cacert.as_ptr())) }
    }

    /// Set the context identifier for sessions.
    ///
    /// This value identifies the server's session cache to clients, telling them when they're
    /// able to reuse sessions. It should be set to a unique value per server, unless multiple
    /// servers share a session cache.
    ///
    /// This value should be set when using client certificates, or each request will fail its
    /// handshake and need to be restarted.
    #[corresponds(SSL_CTX_set_session_id_context)]
    pub fn set_session_id_context(&mut self, sid_ctx: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            assert!(sid_ctx.len() <= c_uint::MAX as usize);
            cvt(ffi::SSL_CTX_set_session_id_context(
                self.as_ptr(),
                sid_ctx.as_ptr(),
                sid_ctx.len(),
            ))
        }
    }

    /// Loads a leaf certificate from a file.
    ///
    /// Only a single certificate will be loaded - use `add_extra_chain_cert` to add the remainder
    /// of the certificate chain, or `set_certificate_chain_file` to load the entire chain from a
    /// single file.
    #[corresponds(SSL_CTX_use_certificate_file)]
    pub fn set_certificate_file<P: AsRef<Path>>(
        &mut self,
        file: P,
        file_type: SslFiletype,
    ) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        let file = path_to_cstring(file.as_ref())?;
        unsafe {
            cvt(ffi::SSL_CTX_use_certificate_file(
                self.as_ptr(),
                file.as_ptr(),
                file_type.as_raw(),
            ))
        }
    }

    /// Loads a certificate chain from a file.
    ///
    /// The file should contain a sequence of PEM-formatted certificates, the first being the leaf
    /// certificate, and the remainder forming the chain of certificates up to and including the
    /// trusted root certificate.
    #[corresponds(SSL_CTX_use_certificate_chain_file)]
    pub fn set_certificate_chain_file<P: AsRef<Path>>(
        &mut self,
        file: P,
    ) -> Result<(), ErrorStack> {
        let file = path_to_cstring(file.as_ref())?;
        unsafe {
            cvt(ffi::SSL_CTX_use_certificate_chain_file(
                self.as_ptr(),
                file.as_ptr(),
            ))
        }
    }

    /// Sets the leaf certificate.
    ///
    /// Use `add_extra_chain_cert` to add the remainder of the certificate chain.
    #[corresponds(SSL_CTX_use_certificate)]
    pub fn set_certificate(&mut self, cert: &X509Ref) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_use_certificate(self.as_ptr(), cert.as_ptr())) }
    }

    /// Appends a certificate to the certificate chain.
    ///
    /// This chain should contain all certificates necessary to go from the certificate specified by
    /// `set_certificate` to a trusted root.
    #[corresponds(SSL_CTX_add_extra_chain_cert)]
    pub fn add_extra_chain_cert(&mut self, cert: X509) -> Result<(), ErrorStack> {
        self.ctx.check_x509();

        unsafe {
            cvt(ffi::SSL_CTX_add_extra_chain_cert(
                self.as_ptr(),
                cert.into_ptr(),
            ))
        }
    }

    /// Loads the private key from a file.
    #[corresponds(SSL_CTX_use_PrivateKey_file)]
    pub fn set_private_key_file<P: AsRef<Path>>(
        &mut self,
        file: P,
        file_type: SslFiletype,
    ) -> Result<(), ErrorStack> {
        let file = path_to_cstring(file.as_ref())?;
        unsafe {
            cvt(ffi::SSL_CTX_use_PrivateKey_file(
                self.as_ptr(),
                file.as_ptr(),
                file_type.as_raw(),
            ))
        }
    }

    /// Sets the private key.
    #[corresponds(SSL_CTX_use_PrivateKey)]
    pub fn set_private_key<T>(&mut self, key: &PKeyRef<T>) -> Result<(), ErrorStack>
    where
        T: HasPrivate,
    {
        unsafe { cvt(ffi::SSL_CTX_use_PrivateKey(self.as_ptr(), key.as_ptr())) }
    }

    /// Sets the list of supported ciphers for protocols before TLSv1.3, ignoring meaningless entries.
    ///
    /// See [`SslContextBuilder::set_strict_cipher_list()`].
    ///
    /// The `set_ciphersuites` method controls the cipher suites for TLSv1.3 in OpenSSL.
    /// BoringSSL doesn't implement `set_ciphersuites`.
    /// See [ssl.h](https://github.com/google/boringssl/blob/master/include/openssl/ssl.h#L1542-L1544).
    ///
    /// See [`ciphers`] for details on the format.
    ///
    /// [`ciphers`]: https://www.openssl.org/docs/manmaster/apps/ciphers.html
    #[corresponds(SSL_CTX_set_cipher_list)]
    pub fn set_cipher_list(&mut self, cipher_list: &str) -> Result<(), ErrorStack> {
        let cipher_list = CString::new(cipher_list).map_err(ErrorStack::internal_error)?;
        unsafe {
            cvt(ffi::SSL_CTX_set_cipher_list(
                self.as_ptr(),
                cipher_list.as_ptr(),
            ))
        }
    }

    /// Sets the list of supported ciphers for protocols before TLSv1.3 but do not
    /// tolerate anything meaningless in the cipher list.
    ///
    /// The `set_ciphersuites` method controls the cipher suites for TLSv1.3 in OpenSSL.
    /// BoringSSL doesn't implement `set_ciphersuites`.
    /// See <https://github.com/google/boringssl/blob/main/include/openssl/ssl.h#L1685>
    ///
    /// See [`ciphers`] for details on the format.
    ///
    /// [`ciphers`]: <https://docs.openssl.org/master/man1/openssl-ciphers/>.
    #[corresponds(SSL_CTX_set_strict_cipher_list)]
    pub fn set_strict_cipher_list(&mut self, cipher_list: &str) -> Result<(), ErrorStack> {
        let cipher_list = CString::new(cipher_list).map_err(ErrorStack::internal_error)?;
        unsafe {
            cvt(ffi::SSL_CTX_set_strict_cipher_list(
                self.as_ptr(),
                cipher_list.as_ptr(),
            ))
        }
    }

    /// Gets the list of supported ciphers for protocols before TLSv1.3.
    ///
    /// See [`ciphers`] for details on the format
    ///
    /// [`ciphers`]: https://www.openssl.org/docs/manmaster/man1/ciphers.html
    #[corresponds(SSL_CTX_get_ciphers)]
    #[must_use]
    pub fn ciphers(&self) -> Option<&StackRef<SslCipher>> {
        self.ctx.ciphers()
    }

    /// Sets the options used by the context, returning the old set.
    ///
    /// # Note
    ///
    /// This *enables* the specified options, but does not disable unspecified options. Use
    /// `clear_options` for that.
    #[corresponds(SSL_CTX_set_options)]
    pub fn set_options(&mut self, option: SslOptions) -> SslOptions {
        let bits = unsafe { ffi::SSL_CTX_set_options(self.as_ptr(), option.bits()) };
        SslOptions::from_bits_retain(bits)
    }

    /// Returns the options used by the context.
    #[corresponds(SSL_CTX_get_options)]
    #[must_use]
    pub fn options(&self) -> SslOptions {
        let bits = unsafe { ffi::SSL_CTX_get_options(self.as_ptr()) };
        SslOptions::from_bits_retain(bits)
    }

    /// Clears the options used by the context, returning the old set.
    #[corresponds(SSL_CTX_clear_options)]
    pub fn clear_options(&mut self, option: SslOptions) -> SslOptions {
        let bits = unsafe { ffi::SSL_CTX_clear_options(self.as_ptr(), option.bits()) };
        SslOptions::from_bits_retain(bits)
    }

    /// Sets the minimum supported protocol version.
    ///
    /// If version is `None`, the default minimum version is used. For BoringSSL this defaults to
    /// TLS 1.0.
    #[corresponds(SSL_CTX_set_min_proto_version)]
    pub fn set_min_proto_version(&mut self, version: Option<SslVersion>) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_CTX_set_min_proto_version(
                self.as_ptr(),
                version.map_or(0, |v| v.0 as _),
            ))
        }
    }

    /// Sets the maximum supported protocol version.
    ///
    /// If version is `None`, the default maximum version is used. For BoringSSL this is TLS 1.3.
    #[corresponds(SSL_CTX_set_max_proto_version)]
    pub fn set_max_proto_version(&mut self, version: Option<SslVersion>) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_CTX_set_max_proto_version(
                self.as_ptr(),
                version.map_or(0, |v| v.0 as _),
            ))
        }
    }

    /// Gets the minimum supported protocol version.
    #[corresponds(SSL_CTX_get_min_proto_version)]
    pub fn min_proto_version(&mut self) -> Option<SslVersion> {
        unsafe {
            let r = ffi::SSL_CTX_get_min_proto_version(self.as_ptr());
            if r == 0 {
                None
            } else {
                Some(SslVersion(r))
            }
        }
    }

    /// Gets the maximum supported protocol version.
    #[corresponds(SSL_CTX_get_max_proto_version)]
    pub fn max_proto_version(&mut self) -> Option<SslVersion> {
        unsafe {
            let r = ffi::SSL_CTX_get_max_proto_version(self.as_ptr());
            if r == 0 {
                None
            } else {
                Some(SslVersion(r))
            }
        }
    }

    /// Sets the protocols to sent to the server for Application Layer Protocol Negotiation (ALPN).
    ///
    /// The input must be in ALPN "wire format". It consists of a sequence of supported protocol
    /// names prefixed by their byte length. For example, the protocol list consisting of `spdy/1`
    /// and `http/1.1` is encoded as `b"\x06spdy/1\x08http/1.1"`. The protocols are ordered by
    /// preference.
    #[corresponds(SSL_CTX_set_alpn_protos)]
    pub fn set_alpn_protos(&mut self, protocols: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            let r = ffi::SSL_CTX_set_alpn_protos(
                self.as_ptr(),
                protocols.as_ptr(),
                try_int(protocols.len())?,
            );
            // fun fact, SSL_CTX_set_alpn_protos has a reversed return code D:
            if r == 0 {
                Ok(())
            } else {
                Err(ErrorStack::get())
            }
        }
    }

    /// Enables the DTLS extension "use_srtp" as defined in RFC5764.
    #[corresponds(SSL_CTX_set_tlsext_use_srtp)]
    pub fn set_tlsext_use_srtp(&mut self, protocols: &str) -> Result<(), ErrorStack> {
        unsafe {
            let cstr = CString::new(protocols).map_err(ErrorStack::internal_error)?;

            let r = ffi::SSL_CTX_set_tlsext_use_srtp(self.as_ptr(), cstr.as_ptr());
            // fun fact, set_tlsext_use_srtp has a reversed return code D:
            if r == 0 {
                Ok(())
            } else {
                Err(ErrorStack::get())
            }
        }
    }

    /// Sets the callback used by a server to select a protocol for Application Layer Protocol
    /// Negotiation (ALPN).
    ///
    /// The callback is provided with the client's protocol list in ALPN wire format. See the
    /// documentation for [`SslContextBuilder::set_alpn_protos`] for details. It should return one
    /// of those protocols on success. The [`select_next_proto`] function implements the standard
    /// protocol selection algorithm.
    ///
    /// [`SslContextBuilder::set_alpn_protos`]: struct.SslContextBuilder.html#method.set_alpn_protos
    /// [`select_next_proto`]: fn.select_next_proto.html
    #[corresponds(SSL_CTX_set_alpn_select_cb)]
    pub fn set_alpn_select_callback<F>(&mut self, callback: F)
    where
        F: for<'a> Fn(&mut SslRef, &'a [u8]) -> Result<&'a [u8], AlpnError> + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_alpn_select_cb(
                self.as_ptr(),
                Some(callbacks::raw_alpn_select::<F>),
                ptr::null_mut(),
            );
        }
    }

    /// Sets a callback that is called before most ClientHello processing and before the decision whether
    /// to resume a session is made. The callback may inspect the ClientHello and configure the
    /// connection.
    #[corresponds(SSL_CTX_set_select_certificate_cb)]
    pub fn set_select_certificate_callback<F>(&mut self, callback: F)
    where
        F: Fn(ClientHello<'_>) -> Result<(), SelectCertError> + Sync + Send + 'static,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_select_certificate_cb(
                self.as_ptr(),
                Some(callbacks::raw_select_cert::<F>),
            );
        }
    }

    /// Registers a certificate compression algorithm.
    ///
    /// [`SSL_CTX_add_cert_compression_alg`]: https://commondatastorage.googleapis.com/chromium-boringssl-docs/ssl.h.html#SSL_CTX_add_cert_compression_alg
    #[corresponds(SSL_CTX_add_cert_compression_alg)]
    pub fn add_certificate_compression_algorithm<C>(
        &mut self,
        compressor: C,
    ) -> Result<(), ErrorStack>
    where
        C: CertificateCompressor,
    {
        const {
            assert!(C::CAN_COMPRESS || C::CAN_DECOMPRESS, "Either compression or decompression must be supported for algorithm to be registered");
        };
        let success = unsafe {
            ffi::SSL_CTX_add_cert_compression_alg(
                self.as_ptr(),
                C::ALGORITHM.0,
                const {
                    if C::CAN_COMPRESS {
                        Some(callbacks::raw_ssl_cert_compress::<C>)
                    } else {
                        None
                    }
                },
                const {
                    if C::CAN_DECOMPRESS {
                        Some(callbacks::raw_ssl_cert_decompress::<C>)
                    } else {
                        None
                    }
                },
            ) == 1
        };
        if !success {
            return Err(ErrorStack::get());
        }
        self.replace_ex_data(SslContext::cached_ex_index::<C>(), compressor);
        Ok(())
    }

    /// Configures a custom private key method on the context.
    ///
    /// See [`PrivateKeyMethod`] for more details.
    #[corresponds(SSL_CTX_set_private_key_method)]
    pub fn set_private_key_method<M>(&mut self, method: M)
    where
        M: PrivateKeyMethod,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<M>(), method);

            ffi::SSL_CTX_set_private_key_method(
                self.as_ptr(),
                &ffi::SSL_PRIVATE_KEY_METHOD {
                    sign: Some(callbacks::raw_sign::<M>),
                    decrypt: Some(callbacks::raw_decrypt::<M>),
                    complete: Some(callbacks::raw_complete::<M>),
                },
            );
        }
    }

    /// Checks for consistency between the private key and certificate.
    #[corresponds(SSL_CTX_check_private_key)]
    pub fn check_private_key(&self) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_check_private_key(self.as_ptr())) }
    }

    /// Returns a shared reference to the context's certificate store.
    #[corresponds(SSL_CTX_get_cert_store)]
    #[must_use]
    pub fn cert_store(&self) -> &X509StoreBuilderRef {
        self.ctx.check_x509();

        unsafe { X509StoreBuilderRef::from_ptr(ffi::SSL_CTX_get_cert_store(self.as_ptr())) }
    }

    /// Returns a mutable reference to the context's certificate store.
    ///
    /// Newly-created `SslContextBuilder` will have its own default mutable store.
    ///
    /// ## Panics
    ///
    /// * If a shared store has been set via [`set_cert_store_ref`]
    /// * If context has been created for Raw Public Key verification (requires `rpk` Cargo feature)
    ///
    #[corresponds(SSL_CTX_get_cert_store)]
    pub fn cert_store_mut(&mut self) -> &mut X509StoreBuilderRef {
        self.ctx.check_x509();

        assert!(
            !self.has_shared_cert_store,
            "Shared X509Store can't be mutated. Use set_cert_store_builder() instead of set_cert_store()
                or completely finish building the cert store setting it."
        );
        // OTOH, it's not safe to return a shared &X509Store when the builder owns it exclusively

        unsafe { X509StoreBuilderRef::from_ptr_mut(ffi::SSL_CTX_get_cert_store(self.as_ptr())) }
    }

    /// Sets the callback dealing with OCSP stapling.
    ///
    /// On the client side, this callback is responsible for validating the OCSP status response
    /// returned by the server. The status may be retrieved with the `SslRef::ocsp_status` method.
    /// A response of `Ok(true)` indicates that the OCSP status is valid, and a response of
    /// `Ok(false)` indicates that the OCSP status is invalid and the handshake should be
    /// terminated.
    ///
    /// On the server side, this callback is resopnsible for setting the OCSP status response to be
    /// returned to clients. The status may be set with the `SslRef::set_ocsp_status` method. A
    /// response of `Ok(true)` indicates that the OCSP status should be returned to the client, and
    /// `Ok(false)` indicates that the status should not be returned to the client.
    #[corresponds(SSL_CTX_set_tlsext_status_cb)]
    pub fn set_status_callback<F>(&mut self, callback: F) -> Result<(), ErrorStack>
    where
        F: Fn(&mut SslRef) -> Result<bool, ErrorStack> + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            cvt(ffi::SSL_CTX_set_tlsext_status_cb(
                self.as_ptr(),
                Some(raw_tlsext_status::<F>),
            ))
        }
    }

    /// Sets the callback for providing an identity and pre-shared key for a TLS-PSK client.
    ///
    /// The callback will be called with the SSL context, an identity hint if one was provided
    /// by the server, a mutable slice for each of the identity and pre-shared key bytes. The
    /// identity must be written as a null-terminated C string.
    #[corresponds(SSL_CTX_set_psk_client_callback)]
    pub fn set_psk_client_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, Option<&[u8]>, &mut [u8], &mut [u8]) -> Result<usize, ErrorStack>
            + 'static
            + Sync
            + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_psk_client_callback(self.as_ptr(), Some(raw_client_psk::<F>));
        }
    }

    #[deprecated(since = "0.10.10", note = "renamed to `set_psk_client_callback`")]
    pub fn set_psk_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, Option<&[u8]>, &mut [u8], &mut [u8]) -> Result<usize, ErrorStack>
            + 'static
            + Sync
            + Send,
    {
        self.set_psk_client_callback(callback);
    }

    /// Sets the callback for providing an identity and pre-shared key for a TLS-PSK server.
    ///
    /// The callback will be called with the SSL context, an identity provided by the client,
    /// and, a mutable slice for the pre-shared key bytes. The callback returns the number of
    /// bytes in the pre-shared key.
    #[corresponds(SSL_CTX_set_psk_server_callback)]
    pub fn set_psk_server_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, Option<&[u8]>, &mut [u8]) -> Result<usize, ErrorStack>
            + 'static
            + Sync
            + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_psk_server_callback(self.as_ptr(), Some(raw_server_psk::<F>));
        }
    }

    /// Sets the callback which is called when new sessions are negotiated.
    ///
    /// This can be used by clients to implement session caching. While in TLSv1.2 the session is
    /// available to access via [`SslRef::session`] immediately after the handshake completes, this
    /// is not the case for TLSv1.3. There, a session is not generally available immediately, and
    /// the server may provide multiple session tokens to the client over a single session. The new
    /// session callback is a portable way to deal with both cases.
    ///
    /// Note that session caching must be enabled for the callback to be invoked, and it defaults
    /// off for clients. [`set_session_cache_mode`] controls that behavior.
    ///
    /// [`SslRef::session`]: struct.SslRef.html#method.session
    /// [`set_session_cache_mode`]: #method.set_session_cache_mode
    #[corresponds(SSL_CTX_sess_set_new_cb)]
    pub fn set_new_session_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, SslSession) + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_sess_set_new_cb(self.as_ptr(), Some(callbacks::raw_new_session::<F>));
        }
    }

    /// Sets the callback which is called when sessions are removed from the context.
    ///
    /// Sessions can be removed because they have timed out or because they are considered faulty.
    #[corresponds(SSL_CTX_sess_set_remove_cb)]
    pub fn set_remove_session_callback<F>(&mut self, callback: F)
    where
        F: Fn(&SslContextRef, &SslSessionRef) + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_sess_set_remove_cb(
                self.as_ptr(),
                Some(callbacks::raw_remove_session::<F>),
            );
        }
    }

    /// Sets the callback which is called when a client proposed to resume a session but it was not
    /// found in the internal cache.
    ///
    /// The callback is passed a reference to the session ID provided by the client. It should
    /// return the session corresponding to that ID if available. This is only used for servers, not
    /// clients.
    ///
    /// # Safety
    ///
    /// The returned [`SslSession`] must not be associated with a different [`SslContext`].
    #[corresponds(SSL_CTX_sess_set_get_cb)]
    pub unsafe fn set_get_session_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, &[u8]) -> Result<Option<SslSession>, GetSessionPendingError>
            + 'static
            + Sync
            + Send,
    {
        self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
        unsafe {
            ffi::SSL_CTX_sess_set_get_cb(self.as_ptr(), Some(callbacks::raw_get_session::<F>));
        }
    }

    /// Sets the TLS key logging callback.
    ///
    /// The callback is invoked whenever TLS key material is generated, and is passed a line of NSS
    /// SSLKEYLOGFILE-formatted text. This can be used by tools like Wireshark to decrypt message
    /// traffic. The line does not contain a trailing newline.
    #[corresponds(SSL_CTX_set_keylog_callback)]
    pub fn set_keylog_callback<F>(&mut self, callback: F)
    where
        F: Fn(&SslRef, &str) + 'static + Sync + Send,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_keylog_callback(self.as_ptr(), Some(callbacks::raw_keylog::<F>));
        }
    }

    /// Sets the session caching mode use for connections made with the context.
    ///
    /// Returns the previous session caching mode.
    #[corresponds(SSL_CTX_set_session_cache_mode)]
    pub fn set_session_cache_mode(&mut self, mode: SslSessionCacheMode) -> SslSessionCacheMode {
        unsafe {
            let bits = ffi::SSL_CTX_set_session_cache_mode(self.as_ptr(), mode.bits());
            SslSessionCacheMode::from_bits_retain(bits)
        }
    }

    /// Sets the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `SslContext::new_ex_index` method to create an `Index`.
    #[corresponds(SSL_CTX_set_ex_data)]
    pub fn set_ex_data<T>(&mut self, index: Index<SslContext, T>, data: T) {
        unsafe {
            self.ctx.replace_ex_data(index, data);
        }
    }

    /// Sets or overwrites the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `SslContext::new_ex_index` method to create an `Index`.
    ///
    /// Any previous value will be returned and replaced by the new one.
    #[corresponds(SSL_CTX_set_ex_data)]
    pub fn replace_ex_data<T>(&mut self, index: Index<SslContext, T>, data: T) -> Option<T> {
        unsafe { self.ctx.replace_ex_data(index, data) }
    }

    /// Sets the context's session cache size limit, returning the previous limit.
    ///
    /// A value of 0 means that the cache size is unbounded.
    #[corresponds(SSL_CTX_sess_set_cache_size)]
    #[allow(clippy::useless_conversion)]
    pub fn set_session_cache_size(&mut self, size: u32) -> u64 {
        unsafe { ffi::SSL_CTX_sess_set_cache_size(self.as_ptr(), size.into()).into() }
    }

    /// Sets the context's supported signature algorithms.
    #[corresponds(SSL_CTX_set1_sigalgs_list)]
    pub fn set_sigalgs_list(&mut self, sigalgs: &str) -> Result<(), ErrorStack> {
        let sigalgs = CString::new(sigalgs).map_err(ErrorStack::internal_error)?;
        unsafe {
            cvt(ffi::SSL_CTX_set1_sigalgs_list(
                self.as_ptr(),
                sigalgs.as_ptr(),
            ))
        }
    }

    /// Sets the ClientHello signature-algorithm advertisement from wire IDs.
    ///
    /// Only implemented entries are enabled for handshake verification. Unknown
    /// entries may be advertised for structural probes, but selecting one fails
    /// the handshake. This does not implement new algorithms or change signing
    /// credentials, certificate-chain verification, or hostname verification.
    #[corresponds(SSL_CTX_set_client_hello_sigalgs)]
    pub fn set_sigalgs(&mut self, values: &[u16]) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_CTX_set_client_hello_sigalgs(
                self.as_ptr(),
                values.as_ptr(),
                values.len(),
            ))
        }
    }

    /// Sets the ClientHello group advertisement and implemented negotiation subset.
    ///
    /// Unknown IDs may be advertised for structural probes, but cannot be
    /// negotiated. The list must contain at least one implemented group, or be
    /// empty to restore defaults. Existing key-share validation is unchanged.
    #[corresponds(SSL_CTX_set_client_hello_group_ids)]
    pub fn set_group_ids(&mut self, group_ids: &[u16]) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_CTX_set_client_hello_group_ids(
                self.as_ptr(),
                group_ids.as_ptr(),
                group_ids.len(),
            ))
        }
    }

    /// Sets the ClientHello `signature_algorithms_cert` advertisement.
    ///
    /// Empty omits the extension. This does not change certificate verification
    /// or add support for any advertised but unimplemented certificate algorithm.
    #[corresponds(SSL_CTX_set_client_hello_cert_sigalgs)]
    pub fn set_cert_sigalgs(&mut self, values: &[u16]) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_CTX_set_client_hello_cert_sigalgs(
                self.as_ptr(),
                values.as_ptr(),
                values.len(),
            ))
        }
    }

    /// Set's whether the context should enable GREASE.
    #[corresponds(SSL_CTX_set_grease_enabled)]
    pub fn set_grease_enabled(&mut self, enabled: bool) {
        unsafe { ffi::SSL_CTX_set_grease_enabled(self.as_ptr(), enabled as _) }
    }

    /// Sets whether the context should enable record size limit.
    #[corresponds(SSL_CTX_set_record_size_limit)]
    pub fn set_record_size_limit(&mut self, limit: u16) {
        unsafe { ffi::SSL_CTX_set_record_size_limit(self.as_ptr(), limit as _) }
    }

    /// Sets whether the context should enable delegated credentials.
    #[corresponds(SSL_CTX_set_delegated_credentials)]
    pub fn set_delegated_credentials(&mut self, sigalgs: &str) -> Result<(), ErrorStack> {
        let sigalgs = CString::new(sigalgs).unwrap();
        unsafe {
            cvt(ffi::SSL_CTX_set_delegated_credentials(self.as_ptr(), sigalgs.as_ptr()) as c_int)
                .map(|_| ())
        }
    }

    /// Sets whether the aes hardware override should be enabled.
    #[cfg(not(feature = "fips"))]
    #[corresponds(SSL_CTX_set_aes_hw_override)]
    pub fn set_aes_hw_override(&mut self, enable: bool) {
        unsafe { ffi::SSL_CTX_set_aes_hw_override(self.as_ptr(), enable as _) }
    }

    /// Sets whether to preserve the TLS 1.3 cipher list as configured by [`Self::set_cipher_list`].
    ///
    /// By default, BoringSSL does not preserve the TLS 1.3 cipher list. When this option is disabled
    /// (the default), BoringSSL uses its internal default TLS 1.3 cipher suites in its default order,
    /// regardless of what is set via [`Self::set_cipher_list`].
    ///
    /// When enabled, this option ensures that the TLS 1.3 cipher suites explicitly set via
    /// [`Self::set_cipher_list`] are retained in their original order, without being reordered or
    /// modified by BoringSSL's internal logic. This is useful for maintaining specific cipher suite
    /// priorities for TLS 1.3. Note that if [`Self::set_cipher_list`] does not include any TLS 1.3
    /// cipher suites, BoringSSL will still fall back to its default TLS 1.3 cipher suites and order.
    ///
    /// This feature isn't available in the certified version of BoringSSL.
    ///
    /// # Note
    ///
    /// This method must be called **before** [`Self::set_cipher_list`] to take effect.
    /// If called after [`Self::set_cipher_list`], the setting will be ignored.
    ///
    /// [`Self::set_cipher_list`]: #method.set_cipher_list
    #[cfg(not(feature = "fips"))]
    #[corresponds(SSL_CTX_set_preserve_tls13_cipher_list)]
    pub fn set_preserve_tls13_cipher_list(&mut self, enable: bool) {
        unsafe { ffi::SSL_CTX_set_preserve_tls13_cipher_list(self.as_ptr(), enable as _) }
    }

    /// Emits TLS 1.3 cipher suites after the legacy cipher suites in ClientHello.
    /// This changes ordering only, not the enabled suites or protocol versions.
    #[corresponds(SSL_CTX_set_tls13_ciphers_last)]
    pub fn set_tls13_ciphers_last(&mut self, enabled: bool) {
        unsafe { ffi::SSL_CTX_set_tls13_ciphers_last(self.as_ptr(), enabled as _) }
    }

    /// Sets the preferred ClientHello extension order.
    ///
    /// Unlisted enabled extensions follow the specified ones. They are permuted
    /// only when [`Self::set_permute_extensions`] is enabled.
    #[corresponds(SSL_CTX_set_extension_order)]
    pub fn set_extension_permutation(
        &mut self,
        indices: &[ExtensionType],
    ) -> Result<(), ErrorStack> {
        let len = c_int::try_from(indices.len()).map_err(ErrorStack::internal_error)?;
        unsafe {
            cvt_0i(ffi::SSL_CTX_set_extension_order(
                self.as_ptr(),
                indices.as_ptr().cast(),
                len,
            ))
            .map(|_| ())
        }
    }

    /// Configures whether ClientHello extensions should be permuted.
    #[corresponds(SSL_CTX_set_permute_extensions)]
    pub fn set_permute_extensions(&mut self, enabled: bool) {
        unsafe { ffi::SSL_CTX_set_permute_extensions(self.as_ptr(), enabled as _) }
    }

    /// Sets the context's supported signature verification algorithms.
    #[corresponds(SSL_CTX_set_verify_algorithm_prefs)]
    pub fn set_verify_algorithm_prefs(
        &mut self,
        prefs: &[SslSignatureAlgorithm],
    ) -> Result<(), ErrorStack> {
        unsafe {
            cvt_0i(ffi::SSL_CTX_set_verify_algorithm_prefs(
                self.as_ptr(),
                prefs.as_ptr().cast(),
                prefs.len(),
            ))
            .map(|_| ())
        }
    }

    /// Enables SCT requests on all client SSL handshakes.
    #[corresponds(SSL_CTX_enable_signed_cert_timestamps)]
    pub fn enable_signed_cert_timestamps(&mut self) {
        unsafe { ffi::SSL_CTX_enable_signed_cert_timestamps(self.as_ptr()) }
    }

    /// Enables OCSP stapling on all client SSL handshakes.
    #[corresponds(SSL_CTX_enable_ocsp_stapling)]
    pub fn enable_ocsp_stapling(&mut self) {
        unsafe { ffi::SSL_CTX_enable_ocsp_stapling(self.as_ptr()) }
    }

    /// Sets the context's supported curves.
    #[corresponds(SSL_CTX_set1_curves_list)]
    pub fn set_curves_list(&mut self, curves: &str) -> Result<(), ErrorStack> {
        let curves = CString::new(curves).map_err(ErrorStack::internal_error)?;
        unsafe {
            cvt_0i(ffi::SSL_CTX_set1_curves_list(
                self.as_ptr(),
                curves.as_ptr(),
            ))
            .map(|_| ())
        }
    }

    /// Sets the context's compliance policy.
    ///
    /// This feature isn't available in the certified version of BoringSSL.
    #[corresponds(SSL_CTX_set_compliance_policy)]
    pub fn set_compliance_policy(&mut self, policy: CompliancePolicy) -> Result<(), ErrorStack> {
        unsafe { cvt_0i(ffi::SSL_CTX_set_compliance_policy(self.as_ptr(), policy.0)).map(|_| ()) }
    }

    /// Sets the context's info callback.
    #[corresponds(SSL_CTX_set_info_callback)]
    pub fn set_info_callback<F>(&mut self, callback: F)
    where
        F: Fn(&SslRef, SslInfoCallbackMode, SslInfoCallbackValue) + Send + Sync + 'static,
    {
        unsafe {
            self.replace_ex_data(SslContext::cached_ex_index::<F>(), callback);
            ffi::SSL_CTX_set_info_callback(self.as_ptr(), Some(callbacks::raw_info_callback::<F>));
        }
    }

    /// Registers a list of ECH keys on the context. This list should contain new and old
    /// ECHConfigs to allow stale DNS caches to update. Unlike most `SSL_CTX` APIs, this function
    /// is safe to call even after the `SSL_CTX` has been associated with connections on various
    /// threads.
    #[corresponds(SSL_CTX_set1_ech_keys)]
    pub fn set_ech_keys(&self, keys: &SslEchKeys) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_set1_ech_keys(self.as_ptr(), keys.as_ptr())) }
    }

    /// Adds a credential.
    #[corresponds(SSL_CTX_add1_credential)]
    #[cfg(feature = "credential")]
    pub fn add_credential(&mut self, credential: &SslCredentialRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt_0i(ffi::SSL_CTX_add1_credential(
                self.as_ptr(),
                credential.as_ptr(),
            ))
            .map(|_| ())
        }
    }

    /// Consumes the builder, returning a new `SslContext`.
    #[must_use]
    pub fn build(self) -> SslContext {
        self.ctx
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::SSL_CTX;
    fn drop = ffi::SSL_CTX_free;

    /// A context object for TLS streams.
    ///
    /// Applications commonly configure a single `SslContext` that is shared by all of its
    /// `SslStreams`.
    pub struct SslContext;
}

impl Clone for SslContext {
    fn clone(&self) -> Self {
        (**self).to_owned()
    }
}

impl ToOwned for SslContextRef {
    type Owned = SslContext;

    fn to_owned(&self) -> Self::Owned {
        unsafe {
            SSL_CTX_up_ref(self.as_ptr());
            SslContext::from_ptr(self.as_ptr())
        }
    }
}

// TODO: add useful info here
impl fmt::Debug for SslContext {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        write!(fmt, "SslContext")
    }
}

impl SslContext {
    /// Creates a new builder object for an `SslContext`.
    pub fn builder(method: SslMethod) -> Result<SslContextBuilder, ErrorStack> {
        SslContextBuilder::new(method)
    }

    /// Returns a new extra data index.
    ///
    /// Each invocation of this function is guaranteed to return a distinct index. These can be used
    /// to store data in the context that can be retrieved later by callbacks, for example.
    #[corresponds(SSL_CTX_get_ex_new_index)]
    pub fn new_ex_index<T>() -> Result<Index<SslContext, T>, ErrorStack>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            ffi::init();
            let idx = cvt_n(get_new_idx(Some(free_data_box::<T>)))?;
            Ok(Index::from_raw(idx))
        }
    }

    // FIXME should return a result?
    fn cached_ex_index<T>() -> Index<SslContext, T>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            let idx = *INDEXES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(TypeId::of::<T>())
                .or_insert_with(|| SslContext::new_ex_index::<T>().unwrap().as_raw());
            Index::from_raw(idx)
        }
    }

    /// Gets the list of supported ciphers for protocols before TLSv1.3.
    ///
    /// See [`ciphers`] for details on the format
    ///
    /// [`ciphers`]: https://www.openssl.org/docs/manmaster/man1/ciphers.html
    #[corresponds(SSL_CTX_get_ciphers)]
    #[must_use]
    pub fn ciphers(&self) -> Option<&StackRef<SslCipher>> {
        unsafe {
            let ciphers = ffi::SSL_CTX_get_ciphers(self.as_ptr());
            if ciphers.is_null() {
                None
            } else {
                Some(StackRef::from_ptr(ciphers))
            }
        }
    }
}

impl SslContextRef {
    /// Returns the certificate associated with this `SslContext`, if present.
    #[corresponds(SSL_CTX_get0_certificate)]
    #[must_use]
    pub fn certificate(&self) -> Option<&X509Ref> {
        self.check_x509();

        unsafe {
            let ptr = ffi::SSL_CTX_get0_certificate(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509Ref::from_ptr(ptr))
            }
        }
    }

    /// Returns the private key associated with this `SslContext`, if present.
    #[corresponds(SSL_CTX_get0_privatekey)]
    #[must_use]
    pub fn private_key(&self) -> Option<&PKeyRef<Private>> {
        unsafe {
            let ptr = ffi::SSL_CTX_get0_privatekey(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(PKeyRef::from_ptr(ptr))
            }
        }
    }

    /// Returns a shared reference to the certificate store used for verification.
    #[corresponds(SSL_CTX_get_cert_store)]
    #[must_use]
    pub fn cert_store(&self) -> &X509StoreRef {
        self.check_x509();

        unsafe { X509StoreRef::from_ptr(ffi::SSL_CTX_get_cert_store(self.as_ptr())) }
    }

    /// Returns a shared reference to the stack of certificates making up the chain from the leaf.
    #[corresponds(SSL_CTX_get_extra_chain_certs)]
    #[must_use]
    pub fn extra_chain_certs(&self) -> &StackRef<X509> {
        unsafe {
            let mut chain = ptr::null_mut();
            ffi::SSL_CTX_get_extra_chain_certs(self.as_ptr(), &mut chain);
            assert!(!chain.is_null());
            StackRef::from_ptr(chain)
        }
    }

    /// Returns a reference to the extra data at the specified index.
    #[corresponds(SSL_CTX_get_ex_data)]
    #[must_use]
    pub fn ex_data<T>(&self, index: Index<SslContext, T>) -> Option<&T> {
        unsafe {
            let data = ffi::SSL_CTX_get_ex_data(self.as_ptr(), index.as_raw());
            if data.is_null() {
                None
            } else {
                Some(&*(data as *const T))
            }
        }
    }

    // Unsafe because SSL contexts are not guaranteed to be unique, we call
    // this only from SslContextBuilder.
    #[corresponds(SSL_CTX_get_ex_data)]
    unsafe fn ex_data_mut<T>(&mut self, index: Index<SslContext, T>) -> Option<&mut T> {
        unsafe {
            ffi::SSL_CTX_get_ex_data(self.as_ptr(), index.as_raw())
                .cast::<T>()
                .as_mut()
        }
    }

    // Unsafe because SSL contexts are not guaranteed to be unique, we call
    // this only from SslContextBuilder.
    #[corresponds(SSL_CTX_set_ex_data)]
    unsafe fn set_ex_data<T>(&mut self, index: Index<SslContext, T>, data: T) {
        unsafe {
            let data = Box::into_raw(Box::new(data));
            ffi::SSL_CTX_set_ex_data(self.as_ptr(), index.as_raw(), data.cast());
        }
    }

    // Unsafe because SSL contexts are not guaranteed to be unique, we call
    // this only from SslContextBuilder.
    #[corresponds(SSL_CTX_set_ex_data)]
    unsafe fn replace_ex_data<T>(&mut self, index: Index<SslContext, T>, data: T) -> Option<T> {
        unsafe {
            if let Some(old) = self.ex_data_mut(index) {
                return Some(mem::replace(old, data));
            }

            self.set_ex_data(index, data);

            None
        }
    }

    /// Adds a session to the context's cache.
    ///
    /// Returns `true` if the session was successfully added to the cache, and `false` if it was already present.
    ///
    /// # Safety
    ///
    /// The caller of this method is responsible for ensuring that the session has never been used with another
    /// `SslContext` than this one.
    #[corresponds(SSL_CTX_add_session)]
    #[must_use]
    pub unsafe fn add_session(&self, session: &SslSessionRef) -> bool {
        unsafe { ffi::SSL_CTX_add_session(self.as_ptr(), session.as_ptr()) != 0 }
    }

    /// Removes a session from the context's cache and marks it as non-resumable.
    ///
    /// Returns `true` if the session was successfully found and removed, and `false` otherwise.
    ///
    /// # Safety
    ///
    /// The caller of this method is responsible for ensuring that the session has never been used with another
    /// `SslContext` than this one.
    #[corresponds(SSL_CTX_remove_session)]
    #[must_use]
    pub unsafe fn remove_session(&self, session: &SslSessionRef) -> bool {
        unsafe { ffi::SSL_CTX_remove_session(self.as_ptr(), session.as_ptr()) != 0 }
    }

    /// Returns the context's session cache size limit.
    ///
    /// A value of 0 means that the cache size is unbounded.
    #[corresponds(SSL_CTX_sess_get_cache_size)]
    #[allow(clippy::useless_conversion)]
    #[must_use]
    pub fn session_cache_size(&self) -> u64 {
        unsafe { ffi::SSL_CTX_sess_get_cache_size(self.as_ptr()).into() }
    }

    /// Returns the verify mode that was set on this context from [`SslContextBuilder::set_verify`].
    ///
    /// [`SslContextBuilder::set_verify`]: struct.SslContextBuilder.html#method.set_verify
    #[corresponds(SSL_CTX_get_verify_mode)]
    #[must_use]
    pub fn verify_mode(&self) -> SslVerifyMode {
        self.check_x509();

        let mode = unsafe { ffi::SSL_CTX_get_verify_mode(self.as_ptr()) };
        SslVerifyMode::from_bits(mode).expect("SSL_CTX_get_verify_mode returned invalid mode")
    }

    /// Assumes that this `SslContext` is configured for X.509 certificates.
    ///
    /// # Safety
    ///
    /// BoringSSL will crash if the user calls a function that involves
    /// X.509 certificates with an object configured with this method.
    /// You most probably don't need it.
    pub unsafe fn assume_x509(&mut self) {
        unsafe {
            self.replace_ex_data(*X509_FLAG_INDEX, true);
        }
    }

    /// Returns `true` if context is configured for X.509 certificates.
    #[must_use]
    pub fn has_x509_support(&self) -> bool {
        self.ex_data(*X509_FLAG_INDEX).copied().unwrap_or_default()
    }

    #[track_caller]
    fn check_x509(&self) {
        assert!(
            self.has_x509_support(),
            "This context is not configured for X.509 certificates"
        );
    }

    /// Registers a list of ECH keys on the context. This list should contain new and old
    /// ECHConfigs to allow stale DNS caches to update. Unlike most `SSL_CTX` APIs, this function
    /// is safe to call even after the `SSL_CTX` has been associated with connections on various
    /// threads.
    #[corresponds(SSL_CTX_set1_ech_keys)]
    pub fn set_ech_keys(&self, keys: &SslEchKeys) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_CTX_set1_ech_keys(self.as_ptr(), keys.as_ptr())) }
    }
}

/// Error returned by the callback to get a session when operation
/// could not complete and should be retried later.
///
/// See [`SslContextBuilder::set_get_session_callback`].
#[derive(Debug)]
pub struct GetSessionPendingError;

/// Information about the state of a cipher.
pub struct CipherBits {
    /// The number of secret bits used for the cipher.
    pub secret: i32,

    /// The number of bits processed by the chosen algorithm.
    pub algorithm: i32,
}

#[repr(transparent)]
pub struct ClientHello<'ssl>(&'ssl ffi::SSL_CLIENT_HELLO);

impl ClientHello<'_> {
    /// Returns the data of a given extension, if present.
    #[corresponds(SSL_early_callback_ctx_extension_get)]
    #[must_use]
    pub fn get_extension(&self, ext_type: ExtensionType) -> Option<&[u8]> {
        unsafe {
            let mut ptr = ptr::null();
            let mut len = 0;
            let result =
                ffi::SSL_early_callback_ctx_extension_get(self.0, ext_type.0, &mut ptr, &mut len);
            if result == 0 {
                return None;
            }
            Some(slice::from_raw_parts(ptr, len))
        }
    }

    pub fn ssl_mut(&mut self) -> &mut SslRef {
        unsafe { SslRef::from_ptr_mut(self.0.ssl) }
    }

    #[must_use]
    pub fn ssl(&self) -> &SslRef {
        unsafe { SslRef::from_ptr(self.0.ssl) }
    }

    /// Returns the servername sent by the client via Server Name Indication (SNI).
    #[must_use]
    pub fn servername(&self, type_: NameType) -> Option<&str> {
        self.ssl().servername(type_)
    }

    /// Returns the version sent by the client in its Client Hello record.
    #[must_use]
    pub fn client_version(&self) -> SslVersion {
        SslVersion(self.0.version)
    }

    /// Returns a string describing the protocol version of the connection.
    #[must_use]
    pub fn version_str(&self) -> &'static str {
        self.ssl().version_str()
    }

    /// Returns the raw data of the client hello message
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.0.client_hello, self.0.client_hello_len) }
    }

    /// Returns the client random data
    #[must_use]
    pub fn random(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.0.random, self.0.random_len) }
    }

    /// Returns the raw list of ciphers supported by the client in its Client Hello record.
    #[must_use]
    pub fn ciphers(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.0.cipher_suites, self.0.cipher_suites_len) }
    }
}

/// Information about a cipher.
#[derive(Clone, Copy)]
pub struct SslCipher(&'static SslCipherRef);

impl SslCipher {
    #[corresponds(SSL_get_cipher_by_value)]
    #[must_use]
    pub fn from_value(value: u16) -> Option<Self> {
        unsafe {
            let ptr = ffi::SSL_get_cipher_by_value(value);
            if ptr.is_null() {
                None
            } else {
                Some(Self::from_ptr(ptr.cast_mut()))
            }
        }
    }
}

impl Stackable for SslCipher {
    type StackType = ffi::stack_st_SSL_CIPHER;
}

unsafe impl ForeignType for SslCipher {
    type CType = ffi::SSL_CIPHER;
    type Ref = SslCipherRef;

    #[inline]
    unsafe fn from_ptr(ptr: *mut ffi::SSL_CIPHER) -> SslCipher {
        SslCipher(unsafe { SslCipherRef::from_ptr(ptr) })
    }

    #[inline]
    fn as_ptr(&self) -> *mut ffi::SSL_CIPHER {
        self.0.as_ptr()
    }
}

impl Deref for SslCipher {
    type Target = SslCipherRef;

    fn deref(&self) -> &SslCipherRef {
        self.0
    }
}

/// Reference to an [`SslCipher`].
///
/// [`SslCipher`]: struct.SslCipher.html
pub struct SslCipherRef(Opaque);

unsafe impl Send for SslCipherRef {}
unsafe impl Sync for SslCipherRef {}

unsafe impl ForeignTypeRef for SslCipherRef {
    type CType = ffi::SSL_CIPHER;
}

impl SslCipherRef {
    /// Returns the IANA number of the cipher.
    #[corresponds(SSL_CIPHER_get_protocol_id)]
    #[must_use]
    pub fn protocol_id(&self) -> u16 {
        unsafe { ffi::SSL_CIPHER_get_protocol_id(self.as_ptr()) }
    }

    /// Returns the name of the cipher.
    #[corresponds(SSL_CIPHER_get_name)]
    #[must_use]
    pub fn name(&self) -> &'static str {
        unsafe {
            let ptr = ffi::SSL_CIPHER_get_name(self.as_ptr());
            CStr::from_ptr(ptr).to_str().unwrap()
        }
    }

    /// Returns the RFC-standard name of the cipher, if one exists.
    #[corresponds(SSL_CIPHER_standard_name)]
    #[must_use]
    pub fn standard_name(&self) -> Option<&'static str> {
        unsafe {
            let ptr = ffi::SSL_CIPHER_standard_name(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(CStr::from_ptr(ptr).to_str().unwrap())
            }
        }
    }

    /// Returns the SSL/TLS protocol version that first defined the cipher.
    #[corresponds(SSL_CIPHER_get_version)]
    #[must_use]
    pub fn version(&self) -> &'static str {
        let version = unsafe {
            let ptr = ffi::SSL_CIPHER_get_version(self.as_ptr());
            CStr::from_ptr(ptr)
        };

        version.to_str().unwrap()
    }

    /// Returns the number of bits used for the cipher.
    #[corresponds(SSL_CIPHER_get_bits)]
    #[allow(clippy::useless_conversion)]
    #[must_use]
    pub fn bits(&self) -> CipherBits {
        unsafe {
            let mut algo_bits = 0;
            let secret_bits = ffi::SSL_CIPHER_get_bits(self.as_ptr(), &mut algo_bits);
            CipherBits {
                secret: secret_bits.into(),
                algorithm: algo_bits.into(),
            }
        }
    }

    /// Returns a textual description of the cipher.
    #[corresponds(SSL_CIPHER_description)]
    #[must_use]
    pub fn description(&self) -> String {
        unsafe {
            // SSL_CIPHER_description requires a buffer of at least 128 bytes.
            let mut buf = [0; 128];
            let ptr = ffi::SSL_CIPHER_description(self.as_ptr(), buf.as_mut_ptr(), 128);
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }

    /// Returns one if the cipher uses an AEAD cipher.
    #[corresponds(SSL_CIPHER_is_aead)]
    #[must_use]
    pub fn cipher_is_aead(&self) -> bool {
        unsafe { ffi::SSL_CIPHER_is_aead(self.as_ptr()) != 0 }
    }

    /// Returns the NID corresponding to the cipher's authentication type.
    #[corresponds(SSL_CIPHER_get_auth_nid)]
    #[must_use]
    pub fn cipher_auth_nid(&self) -> Option<Nid> {
        let n = unsafe { ffi::SSL_CIPHER_get_auth_nid(self.as_ptr()) };
        if n == 0 {
            None
        } else {
            Some(Nid::from_raw(n))
        }
    }

    /// Returns the NID corresponding to the cipher.
    #[corresponds(SSL_CIPHER_get_cipher_nid)]
    #[must_use]
    pub fn cipher_nid(&self) -> Option<Nid> {
        let n = unsafe { ffi::SSL_CIPHER_get_cipher_nid(self.as_ptr()) };
        if n == 0 {
            None
        } else {
            Some(Nid::from_raw(n))
        }
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::SSL_SESSION;
    fn drop = ffi::SSL_SESSION_free;

    /// An encoded SSL session.
    ///
    /// These can be cached to share sessions across connections.
    pub struct SslSession;
}

impl Clone for SslSession {
    fn clone(&self) -> SslSession {
        SslSessionRef::to_owned(self)
    }
}

impl SslSession {
    from_der! {
        /// Deserializes a DER-encoded session structure.
        #[corresponds(d2i_SSL_SESSION)]
        from_der,
        SslSession,
        ffi::d2i_SSL_SESSION,
        ::libc::c_long
    }
}

impl ToOwned for SslSessionRef {
    type Owned = SslSession;

    fn to_owned(&self) -> SslSession {
        unsafe {
            SSL_SESSION_up_ref(self.as_ptr());
            SslSession(NonNull::new_unchecked(self.as_ptr()))
        }
    }
}

impl SslSessionRef {
    /// Returns the SSL session ID.
    #[corresponds(SSL_SESSION_get_id)]
    #[must_use]
    pub fn id(&self) -> &[u8] {
        unsafe {
            let mut len = 0;
            let p = ffi::SSL_SESSION_get_id(self.as_ptr(), &mut len);
            slice::from_raw_parts(p, len as usize)
        }
    }

    /// Returns the length of the master key.
    #[corresponds(SSL_SESSION_get_master_key)]
    #[must_use]
    pub fn master_key_len(&self) -> usize {
        unsafe { SSL_SESSION_get_master_key(self.as_ptr(), ptr::null_mut(), 0) }
    }

    /// Copies the master key into the provided buffer.
    ///
    /// Returns the number of bytes written, or the size of the master key if the buffer is empty.
    #[corresponds(SSL_SESSION_get_master_key)]
    pub fn master_key(&self, buf: &mut [u8]) -> usize {
        unsafe { SSL_SESSION_get_master_key(self.as_ptr(), buf.as_mut_ptr(), buf.len()) }
    }

    /// Returns the time at which the session was established, in seconds since the Unix epoch.
    #[corresponds(SSL_SESSION_get_time)]
    #[allow(clippy::useless_conversion)]
    #[must_use]
    pub fn time(&self) -> u64 {
        unsafe { ffi::SSL_SESSION_get_time(self.as_ptr()) }
    }

    /// Returns the sessions timeout, in seconds.
    ///
    /// A session older than this time should not be used for session resumption.
    #[corresponds(SSL_SESSION_get_timeout)]
    #[allow(clippy::useless_conversion)]
    #[must_use]
    pub fn timeout(&self) -> u32 {
        unsafe { ffi::SSL_SESSION_get_timeout(self.as_ptr()) }
    }

    /// Returns the session's TLS protocol version.
    #[corresponds(SSL_SESSION_get_protocol_version)]
    #[must_use]
    pub fn protocol_version(&self) -> SslVersion {
        unsafe {
            let version = ffi::SSL_SESSION_get_protocol_version(self.as_ptr());
            SslVersion(version)
        }
    }

    to_der! {
        /// Serializes the session into a DER-encoded structure.
        #[corresponds(i2d_SSL_SESSION)]
        to_der,
        ffi::i2d_SSL_SESSION
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::SSL;
    fn drop = ffi::SSL_free;

    /// The state of an SSL/TLS session.
    ///
    /// `Ssl` objects are created from an [`SslContext`], which provides configuration defaults.
    /// These defaults can be overridden on a per-`Ssl` basis, however.
    ///
    /// [`SslContext`]: struct.SslContext.html
    pub struct Ssl;
}

impl fmt::Debug for Ssl {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        fmt::Debug::fmt(&**self, fmt)
    }
}

impl Ssl {
    /// Returns a new extra data index.
    ///
    /// Each invocation of this function is guaranteed to return a distinct index. These can be used
    /// to store data in the context that can be retrieved later by callbacks, for example.
    #[corresponds(SSL_get_ex_new_index)]
    pub fn new_ex_index<T>() -> Result<Index<Ssl, T>, ErrorStack>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            ffi::init();
            let idx = cvt_n(get_new_ssl_idx(Some(free_data_box::<T>)))?;
            Ok(Index::from_raw(idx))
        }
    }

    // FIXME should return a result?
    fn cached_ex_index<T>() -> Index<Ssl, T>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            let idx = *SSL_INDEXES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(TypeId::of::<T>())
                .or_insert_with(|| Ssl::new_ex_index::<T>().unwrap().as_raw());
            Index::from_raw(idx)
        }
    }

    /// Creates a new [`Ssl`].
    #[corresponds(SSL_new)]
    pub fn new(ctx: &SslContextRef) -> Result<Ssl, ErrorStack> {
        unsafe {
            let ptr = cvt_p(ffi::SSL_new(ctx.as_ptr()))?;
            let mut ssl = Ssl::from_ptr(ptr);
            ssl.set_ex_data(*SESSION_CTX_INDEX, ctx.to_owned());

            Ok(ssl)
        }
    }

    /// Initiates a client-side TLS handshake, returning a [`MidHandshakeSslStream`].
    ///
    /// This method is guaranteed to return without calling any callback defined
    /// in the internal [`Ssl`] or [`SslContext`].
    ///
    /// See [`SslStreamBuilder::setup_connect`] for more details.
    ///
    /// # Warning
    ///
    /// BoringSSL's default configuration is insecure. It is highly recommended to use
    /// [`SslConnector`] rather than [`Ssl`] directly, as it manages that configuration.
    pub fn setup_connect<S>(self, stream: S) -> MidHandshakeSslStream<S>
    where
        S: Read + Write,
    {
        SslStreamBuilder::new(self, stream).setup_connect()
    }

    /// Attempts a client-side TLS handshake.
    ///
    /// This is a convenience method which combines [`Self::setup_connect`] and
    /// [`MidHandshakeSslStream::handshake`].
    ///
    /// # Warning
    ///
    /// OpenSSL's default configuration is insecure. It is highly recommended to use
    /// [`SslConnector`] rather than `Ssl` directly, as it manages that configuration.
    pub fn connect<S>(self, stream: S) -> Result<SslStream<S>, HandshakeError<S>>
    where
        S: Read + Write,
    {
        self.setup_connect(stream).handshake()
    }

    /// Initiates a server-side TLS handshake.
    ///
    /// This method is guaranteed to return without calling any callback defined
    /// in the internal [`Ssl`] or [`SslContext`].
    ///
    /// See [`SslStreamBuilder::setup_accept`] for more details.
    ///
    /// # Warning
    ///
    /// BoringSSL's default configuration is insecure. It is highly recommended to use
    /// [`SslAcceptor`] rather than [`Ssl`] directly, as it manages that configuration.
    pub fn setup_accept<S>(self, stream: S) -> MidHandshakeSslStream<S>
    where
        S: Read + Write,
    {
        SslStreamBuilder::new(self, stream).setup_accept()
    }

    /// Attempts a server-side TLS handshake.
    ///
    /// This is a convenience method which combines [`Self::setup_accept`] and
    /// [`MidHandshakeSslStream::handshake`].
    ///
    /// # Warning
    ///
    /// OpenSSL's default configuration is insecure. It is highly recommended to use
    /// `SslAcceptor` rather than `Ssl` directly, as it manages that configuration.
    ///
    /// [`SSL_accept`]: https://www.openssl.org/docs/manmaster/man3/SSL_accept.html
    pub fn accept<S>(self, stream: S) -> Result<SslStream<S>, HandshakeError<S>>
    where
        S: Read + Write,
    {
        self.setup_accept(stream).handshake()
    }
}

impl fmt::Debug for SslRef {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        let mut builder = fmt.debug_struct("Ssl");

        builder.field("state", &self.state_string_long());

        if self.ssl_context().has_x509_support() {
            builder.field("verify_result", &self.verify_result());
        }

        builder.field("verify_result", &self.verify_result());

        builder.finish()
    }
}

impl SslRef {
    fn get_raw_rbio(&self) -> *mut ffi::BIO {
        unsafe { ffi::SSL_get_rbio(self.as_ptr()) }
    }

    /// Sets the options used by the ongoing session, returning the old set.
    ///
    /// # Note
    ///
    /// This *enables* the specified options, but does not disable unspecified options. Use
    /// `clear_options` for that.
    #[corresponds(SSL_set_options)]
    pub fn set_options(&mut self, option: SslOptions) -> SslOptions {
        let bits = unsafe { ffi::SSL_set_options(self.as_ptr(), option.bits()) };
        SslOptions::from_bits_retain(bits)
    }

    /// Clears the options used by the ongoing session, returning the old set.
    #[corresponds(SSL_clear_options)]
    pub fn clear_options(&mut self, option: SslOptions) -> SslOptions {
        let bits = unsafe { ffi::SSL_clear_options(self.as_ptr(), option.bits()) };
        SslOptions::from_bits_retain(bits)
    }

    #[corresponds(SSL_set1_curves_list)]
    pub fn set_curves_list(&mut self, curves: &str) -> Result<(), ErrorStack> {
        let curves = CString::new(curves).map_err(ErrorStack::internal_error)?;
        unsafe { cvt_0i(ffi::SSL_set1_curves_list(self.as_ptr(), curves.as_ptr())).map(|_| ()) }
    }

    /// Returns the curve ID (aka group ID) used for this `SslRef`.
    #[corresponds(SSL_get_curve_id)]
    #[must_use]
    pub fn curve(&self) -> Option<u16> {
        let curve_id = unsafe { ffi::SSL_get_curve_id(self.as_ptr()) };
        if curve_id == 0 {
            return None;
        }
        Some(curve_id)
    }

    /// Returns the curve name used for this `SslRef`.
    #[corresponds(SSL_get_curve_name)]
    #[must_use]
    pub fn curve_name(&self) -> Option<&'static str> {
        let curve_id = self.curve()?;

        unsafe {
            let ptr = ffi::SSL_get_curve_name(curve_id);
            if ptr.is_null() {
                return None;
            }

            CStr::from_ptr(ptr).to_str().ok()
        }
    }

    /// Returns whether the TLS 1.3 HelloRetryRequest was used
    pub fn used_hello_retry_request(&self) -> bool {
        unsafe { ffi::SSL_used_hello_retry_request(self.as_ptr()) == 1 }
    }

    /// Returns an `ErrorCode` value for the most recent operation on this `SslRef`.
    #[corresponds(SSL_get_error)]
    #[must_use]
    pub fn error_code(&self, ret: c_int) -> ErrorCode {
        unsafe { ErrorCode::from_raw(ffi::SSL_get_error(self.as_ptr(), ret)) }
    }

    /// Like [`SslContextBuilder::set_verify`].
    ///
    /// [`SslContextBuilder::set_verify`]: struct.SslContextBuilder.html#method.set_verify
    #[corresponds(SSL_set_verify)]
    pub fn set_verify(&mut self, mode: SslVerifyMode) {
        self.ssl_context().check_x509();

        unsafe { ffi::SSL_set_verify(self.as_ptr(), c_int::from(mode.bits()), None) }
    }

    /// Sets the certificate verification depth.
    ///
    /// If the peer's certificate chain is longer than this value, verification will fail.
    #[corresponds(SSL_set_verify_depth)]
    pub fn set_verify_depth(&mut self, depth: u32) {
        self.ssl_context().check_x509();

        unsafe {
            ffi::SSL_set_verify_depth(self.as_ptr(), depth as c_int);
        }
    }

    /// Returns the verify mode that was set using `set_verify`.
    #[corresponds(SSL_get_verify_mode)]
    #[must_use]
    pub fn verify_mode(&self) -> SslVerifyMode {
        self.ssl_context().check_x509();

        let mode = unsafe { ffi::SSL_get_verify_mode(self.as_ptr()) };
        SslVerifyMode::from_bits(mode).expect("SSL_get_verify_mode returned invalid mode")
    }

    /// Like [`SslContextBuilder::set_verify_callback`].
    ///
    /// *Warning*: This callback does not replace the default certificate verification
    /// process and is, instead, called multiple times in the course of that process.
    /// It is very difficult to implement this callback correctly, without inadvertently
    /// relying on implementation details or making incorrect assumptions about when the
    /// callback is called.
    ///
    /// Instead, use [`SslContextBuilder::set_custom_verify_callback`] to customize
    /// certificate verification. Those callbacks can inspect the peer-sent chain,
    /// call [`X509StoreContextRef::verify_cert`] and inspect the result, or perform
    /// other operations more straightforwardly.
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    #[corresponds(SSL_set_verify)]
    pub fn set_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(bool, &mut X509StoreContextRef) -> bool + 'static + Sync + Send,
    {
        self.ssl_context().check_x509();

        unsafe {
            // this needs to be in an Arc since the callback can register a new callback!
            self.replace_ex_data(Ssl::cached_ex_index(), Arc::new(callback));
            ffi::SSL_set_verify(
                self.as_ptr(),
                c_int::from(mode.bits()),
                Some(ssl_raw_verify::<F>),
            );
        }
    }

    /// Sets a custom certificate store for verifying peer certificates.
    #[corresponds(SSL_set0_verify_cert_store)]
    pub fn set_verify_cert_store(&mut self, cert_store: X509Store) -> Result<(), ErrorStack> {
        self.ssl_context().check_x509();

        unsafe {
            cvt(ffi::SSL_set0_verify_cert_store(
                self.as_ptr(),
                cert_store.into_ptr(),
            ))
        }
    }

    /// Like [`SslContextBuilder::set_custom_verify_callback`].
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    #[corresponds(SSL_set_custom_verify)]
    pub fn set_custom_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(&mut SslRef) -> Result<(), SslVerifyError> + 'static + Sync + Send,
    {
        self.ssl_context().check_x509();

        unsafe {
            // this needs to be in an Arc since the callback can register a new callback!
            self.replace_ex_data(Ssl::cached_ex_index(), Arc::new(callback));
            ffi::SSL_set_custom_verify(
                self.as_ptr(),
                c_int::from(mode.bits()),
                Some(ssl_raw_custom_verify::<F>),
            );
        }
    }

    /// Like [`SslContextBuilder::set_tmp_dh`].
    ///
    /// [`SslContextBuilder::set_tmp_dh`]: struct.SslContextBuilder.html#method.set_tmp_dh
    #[corresponds(SSL_set_tmp_dh)]
    pub fn set_tmp_dh(&mut self, dh: &DhRef<Params>) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_set_tmp_dh(self.as_ptr(), dh.as_ptr())) }
    }

    /// Like [`SslContextBuilder::set_tmp_ecdh`].
    ///
    /// [`SslContextBuilder::set_tmp_ecdh`]: struct.SslContextBuilder.html#method.set_tmp_ecdh
    #[corresponds(SSL_set_tmp_ecdh)]
    pub fn set_tmp_ecdh(&mut self, key: &EcKeyRef<Params>) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_set_tmp_ecdh(self.as_ptr(), key.as_ptr())) }
    }

    /// Configures whether ClientHello extensions should be permuted.
    #[corresponds(SSL_set_permute_extensions)]
    pub fn set_permute_extensions(&mut self, enabled: bool) {
        unsafe { ffi::SSL_set_permute_extensions(self.as_ptr(), enabled as _) }
    }

    /// Like [`SslContextBuilder::set_alpn_protos`].
    ///
    /// [`SslContextBuilder::set_alpn_protos`]: struct.SslContextBuilder.html#method.set_alpn_protos
    #[corresponds(SSL_set_alpn_protos)]
    pub fn set_alpn_protos(&mut self, protocols: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            let r = ffi::SSL_set_alpn_protos(
                self.as_ptr(),
                protocols.as_ptr(),
                try_int(protocols.len())?,
            );
            // fun fact, SSL_set_alpn_protos has a reversed return code D:
            if r == 0 {
                Ok(())
            } else {
                Err(ErrorStack::get())
            }
        }
    }

    /// Returns the stack of available SslCiphers for `SSL`, sorted by preference.
    #[corresponds(SSL_get_ciphers)]
    #[must_use]
    pub fn ciphers(&self) -> &StackRef<SslCipher> {
        unsafe {
            let cipher_list = ffi::SSL_get_ciphers(self.as_ptr());
            StackRef::from_ptr(cipher_list)
        }
    }

    /// Returns the current cipher if the session is active.
    #[corresponds(SSL_get_current_cipher)]
    #[must_use]
    pub fn current_cipher(&self) -> Option<&SslCipherRef> {
        unsafe {
            let ptr = ffi::SSL_get_current_cipher(self.as_ptr());

            if ptr.is_null() {
                None
            } else {
                Some(SslCipherRef::from_ptr(ptr.cast_mut()))
            }
        }
    }

    /// Returns a short string describing the state of the session.
    ///
    /// Returns empty string if the state wasn't valid UTF-8.
    #[corresponds(SSL_state_string)]
    #[must_use]
    pub fn state_string(&self) -> &'static str {
        let state = unsafe {
            let ptr = ffi::SSL_state_string(self.as_ptr());
            CStr::from_ptr(ptr)
        };

        state.to_str().unwrap_or_default()
    }

    /// Returns a longer string describing the state of the session.
    ///
    /// Returns empty string if the state wasn't valid UTF-8.
    #[corresponds(SSL_state_string_long)]
    #[must_use]
    pub fn state_string_long(&self) -> &'static str {
        let state = unsafe {
            let ptr = ffi::SSL_state_string_long(self.as_ptr());
            CStr::from_ptr(ptr)
        };

        state.to_str().unwrap_or_default()
    }

    /// Sets the host name to be sent to the server for Server Name Indication (SNI).
    ///
    /// It has no effect for a server-side connection.
    #[corresponds(SSL_set_tlsext_host_name)]
    pub fn set_hostname(&mut self, hostname: &str) -> Result<(), ErrorStack> {
        let cstr = CString::new(hostname).map_err(ErrorStack::internal_error)?;
        unsafe { cvt(ffi::SSL_set_tlsext_host_name(self.as_ptr(), cstr.as_ptr())) }
    }

    /// Returns the peer's certificate, if present.
    #[corresponds(SSL_get_peer_certificate)]
    #[must_use]
    pub fn peer_certificate(&self) -> Option<X509> {
        self.ssl_context().check_x509();

        unsafe {
            let ptr = ffi::SSL_get_peer_certificate(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509::from_ptr(ptr))
            }
        }
    }

    /// Returns the certificate chain of the peer, if present.
    ///
    /// On the client side, the chain includes the leaf certificate, but on the server side it does
    /// not. Fun!
    #[corresponds(SSL_get_peer_cert_chain)]
    #[must_use]
    pub fn peer_cert_chain(&self) -> Option<&StackRef<X509>> {
        self.ssl_context().check_x509();

        unsafe {
            let ptr = ffi::SSL_get_peer_cert_chain(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(StackRef::from_ptr(ptr))
            }
        }
    }

    /// Like [`SslContext::certificate`].
    #[corresponds(SSL_get_certificate)]
    #[must_use]
    pub fn certificate(&self) -> Option<&X509Ref> {
        self.ssl_context().check_x509();

        unsafe {
            let ptr = ffi::SSL_get_certificate(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509Ref::from_ptr(ptr))
            }
        }
    }

    /// Like [`SslContext::private_key`].
    #[corresponds(SSL_get_privatekey)]
    #[must_use]
    pub fn private_key(&self) -> Option<&PKeyRef<Private>> {
        unsafe {
            let ptr = ffi::SSL_get_privatekey(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(PKeyRef::from_ptr(ptr))
            }
        }
    }

    #[deprecated(since = "0.10.5", note = "renamed to `version_str`")]
    #[must_use]
    pub fn version(&self) -> &str {
        self.version_str()
    }

    /// Returns the protocol version of the session.
    #[corresponds(SSL_version)]
    pub fn version2(&self) -> Option<SslVersion> {
        unsafe {
            let r = ffi::SSL_version(self.as_ptr());
            if r == 0 {
                None
            } else {
                r.try_into().ok().map(SslVersion)
            }
        }
    }

    /// Returns a string describing the protocol version of the session.
    ///
    /// This may panic if the string isn't valid UTF-8 for some reason. Use [`Self::version2`] instead.
    #[corresponds(SSL_get_version)]
    #[must_use]
    pub fn version_str(&self) -> &'static str {
        let version = unsafe {
            let ptr = ffi::SSL_get_version(self.as_ptr());
            CStr::from_ptr(ptr)
        };

        version.to_str().unwrap()
    }

    /// Sets the minimum supported protocol version.
    ///
    /// If version is `None`, the default minimum version is used. For BoringSSL this defaults to
    /// TLS 1.0.
    #[corresponds(SSL_set_min_proto_version)]
    pub fn set_min_proto_version(&mut self, version: Option<SslVersion>) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_set_min_proto_version(
                self.as_ptr(),
                version.map_or(0, |v| v.0 as _),
            ))
        }
    }

    /// Sets the maximum supported protocol version.
    ///
    /// If version is `None`, the default maximum version is used. For BoringSSL this is TLS 1.3.
    #[corresponds(SSL_set_max_proto_version)]
    pub fn set_max_proto_version(&mut self, version: Option<SslVersion>) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_set_max_proto_version(
                self.as_ptr(),
                version.map_or(0, |v| v.0 as _),
            ))
        }
    }

    /// Gets the minimum supported protocol version.
    #[corresponds(SSL_get_min_proto_version)]
    pub fn min_proto_version(&mut self) -> Option<SslVersion> {
        unsafe {
            let r = ffi::SSL_get_min_proto_version(self.as_ptr());
            if r == 0 {
                None
            } else {
                Some(SslVersion(r))
            }
        }
    }

    /// Gets the maximum supported protocol version.
    #[corresponds(SSL_get_max_proto_version)]
    #[must_use]
    pub fn max_proto_version(&self) -> Option<SslVersion> {
        let r = unsafe { ffi::SSL_get_max_proto_version(self.as_ptr()) };
        if r == 0 {
            None
        } else {
            Some(SslVersion(r))
        }
    }

    /// Returns the protocol selected via Application Layer Protocol Negotiation (ALPN).
    ///
    /// The protocol's name is returned is an opaque sequence of bytes. It is up to the client
    /// to interpret it.
    #[corresponds(SSL_get0_alpn_selected)]
    #[must_use]
    pub fn selected_alpn_protocol(&self) -> Option<&[u8]> {
        unsafe {
            let mut data: *const c_uchar = ptr::null();
            let mut len: c_uint = 0;
            // Get the negotiated protocol from the SSL instance.
            // `data` will point at a `c_uchar` array; `len` will contain the length of this array.
            ffi::SSL_get0_alpn_selected(self.as_ptr(), &mut data, &mut len);

            if data.is_null() {
                None
            } else {
                Some(slice::from_raw_parts(data, len as usize))
            }
        }
    }

    /// Enables the DTLS extension "use_srtp" as defined in RFC5764.
    #[corresponds(SSL_set_tlsext_use_srtp)]
    pub fn set_tlsext_use_srtp(&mut self, protocols: &str) -> Result<(), ErrorStack> {
        unsafe {
            let cstr = CString::new(protocols).map_err(ErrorStack::internal_error)?;

            let r = ffi::SSL_set_tlsext_use_srtp(self.as_ptr(), cstr.as_ptr());
            // fun fact, set_tlsext_use_srtp has a reversed return code D:
            if r == 0 {
                Ok(())
            } else {
                Err(ErrorStack::get())
            }
        }
    }

    /// Gets all SRTP profiles that are enabled for handshake via set_tlsext_use_srtp
    ///
    /// DTLS extension "use_srtp" as defined in RFC5764 has to be enabled.
    #[corresponds(SSL_get_strp_profiles)]
    #[must_use]
    pub fn srtp_profiles(&self) -> Option<&StackRef<SrtpProtectionProfile>> {
        unsafe {
            let chain = ffi::SSL_get_srtp_profiles(self.as_ptr());

            if chain.is_null() {
                None
            } else {
                Some(StackRef::from_ptr(chain.cast_mut()))
            }
        }
    }

    /// Gets the SRTP profile selected by handshake.
    ///
    /// DTLS extension "use_srtp" as defined in RFC5764 has to be enabled.
    #[corresponds(SSL_get_selected_srtp_profile)]
    #[must_use]
    pub fn selected_srtp_profile(&self) -> Option<&SrtpProtectionProfileRef> {
        unsafe {
            let profile = ffi::SSL_get_selected_srtp_profile(self.as_ptr());

            if profile.is_null() {
                None
            } else {
                Some(SrtpProtectionProfileRef::from_ptr(profile.cast_mut()))
            }
        }
    }

    /// Returns the number of bytes remaining in the currently processed TLS record.
    ///
    /// If this is greater than 0, the next call to `read` will not call down to the underlying
    /// stream.
    #[corresponds(SSL_pending)]
    #[must_use]
    pub fn pending(&self) -> usize {
        unsafe { ffi::SSL_pending(self.as_ptr()) as usize }
    }

    /// Returns the servername sent by the client via Server Name Indication (SNI).
    ///
    /// It is only useful on the server side.
    ///
    /// # Note
    ///
    /// While the SNI specification requires that servernames be valid domain names (and therefore
    /// ASCII), OpenSSL does not enforce this restriction. If the servername provided by the client
    /// is not valid UTF-8, this function will return `None`. The `servername_raw` method returns
    /// the raw bytes and does not have this restriction.
    ///
    // FIXME maybe rethink in 0.11?
    #[corresponds(SSL_get_servername)]
    #[must_use]
    pub fn servername(&self, type_: NameType) -> Option<&str> {
        self.servername_raw(type_)
            .and_then(|b| str::from_utf8(b).ok())
    }

    /// Returns the servername sent by the client via Server Name Indication (SNI).
    ///
    /// It is only useful on the server side.
    ///
    /// # Note
    ///
    /// Unlike `servername`, this method does not require the name be valid UTF-8.
    #[corresponds(SSL_get_servername)]
    #[must_use]
    pub fn servername_raw(&self, type_: NameType) -> Option<&[u8]> {
        unsafe {
            let name = ffi::SSL_get_servername(self.as_ptr(), type_.0);
            if name.is_null() {
                None
            } else {
                Some(CStr::from_ptr(name).to_bytes())
            }
        }
    }

    /// Changes the context corresponding to the current connection.
    ///
    /// It is most commonly used in the Server Name Indication (SNI) callback.
    #[corresponds(SSL_set_SSL_CTX)]
    pub fn set_ssl_context(&mut self, ctx: &SslContextRef) -> Result<(), ErrorStack> {
        assert_eq!(
            self.ssl_context().has_x509_support(),
            ctx.has_x509_support(),
            "X.509 certificate support in old and new contexts doesn't match",
        );

        unsafe { cvt_p(ffi::SSL_set_SSL_CTX(self.as_ptr(), ctx.as_ptr())).map(|_| ()) }
    }

    /// Returns the context corresponding to the current connection.
    #[corresponds(SSL_get_SSL_CTX)]
    #[must_use]
    pub fn ssl_context(&self) -> &SslContextRef {
        unsafe {
            let ssl_ctx = ffi::SSL_get_SSL_CTX(self.as_ptr());
            SslContextRef::from_ptr(ssl_ctx)
        }
    }

    /// Returns a mutable reference to the X509 verification configuration.
    #[corresponds(SSL_get0_param)]
    pub fn verify_param_mut(&mut self) -> &mut X509VerifyParamRef {
        self.ssl_context().check_x509();

        unsafe { X509VerifyParamRef::from_ptr_mut(ffi::SSL_get0_param(self.as_ptr())) }
    }

    /// See [`Self::verify_param_mut`].
    pub fn param_mut(&mut self) -> &mut X509VerifyParamRef {
        self.verify_param_mut()
    }

    /// Returns the certificate verification result.
    #[corresponds(SSL_get_verify_result)]
    pub fn verify_result(&self) -> X509VerifyResult {
        self.ssl_context().check_x509();

        unsafe { X509VerifyError::from_raw(ffi::SSL_get_verify_result(self.as_ptr()) as c_int) }
    }

    /// Returns a shared reference to the SSL session.
    #[corresponds(SSL_get_session)]
    #[must_use]
    pub fn session(&self) -> Option<&SslSessionRef> {
        unsafe {
            let p = ffi::SSL_get_session(self.as_ptr());
            if p.is_null() {
                None
            } else {
                Some(SslSessionRef::from_ptr(p))
            }
        }
    }

    /// Copies the client_random value sent by the client in the TLS handshake into a buffer.
    ///
    /// Returns the number of bytes copied, or if the buffer is empty, the size of the client_random
    /// value.
    #[corresponds(SSL_get_client_random)]
    pub fn client_random(&self, buf: &mut [u8]) -> usize {
        unsafe { ffi::SSL_get_client_random(self.as_ptr(), buf.as_mut_ptr(), buf.len()) }
    }

    /// Copies the server_random value sent by the server in the TLS handshake into a buffer.
    ///
    /// Returns the number of bytes copied, or if the buffer is empty, the size of the server_random
    /// value.
    #[corresponds(SSL_get_server_random)]
    pub fn server_random(&self, buf: &mut [u8]) -> usize {
        unsafe { ffi::SSL_get_server_random(self.as_ptr(), buf.as_mut_ptr(), buf.len()) }
    }

    /// Derives keying material for application use in accordance to RFC 5705.
    #[corresponds(SSL_export_keying_material)]
    pub fn export_keying_material(
        &self,
        out: &mut [u8],
        label: &str,
        context: Option<&[u8]>,
    ) -> Result<(), ErrorStack> {
        unsafe {
            let (context, contextlen, use_context) = match context {
                Some(context) => (context.as_ptr(), context.len(), 1),
                None => (ptr::null(), 0, 0),
            };
            cvt(ffi::SSL_export_keying_material(
                self.as_ptr(),
                out.as_mut_ptr(),
                out.len(),
                label.as_ptr().cast::<c_char>(),
                label.len(),
                context,
                contextlen,
                use_context,
            ))
        }
    }

    /// Sets the session to be used.
    ///
    /// This should be called before the handshake to attempt to reuse a previously established
    /// session. If the server is not willing to reuse the session, a new one will be transparently
    /// negotiated.
    ///
    /// # Safety
    ///
    /// The caller of this method is responsible for ensuring that the session is associated
    /// with the same `SslContext` as this `Ssl`.
    #[corresponds(SSL_set_session)]
    pub unsafe fn set_session(&mut self, session: &SslSessionRef) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_set_session(self.as_ptr(), session.as_ptr())) }
    }

    /// Determines if the session provided to `set_session` was successfully reused.
    #[corresponds(SSL_session_reused)]
    #[must_use]
    pub fn session_reused(&self) -> bool {
        unsafe { ffi::SSL_session_reused(self.as_ptr()) != 0 }
    }

    /// Sets the status response a client wishes the server to reply with.
    #[corresponds(SSL_set_tlsext_status_type)]
    pub fn set_status_type(&mut self, type_: StatusType) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_set_tlsext_status_type(
                self.as_ptr(),
                type_.as_raw(),
            ))
        }
    }

    /// Returns the server's OCSP response, if present.
    #[corresponds(SSL_get_tlsext_status_ocsp_resp)]
    #[must_use]
    pub fn ocsp_status(&self) -> Option<&[u8]> {
        unsafe {
            let mut p = ptr::null();
            let len = ffi::SSL_get_tlsext_status_ocsp_resp(self.as_ptr(), &mut p);

            if len == 0 {
                None
            } else {
                Some(slice::from_raw_parts(p, len))
            }
        }
    }

    /// Sets the OCSP response to be returned to the client.
    #[corresponds(SSL_set_ocsp_response)]
    pub fn set_ocsp_status(&mut self, response: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            assert!(response.len() <= c_int::MAX as usize);
            cvt(ffi::SSL_set_ocsp_response(
                self.as_ptr(),
                response.as_ptr(),
                response.len(),
            ))
        }
    }

    /// Determines if this `Ssl` is configured for server-side or client-side use.
    #[corresponds(SSL_is_server)]
    #[must_use]
    pub fn is_server(&self) -> bool {
        unsafe { SSL_is_server(self.as_ptr()) != 0 }
    }

    /// Sets the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `Ssl::new_ex_index` method to create an `Index`.
    ///
    /// Note that if this method is called multiple times with the same index, any previous
    /// value stored in the `SslContextBuilder` will be leaked.
    #[corresponds(SSL_set_ex_data)]
    pub fn set_ex_data<T>(&mut self, index: Index<Ssl, T>, data: T) {
        if let Some(old) = self.ex_data_mut(index) {
            *old = data;
            return;
        }

        unsafe {
            let data = Box::into_raw(Box::new(data));
            ffi::SSL_set_ex_data(self.as_ptr(), index.as_raw(), data.cast());
        }
    }

    /// Sets or overwrites the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `Ssl::new_ex_index` method to create an `Index`.
    ///
    /// The previous value, if any, will be returned.
    #[corresponds(SSL_set_ex_data)]
    pub fn replace_ex_data<T>(&mut self, index: Index<Ssl, T>, data: T) -> Option<T> {
        if let Some(old) = self.ex_data_mut(index) {
            return Some(mem::replace(old, data));
        }

        self.set_ex_data(index, data);

        None
    }

    /// Returns a reference to the extra data at the specified index.
    #[corresponds(SSL_get_ex_data)]
    #[must_use]
    pub fn ex_data<T>(&self, index: Index<Ssl, T>) -> Option<&T> {
        unsafe {
            let data = ffi::SSL_get_ex_data(self.as_ptr(), index.as_raw());
            if data.is_null() {
                None
            } else {
                Some(&*(data as *const T))
            }
        }
    }

    /// Returns a mutable reference to the extra data at the specified index.
    #[corresponds(SSL_get_ex_data)]
    pub fn ex_data_mut<T>(&mut self, index: Index<Ssl, T>) -> Option<&mut T> {
        unsafe {
            ffi::SSL_get_ex_data(self.as_ptr(), index.as_raw())
                .cast::<T>()
                .as_mut()
        }
    }

    /// Copies the contents of the last Finished message sent to the peer into the provided buffer.
    ///
    /// The total size of the message is returned, so this can be used to determine the size of the
    /// buffer required.
    #[corresponds(SSL_get_finished)]
    pub fn finished(&self, buf: &mut [u8]) -> usize {
        unsafe { ffi::SSL_get_finished(self.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) }
    }

    /// Copies the contents of the last Finished message received from the peer into the provided
    /// buffer.
    ///
    /// The total size of the message is returned, so this can be used to determine the size of the
    /// buffer required.
    #[corresponds(SSL_get_peer_finished)]
    pub fn peer_finished(&self, buf: &mut [u8]) -> usize {
        unsafe { ffi::SSL_get_peer_finished(self.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) }
    }

    /// Determines if the initial handshake has been completed.
    #[corresponds(SSL_is_init_finished)]
    #[must_use]
    pub fn is_init_finished(&self) -> bool {
        unsafe { ffi::SSL_is_init_finished(self.as_ptr()) != 0 }
    }

    /// Sets the MTU used for DTLS connections.
    #[corresponds(SSL_set_mtu)]
    pub fn set_mtu(&mut self, mtu: u32) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_set_mtu(self.as_ptr(), mtu as c_uint)) }
    }

    /// Sets the certificate.
    #[corresponds(SSL_use_certificate)]
    pub fn set_certificate(&mut self, cert: &X509Ref) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_use_certificate(self.as_ptr(), cert.as_ptr()))?;
        }

        Ok(())
    }

    /// Sets the list of CA names sent to the client.
    ///
    /// The CA certificates must still be added to the trust root - they are not automatically set
    /// as trusted by this method.
    #[corresponds(SSL_set_client_CA_list)]
    pub fn set_client_ca_list(&mut self, list: Stack<X509Name>) {
        self.ssl_context().check_x509();

        unsafe { ffi::SSL_set_client_CA_list(self.as_ptr(), list.as_ptr()) }
        mem::forget(list);
    }

    /// Sets the private key.
    #[corresponds(SSL_use_PrivateKey)]
    pub fn set_private_key<T>(&mut self, key: &PKeyRef<T>) -> Result<(), ErrorStack>
    where
        T: HasPrivate,
    {
        unsafe { cvt(ffi::SSL_use_PrivateKey(self.as_ptr(), key.as_ptr())) }
    }

    /// Enables all modes set in `mode` in `SSL`. Returns a bitmask representing the resulting
    /// enabled modes.
    #[corresponds(SSL_set_mode)]
    pub fn set_mode(&mut self, mode: SslMode) -> SslMode {
        let bits = unsafe { ffi::SSL_set_mode(self.as_ptr(), mode.bits()) };
        SslMode::from_bits_retain(bits)
    }

    /// Disables all modes set in `mode` in `SSL`. Returns a bitmask representing the resulting
    /// enabled modes.
    #[corresponds(SSL_clear_mode)]
    pub fn clear_mode(&mut self, mode: SslMode) -> SslMode {
        let bits = unsafe { ffi::SSL_clear_mode(self.as_ptr(), mode.bits()) };
        SslMode::from_bits_retain(bits)
    }

    /// Appends `cert` to the chain associated with the current certificate of `SSL`.
    #[corresponds(SSL_add1_chain_cert)]
    pub fn add_chain_cert(&mut self, cert: &X509Ref) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::SSL_add1_chain_cert(self.as_ptr(), cert.as_ptr())) }
    }

    /// Configures `ech_config_list` on `SSL` for offering ECH during handshakes. If the server
    /// cannot decrypt the encrypted ClientHello, `SSL` will instead handshake using
    /// the cleartext parameters of the ClientHelloOuter.
    ///
    /// Clients should use `get_ech_name_override` to verify the server certificate in case of ECH
    /// rejection, and follow up with `get_ech_retry_configs` to retry the connection with a fresh
    /// set of ECHConfigs. If the retry also fails, clients should report a connection failure.
    #[corresponds(SSL_set1_ech_config_list)]
    pub fn set_ech_config_list(&mut self, ech_config_list: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            cvt_0i(ffi::SSL_set1_ech_config_list(
                self.as_ptr(),
                ech_config_list.as_ptr(),
                ech_config_list.len(),
            ))
            .map(|_| ())
        }
    }

    /// This function returns a serialized `ECHConfigList` as provided by the
    /// server, if one exists.
    ///
    /// Clients should call this function when handling an `SSL_R_ECH_REJECTED` error code to
    /// recover from potential key mismatches. If the result is `Some`, the client should retry the
    /// connection using the returned `ECHConfigList`.
    #[corresponds(SSL_get0_ech_retry_configs)]
    #[must_use]
    pub fn get_ech_retry_configs(&self) -> Option<&[u8]> {
        unsafe {
            let mut data = ptr::null();
            let mut len: usize = 0;
            ffi::SSL_get0_ech_retry_configs(self.as_ptr(), &mut data, &mut len);

            if data.is_null() {
                None
            } else {
                Some(slice::from_raw_parts(data, len))
            }
        }
    }

    /// If `SSL` is a client and the server rejects ECH, this function returns the public name
    /// associated with the ECHConfig that was used to attempt ECH.
    ///
    /// Clients should call this function during the certificate verification callback to
    /// ensure the server's certificate is valid for the public name, which is required to
    /// authenticate retry configs.
    #[corresponds(SSL_get0_ech_name_override)]
    #[must_use]
    pub fn get_ech_name_override(&self) -> Option<&[u8]> {
        unsafe {
            let mut data: *const c_char = ptr::null();
            let mut len: usize = 0;
            ffi::SSL_get0_ech_name_override(self.as_ptr(), &mut data, &mut len);

            if data.is_null() {
                None
            } else {
                Some(slice::from_raw_parts(data.cast::<u8>(), len))
            }
        }
    }

    // Whether or not `SSL` negotiated ECH.
    #[corresponds(SSL_ech_accepted)]
    #[must_use]
    pub fn ech_accepted(&self) -> bool {
        unsafe { ffi::SSL_ech_accepted(self.as_ptr()) != 0 }
    }

    // Whether or not to enable ECH grease on `SSL`.
    #[corresponds(SSL_set_enable_ech_grease)]
    pub fn set_enable_ech_grease(&self, enable: bool) {
        let enable = if enable { 1 } else { 0 };

        unsafe {
            ffi::SSL_set_enable_ech_grease(self.as_ptr(), enable);
        }
    }

    /// Sets the compliance policy on `SSL`.
    #[corresponds(SSL_set_compliance_policy)]
    pub fn set_compliance_policy(&mut self, policy: CompliancePolicy) -> Result<(), ErrorStack> {
        unsafe { cvt_0i(ffi::SSL_set_compliance_policy(self.as_ptr(), policy.0)).map(|_| ()) }
    }

    /// Adds a credential.
    #[corresponds(SSL_add1_credential)]
    #[cfg(feature = "credential")]
    pub fn add_credential(&mut self, credential: &SslCredentialRef) -> Result<(), ErrorStack> {
        unsafe { cvt_0i(ffi::SSL_add1_credential(self.as_ptr(), credential.as_ptr())).map(|_| ()) }
    }

    /// Sets the client key shares to be used in the TLS 1.3 handshake.
    #[corresponds(SSL_set1_client_key_shares)]
    pub fn set_client_key_shares(&mut self, key_shares: &[KeyShare]) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_set1_client_key_shares(
                self.as_ptr(),
                key_shares.as_ptr() as *const _,
                key_shares.len(),
            ))
            .map(|_| ())
        }
    }

    /// Sets application settings flag for ALPS (Application-Layer Protocol Negotiation).
    #[corresponds(SSL_add_application_settings)]
    pub fn add_application_settings(&mut self, alps: &[u8]) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::SSL_add_application_settings(
                self.as_ptr(),
                alps.as_ptr(),
                alps.len(),
                std::ptr::null(),
                0,
            ))
            .map(|_| ())
        }
    }

    /// Sets the ALPS use new codepoint flag.
    #[corresponds(SSL_set_alps_use_new_codepoint)]
    pub fn set_alps_use_new_codepoint(&mut self, enable: bool) {
        let enable = if enable { 1 } else { 0 };
        unsafe { ffi::SSL_set_alps_use_new_codepoint(self.as_ptr(), enable) }
    }

    /// Sets whether the aes hardware override should be enabled.
    #[cfg(not(feature = "fips"))]
    #[corresponds(SSL_set_aes_hw_override)]
    pub fn set_aes_hw_override(&mut self, enable: bool) {
        let enable = if enable { 1 } else { 0 };
        unsafe { ffi::SSL_set_aes_hw_override(self.as_ptr(), enable) }
    }
}

/// An SSL stream midway through the handshake process.
#[derive(Debug)]
pub struct MidHandshakeSslStream<S> {
    stream: SslStream<S>,
    error: Error,
}

impl<S> MidHandshakeSslStream<S> {
    /// Returns a shared reference to the inner stream.
    #[must_use]
    pub fn get_ref(&self) -> &S {
        self.stream.get_ref()
    }

    /// Returns a mutable reference to the inner stream.
    pub fn get_mut(&mut self) -> &mut S {
        self.stream.get_mut()
    }

    /// Returns a shared reference to the `Ssl` of the stream.
    #[must_use]
    pub fn ssl(&self) -> &SslRef {
        self.stream.ssl()
    }

    /// Returns a mutable reference to the `Ssl` of the stream.
    pub fn ssl_mut(&mut self) -> &mut SslRef {
        self.stream.ssl_mut()
    }

    /// Returns the underlying error which interrupted this handshake.
    #[must_use]
    pub fn error(&self) -> &Error {
        &self.error
    }

    /// Consumes `self`, returning its error.
    #[must_use]
    pub fn into_error(self) -> Error {
        self.error
    }

    /// Returns the source data stream.
    #[must_use]
    pub fn into_source_stream(self) -> S {
        self.stream.into_inner()
    }

    /// Returns both the error and the source data stream, consuming `self`.
    #[must_use]
    pub fn into_parts(self) -> (Error, S) {
        (self.error, self.stream.into_inner())
    }

    /// Restarts the handshake process.
    #[corresponds(SSL_do_handshake)]
    pub fn handshake(mut self) -> Result<SslStream<S>, HandshakeError<S>> {
        let ret = unsafe { ffi::SSL_do_handshake(self.stream.ssl.as_ptr()) };
        if ret > 0 {
            Ok(self.stream)
        } else {
            self.error = self.stream.make_error(ret);
            Err(if self.error.would_block() {
                HandshakeError::WouldBlock(self)
            } else {
                HandshakeError::Failure(self)
            })
        }
    }
}

/// A TLS session over a stream.
pub struct SslStream<S> {
    ssl: ManuallyDrop<Ssl>,
    method: ManuallyDrop<BioMethod>,
    _p: PhantomData<S>,
}

impl<S> Drop for SslStream<S> {
    fn drop(&mut self) {
        // ssl holds a reference to method internally so it has to drop first
        unsafe {
            ManuallyDrop::drop(&mut self.ssl);
            ManuallyDrop::drop(&mut self.method);
        }
    }
}

impl<S> fmt::Debug for SslStream<S>
where
    S: fmt::Debug,
{
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        fmt.debug_struct("SslStream")
            .field("stream", &self.get_ref())
            .field("ssl", &self.ssl())
            .finish()
    }
}

impl<S: Read + Write> SslStream<S> {
    /// Creates a new `SslStream`.
    ///
    /// This function performs no IO; the stream will not have performed any part of the handshake
    /// with the peer. The `connect` and `accept` methods can be used to
    /// explicitly perform the handshake.
    pub fn new(ssl: Ssl, stream: S) -> Result<Self, ErrorStack> {
        let (bio, method) = bio::new(stream)?;

        unsafe {
            ffi::SSL_set_bio(ssl.as_ptr(), bio, bio);
        }

        Ok(SslStream {
            ssl: ManuallyDrop::new(ssl),
            method: ManuallyDrop::new(method),
            _p: PhantomData,
        })
    }

    /// Constructs an `SslStream` from a pointer to the underlying OpenSSL `SSL` struct.
    ///
    /// This is useful if the handshake has already been completed elsewhere.
    ///
    /// # Safety
    ///
    /// The caller must ensure the pointer is valid.
    pub unsafe fn from_raw_parts(ssl: *mut ffi::SSL, stream: S) -> Self {
        let ssl = unsafe { Ssl::from_ptr(ssl) };
        Self::new(ssl, stream).unwrap()
    }

    /// Like `read`, but takes a possibly-uninitialized slice.
    ///
    /// # Safety
    ///
    /// No portion of `buf` will be de-initialized by this method. If the method returns `Ok(n)`,
    /// then the first `n` bytes of `buf` are guaranteed to be initialized.
    pub fn read_uninit(&mut self, buf: &mut [MaybeUninit<u8>]) -> io::Result<usize> {
        loop {
            match self.ssl_read_uninit(buf) {
                Ok(n) => return Ok(n),
                Err(ref e) if e.code() == ErrorCode::ZERO_RETURN => return Ok(0),
                Err(ref e) if e.code() == ErrorCode::SYSCALL && e.io_error().is_none() => {
                    return Ok(0);
                }
                Err(ref e) if e.code() == ErrorCode::WANT_READ && e.io_error().is_none() => {}
                Err(e) => {
                    return Err(e.into_io_error().unwrap_or_else(io::Error::other));
                }
            }
        }
    }

    /// Like `read`, but returns an `ssl::Error` rather than an `io::Error`.
    ///
    /// It is particularly useful with a nonblocking socket, where the error value will identify if
    /// OpenSSL is waiting on read or write readiness.
    #[corresponds(SSL_read)]
    pub fn ssl_read(&mut self, buf: &mut [u8]) -> Result<usize, Error> {
        // SAFETY: `ssl_read_uninit` does not de-initialize the buffer.
        unsafe {
            self.ssl_read_uninit(slice::from_raw_parts_mut(
                buf.as_mut_ptr().cast::<MaybeUninit<u8>>(),
                buf.len(),
            ))
        }
    }

    /// Like `read_ssl`, but takes a possibly-uninitialized slice.
    ///
    /// # Safety
    ///
    /// No portion of `buf` will be de-initialized by this method. If the method returns `Ok(n)`,
    /// then the first `n` bytes of `buf` are guaranteed to be initialized.
    pub fn ssl_read_uninit(&mut self, buf: &mut [MaybeUninit<u8>]) -> Result<usize, Error> {
        if buf.is_empty() {
            return Ok(0);
        }

        let len = usize::min(c_int::MAX as usize, buf.len()) as c_int;
        let ret = unsafe { ffi::SSL_read(self.ssl().as_ptr(), buf.as_mut_ptr().cast(), len) };
        if ret > 0 {
            Ok(ret as usize)
        } else {
            Err(self.make_error(ret))
        }
    }

    /// Like `write`, but returns an `ssl::Error` rather than an `io::Error`.
    ///
    /// It is particularly useful with a nonblocking socket, where the error value will identify if
    /// OpenSSL is waiting on read or write readiness.
    #[corresponds(SSL_write)]
    pub fn ssl_write(&mut self, buf: &[u8]) -> Result<usize, Error> {
        if buf.is_empty() {
            return Ok(0);
        }

        let len = usize::min(c_int::MAX as usize, buf.len()) as c_int;
        let ret = unsafe { ffi::SSL_write(self.ssl().as_ptr(), buf.as_ptr().cast(), len) };
        if ret > 0 {
            Ok(ret as usize)
        } else {
            Err(self.make_error(ret))
        }
    }

    /// Shuts down the session.
    ///
    /// The shutdown process consists of two steps. The first step sends a close notify message to
    /// the peer, after which `ShutdownResult::Sent` is returned. The second step awaits the receipt
    /// of a close notify message from the peer, after which `ShutdownResult::Received` is returned.
    ///
    /// While the connection may be closed after the first step, it is recommended to fully shut the
    /// session down. In particular, it must be fully shut down if the connection is to be used for
    /// further communication in the future.
    #[corresponds(SSL_shutdown)]
    pub fn shutdown(&mut self) -> Result<ShutdownResult, Error> {
        match unsafe { ffi::SSL_shutdown(self.ssl.as_ptr()) } {
            0 => Ok(ShutdownResult::Sent),
            1 => Ok(ShutdownResult::Received),
            n => Err(self.make_error(n)),
        }
    }

    /// Returns the session's shutdown state.
    #[corresponds(SSL_get_shutdown)]
    pub fn get_shutdown(&mut self) -> ShutdownState {
        unsafe {
            let bits = ffi::SSL_get_shutdown(self.ssl.as_ptr());
            ShutdownState::from_bits_retain(bits)
        }
    }

    /// Sets the session's shutdown state.
    ///
    /// This can be used to tell OpenSSL that the session should be cached even if a full two-way
    /// shutdown was not completed.
    #[corresponds(SSL_set_shutdown)]
    pub fn set_shutdown(&mut self, state: ShutdownState) {
        unsafe { ffi::SSL_set_shutdown(self.ssl.as_ptr(), state.bits()) }
    }

    /// Initiates a client-side TLS handshake.
    #[corresponds(SSL_connect)]
    pub fn connect(&mut self) -> Result<(), Error> {
        let ret = unsafe { ffi::SSL_connect(self.ssl.as_ptr()) };
        if ret > 0 {
            Ok(())
        } else {
            Err(self.make_error(ret))
        }
    }

    /// Initiates a server-side TLS handshake.
    #[corresponds(SSL_accept)]
    pub fn accept(&mut self) -> Result<(), Error> {
        let ret = unsafe { ffi::SSL_accept(self.ssl.as_ptr()) };
        if ret > 0 {
            Ok(())
        } else {
            Err(self.make_error(ret))
        }
    }

    /// Initiates the handshake.
    #[corresponds(SSL_do_handshake)]
    pub fn do_handshake(&mut self) -> Result<(), Error> {
        let ret = unsafe { ffi::SSL_do_handshake(self.ssl.as_ptr()) };
        if ret > 0 {
            Ok(())
        } else {
            Err(self.make_error(ret))
        }
    }
}

impl<S> SslStream<S> {
    fn make_error(&mut self, ret: c_int) -> Error {
        self.check_panic();

        let code = self.ssl.error_code(ret);

        let cause = match code {
            ErrorCode::SSL => Some(InnerError::Ssl(ErrorStack::get())),
            ErrorCode::SYSCALL => {
                let errs = ErrorStack::get();
                if errs.errors().is_empty() {
                    self.get_bio_error().map(InnerError::Io)
                } else {
                    Some(InnerError::Ssl(errs))
                }
            }
            ErrorCode::ZERO_RETURN => None,
            ErrorCode::WANT_READ | ErrorCode::WANT_WRITE => {
                self.get_bio_error().map(InnerError::Io)
            }
            _ => None,
        };

        Error { code, cause }
    }

    fn check_panic(&mut self) {
        if let Some(err) = unsafe { bio::take_panic::<S>(self.ssl.get_raw_rbio()) } {
            resume_unwind(err)
        }
    }

    fn get_bio_error(&mut self) -> Option<io::Error> {
        unsafe { bio::take_error::<S>(self.ssl.get_raw_rbio()) }
    }

    /// Converts the SslStream to the underlying data stream.
    #[must_use]
    pub fn into_inner(self) -> S {
        unsafe { bio::take_stream::<S>(self.ssl.get_raw_rbio()) }
    }

    /// Returns a shared reference to the underlying stream.
    #[must_use]
    pub fn get_ref(&self) -> &S {
        unsafe {
            let bio = self.ssl.get_raw_rbio();
            bio::get_ref(bio)
        }
    }

    /// Returns a mutable reference to the underlying stream.
    ///
    /// # Warning
    ///
    /// It is inadvisable to read from or write to the underlying stream as it
    /// will most likely corrupt the SSL session.
    pub fn get_mut(&mut self) -> &mut S {
        unsafe {
            let bio = self.ssl.get_raw_rbio();
            bio::get_mut(bio)
        }
    }

    /// Returns a shared reference to the `Ssl` object associated with this stream.
    #[must_use]
    pub fn ssl(&self) -> &SslRef {
        &self.ssl
    }

    /// Returns a mutable reference to the `Ssl` object associated with this stream.
    pub fn ssl_mut(&mut self) -> &mut SslRef {
        &mut self.ssl
    }
}

impl<S: Read + Write> Read for SslStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // SAFETY: `read_uninit` does not de-initialize the buffer
        unsafe {
            self.read_uninit(slice::from_raw_parts_mut(
                buf.as_mut_ptr().cast::<MaybeUninit<u8>>(),
                buf.len(),
            ))
        }
    }
}

impl<S: Read + Write> Write for SslStream<S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            match self.ssl_write(buf) {
                Ok(n) => return Ok(n),
                Err(ref e) if e.code() == ErrorCode::WANT_READ && e.io_error().is_none() => {}
                Err(e) => {
                    return Err(e.into_io_error().unwrap_or_else(io::Error::other));
                }
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.get_mut().flush()
    }
}

/// A partially constructed `SslStream`, useful for unusual handshakes.
pub struct SslStreamBuilder<S> {
    inner: SslStream<S>,
}

impl<S> SslStreamBuilder<S>
where
    S: Read + Write,
{
    /// Begin creating an `SslStream` atop `stream`
    pub fn new(ssl: Ssl, stream: S) -> Self {
        Self {
            inner: SslStream::new(ssl, stream).unwrap(),
        }
    }

    /// Configure as an outgoing stream from a client.
    #[corresponds(SSL_set_connect_state)]
    pub fn set_connect_state(&mut self) {
        unsafe { ffi::SSL_set_connect_state(self.inner.ssl.as_ptr()) }
    }

    /// Configure as an incoming stream to a server.
    #[corresponds(SSL_set_accept_state)]
    pub fn set_accept_state(&mut self) {
        unsafe { ffi::SSL_set_accept_state(self.inner.ssl.as_ptr()) }
    }

    /// Initiates a client-side TLS handshake, returning a [`MidHandshakeSslStream`].
    ///
    /// This method calls [`Self::set_connect_state`] and returns without actually
    /// initiating the handshake. The caller is then free to call
    /// [`MidHandshakeSslStream`] and loop on [`HandshakeError::WouldBlock`].
    #[must_use]
    pub fn setup_connect(mut self) -> MidHandshakeSslStream<S> {
        self.set_connect_state();

        MidHandshakeSslStream {
            stream: self.inner,
            error: Error {
                code: ErrorCode::WANT_WRITE,
                cause: Some(InnerError::Io(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "connect handshake has not started yet",
                ))),
            },
        }
    }

    /// Attempts a client-side TLS handshake.
    ///
    /// This is a convenience method which combines [`Self::setup_connect`] and
    /// [`MidHandshakeSslStream::handshake`].
    pub fn connect(self) -> Result<SslStream<S>, HandshakeError<S>> {
        self.setup_connect().handshake()
    }

    /// Initiates a server-side TLS handshake, returning a [`MidHandshakeSslStream`].
    ///
    /// This method calls [`Self::set_accept_state`] and returns without actually
    /// initiating the handshake. The caller is then free to call
    /// [`MidHandshakeSslStream`] and loop on [`HandshakeError::WouldBlock`].
    #[must_use]
    pub fn setup_accept(mut self) -> MidHandshakeSslStream<S> {
        self.set_accept_state();

        MidHandshakeSslStream {
            stream: self.inner,
            error: Error {
                code: ErrorCode::WANT_READ,
                cause: Some(InnerError::Io(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "accept handshake has not started yet",
                ))),
            },
        }
    }

    /// Attempts a server-side TLS handshake.
    ///
    /// This is a convenience method which combines [`Self::setup_accept`] and
    /// [`MidHandshakeSslStream::handshake`].
    pub fn accept(self) -> Result<SslStream<S>, HandshakeError<S>> {
        self.setup_accept().handshake()
    }

    /// Initiates the handshake.
    ///
    /// This will fail if `set_accept_state` or `set_connect_state` was not called first.
    #[corresponds(SSL_do_handshake)]
    pub fn handshake(self) -> Result<SslStream<S>, HandshakeError<S>> {
        let mut stream = self.inner;
        let ret = unsafe { ffi::SSL_do_handshake(stream.ssl.as_ptr()) };
        if ret > 0 {
            Ok(stream)
        } else {
            let error = stream.make_error(ret);
            Err(if error.would_block() {
                HandshakeError::WouldBlock(MidHandshakeSslStream { stream, error })
            } else {
                HandshakeError::Failure(MidHandshakeSslStream { stream, error })
            })
        }
    }
}

impl<S> SslStreamBuilder<S> {
    /// Returns a shared reference to the underlying stream.
    #[must_use]
    pub fn get_ref(&self) -> &S {
        unsafe {
            let bio = self.inner.ssl.get_raw_rbio();
            bio::get_ref(bio)
        }
    }

    /// Returns a mutable reference to the underlying stream.
    ///
    /// # Warning
    ///
    /// It is inadvisable to read from or write to the underlying stream as it
    /// will most likely corrupt the SSL session.
    pub fn get_mut(&mut self) -> &mut S {
        unsafe {
            let bio = self.inner.ssl.get_raw_rbio();
            bio::get_mut(bio)
        }
    }

    /// Returns a shared reference to the `Ssl` object associated with this builder.
    #[must_use]
    pub fn ssl(&self) -> &SslRef {
        &self.inner.ssl
    }

    /// Returns a mutable reference to the `Ssl` object associated with this builder.
    pub fn ssl_mut(&mut self) -> &mut SslRef {
        &mut self.inner.ssl
    }

    /// Set the DTLS MTU size.
    ///
    /// It will be ignored if the value is smaller than the minimum packet size
    /// the DTLS protocol requires.
    ///
    /// # Panics
    /// This function panics if the given mtu size can't be represented in a positive `c_long` range
    #[deprecated(note = "Use SslRef::set_mtu instead", since = "0.10.30")]
    pub fn set_dtls_mtu_size(&mut self, mtu_size: usize) {
        unsafe {
            let bio = self.inner.ssl.get_raw_rbio();
            bio::set_dtls_mtu_size::<S>(bio, mtu_size);
        }
    }
}

/// The result of a shutdown request.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ShutdownResult {
    /// A close notify message has been sent to the peer.
    Sent,

    /// A close notify response message has been received from the peer.
    Received,
}

bitflags! {
    /// The shutdown state of a session.
    #[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord, Hash)]
    pub struct ShutdownState: c_int {
        /// A close notify message has been sent to the peer.
        const SENT = ffi::SSL_SENT_SHUTDOWN;
        /// A close notify message has been received from the peer.
        const RECEIVED = ffi::SSL_RECEIVED_SHUTDOWN;
    }
}

/// Describes private key hooks. This is used to off-load signing operations to
/// a custom, potentially asynchronous, backend. Metadata about the key such as
/// the type and size are parsed out of the certificate.
///
/// Corresponds to [`ssl_private_key_method_st`].
///
/// [`ssl_private_key_method_st`]: https://commondatastorage.googleapis.com/chromium-boringssl-docs/ssl.h.html#ssl_private_key_method_st
pub trait PrivateKeyMethod: Send + Sync + 'static {
    /// Signs the message `input` using the specified signature algorithm.
    ///
    /// On success, it returns `Ok(written)` where `written` is the number of
    /// bytes written into `output`. On failure, it returns
    /// `Err(PrivateKeyMethodError::FAILURE)`. If the operation has not completed,
    /// it returns `Err(PrivateKeyMethodError::RETRY)`.
    ///
    /// The caller should arrange for the high-level operation on `ssl` to be
    /// retried when the operation is completed. This will result in a call to
    /// [`Self::complete`].
    fn sign(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        signature_algorithm: SslSignatureAlgorithm,
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError>;

    /// Decrypts `input`.
    ///
    /// On success, it returns `Ok(written)` where `written` is the number of
    /// bytes written into `output`. On failure, it returns
    /// `Err(PrivateKeyMethodError::FAILURE)`. If the operation has not completed,
    /// it returns `Err(PrivateKeyMethodError::RETRY)`.
    ///
    /// The caller should arrange for the high-level operation on `ssl` to be
    /// retried when the operation is completed. This will result in a call to
    /// [`Self::complete`].
    ///
    /// This method only works with RSA keys and should perform a raw RSA
    /// decryption operation with no padding.
    // NOTE(nox): What does it mean that it is an error?
    fn decrypt(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError>;

    /// Completes a pending operation.
    ///
    /// On success, it returns `Ok(written)` where `written` is the number of
    /// bytes written into `output`. On failure, it returns
    /// `Err(PrivateKeyMethodError::FAILURE)`. If the operation has not completed,
    /// it returns `Err(PrivateKeyMethodError::RETRY)`.
    ///
    /// This method may be called arbitrarily many times before completion.
    fn complete(&self, ssl: &mut SslRef, output: &mut [u8])
        -> Result<usize, PrivateKeyMethodError>;
}

/// An error returned from a private key method.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct PrivateKeyMethodError(ffi::ssl_private_key_result_t);

impl PrivateKeyMethodError {
    /// A fatal error occurred and the handshake should be terminated.
    pub const FAILURE: Self = Self(ffi::ssl_private_key_result_t::ssl_private_key_failure);

    /// The operation could not be completed and should be retried later.
    pub const RETRY: Self = Self(ffi::ssl_private_key_result_t::ssl_private_key_retry);
}

/// Describes certificate compression algorithm. Implementation MUST implement transformation at least in one direction.
pub trait CertificateCompressor: Send + Sync + 'static {
    /// An IANA assigned identifier of compression algorithm
    const ALGORITHM: CertificateCompressionAlgorithm;

    /// Indicates if compressor support compression
    const CAN_COMPRESS: bool;

    /// Indicates if compressor support decompression
    const CAN_DECOMPRESS: bool;

    /// Perform compression of `input` buffer and write compressed data to `output`.
    #[allow(unused_variables)]
    fn compress<W>(&self, input: &[u8], output: &mut W) -> std::io::Result<()>
    where
        W: std::io::Write,
    {
        Err(std::io::Error::other("not implemented"))
    }

    /// Perform decompression of `input` buffer and write compressed data to `output`.
    #[allow(unused_variables)]
    fn decompress<W>(&self, input: &[u8], output: &mut W) -> std::io::Result<()>
    where
        W: std::io::Write,
    {
        Err(std::io::Error::other("not implemented"))
    }
}

use crate::ffi::{SSL_CTX_up_ref, SSL_SESSION_get_master_key, SSL_SESSION_up_ref, SSL_is_server};

unsafe fn get_new_idx(f: ffi::CRYPTO_EX_free) -> c_int {
    unsafe { ffi::SSL_CTX_get_ex_new_index(0, ptr::null_mut(), ptr::null_mut(), None, f) }
}

unsafe fn get_new_ssl_idx(f: ffi::CRYPTO_EX_free) -> c_int {
    unsafe { ffi::SSL_get_ex_new_index(0, ptr::null_mut(), ptr::null_mut(), None, f) }
}

fn path_to_cstring(path: &Path) -> Result<CString, ErrorStack> {
    CString::new(path.as_os_str().as_encoded_bytes()).map_err(ErrorStack::internal_error)
}
