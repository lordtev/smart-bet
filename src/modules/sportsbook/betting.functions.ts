import { loose } from "@/integrations/supabase/loose";
/**
 * sportsbook/betting.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server functions for placing and reading real bets against the Supabase
 * betting-platform schema (`bets`, `bet_legs`, `selections`, ...).
 *
 * HOW A BET IS PLACED
 * - The browser sends ONLY `selections.id` values (uuid) and the stake. It never
 *   sends odds, totals or a payout.
 * - `place_bet(p_stake, p_selection_ids)` is a SECURITY DEFINER database function
 *   that re-reads every price, validates the account (status, KYC, self-exclusion
 *   and stake limits), refuses closed/started markets, writes the `bets` row plus
 *   its `bet_legs`, and debits the stake through `post_ledger_entry` — all in one
 *   transaction. `ledger_entries.idempotency_key` ('bet_stake:<bet_id>') makes the
 *   movement impossible to post twice.
 * - Errors raised by the database are translated into readable messages here.
 *
 * Reading uses the caller's RLS-scoped client, so a player only ever sees their
 * own bets and legs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** A leg as stored by the server (prices frozen at placement time). */
export type ServerBetSelection = {
  id: string;
  eventId: string;
  eventName: string;
  marketId: string;
  marketName: string;
  selectionId: string;
  selectionName: string;
  odds: number;
  status: string;
};

/** A placed bet receipt returned to the UI. */
export type ServerBet = {
  id: string;
  /** Booking-style reference derived from the bet id (the schema has no code column). */
  code: string;
  betType: string;
  stake: number;
  totalOdds: number;
  potentialPayout: number;
  payout: number;
  currency: string;
  status: string;
  placedAt: string;
  settledAt: string | null;
  selections: ServerBetSelection[];
};

/** Short, shareable reference shown to the player: SB + first 8 hex chars of the id. */
export function betCode(betId: string): string {
  return `SB${betId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** Turns database exceptions into messages a player can act on. */
function humanise(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("insufficient funds")) return "Not enough balance for this stake";
  if (m.includes("not available")) {
    return "One of your selections is no longer available — refresh the odds and try again";
  }
  if (m.includes("multiple selections from the same event")) {
    return "An accumulator cannot contain two selections from the same event";
  }
  if (m.includes("stake below minimum")) return "Stake is below the minimum allowed";
  if (m.includes("stake above maximum")) return "Stake is above the maximum allowed";
  if (m.includes("self-excluded")) return "Betting is blocked because you are self-excluded";
  if (m.includes("account not active")) return "Your account is not active — contact support";
  if (m.includes("wallet not found")) return "No UGX wallet was found for your account";
  if (m.includes("kyc rejected")) return "Your identity verification was rejected";
  if (m.includes("stake exceeds your limit")) return "This stake exceeds the limit you set";
  if (m.includes("not authenticated")) return "Sign in to place a bet";
  return message;
}

/**
 * Place a bet for the signed-in user.
 * Returns the stored receipt, re-read from the database after placement.
 */
export const placeBetOnServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        stake: z.number().int().positive(),
        // `selections.id` values from the catalogue. Max 20 = app_settings.max_bet_legs.
        selectionIds: z.array(z.string().uuid()).min(1).max(20),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { supabase } = context;

    const { data: betId, error } = await supabase.rpc("place_bet", {
      p_stake: data.stake,
      p_selection_ids: data.selectionIds,
    });
    if (error) throw new Error(humanise(error.message));

    const [bet] = await readBets(supabase, { betId: String(betId) });
    if (!bet) throw new Error("Bet was placed but could not be read back");
    return bet;
  });

/** Recent bets for the signed-in user, newest first. */
export const getMyBets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    return readBets(supabase, { userId, limit: 50 });
  });

/* ── Internal helpers ─────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));
const num = (v: unknown, fallback = 0): number => (v == null ? fallback : Number(v));

/**
 * Joins legs with their selection / market / event labels and maps to receipts.
 * The client is untyped here on purpose: the caller passes either the
 * request-scoped RLS client (reads go through the "own bets"/"own bet legs"
 * policies) or the admin client.
 */
async function readBets(
  supabase: any,
  opts: { userId?: string; betId?: string; limit?: number },
): Promise<ServerBet[]> {
  let query = supabase.from("bets").select("*");
  if (opts.betId) query = query.eq("id", opts.betId);
  if (opts.userId) query = query.eq("user_id", opts.userId);
  const { data: bets, error } = await query
    .order("placed_at", { ascending: false })
    .limit(opts.limit ?? 50);
  if (error) throw new Error(error.message);

  const betRows = (bets ?? []) as Row[];
  if (!betRows.length) return [];

  const betIds = betRows.map((b) => str(b["id"]));
  const { data: legs, error: legError } = await supabase
    .from("bet_legs")
    .select("*")
    .in("bet_id", betIds);
  if (legError) throw new Error(legError.message);

  const legRows = (legs ?? []) as Row[];
  const selectionIds = [...new Set(legRows.map((l) => str(l["selection_id"])))];
  const marketIds = [...new Set(legRows.map((l) => str(l["market_id"])))];
  const eventIds = [...new Set(legRows.map((l) => str(l["event_id"])))];

  // Catalogue lookups (public SELECT policies) for leg labels.
  const [selRes, mktRes, evtRes] = await Promise.all([
    selectionIds.length
      ? supabase.from("selections").select("id, name").in("id", selectionIds)
      : Promise.resolve({ data: [], error: null }),
    marketIds.length
      ? supabase.from("markets").select("id, name").in("id", marketIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length
      ? supabase.from("events").select("id, name").in("id", eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const res of [selRes, mktRes, evtRes]) {
    if (res?.error) throw new Error(res.error.message);
  }

  const selectionName = new Map(((selRes.data ?? []) as Row[]).map((r) => [str(r["id"]), str(r["name"])]));
  const marketName = new Map(((mktRes.data ?? []) as Row[]).map((r) => [str(r["id"]), str(r["name"])]));
  const eventName = new Map(((evtRes.data ?? []) as Row[]).map((r) => [str(r["id"]), str(r["name"])]));

  const legsByBet = new Map<string, Row[]>();
  for (const leg of legRows) {
    const list = legsByBet.get(str(leg["bet_id"]));
    if (list) list.push(leg);
    else legsByBet.set(str(leg["bet_id"]), [leg]);
  }

  return betRows.map((b) => {
    const id = str(b["id"]);
    const legsForBet = legsByBet.get(id) ?? [];
    return {
      id,
      code: betCode(id),
      betType: str(b["bet_type"], "single"),
      stake: num(b["stake"]),
      totalOdds: num(b["total_odds"], 1),
      potentialPayout: num(b["potential_payout"]),
      payout: num(b["payout"]),
      currency: str(b["currency"], "UGX"),
      status: str(b["status"], "pending"),
      placedAt: str(b["placed_at"]),
      settledAt: b["settled_at"] == null ? null : str(b["settled_at"]),
      selections: legsForBet.map((leg) => {
        const selectionId = str(leg["selection_id"]);
        const marketId = str(leg["market_id"]);
        const eventId = str(leg["event_id"]);
        return {
          id: str(leg["id"]),
          eventId,
          eventName: eventName.get(eventId) ?? "Event",
          marketId,
          marketName: marketName.get(marketId) ?? "Market",
          selectionId,
          selectionName: selectionName.get(selectionId) ?? "Selection",
          odds: num(leg["odds_at_placement"], 1),
          status: str(leg["status"], "pending"),
        };
      }),
    } satisfies ServerBet;
  });
}
