# Watt's Left — live EV range prediction

A phone-installable web app that predicts **when your electric car's battery
will hit 0%**, based on the conditions you are actually driving in — speed,
climate/AC setting, outside temperature, headwind, passenger and cargo load,
elevation, and battery health.

Your car's built-in range estimate is essentially *"remaining kWh ÷ average
consumption over the last few kilometres"*. That is **backward-looking**: it has
no idea you are about to join a motorway at 130 km/h, or that you just turned
the AC to maximum. This app is **forward-looking** — you tell it the conditions,
and it computes the consumption those conditions produce.

---

## Navigation

A full-screen map with turn-by-turn directions, spoken guidance, route
alternatives, off-route detection and automatic rerouting — built entirely on
free, keyless services.

**What it is not:** this is not Google Maps, and three gaps are worth naming.
There is **no live traffic**, so travel times are free-flow estimates. There is
**no Street View** and no lane-guidance imagery. POI coverage is
OpenStreetMap's — excellent in cities, patchier for small businesses.

**What it does that Google Maps does not:** rank route alternatives by
**battery**, not just by time.

### Route alternatives, compared by energy

Cairo → Alexandria, as the app shows it:

| | Time | Distance | Energy | Arrival |
|---|---|---|---|---|
| Route 1 | 2 h 26 | 218 km | 35.8 kWh | **18%** |
| Route 2 | 2 h 37 | 236 km | 38.8 kWh | **13%** |

Every alternative gets its own elevation profile and its own run through the
physics model, so the arrival percentage is a real prediction rather than a
proportional guess. When the fastest route is *not* the least-battery one, they
get "Fastest" and "Least battery" badges so the trade-off is explicit.

Worth being straight about: in the routes tested so far the fastest route was
also the leanest, so those badges did not appear. Munich → Innsbruck is a good
example of why — the 146 km route climbs 1521 m and the 164 km alternative
climbs only 656 m, but the shorter one still wins, because 18 km of extra
driving costs more than 865 m of extra climbing saves. The comparison is the
valuable part; the badges are just labels on top of it.

### Turn-by-turn

- **Next-manoeuvre banner** with an arrow, the distance, and the instruction,
  plus a smaller "then…" line for the manoeuvre after it.
- **Spoken guidance** via the browser's built-in speech synthesiser — free, no
  API key, works offline on most platforms. Announcements fire at roughly 30 s,
  12 s and 4 s of travel time ahead, so the warning distance scales with speed
  rather than being a fixed 300 m that is ample in town and far too late at
  120 km/h.
- **Off-route detection** with automatic rerouting, but only after 6 seconds
  genuinely away from the line. A single bad fix, a parallel service road or a
  multi-level junction all momentarily read as "off route", and rerouting on
  every one of those would be maddening.
- **Snap-to-route** positioning, so remaining distance comes from where you
  actually are on the route rather than dead reckoning — a detour or a traffic
  queue no longer corrupts it.
- **Directions list** in the bottom sheet, with completed steps dimmed and the
  current one highlighted.

### Map

Three basemaps — **Dark** (CARTO), **Light** (CARTO Voyager) and **Satellite**
(Esri) — chosen with the layer button.

The dark style is a real dark-designed basemap. An earlier version faked one by
applying `filter: invert(1) hue-rotate(180deg)` to the standard OpenStreetMap
tiles, which also inverts the labels and the colour-coding: motorways came out
the wrong colour and text read like a photographic negative. That is gone.

## Trip planning

Nobody knows their trip's elevation change, so the app works it out. Type a
start and destination and it fetches:

- **Real road distance** from OSRM — not a straight line. Amsterdam to
  Rotterdam is 57 km as the crow flies but 80 km by road.
- **The full elevation profile** from Open-Meteo, sampled about every kilometre.
- **Current temperature and wind** at the route midpoint, with the wind
  resolved onto your actual direction of travel.

That removes four manual inputs at once: distance, elevation, temperature and
headwind.

### Why a profile beats a net elevation figure

Munich → Innsbruck, measured by the app:

| | Net elevation only | Full profile |
|---|---|---|
| Elevation input | +49 m | 1505 m up, 1456 m down |
| Cost of terrain | 2.3 Wh/km | **30.9 Wh/km** |
| Total consumption | 230 Wh/km | **258 Wh/km** |
| Charge on arrival | 36% | **30%** |

The route ends just 49 m higher than it starts, so a net-elevation model calls
it almost flat. It is not — it crosses the Alps. Regen returns only about 65%
of what a climb costs, so 1505 m of climbing and 1456 m of descending leaves
you meaningfully out of pocket. A pure round trip returning to its own starting
altitude still costs ~29 Wh/km in this car.

### The search box

Behaves the way a maps app should: results as you type (debounced, and the
previous request is aborted), arrow keys to move through them, Enter to pick,
Escape to close. Each result is two lines — a bold name and its address context
— with a category icon and, where relevant, the distance from your other
endpoint.

### Search is ranked around where you are

This is the single most important thing about making search feel correct.
Without a bias point a geocoder ranks by global importance, so searching
"mcdonalds" from Cairo returns Sydney, Caracas and Little Falls. Measured:

| Approach | Result searching "mcdonalds" from Cairo |
|---|---|
| No bias | Sydney, Caracas, Little Falls, Hickory ❌ |
| `lat`/`lon` bias | Bab al Luq 167 m, Talaat Harb 1.0 km, Gezira 1.5 km ✅ |
| `lat`/`lon` + `location_bias_scale=1` | back to Sydney/Caracas ❌ |

Note the third row. Photon's documented "bias strength" parameter **breaks**
the bias rather than strengthening it. Plain `lat`/`lon` is what works.

**The app finds your area from your device's timezone, with no permission
prompt.** IANA timezone identifiers are city names — `Africa/Cairo`,
`America/New_York` — so the app geocodes the timezone itself. No popup, no
tracking, no IP lookup. Precision does not matter here: being 40 km off is
irrelevant when the job is ranking Cairo above Sydney.

That guess follows your computer's clock, so it is surfaced as an editable
**"Searching near Cairo"** chip rather than applied invisibly. Change it and
everything re-ranks around the new area.

Bias order, most specific first: the other end of your trip → the current map
view → your home region.

It **ranks, it does not restrict**. Biased to Cairo:

- `الزمالك` → Zamalek, Cairo (2.6 km) — Arabic works with no extra setup
- `Carrefour` → Giza (8.0 km), not France
- `Alexandria` → Alexandria **Egypt** (182 km), above Alexandria Louisiana
- `Berlin` → Berlin **Germany** first — planning a trip abroad still works

Duplicates are collapsed. OpenStreetMap stores one railway station as several
records (the station area, the building, the entrance, the drop-off bay), all
with the same name a few hundred metres apart.

### About "use my current location"

**On a phone this is accurate. On a laptop it is often badly wrong**, and that
is not something the app can fix — a laptop has no GPS chip, so the browser
falls back to looking up nearby Wi-Fi networks or your IP address. That can be
hundreds of metres out on a good day and tens of kilometres out on a bad one,
sometimes landing on your ISP's exchange in another city.

What the app does instead is refuse to hide it:

- the coordinates are reverse-geocoded to a **place name**, so you can
  sanity-check the result instead of squinting at decimals
- the **error radius** the browser reports is shown
- when it is worse than 500 m, it says plainly that this is a network estimate
  and not GPS
- **tapping the map** drops a pin anywhere and sets it as your start or
  destination, which is the fix for a wrong automatic location, an unnamed
  place, or a specific motorway junction

A wrong location you can see is wrong is recoverable. A wrong location
presented as fact is not.

### Services used

All free, all keyless: **Photon**/**Nominatim** (place search), **OSRM**
(routing), **Open-Meteo** (elevation and weather), **OpenStreetMap** (map
tiles). Leaflet is vendored in `vendor/` rather than loaded from a CDN.

Each stage degrades independently — if the elevation service is down you still
get a real road distance, and if everything is down you still have manual entry.

**Privacy:** the trip planner sends your start and destination to those third
parties. Everything else in the app runs on your device. Use manual distance
entry if that matters to you.

## Getting it running

Any static file server works. There is no build step and no dependencies.

```bash
python -m http.server 8123 --directory ev-range-app
```

Then open <http://localhost:8123>.

A launch configuration is already registered, so from Claude Code you can also
just start the `ev-range-app` preview.

### Making live GPS work

Live speed tracking needs **three** things, and all three are about the
environment, not the code:

1. **A device with GPS hardware.** A phone has it; a laptop does not. On a
   laptop the browser falls back to Wi-Fi/IP positioning, which reports
   `coords.speed === null` and a position that never moves — so there is no
   speed to read, by any method.
2. **An HTTPS origin.** Browsers only expose geolocation on a secure context.
   `localhost` counts as secure (verified — `isSecureContext === true` on
   `http://localhost`), but a LAN address like `http://192.168.1.5:8123` does
   **not**, and geolocation silently dies there.
3. **The screen staying awake.** The app requests a wake lock automatically,
   but browsers suspend location updates when a phone locks. Keep it in the
   foreground, ideally in a phone mount.

The practical route: put this folder on any free static host with HTTPS —
Netlify Drop, GitHub Pages, Cloudflare Pages, Vercel — then open that URL on
your phone and allow location. "Add to Home Screen" makes it run full-screen
and offline.

### How speed is derived

There are two ways to get speed from the Geolocation API, and they fail
completely differently:

1. **`coords.speed`** — computed by the GNSS chip from the Doppler shift of the
   satellite signals. Accurate, and *independent* of how well the position
   itself is known, so it is used whenever present regardless of the accuracy
   figure.
2. **Differentiating position** — distance between two fixes over the time
   between them. Dangerous, because the error is the position error divided by
   the time between fixes. Two ±850 m fixes 0.7 s apart manufacture a phantom
   **4001 km/h**.

An earlier version guarded (2) with a hard rule: refuse any fix worse than
50 m. That stopped the phantom speeds — and created a worse bug. A laptop's
Wi-Fi positions are typically 100–300 m, so *every* fix was rejected, and
because a coarse fix is not an *error* it never triggered the fallback either.
The app sat on "waiting for a GPS lock" forever, on exactly the hardware most
people would first try it on.

Comparing movement against noise was the next attempt, and it was still not
enough. Wi-Fi positioning *hops* between access points: a position alternating
between two points 180 m apart looks exactly like driving at 108 km/h, and no
accuracy threshold catches it, because the jump is four times the reported
accuracy and so looks like a confident measurement. In testing this drove the
speed readout to 243 km/h while sitting still.

What actually separates travel from jitter is not distance — it is
**direction**. Driving accumulates displacement consistently, so the straight
line from start to finish is nearly as long as the path walked. Jitter goes back
and forth, so the path is long while the net displacement stays near zero:

```
straightness = net displacement / total path length
```

| | straightness |
|---|---|
| Driving down a road | 0.9 – 1.0 |
| A winding road | ~0.7 |
| Wi-Fi jitter between two points | < 0.3 |

Requiring **0.5** over a six-second window separates them cleanly, and it is a
physical property of travel rather than a threshold tuned to one device. On top
of that, implied speeds above 200 km/h are rejected outright rather than
clamped (clamping still feeds a fiction into the model), and acceleration is
limited to 12 km/h per second — about 0.34 g, more than any road car sustains.

Measured: laptop jitter now yields "0 usable fixes → Position jumping around →
manual speed", while genuine travel at 72 km/h through ±22 m of noise stays on
GPS and tracks correctly. The cost is lag — deriving speed from position needs a
six-second baseline, so it trails real changes. A phone with a GPS chip skips
all of this and uses `coords.speed` directly.

### The headline had to be smoothed

"Battery empty in" was computed from the *instantaneous* draw. Standing still a
car draws ~0.5 kW, so it read 80 hours; the instant speed registered 20 km/h it
drew 1.7 kW and read 27 hours. Both are arithmetically correct, but the headline
leapt by fifty hours and the predicted empty-time clock appeared to **run
backwards**. On a device whose speed flickers between zero and a noise spike,
that happened continuously.

The headline now uses a draw smoothed over about thirty seconds — steady enough
to read at a glance, still responsive to a real change like switching the AC on.
The kW tile keeps the true instantaneous value, because that one is meant to be
live.

Three further guards:

- **A 12-second watchdog.** If nothing usable has arrived by then, the app
  stops waiting, switches to manual speed seeded with your planned figure, opens
  the sheet so the control is in front of you, and says why.
- **Stale-fix detection.** No usable fix for 12 seconds — a tunnel, a car park,
  a locked screen — holds the last known speed rather than collapsing to zero,
  and says so. A held value is not a measurement.
- **Secure-context check.** On plain `http://` at a LAN address the browser will
  never deliver a position, so the app says that instead of spinning.

### A trip starts paused

The app used to assume that pressing Start meant you were driving, and began
draining the battery at your planned speed immediately. On a laptop — which
cannot measure movement at all — that produced a battery countdown racing away
while the user sat at a desk, with no way to tell the app it was wrong. It was
inventing consumption that never happened.

So a trip now begins **paused**. Nothing accumulates: no energy, no distance, no
elapsed time. The figures still update, but as a **projection**:

> **At 110 km/h the battery would last** — 2 h 46 m

which is genuinely useful before you set off, because you can see what turning
the AC up or easing off 10 km/h would cost. Press **Start driving** and the
label switches to "Battery empty in" and the counting begins.

Two details that matter:

- **Measured movement resumes it automatically.** If the device can actually
  detect motion, pulling away starts the trip on its own — so a phone user never
  has to think about this. Verified: parked reads "Nothing is being counted
  yet", and on setting off it flips to "Started automatically — movement
  detected".
- **No transient on starting.** A manual speed is a stated intention, not a
  noisy measurement, so it is used directly rather than smoothed up from zero,
  and the headline draw tracks it exactly while paused. Pressing Start driving
  changes the headline by zero minutes — measured.

The pause control stays available for the whole trip, for charging stops,
traffic, or leaving the car parked.

### Diagnostics and simulated drive

The trip sheet has a **Location diagnostics** panel showing exactly what the
browser reports: secure context, permission state, fixes received vs. usable,
last accuracy, whether the chip supplies a speed field, time since the last fix,
and which source is in use. This turns "tracking doesn't work" into a specific,
answerable question.

**Simulate this drive** walks a synthetic position along the planned route at a
chosen multiplier, so turn-by-turn, voice guidance and the battery countdown can
all be exercised without a car. Time, distance and energy are compressed by the
*same* factor, so the physics stays coherent — you watch the battery genuinely
drain. A red SIMULATED badge sits over the map throughout, because a range
prediction the driver believes is live but is not would be dangerous.

---

## How the model works

The whole thing is in [`js/physics.js`](js/physics.js), which is written to be
read. The central idea:

> **Driving costs energy per kilometre. Climate control costs energy per hour.**

Mixing those up is the most common mistake in range estimation. To combine them,
the per-hour load is divided by speed:

```
Wh/km  =  (F_roll + F_aero + F_grade) × 1000 / 3600 / η   +   P_aux / v
          └──────────────────────────────────────────┘       └────────┘
                   driving — per kilometre                  climate etc.
                                                         per hour, converted
                                                          to per kilometre
```

That single division is where all the interesting behaviour comes from:

| Condition | AC on High costs | Because |
|---|---|---|
| 110 km/h motorway | **~10 Wh/km** | you cover ground fast, so the per-hour draw is spread thin |
| 30 km/h city traffic | **~38 Wh/km** | same kilowatts, four times as long to travel the same km |

Aerodynamic drag does the exact opposite — force grows with v², so going from
100 to 130 km/h raises the aero share of consumption by roughly (130/100)² ≈ 1.7×.

### What's modelled

| Effect | Where | Note |
|---|---|---|
| Aerodynamic drag | `consumption()` | ½ρ·Cd·A·v². Uses **air** speed, so headwind adds directly |
| Rolling resistance | `rollingCoeff()` | roughly constant with speed; rises ~11% at −10 °C |
| Gradient + regen | `consumption()` | uphill costs full energy, downhill returns 65% |
| Air density | `airDensity()` | ideal gas law — air at −10 °C is ~12% denser, so drag is ~12% higher |
| Cabin heating / cooling | `climatePowerW()` | thermal load ÷ COP. Heat pumps ≈ 3.2 COP mild, 1.2 in deep cold; resistive heaters are stuck at 1.0 |
| Cold capacity loss | `coldCapacityFactor()` | packs deliver less usable energy when cold, down to 87.5% at −10 °C |
| Battery health | `availableEnergyWh()` | user-supplied state of health |
| Mass | `consumption()` | passengers at 75 kg each plus cargo, affecting rolling resistance and climbing |

Winter range loss stacks from **four** independent effects at once — denser air,
stiffer tyres, a pack that holds less, and a cabin that needs heating. That is
why it is so much worse than people expect, and why the app models them
separately rather than applying one fudge factor.

### The real-world factor

The force equation describes a car holding a perfectly constant speed on smooth,
flat, dry tarmac. Real driving includes speed variation, acceleration losses,
imperfect surfaces, brake drag and crosswind. Checked against published
constant-speed test data, the gap is consistently around 10%, so `REALWORLD_FACTOR
= 1.10` is applied to the driving terms.

This deliberately biases the model slightly **pessimistic**. For a range app,
being 10% optimistic strands people; being 10% pessimistic just means you arrive
with more charge than you expected.

---

## Live self-calibration

This is what makes the app beat the dashboard over time, and it needs no OBD
dongle or manufacturer API.

During a trip the app integrates its own predicted energy use. Tap **Calibrate**,
type the percentage your car's own display is showing, and it compares:

```
correction = actual energy used / predicted energy used
```

blends that with the existing factor, and clamps it to a sane band so one
mistyped number cannot produce a wild estimate. Every subsequent prediction uses
the corrected figure.

That single number silently absorbs everything the model cannot see: your
driving style, tyre pressure, a roof box, road surface, and pack degradation
beyond what you entered.

---

## Files

```
index.html            three screens: setup, route planner, navigation
styles.css            dark, high-contrast, 40px+ touch targets for in-car use

js/geometry.js        great-circle maths — one haversine, one signature
js/physics.js         the energy model — heavily commented, no UI or network
js/cars.js            201 EVs across 76 brands, including vans and pickups
js/geo.js             place search, geocoding, elevation profile, weather
js/navigation.js      routing, turn-by-turn, snap-to-route, voice, basemaps

js/dom.js             $, el, icons, and the small formatters
js/state.js           state / nav / trip, plus the hooks seam
js/picker.js          the searchable dropdown and the bottom-sheet handle
js/conditions.js      form -> the object physics.predict() wants
js/maps.js            every line of Leaflet, and nothing else
js/persistence.js     save and restore, including route geometry

js/setup-screen.js    the prediction and the advice under it
js/planner.js         the map screen: search, routes, terrain, weather
js/tracking.js        GPS, the straightness test, diagnostics, wake lock
js/trip.js            the 1 Hz loop, the live screen, navigation guidance
js/app.js             startup and event wiring — no app logic

vendor/leaflet.*      map library, vendored rather than loaded from a CDN
sw.js                 service worker (offline support)
manifest.json         PWA metadata
tools/                Playwright screenshot harness — not part of the app
```

### How the modules fit together

Dependencies point strictly downward, so any file can be read without chasing
a cycle:

```
geometry ── physics ── cars          pure: no DOM, no network
    │         │
   geo    navigation                 network: geocoder, router, tiles
    └────┬────┘
         │
   dom · state                       browser + shared state
         │
picker · conditions · maps · persistence
         │
   setup-screen ── planner           the two planning screens
         │
   tracking ── trip                  the drive itself
         │
       app.js
```

The one place an arrow would point back up — `tracking.js` needing the tick
loop that lives in `trip.js` — goes through the `hooks` object in `state.js`
instead. `trip.js` fills those in; `tracking.js` only ever calls them.

`geometry.js`, `physics.js` and `navigation.js` have no DOM dependencies, so
they can be imported into a test file or a Node script and checked
independently.

### Screenshots

The app itself has no build step. `tools/` is separate from it and exists only
to drive the app through a real browser, because layout problems are invisible
from the DOM — a floating button buried under the bottom sheet still reports
sensible coordinates.

```bash
cd tools && npm install && npx playwright install chromium
```

Then, with the preview server running on port 8123:

```bash
cd tools && npm run shots
```

That writes `tools/shots/*.png` plus `report.json`, over three passes:

- **mobile** (390×844, location granted at Cairo) — setup → prediction → map →
  search → live screen.
- **desktop** (1280×800, location *denied*) — the same walk, exercising the
  no-GPS fallback path.
- **route** — plans a real Cairo→Alexandria trip, navigates it, and runs a
  simulated drive.

Between them they check the sheet handle stays put, that no floating control
ends up buried under the sheet or the turn banner, that search from Cairo
returns Egyptian results, that a simulated speed is not smoothed, and — the one
that caught a real bug — that `driven + remaining` still equals the route
length at every moment, since those two figures come from entirely different
mechanisms. Any console error fails the run.

---

## Verified behaviour

Checked in-browser against hand calculations and published figures:

- Tesla Model 3 RWD at 110 km/h, 20 °C → **151 Wh/km** (published constant-speed
  tests: ~150–155)
- Same car at 130 km/h, −10 °C, heater on high → **233 Wh/km**, 172 km of range
- Driving at 100 km/h into a 30 km/h headwind produces **exactly** the same
  aerodynamic load as 130 km/h in still air
- Uphill 1000 m over 200 km costs +33 Wh/km; the same descent returns
  −19 Wh/km, matching the 65% regen efficiency
- Battery at 85% health → usable capacity drops 60 → 51 kWh; at −10 °C, 60 →
  52.5 kWh
- Munich → Innsbruck resolves to 143 km of road, 1505 m of climb and 1456 m of
  descent, against a net change of just +49 m

---

## Known limits

- **Elevation is sampled about every kilometre**, which smooths away small
  undulations. That costs little accuracy, because small rises are nearly
  energy-neutral — you regen back most of what you spend. Total climb will read
  slightly low on genuinely lumpy terrain.
- **Weather is a single snapshot** at the route midpoint, taken when you plan
  the trip. A six-hour drive will outrun it. The app does not yet walk the
  forecast forward along the route.
- **Terrain ahead is scaled proportionally** during a live trip rather than
  matched to your actual position on the route, so a detour degrades it.
- **Speed is assumed steady** between GPS fixes. Stop-start traffic is partly
  absorbed by the real-world factor and fully absorbed by calibration.
- **No charging stops.** The app tells you whether you make it, not where to
  charge.
- **Catalog specs are published figures**, measured under favourable
  conditions, and frontal area is often estimated rather than published.
  Calibration is the fix.

## Editing the code

The service worker is **not registered on localhost**, deliberately. It is
cache-first, which is right for the product but poison for development: every
edit appears to do nothing until you bump the cache name. Deployed over HTTPS it
registers normally and the app is fully installable and offline-capable.

When you change a shell file, still bump `CACHE` in [`sw.js`](sw.js) (e.g.
`wattsleft-v3` → `v4`) so deployed installs pick the change up.

---

**This is an estimate from a physical model, not a guarantee.** Keep a charging
buffer.
