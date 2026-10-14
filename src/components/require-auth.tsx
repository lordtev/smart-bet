/**
 * require-auth.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Gate for pages that only make sense for a signed-in player (wallet, bets,
 * transactions, deposits, withdrawals).
 *
 * It renders a sign-in panel instead of redirecting: the session lives in the
 * browser (localStorage), so a server-side redirect would fire for every
 * deep-link and break bookmarks. The panel keeps SSR and hydration identical and
 * gives the visitor a one-tap route to /auth without losing where they were.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";

export function RequireAuth({
  children,
  title = "Sign in to continue",
  description = "Sign in with your phone number and password to view this page.",
}: {
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <main className="mx-auto max-w-md px-3 py-10 text-center text-sm text-muted-foreground">
        Loading your account…
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="mx-auto max-w-md px-3 py-10">
        <section className="space-y-3 rounded-lg border border-border bg-card p-6 text-center">
          <LogIn className="mx-auto h-7 w-7 text-muted-foreground" />
          <h1 className="font-display text-xl font-bold uppercase tracking-wide">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          <Button asChild className="w-full">
            <Link to="/auth">Sign in or register</Link>
          </Button>
          <Link to="/" className="block text-xs font-semibold text-muted-foreground">
            Browse sports without signing in
          </Link>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
