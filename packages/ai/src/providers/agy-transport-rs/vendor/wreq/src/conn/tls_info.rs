use bytes::Bytes;
use tokio_btls::SslStream;

use crate::tls::{TlsInfo, conn::MaybeHttpsStream};

/// A trait for extracting TLS information from a connection.
pub trait TlsInfoFactory {
    #[inline]
    fn tls_info(&self) -> Option<TlsInfo> {
        None
    }
}

fn extract_tls_info<S>(ssl_stream: &SslStream<S>) -> TlsInfo {
    let ssl = ssl_stream.ssl();
    TlsInfo {
        peer_certificate: ssl
            .peer_certificate()
            .and_then(|cert| cert.to_der().ok())
            .map(Bytes::from),
        peer_certificate_chain: ssl.peer_cert_chain().map(|chain| {
            chain
                .iter()
                .filter_map(|cert| cert.to_der().ok())
                .map(Bytes::from)
                .collect()
        }),
    }
}

// Generic impl: any SslStream can provide TLS info.
impl<T> TlsInfoFactory for SslStream<T> {
    #[inline]
    fn tls_info(&self) -> Option<TlsInfo> {
        Some(extract_tls_info(self))
    }
}

// Generic impl: MaybeHttpsStream delegates to the inner stream.
impl<T: TlsInfoFactory> TlsInfoFactory for MaybeHttpsStream<T> {
    fn tls_info(&self) -> Option<TlsInfo> {
        match self {
            MaybeHttpsStream::Https(tls) => tls.tls_info(),
            MaybeHttpsStream::Http(_) => None,
        }
    }
}
