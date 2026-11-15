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

#include <inttypes.h>
#include <string.h>

#include <openssl/buf.h>
#include <openssl/err.h>
#include <openssl/mem.h>
#include <openssl/x509.h>

#include "../internal.h"
#include "internal.h"

typedef struct lookup_dir_hashes_st {
  uint32_t hash;
  int suffix;
} BY_DIR_HASH;

typedef struct lookup_dir_entry_st {
  CRYPTO_MUTEX lock;
  char *dir;
  int dir_type;
  STACK_OF(BY_DIR_HASH) *hashes;
} BY_DIR_ENTRY;

typedef struct lookup_dir_st {
  STACK_OF(BY_DIR_ENTRY) *dirs;
} BY_DIR;

DEFINE_STACK_OF(BY_DIR_HASH)
DEFINE_STACK_OF(BY_DIR_ENTRY)

static int dir_ctrl(X509_LOOKUP *ctx, int cmd, const char *argp, long argl,
                    char **ret);
static int new_dir(X509_LOOKUP *lu);
static void free_dir(X509_LOOKUP *lu);
static int add_cert_dir(BY_DIR *ctx, const char *dir, int type);
static int get_cert_by_subject(X509_LOOKUP *xl, int type, const X509_NAME *name,
                               X509_OBJECT *ret);
static const X509_LOOKUP_METHOD x509_dir_lookup = {
    new_dir,              // new
    free_dir,             // free
    dir_ctrl,             // ctrl
    get_cert_by_subject,  // get_by_subject
};

const X509_LOOKUP_METHOD *X509_LOOKUP_hash_dir(void) {
  return &x509_dir_lookup;
}

static int dir_ctrl(X509_LOOKUP *ctx, int cmd, const char *argp, long argl,
                    char **retp) {
  int ret = 0;
  char *dir = nullptr;

  BY_DIR *ld = reinterpret_cast<BY_DIR *>(ctx->method_data);

  switch (cmd) {
    case X509_L_ADD_DIR:
      if (argl == X509_FILETYPE_DEFAULT) {
        dir = (char *)getenv(X509_get_default_cert_dir_env());
        if (dir) {
          ret = add_cert_dir(ld, dir, X509_FILETYPE_PEM);
        } else {
          ret =
              add_cert_dir(ld, X509_get_default_cert_dir(), X509_FILETYPE_PEM);
        }
        if (!ret) {
          OPENSSL_PUT_ERROR(X509, X509_R_LOADING_CERT_DIR);
        }
      } else {
        ret = add_cert_dir(ld, argp, (int)argl);
      }
      break;
  }
  return ret;
}

static int new_dir(X509_LOOKUP *lu) {
  BY_DIR *a;

  if ((a = (BY_DIR *)OPENSSL_malloc(sizeof(BY_DIR))) == nullptr) {
    return 0;
  }
  a->dirs = nullptr;
  lu->method_data = a;
  return 1;
}

static void by_dir_hash_free(BY_DIR_HASH *hash) { OPENSSL_free(hash); }

static int by_dir_hash_cmp(const BY_DIR_HASH *const *a,
                           const BY_DIR_HASH *const *b) {
  if ((*a)->hash > (*b)->hash) {
    return 1;
  }
  if ((*a)->hash < (*b)->hash) {
    return -1;
  }
  return 0;
}

static void by_dir_entry_free(BY_DIR_ENTRY *ent) {
  if (ent != nullptr) {
    CRYPTO_MUTEX_cleanup(&ent->lock);
    OPENSSL_free(ent->dir);
    sk_BY_DIR_HASH_pop_free(ent->hashes, by_dir_hash_free);
    OPENSSL_free(ent);
  }
}

static void free_dir(X509_LOOKUP *lu) {
  BY_DIR *a = reinterpret_cast<BY_DIR *>(lu->method_data);
  if (a != nullptr) {
    sk_BY_DIR_ENTRY_pop_free(a->dirs, by_dir_entry_free);
    OPENSSL_free(a);
  }
}

#if defined(OPENSSL_WINDOWS)
#define DIR_HASH_SEPARATOR ';'
#else
#define DIR_HASH_SEPARATOR ':'
#endif

static int add_cert_dir(BY_DIR *ctx, const char *dir, int type) {
  size_t j, len;
  const char *s, *ss, *p;

  if (dir == nullptr || !*dir) {
    OPENSSL_PUT_ERROR(X509, X509_R_INVALID_DIRECTORY);
    return 0;
  }

  s = dir;
  p = s;
  do {
    if (*p == DIR_HASH_SEPARATOR || *p == '\0') {
      BY_DIR_ENTRY *ent;
      ss = s;
      s = p + 1;
      len = p - ss;
      if (len == 0) {
        continue;
      }
      for (j = 0; j < sk_BY_DIR_ENTRY_num(ctx->dirs); j++) {
        ent = sk_BY_DIR_ENTRY_value(ctx->dirs, j);
        if (strlen(ent->dir) == len && strncmp(ent->dir, ss, len) == 0) {
          break;
        }
      }
      if (j < sk_BY_DIR_ENTRY_num(ctx->dirs)) {
        continue;
      }
      if (ctx->dirs == nullptr) {
        ctx->dirs = sk_BY_DIR_ENTRY_new_null();
        if (!ctx->dirs) {
          return 0;
        }
      }
      ent = reinterpret_cast<BY_DIR_ENTRY *>(
          OPENSSL_malloc(sizeof(BY_DIR_ENTRY)));
      if (!ent) {
        return 0;
      }
      CRYPTO_MUTEX_init(&ent->lock);
      ent->dir_type = type;
      ent->hashes = sk_BY_DIR_HASH_new(by_dir_hash_cmp);
      ent->dir = OPENSSL_strndup(ss, len);
      if (ent->dir == nullptr || ent->hashes == nullptr ||
          !sk_BY_DIR_ENTRY_push(ctx->dirs, ent)) {
        by_dir_entry_free(ent);
        return 0;
      }
    }
  } while (*p++ != '\0');
  return 1;
}

static int get_cert_by_subject(X509_LOOKUP *xl, int type, const X509_NAME *name,
                               X509_OBJECT *ret) {
  bssl::UniquePtr<X509> lookup_cert;
  bssl::UniquePtr<X509_CRL> lookup_crl;
  int ok = 0;
  size_t i;
  int k;
  uint32_t h;
  uint32_t hash_array[2];
  int hash_index;
  char *b = nullptr;
  X509_OBJECT stmp, *tmp;
  const char *postfix = "";

  if (name == nullptr) {
    return 0;
  }

  stmp.type = type;
  BY_DIR *ctx = reinterpret_cast<BY_DIR *>(xl->method_data);
  if (type == X509_LU_X509) {
    lookup_cert.reset(X509_new());
    if (lookup_cert == nullptr ||
        !X509_set_subject_name(lookup_cert.get(), name)) {
      return 0;
    }
    stmp.data.x509 = lookup_cert.get();
    postfix = "";
  } else if (type == X509_LU_CRL) {
    lookup_crl.reset(X509_CRL_new());
    if (lookup_crl == nullptr ||
        !X509_CRL_set_issuer_name(lookup_crl.get(), name)) {
      return 0;
    }
    stmp.data.crl = lookup_crl.get();
    postfix = "r";
  } else {
    OPENSSL_PUT_ERROR(X509, X509_R_WRONG_LOOKUP_TYPE);
    goto finish;
  }

  hash_array[0] = X509_NAME_hash(name);
  hash_array[1] = X509_NAME_hash_old(name);
  for (hash_index = 0; hash_index < 2; ++hash_index) {
    h = hash_array[hash_index];
    for (i = 0; i < sk_BY_DIR_ENTRY_num(ctx->dirs); i++) {
      BY_DIR_ENTRY *ent;
      size_t idx;
      BY_DIR_HASH htmp, *hent;
      ent = sk_BY_DIR_ENTRY_value(ctx->dirs, i);
      if (type == X509_LU_CRL && ent->hashes) {
        htmp.hash = h;
        CRYPTO_MUTEX_lock_read(&ent->lock);
        if (sk_BY_DIR_HASH_find(ent->hashes, &idx, &htmp)) {
          hent = sk_BY_DIR_HASH_value(ent->hashes, idx);
          k = hent->suffix;
        } else {
          hent = nullptr;
          k = 0;
        }
        CRYPTO_MUTEX_unlock_read(&ent->lock);
      } else {
        k = 0;
        hent = nullptr;
      }
      for (;;) {
        OPENSSL_free(b);
        if (OPENSSL_asprintf(&b, "%s/%08" PRIx32 ".%s%d", ent->dir, h, postfix,
                             k) == -1) {
          OPENSSL_PUT_ERROR(X509, ERR_R_BUF_LIB);
          b = nullptr;
          goto finish;
        }
        if (type == X509_LU_X509) {
          if ((X509_load_cert_file(xl, b, ent->dir_type)) == 0) {
            // Don't expose the lower level error, All of these boil
            // down to "we could not find a CA".
            ERR_clear_error();
            break;
          }
        } else if (type == X509_LU_CRL) {
          if ((X509_load_crl_file(xl, b, ent->dir_type)) == 0) {
            // Don't expose the lower level error, All of these boil
            // down to "we could not find a CRL".
            ERR_clear_error();
            break;
          }
        }
        // The lack of a CA or CRL will be caught higher up
        k++;
      }

      // we have added it to the cache so now pull it out again
      CRYPTO_MUTEX_lock_write(&xl->store_ctx->objs_lock);
      tmp = nullptr;
      sk_X509_OBJECT_sort(xl->store_ctx->objs);
      if (sk_X509_OBJECT_find(xl->store_ctx->objs, &idx, &stmp)) {
        tmp = sk_X509_OBJECT_value(xl->store_ctx->objs, idx);
      }
      CRYPTO_MUTEX_unlock_write(&xl->store_ctx->objs_lock);

      // If a CRL, update the last file suffix added for this

      if (type == X509_LU_CRL) {
        CRYPTO_MUTEX_lock_write(&ent->lock);
        // Look for entry again in case another thread added an entry
        // first.
        if (!hent) {
          htmp.hash = h;
          sk_BY_DIR_HASH_sort(ent->hashes);
          if (sk_BY_DIR_HASH_find(ent->hashes, &idx, &htmp)) {
            hent = sk_BY_DIR_HASH_value(ent->hashes, idx);
          }
        }
        if (!hent) {
          hent = reinterpret_cast<BY_DIR_HASH *>(
              OPENSSL_malloc(sizeof(BY_DIR_HASH)));
          if (hent == nullptr) {
            CRYPTO_MUTEX_unlock_write(&ent->lock);
            ok = 0;
            goto finish;
          }
          hent->hash = h;
          hent->suffix = k;
          if (!sk_BY_DIR_HASH_push(ent->hashes, hent)) {
            CRYPTO_MUTEX_unlock_write(&ent->lock);
            OPENSSL_free(hent);
            ok = 0;
            goto finish;
          }
          sk_BY_DIR_HASH_sort(ent->hashes);
        } else if (hent->suffix < k) {
          hent->suffix = k;
        }

        CRYPTO_MUTEX_unlock_write(&ent->lock);
      }

      if (tmp != nullptr) {
        ok = 1;
        ret->type = tmp->type;
        OPENSSL_memcpy(&ret->data, &tmp->data, sizeof(ret->data));

        // Clear any errors that might have been raised processing empty
        // or malformed files.
        ERR_clear_error();

        // If we were going to up the reference count, we would need
        // to do it on a perl 'type' basis
        goto finish;
      }
    }
  }
finish:
  OPENSSL_free(b);
  return ok;
}

int X509_LOOKUP_add_dir(X509_LOOKUP *lookup, const char *name, int type) {
  return X509_LOOKUP_ctrl(lookup, X509_L_ADD_DIR, name, type, nullptr);
}
