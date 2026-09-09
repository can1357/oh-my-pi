//! Active endpoint discovery, restart-safe caching, and account catalog
//! merging.

pub mod accounts;
pub mod endpoints;
pub mod probe;
pub mod store;

pub use accounts::{AccountCatalog, AccountDiscoveredModel, merge_account_catalogs};
pub use endpoints::{
	DiscoveryEndpoint, DiscoveryEndpointKind, EndpointError, EndpointOrigin, configured_endpoint,
	configured_endpoint_with_options, known_loopback_endpoints,
};
pub use probe::{
	DiscoveryHttpClient, DiscoveryProbe, ProbeError, ProbeHttpFuture, ProbeHttpRequest,
	ProbeTransportError, ProxyDiscoveryRoutes,
};
pub use store::{
	CachedDiscovery, DiscoveryCacheKey, DiscoveryStore, DiscoveryStoreError, ProviderDiscoveryState,
	ProviderLifecycle,
};
