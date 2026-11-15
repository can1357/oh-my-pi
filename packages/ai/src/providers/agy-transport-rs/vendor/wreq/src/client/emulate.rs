use http::HeaderMap;
use wreq_proto::{http1::Http1Options, http2::Http2Options};

use crate::{group::Group, header::OrigHeaderMap, tls::TlsOptions};

/// Converts a value into an [`Emulation`] configuration.
///
/// This trait lets multiple input types provide a unified way to produce
/// an emulation profile. Typical inputs include:
/// - Predefined browser profiles
/// - Transport option sets (e.g. HTTP/1, HTTP/2, TLS)
/// - User-defined strategy types
pub trait IntoEmulation {
    /// Converts `self` into an [`Emulation`] configuration.
    fn into_emulation(self) -> Emulation;
}

/// Builder for creating an [`Emulation`] configuration.
#[must_use]
#[derive(Debug)]
pub struct EmulationBuilder {
    emulation: Emulation,
}

/// HTTP emulation settings for a client profile.
///
/// Combines protocol options (HTTP/1, HTTP/2, TLS) and default headers.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct Emulation {
    pub(crate) group: Group,

    /// Default headers applied to outgoing requests.
    pub headers: HeaderMap,

    /// Original headers with preserved case and duplicates.
    pub orig_headers: OrigHeaderMap,

    /// TLS configuration.
    pub tls_options: Option<TlsOptions>,

    /// HTTP/1 configuration.
    pub http1_options: Option<Http1Options>,

    /// HTTP/2 configuration.
    pub http2_options: Option<Http2Options>,
}

// ==== impl EmulationBuilder ====

impl EmulationBuilder {
    /// Sets the  HTTP/1 options configuration.
    #[inline]
    pub fn http1_options(mut self, opts: Http1Options) -> Self {
        self.emulation.http1_options = Some(opts);
        self
    }

    /// Sets the HTTP/2 options configuration.
    #[inline]
    pub fn http2_options(mut self, opts: Http2Options) -> Self {
        self.emulation.http2_options = Some(opts);
        self
    }

    /// Sets the  TLS options configuration.
    #[inline]
    pub fn tls_options(mut self, opts: TlsOptions) -> Self {
        self.emulation.tls_options = Some(opts);
        self
    }

    /// Sets the default headers.
    #[inline]
    pub fn headers(mut self, src: HeaderMap) -> Self {
        crate::util::replace_headers(&mut self.emulation.headers, src);
        self
    }

    /// Sets the original headers.
    #[inline]
    pub fn orig_headers(mut self, src: OrigHeaderMap) -> Self {
        self.emulation.orig_headers.extend(src);
        self
    }

    /// Builds the [`Emulation`] instance.
    #[inline]
    pub fn build(mut self, group: Group) -> Emulation {
        self.emulation.group.emulate(group);
        self.emulation
    }
}

// ==== impl Emulation ====

impl Emulation {
    /// Creates a new [`EmulationBuilder`].
    #[inline]
    pub fn builder() -> EmulationBuilder {
        EmulationBuilder {
            emulation: Emulation {
                group: Group::default(),
                headers: HeaderMap::new(),
                orig_headers: OrigHeaderMap::new(),
                tls_options: None,
                http1_options: None,
                http2_options: None,
            },
        }
    }
}

impl<T: Into<Emulation>> IntoEmulation for T {
    #[inline]
    fn into_emulation(self) -> Emulation {
        self.into()
    }
}
