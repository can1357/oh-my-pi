use std::{
    future::Future,
    marker::PhantomData,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::Arc,
    task::{self, Poll},
    time::Duration,
};

use http::uri::{Scheme, Uri};
use pin_project_lite::pin_project;
use tokio::io::{AsyncRead, AsyncWrite};
use tower::{BoxError, Service};

use super::{
    Connection,
    net::{
        SocketBindOptions,
        tcp::{ConnectError, ConnectingTcp, TcpConnector, TcpKeepaliveOptions, TcpOptions},
    },
};
use crate::dns::{self, DnsResolver};

static INVALID_NOT_HTTP: &str = "invalid URI, scheme is not http";
static INVALID_MISSING_SCHEME: &str = "invalid URI, scheme is missing";
static INVALID_MISSING_HOST: &str = "invalid URI, host is missing";

type ConnectResult<S> = Result<<S as TcpConnector>::Connection, ConnectError>;
type BoxConnecting<S> = Pin<Box<dyn Future<Output = ConnectResult<S>> + Send>>;

/// A trait for configuring HTTP transport options on a [`Service<Uri>`] connector.
///
/// Provides methods to adjust TCP/socket-level settings such as keepalive,
/// timeouts, buffer sizes, and local address binding. [`HttpConnector`]
/// is the default implementation.
pub trait HttpConnect: Service<Uri> + Clone + Send + Sized + 'static
where
    Self::Response: AsyncRead + AsyncWrite + Connection + Unpin + Send + 'static,
    Self::Error: Into<BoxError>,
    Self::Future: Unpin + Send + 'static,
{
    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied duration
    /// to remain idle before sending TCP keepalive probes.
    fn enforce_http(&mut self, enforced: bool);

    /// Set that all sockets have `SO_NODELAY` set to the supplied value `nodelay`.
    fn set_nodelay(&mut self, nodelay: bool);

    /// Sets the value of the `SO_SNDBUF` option on the socket.
    fn set_send_buffer_size(&mut self, size: Option<usize>);

    /// Sets the value of the `SO_RCVBUF` option on the socket.
    fn set_recv_buffer_size(&mut self, size: Option<usize>);

    /// Set that all socket have `SO_REUSEADDR` set to the supplied value `reuse_address`.
    fn set_reuse_address(&mut self, reuse: bool);

    /// Sets the value of the `SO_LINGER` option on the socket.
    fn set_linger(&mut self, linger: Option<Duration>);

    /// Sets the value of the `TCP_USER_TIMEOUT` option on the socket.
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    fn set_tcp_user_timeout(&mut self, time: Option<Duration>);

    /// Set the timeout for the complete TCP connection race.
    fn set_connect_timeout(&mut self, dur: Option<Duration>);

    /// Set the delay between connection attempts for [RFC 8305 (Happy Eyeballs v2)][RFC 8305].
    ///
    /// [RFC 8305]: https://www.rfc-editor.org/rfc/rfc8305.html#section-5
    fn set_happy_eyeballs_timeout(&mut self, dur: Option<Duration>);

    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied duration
    /// to remain idle before sending TCP keepalive probes.
    fn set_keepalive(&mut self, time: Option<Duration>);

    /// Set the duration between two successive TCP keepalive retransmissions,
    /// if acknowledgement to the previous keepalive transmission is not received.
    fn set_keepalive_interval(&mut self, interval: Option<Duration>);

    /// Set the number of retransmissions to be carried out before declaring that remote end is not
    /// available.
    fn set_keepalive_retries(&mut self, retries: Option<u32>);

    /// Sets the name of the interface to bind sockets produced.
    #[cfg(any(
        target_os = "android",
        target_os = "fuchsia",
        target_os = "illumos",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos",
        target_os = "solaris",
        target_os = "tvos",
        target_os = "visionos",
        target_os = "watchos",
    ))]
    fn set_interface<I: Into<std::borrow::Cow<'static, str>>>(&mut self, interface: I);

    /// Set that all sockets are bound to the configured IPv4 or IPv6 address (depending on host's
    /// preferences) before connection.
    fn set_local_addresses<V4, V6>(&mut self, ipv4_address: V4, ipv6_address: V6)
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>;
}

/// A connector for the `http` scheme.
///
/// Performs DNS resolution in a thread pool, and then connects over TCP.
///
/// # Note
///
/// Sets the [`HttpInfo`] value on responses, which includes
/// transport information such as the remote socket address used.
#[derive(Clone)]
pub struct HttpConnector<R, S> {
    options: Arc<TcpOptions>,
    resolver: R,
    connector: S,
}

/// Extra information about the transport when an HttpConnector is used.
///
/// # Example
///
/// ```
/// # fn doc(res: http::Response<()>) {
/// use crate::util::client::connect::HttpInfo;
///
/// // res = http::Response
/// res.extensions().get::<HttpInfo>().map(|info| {
///     println!("remote addr = {}", info.remote_addr());
/// });
/// # }
/// ```
///
/// # Note
///
/// If a different connector is used besides [`HttpConnector`],
/// this value will not exist in the extensions. Consult that specific
/// connector to see what "extra" information it might provide to responses.
#[derive(Clone, Debug)]
pub struct HttpInfo {
    pub(crate) remote_addr: SocketAddr,
    pub(crate) local_addr: SocketAddr,
}

// ===== impl HttpConnector =====

impl<R, S> HttpConnector<R, S> {
    /// Construct a new [`HttpConnector`].
    pub fn new(resolver: R, connector: S) -> HttpConnector<R, S> {
        HttpConnector {
            options: Arc::new(TcpOptions {
                enforce_http: true,
                connect_timeout: None,
                happy_eyeballs_timeout: Some(Duration::from_millis(300)),
                nodelay: false,
                reuse_address: false,
                linger: None,
                send_buffer_size: None,
                recv_buffer_size: None,
                #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
                tcp_user_timeout: None,
                tcp_keepalive: TcpKeepaliveOptions::default(),
                socket_bind: SocketBindOptions::default(),
            }),
            resolver,
            connector,
        }
    }

    fn config_mut(&mut self) -> &mut TcpOptions {
        // If the are HttpConnector clones, this will clone the inner
        // config. So mutating the config won't ever affect previous
        // clones.
        Arc::make_mut(&mut self.options)
    }
}

impl<R, S> HttpConnect for HttpConnector<R, S>
where
    R: DnsResolver + Clone + Send + Sync + 'static,
    R::Future: Send,
    S: TcpConnector,
{
    /// Option to enforce all `Uri`s have the `http` scheme.
    ///
    /// Enabled by default.
    #[inline]
    fn enforce_http(&mut self, is_enforced: bool) {
        self.config_mut().enforce_http = is_enforced;
    }

    /// Set that all sockets have `SO_NODELAY` set to the supplied value `nodelay`.
    ///
    /// Default is `false`.
    #[inline]
    fn set_nodelay(&mut self, nodelay: bool) {
        self.config_mut().nodelay = nodelay;
    }

    /// Sets the value of the SO_SNDBUF option on the socket.
    #[inline]
    fn set_send_buffer_size(&mut self, size: Option<usize>) {
        self.config_mut().send_buffer_size = size;
    }

    /// Sets the value of the SO_RCVBUF option on the socket.
    #[inline]
    fn set_recv_buffer_size(&mut self, size: Option<usize>) {
        self.config_mut().recv_buffer_size = size;
    }

    /// Set that all socket have `SO_REUSEADDR` set to the supplied value `reuse_address`.
    ///
    /// Default is `false`.
    #[inline]
    fn set_reuse_address(&mut self, reuse_address: bool) {
        self.config_mut().reuse_address = reuse_address;
    }

    /// Sets the value of the SO_LINGER option on the socket.
    ///
    /// Default is `None`, which leaves the option untouched.
    #[inline]
    fn set_linger(&mut self, linger: Option<Duration>) {
        self.config_mut().linger = linger;
    }

    /// Sets the value of the TCP_USER_TIMEOUT option on the socket.
    #[inline]
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    fn set_tcp_user_timeout(&mut self, time: Option<Duration>) {
        self.config_mut().tcp_user_timeout = time;
    }

    /// Set the timeout for the complete TCP connection race.
    ///
    /// Default is `None`.
    #[inline]
    fn set_connect_timeout(&mut self, dur: Option<Duration>) {
        self.config_mut().connect_timeout = dur;
    }

    /// Set the delay between connection attempts for [RFC 8305 (Happy Eyeballs v2)][RFC 8305].
    ///
    /// The first address is attempted immediately. Later addresses are started
    /// after this delay without waiting for the previous attempt to finish.
    ///
    /// If `None`, parallel connection attempts are disabled.
    ///
    /// Default is 300 milliseconds.
    ///
    /// [RFC 8305]: https://www.rfc-editor.org/rfc/rfc8305.html#section-5
    #[inline]
    fn set_happy_eyeballs_timeout(&mut self, dur: Option<Duration>) {
        self.config_mut().happy_eyeballs_timeout = dur;
    }

    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied duration
    /// to remain idle before sending TCP keepalive probes.
    ///
    /// If `None`, keepalive is disabled.
    ///
    /// Default is `None`.
    #[inline]
    fn set_keepalive(&mut self, time: Option<Duration>) {
        self.config_mut().tcp_keepalive.time = time;
    }

    /// Set the duration between two successive TCP keepalive retransmissions,
    /// if acknowledgement to the previous keepalive transmission is not received.
    #[inline]
    fn set_keepalive_interval(&mut self, interval: Option<Duration>) {
        self.config_mut().tcp_keepalive.interval = interval;
    }

    /// Set the number of retransmissions to be carried out before declaring that remote end is not
    /// available.
    #[inline]
    fn set_keepalive_retries(&mut self, retries: Option<u32>) {
        self.config_mut().tcp_keepalive.retries = retries;
    }

    /// Sets the name of the interface to bind sockets produced by this
    /// connector.
    ///
    /// On Linux, this sets the `SO_BINDTODEVICE` option on this socket (see
    /// [`man 7 socket`] for details). On macOS (and macOS-derived systems like
    /// iOS), illumos, and Solaris, this will instead use the `IP_BOUND_IF`
    /// socket option (see [`man 7p ip`]).
    ///
    /// If a socket is bound to an interface, only packets received from that particular
    /// interface are processed by the socket. Note that this only works for some socket
    /// types, particularly `AF_INET`` sockets.
    ///
    /// On Linux it can be used to specify a [VRF], but the binary needs
    /// to either have `CAP_NET_RAW` or to be run as root.
    ///
    /// This function is only available on the following operating systems:
    /// - Linux, including Android
    /// - Fuchsia
    /// - illumos and Solaris
    /// - macOS, iOS, visionOS, watchOS, and tvOS
    ///
    /// [VRF]: https://www.kernel.org/doc/Documentation/networking/vrf.txt
    /// [`man 7 socket`]: https://man7.org/linux/man-pages/man7/socket.7.html
    /// [`man 7p ip`]: https://docs.oracle.com/cd/E86824_01/html/E54777/ip-7p.html
    #[cfg(any(
        target_os = "android",
        target_os = "fuchsia",
        target_os = "illumos",
        target_os = "ios",
        target_os = "linux",
        target_os = "macos",
        target_os = "solaris",
        target_os = "tvos",
        target_os = "visionos",
        target_os = "watchos",
    ))]
    fn set_interface<I: Into<std::borrow::Cow<'static, str>>>(&mut self, interface: I) {
        self.config_mut().socket_bind.set_interface(interface);
    }

    /// Set that all sockets are bound to the configured IPv4 or IPv6 address (depending on host's
    /// preferences) before connection.
    ///
    /// If `None`, the sockets will not be bound.
    ///
    /// Default is `None`.
    fn set_local_addresses<V4, V6>(&mut self, ipv4_address: V4, ipv6_address: V6)
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>,
    {
        self.config_mut()
            .socket_bind
            .set_local_addresses(ipv4_address, ipv6_address);
    }
}

impl<R, S> Service<Uri> for HttpConnector<R, S>
where
    R: DnsResolver + Clone + Send + Sync + 'static,
    R::Future: Send,
    S: TcpConnector,
    S::TcpStream: From<socket2::Socket>,
{
    type Response = S::Connection;
    type Error = ConnectError;
    type Future = HttpConnecting<R, S>;

    #[inline]
    fn poll_ready(&mut self, cx: &mut task::Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.resolver.poll_ready(cx).map_err(ConnectError::dns)
    }

    fn call(&mut self, dst: Uri) -> Self::Future {
        let mut this = self.clone();

        let fut = async move {
            let options = &this.options;

            let (host, port) = get_host_port(options, &dst)?;
            let host = crate::util::strip_ipv6_brackets(host);

            let addrs = if let Some(addrs) = dns::SocketAddrs::try_parse(host, port) {
                addrs
            } else {
                let addrs = dns::resolve(&mut this.resolver, dns::Name::new(host.into()))
                    .await
                    .map_err(ConnectError::dns)?;
                let addrs = addrs
                    .map(|mut addr| {
                        set_port(&mut addr, port, dst.port().is_some());
                        addr
                    })
                    .collect();
                dns::SocketAddrs::new(addrs)
            };

            ConnectingTcp::new(addrs, options, this.connector)
                .connect(options)
                .await
        };

        HttpConnecting {
            fut: Box::pin(fut),
            _marker: PhantomData,
        }
    }
}

fn get_host_port<'u>(options: &TcpOptions, dst: &'u Uri) -> Result<(&'u str, u16), ConnectError> {
    trace!(
        "Http::connect; scheme={:?}, host={:?}, port={:?}",
        dst.scheme(),
        dst.host(),
        dst.port(),
    );

    if options.enforce_http {
        if dst.scheme() != Some(&Scheme::HTTP) {
            return Err(ConnectError {
                msg: INVALID_NOT_HTTP,
                addr: None,
                cause: None,
            });
        }
    } else if dst.scheme().is_none() {
        return Err(ConnectError {
            msg: INVALID_MISSING_SCHEME,
            addr: None,
            cause: None,
        });
    }

    let host = match dst.host() {
        Some(s) => s,
        None => {
            return Err(ConnectError {
                msg: INVALID_MISSING_HOST,
                addr: None,
                cause: None,
            });
        }
    };
    let port = match dst.port() {
        Some(port) => port.as_u16(),
        None => {
            if dst.scheme() == Some(&Scheme::HTTPS) {
                443
            } else {
                80
            }
        }
    };

    Ok((host, port))
}

/// Respect explicit ports in the URI, if none, either
/// keep non `0` ports resolved from a custom dns resolver,
/// or use the default port for the scheme.
fn set_port(addr: &mut SocketAddr, host_port: u16, explicit: bool) {
    if explicit || addr.port() == 0 {
        addr.set_port(host_port)
    };
}

impl HttpInfo {
    /// Get the remote address of the transport used.
    pub fn remote_addr(&self) -> SocketAddr {
        self.remote_addr
    }

    /// Get the local address of the transport used.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
}

pin_project! {
    // Not publicly exported (so missing_docs doesn't trigger).
    //
    // We return this `Future` instead of the `Pin<Box<dyn Future>>` directly
    // so that users don't rely on it fitting in a `Pin<Box<dyn Future>>` slot
    // (and thus we can change the type in the future).
    #[must_use = "futures do nothing unless polled"]
    pub struct HttpConnecting<R, S: TcpConnector> {
        #[pin]
        fut: BoxConnecting<S>,
        _marker: PhantomData<R>,
    }
}

impl<R, S> Future for HttpConnecting<R, S>
where
    R: DnsResolver,
    S: TcpConnector,
{
    type Output = ConnectResult<S>;

    #[inline]
    fn poll(self: Pin<&mut Self>, cx: &mut task::Context<'_>) -> Poll<Self::Output> {
        self.project().fut.poll(cx)
    }
}
