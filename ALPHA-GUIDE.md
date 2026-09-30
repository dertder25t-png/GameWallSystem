# GameWall alpha — setup and test guide

The alpha lets you start and run the game wall from your phone, from anywhere,
with every layout and tool from the original GameWall. The laptop runs quietly in
the tray and only wakes the wall up when your phone asks for it.

## What's new

- **Phone remote inside GameDay.** New **Wall** tab (between Games and Teams). It is the
  full GameWall remote: layouts 1/2/4/6/8/Featured, custom layouts, presets, Day
  Planner, pinned teams, last-screen memory, undo/history, stats panels, test mode,
  subscriptions picker, monitor picker. Restyled to GameDay's black look, with a
  phone layout (screens on top, games underneath, tools in one swipeable row).
- **Pair once, control from anywhere.** The laptop shows a 6-digit code; enter it in
  the Wall tab. After that your phone reaches the laptop through the internet, not
  the Wi-Fi.
- **Starts with Windows, sits in the tray.** No browser windows or video players run
  until your phone sends something to show. **End session** clears the screens,
  hides the wall and lets the laptop sleep.
- **Games no longer vanish mid-week.** The schedule now covers this week and next
  (it used to stop 2 days out, hiding Saturday's games until Thursday).
- **Locked down by default.** The laptop accepts no connections from the network.
  Only paired phones can send commands, every command is signed, and web addresses
  must be normal http/https links.

## One-time setup (the laptop)

1. Double-click **`GameWall - Click to Run.bat`**. The first build takes a minute or two.
2. A **Pair your phone** window appears with a 6-digit code.
3. On your phone open **gameday-cfb.vercel.app** (after the deploy below), tap **Wall**,
   enter the code, tap **Pair**. The window on the laptop says *Paired*.
4. The first time you put a game on a screen, sign in to your streaming service
   inside that screen once. Sign-ins are remembered.

GameWall now starts with Windows. Tray icon (bottom-right) menu: Show the wall,
End session, Pair a phone, Paired phones, Forget all phones, Start with Windows,
Allow Wi-Fi remote, Quit.

## Deploying the Wall tab (once, from this laptop)

The phone side lives in GameDay, so GameDay needs a new deploy:

1. Double-click **`Deploy GameDay (preview).bat`**. The first time, it asks you to log
   in to Vercel in your browser. It prints a preview link.
2. Open that link on your phone and add **`/wall/`** to the end. Previews ask for
   your Vercel login because your project protects them.
3. When it works, run **`Deploy GameDay (production).bat`** (type YES) to put it on
   gameday-cfb.vercel.app for everyone. You can roll back in the Vercel dashboard.

The pairing server is already live; nothing else needs deploying.

## Game day

1. Plug the laptop into power and the projector, open the lid.
2. Phone → GameDay → **Wall**. The laptop shows as *online* (green dot).
3. Pick a layout, or apply a saved preset. Tap a game, then a screen.
4. **Display** (in the tool row) picks the projector if it isn't chosen yet.
5. Done for the day: **End session**.

## If something goes wrong

| What you see | Try this |
| --- | --- |
| Phone says *offline* | Laptop asleep or GameWall not running: open the lid; tray icon → Show the wall. |
| *No longer paired* | Tray icon → Pair a phone…, enter the new code. |
| A screen won't play video | Note which service. Some services block embedded players; this is the #1 thing we're testing. |
| Build error in the .bat | Copy the red error text and send it back. |
| Internet is down | **`GameWall - Offline Remote (this PC only).bat`** opens the old local remote on the laptop. |

## What to report back

- Which streaming services played, and which didn't (and in what layout).
- Anything from the old GameWall that's missing or behaves differently.
- How long Saturday setup took, start to kickoff.
- Anything confusing on the phone.

## Known alpha limits

- Scores and schedules still come from ESPN's unofficial feed (agreed for the private
  alpha; swapped for CollegeFootballData before anyone pays).
- Volume per screen and the "stalled screen" check still run a tiny script inside the
  streaming page; both get replaced before paid launch.
- A sleeping laptop can't be woken from the phone; open the lid.
- Pairing codes last 10 minutes and work once.
