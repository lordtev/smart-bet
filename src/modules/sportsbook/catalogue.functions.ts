import { loose } from "@/integrations/supabase/loose";
/**
 * sportsbook/catalogue.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the betting catalogue out of the Supabase database and maps it into the
 * shapes the UI already renders (Match / Market / Outcome from lib/betting-data).
 *
 * TABLES READ (all public SELECT policies, publishable key is enough):
 *   events  → one `Match`        (fixture, kickoff, status, live score)
 *   leagues → `Match.league` / `Match.country`
 *   sports  → `Match.sport`
 *   teams   → `Match.home` / `Match.away`
 *   markets → one `Market`       (joined to market_types for `code`)
 *   selections → `Market.outcomes` (id + price the bet slip sends back)
 *
 * RULES
 * - Only events with status 'scheduled' or 'live' are shown, and only markets
 *   whose status is 'open' with 'active' selections — exactly what the
 *   `place_bet` database function will accept.
 * - Ids sent to the browser are the real UUIDs. The bet slip places a bet with
 *   `selections.id` values only; the database re-reads every price.
 * - If the database cannot be reached, or holds no fixtures yet, the UI falls
 *   back to the demo fixtures so pages never render blank. Demo prices are
 *   flagged `bettable: false` and the bet slip refuses them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import type { Database } from "@/integrations/supabase/types";
import {
  demoMarketOptions,
  demoSports,
  demoMatches,
  countryNameFromCode,
  type KickoffDay,
  type Market,
  type Match,
  type Outcome,
} from "@/lib/betting-data";

/** Fixture statuses the book publishes: anything else is finished or void. */
const VISIBLE_EVENT_STATUS: Database["public"]["Enums"]["event_status"][] = ["scheduled", "live"];

export type CatalogueSport = { id: string; name: string; slug: string; count: number };
export type CatalogueMarketType = { code: string; name: string };

export type CataloguePayload = {
  matches: Match[];
  sports: CatalogueSport[];
  marketTypes: CatalogueMarketType[];
  /** 'database' = live Supabase rows, 'demo' = local fallback fixtures. */
  source: "database" | "demo";
  /** Human-readable reason when the demo fallback is in use. */
  notice: string | null;
  fetchedAt: string;
};

/* ── Row shapes (kept local so a schema change fails loudly here) ─────────── */
type SportRow = { id: string; name: string; slug: string; sort_order: number | null };
type LeagueRow = {
  id: string;
  sport_id: string;
  name: string;
  country_code: string | null;
  sort_order: number | null;
};
type TeamRow = { id: string; name: string };
type EventRow = {
  id: string;
  league_id: string;
  home_team_id: string | null;
  away_team_id: string | null;
  name: string;
  starts_at: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
  result_data: unknown;
  is_featured: boolean | null;
};
type MarketRow = {
  id: string;
  event_id: string;
  market_type_id: string;
  name: string;
  status: string;
  sort_order?: number | null;
};
type MarketTypeRow = { id: string; code: string; name: string };
type SelectionRow = {
  id: string;
  market_id: string;
  name: string;
  odds: number;
  status: string;
  sort_order: number | null;
};

/* ── Kickoff formatting ───────────────────────────────────────────────────── */

function dayDiff(iso: string): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86_400_000);
}

/** "Today 18:00", "Tomorrow 22:00", "Sat 17:00", "12 Mar 20:45". */
function kickoffLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const diff = dayDiff(iso);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === 2) return `Day after ${time}`;
  if (diff > 2 && diff < 7) return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${time}`;
}

/** Kickoff bucket used by the sports-page filter chips. */
function kickoffBucket(iso: string): KickoffDay {
  const diff = dayDiff(iso);
  if (diff <= 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === 2) return "day-after";
  return "this-week";
}

/* ── Demo fallback ────────────────────────────────────────────────────────── */

/** Lower rank = shown first. Keeps the familiar 1X2 → totals → BTTS order. */
const MARKET_PRIORITY: Record<string, number> = {
  MATCH_WINNER: 0,
  WINNER: 1,
  OVER_UNDER: 2,
  BTTS: 3,
  DOUBLE_CHANCE: 4,
  DRAW_NO_BET: 5,
  HALF_TIME: 6,
  CORRECT_SCORE: 7,
};

function marketRank(code: string): number {
  return MARKET_PRIORITY[code] ?? 99;
}

function demoPayload(notice: string): CataloguePayload {
  const counts = new Map<string, number>();
  for (const m of demoMatches) counts.set(m.sport, (counts.get(m.sport) ?? 0) + 1);

  return {
    matches: demoMatches.map((m) => ({
      ...m,
      markets: m.markets.map((k) => ({
        ...k,
        outcomes: k.outcomes.map((o) => ({ ...o, bettable: false })),
      })),
    })),
    sports: demoSports.map((s) => ({ id: s.id, name: s.name, slug: s.id, count: counts.get(s.name) ?? 0 })),
    marketTypes: demoMarketOptions.map((m) => ({ code: m.code, name: m.name })),
    source: "demo",
    notice,
    fetchedAt: new Date().toISOString(),
  };
}

/* ── Catalogue loader ─────────────────────────────────────────────────────── */

export const getCatalogue = createServerFn({ method: "GET" }).handler(
  async (): Promise<CataloguePayload> => {
    try {
      // Dynamic import: this module is reachable from the client bundle.
      const supabasePublic = loose((await import("@/integrations/supabase/public.server")).supabasePublic);

      const [sportsRes, leaguesRes, teamsRes, eventsRes, typesRes, marketsRes, selectionsRes] =
        await Promise.all([
          supabasePublic.from("sports").select("id, name, slug, sort_order").eq("is_active", true),
          supabasePublic
            .from("leagues")
            .select("id, sport_id, name, country_code, sort_order")
            .eq("is_active", true),
          supabasePublic.from("teams").select("id, name"),
          supabasePublic
            .from("events")
            .select(
              "id, league_id, home_team_id, away_team_id, name, starts_at, status, home_score, away_score, result_data, is_featured",
            )
            .in("status", VISIBLE_EVENT_STATUS)
            .order("starts_at", { ascending: true })
            .limit(300),
          supabasePublic.from("market_types").select("id, code, name"),
          supabasePublic
            .from("markets")
            .select("id, event_id, market_type_id, name, status")
            .eq("status", "open")
            .limit(3000),
          supabasePublic
            .from("selections")
            .select("id, market_id, name, odds, status, sort_order")
            .eq("status", "active")
            .limit(9000),
        ]);

      const readErrors: Array<[string, { message?: string } | null]> = [
        ["sports", sportsRes.error],
        ["leagues", leaguesRes.error],
        ["teams", teamsRes.error],
        ["events", eventsRes.error],
        ["market_types", typesRes.error],
        ["markets", marketsRes.error],
        ["selections", selectionsRes.error],
      ];
      const failed = readErrors.find((entry) => Boolean(entry[1]));

      if (failed) {
        const [table, err] = failed;
        throw new Error(`catalogue read failed on ${table}: ${err?.message ?? "unknown error"}`);
      }

      const sports = (sportsRes.data ?? []) as unknown as SportRow[];
      const leagues = (leaguesRes.data ?? []) as unknown as LeagueRow[];
      const teams = (teamsRes.data ?? []) as unknown as TeamRow[];
      const events = (eventsRes.data ?? []) as unknown as EventRow[];
      const marketTypes = (typesRes.data ?? []) as unknown as MarketTypeRow[];
      const markets = (marketsRes.data ?? []) as unknown as MarketRow[];
      const selections = (selectionsRes.data ?? []) as unknown as SelectionRow[];

      if (!events.length) {
        return demoPayload(
          "No fixtures are published in the database yet — showing demo data. Run supabase/migrations/20260101000200_seed_demo_catalogue.sql or load your odds feed.",
        );
      }

      const sportsById = new Map(sports.map((s) => [s.id, s]));
      const leaguesById = new Map(leagues.map((l) => [l.id, l]));
      const teamsById = new Map(teams.map((t) => [t.id, t]));
      const typeById = new Map(marketTypes.map((t) => [t.id, t]));

      const selectionsByMarket = new Map<string, SelectionRow[]>();
      for (const s of selections) {
        const list = selectionsByMarket.get(s.market_id);
        if (list) list.push(s);
        else selectionsByMarket.set(s.market_id, [s]);
      }

      const marketsByEvent = new Map<string, Market[]>();
      for (const m of markets) {
        const outcomes: Outcome[] = (selectionsByMarket.get(m.id) ?? [])
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((s) => ({
            id: s.id,
            label: s.name,
            odds: Number(s.odds),
            bettable: true,
          }));
        if (!outcomes.length) continue;

        const type = typeById.get(m.market_type_id);
        const market: Market = {
          id: m.id,
          code: type?.code ?? "OTHER",
          name: m.name,
          outcomes,
        };
        const list = marketsByEvent.get(m.event_id);
        if (list) list.push(market);
        else marketsByEvent.set(m.event_id, [market]);
      }

      // Show the primary market first on cards and on the detail page: the
      // database gives no ordering guarantee for `markets`.
      for (const list of marketsByEvent.values()) {
        list.sort((a, b) => marketRank(a.code) - marketRank(b.code) || a.name.localeCompare(b.name));
      }

      const matches: Match[] = [];
      for (const e of events) {
        const eventMarkets = marketsByEvent.get(e.id);
        if (!eventMarkets?.length) continue; // nothing to bet on → hide the fixture

        const league = leaguesById.get(e.league_id);
        const sport = league ? sportsById.get(league.sport_id) : undefined;
        const fallbackTeams = e.name.split(/\s+vs\s+/i);

        const result =
          e.result_data && typeof e.result_data === "object" && !Array.isArray(e.result_data)
            ? (e.result_data as Record<string, unknown>)
            : {};
        const minute = Number(result["minute"] ?? 0);

        matches.push({
          id: e.id,
          sport: sport?.name ?? league?.name ?? "Football",
          league: league?.name ?? "",
          country: countryNameFromCode(league?.country_code ?? null) || "International",
          countryCode: league?.country_code ?? null,
          home: (e.home_team_id ? teamsById.get(e.home_team_id)?.name : undefined) ?? fallbackTeams[0] ?? "Home",
          away: (e.away_team_id ? teamsById.get(e.away_team_id)?.name : undefined) ?? fallbackTeams[1] ?? "Away",
          startsAt: kickoffLabel(e.starts_at),
          startsAtIso: e.starts_at,
          day: kickoffBucket(e.starts_at),
          popular: Boolean(e.is_featured),
          // `live` is only present for in-play events (exactOptionalPropertyTypes).
          ...(e.status === "live"
            ? {
                live: {
                  minute: Number.isFinite(minute) ? minute : 0,
                  homeScore: e.home_score ?? 0,
                  awayScore: e.away_score ?? 0,
                },
              }
            : {}),
          marketCount: eventMarkets.length,
          markets: eventMarkets,
          bettable: true,
        });
      }

      if (!matches.length) {
        return demoPayload(
          "The database has fixtures but no open markets with active prices — showing demo data until odds are published.",
        );
      }

      const perSport = new Map<string, number>();
      for (const m of matches) perSport.set(m.sport, (perSport.get(m.sport) ?? 0) + 1);

      const usedCodes = new Set(matches.flatMap((m) => m.markets.map((k) => k.code)));
      const catalogueMarketTypes: CatalogueMarketType[] = marketTypes
        .filter((t) => usedCodes.has(t.code))
        .map((t) => ({ code: t.code, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        matches,
        sports: sports
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((s) => ({ id: s.slug, name: s.name, slug: s.slug, count: perSport.get(s.name) ?? 0 }))
          .filter((s) => s.count > 0),
        marketTypes: catalogueMarketTypes.length ? catalogueMarketTypes : demoMarketOptions,
        source: "database",
        notice: null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[catalogue] falling back to demo fixtures:", message);
      return demoPayload(`Could not load the catalogue from Supabase (${message}) — showing demo data.`);
    }
  },
);
