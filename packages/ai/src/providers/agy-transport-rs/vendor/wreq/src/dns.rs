//! DNS resolution

use std::{
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6},
    vec,
};

mod gai;
mod resolve;

#[cfg(feature = "hickory-dns")]
pub(crate) mod hickory;

pub use self::resolve::{Addrs, IntoResolve, Name, Resolve, Resolving};
pub(crate) use self::{
    gai::GaiResolver,
    resolve::{DnsResolverWithOverrides, DynResolver},
    sealed::{DnsResolver, resolve},
};

/// A wrapper around `Vec<SocketAddr>` to implement the `Iterator` trait.
pub(crate) struct SocketAddrs {
    iter: vec::IntoIter<SocketAddr>,
}

impl SocketAddrs {
    pub(crate) fn new(addrs: Vec<SocketAddr>) -> Self {
        SocketAddrs {
            iter: addrs.into_iter(),
        }
    }

    pub(crate) fn try_parse(host: &str, port: u16) -> Option<SocketAddrs> {
        if let Ok(addr) = host.parse::<Ipv4Addr>() {
            let addr = SocketAddrV4::new(addr, port);
            return Some(SocketAddrs {
                iter: vec![SocketAddr::V4(addr)].into_iter(),
            });
        }
        if let Ok(addr) = host.parse::<Ipv6Addr>() {
            let addr = SocketAddrV6::new(addr, port, 0, 0);
            return Some(SocketAddrs {
                iter: vec![SocketAddr::V6(addr)].into_iter(),
            });
        }
        None
    }

    pub(crate) fn split_by_preference(
        self,
        local_addr_ipv4: Option<Ipv4Addr>,
        local_addr_ipv6: Option<Ipv6Addr>,
    ) -> (SocketAddrs, SocketAddrs) {
        match (local_addr_ipv4, local_addr_ipv6) {
            (Some(_), None) => (self.filter(SocketAddr::is_ipv4), SocketAddrs::new(vec![])),
            (None, Some(_)) => (self.filter(SocketAddr::is_ipv6), SocketAddrs::new(vec![])),
            _ => {
                let preferring_v6 = self
                    .iter
                    .as_slice()
                    .first()
                    .map(SocketAddr::is_ipv6)
                    .unwrap_or(false);

                let (preferred, fallback) = self
                    .iter
                    .partition::<Vec<_>, _>(|addr| addr.is_ipv6() == preferring_v6);

                (SocketAddrs::new(preferred), SocketAddrs::new(fallback))
            }
        }
    }

    #[inline]
    fn filter(self, predicate: impl FnMut(&SocketAddr) -> bool) -> SocketAddrs {
        SocketAddrs::new(self.iter.filter(predicate).collect())
    }

    #[inline]
    pub(crate) fn is_empty(&self) -> bool {
        self.iter.as_slice().is_empty()
    }

    #[inline]
    pub(crate) fn len(&self) -> usize {
        self.iter.as_slice().len()
    }
}

impl Iterator for SocketAddrs {
    type Item = SocketAddr;
    #[inline]
    fn next(&mut self) -> Option<SocketAddr> {
        self.iter.next()
    }
}

mod sealed {
    use std::{
        future::Future,
        net::SocketAddr,
        task::{self, Poll},
    };

    use tower::{BoxError, Service};

    use super::Name;

    /// Internal adapter trait for DNS resolvers.
    ///
    /// This trait provides a unified interface for different resolver implementations,
    /// allowing both custom [`super::Resolve`] types and Tower [`Service`] implementations
    /// to be used interchangeably within the connector.
    pub trait DnsResolver {
        type Addrs: Iterator<Item = SocketAddr>;
        type Error: Into<BoxError>;
        type Future: Future<Output = Result<Self::Addrs, Self::Error>>;

        fn poll_ready(&mut self, cx: &mut task::Context<'_>) -> Poll<Result<(), Self::Error>>;
        fn resolve(&mut self, name: Name) -> Self::Future;
    }

    /// Automatic implementation for any Tower [`Service`] that resolves names to socket addresses.
    impl<S> DnsResolver for S
    where
        S: Service<Name>,
        S::Response: Iterator<Item = SocketAddr>,
        S::Error: Into<BoxError>,
    {
        type Addrs = S::Response;
        type Error = S::Error;
        type Future = S::Future;

        fn poll_ready(&mut self, cx: &mut task::Context<'_>) -> Poll<Result<(), Self::Error>> {
            Service::poll_ready(self, cx)
        }

        fn resolve(&mut self, name: Name) -> Self::Future {
            Service::call(self, name)
        }
    }

    pub async fn resolve<R>(resolver: &mut R, name: Name) -> Result<R::Addrs, R::Error>
    where
        R: DnsResolver,
    {
        std::future::poll_fn(|cx| resolver.poll_ready(cx)).await?;
        resolver.resolve(name).await
    }
}
