# Groups — phase 1 spec

Status: **spec, not built** (2026-09-26). Concept and decisions: https://claude.ai/artifact/UrNQWvySP8jSnKhFfzdZEy

Phase 1 is **private groups**: a named, invite-only set of people with a
**weekly recurring run** and a **group chat**. It is for groups leaving a group
text, and for someone forming a standing group of people to call for a game.
Public city×sport chats (phase 2) and listed/discoverable groups (phase 3) are
out of scope here, but the schema leaves room for both.

## Prerequisites — ship these first, independently

Found while writing this spec. Each is useful on its own and none needs Groups,
so they land first, in this order, and Groups builds on them.

| # | Migration | What | Client change | Ships via |
|---|---|---|---|---|
| 1 | `030_run_fixes.sql` | (a) `rec_runs.sport` is still migration 003's 5-sport enum, so planning a soccer/baseball/swimming/handball/badminton/weightroom/golf run fails the insert. Replace it with the `char_length(sport) <= 40` cap every other sport column uses (020). (b) The participant insert policy only checks `user_id = auth.uid()`, so anyone holding a run id can join a friends-only run, and joining grants its chat. Add a **restrictive** insert policy requiring the run to be visible to the caller (`exists (select 1 from rec_runs r where r.id = run_id)` — RLS applies inside the subquery, the pattern 019 already uses for rosters). | None | DB only, today |
| 2 | `031_chat_push.sql` | Chat messages push nowhere today. One `notify_chat_message()` trigger covering **run, signal and direct** threads (and `group` later): recipients = thread members minus the sender, minus anyone who muted the thread or blocks the sender; **coalesced** to one push per recipient per thread per 5 min (`chat_notify_log`, the `crowd_notify_log` shape), body = sender + latest message. New `chat_mutes (user_id, thread_key)` table, own-rows RLS — mute has to be server-side because the push is. | `onNotificationTap` routes `type: 'chat'` to the thread; a Mute toggle in `ChatThread`'s header | DB + JS (OTA-able, but see the fingerprint note) |
| 3 | `032_profile_columns.sql` | Any signed-in user can read **every column of every profile** (age, bio, neighborhood, interests, friend code): one scripted `select *` dumps them all. The app itself only ever reads **other** people's `id` + `display_name`, so the fix costs no feature. Replace the table-wide select grant with a column grant of `(id, display_name)` — the 029 reviews technique — and add two SECURITY DEFINER RPCs: `my_profile()` (own row, all columns) and `find_by_friend_code(code)` (returns `id, display_name` for one exact code, so codes can't be enumerated). | `lib/auth.js` reads via `my_profile()` and stops asking the upsert to return a row; `lib/friends.js` uses the two RPCs. **Must ship before the migration**, or `select PROFILE_COLS` 401s on every launch. | Store build, **then** DB |
| 4 | `033_groups.sql` | This spec. | — | — |

After each: verify with the anon key and a signed-in second account (CLAUDE.md:
`017` once silently didn't take on the live DB).

## Decisions this spec rests on

- The feature is called **Groups** everywhere (UI, i18n `groups.*`, table `rec_groups`).
- Minors (13+) are in scope. Groups are **18+** or **all ages**.
- **No friend requests between adults and minors**, in either direction.
  Friendships that already exist are kept.
- Court chatter is deferred. Upvotes and forums are not planned.

## Goals / non-goals

**Goals**
1. Create a group in under 30 seconds: name, sport, home court, optional weekly run.
2. Invite by link or QR; the recipient lands one tap from joining.
3. Every week the run exists by itself; members get a reminder and tap In / Out.
4. A group chat that pushes, so it can actually replace the group text.
5. The owner can remove people. Everyone can block, report, leave, mute.

**Non-goals (phase 1)**
- No discovery, search or join requests: joining is **invite code only**.
- No per-run chat for group runs (the group chat is the chat).
- No photos/attachments, reactions, threads or polls.
- No admin UI for you; moderation actions stay SQL, now pasted from report emails.

## User flows

**Create.** Social → Groups → "Start a group". Fields: name (≤40), sport
(`sportsInCourts`-filtered `PLAN_SPORTS`, like the composers), home court
(same court picker `RunModal` uses, Indoor/Outdoor filter included), age
setting (an adult picks 18+ or all ages; a minor's group is always all ages
and the choice is hidden), and an
optional weekly run (day, time, court defaulting to home court). Creating
requires a birth year on the profile (see Age below).

**Invite.** Group page → "Invite" shows `QRCode` + share sheet with
`https://playrecreate.com/?group=<code>`. Code: 8 chars, same unambiguous
alphabet as friend codes. Owner can **reset the code** (old links die).

**Join.** Opening the link → app loads with `?group=` (new `urlState` key,
same path as `?add=`) → a join sheet: name, sport, home court, member count,
age setting, "Join". Signed out → sign-in first, then the sheet reappears
(same return pattern as `signInReturnRef`). Blocked outcomes each get a
plain sentence: group is 18+; group is full (cap 50); you were removed;
code reset.

**Weekly run.** The group page pins the next run: date/time, court, In count,
avatars, "I'm in" / "Can't make it". If the owner turned reminders on for the
weekly run (off / evening before / morning of / 2 hours before), members who
haven't answered get one push; it deep-links to the group. The owner can skip a single week ("No run this week")
or edit/remove the rule.

**Chat.** Group chat lives on the group page and in the Chats inbox
(`ChatsScreen`) beside DMs and run/signal chats. New messages push to members,
coalesced (see Push).

**Leave / mute / remove.** Any member: Leave, Mute (no pushes, still in the
group). Owner: remove member (with "and don't let them rejoin" = ban),
transfer ownership, delete group. If the owner deletes their account,
ownership passes to the longest-standing adult member; if none, the group is
deleted.

## Screens

| Where | What |
|---|---|
| `SocialScreen` | Third segment **Groups** (`'activity' \| 'chats' \| 'groups'`). Signed out: the same sign-in prompt the other segments use. |
| New `components/GroupsPane.js` | List of my groups (next run + unread badge per row), "Start a group", "Join with code". |
| New `components/GroupScreen.js` | Full-screen Modal: header, pinned next run, chat (reuse `ChatThread` body with a `thread={kind:'group'}`), members sheet, settings sheet. |
| New `components/GroupComposer.js` | Create/edit sheet. Follows the bottom-sheet rules in CLAUDE.md (static numeric `maxHeight`, sibling backdrop `Pressable`). |
| `ChatsScreen` | Group threads listed; tap opens `GroupScreen`. |
| `RunModal` | Unchanged in phase 1 (group runs are created by the rule). A "Post to group" picker is a phase-1.5 nicety. |
| Profile | "Birth year" field replaces "Age" (see migration). |

All new dialogs go through `lib/dialog.js` / `ActionSheet`, never `Alert.alert`
(dead on web). Every string gets `groups.*` keys in en/zh/es.

## Data model — migration `033_groups.sql` + schema `12_groups.sql`

```sql
-- Age: birth_year replaces age for gating. Keep `age` readable for old
-- clients; backfill birth_year = extract(year from now()) - age.
alter table profiles add column birth_year int
  check (birth_year is null or birth_year between 1900 and extract(year from now())::int - 13);
create function is_adult(uid uuid) returns boolean  -- SECURITY DEFINER, stable
  -- birth_year <= current_year - 18. NULL birth_year => NOT adult, and
  -- group actions require a non-null birth_year anyway.

create table rec_groups (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 40),
  sport         text not null check (char_length(sport) <= 40),
  home_court_id text check (char_length(home_court_id) <= 128),
  city          text not null default 'sf',
  tz            text not null default 'America/Los_Angeles',  -- from lib/cities.js
  adults_only   boolean not null default false,
  invite_code   text not null unique,         -- trigger-generated
  owner         uuid not null references profiles on delete restrict, -- handled by delete_account()
  listed        boolean not null default false check (listed = false), -- phase 3 lifts this
  created_at    timestamptz not null default now()
);

create table rec_group_members (
  group_id   uuid references rec_groups on delete cascade,
  user_id    uuid references profiles on delete cascade,
  role       text not null default 'member' check (role in ('owner','admin','member')),
  muted      boolean not null default false,
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table rec_group_bans (group_id, user_id, created_at, primary key (group_id, user_id));

create table rec_group_run_rules (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid references rec_groups on delete cascade,
  dow        int  not null check (dow between 0 and 6),     -- 0=Sun, app convention
  start_min  int  not null check (start_min between 0 and 1439),
  court_id   text not null check (char_length(court_id) <= 128),
  active     boolean not null default true,
  remind     text not null default 'evening_before'
             check (remind in ('off','evening_before','morning_of','two_hours'))
);  -- one rule per group in phase 1 (unique (group_id)); the table allows more later

alter table rec_runs add column group_id uuid references rec_groups on delete cascade;
alter table rec_runs add column rule_id  uuid references rec_group_run_rules on delete set null;
alter table rec_runs drop constraint rec_runs_visibility_check;
alter table rec_runs add constraint rec_runs_visibility_check
  check (visibility in ('public','friends','group'));
alter table rec_runs add constraint rec_runs_group_vis
  check ((group_id is null) = (visibility <> 'group'));
create unique index rec_runs_rule_week on rec_runs (rule_id, starts_at) where rule_id is not null;

-- (rec_runs.sport enum → length cap is prerequisite 030.)

create table rec_run_declines (run_id, user_id, primary key (run_id, user_id));  -- "Can't make it"

alter table chat_messages add column group_id uuid references rec_groups on delete cascade;
-- one-target check becomes num_nonnulls(run_id, signal_id, direct_key, group_id) = 1
create index chat_messages_group_idx on chat_messages (group_id, created_at);

-- content_reports.kind gains 'group'
```

**Why "In" stays a `rec_run_participants` row.** The join push
(`notify_run_join`), roster queries and `RunModal`/card code all already read
it. "Out" is a separate `rec_run_declines` row; a trigger deletes the opposite
row on insert so the two are mutually exclusive.

## RLS

Pattern: membership is derived from rows, like runs/signals today. A helper
`is_group_member(gid)` (SECURITY DEFINER, returns boolean for `auth.uid()`
only — never takes a user id argument, so it can't be used to probe others)
keeps policies readable and avoids recursive RLS on `rec_group_members`.

| Table | select | insert | update | delete |
|---|---|---|---|---|
| `rec_groups` | members | **RPC only** | owner/admin: name, home court, rule; owner only: `adults_only`, `invite_code` | owner |
| `rec_group_members` | members see the roster | **RPC only** (`join_group`) | owner: role; self: `muted` | self (leave); owner/admin (remove, not the owner) |
| `rec_group_bans` | owner/admin | owner/admin | — | owner/admin |
| `rec_group_run_rules` | members | owner/admin | owner/admin | owner/admin |
| `rec_runs` (`visibility='group'`) | members | cron/RPC only | owner/admin (cancel one week) | — |
| `rec_run_participants` / `rec_run_declines` on a group run | members | self, **and** a member (new *restrictive* policy — the existing insert policy only checks `user_id`, which would let anyone who guesses a run id join) | — | self |
| `chat_messages` (`group_id`) | members | self, member, not suspended | — | self; owner/admin (moderation) |

**RPCs** (SECURITY DEFINER, `set search_path = public`, granted to
`authenticated` only):
- `create_group(name, sport, home_court_id, city, adults_only, rule jsonb)` →
  inserts group + owner membership + rule atomically; requires caller
  `birth_year`; forces `adults_only = false` when the caller is a minor.
- `group_preview(code)` → name, sport, home court, member count, adults_only.
  **No member names** — a code is shareable and may leak.
- `join_group(code)` → checks: birth_year set; not banned; `adults_only`
  ⇒ `is_adult`; member count < 50; rate limit (10 joins/day/user). Returns a
  reason code the client maps to a sentence.
- `reset_group_code(gid)`, `transfer_group(gid, to_user)`.

**Verify with the anon key and a second account after applying** (CLAUDE.md:
`017` once silently didn't take on the live DB):
anon reads nothing; a non-member can't select a group, its runs, roster or
messages, can't insert a participant row on a group run by id, and can't
`join_group` a banned/adults-only group.

## Age rules (phase 1 part)

- Groups require `birth_year`. Opening the Groups segment without one shows a
  one-field prompt. Not skippable for groups; the rest of the app is unaffected.
- **Friend requests:** the `friendships` insert policy adds
  `is_adult(requester) = is_adult(addressee)`; existing rows untouched. The
  client pre-checks so the error is a sentence, not a policy failure.
  Consequence worth knowing: DMs already require friendship, so this also
  closes adult↔minor DMs for new pairs.
- A minor's profile, as seen by a non-friend, shows display name only
  (hide `bio`, `neighborhood`, `age/birth_year`). Prerequisite `032`
  already does this for **everyone**, since the app never shows those fields
  to anyone but their owner — so there is no minor-specific work left here.
  `birth_year` joins the columns excluded from the grant.
- `birth_year` is editable once without friction, then only via support —
  otherwise the 18+ gate is a toggle.

## Recurring runs

`pg_cron` (Supabase extension; first cron in this project) runs **hourly**:

1. **Materialize.** For each active rule, ensure a `rec_runs` row exists for
   the next occurrence within 8 days: `starts_at = (local_date + start_min) at
   time zone group.tz` — computing in the group's tz keeps 7 PM at 7 PM across
   DST. `on conflict (rule_id, starts_at) do nothing` makes it idempotent, so
   an hour's double run or a missed hour is harmless. Host = group owner;
   the owner is **not** auto-joined for group runs (the auto-join trigger
   `add_host_as_participant` must skip `group_id is not null`), since owning
   the group is not saying you're coming.
2. **Remind.** Reminders are a per-rule setting, because some groups want
   them ("Wednesday night runs at Palega") and some don't. `remind` is `off`,
   `evening_before` (18:00 group-local the day before, the default when a
   weekly run is set up), `morning_of` (09:00 group-local) or `two_hours`
   (2 h before start). When the chosen moment has passed and `reminded_at is
   null`, push to members with no participant/decline row and `muted = false`,
   then set `reminded_at` (new column on `rec_runs`). One reminder per run,
   ever. Groups without a weekly run have nothing to remind about. Members who
   don't want them mute the group.

"Skip this week" sets that run's `status = 'cancelled'` (existing column), and
the materializer never recreates it thanks to the unique index. Editing a rule
cancels future **unanswered** runs from the old rule and materializes new ones;
runs people already said In to are left alone and the owner is told so.

## Push

Message pushes come from prerequisite `031` (one trigger for every chat kind);
Groups only adds `group` to its recipient lookup: members with `muted = false`.
`rec_group_members.muted` is the group-level mute; `chat_mutes` still works
for the thread.

Groups also adds: someone joined your group (to owner/admins), the weekly
reminder (see Recurring runs), and "run cancelled" to people who said In. Not
pushed: someone said Out.

## Moderation (phase 1 part)

- `content_reports.kind` gains `'group'` (name/rules); messages reuse
  `'message'`. The `028` email trigger already covers every kind; add
  ready-to-paste SQL lines to the email for group reports (`delete from
  rec_groups where id = …`, suspend user).
- **Suspension:** `profiles.suspended_until timestamptz`. Every group/chat
  insert policy and RPC checks it. Set by you from SQL.
- Owner/admin delete any message in their group; remove/ban members.
- Blocks: `lib/blocks.js` filtering extends to group messages and rosters
  (a blocked user's messages disappear for you, as in run chats).
- Word filter on group names (client + a `check` via a small SQL function
  over a word list) — Apple 1.2. Chat bodies get the same filter.
- `delete_account()` handles ownership transfer before the user row goes
  (`owner ... on delete restrict` forces this to be deliberate).

## Client code

| File | Change |
|---|---|
| New `lib/groups.js` | `listMyGroups`, `groupPreview(code)`, `joinGroup(code)`, `createGroup`, `updateGroup`, `leaveGroup`, `setMuted`, `removeMember`, `banMember`, `resetCode`, `transferOwnership`, `respond(runId, 'in'|'out')`, `subscribeGroups`. Supabase-or-null like every store; with `supabase` null the Groups segment is hidden. |
| `lib/chat.js` | `thread.kind === 'group'` in `sendMessage`/`threadFilter`/`keyOf`; `loadThreads` adds group threads and **skips runs with `group_id`** (otherwise every weekly run becomes its own empty thread). Select column lists must include `group_id`. |
| `lib/runs.js` | Select `group_id`; `loadRuns(courtId)` (court card) excludes group runs a non-member can't see anyway — RLS handles it, but don't render a group run as joinable from the card. |
| `lib/urlState*.js` | Add `group` to `KEYS`. |
| `lib/invite.js` | `groupInviteUrl(code)`, `parseGroupCode`. |
| `lib/friends.js` | Map the age-mismatch policy error to `groups.err.ageFriend`-style copy. |
| `lib/i18n.js` | `groups.*` keys × en/zh/es (`npm run check` enforces parity). |
| `SocialScreen`, `ChatsScreen`, `AuthModal` (birth year) | As in Screens. |

No new native modules ⇒ ships **OTA** (`npm run update:prod`), subject to the
fingerprint note in memory. Web works the same (realtime + RLS), except the
QR is shown and push is native-only.

## Build order

0. Prerequisites `030`, `031`, `032` (above), each verified before the next.
1. Migration `033` + schema `12_groups.sql` + README table rows; apply to a
   branch DB; RLS checks above with anon + two test accounts
   (dev tester + "Alex Rivera").
2. `lib/groups.js` + birth-year field; create/join by code works end to end.
3. `GroupsPane` / `GroupScreen` / chat wiring (`lib/chat.js`).
4. Recurring runs: rule UI (incl. reminder setting), pg_cron materializer, In/Out.
5. Push: `group` in the chat trigger, reminder, join/cancel pushes.
6. Moderation: reports kind, suspension column, owner tools, word filter,
   `delete_account()` transfer.
7. Age rules on `friendships`.
8. i18n pass, `npm run check`, web + device run-through.

## Acceptance checklist

- [ ] Create a group with a Tue 7 PM rule → next Tuesday's run appears; across
      the Nov DST change it is still 7 PM local.
- [ ] Invite link opens the join sheet on web and native, signed in and out.
- [ ] Minor cannot join an 18+ group; adult and minor cannot friend each other;
      existing adult–minor friendship still works.
- [ ] Non-member can't read a group, its runs, roster or chat — checked with
      the anon key **and** a signed-in non-member.
- [ ] Ten rapid messages ⇒ each other member gets ≤ 2 pushes.
- [ ] Muted member gets none; blocked sender's messages hidden.
- [ ] Removed + banned member can't rejoin with the same or a reset code.
- [ ] Deleting the owner's account transfers ownership (or deletes the group).
- [ ] Reminder `off` sends nothing; `two_hours` fires once, 2 h before.
- [ ] (030) Planning a soccer run from `RunModal` succeeds; joining a
      friends-only run you can't see by id fails.
- [ ] (031) A run, signal and direct message each push once; ten rapid
      messages ⇒ ≤ 2 pushes per recipient; muted thread gets none.
- [ ] (032) Signed-in `select *` on `profiles` fails; `select id, display_name`
      works; friend-code add still works.
- [ ] `npm run check` passes; en/zh/es parity.

## Decided since the first draft (2026-09-28)

- Member cap stays **50**.
- **Run and signal chats get message pushes too** — hence one generic trigger
  (prerequisite `031`) instead of a group-only one. Direct messages are
  included on the same reasoning.
- **Reminders are per group**, set on the weekly run: off / evening before /
  morning of / 2 hours before.
