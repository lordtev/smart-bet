import { loose } from "@/integrations/supabase/loose";
/**
 * sportsbook/booking-code.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server functions for shareable booking codes.
 *
 * A booking code is a short reference (8 characters, e.g. `K7QM23XB`) that
 * anyone can type into /booking-code to pull the same selections into their own
 * bet slip, at their own stake.
 *
 * DATABASE CONTRACT (supabase/migrations/20260101000300_booking_codes.sql)
 * - `create_booking_code(p_selection_ids, p_stake)` — authenticated only. It
 *   re-reads every price from `selections` and mirrors place_bet()'s validation
 *   (active selection, open market, max legs, no two legs from one event), then
 *   stores the code with its legs and returns it.
 * - `load_booking_code(p_code)` — callable by anyone, including signed-out
 *   visitors, so a shared slip opens for a visitor who has not registered yet.
 *   It returns each leg with the CURRENT price, the price at creation and an
 *   `is_available` flag computed with the same rules place_bet() uses. An
 *   unknown or expired code returns no rows.
 * - The code is the capability: `booking_codes` has no public SELECT policy, so
 *   codes cannot be listed or enumerated — only resolved one at a time.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** One leg of a shared slip, as returned by `load_booking_code`. */
export type BookingCodeLeg = {
  selectionId: string;
  selectionName: string;
  marketId: string;
  marketName: string;
  eventId: string;
  eventName: string;
  startsAt: string | null;
  /** Live price (what the leg pays today). */
  odds: number;
  /** Price when the code was created — differs if the book moved. */
  oddsAtCreation: number;
  /** False when the market is suspended/closed or the event already started. */
  available: boolean;
};

/** A loaded booking code: header data plus its legs. */
export type BookingCodeSlip = {
  code: string;
  stake: number | null;
  totalOdds: number;
  createdAt: string | null;
  expiresAt: string | null;
  legs: BookingCodeLeg[];
};

/** A code owned by the signed-in player, for the "your codes" list. */
export type BookingCodeSummary = {
  code: string;
  stake: number | null;
  legCount: number;
  totalOdds: number;
  loadCount: number;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

export type CreateBookingCodeResult = {
  code: string;
  expiresAt: string | null;
  legCount: number;
  totalOdds: number;
};

type Row = Record<string, unknown>;

const num = (v: unknown, fallback = 0): number => (v == null ? fallback : Number(v));
const str = (v: unknown, fallback = ""): string => (v == null ? fallback : String(v));

/** Turns database exceptions into messages a player can act on. */
function humanise(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("not authenticated")) return "Sign in to create a booking code";
  if (m.includes("no selections")) return "Add selections to your slip first";
  if (m.includes("too many legs")) return "A booking code can hold at most 20 selections";
  if (m.includes("duplicate selections")) return "The same selection appears twice on your slip";
  if (m.includes("selection is not available") || m.includes("not available")) {
    return "One of your selections is no longer available — refresh the odds and try again";
  }
  if (m.includes("multiple selections from the same event")) {
    return "A booking code cannot contain two selections from the same event";
  }
  if (m.includes("too many active booking codes")) {
    return "You already have 50 active booking codes — revoke one before creating another";
  }
  return message;
}

/* ── Create ───────────────────────────────────────────────────────────────── */

export const createBookingCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        /** `selections.id` values from the current slip. */
        selectionIds: z.array(z.string().uuid()).min(1).max(20),
        /** Slip stake in UGX, stored so the code restores the same stake. */
        stake: z.number().int().positive().max(50_000_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<CreateBookingCodeResult> => {
    const { supabase } = context;

    const args: { p_selection_ids: string[]; p_stake?: number } = {
      p_selection_ids: data.selectionIds,
    };
    if (data.stake != null) args.p_stake = data.stake;

    const { data: code, error } = await supabase.rpc("create_booking_code", args);
    if (error) throw new Error(humanise(error.message));

    // Read the row back so the UI can show the real expiry and totals.
    const { data: row } = await supabase
      .from("booking_codes")
      .select("code, expires_at, leg_count, total_odds")
      .eq("code", String(code))
      .maybeSingle();

    return {
      code: String(code),
      expiresAt: row ? str(row.expires_at) : null,
      legCount: row ? num(row.leg_count, data.selectionIds.length) : data.selectionIds.length,
      totalOdds: row ? num(row.total_odds, 1) : 1,
    };
  });

/* ── Load (public: a shared code must open for signed-out visitors) ───────── */

export const loadBookingCode = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        code: z
          .string()
          .trim()
          .min(4)
          .max(16)
          .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<BookingCodeSlip> => {
    const supabasePublic = loose((await import("@/integrations/supabase/public.server")).supabasePublic);

    const { data: rows, error } = await supabasePublic.rpc("load_booking_code", {
      p_code: data.code,
    });
    if (error) throw new Error(error.message);

    const legs = (rows ?? []) as unknown as Row[];
    if (!legs.length) {
      throw new Error("That booking code was not found, or it has expired");
    }

    const first = legs[0]!;
    return {
      code: str(first["code"], data.code),
      stake: first["stake"] == null ? null : num(first["stake"]),
      totalOdds: num(first["total_odds"], 1),
      createdAt: str(first["created_at"]) || null,
      expiresAt: str(first["expires_at"]) || null,
      legs: legs.map((r) => ({
        selectionId: str(r["selection_id"]),
        selectionName: str(r["selection_name"], "Selection"),
        marketId: str(r["market_id"]),
        marketName: str(r["market_name"], "Market"),
        eventId: str(r["event_id"]),
        eventName: str(r["event_name"], "Event"),
        startsAt: r["starts_at"] == null ? null : str(r["starts_at"]),
        odds: num(r["odds"], 1),
        oddsAtCreation: num(r["odds_at_creation"], num(r["odds"], 1)),
        available: Boolean(r["is_available"]),
      })),
    };
  });

/* ── The signed-in player's own codes ─────────────────────────────────────── */

export const getMyBookingCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BookingCodeSummary[]> => {
    const { supabase, userId } = context;

    const { data, error } = await supabase
      .from("booking_codes")
      .select("code, stake, leg_count, total_odds, load_count, created_at, expires_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    const now = Date.now();
    return ((data ?? []) as unknown as Row[]).map((r) => ({
      code: str(r["code"]),
      stake: r["stake"] == null ? null : num(r["stake"]),
      legCount: num(r["leg_count"]),
      totalOdds: num(r["total_odds"], 1),
      loadCount: num(r["load_count"]),
      createdAt: str(r["created_at"]),
      expiresAt: str(r["expires_at"]),
      expired: new Date(str(r["expires_at"])).getTime() < now,
    }));
  });

/** Revokes one of the caller's own codes (RLS restricts the delete to them). */
export const deleteBookingCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ code: z.string().trim().min(4).max(16) }).parse(input))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;

    const { error } = await supabase
      .from("booking_codes")
      .delete()
      .eq("code", data.code.toUpperCase())
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
