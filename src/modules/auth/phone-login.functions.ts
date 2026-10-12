import { loose } from "@/integrations/supabase/loose";
/**
 * auth/phone-login.functions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets a player sign in with their PHONE NUMBER instead of their email.
 *
 * A phone number is not an email address, so Supabase Auth cannot check it on its
 * own (native phone auth needs the Phone provider enabled, which normally means
 * an SMS gateway). Instead:
 *
 *   1. the browser sends { phone, password } here;
 *   2. `resolve_phone_login()` (SECURITY DEFINER, see
 *      supabase/migrations/20260101000500_phone_login.sql) looks the account up by
 *      normalised phone number and verifies the typed password against GoTrue's
 *      own bcrypt hash with pgcrypto's crypt();
 *   3. only on success does it return the account email — a wrong password, an
 *      unknown number and a number shared by two accounts all return nothing, and
 *      attempts are throttled per phone number;
 *   4. the browser then calls supabase.auth.signInWithPassword({ email, password })
 *      with the email it just resolved, so GoTrue verifies the password a second
 *      time and issues the session exactly as it does for email sign-in.
 *
 * Returning the email is not a disclosure: the caller already had to know the
 * password to get it, and with the password they could sign in anyway.
 *
 * NOTE ON CREDENTIALS: the password passes through this server function (it has to,
 * to be verified against the hash). It is used only for that check, never logged,
 * never stored, and never sent anywhere except Supabase's own auth endpoint.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { normalizePhone } from "./phone";

/** Turns database/GoTrue errors into messages a player can act on. */
function humanise(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("too many attempts")) {
    return "Too many attempts for this phone number — please wait a few minutes and try again";
  }
  if (m.includes("cannot sign in with a phone number")) {
    return "This account cannot sign in with a phone number — use your email address instead";
  }
  if (m.includes("does not exist") || m.includes("could not find the function")) {
    return "Phone sign-in is not set up on this deployment — sign in with your email. (Run supabase/migrations/20260101000500_phone_login.sql.)";
  }
  return message;
}

export type PhoneLoginResolution = { email: string };

/**
 * Resolves a phone number + password to the account's email address.
 * Throws with a readable message when the pair does not match.
 */
export const resolvePhoneLogin = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        phone: z.string().min(5).max(24),
        password: z.string().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<PhoneLoginResolution> => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");

    // Publishable key on purpose: the resolver decides for itself whether the
    // caller may learn the email, so no service-role key is involved.
    const supabasePublic = loose((await import("@/integrations/supabase/public.server")).supabasePublic);

    const { data: email, error } = await supabasePublic.rpc("resolve_phone_login", {
      p_phone: phone,
      p_password: data.password,
    });
    if (error) throw new Error(humanise(error.message));
    if (!email) throw new Error("Phone number or password is incorrect");

    return { email: String(email) };
  });
