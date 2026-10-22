/**
 * Telnet BBSes the modem may dial through the Worker relay (worker/index.ts),
 * which refuses every other host, so the public demo is not an open TCP
 * proxy. To add a board, add it here: the modem's ATI listing and the relay
 * both read this.
 *
 * `ws` is the board's own WebSocket gateway (Synchronet's websocket service,
 * ENiGMA's WebSocket server), which the browser dials directly, without the
 * relay; the relay remains the fallback. ATDT wss://… reaches any such
 * gateway, listed or not.
 */
export interface BbsEntry {
  host: string;
  port: number;
  name: string;
  ws?: string;
}

export const PHONE_BOOK: readonly BbsEntry[] = [
  { host: 'vert.synchro.net', port: 23, name: 'Vertrauen (Synchronet)', ws: 'wss://vert.synchro.net:11235' },
  { host: 'bbs.fozztexx.com', port: 23, name: 'Level 29' },
  { host: 'blackflag.acid.org', port: 23, name: 'Black Flag' },
  { host: 'bbs.retrocampus.com', port: 23, name: 'RetroCampus BBS' },
  { host: 'particlesbbs.dyndns.org', port: 6400, name: 'Particles! BBS' },
  { host: 'xibalba.l33t.codes', port: 44510, name: 'Xibalba', ws: 'wss://xibalba.l33t.codes:44512' },
  { host: '20forbeers.com', port: 1337, name: '20 For Beers' },
  { host: 'bbs.electronicchicken.com', port: 23, name: 'electronic chicken' },
  { host: 'telehack.com', port: 23, name: 'Telehack' },
];

export function inPhoneBook(host: string, port: number): boolean {
  const h = host.toLowerCase();
  return PHONE_BOOK.some((e) => e.host === h && e.port === port);
}
