;	TERM - a dumb terminal for the A-Prompt telnet modem.
;	A-Prompt sample program. Assemble with ASM TERM, then LOAD TERM.
;	The modem is a UART on two I/O ports:
;	  IN 04H status (bit 0 byte ready, bit 7 carrier), OUT 04H bit 0 = DTR
;	  IN/OUT 05H data
;	Type AT commands to the modem: ATI lists the phone book, ATDT 1 or
;	ATDT host:port dials, +++ (with a pause either side) escapes, ATH hangs
;	up. Ctrl-] returns to CP/M and leaves the call up, so XMODEM or ZMODEM
;	can transfer a file; run TERM again to carry on.
;	When the BBS starts a ZMODEM transfer, TERM says which command to run.
;	Console I/O goes straight to the BIOS: BDOS 6 would take FEH and FFH,
;	which ANSI art uses, as input requests instead of characters.

BDOS	EQU	5
PSTR	EQU	9
MSTAT	EQU	04H
MDATA	EQU	05H
RXRDY	EQU	01H
DCD	EQU	80H
QUIT	EQU	1DH		; Ctrl-]
CR	EQU	13
LF	EQU	10

	ORG	100H

START:	LHLD	1		; BIOS WBOOT entry, CONST/CONIN/CONOUT follow
	LXI	D,3
	DAD	D
	SHLD	CONST+1
	DAD	D
	SHLD	CONIN+1
	DAD	D
	SHLD	CONOUT+1

	MVI	A,1		; raise DTR
	OUT	MSTAT
	LXI	D,SHELLO
	MVI	C,PSTR
	CALL	BDOS
	IN	MSTAT		; back to a call already up?
	ANI	DCD
	JZ	LOOP
	LXI	D,SONLIN
	MVI	C,PSTR
	CALL	BDOS

LOOP:	IN	MSTAT		; modem byte waiting?
	ANI	RXRDY
	JZ	KEY
	IN	MDATA
	PUSH	PSW
	CALL	ZDET
	POP	PSW
	MOV	C,A
	CALL	CONOUT
	JMP	LOOP

KEY:	CALL	CONST		; key waiting?
	ORA	A
	JZ	LOOP
	CALL	CONIN
	CPI	QUIT
	JZ	EXIT
	OUT	MDATA
	JMP	LOOP

EXIT:	LXI	D,SBYE		; the call stays up
	MVI	C,PSTR
	CALL	BDOS
	JMP	0

; ZDET: watches the received bytes for a ZMODEM header, ** ZDLE B 0,
; then 0 (ZRQINIT: the BBS sends) or 1 (ZRINIT: the BBS receives).
ZDET:	MOV	B,A
	LDA	ZIDX
	CPI	5
	JZ	ZKIND
	MOV	E,A
	MVI	D,0
	LXI	H,ZPAT
	DAD	D
	MOV	A,B
	CMP	M
	JNZ	ZMISS
	LDA	ZIDX
	INR	A
	STA	ZIDX
	RET
ZMISS:	XRA	A		; a '*' may start a new match
	MOV	C,A
	MOV	A,B
	CPI	'*'
	JNZ	ZSET
	INR	C
ZSET:	MOV	A,C
	STA	ZIDX
	RET
ZKIND:	XRA	A
	STA	ZIDX
	MOV	A,B
	LXI	D,SZDOWN
	CPI	'0'
	JZ	ZSAY
	LXI	D,SZUP
	CPI	'1'
	RNZ
ZSAY:	LDA	ZSEEN		; say it once per session
	ORA	A
	RNZ
	INR	A
	STA	ZSEEN
	MVI	C,PSTR
	JMP	BDOS

CONST:	JMP	0		; patched at start-up
CONIN:	JMP	0
CONOUT:	JMP	0

ZPAT:	DB	'**',18H,'B0'
ZIDX:	DB	0
ZSEEN:	DB	0

SHELLO:	DB	CR,LF,'A-Prompt TERM - telnet modem on ports 04H/05H',CR,LF
	DB	'ATI lists the phone book, ATDT 1 or ATDT host:port dials.',CR,LF
	DB	'Ctrl-] returns to CP/M, the call stays up.',CR,LF
	DB	'+++ then ATH hangs up.',CR,LF,'$'
SONLIN:	DB	'Still connected.',CR,LF,'$'
SBYE:	DB	CR,LF,'TERM done. The call stays up: run TERM to go back.'
	DB	CR,LF,'$'
SZDOWN:	DB	CR,LF,'[TERM: ZMODEM download - press Ctrl-] then ZMODEM R]'
	DB	CR,LF,'$'
SZUP:	DB	CR,LF,'[TERM: ZMODEM upload - press Ctrl-] then ZMODEM S file]'
	DB	CR,LF,'$'

	END	START
