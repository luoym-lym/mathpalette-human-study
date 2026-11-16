-- Run after setup.sql. Safe to rerun; existing answers are preserved.
begin;

create table if not exists public.human_submission_receipts (
    token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
    english_name text not null check (char_length(english_name) between 1 and 80),
    group_id text not null,
    version text not null,
    withdrawn boolean not null default false,
    foreign key (version, group_id) references public.human_study_groups(version, group_id)
);
create unique index if not exists human_submission_active_receipt
    on public.human_submission_receipts (english_name, group_id, version)
    where not withdrawn;
alter table public.human_submission_receipts enable row level security;
revoke all on public.human_submission_receipts from public, anon, authenticated;

-- Private helper shared by submission and withdrawal.
create or replace function public.human_receipt_identity(payload jsonb)
returns text
language plpgsql
set search_path = ''
as $function$
begin
    if jsonb_typeof(payload) is distinct from 'object'
       or jsonb_typeof(payload -> 'english_name') is distinct from 'string'
       or jsonb_typeof(payload -> 'group_id') is distinct from 'string'
       or jsonb_typeof(payload -> 'version') is distinct from 'string'
       or jsonb_typeof(payload -> 'receipt_token') is distinct from 'string'
       or coalesce(payload ->> 'receipt_token', '') !~ '^[0-9a-f]{64}$'
       or char_length(btrim(payload ->> 'english_name')) not between 1 and 80
       or pg_column_size(payload) > 2500000 then
        raise exception 'Invalid submission receipt.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.human_study_groups
        where version = payload ->> 'version' and group_id = payload ->> 'group_id'
    ) then
        raise exception 'Unknown group or dataset version.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array(btrim(payload ->> 'english_name'), payload ->> 'group_id',
                          payload ->> 'version')::text, 0));
    return encode(sha256(convert_to(payload ->> 'receipt_token', 'UTF8')), 'hex');
end;
$function$;
revoke all on function public.human_receipt_identity(jsonb) from public, anon, authenticated;

create or replace function public.submit_human_group_v2(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    receipt public.human_submission_receipts%rowtype;
    result jsonb;
begin
    key_hash := public.human_receipt_identity(payload);
    select * into receipt from public.human_submission_receipts where token_hash = key_hash;
    if found then
        if receipt.english_name <> btrim(payload ->> 'english_name')
           or receipt.group_id <> payload ->> 'group_id'
           or receipt.version <> payload ->> 'version' then
            raise exception 'This receipt belongs to a different submission.' using errcode = '42501';
        end if;
        if receipt.withdrawn then
            raise exception 'This submission was withdrawn. Return to your draft before submitting again.'
                using errcode = '22023';
        end if;
    else
        if exists (
            select 1 from public.human_submission_receipts
            where english_name = btrim(payload ->> 'english_name')
              and group_id = payload ->> 'group_id' and version = payload ->> 'version'
              and not withdrawn
        ) then
            raise exception 'This group was submitted from another browser. Use that browser to withdraw it.'
                using errcode = '42501';
        end if;
        -- The original validator also verifies exact legacy answers before issuing a receipt.
        -- An exception rolls back both the answers and receipt.
        insert into public.human_submission_receipts(token_hash, english_name, group_id, version)
        values (key_hash, btrim(payload ->> 'english_name'), payload ->> 'group_id', payload ->> 'version');
    end if;
    result := public.submit_human_group(payload);
    return result;
end;
$function$;

create or replace function public.withdraw_human_group(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
    key_hash text;
    receipt public.human_submission_receipts%rowtype;
begin
    key_hash := public.human_receipt_identity(payload);
    select * into receipt from public.human_submission_receipts where token_hash = key_hash;
    if not found then
        -- Cancel an uncertain submission without deleting any other receipt's answers.
        -- A tombstone stops a late submission request from recreating withdrawn answers.
        insert into public.human_submission_receipts(token_hash, english_name, group_id, version, withdrawn)
        values (key_hash, btrim(payload ->> 'english_name'), payload ->> 'group_id', payload ->> 'version', true);
        return jsonb_build_object('withdrawn', true);
    end if;
    if receipt.english_name <> btrim(payload ->> 'english_name')
       or receipt.group_id <> payload ->> 'group_id'
       or receipt.version <> payload ->> 'version' then
        raise exception 'This receipt belongs to a different submission.' using errcode = '42501';
    end if;
    if not receipt.withdrawn then
        delete from public.human_responses
        where english_name = receipt.english_name and group_id = receipt.group_id and version = receipt.version;
        update public.human_submission_receipts set withdrawn = true where token_hash = key_hash;
    end if;
    return jsonb_build_object('withdrawn', true);
end;
$function$;

-- Keep the original complete-group validator private; all public writes now require a receipt.
revoke all on function public.submit_human_group(jsonb) from public, anon, authenticated;
revoke all on function public.submit_human_group_v2(jsonb) from public, anon, authenticated;
revoke all on function public.withdraw_human_group(jsonb) from public, anon, authenticated;
grant execute on function public.submit_human_group_v2(jsonb) to anon, authenticated;
grant execute on function public.withdraw_human_group(jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
