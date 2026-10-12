import { loose } from "@/integrations/supabase/loose";
/**
 * auth/phone-auth.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ NOT WIRED TO THE UI (reserved for the SMS phase).
 *
 * Sign-in and registration now run on **Supabase Auth with email + password**
 * (see src/hooks/use-auth.ts and src/routes/auth.tsx). This module is kept
 * because it is the ready-made path for verifying a phone number later, once a
 * real SMS gateway replaces the on-screen code:
 *
 * FLOW
 *  1. `requestSignupOtp`     -> validates the phone, stores a 6-digit code, and
 *                               (for now) returns it so a UI could show it.
 *  2. `verifyOtpAndRegister` -> checks the code, then creates the auth user.
 *
 * REQUIREMENTS BEFORE USE
 * - A real SMS gateway (Twilio Verify / Africa's Talking) — until then the code
 *   is returned to the caller, which must never happen in production.
 * - SUPABASE_SERVICE_ROLE_KEY: `phone_otps` has RLS with no policies and user
 *   creation goes through the admin API, so both need the server-only key.
 * - The `handle_new_user` trigger (auth.users) creates the profile and wallet,
 *   so the profile enrichment below is only a convenience.
 *
 * The password flow needs none of that: it works with the publishable key alone.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizePhone, phoneToAuthEmail } from "./phone";

/** How long a code stays valid. */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Maximum wrong guesses before a code is burned. */
const MAX_ATTEMPTS = 5;

/**
 * OTP storage (`phone_otps`) and user creation both need the service-role key,
 * which lives only on the server. Fail with an actionable message instead of a
 * generic 500 when it is not configured.
 */
function requireServiceRole(): void {
  if (!process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
    throw new Error(
      "Account registration is unavailable: the server is missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env (Supabase → Project Settings → API keys → secret key) to enable sign-up.",
    );
  }
}

/** Cryptographically random 6-digit code. */
function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

const requestSchema = z.object({ phone: z.string().min(5) });

/**
 * Step 1 — issue an OTP for a phone number that is not yet registered.
 */
export const requestSignupOtp = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => requestSchema.parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    requireServiceRole();
    const supabaseAdmin = loose((await import("@/integrations/supabase/client.server")).supabaseAdmin);

    // Reject numbers that already have an account.
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();
    if (existing) throw new Error("This phone number already has an account. Please sign in.");

    // Simple resend throttle: one code per minute per number.
    const { data: recent } = await supabaseAdmin
      .from("phone_otps")
      .select("created_at")
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent && Date.now() - new Date(recent.created_at).getTime() < 60_000) {
      throw new Error("Please wait a minute before requesting another code.");
    }

    const code = generateCode();
    const { error } = await supabaseAdmin.from("phone_otps").insert({
      phone,
      code,
      purpose: "signup",
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    if (error) throw new Error(error.message);

    // TODO(integration): send `code` by SMS here and drop `devCode` from the response.
    return { phone, devCode: code };
  });

const verifySchema = z.object({
  phone: z.string().min(5),
  code: z.string().length(6),
  password: z.string().min(8),
  displayName: z.string().min(2),
  dateOfBirth: z.string().min(4),
  email: z.string().email().optional().or(z.literal("")),
  // National ID / NIN — required for KYC later; basic shape check only here.
  nationalId: z.string().min(5).max(30),
});

/**
 * Step 2 — verify the code and create the account.
 * The auth email is synthetic (derived from the phone); any real email the
 * player supplied is kept as contact detail on their profile.
 */
export const verifyOtpAndRegister = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => verifySchema.parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number");

    requireServiceRole();
    const supabaseAdmin = loose((await import("@/integrations/supabase/client.server")).supabaseAdmin);

    const { data: otp } = await supabaseAdmin
      .from("phone_otps")
      .select("*")
      .eq("phone", phone)
      .eq("purpose", "signup")
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!otp) throw new Error("Request a new verification code.");
    if (new Date(otp.expires_at).getTime() < Date.now()) {
      throw new Error("That code has expired. Request a new one.");
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new Error("Too many attempts. Request a new code.");
    }
    if (otp.code !== data.code) {
      await supabaseAdmin
        .from("phone_otps")
        .update({ attempts: otp.attempts + 1 })
        .eq("id", otp.id);
      throw new Error("Incorrect code. Please try again.");
    }

    // Burn the code before creating anything so it can never be replayed.
    await supabaseAdmin
      .from("phone_otps")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", otp.id);

    const authEmail = phoneToAuthEmail(phone);
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      password: data.password,
      // The number was just proven, and the synthetic address cannot receive mail.
      email_confirm: true,
      user_metadata: {
        phone,
        display_name: data.displayName,
        date_of_birth: data.dateOfBirth,
        contact_email: data.email ? data.email : null,
        national_id: data.nationalId,
        phone_verified: true,
      },
    });
    if (error) {
      if (/already/i.test(error.message)) {
        throw new Error("This phone number already has an account. Please sign in.");
      }
      throw new Error(error.message);
    }

    // `handle_new_user()` (trigger on auth.users) has already created the profile
    // and the UGX wallet. Fill in the registration details it does not copy over
    // so the profile is complete even before the player's first request.
    if (created?.user?.id) {
      const nameParts = data.displayName.trim().split(/\s+/);
      await supabaseAdmin
        .from("profiles")
        .update({
          phone,
          email: data.email ? data.email : null,
          first_name: nameParts[0] ?? null,
          last_name: nameParts.slice(1).join(" ") || null,
          date_of_birth: data.dateOfBirth || null,
          national_id: data.nationalId,
          terms_accepted_at: new Date().toISOString(),
        })
        .eq("id", created.user.id);
    }

    // The profile / wallet rows are created by the `on_auth_user_created`
    // trigger; `getCurrentUserProfile` keeps a lazy fallback for older accounts.
    return { phone, authEmail };
  });
