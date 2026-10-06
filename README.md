# Scenario Test Dashboard (web)

The browser dashboard for the
[puppeteer-cucumber-tester-dashboard](https://github.com/Ephraimmo/puppeteer-cucumber-tester-dashboard1)
project. It's a plain static site (no build step) meant to be hosted on Vercel and
opened from any computer.

## How it connects to the Puppeteer project

```
 this site (Vercel)  ──►  Firebase Realtime Database  ◄──  firebase-agent.js (test machine)
                                                              └─ runs cucumber / Puppeteer
```

The page never talks to the test machine directly. Every `/api/*` call in
`dashboard.js` goes through `FB.fetch` in `firebase-client.js`, which reads mirrored
state from Firebase or writes a command there. The agent in the Puppeteer project
(`npm run agent`) picks the command up, does the work, and writes the result back.

So for the dashboard to do anything, **`npm run agent` must be running** on the machine
that has the Puppeteer project. Otherwise actions fail after 20 seconds with "the agent
on your machine did not respond".

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page, including the sign-in overlay and the Firebase SDK script tags |
| `dashboard.js` | Dashboard logic (runs, results, feature editor, step definitions, recording) |
| `dashboard.css` | Styles |
| `firebase-client.js` | Firebase config, sign-in gate, and the `FB.fetch` bridge |
| `vercel.json` | Security headers for the Vercel deployment |

## Deploy to Vercel

1. Push this repo to GitHub.
2. On [vercel.com](https://vercel.com): **Add New → Project**, then import this repo.
3. Leave **Framework Preset** as **Other** and leave the build command and output
   directory empty. There's nothing to build.
4. Click **Deploy**. After that, every push to `main` redeploys automatically.

If sign-in on the deployed site fails with `auth/unauthorized-domain`, add the Vercel
domain (e.g. `your-project.vercel.app`) in the Firebase console under
**Authentication → Settings → Authorized domains**.

## Using it

Open the deployed URL and sign in with the Firebase account the agent uses (see
`FIREBASE_SETUP.md` in the Puppeteer project).

If more than one machine runs an agent (`FIREBASE_AGENT_ID` set on that machine), open
the dashboard once with `?agent=<that id>`. The choice is remembered in that browser.

The **Live browser** panel on Run Overview shows what the test browser is showing during a
run, a few frames a second. Frames are only uploaded while a dashboard has that tab open,
since each one (roughly 20–80 KB) counts toward Firebase download usage. In Windowed mode,
don't minimize the Chrome window on the test machine — Chrome stops painting minimized
windows, so the panel would freeze. Headless runs always stream.

Screenshots from test runs are not synced through Firebase, so they don't appear here.
Pass/fail status, error messages, and durations do.

## Run it locally

Serve the folder with any static server, for example:

```
npx serve .
```

Opening `index.html` straight from disk (`file://`) is not supported by Firebase sign-in.
