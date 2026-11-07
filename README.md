# Runplan

A free running coach for your phone. Builds a plan for your race, gives every run target paces, adapts when life gets in the way, and syncs runs from your Garmin for free.

No account, no ads, no subscription. Your data stays on your phone.

## Put it on your phone (GitHub Pages, free)

1. Sign in at github.com and create a new **public** repository called `runplan` (free accounts can only publish public repos; your training data is never in the repo, it stays on your phone).
2. Click **uploading an existing file**, drag in everything inside this folder (not the folder itself), then **Commit changes**.
3. Repo **Settings > Pages**: Source **Deploy from a branch**, branch **main**, folder **/ (root)**, Save.
4. After a minute, open `https://YOUR-USERNAME.github.io/runplan/` on your phone.
5. Install it:
   - iPhone: Safari, Share button, **Add to Home Screen**.
   - Android: Chrome, menu, **Install app**.

It then opens full screen like a normal app and works offline.

## Free auto sync from your Garmin

Strava's API now needs a paid Strava subscription, so this uses intervals.icu instead (free).

1. Sign up at intervals.icu and connect **Garmin** (connect Garmin directly, not Strava: runs that arrive via Strava can't be passed on).
2. On intervals.icu: Settings, scroll to **Developer Settings**, create an API key.
3. In Runplan: Settings, **Auto sync**, paste the key, leave Athlete ID as 0, **Save and sync**.

The app then pulls new runs each time you open it and ticks off the planned run on the same day. Runs on days with nothing planned go in as extra runs.

## How the plan works

- **Paces** come from a recent race or time trial (Jack Daniels' VDOT formula). Easy, threshold, interval and race paces all update together.
- **Phases**: Base, Build, Peak, Taper. Every 4th week is easier, with an optional 5K time trial that updates your paces.
- **Weekly km** rises about 8% a week, and a normal week is never more than 10% above the last one.
- **Hard sessions** never fall on back-to-back days and avoid your other training days (gym legs, football) and the day after where possible.
- **Adapts**:
  - Last week well under or over plan: offers to rebuild the coming weeks from what you really ran.
  - 3 hard sessions in a row felt easy (effort 5 or less): offers faster paces. 2 of 3 felt 9+: offers slower.
  - Time trial or race result: paces update straight away.
  - Not feeling 100%: turn a run into a short easy one, or rest.
  - Move or swap runs within a week.

## Back up

Everything is saved in the browser on your phone. Settings > **Save backup** now and then. **Restore** loads it on a new phone. Clearing Safari/Chrome website data deletes it.

## Change things

All files are plain HTML, CSS and JavaScript. Edit on GitHub (pencil icon) and commit.

After changing any file, open `sw.js` and bump `VERSION` (for example `runplan-v2`), or phones will keep the old cached copy.

| file | what it does |
| --- | --- |
| index.html | page shell and tab bar |
| styles.css | look and colours (tokens at the top) |
| js/app.js | screens and buttons |
| js/plan.js | plan generator |
| js/adapt.js | adaptation rules |
| js/vdot.js | pace maths |
| js/sync.js | intervals.icu sync |
| js/store.js | saving, backup |
| js/charts.js | progress charts |
| js/dates.js | date helpers |
| sw.js, manifest.webmanifest, icons/ | offline and home screen install |
| tests/plan.test.js | tests (`node --test tests/plan.test.js`) |
| replica/ | build notes: recon of Runna, architecture, test results |

Not medical advice. If something hurts in a way that changes how you run, rest and get it checked.
