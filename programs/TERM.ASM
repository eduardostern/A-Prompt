;	TERM - a dumb terminal for the A-Prompt telnet modem.
;	A-Prompt sample program. Assemble with ASM TERM, then LOAD TERM.
;	The modem is a UART on two I/O ports:
;	  IN 04H status (bit 0 byte ready, bit 7 carrier), OUT 04H bit 0 = DTR
;	  IN/OUT 05H data
;	Type AT commands to the modem: ATI lists the phone book, ATDT 1 or
;	ATDT host:port dials, +++ (with a pause either side) escapes, ATH hangs
;	up. Ctrl-] leaves TERM and hangs up.
;	Console I/O goes straight to the BIOS: BDOS 6 would take FEH and FFH,
;	which ANSI art uses, as input requests instead of characters.

BDOS	EQU	5
PSTR	EQU	9
MSTAT	EQU	04H
MDATA	EQU	05H
RXRDY	EQU	01H
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

LOOP:	IN	MSTAT		; modem byte waiting?
	ANI	RXRDY
	JZ	KEY
	IN	MDATA
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

EXIT:	XRA	A		; drop DTR: the modem hangs up
	OUT	MSTAT
	LXI	D,SBYE
	MVI	C,PSTR
	CALL	BDOS
	JMP	0

CONST:	JMP	0		; patched at start-up
CONIN:	JMP	0
CONOUT:	JMP	0

SHELLO:	DB	CR,LF,'A-Prompt TERM - telnet modem on ports 04H/05H',CR,LF
	DB	'ATI lists the phone book, ATDT 1 or ATDT host:port dials.',CR,LF
	DB	'Ctrl-] quits and hangs up.',CR,LF,'$'
SBYE:	DB	CR,LF,'TERM done.',CR,LF,'$'

	END	START
