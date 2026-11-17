-- Run after setup.sql and enable-withdrawal.sql in the Supabase SQL Editor.
-- Safe to rerun; existing responses, receipts, and active locks are preserved.
begin;

create table if not exists public.human_group_locks (
    version text not null,
    group_id text not null,
    token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
    status text not null check (status in ('in_progress', 'completed')),
    updated_at timestamptz not null default now(),
    primary key (version, group_id),
    foreign key (version, group_id) references public.human_study_groups(version, group_id)
);

alter table public.human_group_locks enable row level security;
revoke all on public.human_group_locks from public, anon, authenticated;

-- Backfill locks from any active non-withdrawn receipts.
insert into public.human_group_locks (version, group_id, token_hash, status, updated_at)
select distinct on (r.version, r.group_id)
    r.version, r.group_id, r.token_hash, 'completed', now()
from public.human_submission_receipts as r
where not r.withdrawn
order by r.version, r.group_id, r.token_hash
on conflict (version, group_id) do update
set status = 'completed',
    updated_at = now();

-- Backfill locks from any existing responses that predate receipts.
insert into public.human_group_locks (version, group_id, token_hash, status, updated_at)
select distinct on (resp.version, resp.group_id)
    resp.version,
    resp.group_id,
    encode(sha256(convert_to('legacy:' || resp.version || ':' || resp.group_id || ':' || resp.english_name, 'UTF8')), 'hex'),
    'completed',
    now()
from public.human_responses as resp
order by resp.version, resp.group_id, resp.english_name
on conflict (version, group_id) do update
set status = 'completed',
    updated_at = now();

-- Private helper for claiming and releasing a group lock.
create or replace function public.human_group_lock_identity(payload jsonb)
returns text
language plpgsql
set search_path = ''
as $function$
declare
    raw_token text;
begin
    if jsonb_typeof(payload) is distinct from 'object'
       or jsonb_typeof(payload -> 'group_id') is distinct from 'string'
       or jsonb_typeof(payload -> 'version') is distinct from 'string'
       or pg_column_size(payload) > 2500000 then
        raise exception 'Invalid group lock request.' using errcode = '22023';
    end if;
    raw_token := coalesce(payload ->> 'lock_token', payload ->> 'receipt_token', '');
    if raw_token !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid group lock token.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.human_study_groups
        where version = payload ->> 'version' and group_id = payload ->> 'group_id'
    ) then
        raise exception 'Unknown group or dataset version.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array('group_lock', payload ->> 'version', payload ->> 'group_id')::text, 0));
    return encode(sha256(convert_to(raw_token, 'UTF8')), 'hex');
end;
$function$;
revoke all on function public.human_group_lock_identity(jsonb) from public, anon, authenticated;

-- Public endpoint to inspect which groups are locked and whether the caller holds the lock.
create or replace function public.list_human_group_locks(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    data_version text;
    tokens jsonb;
    result jsonb;
begin
    if jsonb_typeof(payload) is distinct from 'object'
       or jsonb_typeof(payload -> 'version') is distinct from 'string'
       or pg_column_size(payload) > 100000 then
        raise exception 'Invalid group status request.' using errcode = '22023';
    end if;
    data_version := payload ->> 'version';
    tokens := case
        when jsonb_typeof(payload -> 'tokens') = 'object' then payload -> 'tokens'
        else '{}'::jsonb
    end;

    select coalesce(
        jsonb_object_agg(
            l.group_id,
            jsonb_build_object(
                'status', l.status,
                'mine', (
                    jsonb_typeof(tokens -> l.group_id) = 'string'
                    and (tokens ->> l.group_id) ~ '^[0-9a-f]{64}$'
                    and encode(sha256(convert_to(tokens ->> l.group_id, 'UTF8')), 'hex') = l.token_hash
                )
            )
        ),
        '{}'::jsonb
    )
    into result
    from public.human_group_locks as l
    where l.version = data_version;

    return jsonb_build_object('groups', result);
end;
$function$;

-- Public endpoint to lock a group when starting it.
create or replace function public.claim_human_group(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    data_version text;
    group_key text;
    current_lock public.human_group_locks%rowtype;
begin
    key_hash := public.human_group_lock_identity(payload);
    data_version := payload ->> 'version';
    group_key := payload ->> 'group_id';

    select * into current_lock
    from public.human_group_locks
    where version = data_version and group_id = group_key;

    if found then
        if current_lock.token_hash = key_hash then
            return jsonb_build_object('claimed', true, 'status', current_lock.status);
        end if;
        if current_lock.status = 'completed' then
            raise exception 'This group has already been completed by another participant. Please choose another group.'
                using errcode = '23505';
        end if;
        raise exception 'This group is currently being answered by another participant. Please choose another group.'
            using errcode = '23505';
    end if;

    if exists (
        select 1 from public.human_responses
        where version = data_version and group_id = group_key
    ) then
        raise exception 'This group has already been completed by another participant. Please choose another group.'
            using errcode = '23505';
    end if;

    insert into public.human_group_locks (version, group_id, token_hash, status, updated_at)
    values (data_version, group_key, key_hash, 'in_progress', now());

    return jsonb_build_object('claimed', true, 'status', 'in_progress');
end;
$function$;

-- Public endpoint to release an in-progress group lock when clearing the group.
create or replace function public.release_human_group(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    data_version text;
    group_key text;
    current_lock public.human_group_locks%rowtype;
begin
    key_hash := public.human_group_lock_identity(payload);
    data_version := payload ->> 'version';
    group_key := payload ->> 'group_id';

    select * into current_lock
    from public.human_group_locks
    where version = data_version and group_id = group_key;

    if not found then
        return jsonb_build_object('released', true);
    end if;

    if current_lock.token_hash <> key_hash then
        raise exception 'This group is locked by another participant and cannot be cleared from this browser.'
            using errcode = '42501';
    end if;

    if current_lock.status = 'completed' or exists (
        select 1 from public.human_responses
        where version = data_version and group_id = group_key
    ) then
        raise exception 'This group has already been submitted. Withdraw the submission before clearing it.'
            using errcode = '22023';
    end if;

    delete from public.human_group_locks
    where version = data_version and group_id = group_key and token_hash = key_hash;

    return jsonb_build_object('released', true);
end;
$function$;

-- Updated submission endpoint enforcing single-participant group locks.
create or replace function public.submit_human_group_v2(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    lock_hash text;
    legacy_hash text;
    participant text;
    group_key text;
    data_version text;
    receipt public.human_submission_receipts%rowtype;
    current_lock public.human_group_locks%rowtype;
    result jsonb;
begin
    key_hash := public.human_receipt_identity(payload);
    participant := btrim(payload ->> 'english_name');
    group_key := payload ->> 'group_id';
    data_version := payload ->> 'version';

    perform pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array('group_lock', data_version, group_key)::text, 0));

    if jsonb_typeof(payload -> 'lock_token') = 'string'
       and (payload ->> 'lock_token') ~ '^[0-9a-f]{64}$' then
        lock_hash := encode(sha256(convert_to(payload ->> 'lock_token', 'UTF8')), 'hex');
    else
        lock_hash := key_hash;
    end if;
    legacy_hash := encode(sha256(convert_to('legacy:' || data_version || ':' || group_key || ':' || participant, 'UTF8')), 'hex');

    select * into current_lock
    from public.human_group_locks
    where version = data_version and group_id = group_key;

    if found and current_lock.token_hash <> lock_hash
       and current_lock.token_hash <> key_hash
       and current_lock.token_hash <> legacy_hash then
        raise exception 'This group is locked by another participant. Please choose another group.'
            using errcode = '23505';
    end if;

    if exists (
        select 1 from public.human_responses as r
        where r.version = data_version and r.group_id = group_key and r.english_name <> participant
    ) then
        raise exception 'This group has already been completed by another participant. Please choose another group.'
            using errcode = '23505';
    end if;

    select * into receipt from public.human_submission_receipts where token_hash = key_hash;
    if found then
        if receipt.english_name <> participant
           or receipt.group_id <> group_key
           or receipt.version <> data_version then
            raise exception 'This receipt belongs to a different submission.' using errcode = '42501';
        end if;
        if receipt.withdrawn then
            raise exception 'This submission was withdrawn. Return to your draft before submitting again.'
                using errcode = '22023';
        end if;
    else
        if exists (
            select 1 from public.human_submission_receipts
            where group_id = group_key and version = data_version
              and not withdrawn
        ) then
            raise exception 'This group was already submitted. Please choose another group.'
                using errcode = '42501';
        end if;
        insert into public.human_submission_receipts(token_hash, english_name, group_id, version)
        values (key_hash, participant, group_key, data_version);
    end if;

    result := public.submit_human_group(payload);

    insert into public.human_group_locks (version, group_id, token_hash, status, updated_at)
    values (data_version, group_key, lock_hash, 'completed', now())
    on conflict (version, group_id) do update
    set token_hash = excluded.token_hash,
        status = 'completed',
        updated_at = now();

    return result;
end;
$function$;

-- Updated withdrawal endpoint keeping the group locked in progress for the withdrawing browser.
create or replace function public.withdraw_human_group(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    lock_hash text;
    participant text;
    group_key text;
    data_version text;
    receipt public.human_submission_receipts%rowtype;
begin
    key_hash := public.human_receipt_identity(payload);
    participant := btrim(payload ->> 'english_name');
    group_key := payload ->> 'group_id';
    data_version := payload ->> 'version';

    perform pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array('group_lock', data_version, group_key)::text, 0));

    if jsonb_typeof(payload -> 'lock_token') = 'string'
       and (payload ->> 'lock_token') ~ '^[0-9a-f]{64}$' then
        lock_hash := encode(sha256(convert_to(payload ->> 'lock_token', 'UTF8')), 'hex');
    else
        lock_hash := key_hash;
    end if;

    select * into receipt from public.human_submission_receipts where token_hash = key_hash;
    if not found then
        insert into public.human_submission_receipts(token_hash, english_name, group_id, version, withdrawn)
        values (key_hash, participant, group_key, data_version, true);
        update public.human_group_locks
        set status = 'in_progress', token_hash = lock_hash, updated_at = now()
        where version = data_version and group_id = group_key
          and token_hash in (lock_hash, key_hash);
        return jsonb_build_object('withdrawn', true);
    end if;
    if receipt.english_name <> participant
       or receipt.group_id <> group_key
       or receipt.version <> data_version then
        raise exception 'This receipt belongs to a different submission.' using errcode = '42501';
    end if;
    if not receipt.withdrawn then
        delete from public.human_responses
        where english_name = receipt.english_name and group_id = receipt.group_id and version = receipt.version;
        update public.human_submission_receipts set withdrawn = true where token_hash = key_hash;
    end if;

    update public.human_group_locks
    set status = 'in_progress', token_hash = lock_hash, updated_at = now()
    where version = data_version and group_id = group_key
      and token_hash in (lock_hash, key_hash);

    return jsonb_build_object('withdrawn', true);
end;
$function$;

revoke all on function public.list_human_group_locks(jsonb) from public, anon, authenticated;
revoke all on function public.claim_human_group(jsonb) from public, anon, authenticated;
revoke all on function public.release_human_group(jsonb) from public, anon, authenticated;
revoke all on function public.submit_human_group_v2(jsonb) from public, anon, authenticated;
revoke all on function public.withdraw_human_group(jsonb) from public, anon, authenticated;

grant execute on function public.list_human_group_locks(jsonb) to anon, authenticated;
grant execute on function public.claim_human_group(jsonb) to anon, authenticated;
grant execute on function public.release_human_group(jsonb) to anon, authenticated;
grant execute on function public.submit_human_group_v2(jsonb) to anon, authenticated;
grant execute on function public.withdraw_human_group(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
