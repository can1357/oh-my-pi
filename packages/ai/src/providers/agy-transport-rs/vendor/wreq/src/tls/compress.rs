//! TLS certificate compression [RFC 8879](https://datatracker.ietf.org/doc/html/rfc8879).
//!
//! Reduces handshake latency by compressing certificate chains.
//! Supports Zlib, Brotli, and Zstd algorithms to minimize bytes-on-wire
//! and fit within the initial congestion window.

use std::{fmt::Debug, io};

use btls::{
    error::ErrorStack,
    ssl::{self, SslConnectorBuilder},
};
use btls_sys as ffi;
// Re-export the `CertificateCompressionAlgorithm` enum for users of this module.
pub use ssl::CertificateCompressionAlgorithm;

/// Certificate compression or decompression.
///
/// Wraps a function pointer or closure that processes certificate data.
#[allow(clippy::type_complexity)]
pub enum Codec {
    /// Function pointer.
    Pointer(fn(&[u8], &mut dyn io::Write) -> io::Result<()>),
    /// Closure or function object.
    Dynamic(Box<dyn Fn(&[u8], &mut dyn io::Write) -> io::Result<()> + Send + Sync>),
}

/// Trait for TLS certificate compression implementations.
///
/// Provides methods for compressing and decompressing certificate data,
/// as well as identifying the algorithm in use.
///
/// See [RFC 8879, §3](https://www.rfc-editor.org/rfc/rfc8879.html#name-compression-algorithms)
/// for the list of IANA-assigned compression algorithm identifiers.
pub trait CertificateCompressor: Debug + Sync + Send + 'static {
    /// Returns the [`Codec`] used to compress certificate chains for this algorithm.
    fn compress(&self) -> Codec;

    /// Returns the [`Codec`] used to decompress certificate chains for this algorithm.
    fn decompress(&self) -> Codec;

    /// Returns the IANA-assigned identifier of the compression algorithm.
    fn algorithm(&self) -> CertificateCompressionAlgorithm;
}

struct Compressor<const ALGORITHM: i32> {
    compress: Codec,
    decompress: Codec,
}

// ===== impl Codec =====

impl Codec {
    #[inline]
    fn call(&self, input: &[u8], output: &mut dyn io::Write) -> io::Result<()> {
        match self {
            Codec::Pointer(func) => func(input, output),
            Codec::Dynamic(closure) => closure(input, output),
        }
    }
}

// ===== impl Compressor =====

impl<const ALGORITHM: i32> ssl::CertificateCompressor for Compressor<ALGORITHM> {
    const ALGORITHM: CertificateCompressionAlgorithm = match ALGORITHM {
        ffi::TLSEXT_cert_compression_zlib => CertificateCompressionAlgorithm::ZLIB,
        ffi::TLSEXT_cert_compression_brotli => CertificateCompressionAlgorithm::BROTLI,
        ffi::TLSEXT_cert_compression_zstd => CertificateCompressionAlgorithm::ZSTD,
        _ => unreachable!(),
    };
    const CAN_COMPRESS: bool = true;
    const CAN_DECOMPRESS: bool = true;

    #[inline]
    fn compress<W>(&self, input: &[u8], output: &mut W) -> io::Result<()>
    where
        W: io::Write,
    {
        self.compress.call(input, output)
    }

    #[inline]
    fn decompress<W>(&self, input: &[u8], output: &mut W) -> io::Result<()>
    where
        W: io::Write,
    {
        self.decompress.call(input, output)
    }
}

/// Register a certificate compressor with the given [`SslConnectorBuilder`].
pub(super) fn register(
    compressor: &dyn CertificateCompressor,
    builder: &mut SslConnectorBuilder,
) -> Result<(), ErrorStack> {
    match compressor.algorithm() {
        CertificateCompressionAlgorithm::ZLIB => {
            builder.add_certificate_compression_algorithm(Compressor::<
                { ffi::TLSEXT_cert_compression_zlib },
            > {
                compress: compressor.compress(),
                decompress: compressor.decompress(),
            })
        }
        CertificateCompressionAlgorithm::BROTLI => {
            builder.add_certificate_compression_algorithm(Compressor::<
                { ffi::TLSEXT_cert_compression_brotli },
            > {
                compress: compressor.compress(),
                decompress: compressor.decompress(),
            })
        }
        CertificateCompressionAlgorithm::ZSTD => {
            builder.add_certificate_compression_algorithm(Compressor::<
                { ffi::TLSEXT_cert_compression_zstd },
            > {
                compress: compressor.compress(),
                decompress: compressor.decompress(),
            })
        }
        _ => unreachable!(),
    }
}
