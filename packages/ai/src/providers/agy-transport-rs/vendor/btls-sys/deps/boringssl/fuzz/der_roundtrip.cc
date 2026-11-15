// Copyright 2022 The BoringSSL Authors
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

#include <stdlib.h>
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/ecdsa.h>
#include <openssl/mem.h>


extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  CBS cbs, body;
  CBS_ASN1_TAG tag;
  CBS_init(&cbs, buf, len);
  if (CBS_get_any_asn1(&cbs, &body, &tag)) {
    // DER has a unique encoding, so any parsed input should round-trip
    // correctly.
    size_t consumed = len - CBS_len(&cbs);
    bssl::ScopedCBB cbb;
    if (!CBB_init(cbb.get(), consumed) ||
        !CBB_add_asn1_element(cbb.get(), tag, CBS_data(&body),
                              CBS_len(&body)) ||
        CBB_len(cbb.get()) != consumed ||
        memcmp(CBB_data(cbb.get()), buf, consumed) != 0) {
      abort();
    }
  }

  ECDSA_SIG *sig = ECDSA_SIG_from_bytes(buf, len);
  if (sig != NULL) {
    uint8_t *enc;
    size_t enc_len;
    if (!ECDSA_SIG_to_bytes(&enc, &enc_len, sig) ||
        enc_len != len ||
        memcmp(buf, enc, len) != 0) {
      abort();
    }
    OPENSSL_free(enc);
    ECDSA_SIG_free(sig);
  }

  return 0;
}
