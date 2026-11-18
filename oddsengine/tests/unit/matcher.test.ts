/**
 * Fixture matching decides whether two rows describe the same match. Getting it
 * wrong either duplicates fixtures or — much worse — merges two different ones.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fixtureDisplayName,
  participantKey,
  pickBestCandidate,
  resolveFixture,
  scoreCandidate,
  type FixtureCandidate,
  type FixtureLinkStore,
} from '../../src/match/matcher.ts';

const subject = {
  name: 'Arsenal vs Chelsea',
  homeTeam: 'Arsenal',
  awayTeam: 'Chelsea',
  commenceTime: '2026-09-26T15:00:00.000Z',
};

function candidate(overrides: Partial<FixtureCandidate> = {}): FixtureCandidate {
  return {
    eventId: 'evt-1',
    name: 'Arsenal vs Chelsea',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    startsAt: '2026-09-26T15:00:00.000Z',
    leagueName: 'Premier League',
    sportName: 'Football',
    ...overrides,
  };
}

describe('participantKey', () => {
  it('ignores club suffixes providers disagree about', () => {
    expect(participantKey('Arsenal')).toBe('arsenal');
    expect(participantKey('Arsenal F.C.')).toBe('arsenal');
    expect(participantKey('Arsenal FC')).toBe('arsenal');
    expect(participantKey('Manchester United Football Club')).toBe('manchester united football');
  });

  it('keeps the words that distinguish two real clubs', () => {
    expect(participantKey('Manchester United')).not.toBe(participantKey('Manchester City'));
  });

  it('never returns an empty key', () => {
    expect(participantKey('The')).toBe('the');
    expect(participantKey('FC')).toBe('fc');
  });
});

describe('scoreCandidate', () => {
  it('matches identical participants at an identical kickoff', () => {
    expect(scoreCandidate(subject, candidate(), 36)).toEqual({
      method: 'exact_name_kickoff',
      confidence: 1,
    });
  });

  it('matches club-name variants', () => {
    expect(scoreCandidate(subject, candidate({ homeTeam: 'Arsenal F.C.' }), 36)).toEqual({
      method: 'exact_name_kickoff',
      confidence: 1,
    });
  });

  it('still matches when the provider swaps home and away, at lower confidence', () => {
    const swapped = scoreCandidate(subject, candidate({ homeTeam: 'Chelsea', awayTeam: 'Arsenal' }), 36);
    expect(swapped?.method).toBe('fuzzy_name');
    expect(swapped?.confidence).toBeLessThan(1);
  });

  it('rejects a different fixture entirely', () => {
    expect(scoreCandidate(subject, candidate({ homeTeam: 'Spurs', awayTeam: 'Everton' }), 36)).toBeNull();
  });

  it('rejects the same fixture outside the time window', () => {
    expect(scoreCandidate(subject, candidate({ startsAt: '2026-09-29T15:00:00.000Z' }), 36)).toBeNull();
  });

  it('accepts the same fixture a few hours off, but only as fuzzy', () => {
    const scored = scoreCandidate(subject, candidate({ startsAt: '2026-09-26T18:00:00.000Z' }), 36);
    expect(scored?.method).toBe('fuzzy_name');
  });

  it('rejects when only one side knows its participants', () => {
    // A provider that omits the teams must not be merged into a real fixture on
    // the strength of a name alone.
    expect(scoreCandidate(subject, candidate({ homeTeam: null, awayTeam: null }), 36)).toBeNull();
  });

  it('matches outrights by identical name within an hour', () => {
    const outright = { name: 'Premier League Winner', homeTeam: null, awayTeam: null, commenceTime: '2026-09-26T15:00:00.000Z' };
    expect(
      scoreCandidate(outright, candidate({ name: 'Premier League Winner', homeTeam: null, awayTeam: null }), 36)?.method,
    ).toBe('exact_name_kickoff');
  });

  it('rejects an unparseable kickoff rather than guessing', () => {
    expect(scoreCandidate({ ...subject, commenceTime: 'not-a-date' }, candidate(), 36)).toBeNull();
  });
});

describe('pickBestCandidate', () => {
  it('prefers the highest confidence, then the first found', () => {
    const best = pickBestCandidate(
      subject,
      [
        candidate({ eventId: 'swapped', homeTeam: 'Chelsea', awayTeam: 'Arsenal' }),
        candidate({ eventId: 'exact' }),
      ],
      36,
    );
    expect(best?.candidate.eventId).toBe('exact');
  });

  it('returns null when nothing matches', () => {
    expect(pickBestCandidate(subject, [candidate({ homeTeam: 'X', awayTeam: 'Y' })], 36)).toBeNull();
  });
});

describe('resolveFixture', () => {
  const baseSubject = {
    ...subject,
    externalKey: 'provider-1',
    sportName: 'Football',
    sportKey: 'soccer_epl',
    competitionTitle: 'Premier League',
    countryCode: 'GB',
    metadata: {},
  };

  function store(overrides: Partial<FixtureLinkStore> = {}): FixtureLinkStore & {
    saved: Array<Record<string, unknown>>;
    created: Array<Record<string, unknown>>;
  } {
    const saved: Array<Record<string, unknown>> = [];
    const created: Array<Record<string, unknown>> = [];

    return {
      saved,
      created,
      findLink: async () => null,
      findCandidates: async () => [],
      createEvent: async (input) => {
        created.push(input);
        return 'new-event';
      },
      saveLink: async (input) => {
        saved.push(input);
      },
      ...overrides,
    };
  }

  it('takes the fast path when a link already exists', async () => {
    const findCandidates = vi.fn(async () => []);
    const linkStore = store({
      findLink: async () => ({ eventId: 'linked-event', matchMethod: 'linked' }),
      findCandidates,
    });

    const result = await resolveFixture({ subject: baseSubject, store: linkStore, windowHours: 36 });

    expect(result).toMatchObject({ eventId: 'linked-event', method: 'linked', created: false });
    // No heuristic work at all on the normal path.
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it('adopts a matching existing event and records the link', async () => {
    const linkStore = store({ findCandidates: async () => [candidate({ eventId: 'existing' })] });

    const result = await resolveFixture({ subject: baseSubject, store: linkStore, windowHours: 36 });

    expect(result).toMatchObject({ eventId: 'existing', method: 'exact_name_kickoff', created: false });
    expect(linkStore.saved).toHaveLength(1);
    expect(linkStore.saved[0]).toMatchObject({ externalKey: 'provider-1', eventId: 'existing' });
  });

  it('creates an event and links it when nothing matches', async () => {
    const linkStore = store();

    const result = await resolveFixture({ subject: baseSubject, store: linkStore, windowHours: 36 });

    expect(result).toMatchObject({ eventId: 'new-event', method: 'created', created: true });
    expect(linkStore.created).toHaveLength(1);
    expect(linkStore.created[0]).toMatchObject({
      name: 'Arsenal vs Chelsea',
      commenceTime: '2026-09-26T15:00:00.000Z',
    });
    // The link is written even for a fresh event, so the heuristic never repeats.
    expect(linkStore.saved).toHaveLength(1);
  });

  it('searches a window around the kickoff, not the whole table', async () => {
    const findCandidates = vi.fn(async (_input: { from: string; to: string }) => [] as FixtureCandidate[]);
    await resolveFixture({ subject: baseSubject, store: store({ findCandidates }), windowHours: 6 });

    const call = findCandidates.mock.calls[0]?.[0] as { from: string; to: string };
    expect(Date.parse(call.from)).toBe(Date.parse('2026-09-26T09:00:00.000Z'));
    expect(Date.parse(call.to)).toBe(Date.parse('2026-09-26T21:00:00.000Z'));
  });
});

describe('fixtureDisplayName', () => {
  it('produces the "A vs B" shape the website parses', () => {
    expect(fixtureDisplayName('Arsenal', 'Chelsea', 'ignored')).toBe('Arsenal vs Chelsea');
  });

  it('falls back when a participant is unknown', () => {
    expect(fixtureDisplayName(null, null, 'Premier League Winner')).toBe('Premier League Winner');
    expect(fixtureDisplayName('Arsenal', null, 'Arsenal')).toBe('Arsenal');
  });
});
