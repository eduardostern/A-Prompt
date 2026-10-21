	ORG	100H
	MVI	C,9
	LXI	D,MSG
	CALL	5
	RET
MSG:	DB	'Hello from CP/M 2.2!',13,10,'$'
	END
