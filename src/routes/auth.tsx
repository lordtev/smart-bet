/**
 * routes/auth.tsx — SIGN IN / REGISTER / PASSWORD.
 *
 * SMARTBET is **phone-only**: every flow starts with a phone number. No email
 * address is collected, shown or required at any point.
 *
 *   signin   → phone + password (verified through the phone-login resolver)
 *   register → phone → one-time code → details + password → account created
 *   reset    → phone → one-time code → new password   ("forgot password")
 *   change   → new password for an already signed-in session
 *
 * Passwords are hashed and checked by Supabase Auth (GoTrue); this page only
 * collects them and shows the outcome. The account behind the scenes is keyed by
 * a synthetic address derived from the phone number (modules/auth/phone.ts) —
 * the player never sees it.
 *
 * ⚠ One-time codes are MOCKED ("12345") until an SMS gateway is connected, so the
 * code panel says so on screen. See modules/auth/phone.ts to go live.
 *
 * The profile + wallet rows and the registration details are created by the
 * `handle_new_user` trigger — see supabase/migrations/20260101000600_phone_only_signup.sql.
 */
import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { MIN_PASSWORD_LENGTH, useAuth } from "@/hooks/use-auth";
import { OTP_LENGTH, formatPhone, mockOtpHint } from "@/modules/auth/phone";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in or register · SMARTBET" },
      {
        name: "description",
        content:
          "Sign in to SMARTBET with your phone number and password, or open an account in a minute. Players must be 25+.",
      },
      { property: "og:title", content: "Sign in or register · SMARTBET" },
      {
        property: "og:description",
        content: "Access your SMARTBET account or open a new one with your phone number.",
      },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "register" | "reset" | "change";

/** Shared one-time-code field, with the mock-delivery notice while it applies. */
function CodeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const hint = mockOtpHint();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="otp-code">Verification code</Label>
      <InputOTP
        id="otp-code"
        maxLength={OTP_LENGTH}
        value={value}
        onChange={onChange}
        pattern="^\d+$"
        inputMode="numeric"
        autoComplete="one-time-code"
      >
        <InputOTPGroup>
          {Array.from({ length: OTP_LENGTH }, (_, i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AuthPage() {
  const router = useRouter();
  const {
    isAuthenticated,
    loading: authLoading,
    profile,
    signInWithPhone,
    requestSignupCode,
    signUp,
    requestResetCode,
    resetPassword,
    setPassword,
    signOut,
  } = useAuth();

  const [mode, setMode] = useState<Mode>("signin");
  const [pending, setPending] = useState(false);
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState("");

  /** Registration: the number as typed, plus the number a code went to. */
  const [regPhone, setRegPhone] = useState("");
  const [regCodeSentTo, setRegCodeSentTo] = useState<string | null>(null);
  /** Password reset: the same pair. */
  const [resetPhone, setResetPhone] = useState("");
  const [resetCodeSentTo, setResetCodeSentTo] = useState<string | null>(null);

  /**
   * Editing a number invalidates any code already sent to the previous one, so
   * the player cannot submit a code that belongs to a different phone.
   */
  function changePhone(
    value: string,
    sentTo: string | null,
    setPhone: (v: string) => void,
    setSentTo: (v: string | null) => void,
  ) {
    setPhone(value);
    if (sentTo) {
      setSentTo(null);
      setCode("");
    }
  }

  /** Runs `work`, keeping the button disabled and reporting failures. */
  async function run(work: () => Promise<void>) {
    setPending(true);
    try {
      await work();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(false);
    }
  }

  /* ── Sign in: phone + password ──────────────────────────────────────────── */
  function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const phone = (form.elements.namedItem("login-phone") as HTMLInputElement).value;
    const password = (form.elements.namedItem("login-pass") as HTMLInputElement).value;

    void run(async () => {
      await signInWithPhone(phone, password);
      toast.success("Signed in");
      await router.navigate({ to: "/" });
    });
  }

  /* ── Register: text a code to the number typed in the form ──────────────── */
  function handleSendSignupCode() {
    void run(async () => {
      const normalized = await requestSignupCode(regPhone);
      setRegCodeSentTo(normalized);
      setCode("");
      toast.success(`Code sent to ${formatPhone(normalized)}`);
    });
  }

  /* ── Register: prove the number and create the account ──────────────────── */
  function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!regCodeSentTo) {
      toast.error("Send yourself a verification code first");
      return;
    }
    if (!agree) {
      toast.error("You must confirm you are 25 or older");
      return;
    }
    const form = e.currentTarget;
    const fullName = (form.elements.namedItem("reg-name") as HTMLInputElement).value;
    const dateOfBirth = (form.elements.namedItem("reg-dob") as HTMLInputElement).value;
    const nationalId = (form.elements.namedItem("reg-national-id") as HTMLInputElement).value;
    const password = (form.elements.namedItem("reg-pass") as HTMLInputElement).value;
    const confirm = (form.elements.namedItem("reg-pass-confirm") as HTMLInputElement).value;

    if (password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      toast.error("The two passwords do not match");
      return;
    }

    void run(async () => {
      await signUp({
        fullName,
        phone: regCodeSentTo,
        dateOfBirth,
        nationalId,
        password,
        code,
        termsAccepted: agree,
      });
      toast.success("Account created — you are signed in");
      await router.navigate({ to: "/" });
    });
  }

  /* ── Reset: text a code to the registered number typed in the form ──────── */
  function handleSendResetCode() {
    void run(async () => {
      const normalized = await requestResetCode(resetPhone);
      setResetCodeSentTo(normalized);
      setCode("");
      toast.success(`Code sent to ${formatPhone(normalized)}`);
    });
  }

  /* ── Reset: prove the number and set the new password ───────────────────── */
  function handleResetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetCodeSentTo) {
      toast.error("Send yourself a verification code first");
      return;
    }
    const form = e.currentTarget;
    const password = (form.elements.namedItem("reset-pass") as HTMLInputElement).value;
    const confirm = (form.elements.namedItem("reset-pass-confirm") as HTMLInputElement).value;
    if (password !== confirm) {
      toast.error("The two passwords do not match");
      return;
    }

    void run(async () => {
      await resetPassword(resetCodeSentTo, code, password);
      toast.success("Password updated — you are signed in");
      await router.navigate({ to: "/" });
    });
  }

  /* ── Password change for an already signed-in player ────────────────────── */
  function handleChangePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = (form.elements.namedItem("new-pass") as HTMLInputElement).value;
    const confirm = (form.elements.namedItem("new-pass-confirm") as HTMLInputElement).value;
    if (password !== confirm) {
      toast.error("The two passwords do not match");
      return;
    }

    void run(async () => {
      await setPassword(password);
      toast.success("Password updated");
      setMode("signin");
    });
  }

  /* ── Signed in: account summary ─────────────────────────────────────────── */
  if (!authLoading && isAuthenticated && mode !== "change") {
    const name =
      [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
      profile?.username ||
      (profile?.phone ? formatPhone(profile.phone) : null) ||
      "player";

    return (
      <main className="mx-auto max-w-md px-3 py-6">
        <h1 className="mb-4 font-display text-2xl font-bold uppercase tracking-wide">My account</h1>
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-semibold">Signed in as {name}</p>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="font-semibold">{profile?.phone ? formatPhone(profile.phone) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Verification</dt>
              <dd className="font-semibold capitalize">{profile?.kyc_status ?? "—"}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <Link to="/transactions" className="text-xs font-bold text-accent">
              Transactions
            </Link>
            <Link to="/my-bets" className="text-xs font-bold text-accent">
              My bets
            </Link>
            <Link to="/deposit" className="text-xs font-bold text-accent">
              Deposit
            </Link>
          </div>
          <Button type="button" variant="ghost" className="w-full" onClick={() => void signOut()}>
            Sign out
          </Button>
          <div className="space-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <p>
              {profile?.phone
                ? `You sign in with ${formatPhone(profile.phone)} and your password.`
                : "You sign in with your phone number and password."}
            </p>
            <p>
              <button
                type="button"
                className="font-semibold text-accent"
                onClick={() => setMode("change")}
              >
                Change my password
              </button>{" "}
              — you are signed in, so no verification code is needed.
            </p>
          </div>
        </section>
      </main>
    );
  }

  /* ── Change password (signed in) ────────────────────────────────────────── */
  if (mode === "change") {
    return (
      <main className="mx-auto max-w-md px-3 py-6">
        <h1 className="mb-4 font-display text-2xl font-bold uppercase tracking-wide">
          Change password
        </h1>
        <form
          className="space-y-4 rounded-lg border border-border bg-card p-4"
          onSubmit={handleChangePassword}
        >
          <p className="text-sm text-muted-foreground">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="new-pass">New password</Label>
            <Input
              id="new-pass"
              name="new-pass"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pass-confirm">Repeat password</Label>
            <Input
              id="new-pass-confirm"
              name="new-pass-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Saving…" : "Save password"}
          </Button>
          <button
            type="button"
            className="w-full text-xs font-semibold text-muted-foreground"
            onClick={() => setMode("signin")}
          >
            Back to my account
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-3 py-6">
      <h1 className="mb-4 font-display text-2xl font-bold uppercase tracking-wide">
        Welcome to SMARTBET
      </h1>

      {mode === "reset" ? (
        /* ── Forgot password: number + code + new password, one form ─────── */
        <form
          className="space-y-4 rounded-lg border border-border bg-card p-4"
          onSubmit={handleResetPassword}
        >
          <div>
            <p className="font-semibold">Reset your password</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the phone number on your account and we will text you a code that lets you set a
              new password.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-phone">Phone number</Label>
            <div className="flex gap-2">
              <Input
                id="reset-phone"
                name="reset-phone"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0772 000 000"
                value={resetPhone}
                onChange={(e) =>
                  changePhone(e.target.value, resetCodeSentTo, setResetPhone, setResetCodeSentTo)
                }
                required
              />
              <Button
                type="button"
                variant="secondary"
                className="shrink-0"
                onClick={handleSendResetCode}
                disabled={pending || !resetPhone.trim()}
              >
                {resetCodeSentTo ? "Resend" : "Send code"}
              </Button>
            </div>
            {resetCodeSentTo && (
              <p className="text-[11px] text-muted-foreground">
                Code sent to {formatPhone(resetCodeSentTo)}.
              </p>
            )}
          </div>
          <CodeField value={code} onChange={setCode} />
          <div className="space-y-1.5">
            <Label htmlFor="reset-pass">New password</Label>
            <Input
              id="reset-pass"
              name="reset-pass"
              type="password"
              autoComplete="new-password"
              placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-pass-confirm">Repeat password</Label>
            <Input
              id="reset-pass-confirm"
              name="reset-pass-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={pending || !resetCodeSentTo || code.length < OTP_LENGTH}
          >
            {pending ? "Saving…" : "Save password and sign in"}
          </Button>
          <button
            type="button"
            className="w-full text-xs font-semibold text-muted-foreground"
            onClick={() => setMode("signin")}
          >
            Back to sign in
          </button>
        </form>
      ) : (
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>

          {/* ── Sign in ───────────────────────────────────────────────────── */}
          <TabsContent value="signin" className="mt-4 space-y-4">
            <form
              className="space-y-4 rounded-lg border border-border bg-card p-4"
              onSubmit={handleSignIn}
            >
              <div className="space-y-1.5">
                <Label htmlFor="login-phone">Phone number</Label>
                <Input
                  id="login-phone"
                  name="login-phone"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0772 000 000"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-pass">Password</Label>
                <Input
                  id="login-pass"
                  name="login-pass"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Signing in…" : "Sign in"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setResetPhone("");
                  setResetCodeSentTo(null);
                  setCode("");
                  setMode("reset");
                }}
                className="w-full text-xs font-semibold text-muted-foreground"
              >
                Forgot password?
              </button>
            </form>
          </TabsContent>

          {/* ── Register ──────────────────────────────────────────────────── */}
          <TabsContent value="register" className="mt-4 space-y-4">
            <form
              className="space-y-4 rounded-lg border border-border bg-card p-4"
              onSubmit={handleRegister}
            >
              <div>
                <p className="font-semibold">Open an account</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your phone number is your account. Tap “Send code” to confirm it, then fill in the
                  rest — there is no email to give us.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-phone">Phone number</Label>
                <div className="flex gap-2">
                  <Input
                    id="reg-phone"
                    name="reg-phone"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="0772 000 000"
                    value={regPhone}
                    onChange={(e) =>
                      changePhone(e.target.value, regCodeSentTo, setRegPhone, setRegCodeSentTo)
                    }
                    required
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={handleSendSignupCode}
                    disabled={pending || !regPhone.trim()}
                  >
                    {regCodeSentTo ? "Resend" : "Send code"}
                  </Button>
                </div>
                {regCodeSentTo && (
                  <p className="text-[11px] text-muted-foreground">
                    Code sent to {formatPhone(regCodeSentTo)}.
                  </p>
                )}
              </div>
              <CodeField value={code} onChange={setCode} />
              <div className="space-y-1.5">
                <Label htmlFor="reg-name">Full name</Label>
                <Input id="reg-name" name="reg-name" placeholder="Jane Nakato" required />
              </div>
              {/* National ID (NIN) — required now, verified in the KYC phase. */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-national-id">National ID number</Label>
                <Input
                  id="reg-national-id"
                  name="reg-national-id"
                  placeholder="e.g. CF1234567890AB"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-dob">Date of birth</Label>
                <Input id="reg-dob" name="reg-dob" type="date" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass">Password</Label>
                  <Input
                    id="reg-pass"
                    name="reg-pass"
                    type="password"
                    autoComplete="new-password"
                    placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
                    minLength={MIN_PASSWORD_LENGTH}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass-confirm">Repeat password</Label>
                  <Input
                    id="reg-pass-confirm"
                    name="reg-pass-confirm"
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    minLength={MIN_PASSWORD_LENGTH}
                    required
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} />
                <span>
                  I am 25 years or older and accept the terms and responsible gaming policy.
                </span>
              </label>
              <Button
                type="submit"
                className="w-full"
                disabled={pending || !regCodeSentTo || code.length < OTP_LENGTH}
              >
                {pending ? "Creating account…" : "Create account"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Your password is stored and checked by Supabase Auth — SMARTBET never sees it.
              </p>
            </form>
          </TabsContent>
        </Tabs>
      )}

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Betting is for players aged 25 and above. Play responsibly.
      </p>
    </main>
  );
}
