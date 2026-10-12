import { loose } from "@/integrations/supabase/loose";
/**
 * wallet/wallet.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server functions for the player wallet, its ledger history, deposits and
 * withdrawals — all against the Supabase betting-platform schema.
 *
 * MONEY RULES
 * - `wallets.balance` is the authoritative cached balance. It is ONLY ever moved
 *   by `post_ledger_entry()` (SECURITY DEFINER), which locks the wallet row,
 *   checks the funds, updates the balance and appends an immutable
 *   `ledger_entries` row in one transaction. Nothing in this file writes a
 *   balance directly.
 * - `ledger_entries.amount` is SIGNED: positive credits the player, negative
 *   debits them.
 * - Deposits go `deposits` row (status 'pending') → `complete_deposit()`
 *   (or `claim_manual_deposit()` while no payment provider is connected).
 * - Withdrawals go through `request_withdrawal()`, which debits immediately and
 *   requires `profiles.kyc_status = 'verified'`; a rejected request is refunded
 *   by `reject_withdrawal()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type WalletTransaction = {
  id: string;
  /** `ledger_entries.transaction_type`, e.g. 'deposit', 'bet_stake', 'bet_win'. */
  type: string;
  status: string;
  direction: "credit" | "debit";
  /** Absolute value in UGX. */
  amount: number;
  currency: string;
  reference: string | null;
  metadata: Record<string, string | number | boolean | null>;
  /** Wallet balance after this movement (from the ledger snapshot). */
  balanceAfter: number;
  created_at: string;
};

type Row = Record<string, unknown>;

function mapLedgerRow(row: Row): WalletTransaction {
  const meta = row["metadata"] && typeof row["metadata"] === "object" && !Array.isArray(row["metadata"])
    ? (row["metadata"] as Record<string, unknown>)
    : {};

  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
      metadata[k] = v;
    } else {
      metadata[k] = JSON.stringify(v);
    }
  }

  const signed = Number(row["amount"] ?? 0);
  return {
    id: String(row["id"]),
    type: String(row["transaction_type"] ?? "adjustment"),
    status: "completed",
    direction: signed >= 0 ? "credit" : "debit",
    amount: Math.abs(signed),
    currency: String(row["currency"] ?? "UGX"),
    reference: row["description"] == null ? null : String(row["description"]),
    metadata,
    balanceAfter: Number(row["balance_after"] ?? 0),
    created_at: String(row["created_at"] ?? ""),
  };
}

/** Reads the app_settings row that holds the interim deposit switch. */
async function manualDepositsEnabled(supabase: any): Promise<boolean> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "manual_deposits_enabled")
    .maybeSingle();
  const raw = data?.value;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true";
  // Missing row = feature off: never credit a wallet without a provider.
  return false;
}

/** Loads the caller's UGX wallet (created by the signup trigger). */
async function ugxWallet(
  supabase: any,
  userId: string,
): Promise<{ id: string; balance: number; is_locked: boolean }> {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, balance, is_locked")
    .eq("user_id", userId)
    .eq("currency", "UGX")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No UGX wallet was found for your account");
  return {
    id: String(data.id),
    balance: Number(data.balance ?? 0),
    is_locked: Boolean(data.is_locked),
  };
}

/**
 * Return the wallet balance for the signed-in user.
 * The number comes straight from `wallets.balance`, which the ledger keeps in
 * step with every entry.
 */
export const getWalletBalance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const wallet = await ugxWallet(loose(context.supabase), context.userId);
    return wallet.balance;
  });

/**
 * Paginated ledger history for the signed-in user, newest first.
 * Every movement the player has ever made is a row in `ledger_entries`.
 */
export const getWalletTransactions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: { cursor?: string; limit?: number }) =>
    z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    const supabase = loose(context.supabase);
    const { userId } = context;
    const limit = data.limit ?? 50;

    let query = supabase
      .from("ledger_entries")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (data.cursor) {
      // Cursor-based pagination using the created_at timestamp of the cursor row.
      const { data: cursorRow } = await supabase
        .from("ledger_entries")
        .select("created_at")
        .eq("id", data.cursor)
        .single();
      if (cursorRow) query = query.lt("created_at", cursorRow.created_at);
    }

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return ((rows ?? []) as Row[]).map(mapLedgerRow);
  });

export type DepositResult = {
  depositId: string;
  amount: number;
  credited: number;
  balance: number;
  provider: string;
};

/**
 * Interim deposit: opens a `deposits` row and settles it immediately.
 *
 * This is the stand-in for a payment provider. It is gated on the
 * `manual_deposits_enabled` app setting — flip that to `false` (see
 * supabase/migrations/20260101000100_smartbet_app_support.sql) once a real PSP
 * webhook calls `complete_deposit()` instead.
 *
 * When SUPABASE_SERVICE_ROLE_KEY is configured the row is written and settled
 * with the server-only client; otherwise the player's own RLS-scoped client is
 * used, which can only ever insert a 'pending' deposit and settle it through
 * `claim_manual_deposit()`.
 */
export const createDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        amount: z.number().int().min(1000).max(50_000_000),
        provider: z.string().min(2).max(40),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<DepositResult> => {
    const supabase = loose(context.supabase);
    const { userId } = context;

    if (!(await manualDepositsEnabled(supabase))) {
      throw new Error(
        "Instant top-ups are switched off on this deployment — a payment provider must confirm the deposit.",
      );
    }

    const wallet = await ugxWallet(supabase, userId);
    if (wallet.is_locked) throw new Error("Your wallet is locked — contact support");

    const hasServiceRole = Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);
    const admin = hasServiceRole
      ? loose((await import("@/integrations/supabase/client.server")).supabaseAdmin)
      : null;
    // Untyped on purpose: the insert goes through the admin client when a
    // service-role key is configured, otherwise through the player's own
    // RLS-scoped client (own-pending-deposit policy).
    const db: any = admin ?? supabase;

    const depositInsert = {
      user_id: userId,
      wallet_id: wallet.id,
      provider: data.provider,
      amount: data.amount,
      fee: 0,
      currency: "UGX",
      status: "pending",
      provider_reference: `manual-${Date.now()}`,
    };

    const { data: deposit, error: insertError } = await db
      .from("deposits")
      .insert(depositInsert)
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);

    const depositId = String(deposit.id);

    // Settle it: the ledger entry is posted with idempotency key 'deposit:<id>',
    // so this can never credit the same deposit twice.
    const settlement = admin
      ? await admin.rpc("complete_deposit", { p_deposit_id: depositId })
      : await supabase.rpc("claim_manual_deposit", { p_deposit_id: depositId });
    if (settlement.error) {
      throw new Error(
        `${settlement.error.message} (deposit ${depositId} stays pending and can be settled by staff)`,
      );
    }

    const after = await ugxWallet(supabase, userId);
    return {
      depositId,
      amount: data.amount,
      credited: data.amount,
      balance: after.balance,
      provider: data.provider,
    };
  });

export type WithdrawalResult = {
  withdrawalId: string;
  amount: number;
  balance: number;
  destination: string;
  provider: string;
};

/**
 * Request a withdrawal. Funds are debited immediately by the database function
 * and refunded automatically if staff reject the request.
 * KYC must be verified first (`profiles.kyc_status = 'verified'`).
 */
export const requestWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        amount: z.number().int().positive(),
        provider: z.string().min(2).max(40),
        // Masked payout destination, e.g. '+256 7** *** 123'.
        destination: z.string().min(4).max(80),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<WithdrawalResult> => {
    const supabase = loose(context.supabase);
    const { userId } = context;

    const { data: profile } = await supabase
      .from("profiles")
      .select("kyc_status")
      .eq("id", userId)
      .maybeSingle();
    if (profile && String(profile.kyc_status) !== "verified") {
      throw new Error("Your identity must be verified before you can withdraw");
    }

    // Remember the payout destination on a payment method row (own-row insert
    // policy). Only a masked label is stored — never a full account number.
    const { data: method, error: methodError } = await supabase
      .from("payment_methods")
      .insert({
        user_id: userId,
        method_type: "mobile_money",
        provider: data.provider,
        label: data.destination,
        is_default: true,
      })
      .select("id")
      .single();
    if (methodError) throw new Error(methodError.message);

    const methodId = method?.id;
    if (!methodId) throw new Error("Could not store the payout destination — please try again");

    const { data: withdrawalId, error } = await supabase.rpc("request_withdrawal", {
      p_amount: data.amount,
      p_payment_method_id: String(methodId),
    });
    if (error) throw new Error(error.message);

    const after = await ugxWallet(supabase, userId);
    return {
      withdrawalId: String(withdrawalId),
      amount: data.amount,
      balance: after.balance,
      destination: data.destination,
      provider: data.provider,
    };
  });
