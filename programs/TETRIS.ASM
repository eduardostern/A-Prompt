;	TETRIS for CP/M 2.2 on an 80x24 ANSI colour terminal.
;	A-Prompt sample program in 8080 assembly: ASM TETRIS, LOAD TETRIS.
;
;	Keys:  A/D or left/right arrows  move
;	       W or up arrow              rotate
;	       S or down arrow            soft drop
;	       space                      hard drop
;	       P pause                    Q quit
;
;	Ticks come from a busy loop, as in period games, but the loop is
;	re-tuned every second against the clock: BDOS 105 (CP/M 3 T_GET)
;	returns the seconds, the game counts its ticks per second and
;	rescales the loop to 16 ticks a second. So the pace is the same at
;	any clock setting, and follows a change of speed within a second
;	or two. Without the call (plain CP/M 2.2) the 4 MHz default stays.

BDOS	EQU	5
CONOUT	EQU	2
CRAWIO	EQU	6
PSTR	EQU	9
ESC	EQU	1BH
CR	EQU	13
LF	EQU	10
SEMI	EQU	3BH
HBAR	EQU	0C4H		; CP437 box drawing
VBAR	EQU	0B3H

BROWS	EQU	20		; board size in cells
BCOLS	EQU	10
BTOP	EQU	2		; screen row of board row 0
BLEFT	EQU	26		; screen column of board column 0 (2 chars per cell)
PANEL	EQU	52		; column of the side panel (text ends by column 75)
PROW	EQU	10		; first row of the next-piece preview
STATUS	EQU	23		; row for messages
TGET	EQU	105		; CP/M 3 get time: A = seconds
TPSGOAL	EQU	16		; ticks per second (62.5 ms per tick)
DELAY0	EQU	1008		; loop units per tick at 4 MHz (248 T each)

	ORG	100H

START:	LXI	SP,STACK
	CALL	RDSEC		; the first change of the seconds is the
	STA	LASTSEC		; start of the first full second counted
	LXI	D,SINIT		; clear screen, hide cursor
	CALL	PRINT
	CALL	DRAWFR
	CALL	DRAWPN
	LXI	D,SPRESS
	CALL	STATMSG
WAIT0:	CALL	WAIT		; ticking here calibrates the loop early
	CALL	RND		; stir the seed while waiting
	CALL	POLL
	ORA	A
	JZ	WAIT0
	ANI	5FH
	CPI	'Q'
	JZ	QUIT

; ---- new game ----------------------------------------------------------

NEWGAME:
	LXI	H,BOARD
	LXI	B,BROWS*BCOLS
NGCLR:	MVI	M,0
	INX	H
	DCX	B
	MOV	A,B
	ORA	C
	JNZ	NGCLR
	LXI	H,0
	SHLD	SCORE
	SHLD	LINES
	LXI	H,10
	SHLD	NEXTLV
	XRA	A
	STA	LEVEL
	STA	OVER
	CALL	SETSPD
	CALL	DRAWBD
	CALL	UPDPN
	CALL	STATCLR
	CALL	RNDPC
	STA	NEXTP
	CALL	SPAWN

; ---- main loop: one tick per DELAY -----------------------------------

MAIN:	CALL	WAIT
	CALL	RND
KEYS:	CALL	POLL
	ORA	A
	JZ	NOKEY
	CALL	HANDLE
	LDA	OVER
	ORA	A
	JNZ	GAMEOV
	JMP	KEYS
NOKEY:	LDA	TICK
	INR	A
	STA	TICK
	MOV	B,A
	LDA	SPEED
	CMP	B		; SPEED <= TICK: time to fall
	JC	FALL
	JZ	FALL
	JMP	MAIN

FALL:	XRA	A
	STA	TICK
	CALL	ERASE
	LDA	PY
	INR	A
	STA	PY
	CALL	FITS
	JZ	FALLOK
	LDA	PY
	DCR	A
	STA	PY
	CALL	DRAW
	CALL	LANDED
	LDA	OVER
	ORA	A
	JNZ	GAMEOV
	JMP	MAIN
FALLOK:	CALL	DRAW
	JMP	MAIN

GAMEOV:	LXI	D,SOVER
	CALL	STATMSG
WAITOV:	CALL	WAIT
	CALL	RND
	CALL	POLL
	ORA	A
	JZ	WAITOV
	ANI	5FH
	CPI	'Q'
	JZ	QUIT
	JMP	NEWGAME

QUIT:	LXI	D,SBYE
	CALL	PRINT
	JMP	0		; warm boot

; ---- keyboard -----------------------------------------------------------

; HANDLE: A = key
HANDLE:	CPI	ESC
	JZ	KESC
	CPI	' '
	JZ	KDROP
	ANI	5FH		; letters to upper case
	CPI	'A'
	JZ	KLEFT
	CPI	'J'
	JZ	KLEFT
	CPI	'D'
	JZ	KRIGHT
	CPI	'L'
	JZ	KRIGHT
	CPI	'W'
	JZ	KROT
	CPI	'K'
	JZ	KROT
	CPI	'I'
	JZ	KROT
	CPI	'S'
	JZ	KDOWN
	CPI	'P'
	JZ	KPAUSE
	CPI	'Q'
	JZ	QUIT
	RET

KESC:	CALL	POLL		; ESC [ A/B/C/D from the arrow keys
	CPI	'['
	RNZ
	CALL	POLL
	CPI	'A'
	JZ	KROT
	CPI	'B'
	JZ	KDOWN
	CPI	'C'
	JZ	KRIGHT
	CPI	'D'
	JZ	KLEFT
	RET

KLEFT:	CALL	ERASE
	LDA	PX
	DCR	A
	STA	PX
	CALL	FITS
	JZ	DRAW
	LDA	PX
	INR	A
	STA	PX
	JMP	DRAW

KRIGHT:	CALL	ERASE
	LDA	PX
	INR	A
	STA	PX
	CALL	FITS
	JZ	DRAW
	LDA	PX
	DCR	A
	STA	PX
	JMP	DRAW

KROT:	CALL	ERASE
	LDA	PR
	STA	OLDPR
	INR	A
	ANI	3
	STA	PR
	CALL	FITS
	JZ	DRAW
	LDA	PX		; wall kick: try one left, then one right
	DCR	A
	STA	PX
	CALL	FITS
	JZ	DRAW
	LDA	PX
	INR	A
	INR	A
	STA	PX
	CALL	FITS
	JZ	DRAW
	LDA	PX
	DCR	A
	STA	PX
	LDA	OLDPR
	STA	PR
	JMP	DRAW

KDOWN:	CALL	ERASE
	LDA	PY
	INR	A
	STA	PY
	CALL	FITS
	JNZ	KDLAND
	LHLD	SCORE
	INX	H
	SHLD	SCORE
	XRA	A
	STA	TICK
	JMP	DRAW
KDLAND:	LDA	PY
	DCR	A
	STA	PY
	CALL	DRAW
	JMP	LANDED

KDROP:	CALL	ERASE
KDRLP:	LDA	PY
	INR	A
	STA	PY
	CALL	FITS
	JNZ	KDREND
	LHLD	SCORE
	INX	H
	INX	H
	SHLD	SCORE
	JMP	KDRLP
KDREND:	LDA	PY
	DCR	A
	STA	PY
	CALL	DRAW
	JMP	LANDED

KPAUSE:	LXI	D,SPAUSE
	CALL	STATMSG
KPWAIT:	CALL	WAIT
	CALL	RND
	CALL	POLL
	ORA	A
	JZ	KPWAIT
	JMP	STATCLR

; ---- piece landed: lock, clear lines, score, spawn ----------------------

LANDED:	CALL	LOCK
	CALL	CLEARL
	LDA	CLEARED
	ORA	A
	JZ	LDSPAWN
	CALL	ADDSC
	CALL	DRAWBD
LDSPAWN:
	CALL	UPDPN
	JMP	SPAWN

SPAWN:	LDA	NEXTP
	STA	PT
	CALL	RNDPC
	STA	NEXTP
	XRA	A
	STA	PR
	STA	PY
	STA	TICK
	MVI	A,3
	STA	PX
	CALL	DRAWNX
	CALL	FITS
	JZ	DRAW
	MVI	A,1
	STA	OVER
	RET

; ADDSC: score CLEARED lines at the current level, update lines and level.
ADDSC:	LDA	CLEARED
	ADD	A
	MOV	E,A
	MVI	D,0
	LXI	H,SCTAB
	DAD	D
	MOV	E,M
	INX	H
	MOV	D,M		; DE = points for this many lines
	LDA	LEVEL
	INR	A
	MOV	B,A
	LHLD	SCORE
ASLP:	DAD	D		; times level+1
	DCR	B
	JNZ	ASLP
	SHLD	SCORE
	LDA	CLEARED
	MOV	E,A
	MVI	D,0
	LHLD	LINES
	DAD	D
	SHLD	LINES
LVCHK:	LDA	LEVEL
	CPI	9
	JNC	SETSPD
	LHLD	LINES
	XCHG			; DE = lines
	LHLD	NEXTLV
	MOV	A,E
	SUB	L
	MOV	A,D
	SBB	H
	JC	SETSPD		; lines < next level threshold
	LDA	LEVEL
	INR	A
	STA	LEVEL
	LXI	D,10
	DAD	D
	SHLD	NEXTLV
	JMP	LVCHK

SETSPD:	LDA	LEVEL
	MOV	E,A
	MVI	D,0
	LXI	H,SPDTAB
	DAD	D
	MOV	A,M
	STA	SPEED
	RET

; ---- board ----------------------------------------------------------------

; PIECEP: HL -> the 4 (dx,dy) pairs of piece PT in rotation PR.
PIECEP:	LDA	PT
	ADD	A
	ADD	A
	MOV	B,A
	LDA	PR
	ADD	B
	ADD	A
	ADD	A
	ADD	A
	MOV	E,A
	MVI	D,0
	LXI	H,PIECES
	DAD	D
	RET

; BOARDAT: A = row, E = column -> HL = address of that cell.
BOARDAT:
	PUSH	B
	PUSH	D
	MOV	C,E
	MOV	L,A
	MVI	H,0
	DAD	H		; 2y
	MOV	D,H
	MOV	E,L
	DAD	H		; 4y
	DAD	H		; 8y
	DAD	D		; 10y
	MOV	E,C
	MVI	D,0
	DAD	D		; + x
	LXI	D,BOARD
	DAD	D
	POP	D
	POP	B
	RET

; FITS: Z set (A = 0) when the piece at PX,PY,PR is inside the board
; and over empty cells.
FITS:	CALL	PIECEP
	MVI	C,4
FITLP:	LDA	PX
	ADD	M		; x; negative values wrap above BCOLS
	CPI	BCOLS
	JNC	NOFIT
	MOV	E,A
	INX	H
	LDA	PY
	ADD	M		; y
	CPI	BROWS
	JNC	NOFIT
	INX	H
	PUSH	H
	CALL	BOARDAT
	MOV	A,M
	POP	H
	ORA	A
	JNZ	NOFIT
	DCR	C
	JNZ	FITLP
	XRA	A
	RET
NOFIT:	MVI	A,1
	ORA	A
	RET

; LOCK: copy the piece into the board.
LOCK:	CALL	PIECEP
	MVI	C,4
LKLP:	LDA	PX
	ADD	M
	MOV	E,A
	INX	H
	LDA	PY
	ADD	M
	INX	H
	PUSH	H
	CALL	BOARDAT
	LDA	PT
	INR	A
	MOV	M,A
	POP	H
	DCR	C
	JNZ	LKLP
	RET

; CLEARL: remove full rows, counting them in CLEARED.
CLEARL:	XRA	A
	STA	CLEARED
	MVI	A,BROWS-1
CLLP:	STA	CURROW
	MVI	E,0
	CALL	BOARDAT
	MVI	C,BCOLS
CLCHK:	MOV	A,M
	ORA	A
	JZ	CLNEXT
	INX	H
	DCR	C
	JNZ	CLCHK
	CALL	SHIFT		; row CURROW is full
	LDA	CLEARED
	INR	A
	STA	CLEARED
	LDA	CURROW		; look at the same row again
	JMP	CLLP
CLNEXT:	LDA	CURROW
	DCR	A
	JM	CLDONE
	JMP	CLLP
CLDONE:	RET

; SHIFT: move rows 0..CURROW-1 down one row, then clear row 0.
SHIFT:	LDA	CURROW
	MOV	B,A
	ORA	A
	JZ	SHCLR
	MVI	E,0
	CALL	BOARDAT		; HL = destination row
SHROW:	PUSH	B
	MOV	D,H
	MOV	E,L
	LXI	B,0FFF6H	; -10: the row above is the source
	DAD	B
	PUSH	H
	MVI	C,BCOLS
SHBYTE:	MOV	A,M
	STAX	D
	INX	H
	INX	D
	DCR	C
	JNZ	SHBYTE
	POP	H
	POP	B
	DCR	B
	JNZ	SHROW
SHCLR:	LXI	H,BOARD
	MVI	C,BCOLS
	XRA	A
SHZ:	MOV	M,A
	INX	H
	DCR	C
	JNZ	SHZ
	RET

; ---- drawing ---------------------------------------------------------------

DRAW:	LDA	PT		; draw the current piece in its colour
	INR	A
	JMP	DRAWPC
ERASE:	XRA	A		; draw it as empty cells

; DRAWPC: draw the current piece with cell value A (0 = empty).
DRAWPC:	STA	TMPC
	CALL	PIECEP
	MVI	C,4
DPLP:	LDA	PX
	ADD	M
	ADD	A		; 2 columns per cell
	ADI	BLEFT
	MOV	E,A
	INX	H
	LDA	PY
	ADD	M
	ADI	BTOP
	MOV	D,A
	INX	H
	PUSH	H
	XCHG
	CALL	GOTOXY
	LDA	TMPC
	CALL	CELL
	POP	H
	DCR	C
	JNZ	DPLP
	RET

; DRAWBD: redraw every board cell.
DRAWBD:	LXI	H,BOARD
	MVI	D,0
DBROW:	PUSH	H
	MOV	A,D
	ADI	BTOP
	MOV	H,A
	MVI	L,BLEFT
	CALL	GOTOXY
	POP	H
	MVI	C,BCOLS
DBCELL:	MOV	A,M
	CALL	CELL
	INX	H
	DCR	C
	JNZ	DBCELL
	INR	D
	MOV	A,D
	CPI	BROWS
	JNZ	DBROW
	RET

; DRAWNX: show the next piece in the panel.
DRAWNX:	MVI	B,4
	MVI	H,PROW
DNCLR:	MVI	L,PANEL
	CALL	GOTOXY
	LXI	D,SBLANK
	CALL	PRINT
	INR	H
	DCR	B
	JNZ	DNCLR
	LDA	NEXTP
	ADD	A
	ADD	A
	ADD	A
	ADD	A
	ADD	A		; 32 bytes per piece, rotation 0
	MOV	E,A
	MVI	D,0
	LXI	H,PIECES
	DAD	D
	MVI	C,4
DNLP:	MOV	A,M
	ADD	A
	ADI	PANEL
	MOV	E,A
	INX	H
	MOV	A,M
	ADI	PROW
	MOV	D,A
	INX	H
	PUSH	H
	XCHG
	CALL	GOTOXY
	LDA	NEXTP
	INR	A
	CALL	CELL
	POP	H
	DCR	C
	JNZ	DNLP
	RET

; CELL: print one cell (two characters) for board value A.
CELL:	PUSH	B
	PUSH	D
	PUSH	H
	ORA	A
	JZ	CELL0
	MOV	E,A
	MVI	D,0
	LXI	H,COLORS-1
	DAD	D
	MOV	A,M
	CALL	SGR
	LXI	D,SCELL
	CALL	PRINT
	XRA	A
	CALL	SGR
	JMP	CELLX
CELL0:	XRA	A
	CALL	SGR
	LXI	D,SCELL
	CALL	PRINT
CELLX:	POP	H
	POP	D
	POP	B
	RET

; DRAWFR: the board frame, in green with CP437 box-drawing characters
; (the terminal maps them like the banner's).
DRAWFR:	MVI	A,32
	CALL	SGR
	LXI	H,100H+BLEFT-1	; row 1, column BLEFT-1
	CALL	GOTOXY
	LXI	D,STOP
	CALL	PRINT
	MVI	H,BTOP
DFSIDE:	MVI	L,BLEFT-1
	CALL	GOTOXY
	MVI	E,VBAR
	CALL	PCHAR
	MVI	L,BLEFT+2*BCOLS
	CALL	GOTOXY
	MVI	E,VBAR
	CALL	PCHAR
	INR	H
	MOV	A,H
	CPI	BTOP+BROWS
	JNZ	DFSIDE
	MVI	L,BLEFT-1
	CALL	GOTOXY
	LXI	D,SBOTTOM
	CALL	PRINT
	XRA	A
	JMP	SGR

; DRAWPN: the side panel labels.
DRAWPN:	LXI	H,PANELTX
DPNLP:	MOV	A,M		; row, 0 ends the table
	ORA	A
	RZ
	PUSH	H
	MOV	H,A
	MVI	L,PANEL
	CALL	GOTOXY
	POP	H
	INX	H
	XCHG
	CALL	PRINT
	XCHG
DPNSKP:	MOV	A,M		; skip the string
	INX	H
	CPI	'$'
	JNZ	DPNSKP
	JMP	DPNLP

; UPDPN: score, lines and level.
UPDPN:	LXI	H,400H+PANEL+7
	CALL	GOTOXY
	LHLD	SCORE
	CALL	PDEC5
	LXI	H,500H+PANEL+7
	CALL	GOTOXY
	LHLD	LINES
	CALL	PDEC5
	LXI	H,600H+PANEL+7
	CALL	GOTOXY
	LDA	LEVEL
	INR	A
	JMP	PDEC

; STATMSG: show the string at DE on the status line.  STATCLR clears it.
STATMSG:
	PUSH	D
	CALL	STATCLR
	POP	D
	JMP	PRINT
STATCLR:
	LXI	H,STATUS*256+1
	CALL	GOTOXY
	LXI	D,SEOL
	JMP	PRINT

; ---- console --------------------------------------------------------------

; GOTOXY: cursor to row H, column L.  Preserves all registers.
GOTOXY:	PUSH	D
	MVI	E,ESC
	CALL	PCHAR
	MVI	E,'['
	CALL	PCHAR
	MOV	A,H
	CALL	PDEC
	MVI	E,SEMI
	CALL	PCHAR
	MOV	A,L
	CALL	PDEC
	MVI	E,'H'
	CALL	PCHAR
	POP	D
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
	MVI	B,0
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
DDONE:	PUSH	PSW
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

; PDEC5: print HL as five decimal digits.  Preserves BC, DE, HL.
PDEC5:	PUSH	B
	PUSH	D
	PUSH	H
	LXI	D,10000
	CALL	DIG16
	LXI	D,1000
	CALL	DIG16
	LXI	D,100
	CALL	DIG16
	LXI	D,10
	CALL	DIG16
	MOV	A,L
	ADI	'0'
	MOV	E,A
	CALL	PCHAR
	POP	H
	POP	D
	POP	B
	RET

DIG16:	MVI	C,0
D16LP:	MOV	A,L
	SUB	E
	MOV	B,A
	MOV	A,H
	SBB	D
	JC	D16END
	MOV	H,A
	MOV	L,B
	INR	C
	JMP	D16LP
D16END:	PUSH	D
	MOV	A,C
	ADI	'0'
	MOV	E,A
	CALL	PCHAR
	POP	D
	RET

; POLL: A = waiting key, or 0.  Preserves BC, DE, HL.
POLL:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,CRAWIO
	MVI	E,0FFH
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

; PCHAR: write E.  PRINT: write the $-string at DE.  Both preserve BC, DE, HL.
PCHAR:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,CONOUT
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

PRINT:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,PSTR
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

; WAIT: one game tick: DELAYU units of a 248 T-state loop, then TICKCTL.
WAIT:	LHLD	DELAYU
	MOV	B,H
	MOV	C,L
WAITLP:	MVI	A,16
WAITIN:	DCR	A
	JNZ	WAITIN
	DCX	B
	MOV	A,B
	ORA	C
	JNZ	WAITLP

; TICKCTL: count ticks per clock second; at each change of the seconds
; rescale DELAYU by ticks/TPSGOAL so the next second has TPSGOAL ticks.
TICKCTL:
	LDA	TPS
	INR	A
	JZ	TCFULL		; saturate at 255
	STA	TPS
TCFULL:	CALL	RDSEC
	MOV	B,A
	LDA	LASTSEC
	CMP	B
	RZ			; still the same second
	MOV	A,B
	STA	LASTSEC
	LDA	ARMED		; the first edge only starts the count
	ORA	A
	JNZ	ADJUST
	MVI	A,1
	STA	ARMED
	XRA	A
	STA	TPS
	RET
ADJUST:	LDA	TPS
	MOV	B,A
	XRA	A
	STA	TPS
	LHLD	DELAYU
	XCHG			; DE = DELAYU
	LXI	H,0
	MVI	C,0		; C:HL = DELAYU * ticks
MULLP:	DAD	D
	JNC	MULNC
	INR	C
MULNC:	DCR	B
	JNZ	MULLP
	MVI	B,4		; divide by TPSGOAL = 16
SHRLP:	ORA	A
	MOV	A,C
	RAR
	MOV	C,A
	MOV	A,H
	RAR
	MOV	H,A
	MOV	A,L
	RAR
	MOV	L,A
	DCR	B
	JNZ	SHRLP
	MOV	A,C
	ORA	A
	JZ	ADJFIT
	LXI	H,0FFFFH	; too large for 16 bits
ADJFIT:	MOV	A,H
	ORA	L
	JNZ	ADJSET
	INX	H		; never zero
ADJSET:	SHLD	DELAYU
	RET

; RDSEC: A = seconds from the clock (CP/M 3 T_GET), 0 where there is none.
RDSEC:	PUSH	B
	PUSH	D
	PUSH	H
	MVI	C,TGET
	LXI	D,TBUF
	CALL	BDOS
	POP	H
	POP	D
	POP	B
	RET

; RND: step the 16-bit generator.  RNDPC: A = random piece 0..6.
RND:	LHLD	SEED
	MOV	D,H
	MOV	E,L
	DAD	H
	DAD	H
	DAD	D		; times 5
	LXI	D,3D09H
	DAD	D
	SHLD	SEED
	RET

RNDPC:	CALL	RND
	MOV	A,H
RMOD:	CPI	7
	RC
	SUI	7
	JMP	RMOD

; ---- data -------------------------------------------------------------------

; Pieces: 7 types x 4 rotations x 4 cells of (dx,dy) in a 4x4 box.
PIECES:	DB	0,1,1,1,2,1,3,1, 2,0,2,1,2,2,2,3	; I
	DB	0,1,1,1,2,1,3,1, 2,0,2,1,2,2,2,3
	DB	1,0,2,0,1,1,2,1, 1,0,2,0,1,1,2,1	; O
	DB	1,0,2,0,1,1,2,1, 1,0,2,0,1,1,2,1
	DB	1,0,0,1,1,1,2,1, 1,0,1,1,2,1,1,2	; T
	DB	0,1,1,1,2,1,1,2, 1,0,0,1,1,1,1,2
	DB	1,0,2,0,0,1,1,1, 1,0,1,1,2,1,2,2	; S
	DB	1,0,2,0,0,1,1,1, 1,0,1,1,2,1,2,2
	DB	0,0,1,0,1,1,2,1, 2,0,1,1,2,1,1,2	; Z
	DB	0,0,1,0,1,1,2,1, 2,0,1,1,2,1,1,2
	DB	0,0,0,1,1,1,2,1, 1,0,2,0,1,1,1,2	; J
	DB	0,1,1,1,2,1,2,2, 1,0,1,1,0,2,1,2
	DB	2,0,0,1,1,1,2,1, 1,0,1,1,1,2,2,2	; L
	DB	0,1,1,1,2,1,0,2, 0,0,1,0,1,1,1,2

; Background SGR code for board values 1..7 (I O T S Z J L).
COLORS:	DB	46,43,45,42,41,44,47

; Points for 1..4 lines (index 0 unused), times level.
SCTAB:	DW	0,40,100,300,1200

; Ticks per row for levels 1..10 (16 ticks = one second).
SPDTAB:	DB	13,11,10,8,6,5,4,3,2,2

; Side panel: row, then a $-string; 0 ends.
PANELTX:
	DB	2,ESC,'[1',SEMI,'32mT E T R I S',ESC,'[0m$'
	DB	4,'Score  00000$'
	DB	5,'Lines  00000$'
	DB	6,'Level  1$'
	DB	8,'Next$'
	DB	15,'A D or arrows  move$'
	DB	16,'W or up        rotate$'
	DB	17,'S or down      soft drop$'
	DB	18,'space          hard drop$'
	DB	19,'P pause        Q quit$'
	DB	0

SINIT:	DB	ESC,'[0m',ESC,'[2J',ESC,'[H',ESC,'[?25l$'
SBYE:	DB	ESC,'[0m',ESC,'[2J',ESC,'[H',ESC,'[?25h'
	DB	'Thanks for playing.',CR,LF,'$'
STOP:	DB	0DAH,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR
	DB	HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,0BFH,'$'
SBOTTOM: DB	0C0H,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR
	DB	HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,HBAR,0D9H,'$'
SCELL:	DB	'  $'
SBLANK:	DB	'        $'
SEOL:	DB	ESC,'[K$'
SPRESS:	DB	'Press any key to start, Q to quit.$'
SPAUSE:	DB	'Paused. Press any key.$'
SOVER:	DB	ESC,'[1mGAME OVER',ESC,'[0m  Any key starts a new game, Q quits.$'

; ---- variables ----------------------------------------------------------------

PX:	DS	1		; piece column (may go negative)
PY:	DS	1
PT:	DS	1		; piece type 0..6
PR:	DS	1		; rotation 0..3
OLDPR:	DS	1
NEXTP:	DS	1
TMPC:	DS	1
TICK:	DS	1
SPEED:	DS	1
LEVEL:	DS	1
OVER:	DS	1
CLEARED: DS	1
CURROW:	DS	1
TPS:	DB	0		; ticks counted in the current clock second
LASTSEC: DB	0
ARMED:	DB	0		; 1 once a seconds edge has been seen
DELAYU:	DW	DELAY0		; loop units per tick, re-tuned every second
TBUF:	DS	4		; T_GET date/time buffer
SCORE:	DS	2
LINES:	DS	2
NEXTLV:	DS	2
SEED:	DW	4D2BH
BOARD:	DS	BROWS*BCOLS
	DS	64
STACK	EQU	$

	END
