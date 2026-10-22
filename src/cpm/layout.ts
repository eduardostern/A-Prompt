/**
 * Memory map of the emulated CP/M system.
 *
 * As on a real CP/M machine, everything the system owns sits above the BDOS
 * entry advertised at 0006h, so programs may use all of 0100h..BDOS_BASE-1.
 *
 *   0100h-FBFFh  TPA
 *   FC00h        BDOS (serial bytes, entry at FC06h)
 *   FC10h-FCFFh  CCP stack
 *   FD00h-FDFFh  allocation vector (up to 2048 blocks)
 *   FE00h        BIOS jump table (17 entries)
 *   FE40h        BIOS host traps
 *   FE80h        DPH, FE90h DPB, FF00h directory buffer
 */
export const BDOS_BASE = 0xfc00;
export const BDOS_ENTRY = BDOS_BASE + 6;
export const CCP_STACK = 0xfd00;
export const BIOS_BASE = 0xfe00;
export const BIOS_ENTRIES = 17;
export const TRAP_BASE = 0xfe40;
export const DPH_ADDR = 0xfe80;
export const DPB_ADDR = 0xfe90;
export const ALV_ADDR = 0xfd00;
/** ALV holds one bit per block; 256 bytes covers up to 2048 blocks. */
export const ALV_BYTES = 0x100;
export const DIRBUF_ADDR = 0xff00;

/** Largest .COM that fits in the TPA. */
export const MAX_COM_BYTES = BDOS_BASE - 0x0100;

/**
 * I/O ports of the telnet modem (see modem.ts). Every other port reads FFh.
 *   IN  04h: status, bit 0 byte ready, bit 1 can send, bit 7 carrier
 *   OUT 04h: control, bit 0 DTR (0 hangs up)
 *   IN/OUT 05h: data
 */
export const MODEM_STATUS_PORT = 0x04;
export const MODEM_DATA_PORT = 0x05;
