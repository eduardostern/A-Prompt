/**
 * Disk drives of the era: how long an access took and how it sounded. Pure
 * timing; `drive-sound.ts` makes the noise and the machine sleeps for the
 * time when "speed of the era" is on.
 */

export type DriveKind = 'floppy8' | 'floppy5' | 'hard';
export type DriveSetup = DriveKind | 'mixed';

export interface DriveProfile {
  label: string;
  /** Head step, track to track. */
  stepMs: number;
  /** Settling after a seek. */
  settleMs: number;
  /** One 128-byte record, sequential, interleave and rotation included. */
  recordMs: number;
  /** Loading the head (8") or spinning the motor up (5¼") after idling. */
  startMs: number;
  /** Idle time after which the next access pays `startMs` again. */
  idleMs: number;
}

/**
 * Shugart SA-800 class 8" drive (1977): 8 ms steps, a 35 ms head load, about
 * 3.5 KB/s for CP/M's skewed 26-sector tracks at 360 rpm.
 * A 5¼" drive of the Kaypro and IBM PC (1981): 6 ms steps, a half-second spin
 * up, about 3 KB/s.
 * An ST-506 class hard disk (1983): 3 ms buffered steps, 3600 rpm, about
 * 85 KB/s through a CP/M BIOS; it never stops spinning.
 */
export const DRIVES: Record<DriveKind, DriveProfile> = {
  floppy8: { label: '8-inch floppy', stepMs: 8, settleMs: 10, recordMs: 36, startMs: 35, idleMs: 1600 },
  floppy5: { label: '5¼-inch floppy', stepMs: 6, settleMs: 15, recordMs: 42, startMs: 500, idleMs: 2500 },
  hard: { label: 'Hard disk', stepMs: 3, settleMs: 15, recordMs: 1.5, startMs: 0, idleMs: Infinity },
};

export const SETUPS: Record<DriveSetup, string> = {
  mixed: 'Floppies A: B:, hard disk C: D:',
  floppy8: '8-inch floppies (1977)',
  floppy5: '5¼-inch floppies (1981)',
  hard: 'Hard disks (ST-506, 1983)',
};

/** The kind of drive `drive` (0 = A:) is in a setup. */
export function driveKind(setup: DriveSetup, drive: number): DriveKind {
  if (setup !== 'mixed') return setup;
  return drive < 2 ? 'floppy8' : 'hard';
}

/** Head positions and idle times, to price each access. */
export class DriveTiming {
  private heads = new Map<number, { track: number; last: number }>();

  constructor(public setup: DriveSetup = 'mixed') {}

  /**
   * What an access costs: steps from the last track, settling, start-up
   * after idling, and the records read or written. `now` is in ms.
   */
  access(drive: number, track: number, records: number, now: number): { ms: number; steps: number; started: boolean; kind: DriveKind } {
    const kind = driveKind(this.setup, drive);
    const p = DRIVES[kind];
    const head = this.heads.get(drive) ?? { track: 0, last: -Infinity };
    const steps = Math.abs(track - head.track);
    const started = now - head.last > p.idleMs;
    const ms = (started ? p.startMs : 0) + (steps ? steps * p.stepMs + p.settleMs : 0) + records * p.recordMs;
    // The head is busy until the access ends.
    this.heads.set(drive, { track, last: now + ms });
    return { ms, steps, started, kind };
  }
}
