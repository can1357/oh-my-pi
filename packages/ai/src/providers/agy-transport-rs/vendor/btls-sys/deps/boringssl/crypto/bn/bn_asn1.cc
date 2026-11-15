// Copyright 2015 The BoringSSL Authors
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

#include <openssl/bn.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>


int BN_parse_asn1_unsigned(CBS *cbs, BIGNUM *ret) {
  CBS child;
  int is_negative;
  if (!CBS_get_asn1(cbs, &child, CBS_ASN1_INTEGER) ||
      !CBS_is_valid_asn1_integer(&child, &is_negative)) {
    OPENSSL_PUT_ERROR(BN, BN_R_BAD_ENCODING);
    return 0;
  }

  if (is_negative) {
    OPENSSL_PUT_ERROR(BN, BN_R_NEGATIVE_NUMBER);
    return 0;
  }

  return BN_bin2bn(CBS_data(&child), CBS_len(&child), ret) != nullptr;
}

int BN_marshal_asn1(CBB *cbb, const BIGNUM *bn) {
  // Negative numbers are unsupported.
  if (BN_is_negative(bn)) {
    OPENSSL_PUT_ERROR(BN, BN_R_NEGATIVE_NUMBER);
    return 0;
  }

  CBB child;
  if (!CBB_add_asn1(cbb, &child, CBS_ASN1_INTEGER) ||
      // The number must be padded with a leading zero if the high bit would
      // otherwise be set or if |bn| is zero.
      (BN_num_bits(bn) % 8 == 0 && !CBB_add_u8(&child, 0x00)) ||
      !BN_bn2cbb_padded(&child, BN_num_bytes(bn), bn) ||
      !CBB_flush(cbb)) {
    OPENSSL_PUT_ERROR(BN, BN_R_ENCODE_ERROR);
    return 0;
  }

  return 1;
}
