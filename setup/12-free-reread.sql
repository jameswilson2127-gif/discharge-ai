-- 12 — Same pages read again within an hour are not charged again (see fn-extract.ts).
-- photo_sig is a one-way SHA-256 fingerprint of the photos; the photos themselves are never stored.
alter table public.usage_events add column if not exists photo_sig text;
alter table public.usage_events add column if not exists charged boolean not null default true;
create index if not exists usage_events_reread_idx on public.usage_events (user_id, photo_sig, created_at) where photo_sig is not null;
