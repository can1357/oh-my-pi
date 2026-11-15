//! Network connection types and utilities.

pub(super) mod tcp;

if_any_rt!(
    mod io;
    #[cfg(unix)]
    mod uds;
);

if_all_rt! {
    pub use tcp::tokio::TcpConnector;
    #[cfg(unix)]
    pub use uds::tokio::UnixConnector;
}

if_tokio_rt! {
    pub use tcp::tokio::TcpConnector;
    #[cfg(unix)]
    pub use uds::tokio::UnixConnector;
}

if_compio_rt! {
    pub use tcp::compio::TcpConnector;
    #[cfg(unix)]
    pub use uds::compio::UnixConnector;
}

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Options for configuring socket bind behavior for outbound connections.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Default)]
pub(crate) struct SocketBindOptions {
    #[cfg(any(
        target_os = "illumos",
        target_os = "ios",
        target_os = "macos",
        target_os = "solaris",
        target_os = "tvos",
        target_os = "visionos",
        target_os = "watchos",
        target_os = "android",
        target_os = "fuchsia",
        target_os = "linux",
    ))]
    pub interface: Option<std::borrow::Cow<'static, str>>,
    pub ipv4_address: Option<Ipv4Addr>,
    pub ipv6_address: Option<Ipv6Addr>,
}

impl SocketBindOptions {
    /// Sets the name of the network interface to bind the socket to.
    ///
    /// ## Platform behavior
    /// - On Linux/Fuchsia/Android: sets `SO_BINDTODEVICE`
    /// - On macOS/illumos/Solaris/iOS/etc.: sets `IP_BOUND_IF`
    ///
    /// If `interface` is `None`, the socket will not be explicitly bound to any device.
    ///
    /// # Errors
    ///
    /// On platforms that require a `CString` (e.g. macOS), this will return an error if the
    /// interface name contains an internal null byte (`\0`), which is invalid in C strings.
    ///
    /// # See Also
    /// - [VRF documentation](https://www.kernel.org/doc/Documentation/networking/vrf.txt)
    /// - [`man 7 socket`](https://man7.org/linux/man-pages/man7/socket.7.html)
    /// - [`man 7p ip`](https://docs.oracle.com/cd/E86824_01/html/E54777/ip-7p.html)
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
    #[inline]
    pub fn set_interface<I>(&mut self, interface: I) -> &mut Self
    where
        I: Into<std::borrow::Cow<'static, str>>,
    {
        self.interface = Some(interface.into());
        self
    }

    /// Set that all sockets are bound to the configured address before connection.
    ///
    /// If `None`, the sockets will not be bound.
    ///
    /// Default is `None`.
    #[inline]
    pub fn set_local_address<V>(&mut self, local_address: V)
    where
        V: Into<Option<IpAddr>>,
    {
        match local_address.into() {
            Some(IpAddr::V4(a)) => {
                self.ipv4_address = Some(a);
            }
            Some(IpAddr::V6(a)) => {
                self.ipv6_address = Some(a);
            }
            _ => {}
        };
    }

    /// Set that all sockets are bound to the configured IPv4 or IPv6 address (depending on host's
    /// preferences) before connection.
    ///
    /// If `None`, the sockets will not be bound.
    ///
    /// Default is `None`.
    #[inline]
    pub fn set_local_addresses<V4, V6>(&mut self, ipv4_address: V4, ipv6_address: V6)
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>,
    {
        if let Some(addr) = ipv4_address.into() {
            self.ipv4_address = Some(addr);
        }
        if let Some(addr) = ipv6_address.into() {
            self.ipv6_address = Some(addr);
        }
    }
}
