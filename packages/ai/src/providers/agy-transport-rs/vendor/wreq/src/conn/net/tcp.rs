//! TCP connection types and utilities.
//!
//! DNS resolution finishes before this module receives the candidate addresses.
//! For that address list, Happy Eyeballs follows curl's connection strategy:
//! address families are alternated, later attempts are staggered, and the next
//! address starts immediately when no attempt remains active. Up to six attempts
//! are kept in flight, and the first successful connection cancels the rest.
//!
//! `connect_timeout` is one deadline for the complete TCP race instead of a
//! separate timeout for each address. When Happy Eyeballs is disabled, addresses
//! are tried sequentially in resolver order.
//!
//! See [RFC 8305 section 5] and [curl's Happy Eyeballs implementation].
//!
//! [RFC 8305 section 5]: https://www.rfc-editor.org/rfc/rfc8305.html#section-5
//! [curl's Happy Eyeballs implementation]: https://github.com/curl/curl/blob/master/lib/cf-ip-happy.c

#[cfg(feature = "tokio-rt")]
pub mod tokio;

#[cfg(feature = "compio-rt")]
pub mod compio;

use std::{
    collections::VecDeque,
    error::Error as StdError,
    fmt,
    future::Future,
    io,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::{Pin, pin},
    task::{Context, Poll},
    time::Duration,
};

use futures_util::future::Either;
use socket2::TcpKeepalive;

use crate::{
    conn::{Connection, net::SocketBindOptions},
    dns,
    error::BoxError,
};

type BoxConnecting<T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send>>;

const MAX_PARALLEL_CONNECT_ATTEMPTS: usize = 6;

/// A builder for tcp connections.
pub trait TcpConnector: Clone + Send + Sync + 'static {
    /// The underlying stream type.
    type TcpStream: From<socket2::Socket> + Send + Sync + 'static;

    /// The type of connection returned by this builder.
    type Connection: ::tokio::io::AsyncRead
        + ::tokio::io::AsyncWrite
        + Connection
        + Send
        + Unpin
        + 'static;

    /// The type of error returned by this builder.
    type Error: Into<Box<dyn StdError + Send + Sync>>;

    /// The future type returned by this builder.
    type Future: Future<Output = Result<Self::Connection, Self::Error>> + Send + Unpin + 'static;

    /// The future type returned by this builder's sleep.
    type Sleep: Future<Output = ()> + Send + 'static;

    /// Build a connection from the given socket and connect to the address.
    fn connect(&self, socket: Self::TcpStream, addr: SocketAddr) -> Self::Future;

    /// Return a future that sleeps for the given duration.
    fn sleep(&self, duration: Duration) -> Self::Sleep;
}

pub(crate) struct ConnectingTcp<S: TcpConnector> {
    preferred: ConnectingTcpRemote<S>,
    fallback: Option<ConnectingTcpFallback<S>>,
}

struct ConnectingTcpFallback<S: TcpConnector> {
    delay: S::Sleep,
    remote: ConnectingTcpRemote<S>,
}

struct ConnectingTcpRemote<S: TcpConnector> {
    addrs: dns::SocketAddrs,
    connect_timeout: Option<Duration>,
    connector: S,
}

/// Schedules staggered connection attempts for a resolved address list.
///
/// The state owns every active future, so dropping it cancels the remaining
/// attempts.
struct ConnectingTcpState<S: TcpConnector> {
    preferred: ConnectingTcpRemote<S>,
    fallback: Option<ConnectingTcpRemote<S>>,
    initial_delay: Option<S::Sleep>,
    next_fallback: bool,
    happy_eyeballs_timeout: Option<Duration>,
    attempts: VecDeque<ConnectingTcpAttempt<S>>,
    next_attempt_order: usize,
    first_error: Option<(usize, ConnectError)>,
}

/// One active TCP connection attempt and its position in launch order.
struct ConnectingTcpAttempt<S: TcpConnector> {
    addr: SocketAddr,
    order: usize,
    future: S::Future,
}

/// An event that advances the address race.
enum TcpEvent<C> {
    Connected(C),
    AllAttemptsFailed,
    DelayElapsed,
}

impl<S: TcpConnector> ConnectingTcp<S>
where
    S::TcpStream: From<socket2::Socket>,
{
    pub(crate) fn new(remote_addrs: dns::SocketAddrs, config: &TcpOptions, connector: S) -> Self {
        if let Some(fallback_timeout) = config.happy_eyeballs_timeout {
            let (preferred_addrs, fallback_addrs) = remote_addrs.split_by_preference(
                config.socket_bind.ipv4_address,
                config.socket_bind.ipv6_address,
            );
            if fallback_addrs.is_empty() {
                return ConnectingTcp {
                    preferred: ConnectingTcpRemote::new(
                        preferred_addrs,
                        config.connect_timeout,
                        connector,
                    ),
                    fallback: None,
                };
            }

            ConnectingTcp {
                preferred: ConnectingTcpRemote::new(
                    preferred_addrs,
                    config.connect_timeout,
                    connector.clone(),
                ),
                fallback: Some(ConnectingTcpFallback {
                    delay: connector.sleep(fallback_timeout),
                    remote: ConnectingTcpRemote::new(
                        fallback_addrs,
                        config.connect_timeout,
                        connector,
                    ),
                }),
            }
        } else {
            ConnectingTcp {
                preferred: ConnectingTcpRemote::new(
                    remote_addrs,
                    config.connect_timeout,
                    connector,
                ),
                fallback: None,
            }
        }
    }

    /// Connects through the sequential fast path or the staggered address race.
    pub(crate) async fn connect(self, config: &TcpOptions) -> Result<S::Connection, ConnectError> {
        if self.fallback.is_none()
            && (config.happy_eyeballs_timeout.is_none() || self.preferred.addrs.len() <= 1)
        {
            return self.preferred.connect(config).await;
        }

        ConnectingTcpState::new(self, config.happy_eyeballs_timeout)
            .connect(config)
            .await
    }
}

impl<S: TcpConnector> ConnectingTcpRemote<S>
where
    S::TcpStream: From<socket2::Socket>,
{
    fn new(addrs: dns::SocketAddrs, connect_timeout: Option<Duration>, connector: S) -> Self {
        Self {
            addrs,
            connect_timeout,
            connector,
        }
    }

    /// Prepares a connection future for the next address.
    fn connect_next(
        &mut self,
        config: &TcpOptions,
    ) -> Option<(SocketAddr, Result<S::Future, ConnectError>)> {
        let addr = self.addrs.next()?;
        debug!("connecting to {}", addr);
        Some((addr, connect(&addr, config, &self.connector)))
    }

    /// Tries this address list sequentially under one shared deadline.
    async fn connect(mut self, config: &TcpOptions) -> Result<S::Connection, ConnectError> {
        let timeout = self
            .connect_timeout
            .map(|duration| self.connector.sleep(duration));
        connect_with_timeout(self.connect_inner(config), timeout).await
    }

    /// Tries addresses in resolver order until one connects.
    async fn connect_inner(&mut self, config: &TcpOptions) -> Result<S::Connection, ConnectError> {
        let mut first_error = None;

        while let Some((addr, result)) = self.connect_next(config) {
            let result = match result {
                Ok(future) => future.await.map_err(ConnectError::tcp),
                Err(error) => Err(error),
            };

            match result {
                Ok(connection) => {
                    debug!("connected to {}", addr);
                    return Ok(connection);
                }
                Err(error) => {
                    let error = error.with_addr(addr);
                    trace!("connect error for {}: {:?}", addr, error);
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        Err(first_error.unwrap_or_else(ConnectError::network_unreachable))
    }
}

impl<S: TcpConnector> ConnectingTcpState<S>
where
    S::TcpStream: From<socket2::Socket>,
{
    /// Builds the scheduler while preserving the initial fallback delay.
    fn new(connecting: ConnectingTcp<S>, happy_eyeballs_timeout: Option<Duration>) -> Self {
        let (initial_delay, fallback) = match connecting.fallback {
            Some(fallback) => (Some(fallback.delay), Some(fallback.remote)),
            None => (None, None),
        };

        Self {
            preferred: connecting.preferred,
            fallback,
            initial_delay,
            next_fallback: false,
            happy_eyeballs_timeout,
            attempts: VecDeque::with_capacity(MAX_PARALLEL_CONNECT_ATTEMPTS),
            next_attempt_order: 0,
            first_error: None,
        }
    }

    /// Returns whether any resolved address has not been attempted.
    fn has_remaining_addrs(&self) -> bool {
        !self.preferred.addrs.is_empty()
            || self
                .fallback
                .as_ref()
                .is_some_and(|fallback| !fallback.addrs.is_empty())
    }

    /// Alternates address families while both still have candidates.
    fn next_remote(&mut self) -> Option<&mut ConnectingTcpRemote<S>> {
        let has_preferred = !self.preferred.addrs.is_empty();
        let has_fallback = self
            .fallback
            .as_ref()
            .is_some_and(|fallback| !fallback.addrs.is_empty());

        let use_fallback = match (self.next_fallback, has_preferred, has_fallback) {
            (_, false, false) => return None,
            (true, _, true) | (_, false, true) => true,
            _ => false,
        };
        self.next_fallback = !use_fallback;

        if use_fallback {
            self.fallback.as_mut()
        } else {
            Some(&mut self.preferred)
        }
    }

    /// Keeps the error from the earliest failed attempt.
    fn record_error(&mut self, order: usize, error: ConnectError) {
        match &self.first_error {
            Some((first_order, _)) if *first_order <= order => {}
            _ => self.first_error = Some((order, error)),
        }
    }

    /// Starts the next candidate, skipping synchronous socket setup failures.
    fn launch_next(&mut self, config: &TcpOptions) -> bool {
        while let Some(remote) = self.next_remote() {
            let Some((addr, result)) = remote.connect_next(config) else {
                continue;
            };
            let order = self.next_attempt_order;
            self.next_attempt_order = self.next_attempt_order.saturating_add(1);

            match result {
                Ok(future) => {
                    if order != 0 {
                        self.initial_delay = None;
                    }
                    self.attempts.push_back(ConnectingTcpAttempt {
                        addr,
                        order,
                        future,
                    });
                    return true;
                }
                Err(error) => {
                    let error = error.with_addr(addr);
                    trace!("connect error for {}: {:?}", addr, error);
                    self.record_error(order, error);
                }
            }
        }

        false
    }

    /// Polls every active attempt and reports failure only when none remain.
    fn poll_attempts(&mut self, cx: &mut Context<'_>) -> Poll<TcpEvent<S::Connection>> {
        let mut index = 0;
        let mut failed = false;
        while let Some(attempt) = self.attempts.get_mut(index) {
            let addr = attempt.addr;
            let order = attempt.order;
            let result = Pin::new(&mut attempt.future).poll(cx);

            match result {
                Poll::Pending => index += 1,
                Poll::Ready(result) => {
                    let _ = self.attempts.remove(index);
                    match result {
                        Ok(connection) => {
                            debug!("connected to {}", addr);
                            return Poll::Ready(TcpEvent::Connected(connection));
                        }
                        Err(error) => {
                            let error = ConnectError::tcp(error).with_addr(addr);
                            trace!("connect error for {}: {:?}", addr, error);
                            self.record_error(order, error);
                            failed = true;
                        }
                    }
                }
            }
        }

        if failed && self.attempts.is_empty() {
            Poll::Ready(TcpEvent::AllAttemptsFailed)
        } else {
            Poll::Pending
        }
    }

    /// Cancels the oldest attempt when the parallel limit is reached.
    fn make_room_for_next_attempt(&mut self) {
        if self.attempts.len() < MAX_PARALLEL_CONNECT_ATTEMPTS {
            return;
        }

        if let Some(attempt) = self.attempts.pop_front() {
            trace!("canceling stale connection attempt to {}", attempt.addr);
            drop(attempt);
        }
    }

    /// Takes the earliest error or reports that no address was reachable.
    fn take_error(&mut self) -> ConnectError {
        self.first_error
            .take()
            .map(|(_, error)| error)
            .unwrap_or_else(ConnectError::network_unreachable)
    }

    /// Runs the complete address race under one shared deadline.
    async fn connect(mut self, config: &TcpOptions) -> Result<S::Connection, ConnectError> {
        // One deadline covers the complete address race. Dividing it by the
        // number of resolved addresses can make every attempt unusably short.
        let timeout = self
            .preferred
            .connect_timeout
            .map(|duration| self.preferred.connector.sleep(duration));
        connect_with_timeout(self.connect_inner(config), timeout).await
    }

    /// Drives staggered attempts until one connects or all addresses are exhausted.
    async fn connect_inner(&mut self, config: &TcpOptions) -> Result<S::Connection, ConnectError> {
        loop {
            if self.attempts.is_empty() && !self.launch_next(config) {
                return Err(self.take_error());
            }

            // RFC 8305 section 5 starts later addresses after a short delay
            // while earlier attempts remain active.
            // https://www.rfc-editor.org/rfc/rfc8305.html#section-5
            let event = match (self.happy_eyeballs_timeout, self.has_remaining_addrs()) {
                (Some(delay), true) => {
                    let sleep = self
                        .initial_delay
                        .take()
                        .unwrap_or_else(|| self.preferred.connector.sleep(delay));
                    let mut sleep = pin!(sleep);
                    std::future::poll_fn(|cx| match self.poll_attempts(cx) {
                        Poll::Ready(event) => Poll::Ready(event),
                        Poll::Pending => sleep.as_mut().poll(cx).map(|()| TcpEvent::DelayElapsed),
                    })
                    .await
                }
                _ => std::future::poll_fn(|cx| self.poll_attempts(cx)).await,
            };

            match event {
                TcpEvent::Connected(connection) => return Ok(connection),
                TcpEvent::AllAttemptsFailed => {}
                TcpEvent::DelayElapsed => self.make_room_for_next_attempt(),
            }

            self.launch_next(config);
        }
    }
}

/// Applies one optional deadline to a complete connection operation.
async fn connect_with_timeout<C, F, T>(connecting: F, timeout: Option<T>) -> Result<C, ConnectError>
where
    F: Future<Output = Result<C, ConnectError>>,
    T: Future<Output = ()>,
{
    let Some(timeout) = timeout else {
        return connecting.await;
    };

    // Poll the connection first so a result ready at the deadline wins the
    // tie, matching Tokio and Tower timeout semantics.
    match futures_util::future::select(pin!(connecting), pin!(timeout)).await {
        Either::Left((result, _)) => result,
        Either::Right(((), _)) => Err(ConnectError::tcp(io::Error::new(
            io::ErrorKind::TimedOut,
            "connect timeout",
        ))),
    }
}

fn bind_local_address(
    socket: &socket2::Socket,
    dst_addr: &SocketAddr,
    local_addr_ipv4: &Option<Ipv4Addr>,
    local_addr_ipv6: &Option<Ipv6Addr>,
) -> io::Result<()> {
    match (*dst_addr, local_addr_ipv4, local_addr_ipv6) {
        (SocketAddr::V4(_), Some(addr), _) => {
            socket.bind(&SocketAddr::new((*addr).into(), 0).into())?;
        }
        (SocketAddr::V6(_), _, Some(addr)) => {
            socket.bind(&SocketAddr::new((*addr).into(), 0).into())?;
        }
        _ => {
            if cfg!(windows) {
                // Windows requires a socket be bound before calling connect
                let any: SocketAddr = match *dst_addr {
                    SocketAddr::V4(_) => ([0, 0, 0, 0], 0).into(),
                    SocketAddr::V6(_) => ([0, 0, 0, 0, 0, 0, 0, 0], 0).into(),
                };
                socket.bind(&any.into())?;
            }
        }
    }

    Ok(())
}

fn connect<S: TcpConnector>(
    addr: &SocketAddr,
    config: &TcpOptions,
    connector: &S,
) -> Result<S::Future, ConnectError>
where
    S::TcpStream: From<socket2::Socket>,
{
    use socket2::{Domain, Protocol, Socket, Type};

    let domain = Domain::for_address(*addr);
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))
        .map_err(ConnectError::m("tcp open error"))?;

    // When constructing a Tokio `TcpSocket` from a raw fd/socket, the user is
    // responsible for ensuring O_NONBLOCK is set.
    socket
        .set_nonblocking(true)
        .map_err(ConnectError::m("tcp set_nonblocking error"))?;

    if let Some(tcp_keepalive) = &config.tcp_keepalive.into_tcpkeepalive()
        && let Err(_e) = socket.set_tcp_keepalive(tcp_keepalive)
    {
        warn!("tcp set_keepalive error: {_e}");
    }

    // That this only works for some socket types, particularly AF_INET sockets.
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
    if let Some(interface) = &config.socket_bind.interface {
        // On Linux-like systems, set the interface to bind using
        // `SO_BINDTODEVICE`.
        #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
        socket
            .bind_device(Some(interface.as_bytes()))
            .map_err(ConnectError::m("tcp bind interface error"))?;

        // On macOS-like and Solaris-like systems, we instead use `IP_BOUND_IF`.
        // This socket option desires an integer index for the interface, so we
        // must first determine the index of the requested interface name using
        // `if_nametoindex`.
        #[cfg(any(
            target_os = "illumos",
            target_os = "ios",
            target_os = "macos",
            target_os = "solaris",
            target_os = "tvos",
            target_os = "visionos",
            target_os = "watchos",
        ))]
        if let Ok(interface) = std::ffi::CString::new(interface.as_bytes()) {
            #[allow(unsafe_code)]
            let idx = unsafe { libc::if_nametoindex(interface.as_ptr()) };
            let idx = std::num::NonZeroU32::new(idx).ok_or_else(|| {
                // If the index is 0, check errno and return an I/O error.
                ConnectError::new(
                    "error converting interface name to index",
                    io::Error::last_os_error(),
                )
            })?;

            // Different setsockopt calls are necessary depending on whether the
            // address is IPv4 or IPv6.
            match addr {
                SocketAddr::V4(_) => socket.bind_device_by_index_v4(Some(idx)),
                SocketAddr::V6(_) => socket.bind_device_by_index_v6(Some(idx)),
            }
            .map_err(ConnectError::m("tcp bind interface error"))?;
        }
    }

    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    if let Some(tcp_user_timeout) = &config.tcp_user_timeout
        && let Err(_e) = socket.set_tcp_user_timeout(Some(*tcp_user_timeout))
    {
        warn!("tcp set_tcp_user_timeout error: {_e}");
    }

    bind_local_address(
        &socket,
        addr,
        &config.socket_bind.ipv4_address,
        &config.socket_bind.ipv6_address,
    )
    .map_err(ConnectError::m("tcp bind local error"))?;

    if config.reuse_address
        && let Err(_e) = socket.set_reuse_address(true)
    {
        warn!("tcp set_reuse_address error: {_e}");
    }

    if let Some(linger) = config.linger
        && let Err(_e) = socket.set_linger(Some(linger))
    {
        warn!("tcp set_linger error: {_e}");
    }

    if let Some(size) = config.send_buffer_size
        && let Err(_e) = socket.set_send_buffer_size(size)
    {
        warn!("tcp set_buffer_size error: {_e}");
    }

    if let Some(size) = config.recv_buffer_size
        && let Err(_e) = socket.set_recv_buffer_size(size)
    {
        warn!("tcp set_recv_buffer_size error: {_e}");
    }

    if let Err(_e) = socket.set_tcp_nodelay(config.nodelay) {
        warn!("tcp set_tcp_nodelay error: {_e}");
    }

    Ok(connector.connect(socket.into(), *addr))
}

// Not publicly exported (so missing_docs doesn't trigger).
pub struct ConnectError {
    pub(crate) msg: &'static str,
    pub(crate) addr: Option<SocketAddr>,
    pub(crate) cause: Option<BoxError>,
}

impl ConnectError {
    pub(crate) fn new<E>(msg: &'static str, cause: E) -> ConnectError
    where
        E: Into<BoxError>,
    {
        ConnectError {
            msg,
            addr: None,
            cause: Some(cause.into()),
        }
    }

    /// Wraps an error produced while opening a TCP connection.
    fn tcp<E>(cause: E) -> ConnectError
    where
        E: Into<BoxError>,
    {
        ConnectError::new("tcp connect error", cause)
    }

    /// Creates the fallback error used when no address can be attempted.
    fn network_unreachable() -> ConnectError {
        ConnectError::tcp(io::Error::new(
            io::ErrorKind::NotConnected,
            "Network unreachable",
        ))
    }

    pub(crate) fn dns<E>(cause: E) -> ConnectError
    where
        E: Into<BoxError>,
    {
        ConnectError::new("dns error", cause)
    }

    pub(crate) fn m<E>(msg: &'static str) -> impl FnOnce(E) -> ConnectError
    where
        E: Into<BoxError>,
    {
        move |cause| ConnectError::new(msg, cause)
    }

    /// Attaches the address associated with this connection error.
    fn with_addr(mut self, addr: SocketAddr) -> Self {
        self.addr = Some(addr);
        self
    }
}

impl fmt::Debug for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut b = f.debug_tuple("ConnectError");
        b.field(&self.msg);
        if let Some(ref addr) = self.addr {
            b.field(addr);
        }
        if let Some(ref cause) = self.cause {
            b.field(cause);
        }
        b.finish()
    }
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.msg)
    }
}

impl StdError for ConnectError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.cause.as_ref().map(|e| &**e as _)
    }
}

#[derive(Clone)]
pub(crate) struct TcpOptions {
    pub enforce_http: bool,
    pub connect_timeout: Option<Duration>,
    pub happy_eyeballs_timeout: Option<Duration>,
    pub nodelay: bool,
    pub reuse_address: bool,
    pub linger: Option<Duration>,
    pub send_buffer_size: Option<usize>,
    pub recv_buffer_size: Option<usize>,
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    pub tcp_user_timeout: Option<Duration>,
    pub tcp_keepalive: TcpKeepaliveOptions,
    pub socket_bind: SocketBindOptions,
}

#[derive(Default, Debug, Clone, Copy)]
pub(crate) struct TcpKeepaliveOptions {
    pub time: Option<Duration>,
    pub interval: Option<Duration>,
    pub retries: Option<u32>,
}

impl TcpKeepaliveOptions {
    /// Converts into a `socket2::TcpKeealive` if there is any keep alive configuration.
    pub(crate) fn into_tcpkeepalive(self) -> Option<TcpKeepalive> {
        let Self {
            time,
            interval: _interval,
            retries: _retries,
        } = self;

        let mut dirty = false;
        let mut ka = TcpKeepalive::new();
        if let Some(time) = time {
            ka = ka.with_time(time);
            dirty = true
        }

        #[cfg(any(
            target_os = "android",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "fuchsia",
            target_os = "illumos",
            target_os = "ios",
            target_os = "visionos",
            target_os = "linux",
            target_os = "macos",
            target_os = "netbsd",
            target_os = "tvos",
            target_os = "watchos",
            target_os = "windows",
            target_os = "cygwin",
        ))]
        {
            // Set the time between TCP keepalive probes. Some platforms specify
            // this value in seconds, so sub-second values may be omitted.
            if let Some(interval) = _interval {
                dirty = true;
                ka = ka.with_interval(interval)
            };

            // Set how many unanswered probes are sent before dropping the connection.
            if let Some(retries) = _retries {
                dirty = true;
                ka = ka.with_retries(retries)
            };
        }

        if dirty { Some(ka) } else { None }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        net::{Ipv6Addr, SocketAddr},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use super::{
        BoxConnecting, ConnectingTcp, TcpConnector, TcpKeepaliveOptions, TcpOptions,
        connect_with_timeout,
    };
    use crate::{
        conn::{Connected, Connection, net::SocketBindOptions},
        dns,
    };

    #[derive(Default)]
    struct TestState {
        launched: Vec<SocketAddr>,
        active: usize,
        max_active: usize,
    }

    #[derive(Clone)]
    struct TestConnector {
        outcomes: Arc<[(SocketAddr, TestOutcome)]>,
        state: Arc<Mutex<TestState>>,
    }

    #[derive(Clone, Copy)]
    enum TestOutcome {
        Pending,
        SuccessAfter(Duration),
        FailAfter(Duration),
    }

    struct ActiveAttempt(Arc<Mutex<TestState>>);

    impl Drop for ActiveAttempt {
        fn drop(&mut self) {
            let mut state = self.0.lock().unwrap();
            state.active -= 1;
        }
    }

    impl TestConnector {
        fn new(success: SocketAddr) -> Self {
            Self::with_outcomes([(success, TestOutcome::SuccessAfter(Duration::ZERO))])
        }

        fn with_outcomes(outcomes: impl IntoIterator<Item = (SocketAddr, TestOutcome)>) -> Self {
            Self {
                outcomes: outcomes.into_iter().collect::<Vec<_>>().into(),
                state: Arc::new(Mutex::new(TestState::default())),
            }
        }

        fn snapshot(&self) -> (Vec<SocketAddr>, usize, usize) {
            let state = self.state.lock().unwrap();
            (state.launched.clone(), state.active, state.max_active)
        }
    }

    impl TcpConnector for TestConnector {
        type TcpStream = std::net::TcpStream;
        type Connection = ::tokio::io::DuplexStream;
        type Error = io::Error;
        type Future = BoxConnecting<Self::Connection, Self::Error>;
        type Sleep = ::tokio::time::Sleep;

        fn connect(&self, _socket: Self::TcpStream, addr: SocketAddr) -> Self::Future {
            {
                let mut state = self.state.lock().unwrap();
                state.launched.push(addr);
                state.active += 1;
                state.max_active = state.max_active.max(state.active);
            }
            let outcome = self
                .outcomes
                .iter()
                .find_map(|(candidate, outcome)| (*candidate == addr).then_some(*outcome))
                .unwrap_or(TestOutcome::Pending);
            let attempt = ActiveAttempt(self.state.clone());

            Box::pin(async move {
                let _attempt = attempt;
                match outcome {
                    TestOutcome::Pending => std::future::pending().await,
                    TestOutcome::SuccessAfter(delay) => {
                        ::tokio::time::sleep(delay).await;
                        Ok(::tokio::io::duplex(64).0)
                    }
                    TestOutcome::FailAfter(delay) => {
                        ::tokio::time::sleep(delay).await;
                        Err(io::ErrorKind::ConnectionRefused.into())
                    }
                }
            })
        }

        fn sleep(&self, duration: Duration) -> Self::Sleep {
            ::tokio::time::sleep(duration)
        }
    }

    impl Connection for ::tokio::io::DuplexStream {
        fn connected(&self) -> Connected {
            Connected::new()
        }
    }

    fn tcp_options(
        happy_eyeballs_timeout: Option<Duration>,
        connect_timeout: Option<Duration>,
    ) -> TcpOptions {
        TcpOptions {
            enforce_http: false,
            connect_timeout,
            happy_eyeballs_timeout,
            nodelay: false,
            reuse_address: false,
            linger: None,
            send_buffer_size: None,
            recv_buffer_size: None,
            #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
            tcp_user_timeout: None,
            tcp_keepalive: TcpKeepaliveOptions::default(),
            socket_bind: SocketBindOptions::default(),
        }
    }

    fn ipv4(last: u8) -> SocketAddr {
        ([192, 0, 2, last], 443).into()
    }

    fn ipv6(last: u16) -> SocketAddr {
        (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, last), 443).into()
    }

    #[::tokio::test(start_paused = true)]
    async fn races_resolved_addresses_in_order_with_a_bounded_set() {
        let result =
            connect_with_timeout(std::future::ready(Ok(())), Some(std::future::ready(()))).await;
        assert!(
            result.is_ok(),
            "a ready connection should win a timeout tie"
        );

        let delay = Duration::from_millis(100);
        let sequential = [ipv4(1), ipv4(2)];
        let connector = TestConnector::with_outcomes([
            (sequential[0], TestOutcome::FailAfter(delay / 2)),
            (sequential[1], TestOutcome::SuccessAfter(Duration::ZERO)),
        ]);
        let options = tcp_options(None, None);
        let started = ::tokio::time::Instant::now();

        ConnectingTcp::new(
            dns::SocketAddrs::new(sequential.to_vec()),
            &options,
            connector.clone(),
        )
        .connect(&options)
        .await
        .unwrap();

        assert_eq!(started.elapsed(), delay / 2);
        assert_eq!(connector.snapshot(), (sequential.to_vec(), 0, 1));

        let paced = [ipv4(1), ipv4(2), ipv4(3)];
        let connector = TestConnector::with_outcomes([
            (paced[1], TestOutcome::FailAfter(delay / 10)),
            (paced[2], TestOutcome::SuccessAfter(Duration::ZERO)),
        ]);
        let options = tcp_options(Some(delay), None);
        let started = ::tokio::time::Instant::now();

        ConnectingTcp::new(
            dns::SocketAddrs::new(paced.to_vec()),
            &options,
            connector.clone(),
        )
        .connect(&options)
        .await
        .unwrap();

        assert_eq!(started.elapsed(), delay * 2);
        assert_eq!(connector.snapshot(), (paced.to_vec(), 0, 2));

        let v4 = [ipv4(1), ipv4(2), ipv4(3), ipv4(4), ipv4(5), ipv4(6)];
        let v6 = [ipv6(1), ipv6(2)];
        let addrs = [v4.as_slice(), v6.as_slice()].concat();
        let expected = [v4[0], v6[0], v4[1], v6[1], v4[2], v4[3], v4[4], v4[5]];
        let connector = TestConnector::new(v4[5]);
        let started = ::tokio::time::Instant::now();

        ConnectingTcp::new(dns::SocketAddrs::new(addrs), &options, connector.clone())
            .connect(&options)
            .await
            .unwrap();

        assert_eq!(started.elapsed(), delay * 7);
        assert_eq!(connector.snapshot(), (expected.to_vec(), 0, 6));

        let timeout = Duration::from_millis(250);
        let options = tcp_options(Some(delay), Some(timeout));
        let addrs = [ipv4(1), ipv4(2), ipv4(3), ipv4(4)];
        let connector = TestConnector::new(ipv4(255));
        let started = ::tokio::time::Instant::now();

        let error = ConnectingTcp::new(
            dns::SocketAddrs::new(addrs.to_vec()),
            &options,
            connector.clone(),
        )
        .connect(&options)
        .await
        .unwrap_err();

        assert_eq!(started.elapsed(), timeout);
        assert!(
            error
                .cause
                .as_deref()
                .and_then(|cause| cause.downcast_ref::<io::Error>())
                .is_some_and(|cause| cause.kind() == io::ErrorKind::TimedOut)
        );
        assert_eq!(connector.snapshot(), (addrs[..3].to_vec(), 0, 3));
    }
}
