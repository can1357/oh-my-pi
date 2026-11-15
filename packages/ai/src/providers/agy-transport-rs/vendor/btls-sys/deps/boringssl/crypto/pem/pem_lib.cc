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

#include <assert.h>
#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include <string_view>

#include <openssl/base64.h>
#include <openssl/buf.h>
#include <openssl/cipher.h>
#include <openssl/des.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/obj.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"


#define MIN_LENGTH 4

static int load_iv(const char **fromp, unsigned char *to, size_t num);
static int check_pem(const char *nm, const char *name);

// PEM_proc_type appends a Proc-Type header to |buf|, determined by |type|.
static void PEM_proc_type(char buf[PEM_BUFSIZE], int type) {
  const char *str;

  if (type == PEM_TYPE_ENCRYPTED) {
    str = "ENCRYPTED";
  } else if (type == PEM_TYPE_MIC_CLEAR) {
    str = "MIC-CLEAR";
  } else if (type == PEM_TYPE_MIC_ONLY) {
    str = "MIC-ONLY";
  } else {
    str = "BAD-TYPE";
  }

  OPENSSL_strlcat(buf, "Proc-Type: 4,", PEM_BUFSIZE);
  OPENSSL_strlcat(buf, str, PEM_BUFSIZE);
  OPENSSL_strlcat(buf, "\n", PEM_BUFSIZE);
}

// PEM_dek_info appends a DEK-Info header to |buf|, with an algorithm of |type|
// and a single parameter, specified by hex-encoding |len| bytes from |str|.
static void PEM_dek_info(char buf[PEM_BUFSIZE], const char *type, size_t len,
                         char *str) {
  static const unsigned char map[17] = "0123456789ABCDEF";

  OPENSSL_strlcat(buf, "DEK-Info: ", PEM_BUFSIZE);
  OPENSSL_strlcat(buf, type, PEM_BUFSIZE);
  OPENSSL_strlcat(buf, ",", PEM_BUFSIZE);

  const size_t used = strlen(buf);
  const size_t available = PEM_BUFSIZE - used;
  if (len * 2 < len || len * 2 + 2 < len || available < len * 2 + 2) {
    return;
  }

  for (size_t i = 0; i < len; i++) {
    buf[used + i * 2] = map[(str[i] >> 4) & 0x0f];
    buf[used + i * 2 + 1] = map[(str[i]) & 0x0f];
  }
  buf[used + len * 2] = '\n';
  buf[used + len * 2 + 1] = '\0';
}

void *PEM_ASN1_read(d2i_of_void *d2i, const char *name, FILE *fp, void **x,
                    pem_password_cb *cb, void *u) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return nullptr;
  }
  void *ret = PEM_ASN1_read_bio(d2i, name, b, x, cb, u);
  BIO_free(b);
  return ret;
}

static int check_pem(const char *nm, const char *name) {
  // Normal matching nm and name
  if (!strcmp(nm, name)) {
    return 1;
  }

  // Make PEM_STRING_EVP_PKEY match any private key

  if (!strcmp(name, PEM_STRING_EVP_PKEY)) {
    return !strcmp(nm, PEM_STRING_PKCS8) || !strcmp(nm, PEM_STRING_PKCS8INF) ||
           !strcmp(nm, PEM_STRING_RSA) || !strcmp(nm, PEM_STRING_EC) ||
           !strcmp(nm, PEM_STRING_DSA);
  }

  // Permit older strings

  if (!strcmp(nm, PEM_STRING_X509_OLD) && !strcmp(name, PEM_STRING_X509)) {
    return 1;
  }

  if (!strcmp(nm, PEM_STRING_X509_REQ_OLD) &&
      !strcmp(name, PEM_STRING_X509_REQ)) {
    return 1;
  }

  // Allow normal certs to be read as trusted certs
  if (!strcmp(nm, PEM_STRING_X509) && !strcmp(name, PEM_STRING_X509_TRUSTED)) {
    return 1;
  }

  if (!strcmp(nm, PEM_STRING_X509_OLD) &&
      !strcmp(name, PEM_STRING_X509_TRUSTED)) {
    return 1;
  }

  // Some CAs use PKCS#7 with CERTIFICATE headers
  if (!strcmp(nm, PEM_STRING_X509) && !strcmp(name, PEM_STRING_PKCS7)) {
    return 1;
  }

  if (!strcmp(nm, PEM_STRING_PKCS7_SIGNED) && !strcmp(name, PEM_STRING_PKCS7)) {
    return 1;
  }

#ifndef OPENSSL_NO_CMS
  if (!strcmp(nm, PEM_STRING_X509) && !strcmp(name, PEM_STRING_CMS)) {
    return 1;
  }
  // Allow CMS to be read from PKCS#7 headers
  if (!strcmp(nm, PEM_STRING_PKCS7) && !strcmp(name, PEM_STRING_CMS)) {
    return 1;
  }
#endif

  return 0;
}

static const EVP_CIPHER *cipher_by_name(std::string_view name) {
  // This is similar to the (deprecated) function |EVP_get_cipherbyname|. Note
  // the PEM code assumes that ciphers have at least 8 bytes of IV, at most 20
  // bytes of overhead and generally behave like CBC mode.
  if (name == SN_des_cbc) {
    return EVP_des_cbc();
  } else if (name == SN_des_ede3_cbc) {
    return EVP_des_ede3_cbc();
  } else if (name == SN_aes_128_cbc) {
    return EVP_aes_128_cbc();
  } else if (name == SN_aes_192_cbc) {
    return EVP_aes_192_cbc();
  } else if (name == SN_aes_256_cbc) {
    return EVP_aes_256_cbc();
  } else {
    return nullptr;
  }
}

int PEM_bytes_read_bio(unsigned char **pdata, long *plen, char **pnm,
                       const char *name, BIO *bp, pem_password_cb *cb,
                       void *u) {
  EVP_CIPHER_INFO cipher;
  char *nm = nullptr, *header = nullptr;
  unsigned char *data = nullptr;
  long len;
  int ret = 0;

  for (;;) {
    if (!PEM_read_bio(bp, &nm, &header, &data, &len)) {
      if (ERR_equals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE)) {
        ERR_add_error_data(2, "Expecting: ", name);
      }
      return 0;
    }
    if (check_pem(nm, name)) {
      break;
    }
    OPENSSL_free(nm);
    OPENSSL_free(header);
    OPENSSL_free(data);
  }
  if (!PEM_get_EVP_CIPHER_INFO(header, &cipher)) {
    goto err;
  }
  if (!PEM_do_header(&cipher, data, &len, cb, u)) {
    goto err;
  }

  *pdata = data;
  *plen = len;

  if (pnm) {
    *pnm = nm;
  }

  ret = 1;

err:
  if (!ret || !pnm) {
    OPENSSL_free(nm);
  }
  OPENSSL_free(header);
  if (!ret) {
    OPENSSL_free(data);
  }
  return ret;
}

int PEM_ASN1_write(i2d_of_void *i2d, const char *name, FILE *fp, void *x,
                   const EVP_CIPHER *enc, const unsigned char *pass,
                   int pass_len, pem_password_cb *callback, void *u) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return 0;
  }
  int ret =
      PEM_ASN1_write_bio(i2d, name, b, x, enc, pass, pass_len, callback, u);
  BIO_free(b);
  return ret;
}

int PEM_ASN1_write_bio(i2d_of_void *i2d, const char *name, BIO *bp, void *x,
                       const EVP_CIPHER *enc, const unsigned char *pass,
                       int pass_len, pem_password_cb *callback, void *u) {
  bssl::ScopedEVP_CIPHER_CTX ctx;
  int dsize = 0, i, j, ret = 0;
  unsigned char *p, *data = nullptr;
  const char *objstr = nullptr;
  char buf[PEM_BUFSIZE];
  unsigned char key[EVP_MAX_KEY_LENGTH];
  unsigned char iv[EVP_MAX_IV_LENGTH];

  if (enc != nullptr) {
    objstr = OBJ_nid2sn(EVP_CIPHER_nid(enc));
    if (objstr == nullptr || cipher_by_name(objstr) == nullptr ||
        EVP_CIPHER_iv_length(enc) < 8) {
      OPENSSL_PUT_ERROR(PEM, PEM_R_UNSUPPORTED_CIPHER);
      goto err;
    }
  }

  if ((dsize = i2d(x, nullptr)) < 0) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_ASN1_LIB);
    dsize = 0;
    goto err;
  }
  // dzise + 8 bytes are needed
  // actually it needs the cipher block size extra...
  data = (unsigned char *)OPENSSL_malloc((unsigned int)dsize + 20);
  if (data == nullptr) {
    goto err;
  }
  p = data;
  i = i2d(x, &p);

  if (enc != nullptr) {
    const unsigned iv_len = EVP_CIPHER_iv_length(enc);

    if (pass == nullptr) {
      if (!callback) {
        callback = PEM_def_callback;
      }
      pass_len = (*callback)(buf, PEM_BUFSIZE, 1, u);
      if (pass_len < 0) {
        OPENSSL_PUT_ERROR(PEM, PEM_R_READ_KEY);
        goto err;
      }
      pass = (const unsigned char *)buf;
    }
    assert(iv_len <= sizeof(iv));
    if (!RAND_bytes(iv, iv_len)) {  // Generate a salt
      goto err;
    }
    // The 'iv' is used as the iv and as a salt.  It is NOT taken from
    // the BytesToKey function
    if (!EVP_BytesToKey(enc, EVP_md5(), iv, pass, pass_len, 1, key, nullptr)) {
      goto err;
    }

    if (pass == (const unsigned char *)buf) {
      OPENSSL_cleanse(buf, PEM_BUFSIZE);
    }

    assert(strlen(objstr) + 23 + 2 * iv_len + 13 <= sizeof(buf));

    buf[0] = '\0';
    PEM_proc_type(buf, PEM_TYPE_ENCRYPTED);
    PEM_dek_info(buf, objstr, iv_len, (char *)iv);
    // k=strlen(buf);

    ret = 1;
    if (!EVP_EncryptInit_ex(ctx.get(), enc, nullptr, key, iv) ||
        !EVP_EncryptUpdate(ctx.get(), data, &j, data, i) ||
        !EVP_EncryptFinal_ex(ctx.get(), &(data[j]), &i)) {
      ret = 0;
    } else {
      i += j;
    }
    if (ret == 0) {
      goto err;
    }
  } else {
    ret = 1;
    buf[0] = '\0';
  }
  i = PEM_write_bio(bp, name, buf, data, i);
  if (i <= 0) {
    ret = 0;
  }
err:
  OPENSSL_cleanse(key, sizeof(key));
  OPENSSL_cleanse(iv, sizeof(iv));
  OPENSSL_cleanse(buf, PEM_BUFSIZE);
  OPENSSL_free(data);
  return ret;
}

int PEM_do_header(const EVP_CIPHER_INFO *cipher, unsigned char *data,
                  long *plen, pem_password_cb *callback, void *u) {
  int i = 0, j, o, pass_len;
  long len;
  bssl::ScopedEVP_CIPHER_CTX ctx;
  unsigned char key[EVP_MAX_KEY_LENGTH];
  char buf[PEM_BUFSIZE];

  len = *plen;

  if (cipher->cipher == nullptr) {
    return 1;
  }

  pass_len = 0;
  if (!callback) {
    callback = PEM_def_callback;
  }
  pass_len = callback(buf, PEM_BUFSIZE, 0, u);
  if (pass_len < 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_PASSWORD_READ);
    return 0;
  }

  if (!EVP_BytesToKey(cipher->cipher, EVP_md5(), cipher->iv,
                      (unsigned char *)buf, pass_len, 1, key, nullptr)) {
    return 0;
  }

  j = (int)len;
  o = EVP_DecryptInit_ex(ctx.get(), cipher->cipher, nullptr, key, cipher->iv);
  if (o) {
    o = EVP_DecryptUpdate(ctx.get(), data, &i, data, j);
  }
  if (o) {
    o = EVP_DecryptFinal_ex(ctx.get(), &(data[i]), &j);
  }
  OPENSSL_cleanse((char *)buf, sizeof(buf));
  OPENSSL_cleanse((char *)key, sizeof(key));
  if (!o) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_DECRYPT);
    return 0;
  }
  j += i;
  *plen = j;
  return 1;
}

int PEM_get_EVP_CIPHER_INFO(const char *header, EVP_CIPHER_INFO *cipher) {
  cipher->cipher = nullptr;
  OPENSSL_memset(cipher->iv, 0, sizeof(cipher->iv));
  if ((header == nullptr) || (*header == '\0') || (*header == '\n')) {
    return 1;
  }
  if (strncmp(header, "Proc-Type: ", 11) != 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_NOT_PROC_TYPE);
    return 0;
  }
  header += 11;
  if (header[0] != '4' || header[1] != ',') {
    OPENSSL_PUT_ERROR(PEM, PEM_R_UNSUPPORTED_PROC_TYPE_VERSION);
    return 0;
  }
  header += 2;
  if (strncmp(header, "ENCRYPTED", 9) != 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_NOT_ENCRYPTED);
    return 0;
  }
  for (; (*header != '\n') && (*header != '\0'); header++) {
    ;
  }
  if (*header == '\0') {
    OPENSSL_PUT_ERROR(PEM, PEM_R_SHORT_HEADER);
    return 0;
  }
  header++;
  if (strncmp(header, "DEK-Info: ", 10) != 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_NOT_DEK_INFO);
    return 0;
  }
  header += 10;

  const char *p = header;
  for (;;) {
    char c = *header;
    if (!((c >= 'A' && c <= 'Z') || c == '-' || OPENSSL_isdigit(c))) {
      break;
    }
    header++;
  }
  cipher->cipher = cipher_by_name(std::string_view(p, header - p));
  header++;
  if (cipher->cipher == nullptr) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_UNSUPPORTED_ENCRYPTION);
    return 0;
  }
  // The IV parameter must be at least 8 bytes long to be used as the salt in
  // the KDF. (This should not happen given |cipher_by_name|.)
  if (EVP_CIPHER_iv_length(cipher->cipher) < 8) {
    assert(0);
    OPENSSL_PUT_ERROR(PEM, PEM_R_UNSUPPORTED_ENCRYPTION);
    return 0;
  }
  const char **header_pp = &header;
  if (!load_iv(header_pp, cipher->iv, EVP_CIPHER_iv_length(cipher->cipher))) {
    return 0;
  }

  return 1;
}

static int load_iv(const char **fromp, unsigned char *to, size_t num) {
  uint8_t v;
  const char *from;

  from = *fromp;
  for (size_t i = 0; i < num; i++) {
    to[i] = 0;
  }
  num *= 2;
  for (size_t i = 0; i < num; i++) {
    if (!OPENSSL_fromxdigit(&v, *from)) {
      OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_IV_CHARS);
      return 0;
    }
    from++;
    to[i / 2] |= v << (!(i & 1)) * 4;
  }

  *fromp = from;
  return 1;
}

int PEM_write(FILE *fp, const char *name, const char *header,
              const unsigned char *data, long len) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return 0;
  }
  int ret = PEM_write_bio(b, name, header, data, len);
  BIO_free(b);
  return ret;
}

int PEM_write_bio(BIO *bp, const char *name, const char *header,
                  const unsigned char *data, long len) {
  int nlen, n, i, j, outl;
  unsigned char *buf = nullptr;
  EVP_ENCODE_CTX ctx;
  int reason = ERR_R_BUF_LIB;
  int retval = 0;

  EVP_EncodeInit(&ctx);
  nlen = strlen(name);

  if ((BIO_write(bp, "-----BEGIN ", 11) != 11) ||
      (BIO_write(bp, name, nlen) != nlen) ||
      (BIO_write(bp, "-----\n", 6) != 6)) {
    goto err;
  }

  i = strlen(header);
  if (i > 0) {
    if ((BIO_write(bp, header, i) != i) || (BIO_write(bp, "\n", 1) != 1)) {
      goto err;
    }
  }

  buf = reinterpret_cast<uint8_t *>(OPENSSL_malloc(PEM_BUFSIZE * 8));
  if (buf == nullptr) {
    goto err;
  }

  i = j = 0;
  while (len > 0) {
    n = (int)((len > (PEM_BUFSIZE * 5)) ? (PEM_BUFSIZE * 5) : len);
    EVP_EncodeUpdate(&ctx, buf, &outl, &(data[j]), n);
    if ((outl) && (BIO_write(bp, (char *)buf, outl) != outl)) {
      goto err;
    }
    i += outl;
    len -= n;
    j += n;
  }
  EVP_EncodeFinal(&ctx, buf, &outl);
  if ((outl > 0) && (BIO_write(bp, (char *)buf, outl) != outl)) {
    goto err;
  }
  if ((BIO_write(bp, "-----END ", 9) != 9) ||
      (BIO_write(bp, name, nlen) != nlen) ||
      (BIO_write(bp, "-----\n", 6) != 6)) {
    goto err;
  }
  retval = i + outl;

err:
  if (retval == 0) {
    OPENSSL_PUT_ERROR(PEM, reason);
  }
  OPENSSL_free(buf);
  return retval;
}

int PEM_read(FILE *fp, char **name, char **header, unsigned char **data,
             long *len) {
  BIO *b = BIO_new_fp(fp, BIO_NOCLOSE);
  if (b == nullptr) {
    OPENSSL_PUT_ERROR(PEM, ERR_R_BUF_LIB);
    return 0;
  }
  int ret = PEM_read_bio(b, name, header, data, len);
  BIO_free(b);
  return ret;
}

int PEM_read_bio(BIO *bp, char **name, char **header, unsigned char **data,
                 long *len) {
  EVP_ENCODE_CTX ctx;
  int end = 0, i, k, bl = 0, hl = 0, nohead = 0;
  char buf[256];
  BUF_MEM *nameB;
  BUF_MEM *headerB;
  BUF_MEM *dataB, *tmpB;

  nameB = BUF_MEM_new();
  headerB = BUF_MEM_new();
  dataB = BUF_MEM_new();
  if ((nameB == nullptr) || (headerB == nullptr) || (dataB == nullptr)) {
    BUF_MEM_free(nameB);
    BUF_MEM_free(headerB);
    BUF_MEM_free(dataB);
    return 0;
  }

  buf[254] = '\0';
  for (;;) {
    i = BIO_gets(bp, buf, 254);

    if (i <= 0) {
      OPENSSL_PUT_ERROR(PEM, PEM_R_NO_START_LINE);
      goto err;
    }

    while ((i >= 0) && (buf[i] <= ' ')) {
      i--;
    }
    buf[++i] = '\n';
    buf[++i] = '\0';

    if (strncmp(buf, "-----BEGIN ", 11) == 0) {
      i = strlen(&(buf[11]));

      if (strncmp(&(buf[11 + i - 6]), "-----\n", 6) != 0) {
        continue;
      }
      if (!BUF_MEM_grow(nameB, i + 9)) {
        goto err;
      }
      OPENSSL_memcpy(nameB->data, &(buf[11]), i - 6);
      nameB->data[i - 6] = '\0';
      break;
    }
  }
  hl = 0;
  if (!BUF_MEM_grow(headerB, 256)) {
    goto err;
  }
  headerB->data[0] = '\0';
  for (;;) {
    i = BIO_gets(bp, buf, 254);
    if (i <= 0) {
      break;
    }

    while ((i >= 0) && (buf[i] <= ' ')) {
      i--;
    }
    buf[++i] = '\n';
    buf[++i] = '\0';

    if (buf[0] == '\n') {
      break;
    }
    if (!BUF_MEM_grow(headerB, hl + i + 9)) {
      goto err;
    }
    if (strncmp(buf, "-----END ", 9) == 0) {
      nohead = 1;
      break;
    }
    OPENSSL_memcpy(&(headerB->data[hl]), buf, i);
    headerB->data[hl + i] = '\0';
    hl += i;
  }

  bl = 0;
  if (!BUF_MEM_grow(dataB, 1024)) {
    goto err;
  }
  dataB->data[0] = '\0';
  if (!nohead) {
    for (;;) {
      i = BIO_gets(bp, buf, 254);
      if (i <= 0) {
        break;
      }

      while ((i >= 0) && (buf[i] <= ' ')) {
        i--;
      }
      buf[++i] = '\n';
      buf[++i] = '\0';

      if (i != 65) {
        end = 1;
      }
      if (strncmp(buf, "-----END ", 9) == 0) {
        break;
      }
      if (i > 65) {
        break;
      }
      if (!BUF_MEM_grow_clean(dataB, i + bl + 9)) {
        goto err;
      }
      OPENSSL_memcpy(&(dataB->data[bl]), buf, i);
      dataB->data[bl + i] = '\0';
      bl += i;
      if (end) {
        buf[0] = '\0';
        i = BIO_gets(bp, buf, 254);
        if (i <= 0) {
          break;
        }

        while ((i >= 0) && (buf[i] <= ' ')) {
          i--;
        }
        buf[++i] = '\n';
        buf[++i] = '\0';

        break;
      }
    }
  } else {
    tmpB = headerB;
    headerB = dataB;
    dataB = tmpB;
    bl = hl;
  }
  i = strlen(nameB->data);
  if ((strncmp(buf, "-----END ", 9) != 0) ||
      (strncmp(nameB->data, &(buf[9]), i) != 0) ||
      (strncmp(&(buf[9 + i]), "-----\n", 6) != 0)) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_END_LINE);
    goto err;
  }

  EVP_DecodeInit(&ctx);
  i = EVP_DecodeUpdate(&ctx, (unsigned char *)dataB->data, &bl,
                       (unsigned char *)dataB->data, bl);
  if (i < 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_BASE64_DECODE);
    goto err;
  }
  i = EVP_DecodeFinal(&ctx, (unsigned char *)&(dataB->data[bl]), &k);
  if (i < 0) {
    OPENSSL_PUT_ERROR(PEM, PEM_R_BAD_BASE64_DECODE);
    goto err;
  }
  bl += k;

  if (bl == 0) {
    goto err;
  }
  *name = nameB->data;
  *header = headerB->data;
  *data = (unsigned char *)dataB->data;
  *len = bl;
  OPENSSL_free(nameB);
  OPENSSL_free(headerB);
  OPENSSL_free(dataB);
  return 1;
err:
  BUF_MEM_free(nameB);
  BUF_MEM_free(headerB);
  BUF_MEM_free(dataB);
  return 0;
}

int PEM_def_callback(char *buf, int size, int rwflag, void *userdata) {
  if (!buf || !userdata || size < 0) {
    return -1;
  }
  size_t len = strlen((char *)userdata);
  if (len >= (size_t)size) {
    return -1;
  }
  OPENSSL_strlcpy(buf, reinterpret_cast<char *>(userdata), (size_t)size);
  return (int)len;
}
