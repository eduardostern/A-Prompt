import { describe, expect, it } from 'vitest';
import { DRIVES, DriveTiming, driveKind } from '../src/drives';

describe('drives of the era', () => {
  it('a mixed setup has floppies on A: and B:, hard disks on C: and D:', () => {
    expect([0, 1, 2, 3].map((d) => driveKind('mixed', d))).toEqual(['floppy8', 'floppy8', 'hard', 'hard']);
    expect(driveKind('floppy5', 3)).toBe('floppy5');
  });

  it('prices a seek, the head load and the records on an 8-inch floppy', () => {
    const t = new DriveTiming('floppy8');
    const p = DRIVES.floppy8;
    const first = t.access(0, 10, 1, 0);
    expect(first.started).toBe(true);
    expect(first.steps).toBe(10);
    expect(first.ms).toBe(p.startMs + 10 * p.stepMs + p.settleMs + p.recordMs);
    // Same track straight after: just the record.
    const next = t.access(0, 10, 1, first.ms);
    expect(next).toMatchObject({ steps: 0, started: false, ms: p.recordMs });
    // After idling the head loads again.
    expect(t.access(0, 10, 1, 10_000).started).toBe(true);
  });

  it('each drive has its own head', () => {
    const t = new DriveTiming('floppy8');
    t.access(0, 40, 1, 0);
    expect(t.access(1, 0, 1, 0).steps).toBe(0);
    expect(t.access(0, 0, 1, 1000).steps).toBe(40);
  });

  it('a hard disk is much faster and never has to spin up again', () => {
    const t = new DriveTiming('hard');
    const a = t.access(2, 5, 26, 0);
    const f = new DriveTiming('floppy5').access(0, 5, 26, 0);
    expect(a.ms * 10).toBeLessThan(f.ms);
    expect(t.access(2, 5, 1, 1e9).started).toBe(false);
  });
});
