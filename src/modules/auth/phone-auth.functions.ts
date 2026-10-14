import { loose, type LooseClient } from "@/integrations/supabase/loose";
/**
 * auth/phone-auth.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PHONE-ONLY SIGN-UP AND PASSWORD RESET.
 *
 * SMARTBET has no email step at all: the phone number is the only identifier a
 * player ever gives, and it is proven with a one-time code before an account
 * exists or a password is changed.
 *
 *   requestSignupOtp(phone)                → step 1 of registration
 *   verifyOtpAndRegister(phone, code, …)   → step 2: create the account
 *   requestPasswordResetOtp(phone)         → step 1 of "forgot password"
 *   resetPasswordWithOtp(phone, code, pw)  → step 2: set a new password
 *
 * ⚠ SMS DELIVERY IS MOCKED (see modules/auth/phone.ts). No gateway is connected
 * yet, so every code is the fixed `MOCK_OTP_CODE` ("12345"). The verification
 * half is real: the code is stored in `phone_otps`, expires, counts attempts and
 * is burned on use. To go live, set `SMS_PROVIDER_CONFIGURED = true`, send the
 * generated code by SMS in `issueOtp()` and delete the mock constant.
 *
 * WHY THE SERVER DOES THE WORK
 * - `phone_otps` has RLS with no policies and accounts are created through the
 *   admin API, so both need SUPABASE_SERVICE_ROLE_KEY. It is server-only.
 * - GoTrue cannot accept a phone number as a credential, so the account is
 *   created with a deterministic synthetic email derived from the phone
 *   (`phoneToAuthEmail`). The player never sees it; the browser derives the same
 *   value locally to open a session afterwards, so it never travels over the wire.
 * - The `handle_new_user` trigger creates the profile + UGX wallet, so the
 *   profile enrichment below is only a convenience.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  MOCK_OTP_CODE,
  SMS_PROVIDER_CONFIGURED,
  normalizePhone,
  phoneToAuthEmail,
} from "./phone";

/** How long a code stays valid. */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Maximum wrong guesses before a code is burned. */
const MAX_ATTEMPTS = 5;
/** With a real gateway, one code per number per this window. */
const RESEND_THROTTLE_MS = 60_000;

/** The two things a code can be issued for. */
type OtpPurpose = "signup" | "reset";

/**
 * OTP storage (`phone_otps`) and user creation both need the service-role key,
 * which lives only on the server. Fail with an actionable message instead of a
 * generic 500 when it is not configured.
 */
function requireServiceRole(): void {
  if (!process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
    throw new Error(
      "Phone accounts are unavailable: the server is missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env (Supabase → Project Settings → API keys → secret key).",
    );
  }
}

/** Cryptographically random 6-digit code, used once a real gateway is wired up. */
function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** The service-role client, imported lazily so it never reaches the browser. */
async function adminClient() {
  requireServiceRole();
  return loose((await import("@/integrations/supabase/client.server")).supabaseAdmin);
}

/**
 * Stores a fresh code for `phone`, burning any earlier unused one so only the
 * newest can ever be redeemed. Returns the code that was stored — which the SMS
 * provider will send, and which is the mock constant while delivery is stubbed.
 */
async function issueOtp(
  supabaseAdmin: LooseClient,
  phone: string,
  purpose: OtpPurpose,
): Promise<string> {
  const now = new Date();

  // Housekeeping: an older code for the same number and purpose is dead.
  await supabaseAdmin
    .from("phone_otps")
    .update({ consumed_at: now.toISOString() })
    .eq("phone", phone)
    .eq("purpose", purpose)
    .is("consumed_at", null);

  // ⚠ MOCK: replace with `generateCode()` and an SMS call to go live.
  const code = SMS_PROVIDER_CONFIGURED ? generateCode() : MOCK_OTP_CODE;

  const { error } = await supabaseAdmin.from("phone_otps").insert({
    phone,
    code,
    purpose,
    expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
  });
  if (error) throw new Error(error.message);

  return code;
}

/**
 * Checks the newest unused code for `phone`/`purpose` and burns it on success.
 * Throws a player-readable error otherwise (missing, expired, wrong, exhausted).
 */
async function redeemOtp(
  supabaseAdmin: LooseClient,
  phone: string,
  purpose: OtpPurpose,
  submitted: string,
): Promise<void> {
  const { data: otp, error } = await supabaseAdmin
    .from("phone_otps")
    .select("*")
    .eq("phone", phone)
    .eq("purpose", purpose)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (!otp) throw new Error("Request a new verification code.");
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    throw new Error("That code has expired. Request a new one.");
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new Error("Too many attempts. Request a new code.");
  }
  if (String(otp.code).trim() !== submitted.trim()) {
    await supabaseAdmin
      .from("phone_otps")
      .update({ attempts: otp.attempts + 1 })
      .eq("id", otp.id);
    throw new Error("Incorrect code. Please try again.");
  }

  // Burn the code before anything else happens so it can never be replayed.
  await supabaseAdmin
    .from("phone_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", otp.id);
}

/** Blocks a re-send within the throttle window. Only used with a real gateway. */
async function assertNotThrottled(
  supabaseAdmin: LooseClient,
  phone: string,
  purpose: OtpPurpose,
): Promise<void> {
  if (!SMS_PROVIDER_CONFIGURED) return; // Mock delivery costs nothing to repeat.

  const { data: recent } = await supabaseAdmin
    .from("phone_otps")
    .select("created_at")
    .eq("phone", phone)
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_THROTTLE_MS) {
    throw new Error("Please wait a moment before requesting another code.");
  }
}

/** The single account that owns a phone number, or null when there is none. */
async function accountIdForPhone(
  supabaseAdmin: LooseClient,
  phone: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("profiles").select("id").eq("phone", phone);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    throw new Error(
      "Several accounts share that phone number. Please contact support to sort it out.",
    );
  }
  const row = data[0] as { id: string } | undefined;
  return row ? row.id : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * REGISTRATION — step 1: send a code to a number that has no account yet
 * ═══════════════════════════════════════════════════════════════════════════ */

export const requestSignupOtp = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ phone: z.string().min(5) }).parse(input))
  .handler(async ({ data }): Promise<{ phone: string }> => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    const supabaseAdmin = await adminClient();

    if (await accountIdForPhone(supabaseAdmin, phone)) {
      throw new Error("That phone number already has an account. Sign in instead.");
    }

    await assertNotThrottled(supabaseAdmin, phone, "signup");
    await issueOtp(supabaseAdmin, phone, "signup");

    // TODO(sms): send the code from `issueOtp()` by SMS.
    return { phone };
  });

const registerSchema = z.object({
  phone: z.string().min(5),
  code: z.string().min(4).max(8),
  password: z.string().min(8),
  displayName: z.string().min(2),
  dateOfBirth: z.string().min(4),
  /** National ID / NIN — required for KYC later; basic shape check only here. */
  nationalId: z.string().min(5).max(30),
});

/**
 * REGISTRATION — step 2: verify the code and create the account.
 * The auth email is synthetic (derived from the phone); nothing email-shaped is
 * collected from the player.
 */
export const verifyOtpAndRegister = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => registerSchema.parse(input))
  .handler(async ({ data }): Promise<{ phone: string }> => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    const supabaseAdmin = await adminClient();

    if (await accountIdForPhone(supabaseAdmin, phone)) {
      throw new Error("That phone number already has an account. Sign in instead.");
    }

    await redeemOtp(supabaseAdmin, phone, "signup", data.code);

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: phoneToAuthEmail(phone),
      password: data.password,
      // The number was just proven, and the synthetic address cannot receive mail.
      email_confirm: true,
      user_metadata: {
        phone,
        display_name: data.displayName.trim(),
        date_of_birth: data.dateOfBirth,
        national_id: data.nationalId,
        phone_verified: true,
        terms_accepted: true,
      },
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) {
        throw new Error("That phone number already has an account. Sign in instead.");
      }
      throw new Error(error.message);
    }

    // `handle_new_user()` (trigger on auth.users) has already created the profile
    // and the UGX wallet. Fill in anything it left empty so the profile is
    // complete before the player's first request.
    if (created?.user?.id) {
      const nameParts = data.displayName.trim().split(/\s+/);
      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .update({
          phone,
          email: null,
          first_name: nameParts[0] ?? null,
          last_name: nameParts.slice(1).join(" ") || null,
          date_of_birth: data.dateOfBirth || null,
          national_id: data.nationalId,
          terms_accepted_at: new Date().toISOString(),
        })
        .eq("id", created.user.id);
      if (profileError) throw new Error(profileError.message);
    }

    // The browser now opens the session with the password it just chose.
    return { phone };
  });

/* ═══════════════════════════════════════════════════════════════════════════
 * PASSWORD RESET — by phone number, with the same one-time code
 * ═══════════════════════════════════════════════════════════════════════════ */

export const requestPasswordResetOtp = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ phone: z.string().min(5) }).parse(input))
  .handler(async ({ data }): Promise<{ phone: string }> => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    const supabaseAdmin = await adminClient();

    // Being explicit here is a deliberate trade-off: the caller learns whether a
    // number is registered. Once a real gateway bills per message, return the
    // same success shape either way and only send when the account exists.
    if (!(await accountIdForPhone(supabaseAdmin, phone))) {
      throw new Error("No SMARTBET account uses that phone number. Check it and try again.");
    }

    await assertNotThrottled(supabaseAdmin, phone, "reset");
    await issueOtp(supabaseAdmin, phone, "reset");

    // TODO(sms): send the code from `issueOtp()` by SMS.
    return { phone };
  });

const resetSchema = z.object({
  phone: z.string().min(5),
  code: z.string().min(4).max(8),
  password: z.string().min(8),
});

/**
 * PASSWORD RESET — step 2: verify the code and set the new password.
 * GoTrue hashes it; the browser signs in afterwards with the phone's synthetic
 * credential email, which it derives locally.
 */
export const resetPasswordWithOtp = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resetSchema.parse(input))
  .handler(async ({ data }): Promise<{ phone: string }> => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    const supabaseAdmin = await adminClient();

    const userId = await accountIdForPhone(supabaseAdmin, phone);
    if (!userId) {
      throw new Error("No SMARTBET account uses that phone number. Check it and try again.");
    }

    // Burn the code last-but-one: only after it is proven correct do we touch the
    // password, and only after the password is set do we tell the player.
    await redeemOtp(supabaseAdmin, phone, "reset", data.code);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);

    return { phone };
  });
