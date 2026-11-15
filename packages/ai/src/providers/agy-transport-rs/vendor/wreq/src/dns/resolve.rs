use std::{
    borrow::Cow,
    collections::HashMap,
    fmt,
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use futures_util::{TryFutureExt, future::MapErr};
use tower::{BoxError, Service};

use crate::error::DnsError;

/// A domain name to resolve into IP addresses.
#[derive(Clone, Hash, Eq, PartialEq)]
pub struct Name {
    host: Box<str>,
}

impl Name {
    /// Creates a new [`Name`] from a string slice.
    #[inline]
    pub fn new(host: Box<str>) -> Name {
        Name { host }
    }

    /// View the hostname as a string slice.
    #[inline]
    pub fn as_str(&self) -> &str {
        &self.host
    }
}

impl From<&str> for Name {
    fn from(value: &str) -> Self {
        Name::new(value.into())
    }
}

impl fmt::Debug for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.host, f)
    }
}

impl fmt::Display for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.host, f)
    }
}

/// Alias for an `Iterator` trait object over `SocketAddr`.
pub type Addrs = Box<dyn Iterator<Item = SocketAddr> + Send>;

/// Alias for the `Future` type returned by a DNS resolver.
pub type Resolving = Pin<Box<dyn Future<Output = Result<Addrs, BoxError>> + Send>>;

/// Trait for customizing DNS resolution in wreq.
pub trait Resolve: Send + Sync {
    /// Performs DNS resolution on a `Name`.
    /// The return type is a future containing an iterator of `SocketAddr`.
    ///
    /// It differs from `tower::Service<Name>` in several ways:
    ///  * It is assumed that `resolve` will always be ready to poll.
    ///  * It does not need a mutable reference to `self`.
    ///  * Since trait objects cannot make use of associated types, it requires wrapping the
    ///    returned `Future` and its contained `Iterator` with `Box`.
    ///
    /// Explicitly specified port in the URI will override any port in the resolved `SocketAddr`s.
    /// Otherwise, port `0` will be replaced by the conventional port for the given scheme (e.g. 80
    /// for http).
    fn resolve(&self, name: Name) -> Resolving;
}

impl_into_shared!(
    /// Trait for converting types into a shared DNS resolver ([`Arc<dyn Resolve>`]).
    ///
    /// Implemented for any [`Resolve`] type, [`Arc<T>`] where `T: Resolve`, and [`Arc<dyn Resolve>`].
    /// Enables ergonomic conversion to a trait object for use in APIs without manual Arc wrapping.
    pub trait IntoResolve => Resolve
);

/// Adapter that wraps a [`Resolve`] trait object to work with Tower's `Service` trait.
///
/// This allows custom DNS resolvers implementing `Resolve` to be used in contexts
/// that expect a `Service<Name>` implementation.
#[derive(Clone)]
pub(crate) struct DynResolver {
    resolver: Arc<dyn Resolve>,
}

impl DynResolver {
    /// Creates a new [`DynResolver`] with the provided resolver.
    pub(crate) fn new(resolver: Arc<dyn Resolve>) -> Self {
        Self { resolver }
    }
}

impl Service<Name> for DynResolver {
    type Response = Addrs;
    type Error = BoxError;
    type Future = MapErr<MapErr<Resolving, fn(BoxError) -> DnsError>, fn(DnsError) -> Self::Error>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, name: Name) -> Self::Future {
        self.resolver
            .resolve(name)
            .map_err(DnsError as _)
            .map_err(Into::into)
    }
}

/// DNS resolver that supports hostname overrides.
///
/// This resolver first checks for manual hostname-to-IP mappings before
/// falling back to the underlying DNS resolver. Useful for testing or
/// bypassing DNS for specific domains.
pub(crate) struct DnsResolverWithOverrides {
    dns_resolver: Arc<dyn Resolve>,
    overrides: Arc<HashMap<Cow<'static, str>, Vec<SocketAddr>>>,
}

impl DnsResolverWithOverrides {
    /// Creates a new [`DnsResolverWithOverrides`] with the provided DNS resolver and overrides.
    pub(crate) fn new(
        dns_resolver: Arc<dyn Resolve>,
        overrides: HashMap<Cow<'static, str>, Vec<SocketAddr>>,
    ) -> Self {
        DnsResolverWithOverrides {
            dns_resolver,
            overrides: Arc::new(overrides),
        }
    }
}

impl Resolve for DnsResolverWithOverrides {
    fn resolve(&self, name: Name) -> Resolving {
        match self.overrides.get(name.as_str()) {
            Some(dest) => {
                let addrs: Addrs = Box::new(dest.clone().into_iter());
                Box::pin(std::future::ready(Ok(addrs)))
            }
            None => self.dns_resolver.resolve(name),
        }
    }
}
