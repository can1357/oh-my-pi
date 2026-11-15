// Copyright 2006-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/obj.h>

#include "../internal.h"


typedef struct {
  int sign_nid;
  int digest_nid;
  int pkey_nid;
} nid_triple;

static const nid_triple kTriples[] = {
    // RSA PKCS#1.
    {NID_md4WithRSAEncryption, NID_md4, NID_rsaEncryption},
    {NID_md5WithRSAEncryption, NID_md5, NID_rsaEncryption},
    {NID_sha1WithRSAEncryption, NID_sha1, NID_rsaEncryption},
    {NID_sha224WithRSAEncryption, NID_sha224, NID_rsaEncryption},
    {NID_sha256WithRSAEncryption, NID_sha256, NID_rsaEncryption},
    {NID_sha384WithRSAEncryption, NID_sha384, NID_rsaEncryption},
    {NID_sha512WithRSAEncryption, NID_sha512, NID_rsaEncryption},
    // DSA.
    {NID_dsaWithSHA1, NID_sha1, NID_dsa},
    {NID_dsaWithSHA1_2, NID_sha1, NID_dsa_2},
    {NID_dsa_with_SHA224, NID_sha224, NID_dsa},
    {NID_dsa_with_SHA256, NID_sha256, NID_dsa},
    // ECDSA.
    {NID_ecdsa_with_SHA1, NID_sha1, NID_X9_62_id_ecPublicKey},
    {NID_ecdsa_with_SHA224, NID_sha224, NID_X9_62_id_ecPublicKey},
    {NID_ecdsa_with_SHA256, NID_sha256, NID_X9_62_id_ecPublicKey},
    {NID_ecdsa_with_SHA384, NID_sha384, NID_X9_62_id_ecPublicKey},
    {NID_ecdsa_with_SHA512, NID_sha512, NID_X9_62_id_ecPublicKey},
    // The following algorithms use more complex (or simpler) parameters. The
    // digest "undef" indicates the caller should handle this explicitly.
    {NID_rsassaPss, NID_undef, NID_rsaEncryption},
    {NID_ED25519, NID_undef, NID_ED25519},
};

int OBJ_find_sigid_algs(int sign_nid, int *out_digest_nid, int *out_pkey_nid) {
  for (const auto &triple : kTriples) {
    if (triple.sign_nid == sign_nid) {
      if (out_digest_nid != nullptr) {
        *out_digest_nid = triple.digest_nid;
      }
      if (out_pkey_nid != nullptr) {
        *out_pkey_nid = triple.pkey_nid;
      }
      return 1;
    }
  }

  return 0;
}

int OBJ_find_sigid_by_algs(int *out_sign_nid, int digest_nid, int pkey_nid) {
  for (const auto &triple : kTriples) {
    if (triple.digest_nid == digest_nid &&
        triple.pkey_nid == pkey_nid) {
      if (out_sign_nid != nullptr) {
        *out_sign_nid = triple.sign_nid;
      }
      return 1;
    }
  }

  return 0;
}
