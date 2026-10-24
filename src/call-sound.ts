/**
 * Puts the modem speaker on a dialer. The whole call plays first: dial
 * tone, the digits, a ring, and the answer and training handshake. Only
 * then is the connection opened, the way the BBS would only have seen the
 * caller once both modems had trained. From there nothing is held: CONNECT
 * comes when the line is up, and the BBS's first bytes (its terminal
 * probes, its telnet options) are answered at once, so it detects the
 * terminal properly. A call that cannot be made gets the busy signal.
 */
import type { DialTarget, Dialer, Link } from './cpm/modem';
import type { CallSound } from './modem-audio';

export function withCallSound(inner: Dialer, start: (target: DialTarget) => CallSound | undefined): Dialer {
  return (target, handlers) => {
    const sound = start(target);
    if (!sound) return inner(target, handlers);
    let open = false;
    let over = false;
    let link: Link | undefined;
    void sound.answered().then(() => {
      if (over) return;
      link = inner(target, {
        onOpen: (info) => {
          if (over) return;
          open = true;
          handlers.onOpen(info);
        },
        onData: (bytes) => {
          if (!over) handlers.onData(bytes);
        },
        onClose: () => {
          if (over) return;
          over = true;
          if (open) sound.stop();
          else sound.failed();
          handlers.onClose();
        },
      });
    });
    return {
      send: (bytes) => link?.send(bytes),
      close: () => {
        // After the far end hung up, the modem closes too: let the busy signal play.
        if (!over) sound.stop();
        over = true;
        link?.close();
      },
    };
  };
}
