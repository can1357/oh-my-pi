//! DNS resolution via the [hickory-resolver](https://github.com/hickory-dns/hickory-dns) crate

use std::{net::SocketAddr, sync::LazyLock};

use hickory_resolver::{
    TokioResolver,
    config::{self, LookupIpStrategy, ResolverConfig},
    net::runtime::TokioRuntimeProvider,
};

use super::{Addrs, Name, Resolve, Resolving};

/// Wrapper around an [`TokioResolver`], which implements the `Resolve` trait.
#[derive(Debug, Clone)]
pub struct HickoryDnsResolver {
    /// Shared, lazily-initialized Tokio-based DNS resolver.
    ///
    /// Backed by [`LazyLock`] to guarantee thread-safe, one-time creation.
    /// On initialization, it attempts to load the system's DNS configuration;
    /// if unavailable, it falls back to sensible default settings.
    resolver: &'static LazyLock<TokioResolver>,
}

impl HickoryDnsResolver {
    /// Create a new resolver with the default configuration,
    /// which reads from `/etc/resolve.conf`. The options are
    /// overridden to look up both IPv4 and IPv6 addresses
    /// to support the "happy eyeballs" algorithm.
    ///
    /// SAFETY: `build` only fails if DNS-over-TLS is enabled and default TLS config creation fails.
    pub fn new() -> HickoryDnsResolver {
        static RESOLVER: LazyLock<TokioResolver> = LazyLock::new(|| {
            let mut builder = match TokioResolver::builder_tokio() {
                Ok(resolver) => {
                    debug!("using system DNS configuration");
                    resolver
                }
                Err(_err) => {
                    debug!("error reading DNS system conf: {}, using defaults", _err);
                    TokioResolver::builder_with_config(
                        ResolverConfig::udp_and_tcp(&config::GOOGLE),
                        TokioRuntimeProvider::default(),
                    )
                }
            };
            builder.options_mut().ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
            builder.build().expect("failed to create DNS resolver")
        });

        HickoryDnsResolver {
            resolver: &RESOLVER,
        }
    }
}

impl Resolve for HickoryDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let resolver = self.clone();
        Box::pin(async move {
            let lookup = resolver.resolver.lookup_ip(name.as_str()).await?;
            let addrs: Addrs = Box::new(
                lookup
                    .iter()
                    .map(|ip_addr| SocketAddr::new(ip_addr, 0))
                    .collect::<Vec<_>>()
                    .into_iter(),
            );
            Ok(addrs)
        })
    }
}
