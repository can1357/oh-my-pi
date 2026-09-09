.intel_syntax noprefix
.text

.p2align 4, 0x90
.globl _apple_fm_value_get
_apple_fm_value_get:
	push rbp
	mov rbp, rsp
	mov rax, rdi
	pop rbp
	jmp rsi

.p2align 4, 0x90
.globl _apple_fm_availability_get
_apple_fm_availability_get:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov rax, rdi
	mov r13, rsi
	call rdx
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_model_init
_apple_fm_model_init:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov r13, rdx
	call rcx
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_session_init
_apple_fm_session_init:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov r13, rcx
	mov rcx, rdx
	mov rdx, rsi
	mov rsi, r8
	call r9
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_options_init
_apple_fm_options_init:
	push rbp
	mov rbp, rsp
	mov r10, r8
	mov rax, rdi
	mov rdi, rsi
	mov rsi, rdx
	mov edx, ecx
	mov r8d, r9d
	mov rcx, r10
	pop rbp
	jmp qword ptr [rsp + 8]

.p2align 4, 0x90
.globl _apple_fm_stream_response
_apple_fm_stream_response:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov r13, rsi
	mov rax, rdi
	mov rdi, rdx
	mov rsi, rcx
	mov rdx, r8
	call r9
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_make_iterator
_apple_fm_make_iterator:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov rax, rdi
	mov rdi, rdx
	mov r13, rsi
	call rcx
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_snapshot_content
_apple_fm_snapshot_content:
	push rbp
	mov rbp, rsp
	push r13
	push rax
	mov rax, rdx
	mov r13, rdi
	mov rdi, rsi
	call rcx
	add rsp, 8
	pop r13
	pop rbp
	ret

.p2align 4, 0x90
.globl _apple_fm_task_create
_apple_fm_task_create:
	push rbp
	mov rbp, rsp
	mov rax, rcx
	mov r10, rsi
	lea rcx, [rip + _apple_fm_task_entry]
	mov r9d, 48
	mov r8, rdx
	xor esi, esi
	mov rdx, r10
	pop rbp
	jmp rax

.p2align 4, 0x90
_apple_fm_task_entry:
	bts rbp, 60
	push rbp
	push r14
	lea rbp, [rsp + 8]
	sub rsp, 24
	mov rax, qword ptr [r13 + 32]
	mov edi, dword ptr [rax + 4]
	call qword ptr [r13 + 40]
	mov qword ptr [rax], r14
	lea rcx, [rip + _apple_fm_next_continuation]
	mov qword ptr [rax + 8], rcx
	mov qword ptr [r14 + 32], r13
	mov r9, qword ptr [r13 + 24]
	mov rdi, qword ptr [r13 + 16]
	mov r8, qword ptr [r13]
	mov rcx, qword ptr [r13 + 8]
	xor esi, esi
	xor edx, edx
	mov r14, rax
	mov r13, r8
	add rsp, 16
	add rsp, 16
	pop rbp
	btr rbp, 60
	jmp r9

.p2align 4, 0x90
_apple_fm_next_continuation:
	bts rbp, 60
	push rbp
	push r14
	lea rbp, [rsp + 8]
	sub rsp, 8
	push rbx
	sub rsp, 24
	mov rdi, r14
	mov r14, qword ptr [r14]
	mov rbx, qword ptr [r14 + 32]
	call qword ptr [rbx + 48]
	mov rdi, rbx
	mov rsi, r13
	call _apple_fm_next_completed
	mov rax, qword ptr [r14 + 8]
	add rsp, 24
	pop rbx
	add rsp, 16
	pop rbp
	btr rbp, 60
	jmp rax
