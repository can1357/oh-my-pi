//! Pure canonical-to-wire encoding after rate reservation and before
//! credentials.

use std::{
	future,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, SystemTime},
};

use omp_core::{Hash32, Str, sf};
use parking_lot::Mutex;
use tokio::time;
use tower::{Layer, Service};

use crate::{
	auth::{AuthScheme, AuthSpec, CredentialLease, lease::AppliedCredentials},
	body::BodySource,
	codec::{BeforeRequestMutation, Cancellation, ProviderSignHookRequest, TransportRequest},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	layer::{
		ExecutionContext, LayerCall,
		auth::Authorized,
		hook::{HookHandle, NoHookHandle},
	},
	receipt::ReasonId,
};

/// Pure construction-time codec binding for a planned request.
pub trait AttemptEncoder<R, L>: Clone + Send + 'static {
	/// Runs the session-scoped request gate against a bounded typed draft.
	///
	/// The default is allocation-free for route stacks without a provider hook.
	fn before_request(
		&self,
		_request: &mut R,
		_execution: &ExecutionContext,
	) -> impl Future<Output = Result<BeforeRequestMutation, Error>> + Send {
		future::ready(Ok(BeforeRequestMutation::default()))
	}

	/// Encodes with a fresh body source and decoder; it must not acquire
	/// credentials or perform I/O.
	fn encode(
		&self,
		request: &R,
		lease: &L,
		mutation: &BeforeRequestMutation,
		execution: &ExecutionContext,
		attempt: u32,
		provisional: bool,
		cancel: Cancellation,
	) -> Result<TransportRequest, Error>;
}

/// Fully encoded transport request paired with the still-opaque credential
/// lease.
pub struct EncodedAttempt<A, L> {
	/// Non-secret selected account metadata.
	pub account:      A,
	/// Secret-free encoded transport request.
	pub transport:    TransportRequest,
	/// Opaque lease consumed only by credential application.
	pub(crate) lease: L,
}

/// Adds pure codec lowering.
#[derive(Clone, Debug)]
pub struct EncodeLayer<E, H = NoHookHandle> {
	encoder:     E,
	hook:        Option<H>,
	provisional: bool,
}
impl<E> EncodeLayer<E, NoHookHandle> {
	/// Creates an encoding layer for visible or transactionally provisional
	/// attempts without a cold-path hook subscription.
	pub const fn new(encoder: E, provisional: bool) -> Self {
		Self { encoder, hook: None, provisional }
	}
}
impl<E> EncodeLayer<E, NoHookHandle> {
	/// Attaches the concrete hook dispatcher to this route stack.
	pub fn with_hook<T: HookHandle>(self, hook: T) -> EncodeLayer<E, T> {
		EncodeLayer {
			encoder:     self.encoder,
			hook:        Some(hook),
			provisional: self.provisional,
		}
	}
}
/// Encoding service.
#[derive(Clone, Debug)]
pub struct EncodeService<S, E, H = NoHookHandle> {
	inner:       Arc<Mutex<S>>,
	encoder:     E,
	hook:        Option<H>,
	provisional: bool,
}
impl<S, E: Clone, H: Clone> Layer<S> for EncodeLayer<E, H> {
	type Service = EncodeService<S, E, H>;

	fn layer(&self, inner: S) -> Self::Service {
		EncodeService {
			inner:       Arc::new(Mutex::new(inner)),
			encoder:     self.encoder.clone(),
			hook:        self.hook.clone(),
			provisional: self.provisional,
		}
	}
}
impl<S, E, R, A, L, H> Service<LayerCall<Authorized<R, A, L>>> for EncodeService<S, E, H>
where
	R: Send,
	A: Send,
	L: Send,
	E: AttemptEncoder<R, L>,
	H: HookHandle,
	S: Service<LayerCall<EncodedAttempt<A, L>>, Error = Error> + Send,
	S::Future: Send,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>> + Send;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.lock().poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<Authorized<R, A, L>>) -> Self::Future {
		let Authorized { request: mut planned, account, lease } = request.payload;
		let attempt = request.context.attempts().saturating_sub(1);
		let context = request.context;
		let hook = self.hook.clone();
		let encoder = self.encoder.clone();
		let provisional = self.provisional;
		let cancel = Cancellation::default();
		context.register_transport_cancel(cancel.clone());
		let inner = Arc::clone(&self.inner);
		async move {
			context.checkpoint(ErrorPhase::Encoding)?;
			// This legacy route-scoped escape hatch is fail-open. The
			// session-scoped gate below preserves explicit Deny.
			if let Some(hook) = hook {
				let _ = hook.before_request(&context).await;
			}
			let mutation = encoder.before_request(&mut planned, &context).await?;
			let transport =
				encoder.encode(&planned, &lease, &mutation, &context, attempt, provisional, cancel)?;
			let future = {
				let mut service = inner.lock();
				let future = service
					.call(LayerCall { payload: EncodedAttempt { account, transport, lease }, context });
				drop(service);
				future
			};
			future.await
		}
	}
}

/// Applies an opaque lease to a fully encoded request without exposing secret
/// bytes.
pub trait CredentialApplier<A, L>: Clone + Send + 'static {
	/// Applies headers/query/signing metadata or returns a typed authentication
	/// error.
	fn apply(
		&self,
		account: &A,
		lease: L,
		request: &mut TransportRequest,
		context: &ExecutionContext,
	) -> Result<(), Error>;

	/// Refines a wire failure using the non-secret authentication scheme
	/// selected for the attempt.
	fn map_response_error(&self, _scheme: Option<AuthScheme>, error: Error) -> Error {
		error
	}
}

/// Attaches an auth-owned opaque credential envelope without materializing
/// secrets.
#[derive(Clone, Copy, Debug, Default)]
pub struct AttachCredentials;
impl<A> CredentialApplier<A, AppliedCredentials> for AttachCredentials {
	fn apply(
		&self,
		_: &A,
		credentials: AppliedCredentials,
		request: &mut TransportRequest,
		_: &ExecutionContext,
	) -> Result<(), Error> {
		request.credentials = Some(credentials);
		Ok(())
	}
}

/// Prepares a raw opaque lease against one route's exact authentication spec.
#[derive(Clone, Debug)]
pub struct PrepareCredentials {
	spec: AuthSpec,
}

impl PrepareCredentials {
	/// Creates a route-scoped credential adapter.
	pub const fn new(spec: AuthSpec) -> Self {
		Self { spec }
	}
}

impl<A> CredentialApplier<A, CredentialLease> for PrepareCredentials {
	fn apply(
		&self,
		_: &A,
		lease: CredentialLease,
		request: &mut TransportRequest,
		context: &ExecutionContext,
	) -> Result<(), Error> {
		let credentials = lease
			.prepare(&self.spec, SystemTime::now())
			.map_err(|_| credential_prepare_error(context))?;
		request.credentials = Some(credentials);
		Ok(())
	}
}

fn credential_prepare_error(context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!("credential-application-contract"))))
}

/// Adds credential application at the last boundary before wire transport.
#[derive(Clone, Debug)]
pub struct CredentialApplyLayer<P, H = NoHookHandle> {
	applier: P,
	hook:    Option<H>,
}
impl<P> CredentialApplyLayer<P, NoHookHandle> {
	/// Creates a credential application layer without a signing hook.
	pub const fn new(applier: P) -> Self {
		Self { applier, hook: None }
	}
}
impl<P> CredentialApplyLayer<P, NoHookHandle> {
	/// Attaches the concrete hook dispatcher for per-attempt provider signing.
	pub fn with_hook<T: HookHandle>(self, hook: T) -> CredentialApplyLayer<P, T> {
		CredentialApplyLayer { applier: self.applier, hook: Some(hook) }
	}
}
/// Credential-finalizing service.
#[derive(Clone, Debug)]
pub struct CredentialApplyService<S, P, H = NoHookHandle> {
	inner:   Arc<Mutex<S>>,
	applier: P,
	hook:    Option<H>,
}
impl<S, P: Clone, H: Clone> Layer<S> for CredentialApplyLayer<P, H> {
	type Service = CredentialApplyService<S, P, H>;

	fn layer(&self, inner: S) -> Self::Service {
		CredentialApplyService {
			inner:   Arc::new(Mutex::new(inner)),
			applier: self.applier.clone(),
			hook:    self.hook.clone(),
		}
	}
}
impl<S, P, A, L, H> Service<LayerCall<EncodedAttempt<A, L>>> for CredentialApplyService<S, P, H>
where
	A: Send,
	L: Send,
	H: HookHandle,
	P: CredentialApplier<A, L>,
	S: Service<TransportRequest, Error = Error> + Send,
	S::Future: Send,
{
	type Error = Error;
	type Response = S::Response;

	type Future = impl Future<Output = Result<S::Response, Error>> + Send;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.lock().poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<EncodedAttempt<A, L>>) -> Self::Future {
		let EncodedAttempt { account, mut transport, lease } = request.payload;
		let context = request.context;
		let hook = self.hook.clone();
		let applier = self.applier.clone();
		let applied = context
			.checkpoint(ErrorPhase::Authentication)
			.and_then(|()| {
				self
					.applier
					.apply(&account, lease, &mut transport, &context)
			});
		let future = applied.map(|()| {
			let inner = Arc::clone(&self.inner);
			async move {
				if transport
					.response_hooks
					.provider_sign_subscribed(&transport.attempt.provider)
				{
					let BodySource::Bytes(body) = &transport.encoded.body else {
						return Err(provider_sign_failed(&context, "provider-sign-body-not-buffered"));
					};
					let method: &'static str = transport.encoded.method.into();
					let request = ProviderSignHookRequest {
						provider:    transport.attempt.provider.clone(),
						route:       transport.attempt.route.clone(),
						method:      Str::new_static(method),
						url:         transport.encoded.uri.clone(),
						headers:     transport.encoded.headers.clone(),
						body_sha256: Hash32::sum(body).into_bytes(),
					};
					let budget = Duration::from_millis(250);
					match time::timeout(budget, transport.response_hooks.provider_sign(request)).await {
						Ok(Ok(signature)) => transport.signature = Some(signature),
						Ok(Err(_)) => {
							return Err(provider_sign_failed(&context, "provider-sign-hook-failed"));
						},
						Err(_) => return Err(provider_sign_timeout(&context, budget)),
					}
				}
				if let Some(hook) = hook {
					let budget = hook.sign_budget();
					match time::timeout(budget, hook.provider_sign(&transport, &context)).await {
						Ok(Ok(())) => {},
						Ok(Err(error)) => return Err(error),
						Err(_) => return Err(provider_sign_timeout(&context, budget)),
					}
				}
				let auth_scheme = transport
					.credentials
					.as_ref()
					.map(AppliedCredentials::scheme);
				let future = {
					let mut service = inner.lock();
					let future = service.call(transport);
					drop(service);
					future
				};
				future
					.await
					.map_err(|error| applier.map_response_error(auth_scheme, error))
			}
		});
		async move { future?.await }
	}
}

fn provider_sign_failed(context: &ExecutionContext, reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::target(sf!(reason)))
}

fn provider_sign_timeout(context: &ExecutionContext, budget: Duration) -> Error {
	context.record_sign_budget_exhaustion();
	Error::new(
		ErrorKind::Authentication,
		ErrorPhase::Authentication,
		RetryAction::Never,
		context.receipt(),
	)
	.detail(ErrorDetail::budget(
		sf!("provider_sign"),
		budget.as_nanos(),
		budget.as_nanos().saturating_add(1),
	))
}

#[cfg(test)]
mod tests {
	use std::{
		future::{self, Future},
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		task::{Context, Poll},
		time::{self, Duration},
	};

	use bytes::Bytes;
	use futures::future::{Ready, ready};
	use omp_core::{Hash32, SecretString};
	use parking_lot::Mutex;
	use tower::Service;

	use super::{
		AttemptEncoder, CredentialApplier, CredentialApplyService, EncodeService, EncodedAttempt,
	};
	use crate::{
		BeforeRequestMutation,
		auth::AuthScheme,
		body::BodySource,
		codec::{
			Cancellation, Decoder, EncodedRequest, ProviderHookError, ProviderHookObserver,
			ProviderResponseHooks, ProviderResponseObservation, ProviderResponseObserver,
			ProviderSignHookRequest, ProviderSignature, RawEvent, RequestMethod, SizeBounds,
			TransportAttempt, TransportRequest,
		},
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		id::RequestId,
		layer::{
			ExecutionContext, LayerCall,
			auth::Authorized,
			hook::{HookHandle, NoHookHandle},
		},
		receipt::ExecutionBudget,
		transport::{Frame, FramingProtocol},
	};

	struct EmptyDecoder;
	impl Decoder for EmptyDecoder {
		fn push(&mut self, _: Frame, _: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
			Ok(())
		}

		fn finish(&mut self, _: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
			Ok(())
		}
	}
	fn transport() -> TransportRequest {
		TransportRequest {
			encoded:        EncodedRequest {
				operation:   omp_catalog::OperationKind::Chat,
				method:      RequestMethod::Post,
				uri:         "https://example.invalid".into(),
				headers:     Box::new([]),
				body:        BodySource::Bytes(Bytes::new()),
				framing:     FramingProtocol::Raw,
				bounds:      SizeBounds { request_body: 1, frame: 1, response: 1 },
				sealed_body: None,
				adjustments: Vec::new(),
			},
			credentials:    None,
			signature:      None,
			decoder:        Some(Box::new(EmptyDecoder)),
			realtime:       None,
			cancel:         Cancellation::default(),
			response_hooks: Default::default(),
			attempt:        TransportAttempt {
				request_id:          RequestId::from("request"),
				session:             None,
				provider:            omp_catalog::ProviderId::from("provider"),
				model:               Some(omp_catalog::ModelKey::from("model")),
				api:                 omp_core::Str::new_static("test"),
				route:               omp_catalog::RouteId::from("route"),
				account:             None,
				principal:           None,
				index:               0,
				provisional:         false,
				capture_limit:       0,
				timeout:             time::Duration::from_secs(1),
				first_event_timeout: None,
			},
		}
	}
	#[derive(Clone)]
	struct Encoder(Arc<Mutex<Vec<&'static str>>>);
	impl AttemptEncoder<(), u8> for Encoder {
		fn encode(
			&self,
			&(): &(),
			_: &u8,
			_: &BeforeRequestMutation,
			_: &ExecutionContext,
			_: u32,
			_: bool,
			_: Cancellation,
		) -> Result<TransportRequest, Error> {
			self.0.lock().push("encode");
			Ok(transport())
		}
	}
	#[derive(Clone)]
	struct Applier(Arc<Mutex<Vec<&'static str>>>);
	impl CredentialApplier<(), u8> for Applier {
		fn apply(
			&self,
			&(): &(),
			_: u8,
			_: &mut TransportRequest,
			_: &ExecutionContext,
		) -> Result<(), Error> {
			self.0.lock().push("credential");
			Ok(())
		}
	}
	#[derive(Clone)]
	struct Wire(Arc<Mutex<Vec<&'static str>>>);
	impl Service<TransportRequest> for Wire {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: TransportRequest) -> Self::Future {
			self.0.lock().push("wire");
			ready(Ok(()))
		}
	}
	struct StubExthost;

	impl ProviderHookObserver for StubExthost {
		fn provider_sign_subscribed(&self, provider: &omp_catalog::ProviderId<str>) -> bool {
			provider.as_str() == "provider"
		}

		fn provider_sign<'a>(
			&'a self,
			request: ProviderSignHookRequest,
		) -> std::pin::Pin<
			Box<dyn Future<Output = Result<ProviderSignature, ProviderHookError>> + Send + 'a>,
		> {
			Box::pin(async move {
				assert_eq!(request.method, "POST");
				assert_eq!(request.body_sha256, Hash32::sum([]).into_bytes());
				Ok(ProviderSignature {
					headers: Box::new([(
						omp_core::Str::new_static("x-extension-signature"),
						SecretString::from("signed"),
					)]),
					query:   Box::new([]),
				})
			})
		}
	}

	impl ProviderResponseObserver for StubExthost {
		fn subscribed(&self) -> bool {
			false
		}

		fn observe(&self, _observation: ProviderResponseObservation) {}
	}

	#[derive(Clone)]
	struct SigningWire(Arc<AtomicBool>);

	impl Service<TransportRequest> for SigningWire {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, request: TransportRequest) -> Self::Future {
			self.0.store(request.signature.is_some(), Ordering::Release);
			ready(Ok(()))
		}
	}

	#[derive(Clone, Copy)]
	struct MappingApplier;

	impl CredentialApplier<(), ()> for MappingApplier {
		fn apply(
			&self,
			&(): &(),
			(): (),
			_: &mut TransportRequest,
			_: &ExecutionContext,
		) -> Result<(), Error> {
			Ok(())
		}

		fn map_response_error(&self, _: Option<AuthScheme>, mut error: Error) -> Error {
			error.action = RetryAction::RotateAccount;
			error
		}
	}

	#[derive(Clone, Copy)]
	struct FailingWire;

	impl Service<TransportRequest> for FailingWire {
		type Error = Error;
		type Future = Ready<Result<(), Error>>;
		type Response = ();

		fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Error>> {
			Poll::Ready(Ok(()))
		}

		fn call(&mut self, _: TransportRequest) -> Self::Future {
			ready(Err(Error::new(
				ErrorKind::Authorization,
				ErrorPhase::Handshake,
				RetryAction::Never,
				Default::default(),
			)))
		}
	}

	#[tokio::test]
	async fn credential_policy_refines_wire_errors_before_attempt_recovery() {
		let mut service = CredentialApplyService::<_, _, NoHookHandle> {
			inner:   Arc::new(Mutex::new(FailingWire)),
			applier: MappingApplier,
			hook:    None,
		};
		let error = service
			.call(LayerCall {
				payload: EncodedAttempt { account: (), transport: transport(), lease: () },
				context: ExecutionContext::new(ExecutionBudget::default()),
			})
			.await
			.expect_err("credential policy maps the wire rejection");
		assert_eq!(error.kind, ErrorKind::Authorization);
		assert_eq!(error.action, RetryAction::RotateAccount);
	}

	#[tokio::test]
	async fn extension_provider_sign_runs_after_credentials_and_before_wire() {
		let signed = Arc::new(AtomicBool::new(false));
		let mut request = transport();
		request.response_hooks = ProviderResponseHooks::new(Arc::new(StubExthost));
		let mut service = CredentialApplyService::<_, _, NoHookHandle> {
			inner:   Arc::new(Mutex::new(SigningWire(Arc::clone(&signed)))),
			applier: Applier(Arc::new(Mutex::new(Vec::new()))),
			hook:    None,
		};
		service
			.call(LayerCall {
				payload: EncodedAttempt { account: (), transport: request, lease: 7 },
				context: ExecutionContext::new(ExecutionBudget::default()),
			})
			.await
			.expect("signed request");
		assert!(signed.load(Ordering::Acquire));
	}

	#[derive(Clone, Copy)]
	struct SlowSigner;
	impl HookHandle for SlowSigner {
		fn before_request(
			&self,
			_: &ExecutionContext,
		) -> impl Future<Output = Result<(), Error>> + Send {
			ready(Ok(()))
		}

		fn provider_error(
			&self,
			_: &Error,
			_: &ExecutionContext,
		) -> impl Future<Output = Option<RetryAction>> + Send {
			ready(None)
		}

		fn provider_sign(
			&self,
			_: &TransportRequest,
			_: &ExecutionContext,
		) -> impl Future<Output = Result<(), Error>> + Send {
			future::pending()
		}

		fn sign_budget(&self) -> Duration {
			Duration::ZERO
		}
	}

	#[tokio::test]
	async fn signing_timeout_fails_closed_before_wire_transport() {
		let trace = Arc::new(Mutex::new(Vec::new()));
		let context = ExecutionContext::new(ExecutionBudget::default());
		let mut service = CredentialApplyService {
			inner:   Arc::new(Mutex::new(Wire(trace.clone()))),
			applier: Applier(trace.clone()),
			hook:    Some(SlowSigner),
		};
		let error = service
			.call(LayerCall {
				payload: EncodedAttempt { account: (), transport: transport(), lease: 7 },
				context: context.clone(),
			})
			.await
			.expect_err("sign timeout must prevent wire transport");
		assert_eq!(error.kind, ErrorKind::Authentication);
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(context.sign_budget_exhaustions(), 1);
		assert_eq!(&*trace.lock(), &["credential"]);
	}
	#[tokio::test]
	async fn credentials_are_applied_only_after_encoding_and_immediately_before_transport() {
		let trace = Arc::new(Mutex::new(Vec::new()));
		let credential = CredentialApplyService {
			inner:   Arc::new(Mutex::new(Wire(trace.clone()))),
			applier: Applier(trace.clone()),
			hook:    None::<NoHookHandle>,
		};
		let mut service = EncodeService {
			inner:       Arc::new(Mutex::new(credential)),
			encoder:     Encoder(trace.clone()),
			hook:        None::<NoHookHandle>,
			provisional: false,
		};
		futures::future::poll_fn(|cx| service.poll_ready(cx))
			.await
			.unwrap();
		service
			.call(LayerCall {
				payload: Authorized { request: (), account: (), lease: 7 },
				context: ExecutionContext::new(ExecutionBudget::default()),
			})
			.await
			.unwrap();
		assert_eq!(&*trace.lock(), &["encode", "credential", "wire"]);
	}
}
