/**
 * A-Prompt Worker: serves the static site and relays the emulated modem's
 * telnet sessions. Browsers cannot open TCP sockets, so the modem opens a
 * WebSocket to /relay?host=H&port=P and this Worker connects to the BBS.
 *
 * Protocol: binary frames carry the raw byte stream both ways. The Worker
 * sends one text frame, "CONNECT", once the TCP connection is up; a failed
 * or refused call closes the WebSocket before that.
 */
import { connect } from 'cloudflare:sockets';
import { inPhoneBook } from '../src/phonebook';
import { originAllowed } from './origin';

interface Env {
  ASSETS: Fetcher;
}

const IDLE_MS = 30 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/relay') return env.ASSETS.fetch(request);

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required\n', { status: 426 });
    }
    if (!originAllowed(request.headers.get('Origin'), url.host)) {
      return new Response('Forbidden\n', { status: 403 });
    }
    const host = (url.searchParams.get('host') ?? '').toLowerCase();
    const port = Number(url.searchParams.get('port'));
    if (!inPhoneBook(host, port)) {
      return new Response('Not in the phone book\n', { status: 403 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const socket = connect({ hostname: host, port });
    const writer = socket.writable.getWriter();
    let closed = false;
    let idle: number | null = null;
    const close = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      try { server.close(code, reason); } catch { /* already closed */ }
      socket.close().catch(() => {});
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => close(1000, 'idle'), IDLE_MS);
    };

    socket.closed.catch(() => {}); // a reset is handled by the reader below
    socket.opened.then(
      () => { if (!closed) { server.send('CONNECT'); touch(); } },
      () => close(1011, 'connect failed'),
    );

    // Binary frames may arrive as Blob (newer compatibility dates) or
    // ArrayBuffer; the chain keeps the bytes in order either way.
    let pending = Promise.resolve();
    server.addEventListener('message', (event) => {
      const data = event.data as string | ArrayBuffer | Blob;
      if (closed || typeof data === 'string') return;
      pending = pending
        .then(async () => {
          const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
          if (!closed) await writer.write(bytes);
        })
        .catch(() => close(1011, 'write failed'));
      touch();
    });
    server.addEventListener('close', () => close());
    server.addEventListener('error', () => close());

    (async () => {
      const reader = socket.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          server.send(value);
          touch();
        }
      } catch { /* the remote end reset */ }
      close(1000, 'remote closed');
    })();

    return new Response(null, { status: 101, webSocket: client });
  },
};
