# Project instructions — terminology (READ FIRST)

Two products. Never mix them up.

## "Mobile app" = the LIVE, PUBLIC GameDay app on Vercel
- URL: gameday-cfb.vercel.app (Vercel project `gameday-cfb`). This is what real users open on their phones.
- Source: `GameWall-Alpha/web/` (index.html = GameDay, `web/wall/` = the Wall tab and remote UI, `web/api/` = serverless endpoints).
- Changes here only reach users after a deploy: `Deploy GameDay (preview).bat`, then `Deploy GameDay (production).bat` (run on the laptop, needs the Vercel login).
- When the user says "the mobile app", "the app", "live app" or "web app", they mean THIS. A task about it is not finished until it is deployed to Vercel production and checked on the live URL.

## "Wall software" = the LOCAL Windows PC software
- The GameWall Display Host (tray app that draws the screens) and the Control Server, run from `GameWall - Click to Run.bat` on the laptop.
- Source: `GameWall-Alpha/GameWallDisplayHost`, `GameWallControlServer`.
- Not public. Only the owner's laptop runs it. The phone reaches it through the Supabase `wall` function (pairing code).
- When the user says "wall software", "the wall", "local" or "the PC software", they mean THIS.

## How they connect
- The mobile app's Wall tab is the remote control for the wall software.
- One shared remote codebase: `GameWall-Alpha/GameWallControlServer/wwwroot` is the source of truth. `tools/sync-web.sh` copies it into `web/wall` (the mobile app). Always edit wwwroot, run the sync, then deploy `web/`.
- The Day Planner lives in that shared code, so a Day Planner change must be deployed to Vercel for the mobile app to get it, and the wall software needs a rebuild to get it locally.

## Rules for Claude
1. Always say which one you changed: "mobile app (Vercel)" or "wall software (local PC)". Never say "the app" alone.
2. Default target is the mobile app. Do not stop at the local copy.
3. Finishing = changed, tested, deployed to production, verified on gameday-cfb.vercel.app.
4. If a deploy cannot be run from the session, say so up front and give the exact one-step command, not a long explanation.
