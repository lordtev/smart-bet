-- =====================================================================
-- SMARTBET — PHONE-ONLY SIGN-UP (no email anywhere)
-- =====================================================================
-- Run this AFTER 20260101000500_phone_login.sql.
--
-- WHAT CHANGED IN THE APP
--   Registration and sign-in now begin and end with a phone number. No email
--   address is collected, shown, stored as contact detail or used as a
--   credential the player can see:
--
--     register  phone → one-time code → details + password
--     sign in   phone + password
--     reset     phone → one-time code → new password
--
--   Supabase Auth still has to store an email for every credential, so the app
--   derives a deterministic SYNTHETIC address from the phone number
--   ("+256772000000" → "256772000000@phone.smartbet.app" — see
--   src/modules/auth/phone.ts). It is an internal implementation detail: it is
--   never typed by a player, never sent over the wire, and — the point of this
--   file — never stored on `profiles.email`.
--
--   ⚠ One-time codes are MOCKED ("12345") until an SMS gateway is connected.
--     The verification is real (phone_otps: expiry, attempt count, burn-on-use);
--     only delivery is stubbed. See modules/auth/phone.ts to go live.
--
-- WHAT THIS FILE CHANGES
--   1. handle_new_user() — ignores synthetic addresses, so `profiles.email` stays
--      NULL for phone accounts, and builds a username from the player's name or
--      phone number instead of an email local part.
--   2. Cleans up any synthetic address an earlier signup already stored.
--   3. Makes the phone number unique (guarded: only when no duplicates exist),
--      so two accounts can never share one number — which is what the
--      phone-login resolver relies on to be unambiguous.
--
-- DASHBOARD SETTINGS THAT MUST MATCH (Authentication → Sign In / Providers)
--   * Email provider ......... ENABLED  ← still required: GoTrue stores every
--                               credential, including the synthetic ones, as an
--                               email. Players never see or type an address.
--   * Confirm email .......... OFF is fine (accounts are created with the admin
--                               API and `email_confirm: true`)
--   * Phone provider ......... leave DISABLED until a real SMS gateway exists
--   * Minimum password length  ≥ 8 (the app enforces 8 as well)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A SYNTHETIC ADDRESS IS NEVER CONTACT DETAIL
-- ---------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_display  text  := nullif(trim(coalesce(v_meta ->> 'display_name', v_meta ->> 'full_name', '')), '');
  v_first    text;
  v_last     text;
  v_username text;
  v_phone    text  := nullif(trim(coalesce(v_meta ->> 'phone', '')), '');
  v_country  text  := upper(nullif(trim(coalesce(v_meta ->> 'country_code', '')), ''));
  v_dob      text  := nullif(trim(coalesce(v_meta ->> 'date_of_birth', '')), '');
  v_national text  := nullif(trim(coalesce(v_meta ->> 'national_id', '')), '');
  v_email    text;
begin
  -- The credential address GoTrue holds for a phone account is made up. Storing
  -- it would put an undeliverable mailbox in front of the player as if it were
  -- theirs, so it is dropped here and only a real address would ever survive.
  v_email := case
    when new.email is null or new.email = '' then null
    when new.email like '%@phone.smartbet.app' then null
    else new.email
  end;

  -- "Jane Nakato" → first_name 'Jane', last_name 'Nakato'
  if v_display is not null then
    v_first := split_part(v_display, ' ', 1);
    v_last  := nullif(trim(substr(v_display, length(v_first) + 1)), '');
  end if;

  -- Username from metadata, else the player's name, else the phone digits.
  -- De-duplicated so the unique constraint can never make a signup fail.
  v_username := nullif(
    lower(regexp_replace(
      coalesce(
        nullif(trim(coalesce(v_meta ->> 'username', '')), ''),
        v_display,
        split_part(coalesce(v_email, ''), '@', 1),
        regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g')
      ),
      '[^a-zA-Z0-9_]', '', 'g')),
    '');
  if v_username is not null and exists (select 1 from profiles p where p.username = v_username) then
    v_username := v_username || '_' || substr(md5(random()::text), 1, 4);
  end if;

  insert into profiles (
    id, email, username, phone, first_name, last_name,
    date_of_birth, country_code, national_id, terms_accepted_at
  ) values (
    new.id, v_email, v_username, v_phone, v_first, v_last,
    case when v_dob ~ '^\d{4}-\d{2}-\d{2}$' then v_dob::date else null end,
    case when length(v_country) = 2 then v_country::char(2) else null end,
    v_national,
    case when coalesce((v_meta ->> 'terms_accepted')::boolean, false) then now() else null end
  )
  on conflict (id) do nothing;

  -- Every player starts with a UGX wallet (unique on user_id + currency).
  insert into wallets (user_id, currency) values (new.id, 'UGX')
  on conflict (user_id, currency) do nothing;

  return new;
end $$;

-- The trigger itself is unchanged; recreate it only if it went missing.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------
-- 2. CLEAR SYNTHETIC ADDRESSES FROM EARLIER SIGNUPS
-- ---------------------------------------------------------------------
-- Accounts created before this file may carry the made-up address on their
-- profile. They keep signing in exactly as before — the phone number and the
-- password are what matter.
update profiles
   set email = null
 where email is not null
   and email like '%@phone.smartbet.app';

-- ---------------------------------------------------------------------
-- 3. ONE ACCOUNT PER PHONE NUMBER
-- ---------------------------------------------------------------------
-- The resolver refuses to guess when a number matches several accounts, so this
-- index removes the ambiguity for players. It is created only when the existing
-- data is already clean, so running this file can never fail halfway.
do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes
  from (
    select phone
      from profiles
     where phone is not null
     group by phone
    having count(*) > 1
  ) d;

  if v_dupes = 0 then
    create unique index if not exists profiles_phone_unique
      on profiles (phone) where phone is not null;
    raise notice 'profiles_phone_unique created — one account per phone number.';
  else
    raise notice 'Skipped profiles_phone_unique: % phone number(s) are shared by several accounts. Resolve them, then re-run section 3.', v_dupes;
  end if;
end $$;

-- =====================================================================
-- VERIFY
-- =====================================================================
-- Register a test account in the app (any phone number, code 12345), then:
--   select p.id, p.phone, p.username, p.first_name, p.last_name,
--          p.email as contact_email,          -- expect NULL
--          p.national_id, p.terms_accepted_at,
--          u.email as credential_email,       -- expect <digits>@phone.smartbet.app
--          u.email_confirmed_at, u.last_sign_in_at,
--          w.currency, w.balance
--     from profiles p
--     join auth.users u on u.id = p.id
--     left join wallets w on w.user_id = p.id
--    order by p.created_at desc limit 3;
--
-- One-time codes issued for that number (newest first):
--   select phone, code, purpose, attempts, expires_at, consumed_at, created_at
--     from phone_otps order by created_at desc limit 10;
--
-- Sign-in attempts through the phone resolver:
--   select identifier, success, attempted_at from login_attempts
--    order by attempted_at desc limit 20;
-- =====================================================================
