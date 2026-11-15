// Copyright 2014 The BoringSSL Authors
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

#include <openssl/pkcs7.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/pool.h>
#include <openssl/stack.h>

#include "../bytestring/internal.h"
#include "internal.h"


// 1.2.840.113549.1.7.1
static const uint8_t kPKCS7Data[] = {0x2a, 0x86, 0x48, 0x86, 0xf7,
                                     0x0d, 0x01, 0x07, 0x01};

// 1.2.840.113549.1.7.2
static const uint8_t kPKCS7SignedData[] = {0x2a, 0x86, 0x48, 0x86, 0xf7,
                                           0x0d, 0x01, 0x07, 0x02};

// pkcs7_parse_header reads the non-certificate/non-CRL prefix of a PKCS#7
// SignedData blob from |cbs| and sets |*out| to point to the rest of the
// input. If the input is in BER format, then |*der_bytes| will be set to a
// pointer that needs to be freed by the caller once they have finished
// processing |*out| (which will be pointing into |*der_bytes|).
//
// It returns one on success or zero on error. On error, |*der_bytes| is
// NULL.
int pkcs7_parse_header(uint8_t **der_bytes, CBS *out, CBS *cbs) {
  CBS in, content_info, content_type, wrapped_signed_data, signed_data;
  uint64_t version;

  // The input may be in BER format.
  *der_bytes = nullptr;
  if (!CBS_asn1_ber_to_der(cbs, &in, der_bytes) ||
      // See https://tools.ietf.org/html/rfc2315#section-7
      !CBS_get_asn1(&in, &content_info, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&content_info, &content_type, CBS_ASN1_OBJECT)) {
    goto err;
  }

  if (!CBS_mem_equal(&content_type, kPKCS7SignedData,
                     sizeof(kPKCS7SignedData))) {
    OPENSSL_PUT_ERROR(PKCS7, PKCS7_R_NOT_PKCS7_SIGNED_DATA);
    goto err;
  }

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!CBS_get_asn1(&content_info, &wrapped_signed_data,
                    CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0) ||
      !CBS_get_asn1(&wrapped_signed_data, &signed_data, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1_uint64(&signed_data, &version) ||
      !CBS_get_asn1(&signed_data, nullptr /* digests */, CBS_ASN1_SET) ||
      !CBS_get_asn1(&signed_data, nullptr /* content */, CBS_ASN1_SEQUENCE)) {
    goto err;
  }

  if (version < 1) {
    OPENSSL_PUT_ERROR(PKCS7, PKCS7_R_BAD_PKCS7_VERSION);
    goto err;
  }

  CBS_init(out, CBS_data(&signed_data), CBS_len(&signed_data));
  return 1;

err:
  OPENSSL_free(*der_bytes);
  *der_bytes = nullptr;
  return 0;
}

int PKCS7_get_raw_certificates(STACK_OF(CRYPTO_BUFFER) *out_certs, CBS *cbs,
                               CRYPTO_BUFFER_POOL *pool) {
  CBS signed_data, certificates;
  uint8_t *der_bytes = nullptr;
  int ret = 0, has_certificates;
  const size_t initial_certs_len = sk_CRYPTO_BUFFER_num(out_certs);

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!pkcs7_parse_header(&der_bytes, &signed_data, cbs) ||
      !CBS_get_optional_asn1(
          &signed_data, &certificates, &has_certificates,
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0)) {
    goto err;
  }

  if (!has_certificates) {
    CBS_init(&certificates, nullptr, 0);
  }

  while (CBS_len(&certificates) > 0) {
    CBS cert;
    if (!CBS_get_asn1_element(&certificates, &cert, CBS_ASN1_SEQUENCE)) {
      goto err;
    }

    CRYPTO_BUFFER *buf = CRYPTO_BUFFER_new_from_CBS(&cert, pool);
    if (buf == nullptr || !sk_CRYPTO_BUFFER_push(out_certs, buf)) {
      CRYPTO_BUFFER_free(buf);
      goto err;
    }
  }

  ret = 1;

err:
  OPENSSL_free(der_bytes);

  if (!ret) {
    while (sk_CRYPTO_BUFFER_num(out_certs) != initial_certs_len) {
      CRYPTO_BUFFER *buf = sk_CRYPTO_BUFFER_pop(out_certs);
      CRYPTO_BUFFER_free(buf);
    }
  }

  return ret;
}

static int pkcs7_bundle_raw_certificates_cb(CBB *out, void *arg) {
  const STACK_OF(CRYPTO_BUFFER) *certs =
      reinterpret_cast<const STACK_OF(CRYPTO_BUFFER) *>(arg);
  CBB certificates;

  // See https://tools.ietf.org/html/rfc2315#section-9.1
  if (!CBB_add_asn1(out, &certificates,
                    CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0)) {
    return 0;
  }

  for (size_t i = 0; i < sk_CRYPTO_BUFFER_num(certs); i++) {
    CRYPTO_BUFFER *cert = sk_CRYPTO_BUFFER_value(certs, i);
    if (!CBB_add_bytes(&certificates, CRYPTO_BUFFER_data(cert),
                       CRYPTO_BUFFER_len(cert))) {
      return 0;
    }
  }

  // |certificates| is a implicitly-tagged SET OF.
  return CBB_flush_asn1_set_of(&certificates) && CBB_flush(out);
}

int PKCS7_bundle_raw_certificates(CBB *out,
                                  const STACK_OF(CRYPTO_BUFFER) *certs) {
  return pkcs7_add_signed_data(out, /*signed_data_version=*/1,
                               /*digest_algos_cb=*/nullptr,
                               pkcs7_bundle_raw_certificates_cb,
                               /*signer_infos_cb=*/nullptr,
                               const_cast<STACK_OF(CRYPTO_BUFFER) *>(certs));
}

int pkcs7_add_signed_data(CBB *out, uint64_t signed_data_version,
                          int (*digest_algos_cb)(CBB *out, void *arg),
                          int (*cert_crl_cb)(CBB *out, void *arg),
                          int (*signer_infos_cb)(CBB *out, void *arg),
                          void *arg) {
  CBB outer_seq, wrapped_seq, seq, digest_algos_set, content_info, signer_infos;

  // See https://tools.ietf.org/html/rfc2315#section-7
  if (!CBB_add_asn1(out, &outer_seq, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&outer_seq, CBS_ASN1_OBJECT, kPKCS7SignedData,
                            sizeof(kPKCS7SignedData)) ||
      !CBB_add_asn1(&outer_seq, &wrapped_seq,
                    CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0) ||
      // See https://tools.ietf.org/html/rfc2315#section-9.1
      !CBB_add_asn1(&wrapped_seq, &seq, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_uint64(&seq, signed_data_version) ||
      !CBB_add_asn1(&seq, &digest_algos_set, CBS_ASN1_SET) ||
      (digest_algos_cb != nullptr &&
       !digest_algos_cb(&digest_algos_set, arg)) ||
      !CBB_flush_asn1_set_of(&digest_algos_set) ||
      !CBB_add_asn1(&seq, &content_info, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&content_info, CBS_ASN1_OBJECT, kPKCS7Data,
                            sizeof(kPKCS7Data)) ||
      (cert_crl_cb != nullptr && !cert_crl_cb(&seq, arg)) ||
      !CBB_add_asn1(&seq, &signer_infos, CBS_ASN1_SET) ||
      (signer_infos_cb != nullptr && !signer_infos_cb(&signer_infos, arg)) ||
      !CBB_flush_asn1_set_of(&signer_infos)) {
    return 0;
  }

  return CBB_flush(out);
}
