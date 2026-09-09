//! Gateway schema and capability negotiation.

use omp_core::{Str, str::IntoStr};
use omp_proto::gateway::v1::{
	HelloRequest, HelloResponse, gateway_client::GatewayClient, gateway_server::Gateway,
};
use tonic::{Request, Response, Status, transport::Channel};

use crate::Error;

/// Oldest protocol schema understood by this gateway implementation.
pub const MIN_SCHEMA_REV: u32 = 1;

/// Gateway Hello endpoint advertising this server's protocol surface.
#[derive(Clone, Debug)]
pub struct HelloService {
	server_version: Str,
	capabilities:   Vec<Str>,
}

impl HelloService {
	/// Create a Hello endpoint with a server version and advertised
	/// capabilities.
	pub fn new(server_version: impl IntoStr, capabilities: Vec<Str>) -> Self {
		Self { server_version: server_version.into_str(), capabilities }
	}
}

#[tonic::async_trait]
impl Gateway for HelloService {
	#[tracing::instrument(
		level = "debug",
		skip_all,
		fields(rpc.service = "gateway", rpc.method = "hello")
	)]
	async fn hello(
		&self,
		_request: Request<HelloRequest>,
	) -> Result<Response<HelloResponse>, Status> {
		Ok(Response::new(HelloResponse {
			schema_rev:     omp_proto::SCHEMA_REV,
			min_schema_rev: MIN_SCHEMA_REV,
			capabilities:   self.capabilities.iter().map(ToString::to_string).collect(),
			server_version: self.server_version.to_string(),
		}))
	}
}

/// Protocol information negotiated with a remote gateway.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Peer {
	/// Schema revision implemented by the server.
	pub schema_rev:     u32,
	/// Capabilities advertised by the server.
	pub capabilities:   Vec<Str>,
	/// Human-readable server build version.
	pub server_version: Str,
}

impl Peer {
	/// Return whether the server advertised `cap`.
	pub fn has(&self, cap: &str) -> bool {
		self
			.capabilities
			.iter()
			.any(|candidate| candidate.as_str() == cap)
	}
}

/// Perform the mandatory Hello handshake and reject incompatible schema
/// revisions.
#[tracing::instrument(
	level = "debug",
	skip_all,
	fields(rpc.service = "gateway", rpc.method = "hello", client = %client, capability_count = capabilities.len())
)]
pub async fn handshake(
	channel: Channel,
	client: &str,
	capabilities: &[&str],
) -> Result<Peer, Error> {
	handshake_at(channel, client, capabilities, omp_proto::SCHEMA_REV).await
}

async fn handshake_at(
	channel: Channel,
	client: &str,
	capabilities: &[&str],
	client_rev: u32,
) -> Result<Peer, Error> {
	let request = HelloRequest {
		client:       client.to_owned(),
		schema_rev:   client_rev,
		capabilities: capabilities.iter().map(|cap| (*cap).to_owned()).collect(),
	};
	let response = GatewayClient::new(channel)
		.hello(request)
		.await?
		.into_inner();

	if response.schema_rev < client_rev {
		tracing::warn!(
			server_schema_rev = response.schema_rev,
			client_schema_rev = client_rev,
			"RPC handshake rejected an older server schema"
		);
		return Err(Error::SchemaTooOld { server: response.schema_rev, client: client_rev });
	}
	if omp_proto::SCHEMA_REV < response.min_schema_rev {
		tracing::warn!(
			server_min_schema_rev = response.min_schema_rev,
			client_schema_rev = omp_proto::SCHEMA_REV,
			"RPC handshake rejected an unsupported client schema"
		);
		return Err(Error::SchemaUnsupported {
			server_min: response.min_schema_rev,
			client:     omp_proto::SCHEMA_REV,
		});
	}

	tracing::debug!(
		server_schema_rev = response.schema_rev,
		capability_count = response.capabilities.len(),
		"RPC handshake completed"
	);
	Ok(Peer {
		schema_rev:     response.schema_rev,
		capabilities:   response
			.capabilities
			.into_iter()
			.map(IntoStr::into_str)
			.collect(),
		server_version: response.server_version.into_str(),
	})
}

#[cfg(test)]
mod tests {
	use std::path::{Path, PathBuf};

	use omp_core::IntoStr;
	use omp_proto::gateway::v1::gateway_server::GatewayServer;
	use tempfile::TempDir;
	use tonic::transport::Server;
	use tonic_health::pb::{
		HealthCheckRequest, health_check_response::ServingStatus, health_client::HealthClient,
	};

	use super::*;
	use crate::{health_service, uds};

	async fn serve(path: &Path) {
		let incoming = uds::listen(path).await.expect("test UDS should bind");
		let (reporter, health) = health_service();
		reporter.set_serving::<GatewayServer<HelloService>>().await;
		let hello =
			HelloService::new("test-server", vec!["inference.turn".into_str(), "blob.v1".into_str()]);
		tokio::spawn(async move {
			Server::builder()
				.add_service(health)
				.add_service(GatewayServer::new(hello))
				.serve_with_incoming(incoming)
				.await
				.expect("test server should run");
		});
	}

	fn socket(tempdir: &TempDir) -> PathBuf {
		tempdir.path().join("rpc.sock")
	}

	#[tokio::test]
	async fn handshake_reports_server_capabilities() {
		let tempdir = tempfile::tempdir().expect("temporary directory should be created");
		let socket = socket(&tempdir);
		serve(&socket).await;
		let channel = uds::connect(&socket).await.expect("client should connect");
		let peer = handshake(channel, "test-client", &["inference.turn"])
			.await
			.expect("matching revisions should negotiate");

		assert_eq!(peer.schema_rev, omp_proto::SCHEMA_REV);
		assert_eq!(peer.server_version.as_str(), "test-server");
		assert!(peer.has("inference.turn"));
		assert!(peer.has("blob.v1"));
		assert!(!peer.has("search"));
	}

	#[tokio::test]
	async fn rejects_server_older_than_client() {
		let tempdir = tempfile::tempdir().expect("temporary directory should be created");
		let socket = socket(&tempdir);
		serve(&socket).await;
		let channel = uds::connect(&socket).await.expect("client should connect");
		let client_rev = omp_proto::SCHEMA_REV + 1;
		let error = handshake_at(channel, "new-client", &[], client_rev)
			.await
			.expect_err("newer client must reject this server");

		assert!(matches!(
			error,
			Error::SchemaTooOld { server, client }
				if server == omp_proto::SCHEMA_REV && client == client_rev
		));
	}

	#[tokio::test]
	async fn standard_health_check_is_serving() {
		let tempdir = tempfile::tempdir().expect("temporary directory should be created");
		let socket = socket(&tempdir);
		serve(&socket).await;
		let channel = uds::connect(&socket).await.expect("client should connect");
		let response = HealthClient::new(channel)
			.check(HealthCheckRequest { service: String::new() })
			.await
			.expect("health check should succeed")
			.into_inner();

		assert_eq!(response.status, ServingStatus::Serving as i32);
	}
}
