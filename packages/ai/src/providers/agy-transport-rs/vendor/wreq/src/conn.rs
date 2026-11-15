mod timeout;
mod tls_info;
mod verbose;

pub(super) mod connector;
pub(super) mod descriptor;
pub(super) mod http;
pub(super) mod net;
pub(super) mod proxy;

use std::{
    fmt::{self, Debug, Formatter},
    io,
    io::IoSlice,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};

use ::http::{Extensions, HeaderMap, HeaderValue};
#[cfg(any(feature = "tokio-rt", feature = "compio-rt"))]
use net::TcpConnector;
use pin_project_lite::pin_project;
use tls_info::TlsInfoFactory;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_btls::SslStream;
use tower::{
    BoxError,
    util::{BoxCloneSyncService, BoxCloneSyncServiceLayer},
};

use crate::{
    dns::DynResolver,
    proxy::matcher::Intercept,
    tls::{AlpnProtocol, TlsInfo},
};

/// HTTP connector with dynamic DNS resolver.
pub type HttpConnector = http::HttpConnector<DynResolver, TcpConnector>;

/// Type-erased transport service retained after custom connector layers are composed.
pub type BoxedTransportConnector = BoxCloneSyncService<Unnameable, Conn, BoxError>;

/// Type-erased layer applied while assembling a [`BoxedTransportConnector`].
pub type BoxedConnectorLayer =
    BoxCloneSyncServiceLayer<BoxedTransportConnector, Unnameable, Conn, BoxError>;

/// A wrapper type for [`descriptor::ConnectionDescriptor`] used to erase its concrete type.
///
/// [`Unnameable`] allows passing connection requests through trait objects or
/// type-erased interfaces where the concrete type of the request is not important.
/// This is mainly used internally to simplify service composition and dynamic dispatch.
pub struct Unnameable(pub(super) descriptor::ConnectionDescriptor);

/// A trait alias for types that can be used as async connections.
///
/// This trait is automatically implemented for any type that satisfies the required bounds:
/// - [`AsyncRead`] + [`AsyncWrite`]: For I/O operations
/// - [`Connection`]: For connection metadata
/// - [`Send`] + [`Sync`] + [`Unpin`] + `'static`: For async/await compatibility
trait AsyncConn: AsyncRead + AsyncWrite + Connection + Send + Sync + Unpin + 'static {}

/// An async connection that can also provide TLS information.
///
/// This extends [`AsyncConn`] with the ability to extract TLS certificate information
/// when available. Useful for connections that may be either plain TCP or TLS-encrypted.
trait AsyncConnWithInfo: AsyncConn + TlsInfoFactory {}

impl<T> AsyncConn for T where T: AsyncRead + AsyncWrite + Connection + Send + Sync + Unpin + 'static {}

impl<T> AsyncConnWithInfo for T where T: AsyncConn + TlsInfoFactory {}

pin_project! {
    /// Note: the `is_proxy` member means *is plain text HTTP proxy*.
    /// This tells core whether the URI should be written in
    /// * origin-form (`GET /just/a/path HTTP/1.1`), when `proxy == None`, or
    /// * absolute-form (`GET http://foo.bar/and/a/path HTTP/1.1`), otherwise.
    pub struct Conn {
        tls_info: bool,
        proxy: Option<Intercept>,
        #[pin]
        stream: Box<dyn AsyncConnWithInfo>,
    }
}

pin_project! {
    /// A wrapper around `SslStream` that adapts it for use as a generic async connection.
    ///
    /// This type enables unified handling of plain TCP and TLS-encrypted streams by providing
    /// implementations of `Connection`, `Read`, `Write`, and `TlsInfoFactory`.
    /// It is mainly used internally to abstract over different connection types.
    pub struct TlsConn<T> {
        #[pin]
        stream: SslStream<T>,
    }
}

/// Describes a type returned by a connector.
pub trait Connection {
    /// Return metadata describing the connection.
    fn connected(&self) -> Connected;
}

/// Indicates the negotiated ALPN protocol.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Alpn {
    H2,
    None,
}

/// A pill that can be poisoned to indicate that a connection should not be reused.
#[derive(Clone)]
struct PoisonPill(Arc<AtomicBool>);

/// A boxed asynchronous connection with associated information.
#[derive(Debug)]
struct Extra(Box<dyn ExtraInner>);

/// Inner trait for extra connection information.
trait ExtraInner: Send + Sync + Debug {
    fn clone_box(&self) -> Box<dyn ExtraInner>;
    fn set(&self, res: &mut Extensions);
}

// This indirection allows the `Connected` to have a type-erased "extra" value,
// while that type still knows its inner extra type. This allows the correct
// TypeId to be used when inserting into `res.extensions_mut()`.
#[derive(Debug, Clone)]
struct ExtraEnvelope<T>(T);

/// Chains two `ExtraInner` implementations together, inserting both into
/// the extensions.
#[derive(Debug)]
struct ExtraChain<T>(Box<dyn ExtraInner>, T);

/// Information about an HTTP proxy identity.
#[derive(Debug, Default, Clone)]
struct ProxyIdentity {
    is_proxied: bool,
    auth: Option<HeaderValue>,
    headers: Option<HeaderMap>,
}

/// Extra information about the connected transport.
///
/// This can be used to inform recipients about things like if ALPN
/// was used, or if connected to an HTTP proxy.
#[derive(Debug, Clone)]
pub struct Connected {
    alpn: Alpn,
    proxy: Box<ProxyIdentity>,
    extra: Option<Extra>,
    poisoned: PoisonPill,
}

// ==== impl Conn ====

impl Connection for Conn {
    fn connected(&self) -> Connected {
        let mut connected = self.stream.connected();

        if let Some(proxy) = &self.proxy {
            connected = connected.proxy(proxy.clone());
        }

        if self.tls_info {
            if let Some(tls_info) = self.stream.tls_info() {
                connected.extra(tls_info)
            } else {
                connected
            }
        } else {
            connected
        }
    }
}

impl AsyncRead for Conn {
    #[inline]
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        AsyncRead::poll_read(self.project().stream, cx, buf)
    }
}

impl AsyncWrite for Conn {
    #[inline]
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context,
        buf: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        AsyncWrite::poll_write(self.project().stream, cx, buf)
    }

    #[inline]
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<Result<usize, io::Error>> {
        AsyncWrite::poll_write_vectored(self.project().stream, cx, bufs)
    }

    #[inline]
    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), io::Error>> {
        AsyncWrite::poll_flush(self.project().stream, cx)
    }

    #[inline]
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), io::Error>> {
        AsyncWrite::poll_shutdown(self.project().stream, cx)
    }
}

// ===== impl TlsConn =====

impl<T> Connection for TlsConn<T>
where
    T: Connection,
{
    fn connected(&self) -> Connected {
        let connected = self.stream.get_ref().connected();
        if self
            .stream
            .ssl()
            .selected_alpn_protocol()
            .is_some_and(|alpn| AlpnProtocol::HTTP2.eq(alpn))
        {
            connected.negotiated_h2()
        } else {
            connected
        }
    }
}

impl<T: AsyncRead + AsyncWrite + Unpin> AsyncRead for TlsConn<T> {
    #[inline]
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<tokio::io::Result<()>> {
        AsyncRead::poll_read(self.project().stream, cx, buf)
    }
}

impl<T: AsyncRead + AsyncWrite + Unpin> AsyncWrite for TlsConn<T> {
    #[inline]
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context,
        buf: &[u8],
    ) -> Poll<Result<usize, tokio::io::Error>> {
        AsyncWrite::poll_write(self.project().stream, cx, buf)
    }

    #[inline]
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<Result<usize, io::Error>> {
        AsyncWrite::poll_write_vectored(self.project().stream, cx, bufs)
    }

    #[inline]
    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), tokio::io::Error>> {
        AsyncWrite::poll_flush(self.project().stream, cx)
    }

    #[inline]
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Result<(), tokio::io::Error>> {
        AsyncWrite::poll_shutdown(self.project().stream, cx)
    }
}

impl<T> TlsInfoFactory for TlsConn<T>
where
    SslStream<T>: TlsInfoFactory,
{
    #[inline]
    fn tls_info(&self) -> Option<TlsInfo> {
        self.stream.tls_info()
    }
}

// ===== impl PoisonPill =====

impl fmt::Debug for PoisonPill {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        // print the address of the pill—this makes debugging issues much easier
        write!(
            f,
            "PoisonPill@{:p} {{ poisoned: {} }}",
            self.0,
            self.0.load(Ordering::Relaxed)
        )
    }
}

impl PoisonPill {
    /// Create a healthy (not poisoned) pill.
    #[inline]
    fn healthy() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

// ===== impl Connected =====

impl Connected {
    /// Create new `Connected` type with empty metadata.
    pub fn new() -> Connected {
        Connected {
            alpn: Alpn::None,
            proxy: Box::new(ProxyIdentity::default()),
            extra: None,
            poisoned: PoisonPill::healthy(),
        }
    }

    /// Set extra connection information to be set in the extensions of every `Response`.
    pub fn extra<T: Clone + Send + Sync + Debug + 'static>(mut self, extra: T) -> Connected {
        if let Some(prev) = self.extra {
            self.extra = Some(Extra(Box::new(ExtraChain(prev.0, extra))));
        } else {
            self.extra = Some(Extra(Box::new(ExtraEnvelope(extra))));
        }
        self
    }

    /// Copies the extra connection information into an `Extensions` map.
    #[inline]
    pub fn set_extras(&self, extensions: &mut Extensions) {
        if let Some(extra) = &self.extra {
            extra.set(extensions);
        }
    }

    /// Set that the proxy was used for this connected transport.
    pub fn proxy(mut self, proxy: Intercept) -> Connected {
        self.proxy.is_proxied = true;

        if let Some(auth) = proxy.basic_auth() {
            self.proxy.auth.replace(auth.clone());
        }

        if let Some(headers) = proxy.custom_headers() {
            self.proxy.headers.replace(headers.clone());
        }

        self
    }

    /// Determines if the connected transport is to an HTTP proxy.
    #[inline]
    pub fn is_proxied(&self) -> bool {
        self.proxy.is_proxied
    }

    /// Get the proxy identity information for the connected transport.
    #[inline]
    pub fn proxy_auth(&self) -> Option<&HeaderValue> {
        self.proxy.auth.as_ref()
    }

    /// Get the custom proxy headers for the connected transport.
    #[inline]
    pub fn proxy_headers(&self) -> Option<&HeaderMap> {
        self.proxy.headers.as_ref()
    }

    /// Set that the connected transport negotiated HTTP/2 as its next protocol.
    #[inline]
    pub fn negotiated_h2(mut self) -> Connected {
        self.alpn = Alpn::H2;
        self
    }

    /// Determines if the connected transport negotiated HTTP/2 as its next protocol.
    #[inline]
    pub fn is_negotiated_h2(&self) -> bool {
        self.alpn == Alpn::H2
    }

    /// Determine if this connection is poisoned
    #[inline]
    pub fn poisoned(&self) -> bool {
        self.poisoned.0.load(Ordering::Relaxed)
    }

    /// Poison this connection
    ///
    /// A poisoned connection will not be reused for subsequent requests by the pool
    #[allow(unused)]
    #[inline]
    pub fn poison(&self) {
        self.poisoned.0.store(true, Ordering::Relaxed);
        debug!(
            "connection was poisoned. this connection will not be reused for subsequent requests"
        );
    }
}

// ===== impl Extra =====

impl Extra {
    #[inline]
    fn set(&self, res: &mut Extensions) {
        self.0.set(res);
    }
}

impl Clone for Extra {
    fn clone(&self) -> Extra {
        Extra(self.0.clone_box())
    }
}

// ===== impl ExtraEnvelope =====

impl<T> ExtraInner for ExtraEnvelope<T>
where
    T: Clone + Send + Sync + Debug + 'static,
{
    fn clone_box(&self) -> Box<dyn ExtraInner> {
        Box::new(self.clone())
    }

    fn set(&self, res: &mut Extensions) {
        res.insert(self.0.clone());
    }
}

// ===== impl ExtraChain =====

impl<T: Clone> Clone for ExtraChain<T> {
    fn clone(&self) -> Self {
        ExtraChain(self.0.clone_box(), self.1.clone())
    }
}

impl<T> ExtraInner for ExtraChain<T>
where
    T: Clone + Send + Sync + Debug + 'static,
{
    fn clone_box(&self) -> Box<dyn ExtraInner> {
        Box::new(self.clone())
    }

    fn set(&self, res: &mut Extensions) {
        self.0.set(res);
        res.insert(self.1.clone());
    }
}
