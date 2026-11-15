use super::mut_only::MutOnly;
use super::{
    ClientHello, GetSessionPendingError, PrivateKeyMethod, PrivateKeyMethodError, SelectCertError,
    Ssl, SslAlert, SslContextBuilder, SslRef, SslSession, SslSignatureAlgorithm, SslVerifyError,
    SslVerifyMode,
};
#[cfg(feature = "credential")]
use crate::error::ErrorStack;
use crate::ex_data::Index;
#[cfg(feature = "credential")]
use crate::ssl::SslCredentialBuilder;
use std::convert::identity;
use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::task::{ready, Context, Poll, Waker};

/// The type of futures to pass to [`SslContextBuilder::set_async_select_certificate_callback`].
pub type BoxSelectCertFuture = ExDataFuture<Result<BoxSelectCertFinish, AsyncSelectCertError>>;

/// The type of callbacks returned by [`BoxSelectCertFuture`] methods.
pub type BoxSelectCertFinish = Box<dyn FnOnce(ClientHello<'_>) -> Result<(), AsyncSelectCertError>>;

/// The type of futures returned by [`AsyncPrivateKeyMethod`] methods.
pub type BoxPrivateKeyMethodFuture =
    ExDataFuture<Result<BoxPrivateKeyMethodFinish, AsyncPrivateKeyMethodError>>;

/// The type of callbacks returned by [`BoxPrivateKeyMethodFuture`].
pub type BoxPrivateKeyMethodFinish =
    Box<dyn FnOnce(&mut SslRef, &mut [u8]) -> Result<usize, AsyncPrivateKeyMethodError>>;

/// The type of futures to pass to [`SslContextBuilder::set_async_get_session_callback`].
pub type BoxGetSessionFuture = ExDataFuture<Option<BoxGetSessionFinish>>;

/// The type of callbacks returned by [`BoxSelectCertFuture`] methods.
pub type BoxGetSessionFinish = Box<dyn FnOnce(&mut SslRef, &[u8]) -> Option<SslSession>>;

/// The type of futures to pass to [`SslContextBuilder::set_async_custom_verify_callback`].
pub type BoxCustomVerifyFuture = ExDataFuture<Result<BoxCustomVerifyFinish, SslAlert>>;

/// The type of callbacks returned by [`BoxCustomVerifyFuture`] methods.
pub type BoxCustomVerifyFinish = Box<dyn FnOnce(&mut SslRef) -> Result<(), SslAlert>>;

/// Convenience alias for futures stored in [`Ssl`] ex data by [`SslContextBuilder`] methods.
///
/// Public for documentation purposes.
pub type ExDataFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub(crate) static TASK_WAKER_INDEX: LazyLock<Index<Ssl, Option<Waker>>> =
    LazyLock::new(|| Ssl::new_ex_index().unwrap());
pub(crate) static SELECT_CERT_FUTURE_INDEX: LazyLock<
    Index<Ssl, MutOnly<Option<BoxSelectCertFuture>>>,
> = LazyLock::new(|| Ssl::new_ex_index().unwrap());
pub(crate) static SELECT_PRIVATE_KEY_METHOD_FUTURE_INDEX: LazyLock<
    Index<Ssl, MutOnly<Option<BoxPrivateKeyMethodFuture>>>,
> = LazyLock::new(|| Ssl::new_ex_index().unwrap());
pub(crate) static SELECT_GET_SESSION_FUTURE_INDEX: LazyLock<
    Index<Ssl, MutOnly<Option<BoxGetSessionFuture>>>,
> = LazyLock::new(|| Ssl::new_ex_index().unwrap());
pub(crate) static SELECT_CUSTOM_VERIFY_FUTURE_INDEX: LazyLock<
    Index<Ssl, MutOnly<Option<BoxCustomVerifyFuture>>>,
> = LazyLock::new(|| Ssl::new_ex_index().unwrap());

impl SslContextBuilder {
    /// Sets a callback that is called before most [`ClientHello`] processing
    /// and before the decision whether to resume a session is made. The
    /// callback may inspect the [`ClientHello`] and configure the connection.
    ///
    /// This method uses a function that returns a future whose output is
    /// itself a closure that will be passed [`ClientHello`] to configure
    /// the connection based on the computations done in the future.
    ///
    /// A task waker must be set on `Ssl` values associated with the resulting
    /// `SslContext` with [`SslRef::set_task_waker`].
    ///
    /// See [`SslContextBuilder::set_select_certificate_callback`] for the sync
    /// setter of this callback.
    pub fn set_async_select_certificate_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut ClientHello<'_>) -> Result<BoxSelectCertFuture, AsyncSelectCertError>
            + Send
            + Sync
            + 'static,
    {
        self.set_select_certificate_callback(move |mut client_hello| {
            let fut_poll_result = with_ex_data_future(
                &mut client_hello,
                *SELECT_CERT_FUTURE_INDEX,
                ClientHello::ssl_mut,
                &callback,
                identity,
            );

            let fut_result = match fut_poll_result {
                Poll::Ready(fut_result) => fut_result,
                Poll::Pending => return Err(SelectCertError::RETRY),
            };

            let finish = fut_result.or(Err(SelectCertError::ERROR))?;

            finish(client_hello).or(Err(SelectCertError::ERROR))
        });
    }

    /// Configures a custom private key method on the context.
    ///
    /// A task waker must be set on `Ssl` values associated with the resulting
    /// `SslContext` with [`SslRef::set_task_waker`].
    ///
    /// See [`AsyncPrivateKeyMethod`] for more details.
    pub fn set_async_private_key_method(&mut self, method: impl AsyncPrivateKeyMethod) {
        self.set_private_key_method(AsyncPrivateKeyMethodBridge(Box::new(method)));
    }

    /// Sets a callback that is called when a client proposed to resume a session
    /// but it was not found in the internal cache.
    ///
    /// The callback is passed a reference to the session ID provided by the client.
    /// It should return the session corresponding to that ID if available. This is
    /// only used for servers, not clients.
    ///
    /// A task waker must be set on `Ssl` values associated with the resulting
    /// `SslContext` with [`SslRef::set_task_waker`].
    ///
    /// See [`SslContextBuilder::set_get_session_callback`] for the sync setter
    /// of this callback.
    ///
    /// # Safety
    ///
    /// The returned [`SslSession`] must not be associated with a different [`SslContextBuilder`].
    pub unsafe fn set_async_get_session_callback<F>(&mut self, callback: F)
    where
        F: Fn(&mut SslRef, &[u8]) -> Option<BoxGetSessionFuture> + Send + Sync + 'static,
    {
        let async_callback = move |ssl: &mut SslRef, id: &[u8]| {
            let fut_poll_result = with_ex_data_future(
                &mut *ssl,
                *SELECT_GET_SESSION_FUTURE_INDEX,
                |ssl| ssl,
                |ssl| callback(ssl, id).ok_or(()),
                |option| option.ok_or(()),
            );

            match fut_poll_result {
                Poll::Ready(Err(())) => Ok(None),
                Poll::Ready(Ok(finish)) => Ok(finish(ssl, id)),
                Poll::Pending => Err(GetSessionPendingError),
            }
        };

        unsafe {
            self.set_get_session_callback(async_callback);
        }
    }

    /// Configures certificate verification.
    ///
    /// The callback should return `Ok(())` if the certificate is valid.
    /// If the certificate is invalid, the callback should return `SslVerifyError::Invalid(alert)`.
    /// Some useful alerts include [`SslAlert::CERTIFICATE_EXPIRED`], [`SslAlert::CERTIFICATE_REVOKED`],
    /// [`SslAlert::UNKNOWN_CA`], [`SslAlert::BAD_CERTIFICATE`], [`SslAlert::CERTIFICATE_UNKNOWN`],
    /// and [`SslAlert::INTERNAL_ERROR`]. See RFC 5246 section 7.2.2 for their precise meanings.
    ///
    /// A task waker must be set on `Ssl` values associated with the resulting
    /// `SslContext` with [`SslRef::set_task_waker`].
    ///
    /// See [`SslContextBuilder::set_custom_verify_callback`] for the sync version of this method.
    ///
    /// # Panics
    ///
    /// This method panics if this `Ssl` is associated with a RPK context.
    pub fn set_async_custom_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(&mut SslRef) -> Result<BoxCustomVerifyFuture, SslAlert> + Send + Sync + 'static,
    {
        self.set_custom_verify_callback(mode, async_custom_verify_callback(callback));
    }
}

#[cfg(feature = "credential")]
impl SslCredentialBuilder {
    /// Configures a custom private key method on the context.
    ///
    /// A task waker must be set on `Ssl` values associated with the resulting
    /// `SslContext` with [`SslRef::set_task_waker`].
    ///
    /// See [`AsyncPrivateKeyMethod`] for more details.
    pub fn set_async_private_key_method(
        &mut self,
        method: impl AsyncPrivateKeyMethod,
    ) -> Result<(), ErrorStack> {
        self.set_private_key_method(AsyncPrivateKeyMethodBridge(Box::new(method)))
    }
}

impl SslRef {
    pub fn set_async_custom_verify_callback<F>(&mut self, mode: SslVerifyMode, callback: F)
    where
        F: Fn(&mut SslRef) -> Result<BoxCustomVerifyFuture, SslAlert> + Send + Sync + 'static,
    {
        self.set_custom_verify_callback(mode, async_custom_verify_callback(callback));
    }

    /// Sets the task waker to be used in async callbacks installed on this `Ssl`.
    pub fn set_task_waker(&mut self, waker: Option<Waker>) {
        self.replace_ex_data(*TASK_WAKER_INDEX, waker);
    }
}

fn async_custom_verify_callback<F>(
    callback: F,
) -> impl Fn(&mut SslRef) -> Result<(), SslVerifyError>
where
    F: Fn(&mut SslRef) -> Result<BoxCustomVerifyFuture, SslAlert> + Send + Sync + 'static,
{
    move |ssl| {
        let fut_poll_result = with_ex_data_future(
            &mut *ssl,
            *SELECT_CUSTOM_VERIFY_FUTURE_INDEX,
            |ssl| ssl,
            &callback,
            identity,
        );

        match fut_poll_result {
            Poll::Ready(Err(alert)) => Err(SslVerifyError::Invalid(alert)),
            Poll::Ready(Ok(finish)) => Ok(finish(ssl).map_err(SslVerifyError::Invalid)?),
            Poll::Pending => Err(SslVerifyError::Retry),
        }
    }
}

/// A fatal error to be returned from async select certificate callbacks.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct AsyncSelectCertError;

/// Describes async private key hooks. This is used to off-load signing
/// operations to a custom, potentially asynchronous, backend. Metadata about the
/// key such as the type and size are parsed out of the certificate.
///
/// See [`PrivateKeyMethod`] for the sync version of those hooks.
///
/// [`ssl_private_key_method_st`]: https://commondatastorage.googleapis.com/chromium-boringssl-docs/ssl.h.html#ssl_private_key_method_st
pub trait AsyncPrivateKeyMethod: Send + Sync + 'static {
    /// Signs the message `input` using the specified signature algorithm.
    ///
    /// This method uses a function that returns a future whose output is
    /// itself a closure that will be passed `ssl` and `output`
    /// to finish writing the signature.
    ///
    /// See [`PrivateKeyMethod::sign`] for the sync version of this method.
    fn sign(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        signature_algorithm: SslSignatureAlgorithm,
        output: &mut [u8],
    ) -> Result<BoxPrivateKeyMethodFuture, AsyncPrivateKeyMethodError>;

    /// Decrypts `input`.
    ///
    /// This method uses a function that returns a future whose output is
    /// itself a closure that will be passed `ssl` and `output`
    /// to finish decrypting the input.
    ///
    /// See [`PrivateKeyMethod::decrypt`] for the sync version of this method.
    fn decrypt(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<BoxPrivateKeyMethodFuture, AsyncPrivateKeyMethodError>;
}

/// A fatal error to be returned from async private key methods.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct AsyncPrivateKeyMethodError;

struct AsyncPrivateKeyMethodBridge(Box<dyn AsyncPrivateKeyMethod>);

impl PrivateKeyMethod for AsyncPrivateKeyMethodBridge {
    fn sign(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        signature_algorithm: SslSignatureAlgorithm,
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        with_private_key_method(ssl, output, |ssl, output| {
            <dyn AsyncPrivateKeyMethod>::sign(&*self.0, ssl, input, signature_algorithm, output)
        })
    }

    fn decrypt(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        with_private_key_method(ssl, output, |ssl, output| {
            <dyn AsyncPrivateKeyMethod>::decrypt(&*self.0, ssl, input, output)
        })
    }

    fn complete(
        &self,
        ssl: &mut SslRef,
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        with_private_key_method(ssl, output, |_, _| {
            // This should never be reached, if it does, that's a bug on btls's side,
            // which called `complete` without having been returned to with a pending
            // future from `sign` or `decrypt`.

            if cfg!(debug_assertions) {
                panic!("BUG: btls called complete without a pending operation");
            }

            Err(AsyncPrivateKeyMethodError)
        })
    }
}

/// Creates and drives a private key method future.
///
/// This is a convenience function for the three methods of impl `PrivateKeyMethod``
/// for `dyn AsyncPrivateKeyMethod`. It relies on [`with_ex_data_future`] to
/// drive the future and then immediately calls the final [`BoxPrivateKeyMethodFinish`]
/// when the future is ready.
fn with_private_key_method(
    ssl: &mut SslRef,
    output: &mut [u8],
    create_fut: impl FnOnce(
        &mut SslRef,
        &mut [u8],
    ) -> Result<BoxPrivateKeyMethodFuture, AsyncPrivateKeyMethodError>,
) -> Result<usize, PrivateKeyMethodError> {
    let fut_poll_result = with_ex_data_future(
        ssl,
        *SELECT_PRIVATE_KEY_METHOD_FUTURE_INDEX,
        |ssl| ssl,
        |ssl| create_fut(ssl, output),
        identity,
    );

    let fut_result = match fut_poll_result {
        Poll::Ready(fut_result) => fut_result,
        Poll::Pending => return Err(PrivateKeyMethodError::RETRY),
    };

    let finish = fut_result.or(Err(PrivateKeyMethodError::FAILURE))?;

    finish(ssl, output).or(Err(PrivateKeyMethodError::FAILURE))
}

/// Creates and drives a future stored in `ssl_handle`'s `Ssl` at ex data index `index`.
///
/// This function won't even bother storing the future in `index` if the future
/// created by `create_fut` returns `Poll::Ready(_)` on the first poll call.
fn with_ex_data_future<H, R, T, E>(
    ssl_handle: &mut H,
    index: Index<Ssl, MutOnly<Option<ExDataFuture<R>>>>,
    get_ssl_mut: impl Fn(&mut H) -> &mut SslRef,
    create_fut: impl FnOnce(&mut H) -> Result<ExDataFuture<R>, E>,
    into_result: impl Fn(R) -> Result<T, E>,
) -> Poll<Result<T, E>> {
    let ssl = get_ssl_mut(ssl_handle);
    let waker = ssl
        .ex_data(*TASK_WAKER_INDEX)
        .cloned()
        .flatten()
        .expect("task waker should be set");

    let mut ctx = Context::from_waker(&waker);

    if let Some(data @ Some(_)) = ssl.ex_data_mut(index).map(MutOnly::get_mut) {
        let fut_result = into_result(ready!(data.as_mut().unwrap().as_mut().poll(&mut ctx)));

        *data = None;

        Poll::Ready(fut_result)
    } else {
        let mut fut = create_fut(ssl_handle)?;

        match fut.as_mut().poll(&mut ctx) {
            Poll::Ready(fut_result) => Poll::Ready(into_result(fut_result)),
            Poll::Pending => {
                get_ssl_mut(ssl_handle).replace_ex_data(index, MutOnly::new(Some(fut)));

                Poll::Pending
            }
        }
    }
}
