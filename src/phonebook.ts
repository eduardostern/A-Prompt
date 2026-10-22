/**
 * Telnet BBSes the modem may dial. The Worker relay (worker/index.ts) refuses
 * every other host, so the public demo is not an open TCP proxy. To add a
 * board, add it here: the modem's ATI listing and the relay both read this.
 */
export interface BbsEntry {
  host: string;
  port: number;
  name: string;
}

export const PHONE_BOOK: readonly BbsEntry[] = [
  { host: 'vert.synchro.net', port: 23, name: 'Vertrauen (Synchronet)' },
  { host: 'bbs.fozztexx.com', port: 23, name: 'Level 29' },
  { host: 'blackflag.acid.org', port: 23, name: 'Black Flag' },
  { host: 'bbs.retrocampus.com', port: 23, name: 'RetroCampus BBS' },
  { host: 'particlesbbs.dyndns.org', port: 6400, name: 'Particles! BBS' },
  { host: 'xibalba.l33t.codes', port: 44510, name: 'Xibalba' },
  { host: '20forbeers.com', port: 1337, name: '20 For Beers' },
  { host: 'bbs.electronicchicken.com', port: 23, name: 'electronic chicken' },
  { host: 'telehack.com', port: 23, name: 'Telehack' },
];

export function inPhoneBook(host: string, port: number): boolean {
  const h = host.toLowerCase();
  return PHONE_BOOK.some((e) => e.host === h && e.port === port);
}
