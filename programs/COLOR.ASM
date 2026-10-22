;	COLOR - shows the ANSI colour palette of the terminal.
;	A-Prompt sample program. Assemble with ASM COLOR, then LOAD COLOR.
;	Needs the ANSI/VT100 terminal profile; ADM-3A and VT52 are monochrome.

BDOS	EQU	5
CONOUT	EQU	2
PSTR	EQU	9
ESC	EQU	1BH
CR	EQU	13
LF	EQU	10
SEMI	EQU	3BH

	ORG	100H

START:	LXI	D,STITLE
	CALL	PRINT

	LXI	D,SFG		; 16 foreground colours
	CALL	PRINT
	MVI	A,30
	CALL	ROW
	LXI	D,SBRI
	CALL	PRINT
	MVI	A,90
	CALL	ROW

	LXI	D,SBG		; 16 background colours
	CALL	PRINT
	MVI	A,40
	CALL	ROW
	LXI	D,SBRI
	CALL	PRINT
	MVI	A,100
	CALL	ROW

	LXI	D,SATTR		; attributes
	CALL	PRINT

	LXI	D,S256		; 256-colour cube, first 36 entries
	CALL	PRINT
	MVI	A,16
CUBE:	PUSH	PSW
	LXI	D,S485
	CALL	PRINT
	POP	PSW
	PUSH	PSW
	CALL	PDEC
	LXI	D,SMSP
	CALL	PRINT
	POP	PSW
	INR	A
	CPI	52
	JNZ	CUBE
	LXI	D,SRESET
	CALL	PRINT

	LXI	D,SGRAY		; 256-colour greys 232..255
	CALL	PRINT
	MVI	A,232
GRAY:	PUSH	PSW
	LXI	D,S485
	CALL	PRINT
	POP	PSW
	PUSH	PSW
	CALL	PDEC
	LXI	D,SMSP
	CALL	PRINT
	POP	PSW
	INR	A
	JNZ	GRAY
	LXI	D,SRESET
	CALL	PRINT

	LXI	D,STRUE		; 24-bit colour gradient
	CALL	PRINT
	MVI	B,0
TRUE:	LXI	D,S482
	CALL	PRINT
	CALL	TIMES7		; red = 7*i
	CALL	PDEC
	MVI	E,SEMI
	CALL	PCHAR
	CALL	TIMES7		; green = 255 - 7*i
	CMA
	CALL	PDEC
	MVI	E,SEMI
	CALL	PCHAR
	MVI	A,120		; blue
	CALL	PDEC
	LXI	D,SMSP
	CALL	PRINT
	INR	B
	MOV	A,B
	CPI	36
	JNZ	TRUE
	LXI	D,SRESET
	CALL	PRINT

	LXI	D,SEND
	CALL	PRINT
	RET			; back to the CCP

; A = 7 * B
TIMES7:	MOV	A,B
	ADD	A
	ADD	A
	ADD	B
	ADD	B
	ADD	B
	RET

; ROW: print eight SGR codes starting at A, each in its own colour.
ROW:	MOV	H,A
	MVI	L,8
ROWLP:	MOV	A,H
	CALL	SGR
	MVI	E,' '
	CALL	PCHAR
	MOV	A,H
	CALL	PDEC
	MVI	E,' '
	CALL	PCHAR
	XRA	A
	CALL	SGR
	INR	H
	DCR	L
	JNZ	ROWLP
	LXI	D,CRLF
	CALL	PRINT
	RET

; SGR: print ESC [ A m.  Preserves BC, DE, HL.
SGR:	PUSH	D
	PUSH	PSW
	MVI	E,ESC
	CALL	PCHAR
	MVI	E,'['
	CALL	PCHAR
	POP	PSW
	CALL	PDEC
	MVI	E,'m'
	CALL	PCHAR
	POP	D
	RET

; PDEC: print A in decimal without leading zeros.  Preserves BC, DE, HL.
PDEC:	PUSH	B
	PUSH	D
	MVI	B,0		; set once a digit has been printed
	MVI	C,100
	CALL	DIGIT
	MVI	C,10
	CALL	DIGIT
	ADI	'0'
	MOV	E,A
	CALL	PCHAR
	POP	D
	POP	B
	RET

DIGIT:	MVI	D,0
DLOOP:	CMP	C
	JC	DDONE
	SUB	C
	INR	D
	JMP	DLOOP
DDONE:	PUSH	PSW		; remainder
	MOV	A,D
	ORA	B
	JZ	DSKIP
	MVI	B,1
	MOV	A,D
	ADI	'0'
	MOV	E,A
	CALL	PCHAR
DSKIP:	POP	PSW
	RET

; PCHAR: write E to the console.  Preserves BC, DE, HL.
PCHAR:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,CONOUT
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

; PRINT: write the $-terminated string at DE.  Preserves BC, DE, HL.
PRINT:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,PSTR
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

STITLE:	DB	CR,LF,'A-Prompt ANSI colour test',CR,LF
	DB	'Each number is the SGR code that produced it.',CR,LF,CR,LF,'$'
SFG:	DB	'Foreground  $'
SBG:	DB	'Background  $'
SBRI:	DB	'   bright   $'
SATTR:	DB	CR,LF,'Attributes  '
	DB	ESC,'[1mbold',ESC,'[0m '
	DB	ESC,'[2mdim',ESC,'[0m '
	DB	ESC,'[3mitalic',ESC,'[0m '
	DB	ESC,'[4munderline',ESC,'[0m '
	DB	ESC,'[5mblink',ESC,'[0m '
	DB	ESC,'[7mreverse',ESC,'[0m '
	DB	ESC,'[9mstrike',ESC,'[0m',CR,LF,CR,LF,'$'
S256:	DB	'256 colours $'
SGRAY:	DB	'Greys       $'
STRUE:	DB	'24-bit      $'
S485:	DB	ESC,'[48',SEMI,'5',SEMI,'$'
S482:	DB	ESC,'[48',SEMI,'2',SEMI,'$'
SMSP:	DB	'm $'
SRESET:	DB	ESC,'[0m',CR,LF,'$'
CRLF:	DB	CR,LF,'$'
SEND:	DB	CR,LF,'Nothing coloured? Pick ANSI/VT100 in the terminal menu.'
	DB	CR,LF,'$'

	END
