// Copyright 1999-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <string.h>

#include <openssl/base64.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/x509.h>

int NETSCAPE_SPKI_set_pubkey(NETSCAPE_SPKI *x, EVP_PKEY *pkey) {
  if ((x == nullptr) || (x->spkac == nullptr)) {
    return 0;
  }
  return (X509_PUBKEY_set(&(x->spkac->pubkey), pkey));
}

EVP_PKEY *NETSCAPE_SPKI_get_pubkey(const NETSCAPE_SPKI *x) {
  if ((x == nullptr) || (x->spkac == nullptr)) {
    return nullptr;
  }
  return (X509_PUBKEY_get(x->spkac->pubkey));
}

// Load a Netscape SPKI from a base64 encoded string

NETSCAPE_SPKI *NETSCAPE_SPKI_b64_decode(const char *str, ossl_ssize_t len) {
  unsigned char *spki_der;
  const unsigned char *p;
  size_t spki_len;
  NETSCAPE_SPKI *spki;
  if (len <= 0) {
    len = strlen(str);
  }
  if (!EVP_DecodedLength(&spki_len, len)) {
    OPENSSL_PUT_ERROR(X509, X509_R_BASE64_DECODE_ERROR);
    return nullptr;
  }
  if (!(spki_der = reinterpret_cast<uint8_t *>(OPENSSL_malloc(spki_len)))) {
    return nullptr;
  }
  if (!EVP_DecodeBase64(spki_der, &spki_len, spki_len, (const uint8_t *)str,
                        len)) {
    OPENSSL_PUT_ERROR(X509, X509_R_BASE64_DECODE_ERROR);
    OPENSSL_free(spki_der);
    return nullptr;
  }
  p = spki_der;
  spki = d2i_NETSCAPE_SPKI(nullptr, &p, spki_len);
  OPENSSL_free(spki_der);
  return spki;
}

// Generate a base64 encoded string from an SPKI

char *NETSCAPE_SPKI_b64_encode(NETSCAPE_SPKI *spki) {
  unsigned char *der_spki, *p;
  char *b64_str;
  size_t b64_len;
  int der_len;
  der_len = i2d_NETSCAPE_SPKI(spki, nullptr);
  if (!EVP_EncodedLength(&b64_len, der_len)) {
    OPENSSL_PUT_ERROR(X509, ERR_R_OVERFLOW);
    return nullptr;
  }
  der_spki = reinterpret_cast<uint8_t *>(OPENSSL_malloc(der_len));
  if (der_spki == nullptr) {
    return nullptr;
  }
  b64_str = reinterpret_cast<char *>(OPENSSL_malloc(b64_len));
  if (b64_str == nullptr) {
    OPENSSL_free(der_spki);
    return nullptr;
  }
  p = der_spki;
  i2d_NETSCAPE_SPKI(spki, &p);
  EVP_EncodeBlock((unsigned char *)b64_str, der_spki, der_len);
  OPENSSL_free(der_spki);
  return b64_str;
}
