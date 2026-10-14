/**
 * auth/phone.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phone-number helpers shared by the browser and the server.
 *
 * SMARTBET is phone-only: the phone number IS the account identifier, and there
 * is no email address anywhere in the sign-up or sign-in flow. Supabase Auth
 * credentials still *require* an email field, so we derive a deterministic
 * synthetic address from the normalised phone number and hand it to GoTrue
 * internally (see `phoneToAuthEmail`). The player never sees it and it is never
 * stored on `profiles.email`.
 *
 * INTEGRATION NOTES:
 * - Default country is Uganda (+256). Local numbers such as "0772 000 000" are
 *   normalised to "+256772000000".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Domain used for the synthetic auth address. Not a deliverable mailbox. */
export const PHONE_AUTH_EMAIL_DOMAIN = "phone.smartbet.app";

/**
 * ── OTP DELIVERY ────────────────────────────────────────────────────────────
 * ⚠ MOCK MODE: no SMS gateway is connected yet, so every verification code is
 * the fixed value below and the UI tells the player so. The code is still
 * checked on the server against the `phone_otps` row, exactly as a real one
 * would be — only the "send" half is stubbed.
 *
 * WHEN THE SMS PROVIDER LANDS (Twilio Verify, Africa's Talking, …):
 *   1. set `SMS_PROVIDER_CONFIGURED = true`;
 *   2. send the generated code inside `requestOtp()` instead of returning it;
 *   3. delete `MOCK_OTP_CODE` (and the on-screen hint that quotes it).
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The stand-in code accepted while no SMS provider is connected. */
export const MOCK_OTP_CODE = "12345";

/** Flip to true — and delete MOCK_OTP_CODE — once a gateway sends real codes. */
export const SMS_PROVIDER_CONFIGURED = false;

/** How many digits the code input renders / accepts. */
export const OTP_LENGTH = MOCK_OTP_CODE.length;

/**
 * Shown under the code input while delivery is mocked. Returns null once a real
 * provider is configured, so the hint disappears on its own.
 */
export function mockOtpHint(): string | null {
  if (SMS_PROVIDER_CONFIGURED) return null;
  return `No SMS provider is connected yet — enter the demo code ${MOCK_OTP_CODE}.`;
}

/**
 * Normalise a user-typed phone number to E.164 (+256XXXXXXXXX for Uganda).
 * Returns null when the number cannot be understood.
 */
export function normalizePhone(input: string): string | null {
  const digits = (input ?? "").replace(/[^\d+]/g, "");
  if (!digits) return null;

  let msisdn: string;
  if (digits.startsWith("+")) {
    msisdn = digits.slice(1);
  } else if (digits.startsWith("00")) {
    msisdn = digits.slice(2);
  } else if (digits.startsWith("0")) {
    // Local Ugandan format: 0772000000 -> 256772000000
    msisdn = `256${digits.slice(1)}`;
  } else if (digits.startsWith("256")) {
    msisdn = digits;
  } else {
    // Bare subscriber number, e.g. 772000000
    msisdn = `256${digits}`;
  }

  if (!/^\d{9,15}$/.test(msisdn)) return null;
  return `+${msisdn}`;
}

/** Deterministic credential email for a normalised phone number. */
export function phoneToAuthEmail(normalizedPhone: string): string {
  return `${normalizedPhone.replace("+", "")}@${PHONE_AUTH_EMAIL_DOMAIN}`;
}

/** Pretty display form used in the UI, e.g. +256 772 000 000. */
export function formatPhone(normalizedPhone: string): string {
  const m = /^\+256(\d{3})(\d{3})(\d{3})$/.exec(normalizedPhone);
  return m ? `+256 ${m[1]} ${m[2]} ${m[3]}` : normalizedPhone;
}
