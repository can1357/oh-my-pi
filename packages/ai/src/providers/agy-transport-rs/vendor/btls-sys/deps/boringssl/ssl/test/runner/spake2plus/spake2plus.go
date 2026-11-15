// Copyright 2025 The BoringSSL Authors
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

// Package spake2plus implements RFC 9383 for testing.
package spake2plus

import (
	"bytes"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"math/big"

	"golang.org/x/crypto/scrypt"
)

const (
	verifierSize           = 32 // size of w0, w1 in bytes, for P-256
	registrationRecordSize = 65 // uncompressed P-256 point size
	shareSize              = 65
	confirmSize            = 32
	keySize                = 32
	pbkdfOutputSize        = 80
)

type Role int

const (
	RoleProver Role = iota
	RoleVerifier
)

type state int

const (
	stateInit state = iota
	stateShareGenerated
	stateKeyGenerated
)

type Context struct {
	IDProver   []byte
	IDVerifier []byte
	Role       Role

	curve   elliptic.Curve
	context []byte
	w0      *big.Int
	w1      *big.Int
	Lx, Ly  *big.Int // L point
	Mx, My  *big.Int // M point
	Nx, Ny  *big.Int // N point
	Xx, Xy  *big.Int // X point
	Yx, Yy  *big.Int // Y point
	Zx, Zy  *big.Int // Z point
	Vx, Vy  *big.Int // V point
	x       *big.Int // ephemeral scalar for prover
	y       *big.Int // ephemeral scalar for verifier
	share   []byte
	confirm []byte
	state   state
}

// Hardcoded M and N from the RFC (uncompressed)
var kM = []byte{
	0x04, 0x88, 0x6e, 0x2f, 0x97, 0xac, 0xe4, 0x6e, 0x55, 0xba, 0x9d,
	0xd7, 0x24, 0x25, 0x79, 0xf2, 0x99, 0x3b, 0x64, 0xe1, 0x6e, 0xf3,
	0xdc, 0xab, 0x95, 0xaf, 0xd4, 0x97, 0x33, 0x3d, 0x8f, 0xa1, 0x2f,
	0x5f, 0xf3, 0x55, 0x16, 0x3e, 0x43, 0xce, 0x22, 0x4e, 0x0b, 0x0e,
	0x65, 0xff, 0x02, 0xac, 0x8e, 0x5c, 0x7b, 0xe0, 0x94, 0x19, 0xc7,
	0x85, 0xe0, 0xca, 0x54, 0x7d, 0x55, 0xa1, 0x2e, 0x2d, 0x20,
}

var kN = []byte{
	0x04, 0xd8, 0xbb, 0xd6, 0xc6, 0x39, 0xc6, 0x29, 0x37, 0xb0, 0x4d,
	0x99, 0x7f, 0x38, 0xc3, 0x77, 0x07, 0x19, 0xc6, 0x29, 0xd7, 0x01,
	0x4d, 0x49, 0xa2, 0x4b, 0x4f, 0x98, 0xba, 0xa1, 0x29, 0x2b, 0x49,
	0x07, 0xd6, 0x0a, 0xa6, 0xbf, 0xad, 0xe4, 0x50, 0x08, 0xa6, 0x36,
	0x33, 0x7f, 0x51, 0x68, 0xc6, 0x4d, 0x9b, 0xd3, 0x60, 0x34, 0x80,
	0x8c, 0xd5, 0x64, 0x49, 0x0b, 0x1e, 0x65, 0x6e, 0xdb, 0xe7,
}

func Register(
	pw []byte,
	idProver []byte,
	idVerifier []byte,
) (pwVerifierW0 []byte, pwVerifierW1 []byte, registrationRecord []byte, err error) {
	mhfBuf := new(bytes.Buffer)
	if err := binary.Write(mhfBuf, binary.LittleEndian, uint64(len(pw))); err != nil {
		return nil, nil, nil, err
	}
	mhfBuf.Write(pw)
	if err := binary.Write(mhfBuf, binary.LittleEndian, uint64(len(idProver))); err != nil {
		return nil, nil, nil, err
	}
	mhfBuf.Write(idProver)
	if err := binary.Write(mhfBuf, binary.LittleEndian, uint64(len(idVerifier))); err != nil {
		return nil, nil, nil, err
	}
	mhfBuf.Write(idVerifier)

	key, err := scrypt.Key(mhfBuf.Bytes(), nil, 32768, 8, 1, pbkdfOutputSize)
	if err != nil {
		return nil, nil, nil, err
	}

	curve := elliptic.P256()
	N := curve.Params().N

	w0 := new(big.Int).SetBytes(key[:pbkdfOutputSize/2])
	w0.Mod(w0, N)

	w1 := new(big.Int).SetBytes(key[pbkdfOutputSize/2:])
	w1.Mod(w1, N)

	pwVerifierW0 = make([]byte, verifierSize)
	pwVerifierW1 = make([]byte, verifierSize)
	copy(pwVerifierW0, w0.Bytes())
	copy(pwVerifierW1, w1.Bytes())

	Lx, Ly := curve.ScalarBaseMult(w1.Bytes())
	L := elliptic.Marshal(curve, Lx, Ly)
	registrationRecord = make([]byte, registrationRecordSize)
	copy(registrationRecord, L)

	return pwVerifierW0, pwVerifierW1, registrationRecord, nil
}

func newContext(
	role Role,
	context []byte,
	idProver []byte,
	idVerifier []byte,
	pwVerifierW0 []byte,
	pwVerifierW1 []byte,
	registrationRecord []byte,
	x *big.Int,
	y *big.Int,
) (*Context, error) {
	curve := elliptic.P256()

	Mx, My := elliptic.Unmarshal(curve, kM)
	if Mx == nil {
		return nil, errors.New("invalid M point")
	}
	Nx, Ny := elliptic.Unmarshal(curve, kN)
	if Nx == nil {
		return nil, errors.New("invalid N point")
	}

	ctx := &Context{
		Role:       role,
		curve:      curve,
		context:    append([]byte(nil), context...),
		IDProver:   append([]byte(nil), idProver...),
		IDVerifier: append([]byte(nil), idVerifier...),
		Mx:         Mx,
		My:         My,
		Nx:         Nx,
		Ny:         Ny,
		state:      stateInit,
	}

	N := curve.Params().N

	if role == RoleProver {
		if pwVerifierW0 == nil || pwVerifierW1 == nil || y != nil {
			return nil, errors.New("invalid parameters for prover")
		}

		ctx.w0 = new(big.Int).SetBytes(pwVerifierW0)
		ctx.w1 = new(big.Int).SetBytes(pwVerifierW1)
		ctx.w0.Mod(ctx.w0, N)
		ctx.w1.Mod(ctx.w1, N)

		if x == nil {
			xRand, err := randFieldElement(curve)
			if err != nil {
				return nil, err
			}
			ctx.x = xRand
		} else {
			ctx.x = new(big.Int).Set(x)
		}
	} else {
		// Verifier
		if pwVerifierW0 == nil || registrationRecord == nil || x != nil {
			return nil, errors.New("invalid parameters for verifier")
		}

		ctx.w0 = new(big.Int).SetBytes(pwVerifierW0)
		ctx.w0.Mod(ctx.w0, N)

		// Load L
		Lx, Ly := elliptic.Unmarshal(curve, registrationRecord)
		if Lx == nil {
			return nil, errors.New("invalid L point")
		}
		ctx.Lx, ctx.Ly = Lx, Ly

		if y == nil {
			yRand, err := randFieldElement(curve)
			if err != nil {
				return nil, err
			}
			ctx.y = yRand
		} else {
			ctx.y = new(big.Int).Set(y)
		}
	}

	return ctx, nil
}

func randFieldElement(curve elliptic.Curve) (*big.Int, error) {
	params := curve.Params()
	b := make([]byte, (params.BitSize+7)/8)
	var k *big.Int
	for {
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		k = new(big.Int).SetBytes(b)
		if k.Sign() != 0 && k.Cmp(params.N) < 0 {
			break
		}
	}
	return k, nil
}

func NewProver(
	context []byte, idProver []byte, idVerifier []byte,
	pwVerifierW0 []byte, pwVerifierW1 []byte,
) (*Context, error) {
	return newContext(RoleProver, context, idProver, idVerifier,
		pwVerifierW0, pwVerifierW1, nil, nil, nil)
}

func NewVerifier(
	context []byte, idProver []byte, idVerifier []byte,
	pwVerifierW0 []byte, registrationRecord []byte,
) (*Context, error) {
	return newContext(RoleVerifier, context, idProver, idVerifier,
		pwVerifierW0, nil, registrationRecord, nil, nil)
}

func (ctx *Context) GenerateProverShare() (share []byte, err error) {
	if ctx.Role != RoleProver {
		return nil, errors.New("invalid state for prover share generation")
	}
	if ctx.state != stateInit {
		return ctx.share, nil
	}
	curve := ctx.curve

	// l = x * G
	lx, ly := curve.ScalarBaseMult(ctx.x.Bytes())
	// r = w0 * M
	rx, ry := curve.ScalarMult(ctx.Mx, ctx.My, ctx.w0.Bytes())
	// X = l + r
	Xx, Xy := curve.Add(lx, ly, rx, ry)
	ctx.Xx, ctx.Xy = Xx, Xy

	share = elliptic.Marshal(curve, Xx, Xy)
	ctx.share = append([]byte(nil), share...)
	ctx.state = stateShareGenerated
	return share, nil
}

func updateWithLengthPrefix(h io.Writer, data []byte) {
	var lenLe [8]byte
	binary.LittleEndian.PutUint64(lenLe[:], uint64(len(data)))
	h.Write(lenLe[:])
	h.Write(data)
}

func computeTranscriptAndConfirmation(
	ctx *Context,
	shareP, shareV []byte,
) (proverConfirm, verifierConfirm, sharedSecret []byte, err error) {
	curve := ctx.curve
	Z := elliptic.Marshal(curve, ctx.Zx, ctx.Zy)
	V := elliptic.Marshal(curve, ctx.Vx, ctx.Vy)

	h := sha256.New()
	updateWithLengthPrefix(h, ctx.context)
	updateWithLengthPrefix(h, ctx.IDProver)
	updateWithLengthPrefix(h, ctx.IDVerifier)
	updateWithLengthPrefix(h, kM)
	updateWithLengthPrefix(h, kN)
	updateWithLengthPrefix(h, shareP)
	updateWithLengthPrefix(h, shareV)
	updateWithLengthPrefix(h, Z)
	updateWithLengthPrefix(h, V)
	updateWithLengthPrefix(h, ctx.w0.Bytes())
	K_main := h.Sum(nil)

	confirmationStr := []byte("ConfirmationKeys")
	keys := doHKDF(K_main, confirmationStr, keySize*2)
	secretInfoStr := []byte("SharedKey")
	sharedSecret = doHKDF(K_main, secretInfoStr, keySize)

	// Prover confirmation = HMAC(keys[:32], shareV)
	macP := hmac.New(sha256.New, keys[:keySize])
	macP.Write(shareV)
	proverConfirm = macP.Sum(nil)

	// Verifier confirmation = HMAC(keys[32:], shareP)
	macV := hmac.New(sha256.New, keys[keySize:])
	macV.Write(shareP)
	verifierConfirm = macV.Sum(nil)

	return
}

func doHKDF(ikm, info []byte, size int) []byte {
	out, err := hkdf.Key(sha256.New, ikm, nil, string(info), size)
	if err != nil {
		panic(err)
	}
	return out
}

func (ctx *Context) ProcessProverShare(
	proverShare []byte,
) (verifierShare []byte, verifierConfirm []byte, sharedSecret []byte, err error) {
	if ctx.Role != RoleVerifier || ctx.state != stateInit || len(proverShare) != shareSize {
		return nil, nil, nil, errors.New("invalid state or share")
	}
	curve := ctx.curve

	// Y = y*G + w0*N
	lx, ly := curve.ScalarBaseMult(ctx.y.Bytes())
	rx, ry := curve.ScalarMult(ctx.Nx, ctx.Ny, ctx.w0.Bytes())
	Yx, Yy := curve.Add(lx, ly, rx, ry)
	ctx.Yx, ctx.Yy = Yx, Yy

	verifierShare = elliptic.Marshal(curve, Yx, Yy)
	if px, py := elliptic.Unmarshal(curve, proverShare); px == nil {
		return nil, nil, nil, errors.New("invalid prover share")
	} else {
		ctx.Xx, ctx.Xy = px, py
	}

	// T = X - w0*M
	mx, my := curve.ScalarMult(ctx.Mx, ctx.My, ctx.w0.Bytes())
	mx, my = mx, new(big.Int).Neg(my)
	my.Mod(my, curve.Params().P)

	Tx, Ty := curve.Add(ctx.Xx, ctx.Xy, mx, my)
	// Z = (y)*T
	Zx, Zy := curve.ScalarMult(Tx, Ty, ctx.y.Bytes())
	ctx.Zx, ctx.Zy = Zx, Zy
	// V = (y)*L
	Vx, Vy := curve.ScalarMult(ctx.Lx, ctx.Ly, ctx.y.Bytes())
	ctx.Vx, ctx.Vy = Vx, Vy

	proverConfirm, verifierConfirm, sharedSecret, err := computeTranscriptAndConfirmation(ctx, proverShare, verifierShare)
	if err != nil {
		return nil, nil, nil, err
	}

	ctx.confirm = proverConfirm
	ctx.state = stateKeyGenerated

	return verifierShare, verifierConfirm, sharedSecret, nil
}

// computeProverConfirmation (Prover side)
func (ctx *Context) ComputeProverConfirmation(
	verifierShare []byte,
	claimedVerifierConfirm []byte,
) (proverConfirm []byte, sharedSecret []byte, err error) {
	if ctx.Role != RoleProver || ctx.state != stateShareGenerated || len(verifierShare) != shareSize || len(claimedVerifierConfirm) != confirmSize {
		return nil, nil, errors.New("invalid state or input")
	}
	curve := ctx.curve
	vx, vy := elliptic.Unmarshal(curve, verifierShare)
	if vx == nil {
		return nil, nil, errors.New("invalid verifier share")
	}
	ctx.Yx, ctx.Yy = vx, vy

	// T = Y - w0*N
	nx, ny := curve.ScalarMult(ctx.Nx, ctx.Ny, ctx.w0.Bytes())
	ny.Neg(ny)
	ny.Mod(ny, curve.Params().P)

	Tx, Ty := curve.Add(ctx.Yx, ctx.Yy, nx, ny)

	// Z = x*T
	Zx, Zy := curve.ScalarMult(Tx, Ty, ctx.x.Bytes())
	ctx.Zx, ctx.Zy = Zx, Zy

	// V = w1*T
	Vx, Vy := curve.ScalarMult(Tx, Ty, ctx.w1.Bytes())
	ctx.Vx, ctx.Vy = Vx, Vy

	// Compute transcript
	proverConfirm, verifierConfirm, sharedSecret, err := computeTranscriptAndConfirmation(ctx, ctx.share, verifierShare)
	if err != nil {
		return nil, nil, err
	}

	// Check verifier confirm
	if !hmac.Equal(verifierConfirm, claimedVerifierConfirm) {
		return nil, nil, errors.New("verifier confirmation mismatch")
	}

	ctx.state = stateKeyGenerated

	return proverConfirm, sharedSecret, nil
}

// VerifyProverConfirmation (Verifier side)
func (ctx *Context) VerifyProverConfirmation(proverConfirm []byte) error {
	if ctx.Role != RoleVerifier || ctx.state != stateKeyGenerated || len(proverConfirm) != confirmSize {
		return errors.New("invalid state or input")
	}
	if !hmac.Equal(ctx.confirm, proverConfirm) {
		return errors.New("prover confirmation mismatch")
	}
	return nil
}
