# Window Seat

An offline-first web app for the iPhone that shows what is out the airplane window: a map with your
live GPS position, the planned route and corridor, a "look left / look right" list of notable
features coming up, a day/night line, a daylight timeline for the whole flight, and short offline
Wikipedia summaries. After one download it makes **no network requests at all**.

Built for QR720 SEA → DOH. Live at **https://magebeans.github.io/window-seat/**. Everything flight-specific is in [`config/flight.json`](config/flight.json).

```
config/flight.json   flight, schedule, corridor width, zoom rules, size budget, POI settings
tracks/              optional real flight tracks (KML / CSV / GPX / GeoJSON) for the route line
pipeline/            data build (Python, run once on the Mac)
web/                 the static site (plain ES modules, no bundler); data/ vendor/ fonts/ are generated
scripts/             build.sh, deploy.sh, serve.py
tests/               unit tests (node --test) and an offline end-to-end test (Playwright)
CHECKLIST.md         what to do on the phone the night before
```

## Before you build: set the date

`departure` in `config/flight.json` is a **placeholder (2026-12-05 16:25 PST)**. The daylight
timeline, day/night line and the zoom plan (which stretches get detailed tiles) all depend on it.
Set your real date and the scheduled time, then rebuild. Departure has been listed at 16:25 for
recent dates; check it against your booking.

## Route: great circle, until you add tracks

No track history could be fetched automatically. FlightAware and FlightRadar24 both refuse
scripted requests, and their KML/CSV exports need a logged-in browser. **The route is therefore the
great circle**, which for SEA → DOH runs over northern Canada, close to the North Pole, then down
over Russia, Kazakhstan, the Caspian and Iran. The real QR720 may route differently. The corridor
is 300 km wide, so a track that strays far from the great circle can leave the detailed tiles.

To use real tracks (2 or 3 is ideal), any of these works:

- **Download from a browser.** Use FlightAware ("Track log & graph", then KML) or FlightRadar24
  (playback, then "Download KML/CSV"; needs a paid plan). Put the files in `tracks/` and rebuild.
  The line follows the median-length track, and the corridor widens to contain the others.
- **adsb.lol open data.** Run `pipeline/fetch_adsblol.py 2026-11-18`. It streams one day of
  the global ADS-B archive and keeps only the QTR720 leg. Each day is about **3.8 GB downloaded**
  (nothing is stored), so it asks before it starts. It has not been run as part of this build.
- **No rebuild at all.** On the phone, open ⚙︎ → Route → *Import track* and pick a KML, GPX, CSV
  or GeoJSON file. That replaces the route line, timeline, simulation and look list right away.
  It is stored on the device. The basemap does not change, so detail outside the original
  corridor stays at the low "wide" zoom.

## Rebuilding the data

Prerequisites: `uv`, Node, Go (or `brew install pmtiles`), git. Then:

```bash
npm install
scripts/build.sh            # setup + route + basemap + pois + assets (about 15 min, ~300 MB download)
```

Steps can be run on their own. Each one reads the output of the one before it:

| step | command | output |
|---|---|---|
| route | `scripts/build.sh route` | `web/data/route.json`, `build/segments.json`; prints the per-segment daylight/water/zoom table |
| size plan | `scripts/build.sh plan` | dry-run of every extract; **prints MB per segment and downloads nothing** |
| basemap | `scripts/build.sh basemap` | `web/data/tiles/<hash>/p*.bin` (the merged PMTiles in 4 MiB parts) |
| POIs | `scripts/build.sh pois` | `web/data/pois/*.json` |
| assets | `scripts/build.sh assets` | vendored libraries, fonts, sprites, icons, `precache.json`, `sw.js` |

### Adjusting size and detail

Zoom is chosen per ~250 km segment from the sun at that point when you pass it and from how much of
the corridor is water (`zoom` in the config). Current defaults: day land z12, twilight land z12,
night land z10, day water z8, night water z6. The whole planet is included at z0–4 and a 1,200 km
band at z5–6, so the map is never blank. Each airport gets z13 within 40 km.

```bash
scripts/build.sh plan                       # see sizes
scripts/build.sh plan --override 4=11       # try region 4 at z11
scripts/build.sh plan --fit                 # step zooms down until it fits budget_mb
scripts/build.sh basemap --override 4=11    # build with that
```

For a lasting change, edit `zoom` (or add `"zoom_overrides": {"km 7194-10165": 11}`) in the
config. With the placeholder date the basemap is **300 MB** and the whole site is about **314 MB** (895 files).

### POIs

Wikidata (via SPARQL, in boxes along the route) gives every item with coordinates and an English
article. It is typed from its Wikidata class (city, peak, lake, river, glacier, island, coast,
region) and ranked by English Wikipedia **page views over the last 60 days**, with a bonus for
natural landmarks and for features close to the track. The top `per_100km` per 100 km of route
are kept, if they have at least `min_views`. Summaries are the plain-text first paragraph,
pronunciation removed, capped at 600 characters. Wikimedia throttles anonymous clients; if you get
repeated HTTP 429, set `WS_USER_AGENT="window-seat/0.2 (you@example.com)"` before running. All API
responses are cached in `.cache/wiki/`.

## How offline works (and why this way)

**Basemap: one PMTiles archive, split into 4 MiB parts, with Range requests served by the
service worker.** pmtiles.js reads the archive with HTTP Range requests. The Cache API cannot
answer those, so `sw.js` serves the virtual URL `data/basemap.pmtiles`. For each range it reads
only the cached part(s) the range covers, slices them, and returns a proper `206`. It keeps a
6-part (24 MB) in-memory LRU, since neighbouring tiles sit in the same part.

The alternatives, and why not:

- **Range over one cached 300 MB blob.** This is the textbook option (a). On iOS, reading a body
  that size from the Cache API can pull the whole thing into memory, and WebKit kills the page
  under memory pressure without warning. Parts keep the working set at a few MB per request.
- **Individual z/x/y tile files (b).** This needs about 71,000 Cache API entries and 71,000
  requests to fill them. Install takes far longer, each entry costs per-record overhead against
  the quota, and GitHub Pages rate-limits that many requests. Duplicate ocean tiles also cannot
  be shared the way PMTiles deduplicates them. 72 parts are 72 entries.

**Install: the shell at install, the data from the page.** The service worker precaches the small
app shell (about 2.5 MB) in its `install` event, so the app always boots offline. The big files are
then downloaded **by the page**, one at a time, each checked against its SHA-256 from
`precache.json`. This differs from "everything in the install event" on purpose. iOS can kill a
service worker during a long install, and a failed install discards the worker and everything it
fetched. The page-driven loop resumes from where it stopped, shows `X of Y MB cached, ready for
offline`, and holds a wake lock while it runs.

**Missing files fail visibly.** A request the cache cannot answer while offline gets a 504, and
the page shows a red banner naming the file. ⚙︎ also shows a counter of any network fetches, which
must read **0** after the airplane-mode reload. Uncached glyph ranges are the one exception: they
return an empty PBF, so labels in scripts the fonts do not cover are skipped instead of erroring.

**iOS specifics.** The manifest and `apple-touch-icon` are included, and `viewport-fit=cover` with
`env(safe-area-inset-*)` keeps the layout clear of the notch and home bar. Location is requested
from a button tap (iOS standalone apps are fussy about prompts without a gesture). Persistent
storage is requested and the result shown. The screen is kept on with the Wake Lock API plus a
muted looping inline video, because Wake Lock did not hold in home-screen apps before iOS 18.4.
**Storage in the home-screen app is separate from Safari's**, so download inside the installed app.

## Testing

```bash
npm test                    # unit tests: geometry, sun, look list, heading estimation
npm run e2e                 # Chromium: download everything, kill the server, reload, check it all
npm run serve               # http://localhost:8080 ; add ?sim (&speed=300 &at=600) for a fake flight
```

**Simulate flight.** Open `http://localhost:8080/?sim`, or pick ⚙︎ → Position → Simulate flight.
It replays the route as fake GPS with noise, at 1–1000×, and runs a simulated clock so the
day/night line and ETAs match. Tap the timeline to jump to any point of the flight. `?at=640`
starts 640 minutes after departure (over Russia in daylight with the placeholder date).

## Deploy to GitHub Pages

```bash
scripts/deploy.sh
```

This pushes `web/` as a single orphan commit to the `gh-pages` branch (force-pushed, so the 300 MB
of tiles never builds up in history) and enables Pages on first run. `main` holds only source; the
generated data is git-ignored. Every file stays under GitHub's 100 MB limit, and the site stays
under Pages' 1 GB limit.

## Install on the iPhone

1. In **Safari**, open the Pages URL.
2. Share → **Add to Home Screen**.
3. Open it **from the Home Screen icon** (not Safari) and let it finish downloading. ⚙︎ shows
   progress.

Then go through [CHECKLIST.md](CHECKLIST.md).

## Data and licences

Map data © OpenStreetMap contributors (ODbL), tiles from the Protomaps daily build. MapLibre GL JS
(BSD-3), pmtiles (BSD-3), Noto Sans (OFL). Summaries from Wikipedia (CC BY-SA 4.0); notability
from Wikidata (CC0) and Wikimedia page views. Country lookup from Natural Earth (public domain).
