// Copyright 2011-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright (C) 2006, Network Resonance, Inc.
// Copyright (C) 2011, RTFM, Inc.
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

// DTLS code by Eric Rescorla <ekr@rtfm.com>

#include <openssl/ssl.h>

#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>

#include "internal.h"


using namespace bssl;

static const SRTP_PROTECTION_PROFILE kSRTPProfiles[] = {
    {"SRTP_AES128_CM_SHA1_80", SRTP_AES128_CM_SHA1_80},
    {"SRTP_AES128_CM_SHA1_32", SRTP_AES128_CM_SHA1_32},
    {"SRTP_AEAD_AES_128_GCM", SRTP_AEAD_AES_128_GCM},
    {"SRTP_AEAD_AES_256_GCM", SRTP_AEAD_AES_256_GCM},
    {nullptr, 0},
};

static int find_profile_by_name(const char *profile_name,
                                const SRTP_PROTECTION_PROFILE **pptr,
                                size_t len) {
  const SRTP_PROTECTION_PROFILE *p = kSRTPProfiles;
  while (p->name) {
    if (len == strlen(p->name) && !strncmp(p->name, profile_name, len)) {
      *pptr = p;
      return 1;
    }

    p++;
  }

  return 0;
}

static int ssl_ctx_make_profiles(
    const char *profiles_string,
    UniquePtr<STACK_OF(SRTP_PROTECTION_PROFILE)> *out) {
  UniquePtr<STACK_OF(SRTP_PROTECTION_PROFILE)> profiles(
      sk_SRTP_PROTECTION_PROFILE_new_null());
  if (profiles == nullptr) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_SRTP_COULD_NOT_ALLOCATE_PROFILES);
    return 0;
  }

  const char *col;
  const char *ptr = profiles_string;
  do {
    col = strchr(ptr, ':');

    const SRTP_PROTECTION_PROFILE *profile;
    if (!find_profile_by_name(ptr, &profile,
                              col ? (size_t)(col - ptr) : strlen(ptr))) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_SRTP_UNKNOWN_PROTECTION_PROFILE);
      return 0;
    }

    if (!sk_SRTP_PROTECTION_PROFILE_push(profiles.get(), profile)) {
      return 0;
    }

    if (col) {
      ptr = col + 1;
    }
  } while (col);

  *out = std::move(profiles);
  return 1;
}

int SSL_CTX_set_srtp_profiles(SSL_CTX *ctx, const char *profiles) {
  return ssl_ctx_make_profiles(profiles, &ctx->srtp_profiles);
}

int SSL_set_srtp_profiles(SSL *ssl, const char *profiles) {
  return ssl->config != nullptr &&
         ssl_ctx_make_profiles(profiles, &ssl->config->srtp_profiles);
}

const STACK_OF(SRTP_PROTECTION_PROFILE) *SSL_get_srtp_profiles(const SSL *ssl) {
  if (ssl == nullptr) {
    return nullptr;
  }

  if (ssl->config == nullptr) {
    assert(0);
    return nullptr;
  }

  return ssl->config->srtp_profiles != nullptr
             ? ssl->config->srtp_profiles.get()
             : ssl->ctx->srtp_profiles.get();
}

const SRTP_PROTECTION_PROFILE *SSL_get_selected_srtp_profile(SSL *ssl) {
  return ssl->s3->srtp_profile;
}

int SSL_CTX_set_tlsext_use_srtp(SSL_CTX *ctx, const char *profiles) {
  // This API inverts its return value.
  return !SSL_CTX_set_srtp_profiles(ctx, profiles);
}

int SSL_set_tlsext_use_srtp(SSL *ssl, const char *profiles) {
  // This API inverts its return value.
  return !SSL_set_srtp_profiles(ssl, profiles);
}
