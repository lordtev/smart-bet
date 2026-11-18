/**
 * Fixture matching
 * ─────────────────────────────────────────────────────────────────────────────
 * Deciding "is this provider fixture the same match as that row in `events`?"
 * is the one genuinely ambiguous step in the pipeline, so it is isolated here,
 * scored explicitly, and recorded on every link it makes.
 *
 * Resolution order (cheapest and most trustworthy first):
 *
 *   1. LINK      — `odds_source_links` already maps this provider fixture id to
 *                  an event. This is the normal path on every cycle after the
 *                  first, and it costs one indexed lookup.
 *   2. EXACT     — normalised team names match in the same order and the kickoff
 *                  times are within an hour.
 *   3. FUZZY     — normalised team names match within the configured window
 *                  (home/away may be swapped by the provider), with a lower
 *                  confidence recorded so a human can review it later.
 *   4. CREATE    — nothing matched, so a new event row is created.
 *
 * It never merges two provider fixtures into one event by guesswork: a fuzzy
 * match requires both participants, and anything weaker creates a new event.
 */

import { participantKey, slug, teamKey } from '../normalize/canonical.ts';

/** Re-exported so callers of the matcher get the canonical definition. */
export { participantKey };

/** One existing `events` row, with the labels needed to compare it. */
export type FixtureCandidate = {
  eventId: string;
  name: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
  leagueName: string | null;
  sportName: string | null;
};

export type MatchSubject = {
  name: string;
  homeTeam: string | null;
  awayTeam: string | null;
  commenceTime: string;
};

export type MatchMethod = 'linked' | 'exact_name_kickoff' | 'fuzzy_name' | 'created';

export type MatchResult =
  | { kind: 'matched'; eventId: string; method: MatchMethod; confidence: number }
  | { kind: 'create'; method: 'created'; confidence: 1 };

const HOUR_MS = 3_600_000;

/**
 * Score one candidate against the provider fixture.
 * Returns null when they are not the same fixture at all.
 */
export function scoreCandidate(
  subject: MatchSubject,
  candidate: FixtureCandidate,
  windowHours: number,
): { method: Exclude<MatchMethod, 'linked' | 'created'>; confidence: number } | null {
  const subjectStart = Date.parse(subject.commenceTime);
  const candidateStart = Date.parse(candidate.startsAt);
  if (!Number.isFinite(subjectStart) || !Number.isFinite(candidateStart)) return null;

  const deltaHours = Math.abs(subjectStart - candidateStart) / HOUR_MS;
  if (deltaHours > windowHours) return null;

  const hasTeams = Boolean(subject.homeTeam && subject.awayTeam);
  const candidateHasTeams = Boolean(candidate.homeTeam && candidate.awayTeam);

  // ── Case 1: both sides know their participants ───────────────────────────
  if (hasTeams && candidateHasTeams) {
    const sHome = participantKey(subject.homeTeam as string);
    const sAway = participantKey(subject.awayTeam as string);
    const cHome = participantKey(candidate.homeTeam as string);
    const cAway = participantKey(candidate.awayTeam as string);

    const sameOrder = sHome === cHome && sAway === cAway;
    const swapped = sHome === cAway && sAway === cHome;

    if (!sameOrder && !swapped) return null;

    // Kickoff agreement sharpens confidence; a swap is a known provider quirk
    // and stays acceptable but is recorded as fuzzy so it can be reviewed.
    if (sameOrder && deltaHours <= 1) return { method: 'exact_name_kickoff', confidence: 1 };
    if (sameOrder) return { method: 'fuzzy_name', confidence: 0.9 };
    return { method: 'fuzzy_name', confidence: 0.75 };
  }

  // ── Case 2: nobody knows the participants (outrights / futures) ──────────
  // Only an identical display name within an hour is safe here.
  if (!hasTeams && !candidateHasTeams) {
    const subjectName = slug(subject.name);
    const candidateName = slug(candidate.name);
    if (subjectName && subjectName === candidateName && deltaHours <= 1) {
      return { method: 'exact_name_kickoff', confidence: 0.95 };
    }
    return null;
  }

  // ── Case 3: one side has participants, the other does not ───────────────
  // Too weak to merge automatically — a new event is the honest answer.
  return null;
}

/** Pick the best candidate. Ties break toward the closest kickoff time. */
export function pickBestCandidate(
  subject: MatchSubject,
  candidates: readonly FixtureCandidate[],
  windowHours: number,
): { candidate: FixtureCandidate; method: Exclude<MatchMethod, 'linked' | 'created'>; confidence: number } | null {
  let best: { candidate: FixtureCandidate; method: Exclude<MatchMethod, 'linked' | 'created'>; confidence: number } | null =
    null;

  for (const candidate of candidates) {
    const scored = scoreCandidate(subject, candidate, windowHours);
    if (!scored) continue;
    if (!best || scored.confidence > best.confidence) {
      best = { candidate, ...scored };
    }
  }

  return best;
}

/* ── Orchestration ───────────────────────────────────────────────────────── */

export type FixtureLinkStore = {
  /** Existing link for this provider fixture, if already known. */
  findLink: (externalKey: string) => Promise<{ eventId: string; matchMethod: MatchMethod } | null>;
  /** Candidate events in a time window, already resolved to team names. */
  findCandidates: (input: { from: string; to: string }) => Promise<FixtureCandidate[]>;
  /** Create the event (and missing sport/league/teams) and return its id. */
  createEvent: (input: {
    name: string;
    commenceTime: string;
    homeTeam: string | null;
    awayTeam: string | null;
    sportName: string;
    sportKey: string;
    competitionTitle: string | null;
    countryCode: string | null;
  }) => Promise<string>;
  /** Persist the link so the next cycle takes the fast path. */
  saveLink: (input: {
    externalKey: string;
    eventId: string;
    matchMethod: MatchMethod;
    confidence: number;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
};

export type ResolveFixtureInput = {
  subject: MatchSubject & {
    externalKey: string;
    sportName: string;
    sportKey: string;
    competitionTitle: string | null;
    countryCode: string | null;
    metadata: Record<string, unknown>;
  };
  store: FixtureLinkStore;
  windowHours: number;
};

export type ResolveFixtureResult = {
  eventId: string;
  method: MatchMethod;
  confidence: number;
  /** True when this cycle created the event row. */
  created: boolean;
};

/**
 * Resolve (or create) the `events` row for one provider fixture.
 *
 * The link is written even for a freshly created event, so subsequent cycles
 * never pay for the heuristic again.
 */
export async function resolveFixture(input: ResolveFixtureInput): Promise<ResolveFixtureResult> {
  const { subject, store, windowHours } = input;

  const linked = await store.findLink(subject.externalKey);
  if (linked) {
    return { eventId: linked.eventId, method: 'linked', confidence: 1, created: false };
  }

  const start = Date.parse(subject.commenceTime);
  const from = new Date(start - windowHours * HOUR_MS).toISOString();
  const to = new Date(start + windowHours * HOUR_MS).toISOString();

  const candidates = await store.findCandidates({ from, to });
  const best = pickBestCandidate(subject, candidates, windowHours);

  if (best) {
    await store.saveLink({
      externalKey: subject.externalKey,
      eventId: best.candidate.eventId,
      matchMethod: best.method,
      confidence: best.confidence,
      metadata: subject.metadata,
    });
    return {
      eventId: best.candidate.eventId,
      method: best.method,
      confidence: best.confidence,
      created: false,
    };
  }

  const eventId = await store.createEvent({
    name: subject.name,
    commenceTime: subject.commenceTime,
    homeTeam: subject.homeTeam,
    awayTeam: subject.awayTeam,
    sportName: subject.sportName,
    sportKey: subject.sportKey,
    competitionTitle: subject.competitionTitle,
    countryCode: subject.countryCode,
  });

  await store.saveLink({
    externalKey: subject.externalKey,
    eventId,
    matchMethod: 'created',
    confidence: 1,
    metadata: subject.metadata,
  });

  return { eventId, method: 'created', confidence: 1, created: true };
}

/** Display name for a fixture, in the `A vs B` shape the website parses. */
export function fixtureDisplayName(homeTeam: string | null, awayTeam: string | null, fallback: string): string {
  if (homeTeam && awayTeam) return `${homeTeam} vs ${awayTeam}`;
  return fallback;
}

/** Key used to deduplicate fixtures inside a single provider payload. */
export function fixtureDedupeKey(subject: MatchSubject & { externalKey: string }): string {
  if (subject.homeTeam && subject.awayTeam) {
    return `${teamKey(subject.homeTeam)}#${teamKey(subject.awayTeam)}#${subject.commenceTime.slice(0, 13)}`;
  }
  return subject.externalKey;
}
