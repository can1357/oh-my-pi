// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright (c) 2002, Oracle and/or its affiliates. All rights reserved.
// Copyright 2005 Nokia. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <openssl/ssl.h>

#include <assert.h>

#include <openssl/asn1.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "../crypto/internal.h"
#include "../crypto/bytestring/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

// check_ssl_x509_method asserts that |ssl| has the X509-based method
// installed. Calling an X509-based method on an |ssl| with a different method
// will likely misbehave and possibly crash or leak memory.
static void check_ssl_x509_method(const SSL *ssl) {
  assert(ssl == nullptr || ssl->ctx->x509_method == &ssl_crypto_x509_method);
}

// check_ssl_ctx_x509_method acts like |check_ssl_x509_method|, but for an
// |SSL_CTX|.
static void check_ssl_ctx_x509_method(const SSL_CTX *ctx) {
  assert(ctx == nullptr || ctx->x509_method == &ssl_crypto_x509_method);
}

// x509_to_buffer returns a |CRYPTO_BUFFER| that contains the serialised
// contents of |x509|.
static UniquePtr<CRYPTO_BUFFER> x509_to_buffer(X509 *x509) {
  uint8_t *buf = nullptr;
  int cert_len = i2d_X509(x509, &buf);
  if (cert_len <= 0) {
    return nullptr;
  }

  UniquePtr<CRYPTO_BUFFER> buffer(CRYPTO_BUFFER_new(buf, cert_len, nullptr));
  OPENSSL_free(buf);

  return buffer;
}

static void ssl_crypto_x509_cert_flush_cached_leaf(CERT *cert) {
  X509_free(cert->x509_leaf);
  cert->x509_leaf = nullptr;
}

static void ssl_crypto_x509_cert_flush_cached_chain(CERT *cert) {
  sk_X509_pop_free(cert->x509_chain, X509_free);
  cert->x509_chain = nullptr;
}

// ssl_cert_set1_chain sets elements 1.. of |cert->chain| to the serialised
// forms of elements of |chain|. It returns one on success or zero on error, in
// which case no change to |cert->chain| is made. It preserves the existing
// leaf from |cert->chain|, if any.
static bool ssl_cert_set1_chain(CERT *cert, STACK_OF(X509) *chain) {
  cert->legacy_credential->ClearIntermediateCerts();
  for (X509 *x509 : chain) {
    UniquePtr<CRYPTO_BUFFER> buffer = x509_to_buffer(x509);
    if (!buffer ||
        !cert->legacy_credential->AppendIntermediateCert(std::move(buffer))) {
      return false;
    }
  }

  ssl_crypto_x509_cert_flush_cached_chain(cert);
  return true;
}

static bool ssl_crypto_x509_check_client_CA_list(
    STACK_OF(CRYPTO_BUFFER) *names) {
  for (const CRYPTO_BUFFER *buffer : names) {
    const uint8_t *inp = CRYPTO_BUFFER_data(buffer);
    UniquePtr<X509_NAME> name(
        d2i_X509_NAME(nullptr, &inp, CRYPTO_BUFFER_len(buffer)));
    if (name == nullptr ||
        inp != CRYPTO_BUFFER_data(buffer) + CRYPTO_BUFFER_len(buffer)) {
      return false;
    }
  }

  return true;
}

static void ssl_crypto_x509_cert_clear(CERT *cert) {
  ssl_crypto_x509_cert_flush_cached_leaf(cert);
  ssl_crypto_x509_cert_flush_cached_chain(cert);

  X509_free(cert->x509_stash);
  cert->x509_stash = nullptr;
}

static void ssl_crypto_x509_cert_free(CERT *cert) {
  ssl_crypto_x509_cert_clear(cert);
  X509_STORE_free(cert->verify_store);
}

static void ssl_crypto_x509_cert_dup(CERT *new_cert, const CERT *cert) {
  if (cert->verify_store != nullptr) {
    X509_STORE_up_ref(cert->verify_store);
    new_cert->verify_store = cert->verify_store;
  }
}

static bool ssl_crypto_x509_session_cache_objects(SSL_SESSION *sess) {
  bssl::UniquePtr<STACK_OF(X509)> chain, chain_without_leaf;
  if (sk_CRYPTO_BUFFER_num(sess->certs.get()) > 0) {
    chain.reset(sk_X509_new_null());
    if (!chain) {
      return false;
    }
    if (sess->is_server) {
      // chain_without_leaf is only needed for server sessions. See
      // |SSL_get_peer_cert_chain|.
      chain_without_leaf.reset(sk_X509_new_null());
      if (!chain_without_leaf) {
        return false;
      }
    }
  }

  bssl::UniquePtr<X509> leaf;
  for (CRYPTO_BUFFER *cert : sess->certs.get()) {
    UniquePtr<X509> x509(X509_parse_from_buffer(cert));
    if (!x509) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      return false;
    }
    if (leaf == nullptr) {
      leaf = UpRef(x509);
    } else if (chain_without_leaf &&
               !PushToStack(chain_without_leaf.get(), UpRef(x509))) {
      return false;
    }
    if (!PushToStack(chain.get(), std::move(x509))) {
      return false;
    }
  }

  sk_X509_pop_free(sess->x509_chain, X509_free);
  sess->x509_chain = chain.release();

  sk_X509_pop_free(sess->x509_chain_without_leaf, X509_free);
  sess->x509_chain_without_leaf = chain_without_leaf.release();

  X509_free(sess->x509_peer);
  sess->x509_peer = leaf.release();
  return true;
}

static bool ssl_crypto_x509_session_dup(SSL_SESSION *new_session,
                                        const SSL_SESSION *session) {
  new_session->x509_peer = UpRef(session->x509_peer).release();
  if (session->x509_chain != nullptr) {
    new_session->x509_chain = X509_chain_up_ref(session->x509_chain);
    if (new_session->x509_chain == nullptr) {
      return false;
    }
  }
  if (session->x509_chain_without_leaf != nullptr) {
    new_session->x509_chain_without_leaf =
        X509_chain_up_ref(session->x509_chain_without_leaf);
    if (new_session->x509_chain_without_leaf == nullptr) {
      return false;
    }
  }

  return true;
}

static void ssl_crypto_x509_session_clear(SSL_SESSION *session) {
  X509_free(session->x509_peer);
  session->x509_peer = nullptr;
  sk_X509_pop_free(session->x509_chain, X509_free);
  session->x509_chain = nullptr;
  sk_X509_pop_free(session->x509_chain_without_leaf, X509_free);
  session->x509_chain_without_leaf = nullptr;
}

static bool ssl_crypto_x509_session_verify_cert_chain(SSL_SESSION *session,
                                                      SSL_HANDSHAKE *hs,
                                                      uint8_t *out_alert) {
  *out_alert = SSL_AD_INTERNAL_ERROR;
  STACK_OF(X509) *const cert_chain = session->x509_chain;
  if (cert_chain == nullptr || sk_X509_num(cert_chain) == 0) {
    return false;
  }

  SSL *const ssl = hs->ssl;
  SSL_CTX *ssl_ctx = ssl->ctx.get();
  X509_STORE *verify_store = ssl_ctx->cert_store;
  if (hs->config->cert->verify_store != nullptr) {
    verify_store = hs->config->cert->verify_store;
  }

  X509 *leaf = sk_X509_value(cert_chain, 0);
  const char *name;
  size_t name_len;
  SSL_get0_ech_name_override(ssl, &name, &name_len);
  UniquePtr<X509_STORE_CTX> ctx(X509_STORE_CTX_new());
  if (!ctx ||                                                             //
      !X509_STORE_CTX_init(ctx.get(), verify_store, leaf, cert_chain) ||  //
      !X509_STORE_CTX_set_ex_data(
          ctx.get(), SSL_get_ex_data_X509_STORE_CTX_idx(), ssl) ||  //
      // We need to inherit the verify parameters. These can be determined by
      // the context: if its a server it will verify SSL client certificates or
      // vice versa.
      !X509_STORE_CTX_set_default(
          ctx.get(),
          ssl->server ? "ssl_client" : "ssl_server") ||  //
      // Anything non-default in "param" should overwrite anything in the ctx.
      !X509_VERIFY_PARAM_set1(X509_STORE_CTX_get0_param(ctx.get()),
                              hs->config->param) ||  //
      // ClientHelloOuter connections use a different name.
      (name_len != 0 &&  //
       !X509_VERIFY_PARAM_set1_host(X509_STORE_CTX_get0_param(ctx.get()), name,
                                    name_len))) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_X509_LIB);
    return false;
  }

  if (hs->config->verify_callback) {
    X509_STORE_CTX_set_verify_cb(ctx.get(), hs->config->verify_callback);
  }

  int verify_ret;
  if (ssl_ctx->app_verify_callback != nullptr) {
    verify_ret =
        ssl_ctx->app_verify_callback(ctx.get(), ssl_ctx->app_verify_arg);
  } else {
    verify_ret = X509_verify_cert(ctx.get());
  }

  session->verify_result = X509_STORE_CTX_get_error(ctx.get());

  // If |SSL_VERIFY_NONE|, the error is non-fatal, but we keep the result.
  if (verify_ret <= 0 && hs->config->verify_mode != SSL_VERIFY_NONE) {
    *out_alert = SSL_alert_from_verify_result(session->verify_result);
    return false;
  }

  ERR_clear_error();
  return true;
}

static void ssl_crypto_x509_hs_flush_cached_ca_names(SSL_HANDSHAKE *hs) {
  sk_X509_NAME_pop_free(hs->cached_x509_ca_names, X509_NAME_free);
  hs->cached_x509_ca_names = nullptr;
}

static bool ssl_crypto_x509_ssl_new(SSL_HANDSHAKE *hs) {
  hs->config->param = X509_VERIFY_PARAM_new();
  if (hs->config->param == nullptr) {
    return false;
  }
  X509_VERIFY_PARAM_inherit(hs->config->param, hs->ssl->ctx->param);
  return true;
}

static void ssl_crypto_x509_ssl_flush_cached_client_CA(SSL_CONFIG *cfg) {
  sk_X509_NAME_pop_free(cfg->cached_x509_client_CA, X509_NAME_free);
  cfg->cached_x509_client_CA = nullptr;
}

static void ssl_crypto_x509_ssl_config_free(SSL_CONFIG *cfg) {
  sk_X509_NAME_pop_free(cfg->cached_x509_client_CA, X509_NAME_free);
  cfg->cached_x509_client_CA = nullptr;
  X509_VERIFY_PARAM_free(cfg->param);
}

static bool ssl_crypto_x509_ssl_auto_chain_if_needed(SSL_HANDSHAKE *hs) {
  // Only build a chain if the feature isn't disabled, the legacy credential
  // exists but has no intermediates configured.
  SSL *ssl = hs->ssl;
  SSL_CREDENTIAL *cred = hs->config->cert->legacy_credential.get();
  if ((ssl->mode & SSL_MODE_NO_AUTO_CHAIN) || !cred->IsComplete() ||
      sk_CRYPTO_BUFFER_num(cred->chain.get()) != 1) {
    return true;
  }

  UniquePtr<X509> leaf(
      X509_parse_from_buffer(sk_CRYPTO_BUFFER_value(cred->chain.get(), 0)));
  if (!leaf) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_X509_LIB);
    return false;
  }

  UniquePtr<X509_STORE_CTX> ctx(X509_STORE_CTX_new());
  if (!ctx || !X509_STORE_CTX_init(ctx.get(), ssl->ctx->cert_store, leaf.get(),
                                   nullptr)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_X509_LIB);
    return false;
  }

  // Attempt to build a chain, ignoring the result.
  X509_verify_cert(ctx.get());
  ERR_clear_error();

  // Remove the leaf from the generated chain.
  UniquePtr<STACK_OF(X509)> chain(X509_STORE_CTX_get1_chain(ctx.get()));
  if (!chain) {
    return false;
  }
  X509_free(sk_X509_shift(chain.get()));

  return SSL_set1_chain(ssl, chain.get());
}

static void ssl_crypto_x509_ssl_ctx_flush_cached_client_CA(SSL_CTX *ctx) {
  sk_X509_NAME_pop_free(ctx->cached_x509_client_CA, X509_NAME_free);
  ctx->cached_x509_client_CA = nullptr;
}

static bool ssl_crypto_x509_ssl_ctx_new(SSL_CTX *ctx) {
  ctx->cert_store = X509_STORE_new();
  ctx->param = X509_VERIFY_PARAM_new();
  return (ctx->cert_store != nullptr && ctx->param != nullptr);
}

static void ssl_crypto_x509_ssl_ctx_free(SSL_CTX *ctx) {
  ssl_crypto_x509_ssl_ctx_flush_cached_client_CA(ctx);
  X509_VERIFY_PARAM_free(ctx->param);
  X509_STORE_free(ctx->cert_store);
}

const SSL_X509_METHOD ssl_crypto_x509_method = {
    ssl_crypto_x509_check_client_CA_list,
    ssl_crypto_x509_cert_clear,
    ssl_crypto_x509_cert_free,
    ssl_crypto_x509_cert_dup,
    ssl_crypto_x509_cert_flush_cached_chain,
    ssl_crypto_x509_cert_flush_cached_leaf,
    ssl_crypto_x509_session_cache_objects,
    ssl_crypto_x509_session_dup,
    ssl_crypto_x509_session_clear,
    ssl_crypto_x509_session_verify_cert_chain,
    ssl_crypto_x509_hs_flush_cached_ca_names,
    ssl_crypto_x509_ssl_new,
    ssl_crypto_x509_ssl_config_free,
    ssl_crypto_x509_ssl_flush_cached_client_CA,
    ssl_crypto_x509_ssl_auto_chain_if_needed,
    ssl_crypto_x509_ssl_ctx_new,
    ssl_crypto_x509_ssl_ctx_free,
    ssl_crypto_x509_ssl_ctx_flush_cached_client_CA,
};

BSSL_NAMESPACE_END

using namespace bssl;

X509 *SSL_get_peer_certificate(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (ssl == nullptr) {
    return nullptr;
  }
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr || session->x509_peer == nullptr) {
    return nullptr;
  }
  X509_up_ref(session->x509_peer);
  return session->x509_peer;
}

STACK_OF(X509) *SSL_get_peer_cert_chain(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (ssl == nullptr) {
    return nullptr;
  }
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return nullptr;
  }

  // OpenSSL historically didn't include the leaf certificate in the returned
  // certificate chain, but only for servers.
  return ssl->server ? session->x509_chain_without_leaf : session->x509_chain;
}

STACK_OF(X509) *SSL_get_peer_full_cert_chain(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return nullptr;
  }

  return session->x509_chain;
}

int SSL_CTX_set_purpose(SSL_CTX *ctx, int purpose) {
  check_ssl_ctx_x509_method(ctx);
  return X509_VERIFY_PARAM_set_purpose(ctx->param, purpose);
}

int SSL_set_purpose(SSL *ssl, int purpose) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return X509_VERIFY_PARAM_set_purpose(ssl->config->param, purpose);
}

int SSL_CTX_set_trust(SSL_CTX *ctx, int trust) {
  check_ssl_ctx_x509_method(ctx);
  return X509_VERIFY_PARAM_set_trust(ctx->param, trust);
}

int SSL_set_trust(SSL *ssl, int trust) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return X509_VERIFY_PARAM_set_trust(ssl->config->param, trust);
}

int SSL_CTX_set1_param(SSL_CTX *ctx, const X509_VERIFY_PARAM *param) {
  check_ssl_ctx_x509_method(ctx);
  return X509_VERIFY_PARAM_set1(ctx->param, param);
}

int SSL_set1_param(SSL *ssl, const X509_VERIFY_PARAM *param) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return X509_VERIFY_PARAM_set1(ssl->config->param, param);
}

X509_VERIFY_PARAM *SSL_CTX_get0_param(SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return ctx->param;
}

X509_VERIFY_PARAM *SSL_get0_param(SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return nullptr;
  }
  return ssl->config->param;
}

int SSL_get_verify_depth(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return 0;
  }
  return X509_VERIFY_PARAM_get_depth(ssl->config->param);
}

int (*SSL_get_verify_callback(const SSL *ssl))(int, X509_STORE_CTX *) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return nullptr;
  }
  return ssl->config->verify_callback;
}

int SSL_CTX_get_verify_mode(const SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return ctx->verify_mode;
}

int SSL_CTX_get_verify_depth(const SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return X509_VERIFY_PARAM_get_depth(ctx->param);
}

int (*SSL_CTX_get_verify_callback(const SSL_CTX *ctx))(
    int ok, X509_STORE_CTX *store_ctx) {
  check_ssl_ctx_x509_method(ctx);
  return ctx->default_verify_callback;
}

void SSL_set_verify(SSL *ssl, int mode,
                    int (*callback)(int ok, X509_STORE_CTX *store_ctx)) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return;
  }
  ssl->config->verify_mode = mode;
  if (callback != nullptr) {
    ssl->config->verify_callback = callback;
  }
}

void SSL_set_verify_depth(SSL *ssl, int depth) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return;
  }
  X509_VERIFY_PARAM_set_depth(ssl->config->param, depth);
}

void SSL_CTX_set_cert_verify_callback(
    SSL_CTX *ctx, int (*cb)(X509_STORE_CTX *store_ctx, void *arg), void *arg) {
  check_ssl_ctx_x509_method(ctx);
  ctx->app_verify_callback = cb;
  ctx->app_verify_arg = arg;
}

void SSL_CTX_set_verify(SSL_CTX *ctx, int mode,
                        int (*cb)(int, X509_STORE_CTX *)) {
  check_ssl_ctx_x509_method(ctx);
  ctx->verify_mode = mode;
  ctx->default_verify_callback = cb;
}

void SSL_CTX_set_verify_depth(SSL_CTX *ctx, int depth) {
  check_ssl_ctx_x509_method(ctx);
  X509_VERIFY_PARAM_set_depth(ctx->param, depth);
}

int SSL_CTX_set_default_verify_paths(SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return X509_STORE_set_default_paths(ctx->cert_store);
}

int SSL_CTX_load_verify_locations(SSL_CTX *ctx, const char *ca_file,
                                  const char *ca_dir) {
  check_ssl_ctx_x509_method(ctx);
  return X509_STORE_load_locations(ctx->cert_store, ca_file, ca_dir);
}

long SSL_get_verify_result(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  SSL_SESSION *session = SSL_get_session(ssl);
  if (session == nullptr) {
    return X509_V_ERR_INVALID_CALL;
  }
  return session->verify_result;
}

X509_STORE *SSL_CTX_get_cert_store(const SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return ctx->cert_store;
}

void SSL_CTX_set_cert_store(SSL_CTX *ctx, X509_STORE *store) {
  check_ssl_ctx_x509_method(ctx);
  X509_STORE_free(ctx->cert_store);
  ctx->cert_store = store;
}

static int ssl_use_certificate(CERT *cert, X509 *x) {
  if (x == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PASSED_NULL_PARAMETER);
    return 0;
  }

  UniquePtr<CRYPTO_BUFFER> buffer = x509_to_buffer(x);
  if (!buffer) {
    return 0;
  }

  return ssl_set_cert(cert, std::move(buffer));
}

int SSL_use_certificate(SSL *ssl, X509 *x) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return ssl_use_certificate(ssl->config->cert.get(), x);
}

int SSL_CTX_use_certificate(SSL_CTX *ctx, X509 *x) {
  check_ssl_ctx_x509_method(ctx);
  return ssl_use_certificate(ctx->cert.get(), x);
}

// ssl_cert_cache_leaf_cert sets |cert->x509_leaf|, if currently NULL, from the
// first element of |cert->chain|.
static int ssl_cert_cache_leaf_cert(CERT *cert) {
  assert(cert->x509_method);

  const SSL_CREDENTIAL *cred = cert->legacy_credential.get();
  if (cert->x509_leaf != nullptr || cred->chain == nullptr) {
    return 1;
  }

  CRYPTO_BUFFER *leaf = sk_CRYPTO_BUFFER_value(cred->chain.get(), 0);
  if (!leaf) {
    return 1;
  }

  cert->x509_leaf = X509_parse_from_buffer(leaf);
  return cert->x509_leaf != nullptr;
}

static X509 *ssl_cert_get0_leaf(CERT *cert) {
  if (cert->x509_leaf == nullptr &&  //
      !ssl_cert_cache_leaf_cert(cert)) {
    return nullptr;
  }

  return cert->x509_leaf;
}

X509 *SSL_get_certificate(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return nullptr;
  }
  return ssl_cert_get0_leaf(ssl->config->cert.get());
}

X509 *SSL_CTX_get0_certificate(const SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  MutexWriteLock lock(const_cast<CRYPTO_MUTEX *>(&ctx->lock));
  return ssl_cert_get0_leaf(ctx->cert.get());
}

static int ssl_cert_add1_chain_cert(CERT *cert, X509 *x509) {
  assert(cert->x509_method);

  UniquePtr<CRYPTO_BUFFER> buffer = x509_to_buffer(x509);
  if (!buffer ||
      !cert->legacy_credential->AppendIntermediateCert(std::move(buffer))) {
    return 0;
  }

  ssl_crypto_x509_cert_flush_cached_chain(cert);
  return 1;
}

static int ssl_cert_add0_chain_cert(CERT *cert, X509 *x509) {
  if (!ssl_cert_add1_chain_cert(cert, x509)) {
    return 0;
  }

  X509_free(cert->x509_stash);
  cert->x509_stash = x509;
  return 1;
}

int SSL_CTX_set0_chain(SSL_CTX *ctx, STACK_OF(X509) *chain) {
  check_ssl_ctx_x509_method(ctx);
  if (!ssl_cert_set1_chain(ctx->cert.get(), chain)) {
    return 0;
  }
  sk_X509_pop_free(chain, X509_free);
  return 1;
}

int SSL_CTX_set1_chain(SSL_CTX *ctx, STACK_OF(X509) *chain) {
  check_ssl_ctx_x509_method(ctx);
  return ssl_cert_set1_chain(ctx->cert.get(), chain);
}

int SSL_set0_chain(SSL *ssl, STACK_OF(X509) *chain) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  if (!ssl_cert_set1_chain(ssl->config->cert.get(), chain)) {
    return 0;
  }
  sk_X509_pop_free(chain, X509_free);
  return 1;
}

int SSL_set1_chain(SSL *ssl, STACK_OF(X509) *chain) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return ssl_cert_set1_chain(ssl->config->cert.get(), chain);
}

int SSL_CTX_add0_chain_cert(SSL_CTX *ctx, X509 *x509) {
  check_ssl_ctx_x509_method(ctx);
  return ssl_cert_add0_chain_cert(ctx->cert.get(), x509);
}

int SSL_CTX_add1_chain_cert(SSL_CTX *ctx, X509 *x509) {
  check_ssl_ctx_x509_method(ctx);
  return ssl_cert_add1_chain_cert(ctx->cert.get(), x509);
}

int SSL_CTX_add_extra_chain_cert(SSL_CTX *ctx, X509 *x509) {
  check_ssl_ctx_x509_method(ctx);
  return SSL_CTX_add0_chain_cert(ctx, x509);
}

int SSL_add0_chain_cert(SSL *ssl, X509 *x509) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return ssl_cert_add0_chain_cert(ssl->config->cert.get(), x509);
}

int SSL_add1_chain_cert(SSL *ssl, X509 *x509) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return ssl_cert_add1_chain_cert(ssl->config->cert.get(), x509);
}

int SSL_CTX_clear_chain_certs(SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return SSL_CTX_set0_chain(ctx, nullptr);
}

int SSL_CTX_clear_extra_chain_certs(SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  return SSL_CTX_clear_chain_certs(ctx);
}

int SSL_clear_chain_certs(SSL *ssl) {
  check_ssl_x509_method(ssl);
  return SSL_set0_chain(ssl, nullptr);
}

// ssl_cert_cache_chain_certs fills in |cert->x509_chain| from elements 1.. of
// |cert->chain|.
static int ssl_cert_cache_chain_certs(CERT *cert) {
  assert(cert->x509_method);

  const SSL_CREDENTIAL *cred = cert->legacy_credential.get();
  if (cert->x509_chain != nullptr || cred->chain == nullptr ||
      sk_CRYPTO_BUFFER_num(cred->chain.get()) < 2) {
    return 1;
  }

  UniquePtr<STACK_OF(X509)> chain(sk_X509_new_null());
  if (!chain) {
    return 0;
  }

  for (size_t i = 1; i < sk_CRYPTO_BUFFER_num(cred->chain.get()); i++) {
    CRYPTO_BUFFER *buffer = sk_CRYPTO_BUFFER_value(cred->chain.get(), i);
    UniquePtr<X509> x509(X509_parse_from_buffer(buffer));
    if (!x509 ||  //
        !PushToStack(chain.get(), std::move(x509))) {
      return 0;
    }
  }

  cert->x509_chain = chain.release();
  return 1;
}

int SSL_CTX_get0_chain_certs(const SSL_CTX *ctx, STACK_OF(X509) **out_chain) {
  check_ssl_ctx_x509_method(ctx);
  MutexWriteLock lock(const_cast<CRYPTO_MUTEX *>(&ctx->lock));
  if (!ssl_cert_cache_chain_certs(ctx->cert.get())) {
    *out_chain = nullptr;
    return 0;
  }

  *out_chain = ctx->cert->x509_chain;
  return 1;
}

int SSL_CTX_get_extra_chain_certs(const SSL_CTX *ctx,
                                  STACK_OF(X509) **out_chain) {
  return SSL_CTX_get0_chain_certs(ctx, out_chain);
}

int SSL_get0_chain_certs(const SSL *ssl, STACK_OF(X509) **out_chain) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return 0;
  }
  if (!ssl_cert_cache_chain_certs(ssl->config->cert.get())) {
    *out_chain = nullptr;
    return 0;
  }

  *out_chain = ssl->config->cert->x509_chain;
  return 1;
}

SSL_SESSION *d2i_SSL_SESSION_bio(BIO *bio, SSL_SESSION **out) {
  uint8_t *data;
  size_t len;
  if (!BIO_read_asn1(bio, &data, &len, 1024 * 1024)) {
    return nullptr;
  }
  bssl::UniquePtr<uint8_t> free_data(data);
  const uint8_t *ptr = data;
  return d2i_SSL_SESSION(out, &ptr, static_cast<long>(len));
}

int i2d_SSL_SESSION_bio(BIO *bio, const SSL_SESSION *session) {
  uint8_t *data;
  size_t len;
  if (!SSL_SESSION_to_bytes(session, &data, &len)) {
    return 0;
  }
  bssl::UniquePtr<uint8_t> free_data(data);
  return BIO_write_all(bio, data, len);
}

IMPLEMENT_PEM_rw(SSL_SESSION, SSL_SESSION, PEM_STRING_SSL_SESSION, SSL_SESSION)

SSL_SESSION *d2i_SSL_SESSION(SSL_SESSION **out, const uint8_t **inp, long len) {
  return bssl::D2IFromCBS(out, inp, len, [](CBS *cbs) {
    return SSL_SESSION_parse(cbs, &ssl_crypto_x509_method,
                             nullptr /* no buffer pool */);
  });
}

STACK_OF(X509_NAME) *SSL_dup_CA_list(STACK_OF(X509_NAME) *list) {
  return sk_X509_NAME_deep_copy(list, X509_NAME_dup, X509_NAME_free);
}

static void set_client_CA_list(UniquePtr<STACK_OF(CRYPTO_BUFFER)> *ca_list,
                               const STACK_OF(X509_NAME) *name_list,
                               CRYPTO_BUFFER_POOL *pool) {
  UniquePtr<STACK_OF(CRYPTO_BUFFER)> buffers(sk_CRYPTO_BUFFER_new_null());
  if (!buffers) {
    return;
  }

  for (X509_NAME *name : name_list) {
    uint8_t *outp = nullptr;
    int len = i2d_X509_NAME(name, &outp);
    if (len < 0) {
      return;
    }

    UniquePtr<CRYPTO_BUFFER> buffer(CRYPTO_BUFFER_new(outp, len, pool));
    OPENSSL_free(outp);
    if (!buffer || !PushToStack(buffers.get(), std::move(buffer))) {
      return;
    }
  }

  *ca_list = std::move(buffers);
}

void SSL_set_client_CA_list(SSL *ssl, STACK_OF(X509_NAME) *name_list) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return;
  }
  ssl->ctx->x509_method->ssl_flush_cached_client_CA(ssl->config.get());
  set_client_CA_list(&ssl->config->client_CA, name_list, ssl->ctx->pool);
  sk_X509_NAME_pop_free(name_list, X509_NAME_free);
}

void SSL_CTX_set_client_CA_list(SSL_CTX *ctx, STACK_OF(X509_NAME) *name_list) {
  check_ssl_ctx_x509_method(ctx);
  ctx->x509_method->ssl_ctx_flush_cached_client_CA(ctx);
  set_client_CA_list(&ctx->client_CA, name_list, ctx->pool);
  sk_X509_NAME_pop_free(name_list, X509_NAME_free);
}

static STACK_OF(X509_NAME) *buffer_names_to_x509(
    const STACK_OF(CRYPTO_BUFFER) *names, STACK_OF(X509_NAME) **cached) {
  if (names == nullptr) {
    return nullptr;
  }

  if (*cached != nullptr) {
    return *cached;
  }

  UniquePtr<STACK_OF(X509_NAME)> new_cache(sk_X509_NAME_new_null());
  if (!new_cache) {
    return nullptr;
  }

  for (const CRYPTO_BUFFER *buffer : names) {
    const uint8_t *inp = CRYPTO_BUFFER_data(buffer);
    UniquePtr<X509_NAME> name(
        d2i_X509_NAME(nullptr, &inp, CRYPTO_BUFFER_len(buffer)));
    if (!name ||
        inp != CRYPTO_BUFFER_data(buffer) + CRYPTO_BUFFER_len(buffer) ||
        !PushToStack(new_cache.get(), std::move(name))) {
      return nullptr;
    }
  }

  *cached = new_cache.release();
  return *cached;
}

STACK_OF(X509_NAME) *SSL_get_client_CA_list(const SSL *ssl) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    assert(ssl->config);
    return nullptr;
  }
  // For historical reasons, this function is used both to query configuration
  // state on a server as well as handshake state on a client. However, whether
  // |ssl| is a client or server is not known until explicitly configured with
  // |SSL_set_connect_state|. If |do_handshake| is NULL, |ssl| is in an
  // indeterminate mode and |ssl->server| is unset.
  if (ssl->do_handshake != nullptr && !ssl->server) {
    if (ssl->s3->hs != nullptr) {
      return buffer_names_to_x509(ssl->s3->hs->ca_names.get(),
                                  &ssl->s3->hs->cached_x509_ca_names);
    }

    return nullptr;
  }

  if (ssl->config->client_CA != nullptr) {
    return buffer_names_to_x509(
        ssl->config->client_CA.get(),
        (STACK_OF(X509_NAME) **)&ssl->config->cached_x509_client_CA);
  }
  return SSL_CTX_get_client_CA_list(ssl->ctx.get());
}

STACK_OF(X509_NAME) *SSL_CTX_get_client_CA_list(const SSL_CTX *ctx) {
  check_ssl_ctx_x509_method(ctx);
  // This is a logically const operation that may be called on multiple threads,
  // so it needs to lock around updating |cached_x509_client_CA|.
  MutexWriteLock lock(const_cast<CRYPTO_MUTEX *>(&ctx->lock));
  return buffer_names_to_x509(
      ctx->client_CA.get(),
      const_cast<STACK_OF(X509_NAME) **>(&ctx->cached_x509_client_CA));
}

static int add_client_CA(UniquePtr<STACK_OF(CRYPTO_BUFFER)> *names, X509 *x509,
                         CRYPTO_BUFFER_POOL *pool) {
  if (x509 == nullptr) {
    return 0;
  }

  uint8_t *outp = nullptr;
  int len = i2d_X509_NAME(X509_get_subject_name(x509), &outp);
  if (len < 0) {
    return 0;
  }

  UniquePtr<CRYPTO_BUFFER> buffer(CRYPTO_BUFFER_new(outp, len, pool));
  OPENSSL_free(outp);
  if (!buffer) {
    return 0;
  }

  int alloced = 0;
  if (*names == nullptr) {
    names->reset(sk_CRYPTO_BUFFER_new_null());
    alloced = 1;

    if (*names == nullptr) {
      return 0;
    }
  }

  if (!PushToStack(names->get(), std::move(buffer))) {
    if (alloced) {
      names->reset();
    }
    return 0;
  }

  return 1;
}

int SSL_add_client_CA(SSL *ssl, X509 *x509) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  if (!add_client_CA(&ssl->config->client_CA, x509, ssl->ctx->pool)) {
    return 0;
  }

  ssl_crypto_x509_ssl_flush_cached_client_CA(ssl->config.get());
  return 1;
}

int SSL_CTX_add_client_CA(SSL_CTX *ctx, X509 *x509) {
  check_ssl_ctx_x509_method(ctx);
  if (!add_client_CA(&ctx->client_CA, x509, ctx->pool)) {
    return 0;
  }

  ssl_crypto_x509_ssl_ctx_flush_cached_client_CA(ctx);
  return 1;
}

static int do_client_cert_cb(SSL *ssl, void *arg) {
  // Should only be called during handshake, but check to be sure.
  BSSL_CHECK(ssl->config);

  if (ssl->config->cert->legacy_credential->IsComplete() ||
      ssl->ctx->client_cert_cb == nullptr) {
    return 1;
  }

  X509 *x509 = nullptr;
  EVP_PKEY *pkey = nullptr;
  int ret = ssl->ctx->client_cert_cb(ssl, &x509, &pkey);
  if (ret < 0) {
    return -1;
  }
  UniquePtr<X509> free_x509(x509);
  UniquePtr<EVP_PKEY> free_pkey(pkey);

  if (ret != 0) {
    if (!SSL_use_certificate(ssl, x509) ||  //
        !SSL_use_PrivateKey(ssl, pkey)) {
      return 0;
    }
  }

  return 1;
}

void SSL_CTX_set_client_cert_cb(SSL_CTX *ctx,
                                int (*cb)(SSL *ssl, X509 **out_x509,
                                          EVP_PKEY **out_pkey)) {
  check_ssl_ctx_x509_method(ctx);
  // Emulate the old client certificate callback with the new one.
  SSL_CTX_set_cert_cb(ctx, do_client_cert_cb, nullptr);
  ctx->client_cert_cb = cb;
}

static int set_cert_store(X509_STORE **store_ptr, X509_STORE *new_store,
                          int take_ref) {
  X509_STORE_free(*store_ptr);
  *store_ptr = new_store;

  if (new_store != nullptr && take_ref) {
    X509_STORE_up_ref(new_store);
  }

  return 1;
}

int SSL_get_ex_data_X509_STORE_CTX_idx(void) {
  // The ex_data index to go from |X509_STORE_CTX| to |SSL| always uses the
  // reserved app_data slot. Before ex_data was introduced, app_data was used.
  // Avoid breaking any software which assumes |X509_STORE_CTX_get_app_data|
  // works.
  return 0;
}

int SSL_CTX_set0_verify_cert_store(SSL_CTX *ctx, X509_STORE *store) {
  check_ssl_ctx_x509_method(ctx);
  return set_cert_store(&ctx->cert->verify_store, store, 0);
}

int SSL_CTX_set1_verify_cert_store(SSL_CTX *ctx, X509_STORE *store) {
  check_ssl_ctx_x509_method(ctx);
  return set_cert_store(&ctx->cert->verify_store, store, 1);
}

int SSL_set0_verify_cert_store(SSL *ssl, X509_STORE *store) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return set_cert_store(&ssl->config->cert->verify_store, store, 0);
}

int SSL_set1_verify_cert_store(SSL *ssl, X509_STORE *store) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return set_cert_store(&ssl->config->cert->verify_store, store, 1);
}

int SSL_set1_host(SSL *ssl, const char *hostname) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return 0;
  }
  return X509_VERIFY_PARAM_set1_host(ssl->config->param, hostname,
                                     strlen(hostname));
}

void SSL_set_hostflags(SSL *ssl, unsigned flags) {
  check_ssl_x509_method(ssl);
  if (!ssl->config) {
    return;
  }
  X509_VERIFY_PARAM_set_hostflags(ssl->config->param, flags);
}

int SSL_alert_from_verify_result(long result) {
  switch (result) {
    case X509_V_ERR_CERT_CHAIN_TOO_LONG:
    case X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT:
    case X509_V_ERR_INVALID_CA:
    case X509_V_ERR_PATH_LENGTH_EXCEEDED:
    case X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN:
    case X509_V_ERR_UNABLE_TO_GET_CRL:
    case X509_V_ERR_UNABLE_TO_GET_CRL_ISSUER:
    case X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT:
    case X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    case X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      return SSL_AD_UNKNOWN_CA;

    case X509_V_ERR_UNABLE_TO_DECRYPT_CERT_SIGNATURE:
    case X509_V_ERR_UNABLE_TO_DECRYPT_CRL_SIGNATURE:
    case X509_V_ERR_UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY:
    case X509_V_ERR_ERROR_IN_CERT_NOT_BEFORE_FIELD:
    case X509_V_ERR_ERROR_IN_CERT_NOT_AFTER_FIELD:
    case X509_V_ERR_ERROR_IN_CRL_LAST_UPDATE_FIELD:
    case X509_V_ERR_ERROR_IN_CRL_NEXT_UPDATE_FIELD:
    case X509_V_ERR_CERT_UNTRUSTED:
    case X509_V_ERR_CERT_REJECTED:
    case X509_V_ERR_HOSTNAME_MISMATCH:
    case X509_V_ERR_EMAIL_MISMATCH:
    case X509_V_ERR_IP_ADDRESS_MISMATCH:
      return SSL_AD_BAD_CERTIFICATE;

    case X509_V_ERR_CERT_SIGNATURE_FAILURE:
    case X509_V_ERR_CRL_SIGNATURE_FAILURE:
      return SSL_AD_DECRYPT_ERROR;

    case X509_V_ERR_CERT_HAS_EXPIRED:
    case X509_V_ERR_CERT_NOT_YET_VALID:
    case X509_V_ERR_CRL_HAS_EXPIRED:
    case X509_V_ERR_CRL_NOT_YET_VALID:
      return SSL_AD_CERTIFICATE_EXPIRED;

    case X509_V_ERR_CERT_REVOKED:
      return SSL_AD_CERTIFICATE_REVOKED;

    case X509_V_ERR_UNSPECIFIED:
    case X509_V_ERR_OUT_OF_MEM:
    case X509_V_ERR_INVALID_CALL:
    case X509_V_ERR_STORE_LOOKUP:
      return SSL_AD_INTERNAL_ERROR;

    case X509_V_ERR_APPLICATION_VERIFICATION:
      return SSL_AD_HANDSHAKE_FAILURE;

    case X509_V_ERR_INVALID_PURPOSE:
      return SSL_AD_UNSUPPORTED_CERTIFICATE;

    default:
      return SSL_AD_CERTIFICATE_UNKNOWN;
  }
}
