use std::{
    sync::Arc,
    task::{Context, Poll},
};

use futures_util::future::{self, Either, Ready};
use http::{HeaderMap, Request, Response, Version};
use tower::{Layer, Service};
use wreq_proto::{http1::Http1Options, http2::Http2Options};

use crate::{
    Error, config::RequestConfig, conn::net::SocketBindOptions, ext::UriExt, group::Group,
    header::OrigHeaderMap, proxy::Matcher, tls::TlsOptions,
};

/// A marker type for the default headers configuration value.
#[derive(Clone, Copy)]
pub(crate) struct DefaultHeaders;

/// Per-request configuration for proxy, protocol, and transport options.
/// Overrides client defaults for a single request.
#[derive(Debug, Default, Clone)]
#[non_exhaustive]
pub(crate) struct RequestOptions {
    pub group: Group,
    pub proxy: Option<Matcher>,
    pub version: Option<Version>,
    pub tls_options: Option<TlsOptions>,
    pub http1_options: Option<Http1Options>,
    pub http2_options: Option<Http2Options>,
    pub socket_bind_options: Option<SocketBindOptions>,
}

/// Configuration for the [`ConfigService`].
struct Config {
    https_only: bool,
    headers: HeaderMap,
    orig_headers: RequestConfig<OrigHeaderMap>,
    default_headers: RequestConfig<DefaultHeaders>,
}

/// Middleware layer to use [`ConfigService`].
pub struct ConfigServiceLayer {
    config: Arc<Config>,
}

/// Middleware service to use [`Config`].
#[derive(Clone)]
pub struct ConfigService<S> {
    inner: S,
    config: Arc<Config>,
}

// ===== impl DefaultHeaders =====

impl_request_config_value!(DefaultHeaders, bool);

// ===== impl RequestOptions =====

impl_request_config_value!(RequestOptions);

// ===== impl ConfigServiceLayer =====

impl ConfigServiceLayer {
    /// Creates a new [`ConfigServiceLayer`].
    pub fn new(https_only: bool, headers: HeaderMap, orig_headers: OrigHeaderMap) -> Self {
        let org_headers = (!orig_headers.is_empty()).then_some(orig_headers);
        ConfigServiceLayer {
            config: Arc::new(Config {
                https_only,
                headers,
                orig_headers: RequestConfig::new(org_headers),
                default_headers: RequestConfig::new(Some(true)),
            }),
        }
    }
}

impl<S> Layer<S> for ConfigServiceLayer {
    type Service = ConfigService<S>;

    #[inline(always)]
    fn layer(&self, inner: S) -> Self::Service {
        ConfigService {
            inner,
            config: self.config.clone(),
        }
    }
}

// ===== impl ConfigService =====

impl<ReqBody, ResBody, S> Service<Request<ReqBody>> for ConfigService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    S::Error: From<Error>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Either<S::Future, Ready<Result<Self::Response, Self::Error>>>;

    #[inline(always)]
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<ReqBody>) -> Self::Future {
        let uri = req.uri().clone();

        // check if the request URI scheme is valid.
        if !(uri.is_http() || uri.is_https()) || (self.config.https_only && !uri.is_https()) {
            return Either::Right(future::err(Error::uri_bad_scheme(uri.clone()).into()));
        }

        // check if the request ignores the default headers.
        if self
            .config
            .default_headers
            .fetch(req.extensions())
            .copied()
            .unwrap_or_default()
        {
            // insert default headers in the request headers
            // without overwriting already appended headers.
            let mut dest = self.config.headers.clone();
            crate::util::replace_headers(&mut dest, std::mem::take(req.headers_mut()));
            std::mem::swap(req.headers_mut(), &mut dest);
        }

        // store the original headers in request extensions
        if let Some(orig_headers) = self.config.orig_headers.take(req.extensions_mut()) {
            wreq_proto::ext::on_preserve_header(&mut req, orig_headers);
        }

        Either::Left(self.inner.call(req))
    }
}
