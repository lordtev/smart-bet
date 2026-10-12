/**
 * routes/__root.tsx — ROOT LAYOUT.
 * Mounts global providers (React Query, BetSlipProvider), the fixed header,
 * product strip, footer, mobile bottom nav and the toast host. Also defines
 * the default SEO metadata, fonts, favicon, and a pre-paint theme script
 * that reads "smartbet-theme" from localStorage before hydration.
 * Child routes render through <Outlet /> — do not remove it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { BetSlipProvider } from "@/lib/betslip";
import { CatalogueProvider } from "../lib/catalogue";
import { getCatalogue } from "../modules/sportsbook/catalogue.functions";
import { SiteHeader } from "../components/site-header";
import { ProductStrip } from "../components/product-strip";
import { BottomNav } from "../components/bottom-nav";
import { SiteFooter } from "../components/site-footer";
import { Toaster } from "../components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "SMARTBET · Sports betting in Uganda" },
      {
        name: "description",
        content: "Bet on football, basketball and more with SMARTBET. Fast odds, live betting and instant payouts in UGX.",
      },
      { property: "og:title", content: "SMARTBET · Sports betting in Uganda" },
      {
        property: "og:description",
        content: "Fast odds, live betting and instant payouts in UGX.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Sora:wght@500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  // The catalogue (fixtures, markets and prices) is read from Supabase once per
  // page load and rendered into the HTML, so the first paint shows real odds.
  // Retry briefly: a request can drop while the preview server reloads.
  loader: async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return { catalogue: await getCatalogue() };
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('smartbet-theme');document.documentElement.classList.toggle('dark',t?t==='dark':true)}catch(e){}",
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const { catalogue } = Route.useLoaderData();

  return (
    <QueryClientProvider client={queryClient}>
      {/* CatalogueProvider hands the database fixtures/prices to every screen. */}
      <CatalogueProvider initial={catalogue}>
        <BetSlipProvider>
          {/* Reserve space for the compact header and fixed product navigation. */}
          <div className="min-h-screen bg-background pb-20 pt-24 md:pb-8">
            <SiteHeader />
            <ProductStrip />
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <Outlet />
            <SiteFooter />
            <BottomNav />
          </div>
          <Toaster />
        </BetSlipProvider>
      </CatalogueProvider>
    </QueryClientProvider>
  );
}
