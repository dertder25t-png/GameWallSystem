# GameWallSystem — Next Feature Set: Implementation Plan

Scope for this round: **Remote UX** (no PIN/lock), **Reliability & self-healing**,
**Smarter automation** (favorite-team pinning + "last screen" memory + alerts), and
**Multi-sport support** for UFC, NASCAR, and F1. This doc is a build plan, not finished
code — enough detail to implement each piece against the actual files in the repo.

## Implementation Status

Status legend: **[x] Done** · **[~] Partial** · **[ ] Not implemented**

### Completed

- [x] 1.1 Drag-to-reorder / swap any two slots
- [x] 1.2 V1 quick-swap presets
- [x] 1.3 Idle-slot upcoming-game display
- [x] 1.4 Multi-remote awareness and named client list
- [x] 1.5 Light/dark theme toggle
- [x] 2.1 Slot watchdog: crash recovery via `ProcessFailed` + continuous stall watchdog loop with health status broadcast and auto-recovery
- [x] 2.2 Remote health indicator
- [x] 2.3 Reconnect with exponential backoff
- [x] 3.1 Favorite teams: pin persistence, schedule-backed autocomplete suggestions, interactive tags, 1-tap quick pin on cards, state change alerts, and rank-based auto-fill protection
- [x] 3.2 Last screen per team: placement memory, schedule hints, 1-tap direct placement on remembered screen, preferred slot glow, and automatic placement
- [x] 3.3 In-page alerts for pinned-team state changes
- [x] 4.1-4.5 Multi-sport support: UFC flattening with bout details/flags/broadcasts, NASCAR and F1 race extraction with broadcast detection and session selection, sport filter toggles, verified live with HTTP 200 via `site.web.api.espn.com`
- [x] 1.6 Visual custom-layout editor and Canvas-based display layouts
- [x] 5 Data richness wall panel (live win probability, weather, venue, situation, boxscore leaders)
- [x] 6 Day Planner (automated slates, OT policies, fallbacks, manual override protection)
- [x] 7.1 Display Host as the authoritative WallState source (revisions, multi-client sync)
- [x] 7.2 Undo/history (rolling 40-item snapshot history, instant undo toast, history drawer)
- [x] 7.3 Separate soft Close from hard Clear (reopen chip, ✕ dismiss affordance, 60-min auto-clear)

### Partial

None (all partial features have been completed).

### Not Implemented

None (all planned features have been implemented and verified).

---

## 1. Remote UX

### 1.1 Drag-to-reorder / swap any two slots [x]
Right now `swapToMain()` in `app.js` only swaps a slot with slot 0. Generalize it:

```js
function swapSlots(indexA, indexB) { /* same logic as swapToMain, parameterized */ }
```

Reuse the same drag-and-drop event wiring already used to drop a game card onto a slot
(search `app.js` for the slot `ondragover`/`ondrop` handlers) — add a second drag source
(dragging a *slot card* onto another *slot card*) that calls `swapSlots` instead of
`assignGameToSlot`.

### 1.2 Quick-swap presets ("Saturday lineup") [x for V1]
V1: a preset is just a snapshot of `state.slots` (network/URL/label per slot) saved to
`localStorage` under a name, restorable with one tap. This works well for fixed
destinations (e.g., "ESPN main feed always on Screen 1").

V2 (more useful once you have favorite teams — see §3): a *team-based* preset that stores
"whoever Georgia is playing goes on Screen 2" and resolves against the live schedule at
apply-time instead of a frozen URL, so it still works after matchups change week to week.

Build V1 first — it's a small, self-contained addition to `app.js` (new `presets`
localStorage key, "Save layout" / "Apply preset" buttons in the topbar) and doesn't touch
the C# side at all.

### 1.3 Idle-slot screensaver [x]
When a slot is empty, `renderSlots()` currently just shows "Empty — tap a game." Extend it
to also list the next 1–2 upcoming kickoffs (filter `state.schedule` by `kickoff > now`,
sort, take 2) inside that same empty-slot div. Purely a `app.js`/`index.html`/`style.css`
change — no backend work.

### 1.4 Multi-remote awareness [x]
Multiple phones/tablets can already connect to the Display Host's WebSocket
(`CommandServer.cs`) at once, but they're invisible to each other. Add:
- On connect, each remote sends a `{action: "hello", name: "<device label>"}` message.
- `CommandServer.cs` tracks connected sockets with their labels and broadcasts a
  `ClientsStatus { Type: "clients", Names: [...] }` message (same pattern as the existing
  `DisplayStatus`/`AdStatus` broadcasts) whenever the list changes.
- `app.js` shows "2 remotes connected: Kitchen iPad, Caleb's phone" somewhere in the
  topbar, so nobody's surprised when a screen changes out from under them.

### 1.5 Light/dark theme toggle [x]
Add a `--theme` set of CSS custom properties and a `<body class="theme-light">` toggle,
persisted in `localStorage`. Purely `style.css` + a small `app.js` toggle handler.

### 1.6 Visual layout editor (custom layouts, adjustable from the remote) [x]
This is the biggest architecture change in this document — bigger than the multi-sport
work in §4 — because it touches how slots are physically positioned on the wall, not just
what's playing in them.

**Today:** `Layouts.cs` defines a fixed set of named layouts (1/2/4/6/8/featured), each a
hardcoded set of rectangles. The remote sends `{action:"layout", layout:"4"}` and
`MainWindow.xaml.cs` looks up that name and repositions the slots to match. This almost
certainly assumes a `Grid`-based container with fixed row/column definitions, since that's
the natural way to build fixed presets.

**What's needed for custom, remote-adjustable layouts:**

1. **Switch the slot container from `Grid` to `Canvas`.** A `Grid`'s row/column model can't
   express "slot 3 is a small box floating over slot 1" or arbitrary drag-to-resize
   positions. A `Canvas` with `Canvas.SetLeft`/`SetTop` and explicit `Width`/`Height` on
   each slot's `Border` can. Store each slot's rectangle as **fractional** coordinates
   (0.0–1.0 for x/y/width/height) rather than pixels, and recompute actual pixel positions
   against `ActualWidth`/`ActualHeight` — both at layout-apply time and in a `SizeChanged`
   handler, so a layout still looks right if the wall PC's resolution or monitor changes.
2. **Extend the "layout" command** to optionally carry a full custom rectangle set instead
   of a preset name:
   ```
   { action: "layout", layout: "custom", rects: [{x,y,w,h}, {x,y,w,h}, ...] }
   ```
   `MainWindow.xaml.cs` gets a new code path: if `layout == "custom"`, apply `rects`
   directly to the Canvas instead of looking up a `LayoutDefinition`.
3. **Remote-side editor:** a to-scale minimap of the wall (a div matching the wall's
   aspect ratio) where each slot renders as a labeled, draggable/resizable box. This
   doesn't need a heavy library — hand-rolled pointer-drag and corner-resize-handle logic
   on a fixed-aspect-ratio div is enough. On "Apply," convert each box's minimap pixel
   position/size to fractions (divide by the minimap's width/height) and send as the
   `rects` array above.
4. **Deliberately allow overlap.** Don't add collision prevention — a small "inset" box
   sitting on top of a big one is exactly the kind of custom layout (PiP-style) people will
   want, and preventing overlap would block it for no benefit.
5. **Saving:** named custom layouts stored in `localStorage` on the remote, listed
   alongside the existing preset dropdown, using the same selection pattern as before.

Because of the `Grid`→`Canvas` change, this is worth prototyping in isolation before
combining it with anything else in this document — it's the one item here that touches the
rendering foundation rather than sitting on top of it.

---

## 2. Reliability & self-healing

### 2.1 Slot watchdog [x]
Two layers, cheapest/most-precise first:

1. **`CoreWebView2.ProcessFailed` event.** This is a real WebView2 API event that fires
   when a renderer crashes — subscribe to it per slot in `MainWindow.xaml.cs`'s
   `InitializeSlotAsync` (wherever each slot's `CoreWebView2` is first set up) and
   immediately `core.Reload()` or re-navigate to the slot's last known URL when it fires.
   This is the fast, exact path for actual crashes.
2. **Ad-scan failure counter (stalled-but-not-crashed fallback).** `MainWindow.xaml.cs`
   already runs `ScanAllSlotsForAdsAsync` every 2s via `ExecuteScriptAsync`. Track
   consecutive exceptions per slot in a `_adScanFailures[8]` array; after ~5 consecutive
   failures (~10s), treat the slot as stuck and reload it, then reset the counter. This
   catches "infinite spinner, stream stalled" cases the crash event won't.

Broadcast a new `SlotHealth { Slot, Status }` message (mirroring `AdStatus`) whenever a
slot's health changes, so the remote can show it.

### 2.2 Remote health indicator [x]
Small colored dot per slot card in `index.html`/`style.css` (green = ok, amber = stalled,
red = just auto-recovered), driven by the new `SlotHealth` WebSocket message in `app.js`'s
existing `onmessage` switch (same place `adStatus` is handled today).

### 2.3 Reconnect with backoff [x]
Check whether `app.js`'s WebSocket client already retries on disconnect. If it just gives
up on close, add exponential backoff reconnect (1s, 2s, 4s... capped) so the remote
recovers on its own after the Display Host restarts (e.g., after a self-heal or manual
relaunch) instead of needing a manual page refresh.

---

## 3. Smarter automation

### 3.1 Pin a favorite team [x]
- New `state.pinnedTeams` array in `localStorage`, editable via a simple text-entry/
  autocomplete UI (source the autocomplete list from team names already seen in
  `state.schedule`).
- **Auto-grab (`findBestReplacement` in `app.js`):** give pinned-team games a large
  scoring bonus, and — more importantly — make `runAutoGrab` refuse to replace a slot
  currently showing a *live* pinned-team game even if a "better" game exists elsewhere.
  Only allow replacement once that game is genuinely `completed`.
- **Commercial-dim (`evaluateCommercialSwap`'s `rankScore` in `app.js`):** same bonus, so
  the fallback game chosen during a break also prefers a pinned team when available.

### 3.2 "Remember last screen" per team [x]
- New `lastScreenByTeam` map in `localStorage`: `{ "Georgia Bulldogs": 1 }`. Update it
  every time `assignGameToSlot` places a game — record the slot index against both the
  home and away team names.
- When a new game involving a known team appears and its "usual" slot is empty, prefer
  placing it there over the first empty slot / current auto-grab pick.
- Nice small touch: show a subtle "Usually Screen 2" hint on that game's card in
  `renderSchedule()` even when not auto-placing, so the info is visible either way.

### 3.3 In-page alerts for pinned teams [x]
Compare each poll's `state.schedule` against the previous one for pinned-team games;
on a state change (kickoff, went live, final), show a temporary banner (reuse the
existing `#scheduleWarning` banner styling). True OS-level push notifications would need a
PWA manifest + service worker — bigger lift, worth flagging as a later stretch goal rather
than building now, since the remote is normally left open on a tablet/phone anyway.

---

## 4. Multi-sport: UFC, NASCAR, F1 [x]

This is the structurally biggest change, because ESPN's data shape for these sports
breaks the "exactly 2 competitors with a running score" assumption the whole UI is built
around today.

### 4.1 Endpoints [x]
- UFC (MMA): `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard`
- NASCAR (Cup Series): `https://site.api.espn.com/apis/site/v2/sports/racing/nascar-premier/scoreboard`
  (other series use different slugs, e.g. `nascar-xfinity`, `nascar-truck`)
- F1: `https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard`

Same caveat that already applies to the college-football endpoint you're using: this is
ESPN's unofficial site API, not a documented product — verify these slugs empirically once
you're building against them, since they can shift without notice.

### 4.2 Why the data shape is different [x in implementation]
- **Football (current):** one `event` = one game = `competitions[0].competitors` has
  exactly 2 entries tagged `home`/`away`.
- **UFC:** one `event` = one whole *card* (e.g. "UFC 309"). `event.competitions[]` is an
  **array of individual bouts**, each with its own 2 competitors (fighters — no home/away,
  instead an `order` field for card position). A single API event actually bundles many
  separately-watchable bouts.
- **NASCAR / F1:** one `event` = one race. `competitions[0].competitors` is a **large
  array of 20–40+ drivers**, not 2. There's no home/away and no running "score" — just a
  finishing `order` once complete, and a status/lap count while in progress.

### 4.3 Recommended approach [x]
Add a `Sport` field to every event ("football" / "mma" / "nascar" / "f1"). The repo's
`Program.cs` currently builds each game as an anonymous object — worth promoting to a real
`record WallEvent` now, since fields start being sport-conditional:

- **UFC:** model **each bout** as its own separate `WallEvent`
  (`id = event.id + "-" + competitionIndex`), with `homeTeam`/`awayTeam` = the two
  fighters. This is the pragmatic trick — once unpacked, a bout *is* a 2-competitor
  matchup, so the existing game-card UI works with **no changes** beyond the fetch/merge
  logic.
- **NASCAR / F1:** these don't fit the 2-competitor card at all. Add a distinct, lighter
  card type in `renderSchedule()` — title = race name, subtitle = leader + laps-to-go once
  live, status = scheduled/live/final — rather than forcing them into the team-card shape.
  Exclude races entirely from "close game" scoring logic (no meaningful score-diff concept
  applies), but still allow them as valid live candidates for auto-grab/auto-dim.

### 4.4 Fetching multiple sports [x]
`Program.cs`'s `/api/schedule` handler currently hits one hardcoded URL. Generalize to a
small `(sportKey, url)` list, fetch all of them in parallel (`Task.WhenAll`), tag each
event with its sport, and merge into the one `games` array already returned — the client
is already sport-agnostic since it just iterates whatever's in the array. Reuse the exact
same `HttpClient`/header setup (User-Agent, Referer, etc.) for every sport's request, since
that's what gets past ESPN's bot-protection today.

Later: a `?sports=football,mma,nascar,f1` query param so the remote can toggle which sports
feed the schedule, instead of always fetching all four.

### 4.5 Suggested rollout order [x]
1. Add the `sport` field + multi-endpoint fetch/merge, starting with **UFC only** — least
   UI change since bouts map cleanly onto the existing 2-competitor card.
2. Add a sport-filter checkbox row to the sidebar (same pattern as the existing filter
   checkboxes) so people can toggle Football / UFC / NASCAR / F1 independently.
3. Add the race-card UI branch for NASCAR/F1 once the UFC plumbing is proven out.

---

## 5. Data richness as its own wall panel (win probability, weather, etc.) [x]

The earlier brainstorm suggested surfacing win-probability and weather data on the
remote's game cards. The follow-up ask — giving that data **its own dedicated space on
the physical wall**, not just the remote — turns out to need no new native rendering
pipeline at all, because of one thing already true about this app: **a slot is just "load
a URL."** A data panel can be exactly that: another URL.

### 5.1 Recommended approach
1. Add a small self-contained page, `wwwroot/panel.html` (+ `panel.js`), served by the
   existing Control Server alongside `index.html`. It takes a `?gameId=` query param,
   polls `/api/schedule` on the same interval pattern as `app.js`, finds the matching
   game, and renders win probability / weather / score in large, wall-readable type — no
   new server infrastructure, just a second front-end page.
2. On the remote, add a secondary action on each game card — "📊 Stats panel" — next to
   the existing "assign to slot" action. Instead of sending the stream's `watchUrl` to a
   slot, it sends `http://<control-server-host>:5050/panel.html?gameId=<id>` via the same
   `navigate` command every other placement already uses.
3. That's it: any slot, in any layout position (including a small inset box once §1.6 is
   built), can become a "stats panel" simply by navigating it to `panel.html` instead of a
   stream — no changes needed to `Layouts.cs`, `MainWindow.xaml.cs`, or the WebSocket
   protocol.

### 5.2 Data to include
- Win probability (ESPN's API commonly includes this per-event; expose it in `Program.cs`
  the same way `rank`/`statusName` were added).
- Weather (delay-relevant conditions, if the sport/venue data includes it — outdoor games
  only, so this is football/racing rather than something universal).
- Whatever else lands in §4's multi-sport work fits naturally here too — e.g., a
  standalone NASCAR/F1 leaderboard panel showing full running order rather than
  squeezing it into a slot's game card.

---

## 6. Day Planner (scheduled layout + assignment automation) [x]

This is the "plan the whole Saturday" feature — pre-set which layout is active and which
games/teams go where at specific times (e.g., 8-up all morning, then 2-up "featured"
at 3pm for the marquee games) instead of managing every transition live. It builds
directly on §1.6 (custom layouts) and §3.1 (pinned teams), so it's worth sequencing after
both.

The interesting design problem isn't the happy path — it's what happens when reality
doesn't match the plan. A plan is written assuming games end on time; real games run into
overtime, get delayed, or occasionally get postponed outright. **Every one of these needs
a user-configurable policy, not a hardcoded behavior**, because the right answer genuinely
depends on the day (a random October Saturday vs. a championship game you don't want cut
off for anything).

### 6.1 Data model
```
dayPlan: [
  { id, startTime: "15:00", layout: "featured" | customLayoutId,
    assignments: [
      { slot: 0, source: "team:Georgia Bulldogs" },   // resolved live, not frozen
      { slot: 1, source: "network:CBS" },
      { slot: 2, source: "auto" }                      // let auto-grab pick the best game
    ]
  },
  ...
]

dayPlanSettings: {
  otPolicy: "wait" | "hardCutover" | "graceOverflow",
  otGraceMinutes: 20,                 // cap for "wait"/"graceOverflow" - see 6.2
  protectPinnedRegardless: true,      // pinned-team games ignore otPolicy entirely
  manualOverridePrecedence: "keepUntilNextBlock" | "snapBack",
  missingGameFallback: "autoSubstitute" | "placeholder" | "leaveLast",
}
```

Assignments are resolved **at transition time, not at plan-creation time** — `"team:X"` or
`"network:X"` looks up the current `state.schedule` for a live match, so if a network
moves a game or a matchup shifts, the plan self-corrects instead of pointing at stale data.
`"auto"` just hands that slot to the existing `findBestReplacement` scoring logic.

### 6.2 Handling overtime / running-long games
Three selectable policies, applied whenever a scheduled transition arrives and a game
currently on screen (in the outgoing block) is still live:

- **Hard cutover** — the plan wins, transition happens on time regardless. Simplest, but
  can yank a close game away mid-overtime.
- **Wait for completion** — delay the transition until that specific game hits
  `completed`. Capped by `otGraceMinutes` so a 3-OT college game doesn't stall the whole
  day's plan indefinitely — after the cap, fall through to hard cutover anyway.
- **Grace overflow** — don't delay the transition, but temporarily add an extra slot (or
  inset box, once §1.6's overlap-friendly layouts exist) for the still-live game on top of
  the new planned layout, and remove it automatically once that game finishes.

`protectPinnedRegardless: true` is the sane default — whatever policy is chosen for the
general case, a pinned team's game never gets hard-cut. This reuses the same
"never replace a live pinned-team slot" rule already planned for auto-grab in §3.1.

### 6.3 Other real-world edge cases worth a setting
- **Game hasn't started yet at transition time** (early kickoff delay, weather push): show
  a "starting soon" placeholder in that slot rather than dead air, and auto-fill once it
  goes live.
- **Game postponed/cancelled entirely:** `missingGameFallback` controls whether that slot
  auto-substitutes the next-best available game, shows an explicit placeholder message, or
  just leaves whatever was on screen before.
- **Manual rearrangement during an active plan:** if someone manually swaps a slot mid-
  block, `manualOverridePrecedence` decides whether that sticks until the next scheduled
  block (`keepUntilNextBlock`, the friendlier default) or gets overwritten at the next tick
  (`snapBack`). Without this setting, the day planner and a person standing at the remote
  will otherwise fight each other.
- **Interaction with auto-grab/auto-dim:** those should keep operating *within* whatever
  the current block defines — an `"auto"` slot stays dynamically managed all block long;
  an explicit `"team:X"`/`"network:X"` slot is exempt from auto-grab's replacement logic
  entirely (it's pinned by the plan itself, not just scored highly).

### 6.4 Implementation sketch
- Pure `app.js` addition: a scheduler tick (`setInterval`, ~every 15–30s) comparing the
  current time against `dayPlan` block boundaries, detecting when a new block becomes
  active, and running the policy checks in §6.2/§6.3 before applying the layout + slot
  assignment commands (same `sendCommand` calls every other feature already uses).
- UI: a simple list-based block editor (start time, layout picker, per-slot assignment
  dropdown) is enough for V1 — a proper drag-to-build visual timeline is a nice V2 but not
  required to get the feature working.
- Persistence: `localStorage`, alongside the presets from §1.2 — a day plan is really just
  a sequence of presets with timestamps attached.

---

## 7. Architecture foundations: single source of truth, undo, and slot lifecycle clarity [x]

These three are less "a feature" and more "fix the model everything else sits on." Worth
reading before building §1–§6, since two of them change how those features should be
built rather than what gets bolted on after.

### 7.1 Make the Display Host the single source of truth [x]

**The problem.** The remote keeps its own copy of wall state in `app.js`'s `state.slots`,
and commands (`navigate`, `mute`, `close`, etc.) go one-way to the Display Host — but the
Host never broadcasts back a complete picture of current slot state, only the narrower
`DisplayStatus`/`AdStatus` messages already in `SlotCommand.cs`. That's an eventual-
consistency problem waiting to happen: one remote changes Screen 3, a second remote was
already open and doesn't hear about it, someone refreshes the page, the Display Host
restarts, a command silently fails to apply — any of these leaves a remote showing
something the wall isn't actually doing anymore. §1.4's multi-remote awareness (knowing
*who's* connected) helps but doesn't fix this — it's a different problem.

**The fix:** a single authoritative state object, owned by the Display Host, broadcast in
full on every new connection and incrementally after that:

```
WallState
├── layout            (current preset name or custom rect set)
├── activeMonitor
├── slots[]
│   ├── url
│   ├── label
│   ├── network
│   ├── muted
│   ├── volume
│   ├── health         (from §2.1/§2.2's watchdog)
│   └── gameId
└── revision            (monotonically increasing counter)
```

`revision` is what makes this trustworthy: every remote can tell at a glance whether it's
looking at the latest state or something stale, and a reconnecting remote can request "give
me everything since revision N" instead of blindly trusting whatever it last had cached.
This is the same pattern Philips Hue/Home Assistant use — the remote *displays* what the
device reports, it never *assumes* what the device is doing.

**Practically:** this should absorb the ad-hoc status messages already planned elsewhere
in this document rather than running alongside them — §1.4's connected-clients list,
§2.2's per-slot health dot, and the existing `DisplayStatus`/`AdStatus` messages are all
naturally just fields or siblings of one `WallState` broadcast instead of separate message
types. Worth doing this consolidation **before** building §2's reliability work, so health
status has one home from the start instead of getting refactored into `WallState` later.

### 7.2 Add Undo [x]

GameWall has a lot of destructive or rearranging actions by now: replacing a game, move-
to-Main, changing layout, closing a stream, applying a preset, auto-grab replacing
something, a Day Planner transition, commercial-dim swapping audio, and eventually custom
layout edits. Confirmation dialogs (`Are you sure?`) in front of all of these would make
the app feel slow, which cuts against the whole point of GameWall being a fast, glanceable
remote. A toast-with-undo pattern fits much better:

> Georgia moved to Screen 1 — **Undo** *(dismisses after ~8s)*

Maintain a rolling action history:

```
actionHistory = [
  { type: "slotAssignment", before: wallSnapshot, after: wallSnapshot, timestamp },
  ...
]
```

`before`/`after` being full `WallState` snapshots (§7.1) rather than just the one changed
field makes rollback trivial and uniform — undo is always "re-broadcast the `before`
snapshot," regardless of what kind of action caused the change.

**Automated actions should push history entries too, not just manual ones** — an auto-grab
replacement, a commercial-dim swap, or a Day Planner transition the user disagrees with
should be just as undoable as something they did by hand. That matters more as the
automation in §3/§6 gets smarter and occasionally makes a call the user wants to reverse.

An optional **History drawer** falls out of the same data for free:
```
3:42 — Georgia → Screen 1
3:41 — Screen 4 closed
3:38 — Featured layout applied
3:32 — AutoGrab replaced Michigan/Ohio State
```
Genuinely useful for making sense of what the automation has been doing over the course of
a long day, not just for undoing the most recent thing.

### 7.3 Differentiate Close from Clear [x]

Today, `Close` sets `slot.label`/`slot.network` to null but keeps enough to power the
`Reopen` button — the slot shows something like:
```
Screen 3
Georgia @ Florida
Stream closed
[ Reopen ]
```
That's the right behavior for an **accidental or temporary** close — one tap gets the same
game right back. But it conflates two different intents that deserve to be separate
actions:

- **Close (soft):** "stop this stream for now, but remember it" — current behavior,
  exactly as-is. Good for a bathroom break, or pausing a slot mid-game.
- **Clear (hard):** "I'm done with this, forget it" — wipes `lastUrl`/`lastLabel`/
  `lastNetwork`/`lastGame` entirely and returns the slot to a genuinely empty state
  ("Empty — tap a game"), with no lingering `Reopen` prompt.

Without the second option, a closed slot's `Reopen` chip can linger indefinitely —
including well past the point the game itself has ended, which is just clutter by the time
you've mentally moved on. Concretely: add a small dismiss affordance (an ✕ on the `Reopen`
chip, distinct from the `Close` button itself) that clears the slot's memory outright, and
consider auto-promoting a soft `Close` to a full `Clear` once the associated game has been
`completed` for a while (say, an hour) so stale prompts don't survive into next week on
their own.

Worth noting the relationship to §7.2: `Reopen` is a slot-scoped, indefinitely-available
memory of "the last thing here," while `Undo` is a short-lived, global action history.
They can coexist — closing a slot both keeps it reopenable *and* pushes an undo entry — but
it's worth keeping the two concepts distinct in the UI so people aren't left wondering
which one to reach for.

---

## Suggested build order overall
1. **§7.1 single source of truth first, before anything else.** Every other section that
   touches state (reliability's health status, multi-remote awareness, undo, the day
   planner) is cleaner to build on top of a real `WallState`/`revision` model than to
   retrofit into it later.
2. §7.2 Undo — natural to add right alongside §7.1, since undo is just "rebroadcast a
   previous `WallState` snapshot."
3. Reliability (§2) — now folds its health status straight into `WallState` per §7.1.
4. §7.3 Close vs. Clear — small, self-contained, good to knock out early.
5. Remote UX items other than §1.6 — mostly additive, low risk, quick wins.
6. Smarter automation (§3) — builds on the auto-grab/auto-dim logic already in place, and
   now pushes its replacements into the §7.2 action history.
7. Data panel (§5) — small, isolated, and a nice way to validate the multi-sport data
   fields from §4 land correctly before building the race-card UI around them.
8. Multi-sport (§4) — the largest data-model change.
9. Visual layout editor (§1.6) — the biggest rendering-architecture change, most worth
   doing once everything sitting on top of the layout system is already stable.
10. Day planner (§6) last — it composes §1.6, §3.1, and the existing auto-grab/auto-dim
    logic, so it's the natural capstone once all of those are independently solid.


