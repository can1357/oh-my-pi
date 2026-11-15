#ifndef BEDROCK_UNVERIFIED_BAREMINIMUM_INC_H_
#define BEDROCK_UNVERIFIED_BAREMINIMUM_INC_H_

static_assert(sizeof(br_word_t) == sizeof(br_signed_t), "");
static_assert(UINTPTR_MAX <= BR_WORD_MAX, "");

// "An object shall have its stored value accessed only ... a character type."

static inline br_word_t _br_load1(br_word_t a) {
  return *((uint8_t *)a);
}

static inline br_word_t _br_load2(br_word_t a) {
  uint16_t r = 0;
  memcpy(&r, (void *)a, sizeof(r));
  return r;
}

static inline br_word_t _br_load4(br_word_t a) {
  uint32_t r = 0;
  memcpy(&r, (void *)a, sizeof(r));
  return r;
}

static inline br_word_t _br_load(br_word_t a) {
  br_word_t r = 0;
  memcpy(&r, (void *)a, sizeof(r));
  return r;
}

static inline void _br_store1(br_word_t a, uint8_t v) {
  *((uint8_t *)a) = v;
}

static inline void _br_store2(br_word_t a, uint16_t v) {
  memcpy((void *)a, &v, sizeof(v));
}

static inline void _br_store4(br_word_t a, uint32_t v) {
  memcpy((void *)a, &v, sizeof(v));
}

static inline void _br_store(br_word_t a, br_word_t v) {
  memcpy((void *)a, &v, sizeof(v));
}

#endif // BEDROCK_UNVERIFIED_BAREMINIMUM_INC_H_
