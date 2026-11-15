// Copyright 2017 The BoringSSL Authors
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

/* test_fips exercises various cryptographic primitives for demonstration
 * purposes in the validation process only. */

#include <stdio.h>

#include <openssl/aead.h>
#include <openssl/aes.h>
#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/ctrdrbg.h>
#include <openssl/dh.h>
#include <openssl/ec_key.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/hkdf.h>
#include <openssl/hmac.h>
#include <openssl/nid.h>
#include <openssl/rsa.h>
#include <openssl/sha.h>

#include "../../crypto/fipsmodule/bcm_interface.h"
#include "../../crypto/fipsmodule/rand/internal.h"
#include "../../crypto/fipsmodule/tls/internal.h"
#include "../../crypto/internal.h"

OPENSSL_MSVC_PRAGMA(warning(disable : 4295))

#if defined(BORINGSSL_FIPS)
static void hexdump(const void *a, size_t len) {
  const unsigned char *in = (const unsigned char *)a;
  for (size_t i = 0; i < len; i++) {
    printf("%02x", in[i]);
  }

  printf("\n");
}
#endif

static int run_test() {
  // Ensure that the output is line-buffered rather than fully buffered. When
  // some of the tests fail, some of the output can otherwise be lost.
  setvbuf(stdout, NULL, _IOLBF, 0);
  setvbuf(stderr, NULL, _IOLBF, 0);

  if (!FIPS_mode()) {
    printf("Module not in FIPS mode\n");
    return 0;
  }
  printf("Module is in FIPS mode\n");

  const uint32_t module_version = FIPS_version();
  if (module_version == 0) {
    printf("No module version set\n");
    return 0;
  }
  printf("Module: '%s', version: %" PRIu32 " hash:\n", FIPS_module_name(),
         module_version);

#if !defined(BORINGSSL_FIPS)
  // |module_version| will be zero, so the non-FIPS build will never get
  // this far.
  printf("Non zero module version in non-FIPS build - should not happen!\n");
  return 0;
#else
#if defined(OPENSSL_ASAN)
  printf("(not available when compiled for ASAN)");
#else
  hexdump(FIPS_module_hash(), SHA256_DIGEST_LENGTH);
#endif

  static const uint8_t kAESKey[16] = "BoringCrypto Ky";
  static const uint8_t kPlaintext[64] =
      "BoringCryptoModule FIPS KAT Encryption and Decryption Plaintext";
  static const uint8_t kPlaintextSHA256[32] = {
      0x37, 0xbd, 0x70, 0x53, 0x72, 0xfc, 0xd4, 0x03, 0x79, 0x70, 0xfb,
      0x06, 0x95, 0xb1, 0x2a, 0x82, 0x48, 0xe1, 0x3e, 0xf2, 0x33, 0xfb,
      0xef, 0x29, 0x81, 0x22, 0x45, 0x40, 0x43, 0x70, 0xce, 0x0f};
  const uint8_t kDRBGEntropy[48] =
      "DBRG Initial Entropy                           ";
  const uint8_t kDRBGNonce[CTR_DRBG_NONCE_LEN] = "DBRG Nonce     ";
  const uint8_t kDRBGPersonalization[19] = "BCMPersonalization";
  const uint8_t kDRBGAD[16] = "BCM DRBG AD    ";
  const uint8_t kDRBGEntropy2[48] =
      "DBRG Reseed Entropy                            ";

  AES_KEY aes_key;

  if (AES_set_encrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) != 0) {
    printf("AES_set_encrypt_key failed\n");
    return 0;
  }

  /* AES-KW */
  hexdump(kPlaintext, sizeof(kPlaintext));

  printf("About to do AES-KW");
  uint8_t output[256];
  const int kw_len = AES_wrap_key(&aes_key, nullptr, output, kPlaintext, 16);
  if (kw_len == -1) {
    printf("AES_wrap_key failed\n");
    return 0;
  }
  printf("  got ");
  hexdump(output, kw_len);

  /* AES-KWP */
  printf("About to do AES-KWP");
  size_t out_len;
  if (!AES_wrap_key_padded(&aes_key, output, &out_len, sizeof(output),
                           kPlaintext, 16)) {
    printf("AES_wrap_key_padded failed\n");
    return 0;
  }
  printf(" got ");
  hexdump(output, out_len);

  /* AES-CBC Encryption */
  uint8_t aes_iv[16];
  memset(aes_iv, 0, sizeof(aes_iv));
  printf("About to AES-CBC encrypt ");
  AES_cbc_encrypt(kPlaintext, output, sizeof(kPlaintext), &aes_key, aes_iv,
                  AES_ENCRYPT);
  printf("  got ");
  hexdump(output, sizeof(kPlaintext));

  /* AES-CBC Decryption */
  memset(aes_iv, 0, sizeof(aes_iv));
  if (AES_set_decrypt_key(kAESKey, 8 * sizeof(kAESKey), &aes_key) != 0) {
    printf("AES decrypt failed\n");
    return 0;
  }
  printf("About to AES-CBC decrypt ");
  hexdump(output, sizeof(kPlaintext));
  AES_cbc_encrypt(output, output, sizeof(kPlaintext), &aes_key, aes_iv,
                  AES_DECRYPT);
  printf("  got ");
  hexdump(output, sizeof(kPlaintext));

  uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH];
  OPENSSL_memset(nonce, 0, sizeof(nonce));

  /* AES-CCM */
  {
    bssl::ScopedEVP_AEAD_CTX aead_ctx;
    if (!EVP_AEAD_CTX_init(aead_ctx.get(), EVP_aead_aes_128_ccm_bluetooth(),
                           kAESKey, sizeof(kAESKey), 0, NULL)) {
      printf("EVP_AEAD_CTX_init failed\n");
      return 0;
    }
    printf("About to AES-CCM seal ");
    hexdump(kPlaintext, sizeof(kPlaintext));
    if (!EVP_AEAD_CTX_seal(
            aead_ctx.get(), output, &out_len, sizeof(output), nonce,
            EVP_AEAD_nonce_length(EVP_aead_aes_128_ccm_bluetooth()), kPlaintext,
            sizeof(kPlaintext), NULL, 0)) {
      printf("AES-CCM encrypt failed\n");
      return 0;
    }
    printf("  got ");
    hexdump(output, out_len);

    /* AES-CCM Decryption */
    printf("About to AES-CCM open ");
    hexdump(output, out_len);
    if (!EVP_AEAD_CTX_open(
            aead_ctx.get(), output, &out_len, sizeof(output), nonce,
            EVP_AEAD_nonce_length(EVP_aead_aes_128_ccm_bluetooth()), output,
            out_len, NULL, 0)) {
      printf("AES-GCM decrypt failed\n");
      return 0;
    }
    printf("  got ");
    hexdump(output, out_len);
  }

  /* AES-GCM Encryption */
  {
    bssl::ScopedEVP_AEAD_CTX aead_ctx;
    if (!EVP_AEAD_CTX_init(aead_ctx.get(), EVP_aead_aes_128_gcm(), kAESKey,
                           sizeof(kAESKey), 0, NULL)) {
      printf("EVP_AEAD_CTX_init failed\n");
      return 0;
    }
    printf("About to AES-GCM seal ");
    hexdump(kPlaintext, sizeof(kPlaintext));
    if (!EVP_AEAD_CTX_seal(aead_ctx.get(), output, &out_len, sizeof(output),
                           nonce, EVP_AEAD_nonce_length(EVP_aead_aes_128_gcm()),
                           kPlaintext, sizeof(kPlaintext), NULL, 0)) {
      printf("AES-GCM encrypt failed\n");
      return 0;
    }
    printf("  got ");
    hexdump(output, out_len);

    /* AES-GCM Decryption */
    printf("About to AES-GCM open ");
    hexdump(output, out_len);
    if (!EVP_AEAD_CTX_open(aead_ctx.get(), output, &out_len, sizeof(output),
                           nonce, EVP_AEAD_nonce_length(EVP_aead_aes_128_gcm()),
                           output, out_len, NULL, 0)) {
      printf("AES-GCM decrypt failed\n");
      return 0;
    }
    printf("  got ");
    hexdump(output, out_len);
  }

  /* SHA-1 */
  printf("About to SHA-1 hash ");
  hexdump(kPlaintext, sizeof(kPlaintext));
  SHA1(kPlaintext, sizeof(kPlaintext), output);
  printf("  got ");
  hexdump(output, SHA_DIGEST_LENGTH);

  /* SHA-256 */
  printf("About to SHA-256 hash ");
  hexdump(kPlaintext, sizeof(kPlaintext));
  SHA256(kPlaintext, sizeof(kPlaintext), output);
  printf("  got ");
  hexdump(output, SHA256_DIGEST_LENGTH);

  /* SHA-512 */
  printf("About to SHA-512 hash ");
  hexdump(kPlaintext, sizeof(kPlaintext));
  SHA512(kPlaintext, sizeof(kPlaintext), output);
  printf("  got ");
  hexdump(output, SHA512_DIGEST_LENGTH);

  RSA *rsa_key = RSA_new();
  printf("About to generate RSA key\n");
  if (!RSA_generate_key_fips(rsa_key, 2048, NULL)) {
    printf("RSA_generate_key_fips failed\n");
    return 0;
  }

  /* RSA Sign */
  unsigned sig_len;
  printf("About to RSA sign ");
  hexdump(kPlaintextSHA256, sizeof(kPlaintextSHA256));
  if (!RSA_sign(NID_sha256, kPlaintextSHA256, sizeof(kPlaintextSHA256), output,
                &sig_len, rsa_key)) {
    printf("RSA Sign failed\n");
    return 0;
  }
  printf("  got ");
  hexdump(output, sig_len);

  /* RSA Verify */
  printf("About to RSA verify ");
  hexdump(output, sig_len);
  if (!RSA_verify(NID_sha256, kPlaintextSHA256, sizeof(kPlaintextSHA256),
                  output, sig_len, rsa_key)) {
    printf("RSA Verify failed.\n");
    return 0;
  }

  RSA_free(rsa_key);

  /* Generating a key with a null output parameter. */
  printf("About to generate RSA key with null output\n");
  if (!RSA_generate_key_fips(NULL, 2048, NULL)) {
    printf("RSA_generate_key_fips failed with null output parameter\n");
    ERR_clear_error();
  } else {
    printf(
        "RSA_generate_key_fips unexpectedly succeeded with null output "
        "parameter\n");
    return 0;
  }

  EC_KEY *ec_key = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
  if (ec_key == NULL) {
    printf("invalid ECDSA key\n");
    return 0;
  }

  printf("About to generate P-256 key\n");
  if (!EC_KEY_generate_key_fips(ec_key)) {
    printf("EC_KEY_generate_key_fips failed\n");
    return 0;
  }

  /* Primitive Z Computation */
  const EC_GROUP *const ec_group = EC_KEY_get0_group(ec_key);
  EC_POINT *z_point = EC_POINT_new(ec_group);
  uint8_t z_result[65];
  printf("About to compute key-agreement Z with P-256:\n");
  if (!EC_POINT_mul(ec_group, z_point, NULL, EC_KEY_get0_public_key(ec_key),
                    EC_KEY_get0_private_key(ec_key), NULL) ||
      EC_POINT_point2oct(ec_group, z_point, POINT_CONVERSION_UNCOMPRESSED,
                         z_result, sizeof(z_result),
                         NULL) != sizeof(z_result)) {
    fprintf(stderr, "EC_POINT_mul failed.\n");
    return 0;
  }
  EC_POINT_free(z_point);

  printf("  got ");
  hexdump(z_result, sizeof(z_result));

  /* ECDSA Sign/Verify PWCT */
  printf("About to ECDSA sign ");
  hexdump(kPlaintextSHA256, sizeof(kPlaintextSHA256));
  ECDSA_SIG *sig =
      ECDSA_do_sign(kPlaintextSHA256, sizeof(kPlaintextSHA256), ec_key);
  if (sig == NULL || !ECDSA_do_verify(kPlaintextSHA256,
                                      sizeof(kPlaintextSHA256), sig, ec_key)) {
    printf("ECDSA Sign/Verify PWCT failed.\n");
    return 0;
  }

  ECDSA_SIG_free(sig);
  EC_KEY_free(ec_key);

  /* Generating a key with a null output pointer. */
  printf("About to generate P-256 key with NULL output\n");
  if (!EC_KEY_generate_key_fips(NULL)) {
    printf("EC_KEY_generate_key_fips failed with a NULL output pointer.\n");
    ERR_clear_error();
  } else {
    printf(
        "EC_KEY_generate_key_fips unexpectedly succeeded with a NULL output "
        "pointer.\n");
    return 0;
  }

  /* ECDSA with an invalid public key. */
  ec_key = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
  static const uint8_t kNotValidX926[] = {1, 2, 3, 4, 5, 6};
  if (!EC_KEY_oct2key(ec_key, kNotValidX926, sizeof(kNotValidX926),
                      /*ctx=*/NULL)) {
    printf("Error while parsing invalid ECDSA public key\n");
  } else {
    printf("Unexpected success while parsing invalid ECDSA public key\n");
    return 0;
  }
  EC_KEY_free(ec_key);

  /* DBRG */
  CTR_DRBG_STATE drbg;
  printf("About to seed CTR-DRBG with ");
  hexdump(kDRBGEntropy, sizeof(kDRBGEntropy));
  if (!CTR_DRBG_init(&drbg, /*df=*/true, kDRBGEntropy, sizeof(kDRBGEntropy),
                     kDRBGNonce, kDRBGPersonalization,
                     sizeof(kDRBGPersonalization)) ||
      !CTR_DRBG_generate(&drbg, output, sizeof(output), kDRBGAD,
                         sizeof(kDRBGAD)) ||
      !CTR_DRBG_reseed_ex(&drbg, kDRBGEntropy2, sizeof(kDRBGEntropy2), kDRBGAD,
                          sizeof(kDRBGAD)) ||
      !CTR_DRBG_generate(&drbg, output, sizeof(output), kDRBGAD,
                         sizeof(kDRBGAD))) {
    printf("DRBG failed\n");
    return 0;
  }
  printf("  generated ");
  hexdump(output, sizeof(output));
  CTR_DRBG_clear(&drbg);

  /* HKDF */
  printf("About to run HKDF\n");
  uint8_t hkdf_output[32];
  if (!HKDF(hkdf_output, sizeof(hkdf_output), EVP_sha256(), kAESKey,
            sizeof(kAESKey), (const uint8_t *)"salt", 4, kPlaintextSHA256,
            sizeof(kPlaintextSHA256))) {
    fprintf(stderr, "HKDF failed.\n");
    return 0;
  }
  printf("  got ");
  hexdump(hkdf_output, sizeof(hkdf_output));

  /* TLS v1.0 KDF */
  printf("About to run TLS v1.0 KDF\n");
  uint8_t tls10_output[32];
  if (!CRYPTO_tls1_prf(EVP_md5_sha1(), tls10_output, sizeof(tls10_output),
                       kAESKey, sizeof(kAESKey), "foo", 3, kPlaintextSHA256,
                       sizeof(kPlaintextSHA256), kPlaintextSHA256,
                       sizeof(kPlaintextSHA256))) {
    fprintf(stderr, "TLS v1.0 KDF failed.\n");
    return 0;
  }
  printf("  got ");
  hexdump(tls10_output, sizeof(tls10_output));

  /* TLS v1.2 KDF */
  printf("About to run TLS v1.2 KDF\n");
  uint8_t tls12_output[32];
  if (!CRYPTO_tls1_prf(EVP_sha256(), tls12_output, sizeof(tls12_output),
                       kAESKey, sizeof(kAESKey), "foo", 3, kPlaintextSHA256,
                       sizeof(kPlaintextSHA256), kPlaintextSHA256,
                       sizeof(kPlaintextSHA256))) {
    fprintf(stderr, "TLS v1.2 KDF failed.\n");
    return 0;
  }
  printf("  got ");
  hexdump(tls12_output, sizeof(tls12_output));

  /* TLS v1.3 KDF */
  printf("About to run TLS v1.3 KDF\n");
  uint8_t tls13_output[32];
  if (!CRYPTO_tls13_hkdf_expand_label(
          tls13_output, sizeof(tls13_output), EVP_sha256(), kAESKey,
          sizeof(kAESKey), (const uint8_t *)"foo", 3, kPlaintextSHA256,
          sizeof(kPlaintextSHA256))) {
    fprintf(stderr, "TLS v1.3 KDF failed.\n");
    return 0;
  }
  printf("  got ");
  hexdump(tls13_output, sizeof(tls13_output));

  /* FFDH */
  printf("About to compute FFDH key-agreement:\n");
  DH *dh = DH_get_rfc7919_2048();
  uint8_t dh_result[2048 / 8];
  if (!dh || !DH_generate_key(dh) || sizeof(dh_result) != DH_size(dh) ||
      DH_compute_key_padded(dh_result, DH_get0_pub_key(dh), dh) !=
          sizeof(dh_result)) {
    fprintf(stderr, "FFDH failed.\n");
    return 0;
  }
  DH_free(dh);

  printf("  got ");
  hexdump(dh_result, sizeof(dh_result));

  /* ML-KEM */
  printf("About to generate ML-KEM key:\n");
  auto mlkem_public_key_bytes =
      std::make_unique<uint8_t[]>(MLKEM768_PUBLIC_KEY_BYTES);
  auto mlkem_private_key = std::make_unique<MLKEM768_private_key>();
  if (BCM_mlkem768_generate_key_fips(mlkem_public_key_bytes.get(), nullptr,
                                     mlkem_private_key.get()) !=
      bcm_status::approved) {
    fprintf(stderr, "ML-KEM generation failed");
    return 0;
  }
  printf("  got ");
  hexdump(mlkem_public_key_bytes.get(), MLKEM768_PUBLIC_KEY_BYTES);

  printf("About to do ML-KEM encap:\n");
  auto mlkem_ciphertext =
      std::make_unique<uint8_t[]>(MLKEM768_CIPHERTEXT_BYTES);
  uint8_t mlkem_shared_secret[MLKEM_SHARED_SECRET_BYTES];
  auto mlkem_public_key = std::make_unique<MLKEM768_public_key>();
  BCM_mlkem768_public_from_private(mlkem_public_key.get(),
                                   mlkem_private_key.get());
  if (BCM_mlkem768_encap(mlkem_ciphertext.get(), mlkem_shared_secret,
                         mlkem_public_key.get()) != bcm_infallible::approved) {
    fprintf(stderr, "ML-KEM encap failed");
    return 0;
  }
  printf("  got ");
  hexdump(mlkem_shared_secret, sizeof(mlkem_shared_secret));

  printf("About to do ML-KEM decap:\n");
  if (BCM_mlkem768_decap(mlkem_shared_secret, mlkem_ciphertext.get(),
                         MLKEM768_CIPHERTEXT_BYTES,
                         mlkem_private_key.get()) != bcm_status::approved) {
    fprintf(stderr, "ML-KEM decap failed");
    return 0;
  }
  printf("  got ");
  hexdump(mlkem_shared_secret, sizeof(mlkem_shared_secret));

  /* ML-DSA */
  printf("About to generate ML-DSA key:\n");
  auto mldsa_public_key_bytes =
      std::make_unique<uint8_t[]>(MLDSA65_PUBLIC_KEY_BYTES);
  uint8_t mldsa_seed[MLDSA_SEED_BYTES];
  auto mldsa_priv = std::make_unique<MLDSA65_private_key>();
  if (BCM_mldsa65_generate_key_fips(mldsa_public_key_bytes.get(), mldsa_seed,
                                    mldsa_priv.get()) != bcm_status::approved) {
    fprintf(stderr, "ML-DSA keygen failed");
    return 0;
  }
  printf("  got ");
  hexdump(mldsa_public_key_bytes.get(), MLDSA65_PUBLIC_KEY_BYTES);

  printf("About to ML-DSA sign:\n");
  auto mldsa_sig = std::make_unique<uint8_t[]>(MLDSA65_SIGNATURE_BYTES);
  if (BCM_mldsa65_sign(mldsa_sig.get(), mldsa_priv.get(), nullptr, 0, nullptr,
                       0) != bcm_status::approved) {
    fprintf(stderr, "ML-DSA sign failed");
    return 0;
  }
  printf("  got ");
  hexdump(mldsa_sig.get(), MLDSA65_SIGNATURE_BYTES);

  printf("About to ML-DSA verify:\n");
  auto mldsa_pub = std::make_unique<MLDSA65_public_key>();
  if (BCM_mldsa65_public_from_private(mldsa_pub.get(), mldsa_priv.get()) !=
          bcm_status::approved ||
      BCM_mldsa65_verify(mldsa_pub.get(), mldsa_sig.get(), nullptr, 0, nullptr,
                         0) != bcm_status::approved) {
    fprintf(stderr, "ML-DSA verify failed");
    return 0;
  }

  /* SLH-DSA */
  printf("About to generate SLH-DSA key:\n");
  uint8_t slhdsa_seed[3 * BCM_SLHDSA_SHA2_128S_N] = {0};
  uint8_t slhdsa_pub[BCM_SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t slhdsa_priv[BCM_SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  BCM_slhdsa_sha2_128s_generate_key_from_seed(slhdsa_pub, slhdsa_priv,
                                              slhdsa_seed);
  printf("  got ");
  hexdump(slhdsa_pub, sizeof(slhdsa_pub));

  printf("About to SLH-DSA sign:\n");
  auto slhdsa_sig =
      std::make_unique<uint8_t[]>(BCM_SLHDSA_SHA2_128S_SIGNATURE_BYTES);
  if (BCM_slhdsa_sha2_128s_sign(slhdsa_sig.get(), slhdsa_priv, nullptr, 0,
                                nullptr, 0) != bcm_status::approved) {
    fprintf(stderr, "SLH-DSA sign failed");
    return 0;
  }
  printf("  got ");
  hexdump(slhdsa_sig.get(), 128);  // value too long to fully print

  printf("About to SLH-DSA verify:\n");
  if (BCM_slhdsa_sha2_128s_verify(
          slhdsa_sig.get(), BCM_SLHDSA_SHA2_128S_SIGNATURE_BYTES, slhdsa_pub,
          nullptr, 0, nullptr, 0) != bcm_status::approved) {
    fprintf(stderr, "SLH-DSA verify failed");
    return 0;
  }

  printf("PASS\n");
  return 1;
#endif  // !defined(BORINGSSL_FIPS)
}

int main(int argc, char **argv) {
  if (!run_test()) {
    printf("FAIL\n");
    fflush(stdout);
    abort();
  }
  return 0;
}
