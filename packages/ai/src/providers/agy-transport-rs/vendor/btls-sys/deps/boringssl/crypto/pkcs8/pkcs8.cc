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

#include <openssl/pkcs8.h>

#include <assert.h>
#include <limits.h>
#include <string.h>

#include <openssl/bytestring.h>
#include <openssl/cipher.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/nid.h>
#include <openssl/rand.h>

#include "../bytestring/internal.h"
#include "../internal.h"
#include "internal.h"


static int pkcs12_encode_password(const char *in, size_t in_len, uint8_t **out,
                                  size_t *out_len) {
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), in_len * 2)) {
    return 0;
  }

  // Convert the password to BMPString, or UCS-2. See
  // https://tools.ietf.org/html/rfc7292#appendix-B.1.
  CBS cbs;
  CBS_init(&cbs, (const uint8_t *)in, in_len);
  while (CBS_len(&cbs) != 0) {
    uint32_t c;
    if (!CBS_get_utf8(&cbs, &c) || !CBB_add_ucs2_be(cbb.get(), c)) {
      OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_INVALID_CHARACTERS);
      return 0;
    }
  }

  // Terminate the result with a UCS-2 NUL.
  if (!CBB_add_ucs2_be(cbb.get(), 0) || !CBB_finish(cbb.get(), out, out_len)) {
    return 0;
  }

  return 1;
}

int pkcs12_key_gen(const char *pass, size_t pass_len, const uint8_t *salt,
                   size_t salt_len, uint8_t id, uint32_t iterations,
                   size_t out_len, uint8_t *out, const EVP_MD *md) {
  // See https://tools.ietf.org/html/rfc7292#appendix-B. Quoted parts of the
  // specification have errata applied and other typos fixed.

  if (iterations < 1) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_BAD_ITERATION_COUNT);
    return 0;
  }

  int ret = 0;
  EVP_MD_CTX ctx;
  EVP_MD_CTX_init(&ctx);
  uint8_t *pass_raw = nullptr, *I = nullptr;
  size_t pass_raw_len = 0, I_len = 0;

  {
    // If |pass| is NULL, we use the empty string rather than {0, 0} as the raw
    // password.
    if (pass != nullptr &&
        !pkcs12_encode_password(pass, pass_len, &pass_raw, &pass_raw_len)) {
      goto err;
    }

    // In the spec, |block_size| is called "v", but measured in bits.
    size_t block_size = EVP_MD_block_size(md);

    // 1. Construct a string, D (the "diversifier"), by concatenating v/8 copies
    // of ID.
    uint8_t D[EVP_MAX_MD_BLOCK_SIZE];
    OPENSSL_memset(D, id, block_size);

    // 2. Concatenate copies of the salt together to create a string S of length
    // v(ceiling(s/v)) bits (the final copy of the salt may be truncated to
    // create S). Note that if the salt is the empty string, then so is S.
    //
    // 3. Concatenate copies of the password together to create a string P of
    // length v(ceiling(p/v)) bits (the final copy of the password may be
    // truncated to create P).  Note that if the password is the empty string,
    // then so is P.
    //
    // 4. Set I=S||P to be the concatenation of S and P.
    if (salt_len + block_size - 1 < salt_len ||
        pass_raw_len + block_size - 1 < pass_raw_len) {
      OPENSSL_PUT_ERROR(PKCS8, ERR_R_OVERFLOW);
      goto err;
    }
    size_t S_len = block_size * ((salt_len + block_size - 1) / block_size);
    size_t P_len = block_size * ((pass_raw_len + block_size - 1) / block_size);
    I_len = S_len + P_len;
    if (I_len < S_len) {
      OPENSSL_PUT_ERROR(PKCS8, ERR_R_OVERFLOW);
      goto err;
    }

    I = reinterpret_cast<uint8_t *>(OPENSSL_malloc(I_len));
    if (I_len != 0 && I == nullptr) {
      goto err;
    }

    for (size_t i = 0; i < S_len; i++) {
      I[i] = salt[i % salt_len];
    }
    for (size_t i = 0; i < P_len; i++) {
      I[i + S_len] = pass_raw[i % pass_raw_len];
    }

    while (out_len != 0) {
      // A. Set A_i=H^r(D||I). (i.e., the r-th hash of D||I,
      // H(H(H(... H(D||I))))
      uint8_t A[EVP_MAX_MD_SIZE];
      unsigned A_len;
      if (!EVP_DigestInit_ex(&ctx, md, nullptr) ||
          !EVP_DigestUpdate(&ctx, D, block_size) ||
          !EVP_DigestUpdate(&ctx, I, I_len) ||
          !EVP_DigestFinal_ex(&ctx, A, &A_len)) {
        goto err;
      }
      for (uint32_t iter = 1; iter < iterations; iter++) {
        if (!EVP_DigestInit_ex(&ctx, md, nullptr) ||
            !EVP_DigestUpdate(&ctx, A, A_len) ||
            !EVP_DigestFinal_ex(&ctx, A, &A_len)) {
          goto err;
        }
      }

      size_t todo = out_len < A_len ? out_len : A_len;
      OPENSSL_memcpy(out, A, todo);
      out += todo;
      out_len -= todo;
      if (out_len == 0) {
        break;
      }

      // B. Concatenate copies of A_i to create a string B of length v bits (the
      // final copy of A_i may be truncated to create B).
      uint8_t B[EVP_MAX_MD_BLOCK_SIZE];
      for (size_t i = 0; i < block_size; i++) {
        B[i] = A[i % A_len];
      }

      // C. Treating I as a concatenation I_0, I_1, ..., I_(k-1) of v-bit
      // blocks, where k=ceiling(s/v)+ceiling(p/v), modify I by setting
      // I_j=(I_j+B+1) mod 2^v for each j.
      assert(I_len % block_size == 0);
      for (size_t i = 0; i < I_len; i += block_size) {
        unsigned carry = 1;
        for (size_t j = block_size - 1; j < block_size; j--) {
          carry += I[i + j] + B[j];
          I[i + j] = (uint8_t)carry;
          carry >>= 8;
        }
      }
    }

    ret = 1;
  }

err:
  OPENSSL_free(I);
  OPENSSL_free(pass_raw);
  EVP_MD_CTX_cleanup(&ctx);
  return ret;
}

static int pkcs12_pbe_cipher_init(const struct pbe_suite *suite,
                                  EVP_CIPHER_CTX *ctx, uint32_t iterations,
                                  const char *pass, size_t pass_len,
                                  const uint8_t *salt, size_t salt_len,
                                  int is_encrypt) {
  const EVP_CIPHER *cipher = suite->cipher_func();
  const EVP_MD *md = suite->md_func();

  uint8_t key[EVP_MAX_KEY_LENGTH];
  uint8_t iv[EVP_MAX_IV_LENGTH];
  if (!pkcs12_key_gen(pass, pass_len, salt, salt_len, PKCS12_KEY_ID, iterations,
                      EVP_CIPHER_key_length(cipher), key, md) ||
      !pkcs12_key_gen(pass, pass_len, salt, salt_len, PKCS12_IV_ID, iterations,
                      EVP_CIPHER_iv_length(cipher), iv, md)) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_KEY_GEN_ERROR);
    return 0;
  }

  int ret = EVP_CipherInit_ex(ctx, cipher, nullptr, key, iv, is_encrypt);
  OPENSSL_cleanse(key, EVP_MAX_KEY_LENGTH);
  OPENSSL_cleanse(iv, EVP_MAX_IV_LENGTH);
  return ret;
}

static int pkcs12_pbe_decrypt_init(const struct pbe_suite *suite,
                                   EVP_CIPHER_CTX *ctx, const char *pass,
                                   size_t pass_len, CBS *param) {
  CBS pbe_param, salt;
  uint64_t iterations;
  if (!CBS_get_asn1(param, &pbe_param, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&pbe_param, &salt, CBS_ASN1_OCTETSTRING) ||
      !CBS_get_asn1_uint64(&pbe_param, &iterations) ||
      CBS_len(&pbe_param) != 0 || CBS_len(param) != 0) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_DECODE_ERROR);
    return 0;
  }

  if (!pkcs12_iterations_acceptable(iterations)) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_BAD_ITERATION_COUNT);
    return 0;
  }

  return pkcs12_pbe_cipher_init(suite, ctx, (uint32_t)iterations, pass,
                                pass_len, CBS_data(&salt), CBS_len(&salt),
                                0 /* decrypt */);
}

static const struct pbe_suite kBuiltinPBE[] = {
    {
        NID_pbe_WithSHA1And40BitRC2_CBC,
        // 1.2.840.113549.1.12.1.6
        {0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01, 0x06},
        10,
        EVP_rc2_40_cbc,
        EVP_sha1,
        pkcs12_pbe_decrypt_init,
    },
    {
        NID_pbe_WithSHA1And128BitRC4,
        // 1.2.840.113549.1.12.1.1
        {0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01, 0x01},
        10,
        EVP_rc4,
        EVP_sha1,
        pkcs12_pbe_decrypt_init,
    },
    {
        NID_pbe_WithSHA1And3_Key_TripleDES_CBC,
        // 1.2.840.113549.1.12.1.3
        {0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x01, 0x03},
        10,
        EVP_des_ede3_cbc,
        EVP_sha1,
        pkcs12_pbe_decrypt_init,
    },
    {
        NID_pbes2,
        // 1.2.840.113549.1.5.13
        {0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d},
        9,
        nullptr,
        nullptr,
        PKCS5_pbe2_decrypt_init,
    },
};

static const struct pbe_suite *get_pkcs12_pbe_suite(int pbe_nid) {
  for (const auto &pbe : kBuiltinPBE) {
    if (pbe.pbe_nid == pbe_nid &&
        // If |cipher_func| or |md_func| are missing, this is a PBES2 scheme.
        pbe.cipher_func != nullptr && pbe.md_func != nullptr) {
      return &pbe;
    }
  }

  return nullptr;
}

int pkcs12_pbe_encrypt_init(CBB *out, EVP_CIPHER_CTX *ctx, int alg_nid,
                            const EVP_CIPHER *alg_cipher, uint32_t iterations,
                            const char *pass, size_t pass_len,
                            const uint8_t *salt, size_t salt_len) {
  // TODO(davidben): OpenSSL has since extended |pbe_nid| to control either
  // the PBES1 scheme or the PBES2 PRF. E.g. passing |NID_hmacWithSHA256| will
  // select PBES2 with HMAC-SHA256 as the PRF. Implement this if anything uses
  // it. See 5693a30813a031d3921a016a870420e7eb93ec90 in OpenSSL.
  if (alg_nid == -1) {
    return PKCS5_pbe2_encrypt_init(out, ctx, alg_cipher, iterations, pass,
                                   pass_len, salt, salt_len);
  }

  const struct pbe_suite *suite = get_pkcs12_pbe_suite(alg_nid);
  if (suite == nullptr) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_UNKNOWN_ALGORITHM);
    return 0;
  }

  // See RFC 7292, appendix C. All our supported "PBES1" schemes are the PKCS#12
  // schemes, which use a different KDF. The true PBES1 schemes in RFC 8018 use
  // PBKDF1, which use a very similar PBEParameter structure, but require the
  // salt be exactly 8 bytes.
  CBB algorithm, param;
  if (!CBB_add_asn1(out, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, suite->oid,
                            suite->oid_len) ||
      !CBB_add_asn1(&algorithm, &param, CBS_ASN1_SEQUENCE) ||
      !CBB_add_asn1_octet_string(&param, salt, salt_len) ||
      !CBB_add_asn1_uint64(&param, iterations) || !CBB_flush(out)) {
    return 0;
  }

  return pkcs12_pbe_cipher_init(suite, ctx, iterations, pass, pass_len, salt,
                                salt_len, 1 /* encrypt */);
}

int pkcs8_pbe_decrypt(uint8_t **out, size_t *out_len, CBS *algorithm,
                      const char *pass, size_t pass_len, const uint8_t *in,
                      size_t in_len) {
  int ret = 0;
  uint8_t *buf = nullptr;
  bssl::ScopedEVP_CIPHER_CTX ctx;

  CBS obj;
  const struct pbe_suite *suite = nullptr;
  if (!CBS_get_asn1(algorithm, &obj, CBS_ASN1_OBJECT)) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_DECODE_ERROR);
    goto err;
  }

  for (const auto &pbe : kBuiltinPBE) {
    if (CBS_mem_equal(&obj, pbe.oid, pbe.oid_len)) {
      suite = &pbe;
      break;
    }
  }
  if (suite == nullptr) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_UNKNOWN_ALGORITHM);
    goto err;
  }

  if (!suite->decrypt_init(suite, ctx.get(), pass, pass_len, algorithm)) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_KEYGEN_FAILURE);
    goto err;
  }

  buf = reinterpret_cast<uint8_t *>(OPENSSL_malloc(in_len));
  if (buf == nullptr) {
    goto err;
  }

  if (in_len > INT_MAX) {
    OPENSSL_PUT_ERROR(PKCS8, ERR_R_OVERFLOW);
    goto err;
  }

  int n1, n2;
  if (!EVP_DecryptUpdate(ctx.get(), buf, &n1, in, (int)in_len) ||
      !EVP_DecryptFinal_ex(ctx.get(), buf + n1, &n2)) {
    goto err;
  }

  *out = buf;
  *out_len = n1 + n2;
  ret = 1;
  buf = nullptr;

err:
  OPENSSL_free(buf);
  return ret;
}

EVP_PKEY *PKCS8_parse_encrypted_private_key(CBS *cbs, const char *pass,
                                            size_t pass_len) {
  // See RFC 5208, section 6.
  CBS epki, algorithm, ciphertext;
  if (!CBS_get_asn1(cbs, &epki, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&epki, &algorithm, CBS_ASN1_SEQUENCE) ||
      !CBS_get_asn1(&epki, &ciphertext, CBS_ASN1_OCTETSTRING) ||
      CBS_len(&epki) != 0) {
    OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_DECODE_ERROR);
    return nullptr;
  }

  uint8_t *out;
  size_t out_len;
  if (!pkcs8_pbe_decrypt(&out, &out_len, &algorithm, pass, pass_len,
                         CBS_data(&ciphertext), CBS_len(&ciphertext))) {
    return nullptr;
  }

  CBS pki;
  CBS_init(&pki, out, out_len);
  EVP_PKEY *ret = EVP_parse_private_key(&pki);
  OPENSSL_free(out);
  return ret;
}

int PKCS8_marshal_encrypted_private_key(CBB *out, int pbe_nid,
                                        const EVP_CIPHER *cipher,
                                        const char *pass, size_t pass_len,
                                        const uint8_t *salt, size_t salt_len,
                                        int iterations, const EVP_PKEY *pkey) {
  int ret = 0;
  uint8_t *plaintext = nullptr, *salt_buf = nullptr;
  size_t plaintext_len = 0;
  bssl::ScopedEVP_CIPHER_CTX ctx;

  {
    // Generate a random salt if necessary.
    if (salt == nullptr) {
      if (salt_len == 0) {
        salt_len = PKCS5_SALT_LEN;
      }

      salt_buf = reinterpret_cast<uint8_t *>(OPENSSL_malloc(salt_len));
      if (salt_buf == nullptr || !RAND_bytes(salt_buf, salt_len)) {
        goto err;
      }

      salt = salt_buf;
    }

    if (iterations <= 0) {
      iterations = PKCS12_DEFAULT_ITER;
    }

    // Serialize the input key.
    CBB plaintext_cbb;
    if (!CBB_init(&plaintext_cbb, 128) ||
        !EVP_marshal_private_key(&plaintext_cbb, pkey) ||
        !CBB_finish(&plaintext_cbb, &plaintext, &plaintext_len)) {
      CBB_cleanup(&plaintext_cbb);
      goto err;
    }

    CBB epki;
    if (!CBB_add_asn1(out, &epki, CBS_ASN1_SEQUENCE) ||
        !pkcs12_pbe_encrypt_init(&epki, ctx.get(), pbe_nid, cipher,
                                 (uint32_t)iterations, pass, pass_len, salt,
                                 salt_len)) {
      goto err;
    }

    size_t max_out = plaintext_len + EVP_CIPHER_CTX_block_size(ctx.get());
    if (max_out < plaintext_len) {
      OPENSSL_PUT_ERROR(PKCS8, PKCS8_R_TOO_LONG);
      goto err;
    }

    CBB ciphertext;
    uint8_t *ptr;
    int n1, n2;
    if (!CBB_add_asn1(&epki, &ciphertext, CBS_ASN1_OCTETSTRING) ||
        !CBB_reserve(&ciphertext, &ptr, max_out) ||
        !EVP_CipherUpdate(ctx.get(), ptr, &n1, plaintext, plaintext_len) ||
        !EVP_CipherFinal_ex(ctx.get(), ptr + n1, &n2) ||
        !CBB_did_write(&ciphertext, n1 + n2) || !CBB_flush(out)) {
      goto err;
    }

    ret = 1;
  }

err:
  OPENSSL_free(plaintext);
  OPENSSL_free(salt_buf);
  return ret;
}
