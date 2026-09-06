# GameWall — full system overview

Two Windows apps that work together, plus a webpage:

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  GameWallDisplayHost         │◄──WS───│  GameWallControlServer        │
│  (WPF + WebView2)            │  :5000 │  (ASP.NET Core)                │
│  - renders the 8-slot grid   │        │  - serves the Remote webpage   │
│  - actually plays the games  │        │  - fetches/filters the         │
│  - listens for commands      │        │    schedule from ESPN          │
└─────────────────────────────┘        └──────────────────────────────┘
        runs on your PC                          runs on your PC, :5050
                                                          ▲
                                                          │ HTTP + WS
                                                  ┌───────┴────────┐
                                                  │   Remote page   │
                                                  │ (phone/laptop/  │
                                                  │  any browser)   │
                                                  └─────────────────┘
```

Both server apps run **on the same Windows PC** that's connected to your
monitors. Your phone (or any other device on the same WiFi) just opens a
browser to that PC's address — nothing installs on the phone.

## Running it

1. Start the Display Host:
   ```
   cd GameWallDisplayHost
   dotnet run
   ```
   Note the IP address it shows in its top-left overlay, e.g. `192.168.1.42`.

2. Start the Control Server:
   ```
   cd GameWallControlServer
   dotnet run
   ```

3. On your phone or another computer, open a browser to:
   ```
   http://192.168.1.42:5050
   ```
   (use the IP from step 1)

4. On that page, type the same IP into the **"Display PC address"** box at
   the top and hit **Connect** — this is what lets the remote send
   commands (mute, navigate, layout changes) to the Display Host at
   `:5000`. It's saved in the browser so you only do this once per device.

5. Tap **Test mode** to load 8 sample clips and confirm your layout looks
   right before kickoff.

## What each piece is responsible for

**GameWallDisplayHost** (built first) — owns the video. Nothing else. It
has no idea what "college football" is; it just receives `{ action:
"navigate", slot: 3, url: "..." }` style commands and obeys them. See its
own README for the full command list.

**GameWallControlServer** — owns the schedule and hosts the remote page.
It calls ESPN's public scoreboard endpoint for FBS games, filters to
kickoffs within roughly the next 2 days (and keeps anything that finished
in the last 12 hours so recent scores don't vanish), and returns clean
JSON the webpage renders as sidebar cards and the ticker.

**Remote webpage** (`wwwroot/`) — the actual "remote." Tap a game, then
tap a screen (works on phones, where native drag-and-drop is unreliable);
drag-and-drop also works as a bonus on desktop browsers. Includes the
layout picker (1/2/4/6/8/featured), per-slot mute/volume/close, test mode,
and close-all.

The monitor picker sends the selected display index to the Display Host. The
host positions its borderless window with Windows display bounds and tracks
the selected display explicitly, supporting per-monitor scaling and monitors
arranged left or above the primary display. If a move fails, the host status
overlay reports the Windows error.

## The one real limitation, stated plainly

There's no public API that hands out a direct, per-game deep link into
Hulu/YouTube TV/Fubo/etc. ESPN's schedule data tells you *which network*
is carrying a game (ESPN, ABC, FOX, SEC Network...), not a URL to that
exact broadcast on your specific streaming service. So `networks.json` in
the Control Server maps each network name to that service's **live/watch
page** (e.g. `hulu.com/live-guide`) — dropping a game onto a slot gets you
to the right app/channel, and you may still need to tap the correct game
once on some services. Edit `networks.json` to match whichever service you
actually subscribe to; it's plain JSON, no rebuild needed.

## First-run checklist

- .NET 8 SDK installed
- WebView2 Runtime installed (bundled with Edge on most modern Windows)
- Allow both apps through the Windows Firewall prompt on first run
  (only need "Private networks" — you don't need to expose this to the
  internet since everything's LAN-only)
- Log into your streaming accounts once inside any slot — the Display
  Host remembers it after that, across all 8 slots and future restarts

## The Remote says "not connected"

The remote can auto-detect the Display Host only when the page was opened
from the wall PC. From a phone, open http://<wall-ip>:5050 and use that
same wall IP in the Display PC address field. If it still won't connect,
check in this order:

1. **Is the GameWall Display window actually open and running on the PC?**
   Look for a window titled "GameWall Display" in the taskbar. If it
   crashed or you closed it, the Remote has nothing to talk to.

2. **Viewing the Remote on the same PC?** `ws://localhost:5000` should
   just work the moment the Display Host is running — Windows Firewall
   doesn't block loopback (same-machine) traffic, so firewall isn't the
   issue here.

3. **Viewing the Remote from your phone or another device?** Both
   `GameWallDisplayHost.exe` (port 5000) and `GameWallControlServer.exe`
   (port 5050) need to be allowed through Windows Firewall on **Private
   networks**. Check: Windows Security → Firewall & network protection →
   Allow an app through firewall — both should be listed and checked
   under "Private". If either is missing, run these once, as
   Administrator, in PowerShell on the Display Host PC:
   ```
   netsh advfirewall firewall add rule name="GameWall Display Host" dir=in action=allow protocol=TCP localport=5000
   netsh advfirewall firewall add rule name="GameWall Control Server" dir=in action=allow protocol=TCP localport=5050
   ```

4. **Double-check you're both on the same WiFi network** — a phone on
   cellular data or a guest network won't be able to reach the PC at all.

The connection indicator in the top bar will say "not connected — check
firewall?" after a few failed attempts as a nudge toward step 3.

