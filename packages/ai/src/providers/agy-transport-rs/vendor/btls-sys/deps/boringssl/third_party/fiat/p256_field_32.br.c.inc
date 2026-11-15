// Generated from Bedrock code in Fiat Cryptography. Avoid editing directly.

static inline br_word_t shrd(br_word_t lo, br_word_t hi, br_word_t n) {
  br_word_t res;
  res = lo>>(n&(sizeof(br_word_t)*8-1));
  if (n) {
    res = (hi<<((((((0u-(br_word_t)1)>>27)&63)+1)-n)&(sizeof(br_word_t)*8-1)))|res;
  } else {
    /*skip*/
  }
  return res;
}

static inline br_word_t p256_coord_nonzero(br_word_t p_x) {
  br_word_t nz;
  nz = (((_br_load(p_x))|(_br_load(p_x+4)))|(_br_load((p_x+4)+4)))|(_br_load(((p_x+4)+4)+4));
  nz = nz|(_br_load((((p_x+4)+4)+4)+4));
  nz = nz|(_br_load(((((p_x+4)+4)+4)+4)+4));
  nz = nz|(_br_load((((((p_x+4)+4)+4)+4)+4)+4));
  nz = nz|(_br_load(((((((p_x+4)+4)+4)+4)+4)+4)+4));
  nz = br_broadcast_nonzero(nz);
  return nz;
}

static inline void u256_shr(br_word_t p_out, br_word_t p_x, br_word_t n) {
  br_word_t x0, x1, x2, x3, x4, x5, x6, x7, y0, y1, y2, y3, y4, y5, y6, y7;
  x0 = _br_load(p_x);
  x1 = _br_load(p_x+4);
  x2 = _br_load((p_x+4)+4);
  x3 = _br_load(((p_x+4)+4)+4);
  x4 = _br_load((((p_x+4)+4)+4)+4);
  x5 = _br_load(((((p_x+4)+4)+4)+4)+4);
  x6 = _br_load((((((p_x+4)+4)+4)+4)+4)+4);
  x7 = _br_load(((((((p_x+4)+4)+4)+4)+4)+4)+4);
  y0 = shrd(x0, x1, n);
  y1 = shrd(x1, x2, n);
  y2 = shrd(x2, x3, n);
  y3 = shrd(x3, x4, n);
  y4 = shrd(x4, x5, n);
  y5 = shrd(x5, x6, n);
  y6 = shrd(x6, x7, n);
  y7 = x7>>(n&(sizeof(br_word_t)*8-1));
  _br_store(p_out, y0);
  _br_store(p_out+4, y1);
  _br_store((p_out+4)+4, y2);
  _br_store(((p_out+4)+4)+4, y3);
  _br_store((((p_out+4)+4)+4)+4, y4);
  _br_store(((((p_out+4)+4)+4)+4)+4, y5);
  _br_store((((((p_out+4)+4)+4)+4)+4)+4, y6);
  _br_store(((((((p_out+4)+4)+4)+4)+4)+4)+4, y7);
}

static inline void u256_set_p256_minushalf_conditional(br_word_t p_out, br_word_t mask) {
  br_word_t mh0, mh1, mh2, mh3, mh4, mh5, mh6, mh7;
  mh0 = 0u-(br_word_t)1;
  mh1 = mh0;
  mh2 = mh0>>1;
  mh3 = (br_word_t)0;
  mh4 = (br_word_t)0;
  mh5 = (br_word_t)1<<31;
  mh6 = mh5;
  mh7 = mh2;
  _br_store(p_out, mask&mh0);
  _br_store(p_out+4, mask&mh1);
  _br_store((p_out+4)+4, mask&mh2);
  _br_store(((p_out+4)+4)+4, mask&mh3);
  _br_store((((p_out+4)+4)+4)+4, mask&mh4);
  _br_store(((((p_out+4)+4)+4)+4)+4, mask&mh5);
  _br_store((((((p_out+4)+4)+4)+4)+4)+4, mask&mh6);
  _br_store(((((((p_out+4)+4)+4)+4)+4)+4)+4, mask&mh7);
}
