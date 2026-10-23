/** One AudioContext for the page (bell, modem speaker), resumed on use. */
let ctx: AudioContext | undefined;

export function audioContext(): AudioContext | undefined {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return undefined; // no Web Audio
  }
}
