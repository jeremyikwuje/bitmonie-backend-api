import { NameMatchService } from '@/common/name-match/name-match.service';

describe('NameMatchService', () => {
  const svc = new NameMatchService();

  // ── exact / normalisation ──────────────────────────────────────

  it('returns 1.0 for identical names', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Jeremiah Succeed Ikwuje')).toBeCloseTo(1.0);
  });

  it('is case-insensitive', () => {
    expect(svc.compare('JOHN DOE', 'john doe')).toBeCloseTo(1.0);
  });

  // ── ordering tolerance ─────────────────────────────────────────

  it('matches surname-first ordering (Ikwuje Succeed vs Succeed Ikwuje)', () => {
    expect(svc.compare('Succeed Ikwuje', 'Ikwuje Succeed')).toBeCloseTo(1.0);
  });

  it('matches completely reversed 3-token name', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Ikwuje Succeed Jeremiah')).toBeCloseTo(1.0);
  });

  it('matches mixed-order 3-token name', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Succeed Jeremiah Ikwuje')).toBeCloseTo(1.0);
  });

  // ── partial provider responses ─────────────────────────────────

  it('matches when provider returns first 2 of 3 names', () => {
    // Provider omits last name
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Jeremiah Succeed')).toBeGreaterThan(0.85);
  });

  it('matches when provider returns last name + first name (drops middle)', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Jeremiah Ikwuje')).toBeGreaterThan(0.85);
  });

  it('matches when provider returns surname + middle name only', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Succeed Ikwuje')).toBeGreaterThan(0.85);
  });

  it('matches when provider returns single name that is present in submission', () => {
    expect(svc.compare('Ada Chioma Obi', 'Ada')).toBeGreaterThan(0.85);
  });

  // ── middle-name scenarios ──────────────────────────────────────

  it('matches submitted 2-name against provider 3-name (provider has extra middle)', () => {
    expect(svc.compare('Ada Obi', 'Ada Chioma Obi')).toBeGreaterThan(0.85);
  });

  it('matches when submitted name has middle name not in provider response', () => {
    expect(svc.compare('Ada Chioma Obi', 'Ada Obi')).toBeGreaterThan(0.85);
  });

  // ── clear mismatches ───────────────────────────────────────────

  it('rejects a completely different name', () => {
    expect(svc.compare('Ada Obi', 'Emeka Nwosu')).toBeLessThan(0.85);
  });

  it('rejects when one token overlaps but others do not', () => {
    // "John Doe" vs "John Smith" — one match, one miss
    const score = svc.compare('John Doe', 'John Smith');
    // "doe" vs "smith" should pull score below threshold
    expect(score).toBeLessThan(0.85);
  });

  it('rejects single-token name that does not match any submitted token', () => {
    expect(svc.compare('Jeremiah Succeed Ikwuje', 'Emeka')).toBeLessThan(0.85);
  });
});
