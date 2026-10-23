/**
 * Puts the modem speaker on a dialer: the dial and ring sounds play while the
 * call is set up, and when the far end answers, CONNECT waits for the
 * handshake to finish, as on a real modem. Whatever the far end sends in the
 * meantime is held, not lost. A call that fails gets the busy signal.
 */
import type { DialTarget, Dialer, Link } from './cpm/modem';
import type { CallSound } from './modem-audio';

export function withCallSound(inner: Dialer, start: (target: DialTarget) => CallSound | undefined): Dialer {
  return (target, handlers) => {
    const sound = start(target);
    if (!sound) return inner(target, handlers);
    let open = false;
    let over = false;
    const held: Uint8Array[] = [];
    const link: Link = inner(target, {
      onOpen: (info) => {
        void sound.answered().then(() => {
          if (over) return;
          open = true;
          handlers.onOpen(info);
          for (const b of held) handlers.onData(b);
          held.length = 0;
        });
      },
      onData: (bytes) => {
        if (open) handlers.onData(bytes);
        else if (!over) held.push(bytes);
      },
      onClose: () => {
        if (over) return;
        over = true;
        if (open) sound.stop();
        else sound.failed();
        handlers.onClose();
      },
    });
    return {
      send: (bytes) => link.send(bytes),
      close: () => {
        // After the far end hung up, the modem closes too: let the busy signal play.
        if (!over) sound.stop();
        over = true;
        link.close();
      },
    };
  };
}
