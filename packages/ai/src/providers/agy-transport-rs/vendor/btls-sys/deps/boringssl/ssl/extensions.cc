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

#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <utility>

#include <openssl/aead.h>
#include <openssl/bytestring.h>
#include <openssl/chacha.h>
#include <openssl/curve25519.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/hpke.h>
#include <openssl/mem.h>
#include <openssl/nid.h>
#include <openssl/rand.h>

#include "../crypto/internal.h"
#include "../crypto/spake2plus/internal.h"
#include "internal.h"


BSSL_NAMESPACE_BEGIN

static bool ssl_check_clienthello_tlsext(SSL_HANDSHAKE *hs);
static bool ssl_check_serverhello_tlsext(SSL_HANDSHAKE *hs);

// Per http://tools.ietf.org/html/rfc5246#section-7.4.1.4, there may not be
// more than one extension of the same type in a ClientHello or ServerHello.
// This function does an initial scan over the extensions block to filter those
// out.
static bool tls1_check_duplicate_extensions(const CBS *cbs) {
  // First pass: count the extensions.
  size_t num_extensions = 0;
  CBS extensions = *cbs;
  while (CBS_len(&extensions) > 0) {
    uint16_t type;
    CBS extension;

    if (!CBS_get_u16(&extensions, &type) ||
        !CBS_get_u16_length_prefixed(&extensions, &extension)) {
      return false;
    }

    num_extensions++;
  }

  if (num_extensions == 0) {
    return true;
  }

  Array<uint16_t> extension_types;
  if (!extension_types.InitForOverwrite(num_extensions)) {
    return false;
  }

  // Second pass: gather the extension types.
  extensions = *cbs;
  for (size_t i = 0; i < extension_types.size(); i++) {
    CBS extension;

    if (!CBS_get_u16(&extensions, &extension_types[i]) ||
        !CBS_get_u16_length_prefixed(&extensions, &extension)) {
      // This should not happen.
      return false;
    }
  }
  assert(CBS_len(&extensions) == 0);

  // Sort the extensions and make sure there are no duplicates.
  std::sort(extension_types.begin(), extension_types.end());
  for (size_t i = 1; i < num_extensions; i++) {
    if (extension_types[i - 1] == extension_types[i]) {
      return false;
    }
  }

  return true;
}

static bool is_post_quantum_group(uint16_t id) {
  switch (id) {
    case SSL_GROUP_X25519_KYBER768_DRAFT00:
    case SSL_GROUP_X25519_MLKEM768:
    case SSL_GROUP_MLKEM1024:
      return true;
    default:
      return false;
  }
}

bool ssl_parse_client_hello_with_trailing_data(const SSL *ssl, CBS *cbs,
                                               SSL_CLIENT_HELLO *out) {
  OPENSSL_memset(out, 0, sizeof(*out));
  out->ssl = const_cast<SSL *>(ssl);

  CBS copy = *cbs;
  CBS random, session_id;
  if (!CBS_get_u16(cbs, &out->version) ||
      !CBS_get_bytes(cbs, &random, SSL3_RANDOM_SIZE) ||
      !CBS_get_u8_length_prefixed(cbs, &session_id) ||
      CBS_len(&session_id) > SSL_MAX_SSL_SESSION_ID_LENGTH) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_PARSE_FAILED);
    return false;
  }

  out->random = CBS_data(&random);
  out->random_len = CBS_len(&random);
  out->session_id = CBS_data(&session_id);
  out->session_id_len = CBS_len(&session_id);

  if (SSL_is_dtls(out->ssl)) {
    CBS cookie;
    if (!CBS_get_u8_length_prefixed(cbs, &cookie)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_PARSE_FAILED);
      return false;
    }
    out->dtls_cookie = CBS_data(&cookie);
    out->dtls_cookie_len = CBS_len(&cookie);
  } else {
    out->dtls_cookie = nullptr;
    out->dtls_cookie_len = 0;
  }

  CBS cipher_suites, compression_methods;
  if (!CBS_get_u16_length_prefixed(cbs, &cipher_suites) ||
      CBS_len(&cipher_suites) < 2 || (CBS_len(&cipher_suites) & 1) != 0 ||
      !CBS_get_u8_length_prefixed(cbs, &compression_methods) ||
      CBS_len(&compression_methods) < 1) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_PARSE_FAILED);
    return false;
  }

  out->cipher_suites = CBS_data(&cipher_suites);
  out->cipher_suites_len = CBS_len(&cipher_suites);
  out->compression_methods = CBS_data(&compression_methods);
  out->compression_methods_len = CBS_len(&compression_methods);

  // If the ClientHello ends here then it's valid, but doesn't have any
  // extensions.
  if (CBS_len(cbs) == 0) {
    out->extensions = nullptr;
    out->extensions_len = 0;
  } else {
    // Extract extensions and check it is valid.
    CBS extensions;
    if (!CBS_get_u16_length_prefixed(cbs, &extensions) ||
        !tls1_check_duplicate_extensions(&extensions)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_PARSE_FAILED);
      return false;
    }
    out->extensions = CBS_data(&extensions);
    out->extensions_len = CBS_len(&extensions);
  }

  out->client_hello = CBS_data(&copy);
  out->client_hello_len = CBS_len(&copy) - CBS_len(cbs);
  return true;
}

bool ssl_client_hello_get_extension(const SSL_CLIENT_HELLO *client_hello,
                                    CBS *out, uint16_t extension_type) {
  CBS extensions;
  CBS_init(&extensions, client_hello->extensions, client_hello->extensions_len);
  while (CBS_len(&extensions) != 0) {
    // Decode the next extension.
    uint16_t type;
    CBS extension;
    if (!CBS_get_u16(&extensions, &type) ||
        !CBS_get_u16_length_prefixed(&extensions, &extension)) {
      return false;
    }

    if (type == extension_type) {
      *out = extension;
      return true;
    }
  }

  return false;
}

bool tls1_get_shared_group(SSL_HANDSHAKE *hs, uint16_t *out_group_id) {
  SSL *const ssl = hs->ssl;
  assert(ssl->server);

  // Clients are not required to send a supported_groups extension. In this
  // case, the server is free to pick any group it likes. See RFC 4492,
  // section 4, paragraph 3.
  //
  // However, in the interests of compatibility, we will skip ECDH if the
  // client didn't send an extension because we can't be sure that they'll
  // support our favoured group. Thus we do not special-case an empty
  // |peer_supported_group_list|.

  Span<const uint16_t> groups = hs->config->supported_group_list;
  Span<const uint16_t> pref, supp;
  if (ssl->options & SSL_OP_CIPHER_SERVER_PREFERENCE) {
    pref = groups;
    supp = hs->peer_supported_group_list;
  } else {
    pref = hs->peer_supported_group_list;
    supp = groups;
  }

  for (uint16_t pref_group : pref) {
    for (uint16_t supp_group : supp) {
      if (pref_group == supp_group &&
          // Post-quantum key agreements don't fit in the u8-length-prefixed
          // ECPoint field in TLS 1.2 and below.
          (ssl_protocol_version(ssl) >= TLS1_3_VERSION ||
           !is_post_quantum_group(pref_group))) {
        *out_group_id = pref_group;
        return true;
      }
    }
  }

  return false;
}

bool tls1_check_group_id(const SSL_HANDSHAKE *hs, uint16_t group_id) {
  if (is_post_quantum_group(group_id) &&
      ssl_protocol_version(hs->ssl) < TLS1_3_VERSION) {
    // Post-quantum "groups" require TLS 1.3.
    return false;
  }

  // We internally assume zero is never allocated as a group ID.
  if (group_id == 0) {
    return false;
  }

  for (uint16_t supported : hs->config->supported_group_list) {
    if (supported == group_id) {
      return true;
    }
  }

  return false;
}

// kVerifySignatureAlgorithms is the default list of accepted signature
// algorithms for verifying.
static const uint16_t kVerifySignatureAlgorithms[] = {
    // List our preferred algorithms first.
    SSL_SIGN_ECDSA_SECP256R1_SHA256,
    SSL_SIGN_RSA_PSS_RSAE_SHA256,
    SSL_SIGN_RSA_PKCS1_SHA256,

    // Larger hashes are acceptable.
    SSL_SIGN_ECDSA_SECP384R1_SHA384,
    SSL_SIGN_RSA_PSS_RSAE_SHA384,
    SSL_SIGN_RSA_PKCS1_SHA384,

    SSL_SIGN_RSA_PSS_RSAE_SHA512,
    SSL_SIGN_RSA_PKCS1_SHA512,

    // For now, SHA-1 is still accepted but least preferable.
    SSL_SIGN_RSA_PKCS1_SHA1,
};

// kSignSignatureAlgorithms is the default list of supported signature
// algorithms for signing.
static const uint16_t kSignSignatureAlgorithms[] = {
    // List our preferred algorithms first.
    SSL_SIGN_ED25519,
    SSL_SIGN_ECDSA_SECP256R1_SHA256,
    SSL_SIGN_RSA_PSS_RSAE_SHA256,
    SSL_SIGN_RSA_PKCS1_SHA256,

    // If needed, sign larger hashes.
    //
    // TODO(davidben): Determine which of these may be pruned.
    SSL_SIGN_ECDSA_SECP384R1_SHA384,
    SSL_SIGN_RSA_PSS_RSAE_SHA384,
    SSL_SIGN_RSA_PKCS1_SHA384,

    SSL_SIGN_ECDSA_SECP521R1_SHA512,
    SSL_SIGN_RSA_PSS_RSAE_SHA512,
    SSL_SIGN_RSA_PKCS1_SHA512,

    // If the peer supports nothing else, sign with SHA-1.
    SSL_SIGN_ECDSA_SHA1,
    SSL_SIGN_RSA_PKCS1_SHA1,
};

static Span<const uint16_t> tls12_get_verify_sigalgs(const SSL_HANDSHAKE *hs) {
  if (hs->config->verify_sigalgs.empty()) {
    return Span<const uint16_t>(kVerifySignatureAlgorithms);
  }
  return hs->config->verify_sigalgs;
}

bool tls12_add_verify_sigalgs(const SSL_HANDSHAKE *hs, CBB *out) {
  for (uint16_t sigalg : tls12_get_verify_sigalgs(hs)) {
    if (!CBB_add_u16(out, sigalg)) {
      return false;
    }
  }
  return true;
}

bool tls12_check_peer_sigalg(const SSL_HANDSHAKE *hs, uint8_t *out_alert,
                             uint16_t sigalg, EVP_PKEY *pkey) {
  // The peer must have selected an algorithm that is consistent with its public
  // key, the TLS version, and what we advertised.
  Span<const uint16_t> sigalgs = tls12_get_verify_sigalgs(hs);
  if (std::find(sigalgs.begin(), sigalgs.end(), sigalg) == sigalgs.end() ||
      !ssl_pkey_supports_algorithm(hs->ssl, pkey, sigalg, /*is_verify=*/true)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_SIGNATURE_TYPE);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  return true;
}

// Flags.
//
// https://www.ietf.org/archive/id/draft-ietf-tls-tlsflags-14.html

bool ssl_add_flags_extension(CBB *cbb, SSLFlags flags) {
  if (flags == 0) {
    return true;
  }

  CBB body, child;
  if (!CBB_add_u16(cbb, TLSEXT_TYPE_tls_flags) ||
      !CBB_add_u16_length_prefixed(cbb, &body) ||
      !CBB_add_u8_length_prefixed(&body, &child)) {
    return false;
  }

  while (flags != 0) {
    if (!CBB_add_u8(&child, static_cast<uint8_t>(flags))) {
      return false;
    }
    flags >>= 8;
  }

  return CBB_flush(cbb);
}

static bool ssl_parse_flags_extension(const CBS *cbs, SSLFlags *out,
                                      uint8_t *out_alert, bool allow_unknown) {
  CBS copy = *cbs, flags;
  if (!CBS_get_u8_length_prefixed(&copy, &flags) ||  //
      CBS_len(&copy) != 0 ||                         //
      CBS_len(&flags) == 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // There may not be any trailing zeros.
  if (CBS_data(&flags)[CBS_len(&flags) - 1] == 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // We can only represent flags that fit in SSLFlags, so any bits beyond that
  // are necessarily unsolicited. Unsolicited flags are allowed in CH, CR, and
  // NST, but forbidden in SH, EE, CT, and HRR. See Section 3 of
  // draft-ietf-tls-tlsflags-14.
  if (!allow_unknown && CBS_len(&flags) > sizeof(SSLFlags)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // We currently use the same in-memory and wire representation for flags.
  uint8_t padded[sizeof(SSLFlags)] = {0};
  OPENSSL_memcpy(padded, CBS_data(&flags),
                 std::min(CBS_len(&flags), size_t{4}));
  static_assert(sizeof(SSLFlags) == sizeof(uint32_t),
                "We currently assume SSLFlags is 32-bit");
  *out = CRYPTO_load_u32_le(padded);
  return true;
}

bool ssl_parse_flags_extension_request(const CBS *cbs, SSLFlags *out,
                                       uint8_t *out_alert) {
  // In a request message, unsolicited flags are allowed and ignored.
  return ssl_parse_flags_extension(cbs, out, out_alert,
                                   /*allow_unknown=*/true);
}

bool ssl_parse_flags_extension_response(const CBS *cbs, SSLFlags *out,
                                        uint8_t *out_alert,
                                        SSLFlags allowed_flags) {
  // In a response message, unsolicited flags are not allowed.
  if (!ssl_parse_flags_extension(cbs, out, out_alert,
                                 /*allow_unknown=*/false)) {
    return false;
  }

  // Check for unsolicited flags that fit in |SSLFlags|.
  if ((*out & allowed_flags) != *out) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  return true;
}

// tls_extension represents a TLS extension that is handled internally.
//
// The parse callbacks receive a |CBS| that contains the contents of the
// extension (i.e. not including the type and length bytes). If an extension is
// not received then the parse callbacks will be called with a NULL CBS so that
// they can do any processing needed to handle the absence of an extension.
//
// The add callbacks receive a |CBB| to which the extension can be appended but
// the function is responsible for appending the type and length bytes too.
//
// |add_clienthello| may be called multiple times and must not mutate |hs|. It
// is additionally passed two output |CBB|s. If the extension is the same
// independent of the value of |type|, the callback may write to
// |out_compressible| instead of |out|. When serializing the ClientHelloInner,
// all compressible extensions will be made contiguous and replaced with
// ech_outer_extensions when encrypted. When serializing the ClientHelloOuter
// or not offering ECH, |out| will be equal to |out_compressible|, so writing to
// |out_compressible| still works.
//
// Note the |parse_serverhello| and |add_serverhello| callbacks refer to the
// TLS 1.2 ServerHello. In TLS 1.3, these callbacks act on EncryptedExtensions,
// with ServerHello extensions handled elsewhere in the handshake.
//
// All callbacks return true for success and false for error. If a parse
// function returns zero then a fatal alert with value |*out_alert| will be
// sent. If |*out_alert| isn't set, then a |decode_error| alert will be sent.
struct tls_extension {
  uint16_t value;

  bool (*add_clienthello)(const SSL_HANDSHAKE *hs, CBB *out,
                          CBB *out_compressible, ssl_client_hello_type_t type);
  bool (*parse_serverhello)(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                            CBS *contents);

  bool (*parse_clienthello)(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                            CBS *contents);
  bool (*add_serverhello)(SSL_HANDSHAKE *hs, CBB *out);
};

static bool forbid_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                     CBS *contents) {
  if (contents != nullptr) {
    // Servers MUST NOT send this extension.
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    return false;
  }

  return true;
}

static bool ignore_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                     CBS *contents) {
  // This extension from the client is handled elsewhere.
  return true;
}

static bool dont_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) { return true; }

// Server name indication (SNI).
//
// https://tools.ietf.org/html/rfc6066#section-3.

static bool ext_sni_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                    CBB *out_compressible,
                                    ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  // If offering ECH, send the public name instead of the configured name.
  Span<const uint8_t> hostname;
  if (type == ssl_client_hello_outer) {
    hostname = hs->selected_ech_config->public_name;
  } else {
    if (ssl->hostname == nullptr) {
      return true;
    }
    hostname = StringAsBytes(ssl->hostname.get());
  }

  CBB contents, server_name_list, name;
  if (!CBB_add_u16(out, TLSEXT_TYPE_server_name) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &server_name_list) ||
      !CBB_add_u8(&server_name_list, TLSEXT_NAMETYPE_host_name) ||
      !CBB_add_u16_length_prefixed(&server_name_list, &name) ||
      !CBB_add_bytes(&name, hostname.data(), hostname.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_sni_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  // The server may acknowledge SNI with an empty extension. We check the syntax
  // but otherwise ignore this signal.
  return contents == nullptr || CBS_len(contents) == 0;
}

static bool ext_sni_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  // SNI has already been parsed earlier in the handshake. See |extract_sni|.
  return true;
}

static bool ext_sni_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  // RFC 6066 says "When resuming a session, the server MUST NOT include a
  // server_name extension in the server hello."
  if (hs->ssl->s3->session_reused ||  //
      !hs->should_ack_sni) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_server_name) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}


// Encrypted ClientHello (ECH)
//
// https://tools.ietf.org/html/draft-ietf-tls-esni-13

static bool ext_ech_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                    CBB *out_compressible,
                                    ssl_client_hello_type_t type) {
  if (type == ssl_client_hello_inner) {
    if (!CBB_add_u16(out, TLSEXT_TYPE_encrypted_client_hello) ||
        !CBB_add_u16(out, /* length */ 1) ||
        !CBB_add_u8(out, ECH_CLIENT_INNER)) {
      return false;
    }
    return true;
  }

  if (hs->ech_client_outer.empty()) {
    return true;
  }

  CBB ech_body;
  if (!CBB_add_u16(out, TLSEXT_TYPE_encrypted_client_hello) ||
      !CBB_add_u16_length_prefixed(out, &ech_body) ||
      !CBB_add_u8(&ech_body, ECH_CLIENT_OUTER) ||
      !CBB_add_bytes(&ech_body, hs->ech_client_outer.data(),
                     hs->ech_client_outer.size()) ||
      !CBB_flush(out)) {
    return false;
  }
  return true;
}

static bool ext_ech_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  // The ECH extension may not be sent in TLS 1.2 ServerHello, only TLS 1.3
  // EncryptedExtensions. It also may not be sent in response to an inner ECH
  // extension.
  if (ssl_protocol_version(ssl) < TLS1_3_VERSION ||
      ssl->s3->ech_status == ssl_ech_accepted) {
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    return false;
  }

  if (!ssl_is_valid_ech_config_list(*contents)) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  if (ssl->s3->ech_status == ssl_ech_rejected &&
      !hs->ech_retry_configs.CopyFrom(*contents)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  return true;
}

static bool ext_ech_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  uint8_t type;
  if (!CBS_get_u8(contents, &type)) {
    return false;
  }
  if (type == ECH_CLIENT_OUTER) {
    // Outer ECH extensions are handled outside the callback.
    return true;
  }
  if (type != ECH_CLIENT_INNER || CBS_len(contents) != 0) {
    return false;
  }

  hs->ech_is_inner = true;
  return true;
}

static bool ext_ech_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) < TLS1_3_VERSION ||
      ssl->s3->ech_status == ssl_ech_accepted ||  //
      hs->ech_keys == nullptr) {
    return true;
  }

  // Write the list of retry configs to |out|. Note |SSL_CTX_set1_ech_keys|
  // ensures |ech_keys| contains at least one retry config.
  CBB body, retry_configs;
  if (!CBB_add_u16(out, TLSEXT_TYPE_encrypted_client_hello) ||
      !CBB_add_u16_length_prefixed(out, &body) ||
      !CBB_add_u16_length_prefixed(&body, &retry_configs)) {
    return false;
  }
  for (const auto &config : hs->ech_keys->configs) {
    if (!config->is_retry_config()) {
      continue;
    }
    if (!CBB_add_bytes(&retry_configs, config->ech_config().raw.data(),
                       config->ech_config().raw.size())) {
      return false;
    }
  }
  return CBB_flush(out);
}


// Renegotiation indication.
//
// https://tools.ietf.org/html/rfc5746

static bool ext_ri_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                   CBB *out_compressible,
                                   ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  // Renegotiation indication is not necessary in TLS 1.3.
  if (hs->min_version >= TLS1_3_VERSION ||  //
      type == ssl_client_hello_inner) {
    return true;
  }

  assert(ssl->s3->initial_handshake_complete ==
         !ssl->s3->previous_client_finished.empty());

  CBB contents, prev_finished;
  if (!CBB_add_u16(out, TLSEXT_TYPE_renegotiate) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u8_length_prefixed(&contents, &prev_finished) ||
      !CBB_add_bytes(&prev_finished, ssl->s3->previous_client_finished.data(),
                     ssl->s3->previous_client_finished.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_ri_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                     CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents != nullptr && ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // Servers may not switch between omitting the extension and supporting it.
  // See RFC 5746, sections 3.5 and 4.2.
  if (ssl->s3->initial_handshake_complete &&
      (contents != nullptr) != ssl->s3->send_connection_binding) {
    *out_alert = SSL_AD_HANDSHAKE_FAILURE;
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_MISMATCH);
    return false;
  }

  if (contents == nullptr) {
    // Strictly speaking, if we want to avoid an attack we should *always* see
    // RI even on initial ServerHello because the client doesn't see any
    // renegotiation during an attack. However this would mean we could not
    // connect to any server which doesn't support RI.
    //
    // OpenSSL has |SSL_OP_LEGACY_SERVER_CONNECT| to control this, but in
    // practical terms every client sets it so it's just assumed here.
    return true;
  }

  // Check for logic errors.
  assert(ssl->s3->previous_client_finished.size() ==
         ssl->s3->previous_server_finished.size());
  assert(ssl->s3->initial_handshake_complete ==
         !ssl->s3->previous_client_finished.empty());

  // Parse out the extension contents.
  CBS renegotiated_connection;
  if (!CBS_get_u8_length_prefixed(contents, &renegotiated_connection) ||
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_ENCODING_ERR);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // Check that the extension matches.
  CBS client_verify, server_verify;
  if (!CBS_get_bytes(&renegotiated_connection, &client_verify,
                     ssl->s3->previous_client_finished.size()) ||
      !CBS_get_bytes(&renegotiated_connection, &server_verify,
                     ssl->s3->previous_server_finished.size()) ||
      CBS_len(&renegotiated_connection) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_MISMATCH);
    *out_alert = SSL_AD_HANDSHAKE_FAILURE;
    return false;
  }

  bool ok =
      CBS_mem_equal(&client_verify, ssl->s3->previous_client_finished.data(),
                    ssl->s3->previous_client_finished.size()) &&
      CBS_mem_equal(&server_verify, ssl->s3->previous_server_finished.data(),
                    ssl->s3->previous_server_finished.size());
  if (CRYPTO_fuzzer_mode_enabled()) {
    ok = true;
  }
  if (!ok) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_MISMATCH);
    *out_alert = SSL_AD_HANDSHAKE_FAILURE;
    return false;
  }

  ssl->s3->send_connection_binding = true;
  return true;
}

static bool ext_ri_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                     CBS *contents) {
  SSL *const ssl = hs->ssl;
  // Renegotiation isn't supported as a server so this function should never be
  // called after the initial handshake.
  assert(!ssl->s3->initial_handshake_complete);

  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return true;
  }

  if (contents == nullptr) {
    return true;
  }

  CBS renegotiated_connection;
  if (!CBS_get_u8_length_prefixed(contents, &renegotiated_connection) ||
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_ENCODING_ERR);
    return false;
  }

  // Check that the extension matches. We do not support renegotiation as a
  // server, so this must be empty.
  if (CBS_len(&renegotiated_connection) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_MISMATCH);
    *out_alert = SSL_AD_HANDSHAKE_FAILURE;
    return false;
  }

  ssl->s3->send_connection_binding = true;

  return true;
}

static bool ext_ri_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  // Renegotiation isn't supported as a server so this function should never be
  // called after the initial handshake.
  assert(!ssl->s3->initial_handshake_complete);

  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_renegotiate) ||
      !CBB_add_u16(out, 1 /* length */) ||
      !CBB_add_u8(out, 0 /* empty renegotiation info */)) {
    return false;
  }

  return true;
}


// Extended Master Secret.
//
// https://tools.ietf.org/html/rfc7627

static bool ext_ems_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                    CBB *out_compressible,
                                    ssl_client_hello_type_t type) {
  // Extended master secret is not necessary in TLS 1.3.
  if (hs->min_version >= TLS1_3_VERSION || type == ssl_client_hello_inner) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_extended_master_secret) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}

static bool ext_ems_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  SSL *const ssl = hs->ssl;

  if (contents != nullptr) {
    if (ssl_protocol_version(ssl) >= TLS1_3_VERSION ||  //
        CBS_len(contents) != 0) {
      return false;
    }

    hs->extended_master_secret = true;
  }

  // Whether EMS is negotiated may not change on renegotiation.
  if (ssl->s3->established_session != nullptr &&
      hs->extended_master_secret !=
          !!ssl->s3->established_session->extended_master_secret) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_RENEGOTIATION_EMS_MISMATCH);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  return true;
}

static bool ext_ems_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  if (ssl_protocol_version(hs->ssl) >= TLS1_3_VERSION) {
    return true;
  }

  if (contents == nullptr) {
    return true;
  }

  if (CBS_len(contents) != 0) {
    return false;
  }

  hs->extended_master_secret = true;
  return true;
}

static bool ext_ems_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (!hs->extended_master_secret) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_extended_master_secret) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}


// Session tickets.
//
// https://tools.ietf.org/html/rfc5077

static bool ext_ticket_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                       CBB *out_compressible,
                                       ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  // TLS 1.3 uses a different ticket extension.
  if (hs->min_version >= TLS1_3_VERSION || type == ssl_client_hello_inner ||
      SSL_get_options(ssl) & SSL_OP_NO_TICKET) {
    return true;
  }

  // Renegotiation does not participate in session resumption. However, still
  // advertise the extension to avoid potentially breaking servers which carry
  // over the state from the previous handshake, such as OpenSSL servers
  // without upstream's 3c3f0259238594d77264a78944d409f2127642c4.
  Span<const uint8_t> ticket;
  if (!ssl->s3->initial_handshake_complete &&  //
      ssl->session != nullptr &&
      ssl_session_get_type(ssl->session.get()) == SSLSessionType::kTicket) {
    ticket = ssl->session->ticket;
  }

  CBB ticket_cbb;
  if (!CBB_add_u16(out, TLSEXT_TYPE_session_ticket) ||
      !CBB_add_u16_length_prefixed(out, &ticket_cbb) ||
      !CBB_add_bytes(&ticket_cbb, ticket.data(), ticket.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_ticket_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                         CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return false;
  }

  // If |SSL_OP_NO_TICKET| is set then no extension will have been sent and
  // this function should never be called, even if the server tries to send the
  // extension.
  assert((SSL_get_options(ssl) & SSL_OP_NO_TICKET) == 0);

  if (CBS_len(contents) != 0) {
    return false;
  }

  hs->ticket_expected = true;
  return true;
}

static bool ext_ticket_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (!hs->ticket_expected) {
    return true;
  }

  // If |SSL_OP_NO_TICKET| is set, |ticket_expected| should never be true.
  assert((SSL_get_options(hs->ssl) & SSL_OP_NO_TICKET) == 0);

  if (!CBB_add_u16(out, TLSEXT_TYPE_session_ticket) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}


// Signature Algorithms.
//
// https://tools.ietf.org/html/rfc5246#section-7.4.1.4.1

static bool ext_sigalgs_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                        CBB *out_compressible,
                                        ssl_client_hello_type_t type) {
  if (hs->max_version < TLS1_2_VERSION) {
    return true;
  }
  // In PAKE mode, signature_algorithms is not used.
  if (hs->pake_prover != nullptr) {
    return true;
  }

  CBB contents, sigalgs_cbb;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_signature_algorithms) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &sigalgs_cbb) ||
      !tls12_add_verify_sigalgs(hs, &sigalgs_cbb) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

static bool ext_sigalgs_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                          CBS *contents) {
  hs->peer_sigalgs.Reset();
  if (contents == nullptr) {
    return true;
  }

  CBS supported_signature_algorithms;
  if (!CBS_get_u16_length_prefixed(contents, &supported_signature_algorithms) ||
      CBS_len(contents) != 0 ||
      !tls1_parse_peer_sigalgs(hs, &supported_signature_algorithms)) {
    return false;
  }

  return true;
}


// OCSP Stapling.
//
// https://tools.ietf.org/html/rfc6066#section-8

static bool ext_ocsp_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                     CBB *out_compressible,
                                     ssl_client_hello_type_t type) {
  if (!hs->config->ocsp_stapling_enabled) {
    return true;
  }

  CBB contents;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_status_request) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u8(&contents, TLSEXT_STATUSTYPE_ocsp) ||
      !CBB_add_u16(&contents, 0 /* empty responder ID list */) ||
      !CBB_add_u16(&contents, 0 /* empty request extensions */) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

static bool ext_ocsp_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  // TLS 1.3 OCSP responses are included in the Certificate extensions.
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return false;
  }

  // OCSP stapling is forbidden on non-certificate ciphers.
  if (CBS_len(contents) != 0 ||
      !ssl_cipher_uses_certificate_auth(hs->new_cipher)) {
    return false;
  }

  // Note this does not check for resumption in TLS 1.2. Sending
  // status_request here does not make sense, but OpenSSL does so and the
  // specification does not say anything. Tolerate it but ignore it.

  hs->certificate_status_expected = true;
  return true;
}

static bool ext_ocsp_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  uint8_t status_type;
  if (!CBS_get_u8(contents, &status_type)) {
    return false;
  }

  // We cannot decide whether OCSP stapling will occur yet because the correct
  // SSL_CTX might not have been selected.
  hs->ocsp_stapling_requested = status_type == TLSEXT_STATUSTYPE_ocsp;

  return true;
}

static bool ext_ocsp_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION ||
      !hs->ocsp_stapling_requested || ssl->s3->session_reused ||
      !ssl_cipher_uses_certificate_auth(hs->new_cipher) ||
      hs->credential->ocsp_response == nullptr) {
    return true;
  }

  hs->certificate_status_expected = true;

  return CBB_add_u16(out, TLSEXT_TYPE_status_request) &&
         CBB_add_u16(out, 0 /* length */);
}


// Next protocol negotiation.
//
// https://htmlpreview.github.io/?https://github.com/agl/technotes/blob/master/nextprotoneg.html

static bool ext_npn_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                    CBB *out_compressible,
                                    ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (ssl->ctx->next_proto_select_cb == nullptr ||
      // Do not allow NPN to change on renegotiation.
      ssl->s3->initial_handshake_complete ||
      // NPN is not defined in DTLS or TLS 1.3.
      SSL_is_dtls(ssl) || hs->min_version >= TLS1_3_VERSION ||
      type == ssl_client_hello_inner) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_next_proto_neg) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}

static bool ext_npn_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return false;
  }

  // If any of these are false then we should never have sent the NPN
  // extension in the ClientHello and thus this function should never have been
  // called.
  assert(!ssl->s3->initial_handshake_complete);
  assert(!SSL_is_dtls(ssl));
  assert(ssl->ctx->next_proto_select_cb != nullptr);

  if (!ssl->s3->alpn_selected.empty()) {
    // NPN and ALPN may not be negotiated in the same connection.
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    OPENSSL_PUT_ERROR(SSL, SSL_R_NEGOTIATED_BOTH_NPN_AND_ALPN);
    return false;
  }

  const uint8_t *const orig_contents = CBS_data(contents);
  const size_t orig_len = CBS_len(contents);

  while (CBS_len(contents) != 0) {
    CBS proto;
    if (!CBS_get_u8_length_prefixed(contents, &proto) ||  //
        CBS_len(&proto) == 0) {
      return false;
    }
  }

  // |orig_len| fits in |unsigned| because TLS extensions use 16-bit lengths.
  uint8_t *selected;
  uint8_t selected_len;
  if (ssl->ctx->next_proto_select_cb(
          ssl, &selected, &selected_len, orig_contents,
          static_cast<unsigned>(orig_len),
          ssl->ctx->next_proto_select_cb_arg) != SSL_TLSEXT_ERR_OK ||
      !ssl->s3->next_proto_negotiated.CopyFrom(Span(selected, selected_len))) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  hs->next_proto_neg_seen = true;
  return true;
}

static bool ext_npn_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return true;
  }

  if (contents != nullptr && CBS_len(contents) != 0) {
    return false;
  }

  if (contents == nullptr ||                             //
      ssl->s3->initial_handshake_complete ||             //
      ssl->ctx->next_protos_advertised_cb == nullptr ||  //
      SSL_is_dtls(ssl)) {
    return true;
  }

  hs->next_proto_neg_seen = true;
  return true;
}

static bool ext_npn_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  // |next_proto_neg_seen| might have been cleared when an ALPN extension was
  // parsed.
  if (!hs->next_proto_neg_seen) {
    return true;
  }

  const uint8_t *npa;
  unsigned npa_len;

  if (ssl->ctx->next_protos_advertised_cb(
          ssl, &npa, &npa_len, ssl->ctx->next_protos_advertised_cb_arg) !=
      SSL_TLSEXT_ERR_OK) {
    hs->next_proto_neg_seen = false;
    return true;
  }

  CBB contents;
  if (!CBB_add_u16(out, TLSEXT_TYPE_next_proto_neg) ||  //
      !CBB_add_u16_length_prefixed(out, &contents) ||   //
      !CBB_add_bytes(&contents, npa, npa_len) ||        //
      !CBB_flush(out)) {
    return false;
  }

  return true;
}


// Signed certificate timestamps.
//
// https://tools.ietf.org/html/rfc6962#section-3.3.1

static bool ext_sct_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                    CBB *out_compressible,
                                    ssl_client_hello_type_t type) {
  if (!hs->config->signed_cert_timestamps_enabled) {
    return true;
  }

  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_certificate_timestamp) ||
      !CBB_add_u16(out_compressible, 0 /* length */)) {
    return false;
  }

  return true;
}

static bool ext_sct_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  // TLS 1.3 SCTs are included in the Certificate extensions.
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // If this is false then we should never have sent the SCT extension in the
  // ClientHello and thus this function should never have been called.
  assert(hs->config->signed_cert_timestamps_enabled);

  if (!ssl_is_sct_list_valid(contents)) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // Session resumption uses the original session information. The extension
  // should not be sent on resumption, but RFC 6962 did not make it a
  // requirement, so tolerate this.
  //
  // TODO(davidben): Enforce this anyway.
  if (!ssl->s3->session_reused) {
    hs->new_session->signed_cert_timestamp_list.reset(
        CRYPTO_BUFFER_new_from_CBS(contents, ssl->ctx->pool));
    if (hs->new_session->signed_cert_timestamp_list == nullptr) {
      *out_alert = SSL_AD_INTERNAL_ERROR;
      return false;
    }
  }

  return true;
}

static bool ext_sct_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                      CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  if (CBS_len(contents) != 0) {
    return false;
  }

  hs->scts_requested = true;
  return true;
}

static bool ext_sct_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  assert(hs->scts_requested);
  // The extension shouldn't be sent when resuming sessions.
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION || ssl->s3->session_reused ||
      !ssl_cipher_uses_certificate_auth(hs->new_cipher) ||
      hs->credential->signed_cert_timestamp_list == nullptr) {
    return true;
  }

  CBB contents;
  return CBB_add_u16(out, TLSEXT_TYPE_certificate_timestamp) &&
         CBB_add_u16_length_prefixed(out, &contents) &&
         CBB_add_bytes(&contents,
                       CRYPTO_BUFFER_data(
                           hs->credential->signed_cert_timestamp_list.get()),
                       CRYPTO_BUFFER_len(
                           hs->credential->signed_cert_timestamp_list.get())) &&
         CBB_flush(out);
}


// Application-level Protocol Negotiation.
//
// https://tools.ietf.org/html/rfc7301

static bool ext_alpn_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                     CBB *out_compressible,
                                     ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (hs->config->alpn_client_proto_list.empty() && SSL_is_quic(ssl)) {
    // ALPN MUST be used with QUIC.
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_APPLICATION_PROTOCOL);
    return false;
  }

  if (hs->config->alpn_client_proto_list.empty() ||
      ssl->s3->initial_handshake_complete) {
    return true;
  }

  CBB contents, proto_list;
  if (!CBB_add_u16(out_compressible,
                   TLSEXT_TYPE_application_layer_protocol_negotiation) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &proto_list) ||
      !CBB_add_bytes(&proto_list, hs->config->alpn_client_proto_list.data(),
                     hs->config->alpn_client_proto_list.size()) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

static bool ext_alpn_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    if (SSL_is_quic(ssl)) {
      // ALPN is required when QUIC is used.
      OPENSSL_PUT_ERROR(SSL, SSL_R_NO_APPLICATION_PROTOCOL);
      *out_alert = SSL_AD_NO_APPLICATION_PROTOCOL;
      return false;
    }
    return true;
  }

  assert(!ssl->s3->initial_handshake_complete);
  assert(!hs->config->alpn_client_proto_list.empty());

  if (hs->next_proto_neg_seen) {
    // NPN and ALPN may not be negotiated in the same connection.
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    OPENSSL_PUT_ERROR(SSL, SSL_R_NEGOTIATED_BOTH_NPN_AND_ALPN);
    return false;
  }

  // The extension data consists of a ProtocolNameList which must have
  // exactly one ProtocolName. Each of these is length-prefixed.
  CBS protocol_name_list, protocol_name;
  if (!CBS_get_u16_length_prefixed(contents, &protocol_name_list) ||       //
      CBS_len(contents) != 0 ||                                            //
      !CBS_get_u8_length_prefixed(&protocol_name_list, &protocol_name) ||  //
      // Empty protocol names are forbidden.
      CBS_len(&protocol_name) == 0 ||  //
      CBS_len(&protocol_name_list) != 0) {
    return false;
  }

  if (!ssl_is_alpn_protocol_allowed(hs, protocol_name)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_ALPN_PROTOCOL);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  if (!ssl->s3->alpn_selected.CopyFrom(protocol_name)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  return true;
}

bool ssl_is_valid_alpn_list(Span<const uint8_t> in) {
  CBS protocol_name_list = in;
  if (CBS_len(&protocol_name_list) == 0) {
    return false;
  }
  while (CBS_len(&protocol_name_list) > 0) {
    CBS protocol_name;
    if (!CBS_get_u8_length_prefixed(&protocol_name_list, &protocol_name) ||
        // Empty protocol names are forbidden.
        CBS_len(&protocol_name) == 0) {
      return false;
    }
  }
  return true;
}

bool ssl_is_alpn_protocol_allowed(const SSL_HANDSHAKE *hs,
                                  Span<const uint8_t> protocol) {
  if (hs->config->alpn_client_proto_list.empty()) {
    return false;
  }

  if (hs->ssl->ctx->allow_unknown_alpn_protos) {
    return true;
  }

  // Check that the protocol name is one of the ones we advertised.
  return ssl_alpn_list_contains_protocol(hs->config->alpn_client_proto_list,
                                         protocol);
}

bool ssl_alpn_list_contains_protocol(Span<const uint8_t> list,
                                     Span<const uint8_t> protocol) {
  CBS cbs = list, candidate;
  while (CBS_len(&cbs) > 0) {
    if (!CBS_get_u8_length_prefixed(&cbs, &candidate)) {
      return false;
    }

    if (candidate == protocol) {
      return true;
    }
  }

  return false;
}

bool ssl_negotiate_alpn(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                        const SSL_CLIENT_HELLO *client_hello) {
  SSL *const ssl = hs->ssl;
  CBS contents;
  if (ssl->ctx->alpn_select_cb == nullptr ||
      !ssl_client_hello_get_extension(
          client_hello, &contents,
          TLSEXT_TYPE_application_layer_protocol_negotiation)) {
    if (SSL_is_quic(ssl)) {
      // ALPN is required when QUIC is used.
      OPENSSL_PUT_ERROR(SSL, SSL_R_NO_APPLICATION_PROTOCOL);
      *out_alert = SSL_AD_NO_APPLICATION_PROTOCOL;
      return false;
    }
    // Ignore ALPN if not configured or no extension was supplied.
    return true;
  }

  // ALPN takes precedence over NPN.
  hs->next_proto_neg_seen = false;

  CBS protocol_name_list;
  if (!CBS_get_u16_length_prefixed(&contents, &protocol_name_list) ||  //
      CBS_len(&contents) != 0 ||                                       //
      !ssl_is_valid_alpn_list(protocol_name_list)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PARSE_TLSEXT);
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // |protocol_name_list| fits in |unsigned| because TLS extensions use 16-bit
  // lengths.
  const uint8_t *selected;
  uint8_t selected_len;
  int ret = ssl->ctx->alpn_select_cb(
      ssl, &selected, &selected_len, CBS_data(&protocol_name_list),
      static_cast<unsigned>(CBS_len(&protocol_name_list)),
      ssl->ctx->alpn_select_cb_arg);
  // ALPN is required when QUIC is used.
  if (SSL_is_quic(ssl) &&
      (ret == SSL_TLSEXT_ERR_NOACK || ret == SSL_TLSEXT_ERR_ALERT_WARNING)) {
    ret = SSL_TLSEXT_ERR_ALERT_FATAL;
  }
  switch (ret) {
    case SSL_TLSEXT_ERR_OK:
      if (selected_len == 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_ALPN_PROTOCOL);
        *out_alert = SSL_AD_INTERNAL_ERROR;
        return false;
      }
      if (!ssl->s3->alpn_selected.CopyFrom(Span(selected, selected_len))) {
        *out_alert = SSL_AD_INTERNAL_ERROR;
        return false;
      }
      break;
    case SSL_TLSEXT_ERR_NOACK:
    case SSL_TLSEXT_ERR_ALERT_WARNING:
      break;
    case SSL_TLSEXT_ERR_ALERT_FATAL:
      *out_alert = SSL_AD_NO_APPLICATION_PROTOCOL;
      OPENSSL_PUT_ERROR(SSL, SSL_R_NO_APPLICATION_PROTOCOL);
      return false;
    default:
      // Invalid return value.
      *out_alert = SSL_AD_INTERNAL_ERROR;
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return false;
  }

  return true;
}

static bool ext_alpn_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl->s3->alpn_selected.empty()) {
    return true;
  }

  CBB contents, proto_list, proto;
  if (!CBB_add_u16(out, TLSEXT_TYPE_application_layer_protocol_negotiation) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &proto_list) ||
      !CBB_add_u8_length_prefixed(&proto_list, &proto) ||
      !CBB_add_bytes(&proto, ssl->s3->alpn_selected.data(),
                     ssl->s3->alpn_selected.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}


// Channel ID.
//
// https://tools.ietf.org/html/draft-balfanz-tls-channelid-01

static bool ext_channel_id_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                           CBB *out_compressible,
                                           ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (!hs->config->channel_id_private || SSL_is_dtls(ssl) ||
      // Don't offer Channel ID in ClientHelloOuter. ClientHelloOuter handshakes
      // are not authenticated for the name that can learn the Channel ID.
      //
      // We could alternatively offer the extension but sign with a random key.
      // For other extensions, we try to align |ssl_client_hello_outer| and
      // |ssl_client_hello_unencrypted|, to improve the effectiveness of ECH
      // GREASE. However, Channel ID is deprecated and unlikely to be used with
      // ECH, so do the simplest thing.
      type == ssl_client_hello_outer) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_channel_id) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}

static bool ext_channel_id_parse_serverhello(SSL_HANDSHAKE *hs,
                                             uint8_t *out_alert,
                                             CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  assert(!SSL_is_dtls(hs->ssl));
  assert(hs->config->channel_id_private);

  if (CBS_len(contents) != 0) {
    return false;
  }

  hs->channel_id_negotiated = true;
  return true;
}

static bool ext_channel_id_parse_clienthello(SSL_HANDSHAKE *hs,
                                             uint8_t *out_alert,
                                             CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr || !hs->config->channel_id_enabled ||
      SSL_is_dtls(ssl)) {
    return true;
  }

  if (CBS_len(contents) != 0) {
    return false;
  }

  hs->channel_id_negotiated = true;
  return true;
}

static bool ext_channel_id_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (!hs->channel_id_negotiated) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_channel_id) ||
      !CBB_add_u16(out, 0 /* length */)) {
    return false;
  }

  return true;
}


// Secure Real-time Transport Protocol (SRTP) extension.
//
// https://tools.ietf.org/html/rfc5764

static bool ext_srtp_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                     CBB *out_compressible,
                                     ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  const STACK_OF(SRTP_PROTECTION_PROFILE) *profiles =
      SSL_get_srtp_profiles(ssl);
  if (profiles == nullptr ||                            //
      sk_SRTP_PROTECTION_PROFILE_num(profiles) == 0 ||  //
      !SSL_is_dtls(ssl)) {
    return true;
  }

  CBB contents, profile_ids;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_srtp) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &profile_ids)) {
    return false;
  }

  for (const SRTP_PROTECTION_PROFILE *profile : profiles) {
    if (!CBB_add_u16(&profile_ids, profile->id)) {
      return false;
    }
  }

  if (!CBB_add_u8(&contents, 0 /* empty use_mki value */) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

static bool ext_srtp_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  // The extension consists of a u16-prefixed profile ID list containing a
  // single uint16_t profile ID, then followed by a u8-prefixed srtp_mki field.
  //
  // See https://tools.ietf.org/html/rfc5764#section-4.1.1
  assert(SSL_is_dtls(ssl));
  CBS profile_ids, srtp_mki;
  uint16_t profile_id;
  if (!CBS_get_u16_length_prefixed(contents, &profile_ids) ||  //
      !CBS_get_u16(&profile_ids, &profile_id) ||               //
      CBS_len(&profile_ids) != 0 ||                            //
      !CBS_get_u8_length_prefixed(contents, &srtp_mki) ||      //
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SRTP_PROTECTION_PROFILE_LIST);
    return false;
  }

  if (CBS_len(&srtp_mki) != 0) {
    // Must be no MKI, since we never offer one.
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SRTP_MKI_VALUE);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // Check to see if the server gave us something we support and offered.
  for (const SRTP_PROTECTION_PROFILE *profile : SSL_get_srtp_profiles(ssl)) {
    if (profile->id == profile_id) {
      ssl->s3->srtp_profile = profile;
      return true;
    }
  }

  OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SRTP_PROTECTION_PROFILE_LIST);
  *out_alert = SSL_AD_ILLEGAL_PARAMETER;
  return false;
}

static bool ext_srtp_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  SSL *const ssl = hs->ssl;
  // DTLS-SRTP is only defined for DTLS.
  if (contents == nullptr || !SSL_is_dtls(ssl)) {
    return true;
  }

  CBS profile_ids, srtp_mki;
  if (!CBS_get_u16_length_prefixed(contents, &profile_ids) ||
      CBS_len(&profile_ids) < 2 ||
      !CBS_get_u8_length_prefixed(contents, &srtp_mki) ||
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_SRTP_PROTECTION_PROFILE_LIST);
    return false;
  }
  // Discard the MKI value for now.

  const STACK_OF(SRTP_PROTECTION_PROFILE) *server_profiles =
      SSL_get_srtp_profiles(ssl);

  // Pick the server's most preferred profile.
  for (const SRTP_PROTECTION_PROFILE *server_profile : server_profiles) {
    CBS profile_ids_tmp;
    CBS_init(&profile_ids_tmp, CBS_data(&profile_ids), CBS_len(&profile_ids));

    while (CBS_len(&profile_ids_tmp) > 0) {
      uint16_t profile_id;
      if (!CBS_get_u16(&profile_ids_tmp, &profile_id)) {
        return false;
      }

      if (server_profile->id == profile_id) {
        ssl->s3->srtp_profile = server_profile;
        return true;
      }
    }
  }

  return true;
}

static bool ext_srtp_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl->s3->srtp_profile == nullptr) {
    return true;
  }

  assert(SSL_is_dtls(ssl));
  CBB contents, profile_ids;
  if (!CBB_add_u16(out, TLSEXT_TYPE_srtp) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &profile_ids) ||
      !CBB_add_u16(&profile_ids, ssl->s3->srtp_profile->id) ||
      !CBB_add_u8(&contents, 0 /* empty MKI */) || !CBB_flush(out)) {
    return false;
  }

  return true;
}


// EC point formats.
//
// https://tools.ietf.org/html/rfc4492#section-5.1.2

static bool ext_ec_point_add_extension(const SSL_HANDSHAKE *hs, CBB *out) {
  CBB contents, formats;
  if (!CBB_add_u16(out, TLSEXT_TYPE_ec_point_formats) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u8_length_prefixed(&contents, &formats) ||
      !CBB_add_u8(&formats, TLSEXT_ECPOINTFORMAT_uncompressed) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_ec_point_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                         CBB *out_compressible,
                                         ssl_client_hello_type_t type) {
  // The point format extension is unnecessary in TLS 1.3.
  if (hs->min_version >= TLS1_3_VERSION || type == ssl_client_hello_inner) {
    return true;
  }

  return ext_ec_point_add_extension(hs, out);
}

static bool ext_ec_point_parse_serverhello(SSL_HANDSHAKE *hs,
                                           uint8_t *out_alert, CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  if (ssl_protocol_version(hs->ssl) >= TLS1_3_VERSION) {
    return false;
  }

  CBS ec_point_format_list;
  if (!CBS_get_u8_length_prefixed(contents, &ec_point_format_list) ||
      CBS_len(contents) != 0) {
    return false;
  }

  // Per RFC 4492, section 5.1.2, implementations MUST support the uncompressed
  // point format.
  if (OPENSSL_memchr(CBS_data(&ec_point_format_list),
                     TLSEXT_ECPOINTFORMAT_uncompressed,
                     CBS_len(&ec_point_format_list)) == nullptr) {
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  return true;
}

static bool ext_ec_point_parse_clienthello(SSL_HANDSHAKE *hs,
                                           uint8_t *out_alert, CBS *contents) {
  if (ssl_protocol_version(hs->ssl) >= TLS1_3_VERSION) {
    return true;
  }

  return ext_ec_point_parse_serverhello(hs, out_alert, contents);
}

static bool ext_ec_point_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    return true;
  }

  const uint32_t alg_k = hs->new_cipher->algorithm_mkey;
  const uint32_t alg_a = hs->new_cipher->algorithm_auth;
  const bool using_ecc = (alg_k & SSL_kECDHE) || (alg_a & SSL_aECDSA);

  if (!using_ecc) {
    return true;
  }

  return ext_ec_point_add_extension(hs, out);
}


// Pre Shared Key
//
// https://tools.ietf.org/html/rfc8446#section-4.2.11

static bool should_offer_psk(const SSL_HANDSHAKE *hs,
                             ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (hs->max_version < TLS1_3_VERSION || ssl->session == nullptr ||
      ssl_session_get_type(ssl->session.get()) !=
          SSLSessionType::kPreSharedKey ||
      // TODO(https://crbug.com/boringssl/275): Should we synthesize a
      // placeholder PSK, at least when we offer early data? Otherwise
      // ClientHelloOuter will contain an early_data extension without a
      // pre_shared_key extension and potentially break the recovery flow.
      type == ssl_client_hello_outer) {
    return false;
  }

  // Per RFC 8446 section 4.1.4, skip offering the session if the selected
  // cipher in HelloRetryRequest does not match. This avoids performing the
  // transcript hash transformation for multiple hashes.
  if (ssl->s3->used_hello_retry_request &&
      ssl->session->cipher->algorithm_prf != hs->new_cipher->algorithm_prf) {
    return false;
  }

  return true;
}

static size_t ext_pre_shared_key_clienthello_length(
    const SSL_HANDSHAKE *hs, ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (!should_offer_psk(hs, type)) {
    return 0;
  }

  size_t binder_len = EVP_MD_size(ssl_session_get_digest(ssl->session.get()));
  return 15 + ssl->session->ticket.size() + binder_len;
}

static bool ext_pre_shared_key_add_clienthello(const SSL_HANDSHAKE *hs,
                                               CBB *out, bool *out_needs_binder,
                                               ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  *out_needs_binder = false;
  if (!should_offer_psk(hs, type)) {
    return true;
  }

  OPENSSL_timeval now = ssl_ctx_get_current_time(ssl->ctx.get());
  uint32_t ticket_age = 1000 * (now.tv_sec - ssl->session->time);
  uint32_t obfuscated_ticket_age = ticket_age + ssl->session->ticket_age_add;

  // Fill in a placeholder zero binder of the appropriate length. It will be
  // computed and filled in later after length prefixes are computed.
  size_t binder_len = EVP_MD_size(ssl_session_get_digest(ssl->session.get()));

  CBB contents, identity, ticket, binders, binder;
  if (!CBB_add_u16(out, TLSEXT_TYPE_pre_shared_key) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &identity) ||
      !CBB_add_u16_length_prefixed(&identity, &ticket) ||
      !CBB_add_bytes(&ticket, ssl->session->ticket.data(),
                     ssl->session->ticket.size()) ||
      !CBB_add_u32(&identity, obfuscated_ticket_age) ||
      !CBB_add_u16_length_prefixed(&contents, &binders) ||
      !CBB_add_u8_length_prefixed(&binders, &binder) ||
      !CBB_add_zeros(&binder, binder_len)) {
    return false;
  }

  *out_needs_binder = true;
  return CBB_flush(out);
}

bool ssl_ext_pre_shared_key_parse_serverhello(SSL_HANDSHAKE *hs,
                                              uint8_t *out_alert,
                                              CBS *contents) {
  uint16_t psk_id;
  if (!CBS_get_u16(contents, &psk_id) ||  //
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // We only advertise one PSK identity, so the only legal index is zero.
  if (psk_id != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PSK_IDENTITY_NOT_FOUND);
    *out_alert = SSL_AD_UNKNOWN_PSK_IDENTITY;
    return false;
  }

  return true;
}

bool ssl_ext_pre_shared_key_parse_clienthello(
    SSL_HANDSHAKE *hs, CBS *out_ticket, CBS *out_binders,
    uint32_t *out_obfuscated_ticket_age, uint8_t *out_alert,
    const SSL_CLIENT_HELLO *client_hello, CBS *contents) {
  // Verify that the pre_shared_key extension is the last extension in
  // ClientHello.
  if (CBS_data(contents) + CBS_len(contents) !=
      client_hello->extensions + client_hello->extensions_len) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PRE_SHARED_KEY_MUST_BE_LAST);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  // We only process the first PSK identity since we don't support pure PSK.
  CBS identities, binders;
  if (!CBS_get_u16_length_prefixed(contents, &identities) ||    //
      !CBS_get_u16_length_prefixed(&identities, out_ticket) ||  //
      !CBS_get_u32(&identities, out_obfuscated_ticket_age) ||   //
      !CBS_get_u16_length_prefixed(contents, &binders) ||       //
      CBS_len(&binders) == 0 ||                                 //
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  *out_binders = binders;

  // Check the syntax of the remaining identities, but do not process them.
  size_t num_identities = 1;
  while (CBS_len(&identities) != 0) {
    CBS unused_ticket;
    uint32_t unused_obfuscated_ticket_age;
    if (!CBS_get_u16_length_prefixed(&identities, &unused_ticket) ||
        !CBS_get_u32(&identities, &unused_obfuscated_ticket_age)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }

    num_identities++;
  }

  // Check the syntax of the binders. The value will be checked later if
  // resuming.
  size_t num_binders = 0;
  while (CBS_len(&binders) != 0) {
    CBS binder;
    if (!CBS_get_u8_length_prefixed(&binders, &binder)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }

    num_binders++;
  }

  if (num_identities != num_binders) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PSK_IDENTITY_BINDER_COUNT_MISMATCH);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  return true;
}

bool ssl_ext_pre_shared_key_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (!hs->ssl->s3->session_reused) {
    return true;
  }

  CBB contents;
  if (!CBB_add_u16(out, TLSEXT_TYPE_pre_shared_key) ||  //
      !CBB_add_u16_length_prefixed(out, &contents) ||   //
      // We only consider the first identity for resumption
      !CBB_add_u16(&contents, 0) ||  //
      !CBB_flush(out)) {
    return false;
  }

  return true;
}


// Pre-Shared Key Exchange Modes
//
// https://tools.ietf.org/html/rfc8446#section-4.2.9

static bool ext_psk_key_exchange_modes_add_clienthello(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  if (hs->max_version < TLS1_3_VERSION) {
    return true;
  }
  // We do not support resumption with PAKEs, so do not offer any PSK key
  // exchange modes, to signal the server not to send a ticket.
  if (hs->pake_prover != nullptr) {
    return true;
  }

  CBB contents, ke_modes;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_psk_key_exchange_modes) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u8_length_prefixed(&contents, &ke_modes) ||
      !CBB_add_u8(&ke_modes, SSL_PSK_DHE_KE)) {
    return false;
  }

  return CBB_flush(out_compressible);
}

static bool ext_psk_key_exchange_modes_parse_clienthello(SSL_HANDSHAKE *hs,
                                                         uint8_t *out_alert,
                                                         CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  CBS ke_modes;
  if (!CBS_get_u8_length_prefixed(contents, &ke_modes) ||  //
      CBS_len(&ke_modes) == 0 ||                           //
      CBS_len(contents) != 0) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  // We only support tickets with PSK_DHE_KE.
  hs->accept_psk_mode = OPENSSL_memchr(CBS_data(&ke_modes), SSL_PSK_DHE_KE,
                                       CBS_len(&ke_modes)) != nullptr;

  return true;
}


// Early Data Indication
//
// https://tools.ietf.org/html/rfc8446#section-4.2.10

static bool ext_early_data_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                           CBB *out_compressible,
                                           ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  // The second ClientHello never offers early data, and we must have already
  // filled in |early_data_reason| by this point.
  if (ssl->s3->used_hello_retry_request) {
    assert(ssl->s3->early_data_reason != ssl_early_data_unknown);
    return true;
  }

  if (!hs->early_data_offered) {
    return true;
  }

  // If offering ECH, the extension only applies to ClientHelloInner, but we
  // send the extension in both ClientHellos. This ensures that, if the server
  // handshakes with ClientHelloOuter, it can skip past early data. See
  // draft-ietf-tls-esni-13, section 6.1.
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_early_data) ||  //
      !CBB_add_u16(out_compressible, 0) ||                       //
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

static bool ext_early_data_parse_serverhello(SSL_HANDSHAKE *hs,
                                             uint8_t *out_alert,
                                             CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    if (hs->early_data_offered && !ssl->s3->used_hello_retry_request) {
      ssl->s3->early_data_reason = ssl->s3->session_reused
                                       ? ssl_early_data_peer_declined
                                       : ssl_early_data_session_not_resumed;
    } else {
      // We already filled in |early_data_reason| when declining to offer 0-RTT
      // or handling the implicit HelloRetryRequest reject.
      assert(ssl->s3->early_data_reason != ssl_early_data_unknown);
    }
    return true;
  }

  // If we received an HRR, the second ClientHello never offers early data, so
  // the extensions logic will automatically reject early data extensions as
  // unsolicited. This covered by the ServerAcceptsEarlyDataOnHRR test.
  assert(!ssl->s3->used_hello_retry_request);

  if (CBS_len(contents) != 0) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  if (!ssl->s3->session_reused) {
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    return false;
  }

  ssl->s3->early_data_reason = ssl_early_data_accepted;
  ssl->s3->early_data_accepted = true;
  return true;
}

static bool ext_early_data_parse_clienthello(SSL_HANDSHAKE *hs,
                                             uint8_t *out_alert,
                                             CBS *contents) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr || ssl_protocol_version(ssl) < TLS1_3_VERSION) {
    return true;
  }

  if (CBS_len(contents) != 0) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  hs->early_data_offered = true;
  return true;
}

static bool ext_early_data_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (!hs->ssl->s3->early_data_accepted) {
    return true;
  }

  if (!CBB_add_u16(out, TLSEXT_TYPE_early_data) ||  //
      !CBB_add_u16(out, 0) ||                       //
      !CBB_flush(out)) {
    return false;
  }

  return true;
}


// Key Share
//
// https://tools.ietf.org/html/rfc8446#section-4.2.8

bool ssl_setup_key_shares(SSL_HANDSHAKE *hs, uint16_t override_group_id) {
  SSL *const ssl = hs->ssl;
  hs->key_shares.clear();
  hs->key_share_bytes.Reset();

  // If offering a PAKE, do not set up key shares. We do not currently support
  // clients offering both PAKE and non-PAKE modes, including resumption.
  if (hs->max_version < TLS1_3_VERSION || hs->pake_prover) {
    return true;
  }

  const Span<const uint16_t> supported_group_list =
      hs->config->supported_group_list;
  if (supported_group_list.empty()) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_NO_GROUPS_SPECIFIED);
    return false;
  }

  std::optional<Span<const uint16_t>> selected_key_shares;

  // This is used for HelloRetryRequest, where we have already been given the
  // correct group to use.
  if (override_group_id != 0) {
    assert(std::find(supported_group_list.begin(), supported_group_list.end(),
                     override_group_id) != supported_group_list.end());
    selected_key_shares.emplace(&override_group_id, 1u);
  }

  // First try to predict the most preferred (by our preference order) group
  // that was hinted by the server.
  const auto &server_hint_list = ssl->config->server_supported_groups_hint;
  if (!selected_key_shares.has_value() && !server_hint_list.empty()) {
    for (const uint16_t &supported_group : supported_group_list) {
      if (std::find(server_hint_list.begin(), server_hint_list.end(),
                    supported_group) != server_hint_list.end()) {
        selected_key_shares.emplace(&supported_group, 1u);
        break;
      }
    }
  }

  // Otherwise, try to use explicitly configured key shares from the caller.
  if (!selected_key_shares.has_value() &&
      ssl->config->client_key_share_selections.has_value()) {
    selected_key_shares.emplace(*ssl->config->client_key_share_selections);
  }

  // Run the default selection if we don't have anything better.
  InplaceVector<uint16_t, 2> default_key_shares;
  if (!selected_key_shares.has_value()) {
    // By default, predict the most preferred group.
    if (!default_key_shares.TryPushBack(supported_group_list[0])) {
      return false;
    }
    // We'll try to include one post-quantum and one classical initial key
    // share.
    for (size_t i = 1; i < supported_group_list.size(); i++) {
      if (is_post_quantum_group(default_key_shares[0]) ==
          is_post_quantum_group(supported_group_list[i])) {
        continue;
      }
      if (!default_key_shares.TryPushBack(supported_group_list[i])) {
        return false;
      }
      assert(default_key_shares[1] != default_key_shares[0]);
      break;
    }
    selected_key_shares.emplace(default_key_shares);
  }

  assert(selected_key_shares.has_value());

  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 64)) {
    return false;
  }

  if (override_group_id == 0 && ssl->ctx->grease_enabled) {
    // Add a fake group. See RFC 8701.
    if (!CBB_add_u16(cbb.get(), ssl_get_grease_value(hs, ssl_grease_group)) ||
        !CBB_add_u16(cbb.get(), 1 /* length */) ||
        !CBB_add_u8(cbb.get(), 0 /* one byte key share */)) {
      return false;
    }
  }

  CBB key_exchange;
  for (const uint16_t group_id : *selected_key_shares) {
    UniquePtr<SSLKeyShare> key_share = SSLKeyShare::Create(group_id);
    if (key_share == nullptr ||                                    //
        !CBB_add_u16(cbb.get(), group_id) ||                       //
        !CBB_add_u16_length_prefixed(cbb.get(), &key_exchange) ||  //
        !key_share->Generate(&key_exchange) ||                     //
        !hs->key_shares.TryPushBack(std::move(key_share))) {
      return false;
    }
  }

  return CBBFinishArray(cbb.get(), &hs->key_share_bytes);
}

static bool ext_key_share_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                          CBB *out_compressible,
                                          ssl_client_hello_type_t type) {
  // If offering a PAKE, do not set up key shares. We do not currently support
  // clients offering both PAKE and non-PAKE modes, including resumption.
  if (hs->max_version < TLS1_3_VERSION || hs->pake_prover) {
    return true;
  }

  // The caller may explicitly configure empty key shares to request a
  // HelloRetryRequest.
  assert(!hs->key_share_bytes.empty() ||
         (hs->config->client_key_share_selections.has_value() &&
          hs->config->client_key_share_selections->empty()));

  CBB contents, kse_bytes;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_key_share) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &kse_bytes) ||
      !CBB_add_bytes(&kse_bytes, hs->key_share_bytes.data(),
                     hs->key_share_bytes.size()) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

bool ssl_ext_key_share_parse_serverhello(SSL_HANDSHAKE *hs,
                                         Array<uint8_t> *out_secret,
                                         uint8_t *out_alert, CBS *contents) {
  // If we did not offer key shares, the extension should have been rejected
  // as unsolicited.
  assert(!hs->key_shares.empty());

  CBS ciphertext;
  uint16_t group_id;
  if (!CBS_get_u16(contents, &group_id) ||
      !CBS_get_u16_length_prefixed(contents, &ciphertext) ||
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  const auto key_share_it =
      std::find_if(hs->key_shares.begin(), hs->key_shares.end(),
                   [group_id](const auto &key_share) {
                     return key_share->GroupID() == group_id;
                   });
  if (key_share_it == hs->key_shares.end()) {
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    OPENSSL_PUT_ERROR(SSL, SSL_R_WRONG_CURVE);
    return false;
  }
  if (!(*key_share_it)->Decap(out_secret, out_alert, ciphertext)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  hs->new_session->group_id = group_id;
  hs->key_shares.clear();
  return true;
}

bool ssl_ext_key_share_parse_clienthello(SSL_HANDSHAKE *hs, bool *out_found,
                                         Span<const uint8_t> *out_peer_key,
                                         uint8_t *out_alert,
                                         const SSL_CLIENT_HELLO *client_hello) {
  // We only support connections that include an ECDHE key exchange, or use a
  // PAKE.
  CBS contents;
  if (!ssl_client_hello_get_extension(client_hello, &contents,
                                      TLSEXT_TYPE_key_share)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_MISSING_KEY_SHARE);
    *out_alert = SSL_AD_MISSING_EXTENSION;
    return false;
  }

  CBS key_shares;
  if (!CBS_get_u16_length_prefixed(&contents, &key_shares) ||
      CBS_len(&contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  // Find the corresponding key share.
  const uint16_t group_id = hs->new_session->group_id;
  CBS peer_key;
  CBS_init(&peer_key, nullptr, 0);
  while (CBS_len(&key_shares) > 0) {
    uint16_t id;
    CBS peer_key_tmp;
    if (!CBS_get_u16(&key_shares, &id) ||
        !CBS_get_u16_length_prefixed(&key_shares, &peer_key_tmp) ||
        CBS_len(&peer_key_tmp) == 0) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      return false;
    }

    if (id == group_id) {
      if (CBS_len(&peer_key) != 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_DUPLICATE_KEY_SHARE);
        *out_alert = SSL_AD_ILLEGAL_PARAMETER;
        return false;
      }

      peer_key = peer_key_tmp;
      // Continue parsing the structure to keep peers honest.
    }
  }

  if (out_peer_key != nullptr) {
    *out_peer_key = peer_key;
  }
  *out_found = CBS_len(&peer_key) != 0;
  return true;
}

bool ssl_ext_pake_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (hs->pake_share_bytes.empty()) {
    return true;
  }

  CBB pake_ext, pake_msg;
  if (!CBB_add_u16(out, TLSEXT_TYPE_pake) ||
      !CBB_add_u16_length_prefixed(out, &pake_ext) ||
      !CBB_add_u16(&pake_ext, SSL_PAKE_SPAKE2PLUSV1) ||
      !CBB_add_u16_length_prefixed(&pake_ext, &pake_msg) ||
      !CBB_add_bytes(&pake_msg, hs->pake_share_bytes.data(),
                     hs->pake_share_bytes.size()) ||
      !CBB_flush(out)) {
    return false;
  }
  return true;
}

bool ssl_ext_key_share_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  if (hs->pake_verifier) {
    // We don't add the key share extension if a PAKE is offered.
    return true;
  }

  CBB entry, ciphertext;
  if (!CBB_add_u16(out, TLSEXT_TYPE_key_share) ||
      !CBB_add_u16_length_prefixed(out, &entry) ||
      !CBB_add_u16(&entry, hs->new_session->group_id) ||
      !CBB_add_u16_length_prefixed(&entry, &ciphertext) ||
      !CBB_add_bytes(&ciphertext, hs->key_share_ciphertext.data(),
                     hs->key_share_ciphertext.size()) ||
      !CBB_flush(out)) {
    return false;
  }
  return true;
}


// Supported Versions
//
// https://tools.ietf.org/html/rfc8446#section-4.2.1

static bool ext_supported_versions_add_clienthello(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  if (hs->max_version <= TLS1_2_VERSION) {
    return true;
  }

  // supported_versions is compressible in ECH if ClientHelloOuter already
  // requires TLS 1.3. Otherwise the extensions differ in the older versions.
  if (hs->min_version >= TLS1_3_VERSION) {
    out = out_compressible;
  }

  CBB contents, versions;
  if (!CBB_add_u16(out, TLSEXT_TYPE_supported_versions) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u8_length_prefixed(&contents, &versions)) {
    return false;
  }

  // Add a fake version. See RFC 8701.
  if (ssl->ctx->grease_enabled &&
      !CBB_add_u16(&versions, ssl_get_grease_value(hs, ssl_grease_version))) {
    return false;
  }

  // Encrypted ClientHellos requires TLS 1.3 or later.
  uint16_t extra_min_version =
      type == ssl_client_hello_inner ? TLS1_3_VERSION : 0;
  if (!ssl_add_supported_versions(hs, &versions, extra_min_version) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}


// Cookie
//
// https://tools.ietf.org/html/rfc8446#section-4.2.2

static bool ext_cookie_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                       CBB *out_compressible,
                                       ssl_client_hello_type_t type) {
  if (hs->cookie.empty()) {
    return true;
  }

  CBB contents, cookie;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_cookie) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &cookie) ||
      !CBB_add_bytes(&cookie, hs->cookie.data(), hs->cookie.size()) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}


// Supported Groups
//
// https://tools.ietf.org/html/rfc4492#section-5.1.1
// https://tools.ietf.org/html/rfc8446#section-4.2.7

static bool ext_supported_groups_add_clienthello(const SSL_HANDSHAKE *hs,
                                                 CBB *out,
                                                 CBB *out_compressible,
                                                 ssl_client_hello_type_t type) {
  const SSL *const ssl = hs->ssl;
  // In PAKE mode, supported_groups and key_share are not used.
  if (hs->pake_prover != nullptr) {
    return true;
  }

  CBB contents, groups_bytes;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_supported_groups) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &groups_bytes)) {
    return false;
  }

  // Add a fake group. See RFC 8701.
  if (ssl->ctx->grease_enabled &&
      !CBB_add_u16(&groups_bytes, ssl_get_grease_value(hs, ssl_grease_group))) {
    return false;
  }

  for (uint16_t group : hs->config->supported_group_list) {
    if (is_post_quantum_group(group) && hs->max_version < TLS1_3_VERSION) {
      continue;
    }
    if (!CBB_add_u16(&groups_bytes, group)) {
      return false;
    }
  }

  return CBB_flush(out_compressible);
}

static bool ext_supported_groups_parse_serverhello(SSL_HANDSHAKE *hs,
                                                   uint8_t *out_alert,
                                                   CBS *contents) {
  // This extension is not expected to be echoed by servers in TLS 1.2, but some
  // BigIP servers send it nonetheless, so do not enforce this.
  return true;
}

static bool parse_u16_array(const CBS *cbs, Array<uint16_t> *out) {
  CBS copy = *cbs;
  if ((CBS_len(&copy) & 1) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  Array<uint16_t> ret;
  if (!ret.InitForOverwrite(CBS_len(&copy) / 2)) {
    return false;
  }
  for (size_t i = 0; i < ret.size(); i++) {
    if (!CBS_get_u16(&copy, &ret[i])) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return false;
    }
  }

  assert(CBS_len(&copy) == 0);
  *out = std::move(ret);
  return true;
}

static bool ext_supported_groups_parse_clienthello(SSL_HANDSHAKE *hs,
                                                   uint8_t *out_alert,
                                                   CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  CBS supported_group_list;
  if (!CBS_get_u16_length_prefixed(contents, &supported_group_list) ||  //
      CBS_len(&supported_group_list) == 0 ||                            //
      CBS_len(contents) != 0 ||                                         //
      !parse_u16_array(&supported_group_list, &hs->peer_supported_group_list)) {
    return false;
  }

  return true;
}


// Certificate Authorities.
//
// https://tools.ietf.org/html/rfc8446#section-4.2.4

static bool ext_certificate_authorities_add_clienthello(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  // TODO(crbug.com/398275713): What should this send in ClientHelloOuter?
  if (ssl_has_CA_names(hs->config)) {
    CBB ca_contents;
    if (!CBB_add_u16(out_compressible,
                     TLSEXT_TYPE_certificate_authorities) ||             //
        !CBB_add_u16_length_prefixed(out_compressible, &ca_contents) ||  //
        !ssl_add_CA_names(hs, &ca_contents) ||                           //
        !CBB_flush(out_compressible)) {
      return false;
    }
  }
  return true;
}

static bool ext_certificate_authorities_parse_clienthello(SSL_HANDSHAKE *hs,
                                                          uint8_t *out_alert,
                                                          CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  if (CBS_len(contents) == 0) {
    return false;
  }

  hs->ca_names = SSL_parse_CA_list(hs->ssl, out_alert, contents);
  if (!hs->ca_names) {
    return false;
  }

  return true;
}


// Trust Anchor Identifiers
//
// https://datatracker.ietf.org/doc/draft-ietf-tls-trust-anchor-ids/

bool ssl_is_valid_trust_anchor_list(Span<const uint8_t> in) {
  CBS ids = in;
  while (CBS_len(&ids) > 0) {
    CBS id;
    if (!CBS_get_u8_length_prefixed(&ids, &id) ||  //
        CBS_len(&id) == 0) {
      return false;
    }
  }
  return true;
}

static bool ext_trust_anchors_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                              CBB *out_compressible,
                                              ssl_client_hello_type_t type) {
  if (!hs->config->requested_trust_anchors.has_value()) {
    return true;
  }
  // TODO(crbug.com/398275713): What should this send in ClientHelloOuter?
  CBB contents, list;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_trust_anchors) ||  //
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||  //
      !CBB_add_u16_length_prefixed(&contents, &list) ||             //
      !CBB_add_bytes(&list, hs->config->requested_trust_anchors->data(),
                     hs->config->requested_trust_anchors->size()) ||
      !CBB_flush(out_compressible)) {
    return false;
  }
  return true;
}

static bool ext_trust_anchors_parse_clienthello(SSL_HANDSHAKE *hs,
                                                uint8_t *out_alert,
                                                CBS *contents) {
  if (contents == nullptr || ssl_protocol_version(hs->ssl) < TLS1_3_VERSION) {
    return true;
  }

  CBS child;
  if (!CBS_get_u16_length_prefixed(contents, &child) ||
      !ssl_is_valid_trust_anchor_list(child)) {
    *out_alert = SSL_AD_DECODE_ERROR;
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  hs->peer_requested_trust_anchors.emplace();
  if (!hs->peer_requested_trust_anchors->CopyFrom(child)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }
  return true;
}

static bool ext_trust_anchors_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) < TLS1_3_VERSION) {
    return true;
  }

  const size_t old_len = CBB_len(out);
  CBB contents, list, child;
  if (!CBB_add_u16(out, TLSEXT_TYPE_trust_anchors) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &list)) {
    return false;
  }
  for (const auto &cred : hs->config->cert->credentials) {
    if (!cred->trust_anchor_id.empty()) {
      uint16_t unused_sigalg;
      if (!ssl_check_tls13_credential_ignoring_issuer(hs, cred.get(),
                                                      &unused_sigalg)) {
        ERR_clear_error();
        continue;
      }
      if (!CBB_add_u8_length_prefixed(&list, &child) ||
          !CBB_add_bytes(&child, cred->trust_anchor_id.data(),
                         cred->trust_anchor_id.size()) ||
          !CBB_flush(&list)) {
        return false;
      }
    }
  }

  bool empty = CBB_len(&list) == 0;
  if (!CBB_flush(out)) {
    return false;
  }

  // Don't send the extension if it would have been empty.
  if (empty) {
    CBB_discard(out, CBB_len(out) - old_len);
  }
  return true;
}

static bool ext_trust_anchors_parse_serverhello(SSL_HANDSHAKE *hs,
                                                uint8_t *out_alert,
                                                CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  if (ssl_protocol_version(hs->ssl) < TLS1_3_VERSION) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    return false;
  }

  CBS child;
  if (!CBS_get_u16_length_prefixed(contents, &child) ||
      // The list of available trust anchors may not be empty.
      CBS_len(&child) == 0 ||  //
      !ssl_is_valid_trust_anchor_list(child)) {
    *out_alert = SSL_AD_DECODE_ERROR;
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  if (!hs->peer_available_trust_anchors.CopyFrom(child)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }
  return true;
}

// QUIC Transport Parameters

static bool ext_quic_transport_params_add_clienthello_impl(
    const SSL_HANDSHAKE *hs, CBB *out, bool use_legacy_codepoint) {
  if (hs->config->quic_transport_params.empty() && !SSL_is_quic(hs->ssl)) {
    return true;
  }
  if (hs->config->quic_transport_params.empty() || !SSL_is_quic(hs->ssl)) {
    // QUIC Transport Parameters must be sent over QUIC, and they must not be
    // sent over non-QUIC transports. If transport params are set, then
    // SSL(_CTX)_set_quic_method must also be called.
    OPENSSL_PUT_ERROR(SSL, SSL_R_QUIC_TRANSPORT_PARAMETERS_MISCONFIGURED);
    return false;
  }
  assert(hs->min_version > TLS1_2_VERSION);
  if (use_legacy_codepoint != hs->config->quic_use_legacy_codepoint) {
    // Do nothing, we'll send the other codepoint.
    return true;
  }

  uint16_t extension_type = TLSEXT_TYPE_quic_transport_parameters;
  if (hs->config->quic_use_legacy_codepoint) {
    extension_type = TLSEXT_TYPE_quic_transport_parameters_legacy;
  }

  CBB contents;
  if (!CBB_add_u16(out, extension_type) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_bytes(&contents, hs->config->quic_transport_params.data(),
                     hs->config->quic_transport_params.size()) ||
      !CBB_flush(out)) {
    return false;
  }
  return true;
}

static bool ext_quic_transport_params_add_clienthello(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  return ext_quic_transport_params_add_clienthello_impl(
      hs, out_compressible, /*use_legacy_codepoint=*/false);
}

static bool ext_quic_transport_params_add_clienthello_legacy(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  return ext_quic_transport_params_add_clienthello_impl(
      hs, out_compressible, /*use_legacy_codepoint=*/true);
}

static bool ext_quic_transport_params_parse_serverhello_impl(
    SSL_HANDSHAKE *hs, uint8_t *out_alert, CBS *contents,
    bool used_legacy_codepoint) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    if (used_legacy_codepoint != hs->config->quic_use_legacy_codepoint) {
      // Silently ignore because we expect the other QUIC codepoint.
      return true;
    }
    if (!SSL_is_quic(ssl)) {
      return true;
    }
    *out_alert = SSL_AD_MISSING_EXTENSION;
    return false;
  }
  // The extensions parser will check for unsolicited extensions before
  // calling the callback.
  assert(SSL_is_quic(ssl));
  assert(ssl_protocol_version(ssl) == TLS1_3_VERSION);
  assert(used_legacy_codepoint == hs->config->quic_use_legacy_codepoint);
  return ssl->s3->peer_quic_transport_params.CopyFrom(*contents);
}

static bool ext_quic_transport_params_parse_serverhello(SSL_HANDSHAKE *hs,
                                                        uint8_t *out_alert,
                                                        CBS *contents) {
  return ext_quic_transport_params_parse_serverhello_impl(
      hs, out_alert, contents, /*used_legacy_codepoint=*/false);
}

static bool ext_quic_transport_params_parse_serverhello_legacy(
    SSL_HANDSHAKE *hs, uint8_t *out_alert, CBS *contents) {
  return ext_quic_transport_params_parse_serverhello_impl(
      hs, out_alert, contents, /*used_legacy_codepoint=*/true);
}

static bool ext_quic_transport_params_parse_clienthello_impl(
    SSL_HANDSHAKE *hs, uint8_t *out_alert, CBS *contents,
    bool used_legacy_codepoint) {
  SSL *const ssl = hs->ssl;
  if (!contents) {
    if (!SSL_is_quic(ssl)) {
      if (hs->config->quic_transport_params.empty()) {
        return true;
      }
      // QUIC transport parameters must not be set if |ssl| is not configured
      // for QUIC.
      OPENSSL_PUT_ERROR(SSL, SSL_R_QUIC_TRANSPORT_PARAMETERS_MISCONFIGURED);
      *out_alert = SSL_AD_INTERNAL_ERROR;
      return false;
    }
    if (used_legacy_codepoint != hs->config->quic_use_legacy_codepoint) {
      // Silently ignore because we expect the other QUIC codepoint.
      return true;
    }
    *out_alert = SSL_AD_MISSING_EXTENSION;
    return false;
  }
  if (!SSL_is_quic(ssl)) {
    if (used_legacy_codepoint) {
      // Ignore the legacy private-use codepoint because that could be sent
      // to mean something else than QUIC transport parameters.
      return true;
    }
    // Fail if we received the codepoint registered with IANA for QUIC
    // because that is not allowed outside of QUIC.
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    return false;
  }
  assert(ssl_protocol_version(ssl) == TLS1_3_VERSION);
  if (used_legacy_codepoint != hs->config->quic_use_legacy_codepoint) {
    // Silently ignore because we expect the other QUIC codepoint.
    return true;
  }
  return ssl->s3->peer_quic_transport_params.CopyFrom(*contents);
}

static bool ext_quic_transport_params_parse_clienthello(SSL_HANDSHAKE *hs,
                                                        uint8_t *out_alert,
                                                        CBS *contents) {
  return ext_quic_transport_params_parse_clienthello_impl(
      hs, out_alert, contents, /*used_legacy_codepoint=*/false);
}

static bool ext_quic_transport_params_parse_clienthello_legacy(
    SSL_HANDSHAKE *hs, uint8_t *out_alert, CBS *contents) {
  return ext_quic_transport_params_parse_clienthello_impl(
      hs, out_alert, contents, /*used_legacy_codepoint=*/true);
}

static bool ext_quic_transport_params_add_serverhello_impl(
    SSL_HANDSHAKE *hs, CBB *out, bool use_legacy_codepoint) {
  if (!SSL_is_quic(hs->ssl) && use_legacy_codepoint) {
    // Ignore the legacy private-use codepoint because that could be sent
    // to mean something else than QUIC transport parameters.
    return true;
  }
  assert(SSL_is_quic(hs->ssl));
  if (hs->config->quic_transport_params.empty()) {
    // Transport parameters must be set when using QUIC.
    OPENSSL_PUT_ERROR(SSL, SSL_R_QUIC_TRANSPORT_PARAMETERS_MISCONFIGURED);
    return false;
  }
  if (use_legacy_codepoint != hs->config->quic_use_legacy_codepoint) {
    // Do nothing, we'll send the other codepoint.
    return true;
  }

  uint16_t extension_type = TLSEXT_TYPE_quic_transport_parameters;
  if (hs->config->quic_use_legacy_codepoint) {
    extension_type = TLSEXT_TYPE_quic_transport_parameters_legacy;
  }

  CBB contents;
  if (!CBB_add_u16(out, extension_type) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_bytes(&contents, hs->config->quic_transport_params.data(),
                     hs->config->quic_transport_params.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_quic_transport_params_add_serverhello(SSL_HANDSHAKE *hs,
                                                      CBB *out) {
  return ext_quic_transport_params_add_serverhello_impl(
      hs, out, /*use_legacy_codepoint=*/false);
}

static bool ext_quic_transport_params_add_serverhello_legacy(SSL_HANDSHAKE *hs,
                                                             CBB *out) {
  return ext_quic_transport_params_add_serverhello_impl(
      hs, out, /*use_legacy_codepoint=*/true);
}

// Delegated credentials.
//
// https://www.rfc-editor.org/rfc/rfc9345.html

static bool ext_delegated_credential_add_clienthello(
    const SSL_HANDSHAKE *hs, CBB *out, CBB *out_compressible,
    ssl_client_hello_type_t type) {
  return true;
}

static bool ext_delegated_credential_parse_clienthello(SSL_HANDSHAKE *hs,
                                                       uint8_t *out_alert,
                                                       CBS *contents) {
  if (contents == nullptr || ssl_protocol_version(hs->ssl) < TLS1_3_VERSION) {
    // Don't use delegated credentials unless we're negotiating TLS 1.3 or
    // higher.
    return true;
  }

  // The contents of the extension are the signature algorithms the client will
  // accept for a delegated credential.
  CBS sigalg_list;
  if (!CBS_get_u16_length_prefixed(contents, &sigalg_list) ||  //
      CBS_len(&sigalg_list) == 0 ||                            //
      CBS_len(contents) != 0 ||                                //
      !parse_u16_array(&sigalg_list, &hs->peer_delegated_credential_sigalgs)) {
    return false;
  }

  return true;
}

// Certificate compression

static bool cert_compression_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                             CBB *out_compressible,
                                             ssl_client_hello_type_t type) {
  bool first = true;
  CBB contents, algs;

  for (const auto &alg : hs->ssl->ctx->cert_compression_algs) {
    if (alg.decompress == nullptr) {
      continue;
    }

    if (first &&
        (!CBB_add_u16(out_compressible, TLSEXT_TYPE_cert_compression) ||
         !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
         !CBB_add_u8_length_prefixed(&contents, &algs))) {
      return false;
    }
    first = false;
    if (!CBB_add_u16(&algs, alg.alg_id)) {
      return false;
    }
  }

  return first || CBB_flush(out_compressible);
}

static bool cert_compression_parse_serverhello(SSL_HANDSHAKE *hs,
                                               uint8_t *out_alert,
                                               CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  // The server may not echo this extension. Any server to client negotiation is
  // advertised in the CertificateRequest message.
  return false;
}

static bool cert_compression_parse_clienthello(SSL_HANDSHAKE *hs,
                                               uint8_t *out_alert,
                                               CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  const SSL_CTX *ctx = hs->ssl->ctx.get();
  const size_t num_algs = ctx->cert_compression_algs.size();

  CBS alg_ids;
  if (!CBS_get_u8_length_prefixed(contents, &alg_ids) ||  //
      CBS_len(contents) != 0 ||                           //
      CBS_len(&alg_ids) == 0 ||                           //
      CBS_len(&alg_ids) % 2 == 1) {
    return false;
  }

  const size_t num_given_alg_ids = CBS_len(&alg_ids) / 2;
  Array<uint16_t> given_alg_ids;
  if (!given_alg_ids.InitForOverwrite(num_given_alg_ids)) {
    return false;
  }

  size_t best_index = num_algs;
  size_t given_alg_idx = 0;

  while (CBS_len(&alg_ids) > 0) {
    uint16_t alg_id;
    if (!CBS_get_u16(&alg_ids, &alg_id)) {
      return false;
    }

    given_alg_ids[given_alg_idx++] = alg_id;

    for (size_t i = 0; i < num_algs; i++) {
      const auto &alg = ctx->cert_compression_algs[i];
      if (alg.alg_id == alg_id && alg.compress != nullptr) {
        if (i < best_index) {
          best_index = i;
        }
        break;
      }
    }
  }

  std::sort(given_alg_ids.begin(), given_alg_ids.end());
  for (size_t i = 1; i < num_given_alg_ids; i++) {
    if (given_alg_ids[i - 1] == given_alg_ids[i]) {
      return false;
    }
  }

  if (best_index < num_algs &&
      ssl_protocol_version(hs->ssl) >= TLS1_3_VERSION) {
    hs->cert_compression_negotiated = true;
    hs->cert_compression_alg_id = ctx->cert_compression_algs[best_index].alg_id;
  }

  return true;
}

static bool cert_compression_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  return true;
}

// PAKEs
//
// See
// https://chris-wood.github.io/draft-bmw-tls-pake13/draft-bmw-tls-pake13.html

bool ssl_setup_pake_shares(SSL_HANDSHAKE *hs) {
  hs->pake_share_bytes.Reset();
  if (hs->max_version < TLS1_3_VERSION) {
    return true;
  }

  const auto &creds = hs->config->cert->credentials;
  if (std::none_of(creds.begin(), creds.end(), [](const auto &cred) {
        return cred->type == SSLCredentialType::kSPAKE2PlusV1Client;
      })) {
    // If there were no configured PAKE credentials, proceed without filling
    // in the PAKE extension.
    return true;
  }

  // We currently do not support multiple PAKE credentials, or a mix of PAKE and
  // non-PAKE credentials.
  if (creds.size() != 1u) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNSUPPORTED_CREDENTIAL_LIST);
    return false;
  }
  SSL_CREDENTIAL *cred = creds[0].get();
  assert(cred->type == SSLCredentialType::kSPAKE2PlusV1Client);

  hs->pake_prover = MakeUnique<spake2plus::Prover>();
  uint8_t prover_share[spake2plus::kShareSize];
  if (hs->pake_prover == nullptr ||
      !hs->pake_prover->Init(cred->pake_context, cred->client_identity,
                             cred->server_identity, cred->password_verifier_w0,
                             cred->password_verifier_w1) ||
      !hs->pake_prover->GenerateShare(prover_share)) {
    return false;
  }

  hs->credential = UpRef(cred);

  bssl::ScopedCBB cbb;
  CBB shares, client_identity, server_identity, pake_message;
  if (!CBB_init(cbb.get(), 64) ||
      !CBB_add_u16_length_prefixed(cbb.get(), &client_identity) ||
      !CBB_add_bytes(&client_identity, cred->client_identity.data(),
                     cred->client_identity.size()) ||
      !CBB_add_u16_length_prefixed(cbb.get(), &server_identity) ||
      !CBB_add_bytes(&server_identity, cred->server_identity.data(),
                     cred->server_identity.size()) ||
      !CBB_add_u16_length_prefixed(cbb.get(), &shares) ||
      !CBB_add_u16(&shares, SSL_PAKE_SPAKE2PLUSV1) ||
      !CBB_add_u16_length_prefixed(&shares, &pake_message) ||
      !CBB_add_bytes(&pake_message, prover_share, sizeof(prover_share))) {
    return false;
  }

  return CBBFinishArray(cbb.get(), &hs->pake_share_bytes);
}

static bool ext_pake_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                     CBB *out_compressible,
                                     ssl_client_hello_type_t type) {
  if (hs->pake_share_bytes.empty()) {
    return true;
  }

  CBB pake_share_bytes;
  if (!CBB_add_u16(out_compressible, TLSEXT_TYPE_pake) ||
      !CBB_add_u16_length_prefixed(out_compressible, &pake_share_bytes) ||
      !CBB_add_bytes(&pake_share_bytes, hs->pake_share_bytes.data(),
                     hs->pake_share_bytes.size()) ||
      !CBB_flush(out_compressible)) {
    return false;
  }

  return true;
}

bool ssl_ext_pake_parse_serverhello(SSL_HANDSHAKE *hs,
                                    Array<uint8_t> *out_secret,
                                    uint8_t *out_alert, CBS *contents) {
  *out_alert = SSL_AD_DECODE_ERROR;

  if (!hs->pake_prover) {
    // If we did not offer a PAKE, the extension should have been rejected as
    // unsolicited.
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  CBS pake_msg;
  uint16_t named_pake;
  if (!CBS_get_u16(contents, &named_pake) ||
      !CBS_get_u16_length_prefixed(contents, &pake_msg) ||
      CBS_len(contents) != 0 ||  //
      named_pake != SSL_PAKE_SPAKE2PLUSV1) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  // Check that the server's PAKE share consists of the right number of
  // bytes for a PAKE share and a key confirmation message.
  if (CBS_len(&pake_msg) != spake2plus::kShareSize + spake2plus::kConfirmSize) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }
  Span<const uint8_t> pake_msg_span = pake_msg;

  // Releasing the result of |ComputeConfirmation| lets the client confirm one
  // PAKE guess. If all failures are used up, no more guesses are allowed.
  if (!hs->credential->HasPAKEAttempts()) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_PAKE_EXHAUSTED);
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  uint8_t prover_confirm[spake2plus::kConfirmSize];
  uint8_t prover_secret[spake2plus::kSecretSize];
  if (!hs->pake_prover->ComputeConfirmation(
          prover_confirm, prover_secret,
          pake_msg_span.first<spake2plus::kShareSize>(),
          pake_msg_span.subspan(spake2plus::kShareSize))) {
    // Record a failure before releasing the answer to the client.
    hs->credential->ClaimPAKEAttempt();
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    *out_alert = SSL_AD_ILLEGAL_PARAMETER;
    return false;
  }

  Array<uint8_t> secret;
  if (!secret.CopyFrom(prover_secret)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  *out_secret = std::move(secret);
  return true;
}

static bool ext_pake_parse_clienthello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  if (contents == nullptr) {
    return true;
  }

  // struct {
  //     opaque    client_identity<0..2^16-1>;
  //     opaque    server_identity<0..2^16-1>;
  //     PAKEShare client_shares<0..2^16-1>;
  // } PAKEClientHello;
  //
  // struct {
  //     NamedPAKE   named_pake;
  //     opaque      pake_message<1..2^16-1>;
  // } PAKEShare;

  *out_alert = SSL_AD_DECODE_ERROR;
  CBS client_identity, server_identity, shares;
  if (!CBS_get_u16_length_prefixed(contents, &client_identity) ||
      !CBS_get_u16_length_prefixed(contents, &server_identity) ||
      !CBS_get_u16_length_prefixed(contents, &shares) ||
      CBS_len(contents) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    return false;
  }

  uint16_t last_named_pake = 0;
  for (size_t i = 0; CBS_len(&shares) > 0; i++) {
    uint16_t pake_id;
    CBS message;
    if (!CBS_get_u16(&shares, &pake_id) ||
        !CBS_get_u16_length_prefixed(&shares, &message)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      return false;
    }

    // PAKEs must be sent in strictly monotonic order.
    if (i > 0 && last_named_pake >= pake_id) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      return false;
    }
    last_named_pake = pake_id;

    // We only support one PAKE.
    if (pake_id != SSL_PAKE_SPAKE2PLUSV1) {
      continue;
    }

    // Save the PAKE share for the handshake logic to pick up later.
    // TODO(crbug.com/391393404): It would be nice if the callback did not have
    // to copy this.
    hs->pake_share = MakeUnique<SSLPAKEShare>();
    if (hs->pake_share == nullptr ||
        !hs->pake_share->client_identity.CopyFrom(client_identity) ||
        !hs->pake_share->server_identity.CopyFrom(server_identity) ||
        !hs->pake_share->pake_message.CopyFrom(message)) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return false;
    }
    hs->pake_share->named_pake = pake_id;
  }

  return true;
}


// Application-level Protocol Settings
//
// https://tools.ietf.org/html/draft-vvv-tls-alps-01

bool ssl_get_local_application_settings(const SSL_HANDSHAKE *hs,
                                        Span<const uint8_t> *out_settings,
                                        Span<const uint8_t> protocol) {
  for (const ALPSConfig &config : hs->config->alps_configs) {
    if (protocol == config.protocol) {
      *out_settings = config.settings;
      return true;
    }
  }
  return false;
}

static bool ext_alps_add_clienthello_impl(const SSL_HANDSHAKE *hs, CBB *out,
                                          CBB *out_compressible,
                                          ssl_client_hello_type_t type,
                                          bool use_new_codepoint) {
  const SSL *const ssl = hs->ssl;
  if (  // ALPS requires TLS 1.3.
      hs->max_version < TLS1_3_VERSION ||
      // Do not offer ALPS without ALPN.
      hs->config->alpn_client_proto_list.empty() ||
      // Do not offer ALPS if not configured.
      hs->config->alps_configs.empty() ||
      // Do not offer ALPS on renegotiation handshakes.
      ssl->s3->initial_handshake_complete) {
    return true;
  }

  if (use_new_codepoint != hs->config->alps_use_new_codepoint) {
    // Do nothing, we'll send the other codepoint.
    return true;
  }

  uint16_t extension_type = TLSEXT_TYPE_application_settings_old;
  if (hs->config->alps_use_new_codepoint) {
    extension_type = TLSEXT_TYPE_application_settings;
  }

  CBB contents, proto_list, proto;
  if (!CBB_add_u16(out_compressible, extension_type) ||
      !CBB_add_u16_length_prefixed(out_compressible, &contents) ||
      !CBB_add_u16_length_prefixed(&contents, &proto_list)) {
    return false;
  }

  for (const ALPSConfig &config : hs->config->alps_configs) {
    if (!CBB_add_u8_length_prefixed(&proto_list, &proto) ||
        !CBB_add_bytes(&proto, config.protocol.data(),
                       config.protocol.size())) {
      return false;
    }
  }

  return CBB_flush(out_compressible);
}

static bool ext_alps_add_clienthello(const SSL_HANDSHAKE *hs, CBB *out,
                                     CBB *out_compressible,
                                     ssl_client_hello_type_t type) {
  return ext_alps_add_clienthello_impl(hs, out, out_compressible, type,
                                       /*use_new_codepoint=*/true);
}

static bool ext_alps_add_clienthello_old(const SSL_HANDSHAKE *hs, CBB *out,
                                         CBB *out_compressible,
                                         ssl_client_hello_type_t type) {
  return ext_alps_add_clienthello_impl(hs, out, out_compressible, type,
                                       /*use_new_codepoint=*/false);
}

static bool ext_alps_parse_serverhello_impl(SSL_HANDSHAKE *hs,
                                            uint8_t *out_alert, CBS *contents,
                                            bool use_new_codepoint) {
  SSL *const ssl = hs->ssl;
  if (contents == nullptr) {
    return true;
  }

  assert(!ssl->s3->initial_handshake_complete);
  assert(!hs->config->alpn_client_proto_list.empty());
  assert(!hs->config->alps_configs.empty());
  assert(use_new_codepoint == hs->config->alps_use_new_codepoint);

  // ALPS requires TLS 1.3.
  if (ssl_protocol_version(ssl) < TLS1_3_VERSION) {
    *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
    return false;
  }

  // Note extension callbacks may run in any order, so we defer checking
  // consistency with ALPN to |ssl_check_serverhello_tlsext|.
  if (!hs->new_session->peer_application_settings.CopyFrom(*contents)) {
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return false;
  }

  hs->new_session->has_application_settings = true;
  return true;
}

static bool ext_alps_parse_serverhello(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                                       CBS *contents) {
  return ext_alps_parse_serverhello_impl(hs, out_alert, contents,
                                         /*use_new_codepoint=*/true);
}

static bool ext_alps_parse_serverhello_old(SSL_HANDSHAKE *hs,
                                           uint8_t *out_alert, CBS *contents) {
  return ext_alps_parse_serverhello_impl(hs, out_alert, contents,
                                         /*use_new_codepoint=*/false);
}

static bool ext_alps_add_serverhello_impl(SSL_HANDSHAKE *hs, CBB *out,
                                          bool use_new_codepoint) {
  SSL *const ssl = hs->ssl;
  // If early data is accepted, we omit the ALPS extension. It is implicitly
  // carried over from the previous connection.
  if (hs->new_session == nullptr ||
      !hs->new_session->has_application_settings ||
      ssl->s3->early_data_accepted) {
    return true;
  }

  if (use_new_codepoint != hs->config->alps_use_new_codepoint) {
    // Do nothing, we'll send the other codepoint.
    return true;
  }

  uint16_t extension_type = TLSEXT_TYPE_application_settings_old;
  if (hs->config->alps_use_new_codepoint) {
    extension_type = TLSEXT_TYPE_application_settings;
  }

  CBB contents;
  if (!CBB_add_u16(out, extension_type) ||
      !CBB_add_u16_length_prefixed(out, &contents) ||
      !CBB_add_bytes(&contents,
                     hs->new_session->local_application_settings.data(),
                     hs->new_session->local_application_settings.size()) ||
      !CBB_flush(out)) {
    return false;
  }

  return true;
}

static bool ext_alps_add_serverhello(SSL_HANDSHAKE *hs, CBB *out) {
  return ext_alps_add_serverhello_impl(hs, out, /*use_new_codepoint=*/true);
}

static bool ext_alps_add_serverhello_old(SSL_HANDSHAKE *hs, CBB *out) {
  return ext_alps_add_serverhello_impl(hs, out, /*use_new_codepoint=*/false);
}

bool ssl_negotiate_alps(SSL_HANDSHAKE *hs, uint8_t *out_alert,
                        const SSL_CLIENT_HELLO *client_hello) {
  SSL *const ssl = hs->ssl;
  if (ssl->s3->alpn_selected.empty()) {
    return true;
  }

  // If we negotiate ALPN over TLS 1.3, try to negotiate ALPS.
  CBS alps_contents;
  Span<const uint8_t> settings;
  uint16_t extension_type = TLSEXT_TYPE_application_settings_old;
  if (hs->config->alps_use_new_codepoint) {
    extension_type = TLSEXT_TYPE_application_settings;
  }
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION &&
      ssl_get_local_application_settings(hs, &settings,
                                         ssl->s3->alpn_selected) &&
      ssl_client_hello_get_extension(client_hello, &alps_contents,
                                     extension_type)) {
    // Check if the client supports ALPS with the selected ALPN.
    bool found = false;
    CBS alps_list;
    if (!CBS_get_u16_length_prefixed(&alps_contents, &alps_list) ||  //
        CBS_len(&alps_contents) != 0 ||                              //
        CBS_len(&alps_list) == 0) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }
    while (CBS_len(&alps_list) > 0) {
      CBS protocol_name;
      if (!CBS_get_u8_length_prefixed(&alps_list, &protocol_name) ||
          // Empty protocol names are forbidden.
          CBS_len(&protocol_name) == 0) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
        *out_alert = SSL_AD_DECODE_ERROR;
        return false;
      }
      if (protocol_name == Span(ssl->s3->alpn_selected)) {
        found = true;
      }
    }

    // Negotiate ALPS if both client also supports ALPS for this protocol.
    if (found) {
      hs->new_session->has_application_settings = true;
      if (!hs->new_session->local_application_settings.CopyFrom(settings)) {
        *out_alert = SSL_AD_INTERNAL_ERROR;
        return false;
      }
    }
  }

  return true;
}

// kExtensions contains all the supported extensions.
static const struct tls_extension kExtensions[] = {
    {
        TLSEXT_TYPE_server_name,
        ext_sni_add_clienthello,
        ext_sni_parse_serverhello,
        ext_sni_parse_clienthello,
        ext_sni_add_serverhello,
    },
    {
        TLSEXT_TYPE_encrypted_client_hello,
        ext_ech_add_clienthello,
        ext_ech_parse_serverhello,
        ext_ech_parse_clienthello,
        ext_ech_add_serverhello,
    },
    {
        TLSEXT_TYPE_extended_master_secret,
        ext_ems_add_clienthello,
        ext_ems_parse_serverhello,
        ext_ems_parse_clienthello,
        ext_ems_add_serverhello,
    },
    {
        TLSEXT_TYPE_renegotiate,
        ext_ri_add_clienthello,
        ext_ri_parse_serverhello,
        ext_ri_parse_clienthello,
        ext_ri_add_serverhello,
    },
    {
        TLSEXT_TYPE_supported_groups,
        ext_supported_groups_add_clienthello,
        ext_supported_groups_parse_serverhello,
        ext_supported_groups_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_ec_point_formats,
        ext_ec_point_add_clienthello,
        ext_ec_point_parse_serverhello,
        ext_ec_point_parse_clienthello,
        ext_ec_point_add_serverhello,
    },
    {
        TLSEXT_TYPE_session_ticket,
        ext_ticket_add_clienthello,
        ext_ticket_parse_serverhello,
        // Ticket extension client parsing is handled in ssl_session.c
        ignore_parse_clienthello,
        ext_ticket_add_serverhello,
    },
    {
        TLSEXT_TYPE_application_layer_protocol_negotiation,
        ext_alpn_add_clienthello,
        ext_alpn_parse_serverhello,
        // ALPN is negotiated late in |ssl_negotiate_alpn|.
        ignore_parse_clienthello,
        ext_alpn_add_serverhello,
    },
    {
        TLSEXT_TYPE_status_request,
        ext_ocsp_add_clienthello,
        ext_ocsp_parse_serverhello,
        ext_ocsp_parse_clienthello,
        ext_ocsp_add_serverhello,
    },
    {
        TLSEXT_TYPE_signature_algorithms,
        ext_sigalgs_add_clienthello,
        forbid_parse_serverhello,
        ext_sigalgs_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_next_proto_neg,
        ext_npn_add_clienthello,
        ext_npn_parse_serverhello,
        ext_npn_parse_clienthello,
        ext_npn_add_serverhello,
    },
    {
        TLSEXT_TYPE_certificate_timestamp,
        ext_sct_add_clienthello,
        ext_sct_parse_serverhello,
        ext_sct_parse_clienthello,
        ext_sct_add_serverhello,
    },
    {
        TLSEXT_TYPE_channel_id,
        ext_channel_id_add_clienthello,
        ext_channel_id_parse_serverhello,
        ext_channel_id_parse_clienthello,
        ext_channel_id_add_serverhello,
    },
    {
        TLSEXT_TYPE_srtp,
        ext_srtp_add_clienthello,
        ext_srtp_parse_serverhello,
        ext_srtp_parse_clienthello,
        ext_srtp_add_serverhello,
    },
    {
        TLSEXT_TYPE_key_share,
        ext_key_share_add_clienthello,
        forbid_parse_serverhello,
        ignore_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_psk_key_exchange_modes,
        ext_psk_key_exchange_modes_add_clienthello,
        forbid_parse_serverhello,
        ext_psk_key_exchange_modes_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_early_data,
        ext_early_data_add_clienthello,
        ext_early_data_parse_serverhello,
        ext_early_data_parse_clienthello,
        ext_early_data_add_serverhello,
    },
    {
        TLSEXT_TYPE_supported_versions,
        ext_supported_versions_add_clienthello,
        forbid_parse_serverhello,
        ignore_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_cookie,
        ext_cookie_add_clienthello,
        forbid_parse_serverhello,
        ignore_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_quic_transport_parameters,
        ext_quic_transport_params_add_clienthello,
        ext_quic_transport_params_parse_serverhello,
        ext_quic_transport_params_parse_clienthello,
        ext_quic_transport_params_add_serverhello,
    },
    {
        TLSEXT_TYPE_quic_transport_parameters_legacy,
        ext_quic_transport_params_add_clienthello_legacy,
        ext_quic_transport_params_parse_serverhello_legacy,
        ext_quic_transport_params_parse_clienthello_legacy,
        ext_quic_transport_params_add_serverhello_legacy,
    },
    {
        TLSEXT_TYPE_cert_compression,
        cert_compression_add_clienthello,
        cert_compression_parse_serverhello,
        cert_compression_parse_clienthello,
        cert_compression_add_serverhello,
    },
    {
        TLSEXT_TYPE_delegated_credential,
        ext_delegated_credential_add_clienthello,
        forbid_parse_serverhello,
        ext_delegated_credential_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_application_settings,
        ext_alps_add_clienthello,
        ext_alps_parse_serverhello,
        // ALPS is negotiated late in |ssl_negotiate_alpn|.
        ignore_parse_clienthello,
        ext_alps_add_serverhello,
    },
    {
        TLSEXT_TYPE_application_settings_old,
        ext_alps_add_clienthello_old,
        ext_alps_parse_serverhello_old,
        // ALPS is negotiated late in |ssl_negotiate_alpn|.
        ignore_parse_clienthello,
        ext_alps_add_serverhello_old,
    },
    {
        TLSEXT_TYPE_certificate_authorities,
        ext_certificate_authorities_add_clienthello,
        forbid_parse_serverhello,
        ext_certificate_authorities_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_pake,
        ext_pake_add_clienthello,
        // This extension is unencrypted and so adding and parsing it from the
        // ServerHello is handled elsewhere.
        forbid_parse_serverhello,
        ext_pake_parse_clienthello,
        dont_add_serverhello,
    },
    {
        TLSEXT_TYPE_trust_anchors,
        ext_trust_anchors_add_clienthello,
        ext_trust_anchors_parse_serverhello,
        ext_trust_anchors_parse_clienthello,
        ext_trust_anchors_add_serverhello,
    },
};

#define kNumExtensions (sizeof(kExtensions) / sizeof(struct tls_extension))

static_assert(kNumExtensions <=
                  sizeof(((SSL_HANDSHAKE *)nullptr)->extensions.sent) * 8,
              "too many extensions for sent bitset");
static_assert(kNumExtensions <=
                  sizeof(((SSL_HANDSHAKE *)nullptr)->extensions.received) * 8,
              "too many extensions for received bitset");

bool ssl_setup_extension_permutation(SSL_HANDSHAKE *hs) {
  if (!hs->config->permute_extensions) {
    return true;
  }

  static_assert(kNumExtensions <= UINT8_MAX,
                "extensions_permutation type is too small");
  uint32_t seeds[kNumExtensions - 1];
  Array<uint8_t> permutation;
  if (!RAND_bytes(reinterpret_cast<uint8_t *>(seeds), sizeof(seeds)) ||
      !permutation.InitForOverwrite(kNumExtensions)) {
    return false;
  }
  for (size_t i = 0; i < kNumExtensions; i++) {
    permutation[i] = i;
  }
  for (size_t i = kNumExtensions - 1; i > 0; i--) {
    // Set element |i| to a randomly-selected element 0 <= j <= i.
    std::swap(permutation[i], permutation[seeds[i - 1] % (i + 1)]);
  }
  hs->extension_permutation = std::move(permutation);
  return true;
}

static const struct tls_extension *tls_extension_find(uint32_t *out_index,
                                                      uint16_t value) {
  unsigned i;
  for (i = 0; i < kNumExtensions; i++) {
    if (kExtensions[i].value == value) {
      *out_index = i;
      return &kExtensions[i];
    }
  }

  return nullptr;
}

static bool add_padding_extension(CBB *cbb, uint16_t ext, size_t len) {
  CBB child;
  if (!CBB_add_u16(cbb, ext) ||  //
      !CBB_add_u16_length_prefixed(cbb, &child) ||
      !CBB_add_zeros(&child, len)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }
  return CBB_flush(cbb);
}

static bool ssl_add_clienthello_tlsext_inner(SSL_HANDSHAKE *hs, CBB *out,
                                             CBB *out_encoded,
                                             bool *out_needs_psk_binder) {
  // When writing ClientHelloInner, we construct the real and encoded
  // ClientHellos concurrently, to handle compression. Uncompressed extensions
  // are written to |extensions| and copied to |extensions_encoded|. Compressed
  // extensions are buffered in |compressed| and written to the end. (ECH can
  // only compress contiguous extensions.)
  SSL *const ssl = hs->ssl;
  bssl::ScopedCBB compressed, outer_extensions;
  CBB extensions, extensions_encoded;
  if (!CBB_add_u16_length_prefixed(out, &extensions) ||
      !CBB_add_u16_length_prefixed(out_encoded, &extensions_encoded) ||
      !CBB_init(compressed.get(), 64) ||
      !CBB_init(outer_extensions.get(), 64)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  hs->inner_extensions_sent = 0;

  if (ssl->ctx->grease_enabled) {
    // Add a fake empty extension. See RFC 8701. This always matches
    // |ssl_add_clienthello_tlsext|, so compress it.
    uint16_t grease_ext = ssl_get_grease_value(hs, ssl_grease_extension1);
    if (!add_padding_extension(compressed.get(), grease_ext, 0) ||
        !CBB_add_u16(outer_extensions.get(), grease_ext)) {
      return false;
    }
  }

  for (size_t unpermuted = 0; unpermuted < kNumExtensions; unpermuted++) {
    size_t i = hs->extension_permutation.empty()
                   ? unpermuted
                   : hs->extension_permutation[unpermuted];
    const size_t len_before = CBB_len(&extensions);
    const size_t len_compressed_before = CBB_len(compressed.get());
    if (!kExtensions[i].add_clienthello(hs, &extensions, compressed.get(),
                                        ssl_client_hello_inner)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_ERROR_ADDING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)kExtensions[i].value);
      return false;
    }

    const size_t bytes_written = CBB_len(&extensions) - len_before;
    const size_t bytes_written_compressed =
        CBB_len(compressed.get()) - len_compressed_before;
    // The callback may write to at most one output.
    assert(bytes_written == 0 || bytes_written_compressed == 0);
    if (bytes_written != 0 || bytes_written_compressed != 0) {
      hs->inner_extensions_sent |= (1u << i);
    }
    // If compressed, update the running ech_outer_extensions extension.
    if (bytes_written_compressed != 0 &&
        !CBB_add_u16(outer_extensions.get(), kExtensions[i].value)) {
      return false;
    }
  }

  if (ssl->ctx->grease_enabled) {
    // Add a fake non-empty extension. See RFC 8701. This always matches
    // |ssl_add_clienthello_tlsext|, so compress it.
    uint16_t grease_ext = ssl_get_grease_value(hs, ssl_grease_extension2);
    if (!add_padding_extension(compressed.get(), grease_ext, 1) ||
        !CBB_add_u16(outer_extensions.get(), grease_ext)) {
      return false;
    }
  }

  // Uncompressed extensions are encoded as-is.
  if (!CBB_add_bytes(&extensions_encoded, CBB_data(&extensions),
                     CBB_len(&extensions))) {
    return false;
  }

  // Flush all the compressed extensions.
  if (CBB_len(compressed.get()) != 0) {
    CBB extension, child;
    // Copy them as-is in the real ClientHelloInner.
    if (!CBB_add_bytes(&extensions, CBB_data(compressed.get()),
                       CBB_len(compressed.get())) ||
        // Replace with ech_outer_extensions in the encoded form.
        !CBB_add_u16(&extensions_encoded, TLSEXT_TYPE_ech_outer_extensions) ||
        !CBB_add_u16_length_prefixed(&extensions_encoded, &extension) ||
        !CBB_add_u8_length_prefixed(&extension, &child) ||
        !CBB_add_bytes(&child, CBB_data(outer_extensions.get()),
                       CBB_len(outer_extensions.get())) ||
        !CBB_flush(&extensions_encoded)) {
      return false;
    }
  }

  // The PSK extension must be last. It is never compressed. Note, if there is a
  // binder, the caller will need to update both ClientHelloInner and
  // EncodedClientHelloInner after computing it.
  const size_t len_before = CBB_len(&extensions);
  if (!ext_pre_shared_key_add_clienthello(hs, &extensions, out_needs_psk_binder,
                                          ssl_client_hello_inner) ||
      !CBB_add_bytes(&extensions_encoded, CBB_data(&extensions) + len_before,
                     CBB_len(&extensions) - len_before) ||
      !CBB_flush(out) ||  //
      !CBB_flush(out_encoded)) {
    return false;
  }

  return true;
}

bool ssl_add_clienthello_tlsext(SSL_HANDSHAKE *hs, CBB *out, CBB *out_encoded,
                                bool *out_needs_psk_binder,
                                ssl_client_hello_type_t type,
                                size_t header_len) {
  *out_needs_psk_binder = false;

  if (type == ssl_client_hello_inner) {
    return ssl_add_clienthello_tlsext_inner(hs, out, out_encoded,
                                            out_needs_psk_binder);
  }

  assert(out_encoded == nullptr);  // Only ClientHelloInner needs two outputs.
  SSL *const ssl = hs->ssl;
  CBB extensions;
  if (!CBB_add_u16_length_prefixed(out, &extensions)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // Note we may send multiple ClientHellos for DTLS HelloVerifyRequest and TLS
  // 1.3 HelloRetryRequest. For the latter, the extensions may change, so it is
  // important to reset this value.
  hs->extensions.sent = 0;

  // Add a fake empty extension. See RFC 8701.
  if (ssl->ctx->grease_enabled &&
      !add_padding_extension(
          &extensions, ssl_get_grease_value(hs, ssl_grease_extension1), 0)) {
    return false;
  }

  bool last_was_empty = false;
  for (size_t unpermuted = 0; unpermuted < kNumExtensions; unpermuted++) {
    size_t i = hs->extension_permutation.empty()
                   ? unpermuted
                   : hs->extension_permutation[unpermuted];
    const size_t len_before = CBB_len(&extensions);
    if (!kExtensions[i].add_clienthello(hs, &extensions, &extensions, type)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_ERROR_ADDING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)kExtensions[i].value);
      return false;
    }

    const size_t bytes_written = CBB_len(&extensions) - len_before;
    if (bytes_written != 0) {
      hs->extensions.sent |= (1u << i);
    }
    // If the difference in lengths is only four bytes then the extension had
    // an empty body.
    last_was_empty = (bytes_written == 4);
  }

  if (ssl->ctx->grease_enabled) {
    // Add a fake non-empty extension. See RFC 8701.
    if (!add_padding_extension(
            &extensions, ssl_get_grease_value(hs, ssl_grease_extension2), 1)) {
      return false;
    }
    last_was_empty = false;
  }

  // In cleartext ClientHellos, we add the padding extension to work around
  // bugs. We also apply this padding to ClientHelloOuter, to keep the wire
  // images aligned.
  size_t psk_extension_len = ext_pre_shared_key_clienthello_length(hs, type);
  if (!SSL_is_dtls(ssl) && !SSL_is_quic(ssl) &&
      !ssl->s3->used_hello_retry_request) {
    header_len +=
        SSL3_HM_HEADER_LENGTH + 2 + CBB_len(&extensions) + psk_extension_len;
    size_t padding_len = 0;

    // The final extension must be non-empty. WebSphere Application
    // Server 7.0 is intolerant to the last extension being zero-length. See
    // https://crbug.com/363583.
    if (last_was_empty && psk_extension_len == 0) {
      padding_len = 1;
      // The addition of the padding extension may push us into the F5 bug.
      header_len += 4 + padding_len;
    }

    // Add padding to workaround bugs in F5 terminators. See RFC 7685.
    //
    // NB: because this code works out the length of all existing extensions
    // it MUST always appear last (save for any PSK extension).
    if (header_len > 0xff && header_len < 0x200) {
      // If our calculations already included a padding extension, remove that
      // factor because we're about to change its length.
      if (padding_len != 0) {
        header_len -= 4 + padding_len;
      }
      padding_len = 0x200 - header_len;
      // Extensions take at least four bytes to encode. Always include at least
      // one byte of data if including the extension. WebSphere Application
      // Server 7.0 is intolerant to the last extension being zero-length. See
      // https://crbug.com/363583.
      if (padding_len >= 4 + 1) {
        padding_len -= 4;
      } else {
        padding_len = 1;
      }
    }

    if (padding_len != 0 &&
        !add_padding_extension(&extensions, TLSEXT_TYPE_padding, padding_len)) {
      return false;
    }
  }

  // The PSK extension must be last, including after the padding.
  const size_t len_before = CBB_len(&extensions);
  if (!ext_pre_shared_key_add_clienthello(hs, &extensions, out_needs_psk_binder,
                                          type)) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }
  assert(psk_extension_len == CBB_len(&extensions) - len_before);
  (void)len_before;  // |assert| is omitted in release builds.

  // Discard empty extensions blocks.
  if (CBB_len(&extensions) == 0) {
    CBB_discard_child(out);
  }

  return CBB_flush(out);
}

bool ssl_add_serverhello_tlsext(SSL_HANDSHAKE *hs, CBB *out) {
  SSL *const ssl = hs->ssl;
  CBB extensions;
  if (!CBB_add_u16_length_prefixed(out, &extensions)) {
    goto err;
  }

  for (unsigned i = 0; i < kNumExtensions; i++) {
    if (!(hs->extensions.received & (1u << i))) {
      // Don't send extensions that were not received.
      continue;
    }

    if (!kExtensions[i].add_serverhello(hs, &extensions)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_ERROR_ADDING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)kExtensions[i].value);
      goto err;
    }
  }

  // Discard empty extensions blocks before TLS 1.3.
  if (ssl_protocol_version(ssl) < TLS1_3_VERSION &&  //
      CBB_len(&extensions) == 0) {
    CBB_discard_child(out);
  }

  return CBB_flush(out);

err:
  OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
  return false;
}

static bool ssl_scan_clienthello_tlsext(SSL_HANDSHAKE *hs,
                                        const SSL_CLIENT_HELLO *client_hello,
                                        int *out_alert) {
  hs->extensions.received = 0;
  CBS extensions;
  CBS_init(&extensions, client_hello->extensions, client_hello->extensions_len);
  while (CBS_len(&extensions) != 0) {
    uint16_t type;
    CBS extension;

    // Decode the next extension.
    if (!CBS_get_u16(&extensions, &type) ||
        !CBS_get_u16_length_prefixed(&extensions, &extension)) {
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }

    unsigned ext_index;
    const struct tls_extension *const ext =
        tls_extension_find(&ext_index, type);
    if (ext == nullptr) {
      continue;
    }

    hs->extensions.received |= (1u << ext_index);
    uint8_t alert = SSL_AD_DECODE_ERROR;
    if (!ext->parse_clienthello(hs, &alert, &extension)) {
      *out_alert = alert;
      OPENSSL_PUT_ERROR(SSL, SSL_R_ERROR_PARSING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)type);
      return false;
    }
  }

  for (size_t i = 0; i < kNumExtensions; i++) {
    if (hs->extensions.received & (1u << i)) {
      continue;
    }

    CBS *contents = nullptr, fake_contents;
    static const uint8_t kFakeRenegotiateExtension[] = {0};
    if (kExtensions[i].value == TLSEXT_TYPE_renegotiate &&
        ssl_client_cipher_list_contains_cipher(
            client_hello, SSL_CIPHER_EMPTY_RENEGOTIATION_INFO_SCSV)) {
      // The renegotiation SCSV was received so pretend that we received a
      // renegotiation extension.
      CBS_init(&fake_contents, kFakeRenegotiateExtension,
               sizeof(kFakeRenegotiateExtension));
      contents = &fake_contents;
      hs->extensions.received |= (1u << i);
    }

    // Extension wasn't observed so call the callback with a NULL
    // parameter.
    uint8_t alert = SSL_AD_DECODE_ERROR;
    if (!kExtensions[i].parse_clienthello(hs, &alert, contents)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_MISSING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)kExtensions[i].value);
      *out_alert = alert;
      return false;
    }
  }

  return true;
}

bool ssl_parse_clienthello_tlsext(SSL_HANDSHAKE *hs,
                                  const SSL_CLIENT_HELLO *client_hello) {
  SSL *const ssl = hs->ssl;
  int alert = SSL_AD_DECODE_ERROR;
  if (!ssl_scan_clienthello_tlsext(hs, client_hello, &alert)) {
    ssl_send_alert(ssl, SSL3_AL_FATAL, alert);
    return false;
  }

  if (!ssl_check_clienthello_tlsext(hs)) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_TLSEXT);
    return false;
  }

  return true;
}

static bool ssl_scan_serverhello_tlsext(SSL_HANDSHAKE *hs, const CBS *cbs,
                                        int *out_alert) {
  CBS extensions = *cbs;
  if (!tls1_check_duplicate_extensions(&extensions)) {
    *out_alert = SSL_AD_DECODE_ERROR;
    return false;
  }

  uint32_t received = 0;
  while (CBS_len(&extensions) != 0) {
    uint16_t type;
    CBS extension;

    // Decode the next extension.
    if (!CBS_get_u16(&extensions, &type) ||
        !CBS_get_u16_length_prefixed(&extensions, &extension)) {
      *out_alert = SSL_AD_DECODE_ERROR;
      return false;
    }

    unsigned ext_index;
    const struct tls_extension *const ext =
        tls_extension_find(&ext_index, type);

    if (ext == nullptr) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)type);
      *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
      return false;
    }

    static_assert(kNumExtensions <= sizeof(hs->extensions.sent) * 8,
                  "too many bits");

    if (!(hs->extensions.sent & (1u << ext_index))) {
      // If the extension was never sent then it is illegal.
      OPENSSL_PUT_ERROR(SSL, SSL_R_UNEXPECTED_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)type);
      *out_alert = SSL_AD_UNSUPPORTED_EXTENSION;
      return false;
    }

    received |= (1u << ext_index);

    uint8_t alert = SSL_AD_DECODE_ERROR;
    if (!ext->parse_serverhello(hs, &alert, &extension)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_ERROR_PARSING_EXTENSION);
      ERR_add_error_dataf("extension %u", (unsigned)type);
      *out_alert = alert;
      return false;
    }
  }

  for (size_t i = 0; i < kNumExtensions; i++) {
    if (!(received & (1u << i))) {
      // Extension wasn't observed so call the callback with a NULL
      // parameter.
      uint8_t alert = SSL_AD_DECODE_ERROR;
      if (!kExtensions[i].parse_serverhello(hs, &alert, nullptr)) {
        OPENSSL_PUT_ERROR(SSL, SSL_R_MISSING_EXTENSION);
        ERR_add_error_dataf("extension %u", (unsigned)kExtensions[i].value);
        *out_alert = alert;
        return false;
      }
    }
  }

  return true;
}

static bool ssl_check_clienthello_tlsext(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  int ret = SSL_TLSEXT_ERR_NOACK;
  int al = SSL_AD_UNRECOGNIZED_NAME;
  if (ssl->ctx->servername_callback != nullptr) {
    ret = ssl->ctx->servername_callback(ssl, &al, ssl->ctx->servername_arg);
  } else if (ssl->session_ctx->servername_callback != nullptr) {
    ret = ssl->session_ctx->servername_callback(
        ssl, &al, ssl->session_ctx->servername_arg);
  }

  switch (ret) {
    case SSL_TLSEXT_ERR_ALERT_FATAL:
      ssl_send_alert(ssl, SSL3_AL_FATAL, al);
      return false;

    case SSL_TLSEXT_ERR_NOACK:
      hs->should_ack_sni = false;
      return true;

    default:
      hs->should_ack_sni = ssl->s3->hostname != nullptr;
      return true;
  }
}

static bool ssl_check_serverhello_tlsext(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  // ALPS and ALPN have a dependency between each other, so we defer checking
  // consistency to after the callbacks run.
  if (hs->new_session != nullptr && hs->new_session->has_application_settings) {
    // ALPN must be negotiated.
    if (ssl->s3->alpn_selected.empty()) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_NEGOTIATED_ALPS_WITHOUT_ALPN);
      ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_ILLEGAL_PARAMETER);
      return false;
    }

    // The negotiated protocol must be one of the ones we advertised for ALPS.
    Span<const uint8_t> settings;
    if (!ssl_get_local_application_settings(hs, &settings,
                                            ssl->s3->alpn_selected)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_INVALID_ALPN_PROTOCOL);
      ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_ILLEGAL_PARAMETER);
      return false;
    }

    if (!hs->new_session->local_application_settings.CopyFrom(settings)) {
      ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_INTERNAL_ERROR);
      return false;
    }
  }

  return true;
}

bool ssl_parse_serverhello_tlsext(SSL_HANDSHAKE *hs, const CBS *cbs) {
  SSL *const ssl = hs->ssl;
  int alert = SSL_AD_DECODE_ERROR;
  if (!ssl_scan_serverhello_tlsext(hs, cbs, &alert)) {
    ssl_send_alert(ssl, SSL3_AL_FATAL, alert);
    return false;
  }

  if (!ssl_check_serverhello_tlsext(hs)) {
    return false;
  }

  return true;
}

static enum ssl_ticket_aead_result_t decrypt_ticket_with_cipher_ctx(
    Array<uint8_t> *out, EVP_CIPHER_CTX *cipher_ctx, HMAC_CTX *hmac_ctx,
    Span<const uint8_t> ticket) {
  size_t iv_len = EVP_CIPHER_CTX_iv_length(cipher_ctx);

  // Check the MAC at the end of the ticket.
  uint8_t mac[EVP_MAX_MD_SIZE];
  size_t mac_len = HMAC_size(hmac_ctx);
  if (ticket.size() < SSL_TICKET_KEY_NAME_LEN + iv_len + 1 + mac_len) {
    // The ticket must be large enough for key name, IV, data, and MAC.
    return ssl_ticket_aead_ignore_ticket;
  }
  // Split the ticket into the ticket and the MAC.
  auto ticket_mac = ticket.last(mac_len);
  ticket = ticket.first(ticket.size() - mac_len);
  HMAC_Update(hmac_ctx, ticket.data(), ticket.size());
  HMAC_Final(hmac_ctx, mac, nullptr);
  assert(mac_len == ticket_mac.size());
  bool mac_ok = CRYPTO_memcmp(mac, ticket_mac.data(), mac_len) == 0;
  if (CRYPTO_fuzzer_mode_enabled()) {
    mac_ok = true;
  }
  if (!mac_ok) {
    return ssl_ticket_aead_ignore_ticket;
  }

  // Decrypt the session data.
  auto ciphertext = ticket.subspan(SSL_TICKET_KEY_NAME_LEN + iv_len);
  Array<uint8_t> plaintext;
  if (CRYPTO_fuzzer_mode_enabled()) {
    if (!plaintext.CopyFrom(ciphertext)) {
      return ssl_ticket_aead_error;
    }
  } else {
    if (ciphertext.size() >= INT_MAX) {
      return ssl_ticket_aead_ignore_ticket;
    }
    if (!plaintext.InitForOverwrite(ciphertext.size())) {
      return ssl_ticket_aead_error;
    }
    int len1, len2;
    if (!EVP_DecryptUpdate(cipher_ctx, plaintext.data(), &len1,
                           ciphertext.data(), (int)ciphertext.size()) ||
        !EVP_DecryptFinal_ex(cipher_ctx, plaintext.data() + len1, &len2)) {
      ERR_clear_error();
      return ssl_ticket_aead_ignore_ticket;
    }
    plaintext.Shrink(static_cast<size_t>(len1) + len2);
  }

  *out = std::move(plaintext);
  return ssl_ticket_aead_success;
}

static enum ssl_ticket_aead_result_t ssl_decrypt_ticket_with_cb(
    SSL_HANDSHAKE *hs, Array<uint8_t> *out, bool *out_renew_ticket,
    Span<const uint8_t> ticket) {
  assert(ticket.size() >= SSL_TICKET_KEY_NAME_LEN + EVP_MAX_IV_LENGTH);
  ScopedEVP_CIPHER_CTX cipher_ctx;
  ScopedHMAC_CTX hmac_ctx;
  auto name = ticket.first<SSL_TICKET_KEY_NAME_LEN>();
  // The actual IV is shorter, but the length is determined by the callback's
  // chosen cipher. Instead we pass in |EVP_MAX_IV_LENGTH| worth of IV to ensure
  // the callback has enough.
  auto iv = ticket.subspan<SSL_TICKET_KEY_NAME_LEN, EVP_MAX_IV_LENGTH>();
  int cb_ret = hs->ssl->session_ctx->ticket_key_cb(
      hs->ssl, const_cast<uint8_t *>(name.data()),
      const_cast<uint8_t *>(iv.data()), cipher_ctx.get(), hmac_ctx.get(),
      0 /* decrypt */);
  if (cb_ret < 0) {
    return ssl_ticket_aead_error;
  } else if (cb_ret == 0) {
    return ssl_ticket_aead_ignore_ticket;
  } else if (cb_ret == 2) {
    *out_renew_ticket = true;
  } else {
    assert(cb_ret == 1);
  }
  return decrypt_ticket_with_cipher_ctx(out, cipher_ctx.get(), hmac_ctx.get(),
                                        ticket);
}

static enum ssl_ticket_aead_result_t ssl_decrypt_ticket_with_ticket_keys(
    SSL_HANDSHAKE *hs, Array<uint8_t> *out, Span<const uint8_t> ticket) {
  assert(ticket.size() >= SSL_TICKET_KEY_NAME_LEN + EVP_MAX_IV_LENGTH);
  SSL_CTX *ctx = hs->ssl->session_ctx.get();

  // Rotate the ticket key if necessary.
  if (!ssl_ctx_rotate_ticket_encryption_key(ctx)) {
    return ssl_ticket_aead_error;
  }

  const EVP_CIPHER *cipher = EVP_aes_128_cbc();
  auto name = ticket.first<SSL_TICKET_KEY_NAME_LEN>();
  auto iv =
      ticket.subspan(SSL_TICKET_KEY_NAME_LEN, EVP_CIPHER_iv_length(cipher));

  // Pick the matching ticket key and decrypt.
  ScopedEVP_CIPHER_CTX cipher_ctx;
  ScopedHMAC_CTX hmac_ctx;
  {
    MutexReadLock lock(&ctx->lock);
    const TicketKey *key;
    if (ctx->ticket_key_current && name == ctx->ticket_key_current->name) {
      key = ctx->ticket_key_current.get();
    } else if (ctx->ticket_key_prev && name == ctx->ticket_key_prev->name) {
      key = ctx->ticket_key_prev.get();
    } else {
      return ssl_ticket_aead_ignore_ticket;
    }
    if (!HMAC_Init_ex(hmac_ctx.get(), key->hmac_key, sizeof(key->hmac_key),
                      tlsext_tick_md(), nullptr) ||
        !EVP_DecryptInit_ex(cipher_ctx.get(), cipher, nullptr, key->aes_key,
                            iv.data())) {
      return ssl_ticket_aead_error;
    }
  }
  return decrypt_ticket_with_cipher_ctx(out, cipher_ctx.get(), hmac_ctx.get(),
                                        ticket);
}

static enum ssl_ticket_aead_result_t ssl_decrypt_ticket_with_method(
    SSL_HANDSHAKE *hs, Array<uint8_t> *out, bool *out_renew_ticket,
    Span<const uint8_t> ticket) {
  Array<uint8_t> plaintext;
  if (!plaintext.InitForOverwrite(ticket.size())) {
    return ssl_ticket_aead_error;
  }

  size_t plaintext_len;
  const enum ssl_ticket_aead_result_t result =
      hs->ssl->session_ctx->ticket_aead_method->open(
          hs->ssl, plaintext.data(), &plaintext_len, ticket.size(),
          ticket.data(), ticket.size());
  if (result != ssl_ticket_aead_success) {
    return result;
  }

  plaintext.Shrink(plaintext_len);
  *out = std::move(plaintext);
  return ssl_ticket_aead_success;
}

enum ssl_ticket_aead_result_t ssl_process_ticket(
    SSL_HANDSHAKE *hs, UniquePtr<SSL_SESSION> *out_session,
    bool *out_renew_ticket, Span<const uint8_t> ticket,
    Span<const uint8_t> session_id) {
  SSL *const ssl = hs->ssl;
  *out_renew_ticket = false;
  out_session->reset();

  if ((SSL_get_options(hs->ssl) & SSL_OP_NO_TICKET) ||
      session_id.size() > SSL_MAX_SSL_SESSION_ID_LENGTH) {
    return ssl_ticket_aead_ignore_ticket;
  }

  // Tickets in TLS 1.3 are tied into pre-shared keys (PSKs), unlike in TLS 1.2
  // where that concept doesn't exist. The |decrypted_psk| and |ignore_psk|
  // hints only apply to PSKs. We check the version to determine which this is.
  const bool is_psk = ssl_protocol_version(ssl) >= TLS1_3_VERSION;

  Array<uint8_t> plaintext;
  enum ssl_ticket_aead_result_t result;
  SSL_HANDSHAKE_HINTS *const hints = hs->hints.get();
  if (is_psk && hints && !hs->hints_requested &&
      !hints->decrypted_psk.empty()) {
    result = plaintext.CopyFrom(hints->decrypted_psk) ? ssl_ticket_aead_success
                                                      : ssl_ticket_aead_error;
  } else if (is_psk && hints && !hs->hints_requested && hints->ignore_psk) {
    result = ssl_ticket_aead_ignore_ticket;
  } else if (!is_psk && hints && !hs->hints_requested &&
             !hints->decrypted_ticket.empty()) {
    if (plaintext.CopyFrom(hints->decrypted_ticket)) {
      result = ssl_ticket_aead_success;
      *out_renew_ticket = hints->renew_ticket;
    } else {
      result = ssl_ticket_aead_error;
    }
  } else if (!is_psk && hints && !hs->hints_requested && hints->ignore_ticket) {
    result = ssl_ticket_aead_ignore_ticket;
  } else if (ssl->session_ctx->ticket_aead_method != nullptr) {
    result = ssl_decrypt_ticket_with_method(hs, &plaintext, out_renew_ticket,
                                            ticket);
  } else {
    // Ensure there is room for the key name and the largest IV |ticket_key_cb|
    // may try to consume. The real limit may be lower, but the maximum IV
    // length should be well under the minimum size for the session material and
    // HMAC.
    if (ticket.size() < SSL_TICKET_KEY_NAME_LEN + EVP_MAX_IV_LENGTH) {
      result = ssl_ticket_aead_ignore_ticket;
    } else if (ssl->session_ctx->ticket_key_cb != nullptr) {
      result =
          ssl_decrypt_ticket_with_cb(hs, &plaintext, out_renew_ticket, ticket);
    } else {
      result = ssl_decrypt_ticket_with_ticket_keys(hs, &plaintext, ticket);
    }
  }

  if (hints && hs->hints_requested) {
    if (result == ssl_ticket_aead_ignore_ticket) {
      if (is_psk) {
        hints->ignore_psk = true;
      } else {
        hints->ignore_ticket = true;
      }
    } else if (result == ssl_ticket_aead_success) {
      if (is_psk) {
        if (!hints->decrypted_psk.CopyFrom(plaintext)) {
          return ssl_ticket_aead_error;
        }
      } else {
        if (!hints->decrypted_ticket.CopyFrom(plaintext)) {
          return ssl_ticket_aead_error;
        }
        hints->renew_ticket = *out_renew_ticket;
      }
    }
  }

  if (result != ssl_ticket_aead_success) {
    return result;
  }

  // Decode the session.
  UniquePtr<SSL_SESSION> session(SSL_SESSION_from_bytes(
      plaintext.data(), plaintext.size(), ssl->ctx.get()));
  if (!session) {
    ERR_clear_error();  // Don't leave an error on the queue.
    return ssl_ticket_aead_ignore_ticket;
  }

  // Envoy's tests expect the session to have a session ID that matches the
  // placeholder used by the client. It's unclear whether this is a good idea,
  // but we maintain it for now.
  session->session_id.ResizeForOverwrite(SHA256_DIGEST_LENGTH);
  SHA256(ticket.data(), ticket.size(), session->session_id.data());

  *out_session = std::move(session);
  return ssl_ticket_aead_success;
}

bool tls1_parse_peer_sigalgs(SSL_HANDSHAKE *hs, const CBS *in_sigalgs) {
  // Extension ignored for inappropriate versions
  if (ssl_protocol_version(hs->ssl) < TLS1_2_VERSION) {
    return true;
  }

  // In all contexts, the signature algorithms list may not be empty. (It may be
  // omitted by clients in TLS 1.2, but then the entire extension is omitted.)
  return CBS_len(in_sigalgs) != 0 &&
         parse_u16_array(in_sigalgs, &hs->peer_sigalgs);
}

bool tls1_get_legacy_signature_algorithm(uint16_t *out, const EVP_PKEY *pkey) {
  switch (EVP_PKEY_id(pkey)) {
    case EVP_PKEY_RSA:
      *out = SSL_SIGN_RSA_PKCS1_MD5_SHA1;
      return true;
    case EVP_PKEY_EC:
      *out = SSL_SIGN_ECDSA_SHA1;
      return true;
    default:
      return false;
  }
}

bool tls1_choose_signature_algorithm(SSL_HANDSHAKE *hs,
                                     const SSL_CREDENTIAL *cred,
                                     uint16_t *out) {
  SSL *const ssl = hs->ssl;
  if (!cred->UsesPrivateKey()) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_UNKNOWN_CERTIFICATE_TYPE);
    return false;
  }

  // Before TLS 1.2, the signature algorithm isn't negotiated as part of the
  // handshake.
  uint16_t version = ssl_protocol_version(ssl);
  if (version < TLS1_2_VERSION) {
    if (!tls1_get_legacy_signature_algorithm(out, cred->pubkey.get())) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_NO_COMMON_SIGNATURE_ALGORITHMS);
      return false;
    }
    return true;
  }

  Span<const uint16_t> peer_sigalgs;
  if (cred->type == SSLCredentialType::kDelegated) {
    peer_sigalgs = hs->peer_delegated_credential_sigalgs;
  } else {
    peer_sigalgs = hs->peer_sigalgs;
    if (peer_sigalgs.empty() && version == TLS1_2_VERSION) {
      // If the client didn't specify any signature_algorithms extension, it is
      // interpreted as SHA-1. See
      // http://tools.ietf.org/html/rfc5246#section-7.4.1.4.1
      static const uint16_t kTLS12Default[] = {SSL_SIGN_RSA_PKCS1_SHA1,
                                               SSL_SIGN_ECDSA_SHA1};
      peer_sigalgs = kTLS12Default;
    }
  }

  Span<const uint16_t> sigalgs =
      cred->sigalgs.empty() ? Span<const uint16_t>(kSignSignatureAlgorithms)
                            : Span<const uint16_t>(cred->sigalgs);
  for (uint16_t sigalg : sigalgs) {
    if (!ssl_pkey_supports_algorithm(ssl, cred->pubkey.get(), sigalg,
                                     /*is_verify=*/false)) {
      continue;
    }

    if (std::find(peer_sigalgs.begin(), peer_sigalgs.end(), sigalg) !=
        peer_sigalgs.end()) {
      *out = sigalg;
      return true;
    }
  }

  OPENSSL_PUT_ERROR(SSL, SSL_R_NO_COMMON_SIGNATURE_ALGORITHMS);
  return false;
}

bool tls1_verify_channel_id(SSL_HANDSHAKE *hs, const SSLMessage &msg) {
  SSL *const ssl = hs->ssl;
  // A Channel ID handshake message is structured to contain multiple
  // extensions, but the only one that can be present is Channel ID.
  uint16_t extension_type;
  CBS channel_id = msg.body, extension;
  if (!CBS_get_u16(&channel_id, &extension_type) ||             //
      !CBS_get_u16_length_prefixed(&channel_id, &extension) ||  //
      CBS_len(&channel_id) != 0 ||                              //
      extension_type != TLSEXT_TYPE_channel_id ||               //
      CBS_len(&extension) != TLSEXT_CHANNEL_ID_SIZE) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_DECODE_ERROR);
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_DECODE_ERROR);
    return false;
  }

  const EC_GROUP *p256 = EC_group_p256();
  UniquePtr<ECDSA_SIG> sig(ECDSA_SIG_new());
  UniquePtr<BIGNUM> x(BN_new()), y(BN_new());
  if (!sig || !x || !y) {
    return false;
  }

  const uint8_t *p = CBS_data(&extension);
  if (BN_bin2bn(p + 0, 32, x.get()) == nullptr ||
      BN_bin2bn(p + 32, 32, y.get()) == nullptr ||
      BN_bin2bn(p + 64, 32, sig->r) == nullptr ||
      BN_bin2bn(p + 96, 32, sig->s) == nullptr) {
    return false;
  }

  UniquePtr<EC_KEY> key(EC_KEY_new());
  UniquePtr<EC_POINT> point(EC_POINT_new(p256));
  if (!key || !point ||
      !EC_POINT_set_affine_coordinates_GFp(p256, point.get(), x.get(), y.get(),
                                           nullptr) ||
      !EC_KEY_set_group(key.get(), p256) ||
      !EC_KEY_set_public_key(key.get(), point.get())) {
    return false;
  }

  uint8_t digest[EVP_MAX_MD_SIZE];
  size_t digest_len;
  if (!tls1_channel_id_hash(hs, digest, &digest_len)) {
    return false;
  }

  bool sig_ok = ECDSA_do_verify(digest, digest_len, sig.get(), key.get());
  if (CRYPTO_fuzzer_mode_enabled()) {
    sig_ok = true;
    ERR_clear_error();
  }
  if (!sig_ok) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CHANNEL_ID_SIGNATURE_INVALID);
    ssl_send_alert(ssl, SSL3_AL_FATAL, SSL_AD_DECRYPT_ERROR);
    return false;
  }

  OPENSSL_memcpy(ssl->s3->channel_id, p, 64);
  ssl->s3->channel_id_valid = true;
  return true;
}

bool tls1_write_channel_id(SSL_HANDSHAKE *hs, CBB *cbb) {
  uint8_t digest[EVP_MAX_MD_SIZE];
  size_t digest_len;
  if (!tls1_channel_id_hash(hs, digest, &digest_len)) {
    return false;
  }

  EC_KEY *ec_key = EVP_PKEY_get0_EC_KEY(hs->config->channel_id_private.get());
  if (ec_key == nullptr) {
    OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
    return false;
  }

  UniquePtr<BIGNUM> x(BN_new()), y(BN_new());
  if (!x || !y ||
      !EC_POINT_get_affine_coordinates_GFp(EC_KEY_get0_group(ec_key),
                                           EC_KEY_get0_public_key(ec_key),
                                           x.get(), y.get(), nullptr)) {
    return false;
  }

  UniquePtr<ECDSA_SIG> sig(ECDSA_do_sign(digest, digest_len, ec_key));
  if (!sig) {
    return false;
  }

  CBB child;
  if (!CBB_add_u16(cbb, TLSEXT_TYPE_channel_id) ||  //
      !CBB_add_u16_length_prefixed(cbb, &child) ||  //
      !BN_bn2cbb_padded(&child, 32, x.get()) ||     //
      !BN_bn2cbb_padded(&child, 32, y.get()) ||     //
      !BN_bn2cbb_padded(&child, 32, sig->r) ||      //
      !BN_bn2cbb_padded(&child, 32, sig->s) ||      //
      !CBB_flush(cbb)) {
    return false;
  }

  return true;
}

bool tls1_channel_id_hash(SSL_HANDSHAKE *hs, uint8_t *out, size_t *out_len) {
  SSL *const ssl = hs->ssl;
  if (ssl_protocol_version(ssl) >= TLS1_3_VERSION) {
    Array<uint8_t> msg;
    if (!tls13_get_cert_verify_signature_input(hs, &msg,
                                               ssl_cert_verify_channel_id)) {
      return false;
    }
    SHA256(msg.data(), msg.size(), out);
    *out_len = SHA256_DIGEST_LENGTH;
    return true;
  }

  SHA256_CTX ctx;

  SHA256_Init(&ctx);
  static const char kClientIDMagic[] = "TLS Channel ID signature";
  SHA256_Update(&ctx, kClientIDMagic, sizeof(kClientIDMagic));

  if (ssl->session != nullptr) {
    static const char kResumptionMagic[] = "Resumption";
    SHA256_Update(&ctx, kResumptionMagic, sizeof(kResumptionMagic));
    if (ssl->session->original_handshake_hash.empty()) {
      OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
      return false;
    }
    SHA256_Update(&ctx, ssl->session->original_handshake_hash.data(),
                  ssl->session->original_handshake_hash.size());
  }

  uint8_t hs_hash[EVP_MAX_MD_SIZE];
  size_t hs_hash_len;
  if (!hs->transcript.GetHash(hs_hash, &hs_hash_len)) {
    return false;
  }
  SHA256_Update(&ctx, hs_hash, (size_t)hs_hash_len);
  SHA256_Final(out, &ctx);
  *out_len = SHA256_DIGEST_LENGTH;
  return true;
}

bool tls1_record_handshake_hashes_for_channel_id(SSL_HANDSHAKE *hs) {
  SSL *const ssl = hs->ssl;
  // This function should never be called for a resumed session because the
  // handshake hashes that we wish to record are for the original, full
  // handshake.
  if (ssl->session != nullptr) {
    return false;
  }

  size_t digest_len;
  hs->new_session->original_handshake_hash.ResizeForOverwrite(
      hs->transcript.DigestLen());
  if (!hs->transcript.GetHash(hs->new_session->original_handshake_hash.data(),
                              &digest_len)) {
    return false;
  }
  assert(digest_len == hs->new_session->original_handshake_hash.size());
  return true;
}

bool ssl_is_sct_list_valid(const CBS *contents) {
  // Shallow parse the SCT list for sanity. By the RFC
  // (https://tools.ietf.org/html/rfc6962#section-3.3) neither the list nor any
  // of the SCTs may be empty.
  CBS copy = *contents;
  CBS sct_list;
  if (!CBS_get_u16_length_prefixed(&copy, &sct_list) || CBS_len(&copy) != 0 ||
      CBS_len(&sct_list) == 0) {
    return false;
  }

  while (CBS_len(&sct_list) > 0) {
    CBS sct;
    if (!CBS_get_u16_length_prefixed(&sct_list, &sct) || CBS_len(&sct) == 0) {
      return false;
    }
  }

  return true;
}

BSSL_NAMESPACE_END

using namespace bssl;

int SSL_parse_client_hello(const SSL *ssl, SSL_CLIENT_HELLO *out,
                           const uint8_t *in, size_t len) {
  CBS cbs = Span(in, len);
  if (!ssl_parse_client_hello_with_trailing_data(ssl, &cbs, out)) {
    return 0;
  }
  if (CBS_len(&cbs) != 0) {
    OPENSSL_PUT_ERROR(SSL, SSL_R_CLIENTHELLO_PARSE_FAILED);
    return 0;
  }
  return 1;
}

int SSL_early_callback_ctx_extension_get(const SSL_CLIENT_HELLO *client_hello,
                                         uint16_t extension_type,
                                         const uint8_t **out_data,
                                         size_t *out_len) {
  CBS cbs;
  if (!ssl_client_hello_get_extension(client_hello, &cbs, extension_type)) {
    return 0;
  }

  *out_data = CBS_data(&cbs);
  *out_len = CBS_len(&cbs);
  return 1;
}
