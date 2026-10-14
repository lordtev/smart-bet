/**
 * hooks/use-auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The app's authentication surface. SMARTBET is **phone-only**: a player signs
 * up and signs in with a phone number and a password, and proves the number with
 * a one-time code. No email address is collected or used anywhere.
 *
 * Credentials still live in **Supabase Auth** (GoTrue), which hashes the password
 * with bcrypt, verifies it on sign-in and issues the JWT session that this app
 * sends as a bearer token to every server function. No password ever passes
 * through our own tables.
 *
 * Because GoTrue credentials require an email field, each account gets a
 * deterministic synthetic address derived from its phone number
 * (`phoneToAuthEmail`). It is never shown to the player, never stored on
 * `profiles.email`, and never sent over the wire — the browser derives it
 * locally when it needs to open a session.
 *
 *   signInWithPhone()  → resolvePhoneLogin (phone+password → synthetic email)
 *                        then supabase.auth.signInWithPassword
 *   requestSignupCode()→ server fn: store a code for that number
 *   signUp()           → server fn: verify the code + create the account
 *                        then supabase.auth.signInWithPassword
 *   requestResetCode() → server fn: store a reset code
 *   resetPassword()    → server fn: verify the code + set the new password
 *                        then supabase.auth.signInWithPassword
 *   setPassword()      → supabase.auth.updateUser({ password })   [signed in]
 *   signOut()          → supabase.auth.signOut()
 *
 * ⚠ The one-time codes are MOCKED ("12345") until an SMS gateway is connected —
 * see modules/auth/phone.ts. The verification is real; only delivery is stubbed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getCurrentUserProfile, type UserProfile } from "@/modules/auth/auth.functions";
import { resolvePhoneLogin } from "@/modules/auth/phone-login.functions";
import {
  requestPasswordResetOtp,
  requestSignupOtp,
  resetPasswordWithOtp,
  verifyOtpAndRegister,
} from "@/modules/auth/phone-auth.functions";
import { normalizePhone, phoneToAuthEmail } from "@/modules/auth/phone";

/** Minimum password length enforced here as well as in Supabase's settings. */
export const MIN_PASSWORD_LENGTH = 8;

/** The signed-in identity. The phone itself comes from `profile`. */
export type AuthUser = { id: string };

export type SignUpInput = {
  fullName: string;
  /** Any Ugandan format; normalised to E.164 before it is used. */
  phone: string;
  dateOfBirth: string;
  nationalId: string;
  password: string;
  /** The one-time code the player typed back. */
  code: string;
  termsAccepted: boolean;
};

/** Turns Supabase Auth errors into messages a player can act on. */
export function authErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const m = raw.toLowerCase();
  if (m.includes("invalid login credentials")) return "Phone number or password is incorrect";
  if (m.includes("user already registered") || m.includes("already been registered")) {
    return "That phone number already has an account — sign in instead";
  }
  if (m.includes("password should be at least") || m.includes("password is too short")) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (m.includes("rate limit") || m.includes("too many requests")) {
    return "Too many attempts — please wait a minute and try again";
  }
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) {
    return "New registrations are currently disabled on this project";
  }
  if (m.includes("auth session missing")) return "Sign in to continue";
  return raw || "Something went wrong — please try again";
}

/** Normalises a typed number, or throws the message the player should see. */
export function requirePhone(input: string): string {
  const phone = normalizePhone(input);
  if (!phone) throw new Error("Enter a valid phone number, e.g. 0772 000 000");
  return phone;
}

export function useAuth() {
  const fetchProfile = useServerFn(getCurrentUserProfile);
  const resolvePhone = useServerFn(resolvePhoneLogin);
  const requestSignupFn = useServerFn(requestSignupOtp);
  const registerFn = useServerFn(verifyOtpAndRegister);
  const requestResetFn = useServerFn(requestPasswordResetOtp);
  const resetFn = useServerFn(resetPasswordWithOtp);

  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const p = await fetchProfile();
      setProfile(p);
      return p;
    } catch (e) {
      console.error("Failed to load profile", e);
      return null;
    }
  }, [fetchProfile]);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;

      if (session?.user) {
        setUser({ id: session.user.id });
        await loadProfile();
      } else {
        setUser(null);
        setProfile(null);
      }
      if (mounted) setLoading(false);
    }

    load();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
        setUser({ id: session.user.id });
        void loadProfile();
      }
      if (event === "SIGNED_OUT") {
        setUser(null);
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  /**
   * Opens the session behind every flow. `email` is always the synthetic address
   * derived from a phone number, never anything a player types.
   */
  const signInWithCredential = useCallback(
    async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(authErrorMessage(error));
      if (data.user) setUser({ id: data.user.id });
      await loadProfile();
    },
    [loadProfile],
  );

  /**
   * Phone + password sign-in.
   *
   * `resolvePhoneLogin` verifies the typed password against GoTrue's own bcrypt
   * hash and only then returns the account's credential email; the browser signs
   * in with it, so GoTrue checks the password a second time and issues the
   * session. A wrong password, an unknown number and a number shared by two
   * accounts are all indistinguishable from the outside.
   */
  const signInWithPhone = useCallback(
    async (phone: string, password: string) => {
      const value = requirePhone(phone);
      if (!password) throw new Error("Enter your password");

      const resolved = (await resolvePhone({ data: { phone: value, password } })) as {
        email: string;
      };
      await signInWithCredential(resolved.email, password);
    },
    [signInWithCredential, resolvePhone],
  );

  /** REGISTRATION step 1 — ask for a code for a number with no account yet. */
  const requestSignupCode = useCallback(
    async (phone: string): Promise<string> => {
      const value = requirePhone(phone);
      await requestSignupFn({ data: { phone: value } });
      return value;
    },
    [requestSignupFn],
  );

  /** REGISTRATION step 2 — verify the code, create the account, sign in. */
  const signUp = useCallback(
    async (input: SignUpInput): Promise<void> => {
      const phone = requirePhone(input.phone);
      const code = input.code.trim();
      if (!/^\d{4,8}$/.test(code)) {
        throw new Error("Enter the verification code sent to your phone");
      }
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      if (!input.termsAccepted) {
        throw new Error("Confirm you are 25 or older and accept the terms");
      }

      await registerFn({
        data: {
          phone,
          code,
          password: input.password,
          displayName: input.fullName.trim(),
          dateOfBirth: input.dateOfBirth,
          nationalId: input.nationalId.trim(),
        },
      });

      // The account exists now, created through the admin API. Open the session
      // with the password the player just chose — the credential email is derived
      // here, in the browser, from the number they already gave us.
      await signInWithCredential(phoneToAuthEmail(phone), input.password);
    },
    [registerFn, signInWithCredential],
  );

  /** PASSWORD RESET step 1 — ask for a code on a registered number. */
  const requestResetCode = useCallback(
    async (phone: string): Promise<string> => {
      const value = requirePhone(phone);
      await requestResetFn({ data: { phone: value } });
      return value;
    },
    [requestResetFn],
  );

  /** PASSWORD RESET step 2 — verify the code, set the password, sign in. */
  const resetPassword = useCallback(
    async (phone: string, code: string, password: string): Promise<void> => {
      const value = requirePhone(phone);
      if (!/^\d{4,8}$/.test(code.trim())) {
        throw new Error("Enter the verification code sent to your phone");
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }

      await resetFn({ data: { phone: value, code: code.trim(), password } });
      await signInWithCredential(phoneToAuthEmail(value), password);
    },
    [resetFn, signInWithCredential],
  );

  /** Sets a new password for the current session (signed-in change). */
  const setPassword = useCallback(async (password: string) => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(authErrorMessage(error));
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  }, []);

  return {
    user,
    profile,
    loading,
    isAuthenticated: !!user,
    /** Phone number + password, verified through the phone-login resolver. */
    signInWithPhone,
    /** Registration: ask for the code, then `signUp()` with it. */
    requestSignupCode,
    signUp,
    /** Password reset: ask for the code, then `resetPassword()` with it. */
    requestResetCode,
    resetPassword,
    /** Change the password of an already signed-in session. */
    setPassword,
    signOut,
    refreshProfile: loadProfile,
  };
}
