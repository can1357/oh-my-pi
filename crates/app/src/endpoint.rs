//! Owner-local and bearer-authenticated TCP OMP daemon endpoints.
use std::{
	fmt::{self, Display},
	net::{AddrParseError, SocketAddr},
	path::{Path, PathBuf},
	str::FromStr,
};

use omp_core::Str;
use tonic::{transport, transport::Channel};

/// RPC endpoint represented by an owner-local socket/pipe or authenticated TCP.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalEndpoint {
	/// Unix-domain socket path or Windows named-pipe name.
	Local(PathBuf),
	/// TCP listener address. Production TCP listeners require bearer auth.
	Tcp(SocketAddr),
}

impl LocalEndpoint {
	/// Creates a TCP endpoint.
	pub const fn tcp(address: SocketAddr) -> Self {
		Self::Tcp(address)
	}

	/// Borrows the operating-system endpoint path.
	///
	/// # Panics
	///
	/// Panics when called for a TCP endpoint.
	pub fn as_path(&self) -> &Path {
		match self {
			Self::Local(path) => path,
			Self::Tcp(_) => panic!("TCP endpoint has no filesystem path"),
		}
	}

	/// Returns the TCP address, if this endpoint uses TCP.
	pub const fn as_tcp_addr(&self) -> Option<SocketAddr> {
		match self {
			Self::Local(_) => None,
			Self::Tcp(address) => Some(*address),
		}
	}

	/// Connects to either supported endpoint transport.
	#[tracing::instrument(
		name = "endpoint_connect",
		level = "debug",
		skip_all,
		fields(endpoint = %self)
	)]
	pub async fn connect(&self) -> Result<Channel, EndpointConnectError> {
		match self {
			Self::Local(path) => omp_rpc::uds::connect(path)
				.await
				.map_err(EndpointConnectError::Local),
			Self::Tcp(address) => transport::Endpoint::from_shared(format!("http://{address}"))
				.map_err(EndpointConnectError::Uri)?
				.connect()
				.await
				.map_err(EndpointConnectError::Tcp),
		}
	}
}

impl From<PathBuf> for LocalEndpoint {
	fn from(path: PathBuf) -> Self {
		Self::Local(path)
	}
}

impl Display for LocalEndpoint {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Local(path) => path.display().fmt(formatter),
			Self::Tcp(address) => write!(formatter, "tcp://{address}"),
		}
	}
}

/// A local endpoint could not be parsed.
#[derive(Clone, Debug, thiserror::Error)]
pub enum EndpointParseError {
	/// A filesystem endpoint was empty.
	#[error("local OMP endpoint cannot be empty")]
	Empty,
	/// A `tcp://` endpoint did not contain a valid socket address.
	#[error("OMP TCP endpoint address is invalid")]
	InvalidTcp(#[source] AddrParseError),
}

/// Connecting to a local or TCP endpoint failed.
#[derive(Debug, thiserror::Error)]
pub enum EndpointConnectError {
	/// Owner-local transport connection failed.
	#[error("could not connect to owner-local OMP endpoint")]
	Local(#[source] omp_rpc::Error),
	/// TCP endpoint URI construction failed.
	#[error("OMP TCP endpoint URI is invalid")]
	Uri(#[source] transport::Error),
	/// TCP transport connection failed.
	#[error("could not connect to OMP TCP endpoint")]
	Tcp(#[source] transport::Error),
}

impl FromStr for LocalEndpoint {
	type Err = EndpointParseError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		if value.is_empty() {
			return Err(EndpointParseError::Empty);
		}
		if let Some(address) = value.strip_prefix("tcp://") {
			return address
				.parse()
				.map(Self::Tcp)
				.map_err(EndpointParseError::InvalidTcp);
		}
		if let Some(name) = value.strip_prefix("npipe://./pipe/") {
			#[cfg(windows)]
			return Ok(Self::Local(PathBuf::from(format!(r"\\.\pipe\{name}"))));
			#[cfg(not(windows))]
			return Ok(Self::Local(PathBuf::from(name)));
		}
		Ok(Self::Local(PathBuf::from(value)))
	}
}

impl From<&Path> for LocalEndpoint {
	fn from(path: &Path) -> Self {
		Self::Local(path.to_owned())
	}
}

impl From<Str> for LocalEndpoint {
	fn from(value: Str) -> Self {
		Self::Local(PathBuf::from(value.as_str()))
	}
}
#[cfg(test)]
mod tests {
	use std::net::{IpAddr, Ipv4Addr, SocketAddr};

	use super::LocalEndpoint;

	#[test]
	fn tcp_uri_round_trips_as_typed_endpoint() {
		let endpoint: LocalEndpoint = "tcp://127.0.0.1:4000".parse().expect("TCP endpoint");
		assert_eq!(
			endpoint.as_tcp_addr(),
			Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4000)),
		);
		assert_eq!(endpoint.to_string(), "tcp://127.0.0.1:4000");
	}
}
