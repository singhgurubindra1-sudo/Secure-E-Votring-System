-- ============================================================================
-- Secure E-Voting: the two tables the portal writes to.
--
-- votes   - one sealed ballot per voter ID, stored with NO link to the voter
-- tickets - complaints raised from the portal, which ARE linked to a person
--
-- The asymmetry is deliberate and is the whole security property of the
-- system: a ticket has to be traceable so it can be answered, a ballot must
-- not be traceable at all.
--
-- Applied to project bgscnhrdmipgetbkksmd as migration
-- 20260917121537_create_votes_and_tickets. Kept here so the schema is in
-- version control rather than existing only in the hosted project.
-- ============================================================================

-- ---------------------------------------------------------------- votes ----
create table public.votes (
  id           bigint generated always as identity primary key,

  -- HMAC-SHA256 of the normalised voter ID, peppered with the server secret.
  -- This is what makes the ballot unlinkable: it is enough to stop the same
  -- person voting twice, and it cannot be reversed to a voter ID. Nothing
  -- else identifying the voter belongs in this table -- no name, no voter ID,
  -- no account id, no email, no IP.
  voter_key    text        not null,

  candidate_id text        not null,

  -- Coarse geography only, for regional tallies. District plus state is not
  -- narrow enough to single anyone out on a real roll.
  district     text,
  state        text,

  -- Handed to the voter so they can prove a ballot was recorded, without
  -- revealing which one it was.
  receipt      text        not null,

  cast_at      timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  -- One ballot per voter ID, enforced by the database rather than by a
  -- read-then-write check in application code that two concurrent requests
  -- could both pass.
  constraint votes_voter_key_unique unique (voter_key),
  constraint votes_receipt_unique   unique (receipt),

  constraint votes_voter_key_is_sha256 check (voter_key ~ '^[0-9a-f]{64}$'),
  constraint votes_candidate_id_present check (length(btrim(candidate_id)) > 0)
);

comment on table public.votes is
  'Sealed ballots. Deliberately holds no link to the voter: voter_key is a one-way HMAC of the voter ID, used only to enforce one ballot each.';
comment on column public.votes.voter_key is
  'HMAC-SHA256 hex of the normalised voter ID. One way. Never store the voter ID itself here.';
comment on column public.votes.receipt is
  'Receipt shown to the voter. Proves a ballot was recorded; reveals nothing about the choice.';

create index votes_candidate_id_idx on public.votes (candidate_id);
create index votes_region_idx       on public.votes (state, district);
create index votes_cast_at_idx      on public.votes (cast_at desc);

-- -------------------------------------------------------------- tickets ----
create table public.tickets (
  id           bigint generated always as identity primary key,

  reference    text        not null,

  -- A complaint has to be answerable, so unlike a ballot it keeps the contact
  -- details of the person who raised it.
  name         text        not null,
  email        text        not null,
  phone        text,

  category     text        not null default 'General',
  issue        text        not null,

  -- Portal account that raised it, so a voter can list their own tickets.
  raised_by    text,

  status       text        not null default 'open',

  -- [{ originalName, storedName, mimeType, size }]. The absolute disk path is
  -- deliberately not persisted.
  attachments  jsonb       not null default '[]'::jsonb,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint tickets_reference_unique unique (reference),
  constraint tickets_status_allowed
    check (status in ('open', 'in_review', 'resolved', 'rejected')),
  constraint tickets_issue_min_length check (length(btrim(issue)) >= 15),
  constraint tickets_email_shape      check (position('@' in email) > 1),
  constraint tickets_attachments_is_array check (jsonb_typeof(attachments) = 'array')
);

comment on table public.tickets is
  'Complaints raised from the portal. Linked to the person on purpose, so they can be answered and chased.';
comment on column public.tickets.attachments is
  'Array of attachment metadata. Stores originalName, storedName, mimeType and size only, never the absolute path on disk.';

create index tickets_created_at_idx on public.tickets (created_at desc);
create index tickets_status_idx     on public.tickets (status);
create index tickets_raised_by_idx  on public.tickets (raised_by);

-- Keeps updated_at honest when a ticket's status moves. now() is
-- transaction-scoped on purpose: every row touched by one transaction gets
-- the same stamp.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tickets_touch_updated_at
  before update on public.tickets
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ RLS ----
-- Both tables carry either ballots or personal contact details, so neither is
-- readable with the publishable (anon) key. RLS is enabled with NO policies:
-- that denies every browser-side client outright. The portal's own server
-- reaches these tables with the service-role key, which bypasses RLS and must
-- never be shipped to a browser.
alter table public.votes   enable row level security;
alter table public.tickets enable row level security;
