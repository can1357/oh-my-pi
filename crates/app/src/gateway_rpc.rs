//! Bearer-gated gateway projection over inference-owned native HTTP dispatch.

use omp_proto::{
	gateway::v1::{ForwardRequest, forward_proxy_server::ForwardProxy},
	inference::v1::{NativeChunk, inference_server::Inference},
};
use omp_serve::inference::InferenceRpc;
use tonic::{Request, Response, Status};

/// Credential-free forward-proxy surface backed by the canonical inference RPC.
#[derive(Clone)]
pub struct GatewayRpc {
	inference: InferenceRpc,
}

impl GatewayRpc {
	/// Wraps the inference service that owns routing, credentials, and HTTP I/O.
	pub const fn new(inference: InferenceRpc) -> Self {
		Self { inference }
	}
}

#[tonic::async_trait]
impl ForwardProxy for GatewayRpc {
	type ForwardStream = <InferenceRpc as Inference>::NativeStream;

	#[tracing::instrument(
		name = "gateway_request",
		level = "debug",
		skip_all,
		fields(method = "gateway.forward")
	)]
	async fn forward(
		&self,
		request: Request<ForwardRequest>,
	) -> Result<Response<Self::ForwardStream>, Status> {
		let request = request
			.into_inner()
			.request
			.ok_or_else(|| Status::invalid_argument("ForwardRequest.request is required"))?;
		Inference::native(&self.inference, Request::new(request)).await
	}
}

const _: fn(NativeChunk) = |chunk| {
	// The response schema deliberately has no generic header map, so sensitive
	// upstream Authorization, Cookie, or Set-Cookie values cannot cross back to
	// the client.
	let _ = chunk;
};
#[cfg(test)]
mod tests {
	use bytes::Bytes;

	use super::NativeChunk;

	#[test]
	fn forward_response_schema_has_no_credential_header_surface() {
		let chunk = NativeChunk {
			status:              200,
			media_type:          "application/json".to_owned(),
			provider_request_id: "request-1".to_owned(),
			data:                Bytes::from_static(b"{}"),
			r#final:             true,
		};
		let value = serde_json::to_value(chunk).expect("serialize native chunk");
		let object = value.as_object().expect("chunk object");
		assert!(!object.contains_key("headers"));
		assert!(!object.contains_key("authorization"));
		assert!(!object.contains_key("cookie"));
		assert!(!object.contains_key("set_cookie"));
	}
}
