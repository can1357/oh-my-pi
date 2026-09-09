.text

.p2align 2
.globl _apple_fm_value_get
_apple_fm_value_get:
	mov x8, x0
	br x1

.p2align 2
.globl _apple_fm_availability_get
_apple_fm_availability_get:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x8, x0
	mov x20, x1
	blr x2
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_model_init
_apple_fm_model_init:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x20, x2
	blr x3
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_session_init
_apple_fm_session_init:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x20, x3
	mov x3, x2
	mov x2, x1
	mov x1, x4
	blr x5
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_options_init
_apple_fm_options_init:
	mov x8, x0
	mov x0, x1
	mov x1, x2
	mov x2, x3
	mov x3, x4
	mov x4, x5
	br x6

.p2align 2
.globl _apple_fm_stream_response
_apple_fm_stream_response:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x20, x1
	mov x8, x0
	mov x0, x2
	mov x1, x3
	mov x2, x4
	blr x5
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_make_iterator
_apple_fm_make_iterator:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x8, x0
	mov x0, x2
	mov x20, x1
	blr x3
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_snapshot_content
_apple_fm_snapshot_content:
	stp x20, x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	add x29, sp, #16
	mov x20, x0
	mov x8, x2
	mov x0, x1
	blr x3
	ldp x29, x30, [sp, #16]
	ldp x20, x19, [sp], #32
	ret

.p2align 2
.globl _apple_fm_task_create
_apple_fm_task_create:
	mov x6, x3
	mov x4, x2
	mov x2, x1
	adrp x3, _apple_fm_task_entry@PAGE
	add x3, x3, _apple_fm_task_entry@PAGEOFF
	mov x1, #0
	mov w5, #48
	br x6

.p2align 2
_apple_fm_task_entry:
	orr x29, x29, #0x1000000000000000
	sub sp, sp, #32
	stp x29, x30, [sp, #16]
	str x22, [sp, #8]
	add x29, sp, #16
	ldp x8, x9, [x20, #32]
	ldr w0, [x8, #4]
	blr x9
	mov x8, x0
	adrp x9, _apple_fm_next_continuation@PAGE
	add x9, x9, _apple_fm_next_continuation@PAGEOFF
	stp x22, x9, [x0]
	str x20, [x22, #32]
	ldp x0, x4, [x20, #16]
	ldp x20, x3, [x20]
	mov x1, #0
	mov x2, #0
	mov x22, x8
	ldp x29, x30, [sp, #16]
	and x29, x29, #0xefffffffffffffff
	add sp, sp, #32
	br x4

.p2align 2
_apple_fm_next_continuation:
	orr x29, x29, #0x1000000000000000
	str x19, [sp, #-32]!
	stp x29, x30, [sp, #16]
	str x22, [sp, #8]
	add x29, sp, #16
	mov x0, x22
	ldr x22, [x22]
	ldr x19, [x22, #32]
	ldr x8, [x19, #48]
	blr x8
	mov x0, x19
	mov x1, x20
	bl _apple_fm_next_completed
	ldr x0, [x22, #8]
	ldp x29, x30, [sp, #16]
	ldr x19, [sp], #32
	and x29, x29, #0xefffffffffffffff
	br x0
