# GameWall Display Host

The video-rendering half of the GameWall system. This app owns the 8-slot
grid and plays the actual games — it has no schedule UI, no drag-and-drop,
no remote-control buttons. All of that lives in a separate "Remote"
webpage (built next) that talks to this app over the local network.

## What this app does

- Shows up to 8 borderless game panels in switchable layouts (1, 2, 4, 6, 8-up,
  or a "featured" 1-big/4-small layout)
- Persists streaming logins (Hulu, etc.) across restarts — all 8 panels
  share one WebView2 profile folder, so signing into an account once
  applies everywhere
- Listens on a local WebSocket for commands: navigate a slot, mute/unmute,
  set volume, close a slot, switch layout, move to a monitor, or trigger test mode
- Test mode (press **F5**, or send a `test` command) loads 8 sample video
  clips into an 8-up grid so you can check your layout without waiting for
  kickoff

## Requirements

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download) or later
- **WebView2 Runtime** — already installed on most Windows 11 / recent
  Windows 10 machines (it ships with Edge). If missing, grab the
  "Evergreen Bootstrapper" from Microsoft's WebView2 download page.
- Visual Studio 2022 (or `dotnet build`/`dotnet run` from the CLI)

## Building & running

```
cd GameWallDisplayHost
dotnet restore
dotnet run
```

The app opens maximized, borderless, in a 4-up layout by default. A small
overlay in the top-left shows the LAN address and port the remote needs to
connect to, e.g. `Listening: 192.168.1.42:5000`.

## Networking note (important)

This app uses a raw `TcpListener` for its WebSocket server, **not**
`HttpListener`. That's intentional: `HttpListener` requires either
Administrator rights or a one-time `netsh http add urlacl` reservation to
accept connections from other devices on Windows. `TcpListener` on an
ordinary port does not have that restriction, so your phone/other browser
can connect immediately with no extra setup.

You will likely still see a **Windows Defender Firewall** prompt the first
time you run the app ("Windows Firewall has blocked some features of this
app..."). Click **Allow access** (at least for Private networks) — this is
what actually lets your phone reach it.

## Keyboard shortcuts (on the Display Host itself)

- **F5** — run test mode (loads 8 sample clips)
- **F11** — show/hide the status overlay
- **Esc** — quit

## Command protocol (for the Remote to use)

Connect a WebSocket to `ws://<host-ip>:5000/` and send JSON text frames:

```json
{ "action": "navigate", "slot": 2, "url": "https://www.hulu.com/watch/..." }
{ "action": "mute", "slot": 2, "muted": true }
{ "action": "volume", "slot": 2, "volume": 0.5 }
{ "action": "close", "slot": 2 }
{ "action": "closeAll" }
{ "action": "layout", "layout": "8" }
{ "action": "displays" }
{ "action": "monitor", "monitor": 1 }
{ "action": "test" }
```

`layout` accepts: `"1"`, `"2"`, `"4"`, `"6"`, `"8"`, `"featured"`.

## What's deliberately not in this app

- No schedule/scores fetching — that belongs in the Control Server, which
  also serves the Remote webpage.
- No drag-and-drop UI — same reason.
- No login form — you log into Hulu (etc.) the normal way, once, inside
  whichever slot you navigate there; the shared profile folder remembers it.

## Next piece

The Control Server + Remote webpage: a small local web server that serves
the schedule sidebar / drag-and-drop / layout picker / per-slot controls
as a responsive page reachable from any phone or browser on the same
network, and forwards its button presses to this app as the JSON commands
above.
