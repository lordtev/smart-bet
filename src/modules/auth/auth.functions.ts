import { loose } from "@/integrations/supabase/loose";
/**
 * auth/auth.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Server functions for the application side of the account: the `profiles` row,
 * the `wallets` row and sign-in bookkeeping.
 *
 * AUTHENTICATION ITSELF IS SUPABASE AUTH (email + password)
 * - Credentials live in `auth.users`; GoTrue stores a bcrypt hash and verifies
 *   the password. The browser calls `supabase.auth.signInWithPassword()`
 *   directly, so this app never sees, stores or compares a password.
 * - These functions only run AFTER Supabase has accepted a bearer token
 *   (requireSupabaseAuth verifies the JWT and hands us `userId`).
 *
 * NO SERVICE-ROLE KEY NEEDED
 * - `handle_new_user()` (trigger on `auth.users` — see
 *   supabase/migrations/20260101000400_password_auth.sql) creates the profile and
 *   the UGX wallet during signup, copying the registration details out of the
 *   auth metadata.
 * - `getCurrentUserProfile` therefore normally just reads the row; when a field
 *   is empty it fills it from the caller's own session metadata using the
 *   caller's own RLS-scoped client ("own profile insert"/"own profile update"),
 *   and only falls back to the admin client when one is configured.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { normalizePhone } from "./phone";

const profileSchema = z.object({
  id: z.string().uuid(),
  username: z.string().nullable(),
  /** Contact email — also the identifier Supabase Auth checks the password against. */
  email: z.string().nullable(),
  phone: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  country_code: z.string().nullable(),
  city: z.string().nullable(),
  /** National ID / NIN captured at registration (app-support column). */
  national_id: z.string().nullable(),
  kyc_status: z.string(),
  status: z.string(),
  role: z.string(),
  referral_code: z.string().nullable(),
  created_at: z.string(),
});

export type UserProfile = z.infer<typeof profileSchema>;

/** Splits "Jane Nakato" into first/last name for the profiles columns. */
function splitName(displayName: string | null): { first: string | null; last: string | null } {
  if (!displayName) return { first: null, last: null };
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0] ?? null, last: null };
  return { first: parts[0] ?? null, last: parts.slice(1).join(" ") || null };
}

/** Reads the caller's own auth record (metadata comes from their session). */
async function sessionMetadata(supabase: any): Promise<Record<string, unknown>> {
  try {
    const { data } = await supabase.auth.getUser();
    const meta = data?.user?.user_metadata;
    return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const isIsoDate = (v: string | null): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * Return the signed-in user's profile, filling in anything the signup trigger
 * could not copy (and creating the row if it is somehow missing). Every
 * authenticated screen can rely on this returning a complete profile.
 */
export const getCurrentUserProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UserProfile> => {
    const supabase = loose(context.supabase);
    const { userId } = context;

    const { data: existing, error: readError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);

    const meta = await sessionMetadata(supabase);
    const displayName = asText(meta["display_name"]) ?? asText(meta["full_name"]);
    const { first, last } = splitName(displayName);
    const phone = normalizePhone(asText(meta["phone"]) ?? "");
    const dateOfBirth = asText(meta["date_of_birth"]);
    const nationalId = asText(meta["national_id"]);
    const countryCode = (asText(meta["country_code"]) ?? "UG").slice(0, 2).toUpperCase();

    /* ── Row missing: create it from the caller's own metadata ───────────── */
    if (!existing) {
      const insert = {
        id: userId,
        email: asText(meta["contact_email"]),
        phone,
        first_name: first,
        last_name: last,
        date_of_birth: isIsoDate(dateOfBirth) ? dateOfBirth : null,
        country_code: countryCode,
        national_id: nationalId,
      };

      // The "own profile insert" policy (password-auth migration) allows this;
      // the BEFORE INSERT trigger forces role/status/kyc_status.
      const { data: created, error: insertError } = await supabase
        .from("profiles")
        .insert(insert)
        .select("*")
        .single();

      if (insertError) {
        // Last resort: the service-role client, when one is configured.
        const hasServiceRole = Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]);
        if (!hasServiceRole) {
          throw new Error(
            `Could not read or create your profile (${insertError.message}). Make sure supabase/migrations/20260101000400_password_auth.sql has been run.`,
          );
        }
        const supabaseAdmin = loose((await import("@/integrations/supabase/client.server")).supabaseAdmin);
        const { data: adminCreated, error: adminError } = await supabaseAdmin
          .from("profiles")
          .insert(insert)
          .select("*")
          .single();
        if (adminError) throw new Error(adminError.message);
        await supabaseAdmin
          .from("wallets")
          .upsert({ user_id: userId, currency: "UGX" }, { onConflict: "user_id,currency" });
        return profileSchema.parse(adminCreated);
      }

      await supabase
        .from("wallets")
        .upsert({ user_id: userId, currency: "UGX" }, { onConflict: "user_id,currency" });
      return profileSchema.parse(created);
    }

    /* ── Row present: top up any field the trigger could not fill ─────────── */
    const patch: Record<string, unknown> = {};
    if (!existing.first_name && first) patch["first_name"] = first;
    if (!existing.last_name && last) patch["last_name"] = last;
    if (!existing.phone && phone) patch["phone"] = phone;
    if (!existing.date_of_birth && isIsoDate(dateOfBirth)) patch["date_of_birth"] = dateOfBirth;
    if (!existing.national_id && nationalId) patch["national_id"] = nationalId;
    if (!existing.country_code) patch["country_code"] = countryCode;

    // Track the sign-in (at most once every 15 minutes, to avoid write spam).
    const lastSeen = existing.last_login_at ? new Date(existing.last_login_at).getTime() : 0;
    if (Date.now() - lastSeen > 15 * 60 * 1000) patch["last_login_at"] = new Date().toISOString();

    if (Object.keys(patch).length > 0) {
      const { data: updated, error: patchError } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", userId)
        .select("*")
        .single();
      if (patchError) throw new Error(patchError.message);
      return profileSchema.parse(updated);
    }

    return profileSchema.parse(existing);
  });

/**
 * Update the signed-in player's own profile details.
 * Only player-owned columns are accepted — role, status and kyc_status are
 * pinned by the database trigger and are not part of this API.
 */
export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        firstName: z.string().trim().min(1).max(60).optional(),
        lastName: z.string().trim().max(60).optional(),
        /** Any Ugandan format; normalised to E.164 before it is stored. */
        phone: z.string().trim().min(7).max(20).optional(),
        dateOfBirth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
          .optional(),
        city: z.string().trim().max(60).optional(),
        nationalId: z.string().trim().min(5).max(30).optional(),
        marketingOptIn: z.boolean().optional(),
        oddsFormat: z.enum(["decimal", "fractional", "american"]).optional(),
        language: z.string().trim().min(2).max(8).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<UserProfile> => {
    const supabase = loose(context.supabase);
    const { userId } = context;

    const patch: Record<string, unknown> = {};
    if (data.firstName !== undefined) patch["first_name"] = data.firstName;
    if (data.lastName !== undefined) patch["last_name"] = data.lastName || null;
    if (data.city !== undefined) patch["city"] = data.city || null;
    if (data.nationalId !== undefined) patch["national_id"] = data.nationalId;
    if (data.marketingOptIn !== undefined) patch["marketing_opt_in"] = data.marketingOptIn;
    if (data.oddsFormat !== undefined) patch["odds_format"] = data.oddsFormat;
    if (data.language !== undefined) patch["language"] = data.language;
    if (data.dateOfBirth !== undefined) patch["date_of_birth"] = data.dateOfBirth;
    if (data.phone !== undefined) {
      const normalized = normalizePhone(data.phone);
      if (!normalized) throw new Error("Enter a valid phone number, e.g. 0772 000 000");
      patch["phone"] = normalized;
    }

    if (Object.keys(patch).length === 0) {
      // Nothing to change — return the current profile untouched.
      const { data: current, error: readError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();
      if (readError) throw new Error(readError.message);
      return profileSchema.parse(current);
    }

    const { data: updated, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    return profileSchema.parse(updated);
  });
