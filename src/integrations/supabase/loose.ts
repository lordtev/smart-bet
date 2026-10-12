import type { SupabaseClient } from "@supabase/supabase-js";

// The app modules target the planned sportsbook schema, which is not yet in
// the generated types. Until the database is migrated, query through an
// untyped client so the build compiles. Remove once types.ts is regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseClient = SupabaseClient<any, "public", any>;
export const loose = (client: unknown) => client as LooseClient;
