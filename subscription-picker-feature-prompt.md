# Task: Add a streaming-subscription picker to GameWall's Remote webpage

## Context (read this first)

This is a feature addition to an existing small system called GameWall,
used to multiview college football/NFL games across up to 8 screens. Two
apps are involved, but you only need to touch **GameWallControlServer**
(an ASP.NET Core app that serves a static webpage and a schedule API).
The other app (GameWallDisplayHost, a WPF app) is out of scope — don't
touch it.

Relevant files in GameWallControlServer, all of which I will paste the
current contents of below this prompt:
- `Program.cs` — minimal API. Serves `wwwroot/`, and has one endpoint,
  `GET /api/schedule`, which fetches college football games from ESPN's
  public scoreboard API, filters to a 2-day window, and returns JSON.
  Each game includes a `network` field (e.g. "ESPN", "ABC", "FOX") and a
  `watchUrl` field computed by looking `network` up in `networks.json`.
- `networks.json` — a flat `{ "NetworkName": "https://..." }` map from
  broadcast network to a single watch URL, plus a `_default` fallback.
- `wwwroot/index.html`, `wwwroot/style.css`, `wwwroot/app.js` — the Remote
  webpage. It shows a sidebar of games (draggable/tappable), an 8-slot
  grid, a layout picker, and a ticker. `app.js` currently computes nothing
  about subscriptions — it just uses `game.watchUrl` as-is from the API
  when a game is assigned to a slot.

## The problem

`networks.json` currently assumes one fixed URL per network, regardless
of what the person actually subscribes to. In reality, most of these
networks (ESPN, ABC, FOX, SEC Network, etc.) are available through
*multiple* competing services (Hulu + Live TV, YouTube TV, Fubo, DirecTV
Stream, Sling...), and the best link to use depends entirely on which of
those the person actually pays for. Right now that's hardcoded and can
only be changed by hand-editing JSON.

## What to build

A first-run "Select your subscriptions" screen in the Remote webpage, and
smarter routing that uses the person's actual subscriptions to pick the
best watch link for each game.

### 1. New data shape for `networks.json`

Replace the flat map with this structure:

```json
{
  "services": {
    "hulu":          { "label": "Hulu + Live TV",     "defaultUrl": "https://www.hulu.com/live-guide" },
    "youtubetv":     { "label": "YouTube TV",          "defaultUrl": "https://tv.youtube.com/live" },
    "fubo":          { "label": "Fubo",                "defaultUrl": "https://www.fubo.tv/welcome" },
    "sling":         { "label": "Sling TV",            "defaultUrl": "https://watch.sling.com/" },
    "directvstream": { "label": "DirecTV Stream",      "defaultUrl": "https://stream.directv.com/guide" },
    "peacock":       { "label": "Peacock",             "defaultUrl": "https://www.peacocktv.com/live-tv" },
    "paramountplus": { "label": "Paramount+",          "defaultUrl": "https://www.paramountplus.com/live-tv/" },
    "primevideo":    { "label": "Amazon Prime Video",  "defaultUrl": "https://www.amazon.com/gp/video/storefront" },
    "espnplus":      { "label": "ESPN+",               "defaultUrl": "https://www.espn.com/watch/" },
    "nflplus":       { "label": "NFL+",                "defaultUrl": "https://www.nfl.com/plus/" },
    "disneyplus":    { "label": "Disney+",              "defaultUrl": "https://www.disneyplus.com/" }
  },

  "networks": {
    "ESPN":               { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome", "sling": "https://watch.sling.com/", "directvstream": "https://stream.directv.com/guide" },
    "ESPN2":               { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome", "sling": "https://watch.sling.com/" },
    "ESPNU":               { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live" },
    "SEC Network":         { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome" },
    "ACC Network":         { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live" },
    "Big Ten Network":     { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome" },
    "ABC":                 { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "directvstream": "https://stream.directv.com/guide" },
    "FOX":                 { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome" },
    "FS1":                 { "hulu": "https://www.hulu.com/live-guide", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome" },
    "CBS":                 { "paramountplus": "https://www.paramountplus.com/live-tv/", "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome" },
    "CBS Sports Network":  { "paramountplus": "https://www.paramountplus.com/live-tv/" },
    "NBC":                 { "peacock": "https://www.peacocktv.com/live-tv", "youtubetv": "https://tv.youtube.com/live" },
    "NFL Network":         { "youtubetv": "https://tv.youtube.com/live", "fubo": "https://www.fubo.tv/welcome", "directvstream": "https://stream.directv.com/guide", "sling": "https://watch.sling.com/" },
    "Amazon Prime Video":  { "primevideo": "https://www.amazon.com/gp/video/storefront" },
    "Peacock":             { "peacock": "https://www.peacocktv.com/live-tv" },
    "ESPN+":               { "espnplus": "https://www.espn.com/watch/" }
  },

  "priority": ["hulu", "youtubetv", "fubo", "directvstream", "sling", "peacock", "paramountplus", "primevideo", "nflplus", "espnplus", "disneyplus"],

  "default": "https://www.espn.com/watch/"
}
```

Note: I generated these URLs from general knowledge and they may be
slightly stale (streaming services change their URLs). Don't worry about
verifying every single one is perfectly current — get the structure and
behavior right; the person can hand-correct individual URLs afterward
since it's plain, editable JSON.

### 2. Server changes (`Program.cs`)

- Add a new endpoint `GET /api/networks` that just reads and returns
  `networks.json` as-is (raw passthrough, parsed as JSON so the response
  is proper JSON not a string).
- Update the existing `/api/schedule` endpoint's internal watch-URL
  computation to work with the new nested schema instead of the old flat
  one: for a game's `network`, walk `priority` in order and take the
  first service that has an entry for that network; if none match, use
  `default`. This keeps `/api/schedule`'s `watchUrl` field working as a
  reasonable generic fallback for any client that hasn't loaded the
  person's actual subscriptions yet — it does NOT need to know about the
  person's selected subscriptions; that personalization happens entirely
  client-side (see below).
- Don't change anything else about `/api/schedule`'s behavior, response
  shape (aside from `watchUrl`'s computation), or the ESPN-fetch logic.

### 3. Client changes (`wwwroot/`)

**New first-run screen**: a full-screen modal/overlay shown automatically
when `localStorage.getItem('gamewall_subscriptions')` is `null` (i.e.
never set before — this is the "first run" signal). It should:
- Fetch `/api/networks` to get the `services` list, and render one
  checkbox per service using its `label`.
- Have a "Save" button that stores the checked service ids as a JSON
  array to `localStorage['gamewall_subscriptions']`, then closes the
  modal and re-renders the schedule/slots so watch links reflect the new
  selections immediately.
- Have a "Skip for now" button that stores an empty array `[]` (so the
  modal doesn't reappear every load, but routing just falls back to
  defaults) and closes the modal.
- Match the page's existing dark theme (reuse the CSS custom properties
  already defined at the top of `style.css` — `--bg`, `--panel`,
  `--hairline`, `--text`, `--accent`, `--font-ui`, `--font-data`, etc.
  Do not introduce a different color palette or default browser checkbox
  styling that looks out of place next to the rest of the UI.)

**Settings button**: add a small button/icon in the top bar (near the
existing layout picker) that reopens the same modal at any time, with
whatever's currently saved in `localStorage['gamewall_subscriptions']`
pre-checked, so the person can change their answer later.

**Routing logic**: add a function, roughly:

```js
function pickWatchUrl(networkName, userServiceIds, networksData) {
  const entry = networksData.networks[networkName];
  if (entry) {
    // Prefer a service the user actually has, in priority order
    for (const svc of networksData.priority) {
      if (userServiceIds.includes(svc) && entry[svc]) return entry[svc];
    }
    // User has something for this network not covered by priority order
    for (const svc of userServiceIds) {
      if (entry[svc]) return entry[svc];
    }
  }
  // Nothing matched this network specifically - fall back to the
  // general page for whatever service the user has, in priority order
  for (const svc of networksData.priority) {
    if (userServiceIds.includes(svc)) return networksData.services[svc]?.defaultUrl;
  }
  return networksData.default;
}
```

Fetch `/api/networks` once on page load and cache it. When rendering the
schedule sidebar and when assigning a game to a slot, use
`pickWatchUrl(game.network, savedSubscriptions, networksData)` instead of
the raw `game.watchUrl` the API returned — the API's value is only a
fallback for the brief moment before `/api/networks` and
`localStorage` have loaded.

**Don't touch**: the manual "Add a game" custom-entry form already lets
the person type a URL directly — that path should keep working exactly
as-is and bypass all of this (custom games already carry their own
`watchUrl`).

## Hard constraint — do not violate this

Do not attempt to scrape, reverse-engineer, or call any private/internal
API belonging to Hulu, YouTube TV, Fubo, Disney+, Peacock, or any other
streaming service in order to construct exact per-game deep links. None
of these services expose a public API for this. The correct and only
acceptable behavior is linking to each service's general live-guide or
watch page — exactly what a person would get to by clicking around
manually. Also: no UI text or behavior should imply that selecting a
subscription "unlocks" content the person doesn't actually pay for — a
game exclusive to a service they didn't select (e.g. an ESPN+-exclusive
game with no linear-TV simulcast) has no possible link that makes it
watchable without that subscription. That's a licensing reality, not
something this feature can or should paper over.

## Acceptance checklist

- [ ] First-ever page load (no `gamewall_subscriptions` in localStorage)
      shows the picker automatically, before/over the normal UI
- [ ] Picker lists at least: Hulu + Live TV, YouTube TV, Fubo, Sling TV,
      DirecTV Stream, Peacock, Paramount+, Amazon Prime Video, ESPN+,
      NFL+, Disney+
- [ ] Saving persists selections across page reloads
- [ ] "Skip for now" doesn't nag again on next load, but a settings
      button still lets the person configure it later
- [ ] Game routing prefers a service the person actually selected, in
      priority order, before falling back to generic defaults
- [ ] `GET /api/networks` returns the full JSON structure above
- [ ] `GET /api/schedule` still returns a sane `watchUrl` per game even
      before any subscriptions are configured
- [ ] Nothing else already working breaks: drag-and-drop, tap-to-place,
      mute/volume/close/reopen per slot, layout picker, test mode,
      close-all, the ticker, the auto-connecting WebSocket status
      indicator, or the manual "Add a game" form
- [ ] New UI elements visually match the existing dark theme (same CSS
      variables, same fonts, no default unstyled form controls)

---

Below this line, paste the current contents of:
`Program.cs`, `networks.json`, `wwwroot/index.html`, `wwwroot/style.css`,
`wwwroot/app.js`
