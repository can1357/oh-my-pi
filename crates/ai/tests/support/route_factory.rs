use std::{
	future::{Ready, ready},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll},
	time::SystemTime,
};

use omp_ai::{
	answer::{Answer, AnswerBody, ChatStream, ResponseMeta},
	call::{Call, OperationCall},
	error::Error,
	layer::{
		LayerCall,
		stack::{RouteComposer, RouteProviderService, RouteStackFactory},
	},
	registry::RouteUnavailable,
};
use omp_catalog::{OperationKind, provider::RouteDef, snapshot::Catalog};
use omp_core::sf;
use parking_lot::Mutex;
use tower::Service;

#[derive(Clone, Default)]
pub struct RouteProbe {
	pub readiness_polls: Arc<AtomicUsize>,
	pub calls:           Arc<AtomicUsize>,
	pub called_routes:   Arc<Mutex<Vec<omp_catalog::RouteId>>>,
}

impl RouteComposer for RouteProbe {
	fn compose(
		&self,
		_catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable> {
		Ok(RouteProviderService::new(CountingRoute {
			provider: route.provider.clone(),
			route:    route.id.clone(),
			probe:    self.clone(),
		}))
	}
}

impl RouteStackFactory for RouteProbe {
	fn build(
		&self,
		catalog: &Catalog,
		route: &RouteDef,
	) -> Result<RouteProviderService, RouteUnavailable> {
		self.compose(catalog, route)
	}
}

#[derive(Clone)]
struct CountingRoute {
	provider: omp_catalog::ProviderId,
	route:    omp_catalog::RouteId,
	probe:    RouteProbe,
}

impl Service<LayerCall<Call>> for CountingRoute {
	type Error = Error;
	type Future = Ready<Result<Answer, Error>>;
	type Response = Answer;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.probe.readiness_polls.fetch_add(1, Ordering::SeqCst);
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		self.probe.calls.fetch_add(1, Ordering::SeqCst);
		self.probe.called_routes.lock().push(self.route.clone());
		let LayerCall { payload: call, context } = request;
		if !matches!(&call.operation, OperationCall::Chat(_)) {
			unreachable!("route probe is constructed only for the chat planning test");
		}
		let meta = ResponseMeta {
			request_id:          call.id,
			provider:            self.provider.clone(),
			route:               self.route.clone(),
			model:               call.execution.as_ref().and_then(|plan| plan.model.clone()),
			provider_request_id: Some(sf!("route-probe")),
			created_at:          SystemTime::UNIX_EPOCH,
		};
		let body = AnswerBody::Chat(ChatStream::ordinary(Box::pin(futures::stream::empty())));
		ready(Ok(Answer { meta, receipt: context.receipt(), body }))
	}
}

pub const fn supports_chat(model: &omp_catalog::ModelSpec) -> bool {
	model
		.capabilities
		.operations
		.contains_kind(OperationKind::Chat)
}
