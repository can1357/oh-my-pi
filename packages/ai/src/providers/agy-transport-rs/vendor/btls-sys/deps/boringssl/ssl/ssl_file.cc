// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <string.h>

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/pem.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include "internal.h"


static int xname_cmp(const X509_NAME *const *a, const X509_NAME *const *b) {
  return X509_NAME_cmp(*a, *b);
}

static int add_bio_cert_subjects_to_stack(STACK_OF(X509_NAME) *out, BIO *bio,
                                          bool allow_empty) {
  // This function historically sorted |out| after every addition and skipped
  // duplicates. This implementation preserves that behavior, but only sorts at
  // the end, to avoid a quadratic running time. Existing duplicates in |out|
  // are preserved, but do not introduce new duplicates.
  bssl::UniquePtr<STACK_OF(X509_NAME)> to_append(sk_X509_NAME_new(xname_cmp));
  if (to_append == nullptr) {
    return 0;
  }

  // Temporarily switch the comparison function for |out|.
  struct RestoreCmpFunc {
    ~RestoreCmpFunc() { sk_X509_NAME_set_cmp_func(stack, old_cmp); }
    STACK_OF(X509_NAME) *stack;
    int (*old_cmp)(const X509_NAME *const *, const X509_NAME *const *);
  };
  RestoreCmpFunc restore = {out, sk_X509_NAME_set_cmp_func(out, xname_cmp)};

  sk_X509_NAME_sort(out);
  bool first = true;
  for (;;) {
    bssl::UniquePtr<X509> x509(
        PEM_read_bio_X509(bio, nullptr, nullptr, nullptr));
    if (x509 == nullptr) {
      if (first && !allow_empty) {
        return 0;
      }
      // TODO(davidben): This ignores PEM syntax errors. It should only succeed
      // on |PEM_R_NO_START_LINE|.
      ERR_clear_error();
      break;
    }
    first = false;

    X509_NAME *subject = X509_get_subject_name(x509.get());
    // Skip if already present in |out|. Duplicates in |to_append| will be
    // handled separately.
    if (sk_X509_NAME_find(out, /*out_index=*/nullptr, subject)) {
      continue;
    }

    bssl::UniquePtr<X509_NAME> copy(X509_NAME_dup(subject));
    if (copy == nullptr ||
        !bssl::PushToStack(to_append.get(), std::move(copy))) {
      return 0;
    }
  }

  // Append |to_append| to |stack|, skipping any duplicates.
  sk_X509_NAME_sort(to_append.get());
  size_t num = sk_X509_NAME_num(to_append.get());
  for (size_t i = 0; i < num; i++) {
    bssl::UniquePtr<X509_NAME> name(sk_X509_NAME_value(to_append.get(), i));
    sk_X509_NAME_set(to_append.get(), i, nullptr);
    if (i + 1 < num &&
        X509_NAME_cmp(name.get(), sk_X509_NAME_value(to_append.get(), i + 1)) ==
            0) {
      continue;
    }
    if (!bssl::PushToStack(out, std::move(name))) {
      return 0;
    }
  }

  // Sort |out| one last time, to preserve the historical behavior of
  // maintaining the sorted list.
  sk_X509_NAME_sort(out);
  return 1;
}

int SSL_add_bio_cert_subjects_to_stack(STACK_OF(X509_NAME) *out, BIO *bio) {
  return add_bio_cert_subjects_to_stack(out, bio, /*allow_empty=*/true);
}

STACK_OF(X509_NAME) *SSL_load_client_CA_file(const char *file) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    return nullptr;
  }
  bssl::UniquePtr<STACK_OF(X509_NAME)> ret(sk_X509_NAME_new_null());
  if (ret == nullptr ||  //
      !add_bio_cert_subjects_to_stack(ret.get(), in.get(),
                                      /*allow_empty=*/false)) {
    return nullptr;
  }
  return ret.release();
}

int SSL_add_file_cert_subjects_to_stack(STACK_OF(X509_NAME) *out,
                                        const char *file) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    return 0;
  }
  return SSL_add_bio_cert_subjects_to_stack(out, in.get());
}

int SSL_use_certificate_file(SSL *ssl, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<X509> x;
  if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    x.reset(d2i_X509_bio(in.get(), nullptr));
  } else if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    x.reset(PEM_read_bio_X509(in.get(), nullptr,
                              ssl->ctx->default_passwd_callback,
                              ssl->ctx->default_passwd_callback_userdata));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (x == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }

  return SSL_use_certificate(ssl, x.get());
}

int SSL_use_RSAPrivateKey_file(SSL *ssl, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<RSA> rsa;
  if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    rsa.reset(d2i_RSAPrivateKey_bio(in.get(), nullptr));
  } else if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    rsa.reset(PEM_read_bio_RSAPrivateKey(
        in.get(), nullptr, ssl->ctx->default_passwd_callback,
        ssl->ctx->default_passwd_callback_userdata));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (rsa == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }
  return SSL_use_RSAPrivateKey(ssl, rsa.get());
}

int SSL_use_PrivateKey_file(SSL *ssl, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<EVP_PKEY> pkey;
  if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    pkey.reset(PEM_read_bio_PrivateKey(
        in.get(), nullptr, ssl->ctx->default_passwd_callback,
        ssl->ctx->default_passwd_callback_userdata));
  } else if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    pkey.reset(d2i_PrivateKey_bio(in.get(), nullptr));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (pkey == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }

  return SSL_use_PrivateKey(ssl, pkey.get());
}

int SSL_CTX_use_certificate_file(SSL_CTX *ctx, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<X509> x;
  if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    x.reset(d2i_X509_bio(in.get(), nullptr));
  } else if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    x.reset(PEM_read_bio_X509(in.get(), nullptr, ctx->default_passwd_callback,
                              ctx->default_passwd_callback_userdata));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (x == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }

  return SSL_CTX_use_certificate(ctx, x.get());
}

int SSL_CTX_use_RSAPrivateKey_file(SSL_CTX *ctx, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<RSA> rsa;
  if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    rsa.reset(d2i_RSAPrivateKey_bio(in.get(), nullptr));
  } else if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    rsa.reset(PEM_read_bio_RSAPrivateKey(
        in.get(), nullptr, ctx->default_passwd_callback,
        ctx->default_passwd_callback_userdata));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (rsa == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }
  return SSL_CTX_use_RSAPrivateKey(ctx, rsa.get());
}

int SSL_CTX_use_PrivateKey_file(SSL_CTX *ctx, const char *file, int type) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  int reason_code;
  bssl::UniquePtr<EVP_PKEY> pkey;
  if (type == SSL_FILETYPE_PEM) {
    reason_code = ERR_R_PEM_LIB;
    pkey.reset(PEM_read_bio_PrivateKey(in.get(), nullptr,
                                       ctx->default_passwd_callback,
                                       ctx->default_passwd_callback_userdata));
  } else if (type == SSL_FILETYPE_ASN1) {
    reason_code = ERR_R_ASN1_LIB;
    pkey.reset(d2i_PrivateKey_bio(in.get(), nullptr));
  } else {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SSL_FILETYPE);
    return 0;
  }

  if (pkey == nullptr) {
    OPENSSL_PUT_ERROR(SSL, reason_code);
    return 0;
  }

  return SSL_CTX_use_PrivateKey(ctx, pkey.get());
}

// Read a file that contains our certificate in "PEM" format, possibly followed
// by a sequence of CA certificates that should be sent to the peer in the
// Certificate message.
int SSL_CTX_use_certificate_chain_file(SSL_CTX *ctx, const char *file) {
  bssl::UniquePtr<BIO> in(BIO_new_file(file, "rb"));
  if (in == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_BUF_LIB);
    return 0;
  }

  bssl::UniquePtr<X509> x(
      PEM_read_bio_X509_AUX(in.get(), nullptr, ctx->default_passwd_callback,
                            ctx->default_passwd_callback_userdata));
  if (x == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_PEM_LIB);
    return 0;
  }

  if (!SSL_CTX_use_certificate(ctx, x.get())) {
    return 0;
  }

  // If we could set up our certificate, now proceed to the CA certificates.
  SSL_CTX_clear_chain_certs(ctx);
  for (;;) {
    bssl::UniquePtr<X509> ca(
        PEM_read_bio_X509(in.get(), nullptr, ctx->default_passwd_callback,
                          ctx->default_passwd_callback_userdata));
    if (ca == nullptr) {
      break;
    }
    if (!SSL_CTX_add1_chain_cert(ctx, ca.get())) {
      return 0;
    }
  }

  // When the while loop ends, it's usually just EOF.
  if (ERR_equals(ERR_peek_last_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE)) {
    ERR_clear_error();
    return 1;
  }

  return 0;  // Some real error.
}

void SSL_CTX_set_default_passwd_cb(SSL_CTX *ctx, pem_password_cb *cb) {
  ctx->default_passwd_callback = cb;
}

pem_password_cb *SSL_CTX_get_default_passwd_cb(const SSL_CTX *ctx) {
  return ctx->default_passwd_callback;
}

void SSL_CTX_set_default_passwd_cb_userdata(SSL_CTX *ctx, void *data) {
  ctx->default_passwd_callback_userdata = data;
}

void *SSL_CTX_get_default_passwd_cb_userdata(const SSL_CTX *ctx) {
  return ctx->default_passwd_callback_userdata;
}
