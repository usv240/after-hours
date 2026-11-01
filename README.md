# After Hours

[![check](https://github.com/usv240/after-hours/actions/workflows/check.yml/badge.svg)](https://github.com/usv240/after-hours/actions/workflows/check.yml)

**Defibrillators keep office hours. Cardiac arrest doesn't.**

After Hours maps New York City's 4,032 public defibrillator (AED) locations by the hour, showing which ones sit behind an unlocked door. It replays 25,448 cardiac-arrest 911 calls from 2025 against those timetables, and ranks where a 24/7 street-wall cabinet would reach the most of them.

- **Live site:** https://dqcf6x4e7zbds.cloudfront.net
- **60-second guided story:** https://dqcf6x4e7zbds.cloudfront.net/map.html?story
- **Map:** https://dqcf6x4e7zbds.cloudfront.net/map.html (every view has a shareable link; ask it in your own words, e.g. "Sunday 11 PM near Penn Station")
- **School briefs, one printable page each:** https://dqcf6x4e7zbds.cloudfront.net/brief.html
- **Bring your own data:** https://dqcf6x4e7zbds.cloudfront.net/data.html
- **API and live console:** https://dqcf6x4e7zbds.cloudfront.net/api.html
- **MCP server for AI assistants:** `claude mcp add --transport http after-hours https://dqcf6x4e7zbds.cloudfront.net/api/mcp`

Built for the AWS Builder Center *Weekend Challenge: Map it* (October–November 2026).

## What it found

| | |
|---|---|
| NYC AED locations that are school buildings | 1,925 of 4,032 (48%); 69% outside Manhattan |
| 2025 cardiac-arrest calls while school buildings were shut | 16,285 of 25,448 (64%) |
| Confirmed-open AED locations, school-year Tuesday 2 PM → Sunday 3 AM | 2,636 → 52 |
| Coverage a time-blind map shows that was locked at the hour calls came | 69% |
| …even if every venue with unknown hours were open 24/7 | 39% |
| Paris (France makes owners declare hours): confirmed open, Tue 2 PM → Sun 3 AM | 838 → 219 |
| 2025 calls with an open AED within a two-minute walk, today → with 24/7 cabinets at the top 100 schools | about 363 → at least 448 (+23%) |

Try the last row on the map: **Make 24/7** → *Put a 24/7 cabinet outside the top 10 / 25 / 50 / 100* relights those schools at every hour ([top 100 at Sunday 3 AM](https://dqcf6x4e7zbds.cloudfront.net/map.html?t=6-3&fix=100#relocation)).

Every number is computed by the pipeline in this repo and written to `web/public/data/*/summary.json`; the web pages fill them in at build time and never hardcode one.

## Check every number

```sh
npm install
npm test             # 16 tests: the engine, and the API against the published data (offline)
npm run verify       # 25 claims in this README and the article, recomputed from the downloadable CSVs
npm run verify:live  # …plus 6 questions asked of the live API, as the article quotes them
npm run eval         # "Ask the map" on 72 fixed questions (calls Amazon Bedrock and Amazon Location)
```

`verify` recounts the open locations from `sites.csv` with the same engine the pipeline uses, re-adds the ranking from `relocation.csv`, and exits 1 if any stated number has drifted from the data. Writing it caught one: the coverage lost had been computed with a weighting that differed from the one the method describes, so the headline moved from 70% to 69%, and "even if every unknown venue were open" from 45% to 39%.

`eval` measures the question box on 48 questions used while building it and 24 written afterwards and run once: places it must find, emergencies it must flag, look-alikes it must not, places outside the city it must decline, and injected instructions that must put nothing on the map. Results, with every question and answer, are in [`evals.json`](web/public/data/nyc/evals.json) and on the [How it works](https://dqcf6x4e7zbds.cloudfront.net/method.html#ai) page.

## How it works

```
NYC Open Data ──► hours ──────────────► walking areas ──► coverage grid ──► presets (S3) ──► CloudFront site
 AED Inventory    school calendar        Amazon Location    50 m × 336 hours    + CSV downloads   API Gateway + Lambda
 FDNY dispatch    Amazon Location Places  Routes isolines    call-weighted                        MCP server
 ZIP polygons     Amazon Bedrock (graded)  (Pedestrian, 2 min)
Géo'DAE (France)
Overture Maps ◄── Amazon Athena (Registry of Open Data on AWS): fire/police/hospital hosts near top schools
GetStaticMap ───► one printable brief per ranked school (/brief.html)
EventBridge Scheduler ─► Lambda ─► S3 ─► Apache Iceberg table (Athena INSERT) ─► nightly "what changed" diff
```

| AWS service | What it does here |
|---|---|
| Amazon Location Service: Maps | Monochrome basemap, light or dark to match the page's theme (browser API key limited to the site's referrer and `GetTile`); `GetStaticMap` draws the print-ready street map on each of the 100 school briefs (routed walking area as a GeoJSON overlay), the sample previews and the API page's `/nearest` figure |
| Amazon Location Service: Places | Opening hours for 742 named AED venues (`SearchText` + `AdditionalFeatures: Contact`, name-matched within 200 m); geocoding for uploaded addresses |
| Amazon Location Service: Routes | `CalculateIsolines` two-minute pedestrian walking area for all 4,032 locations; `CalculateRouteMatrix` and `CalculateRoutes` for "collapse here" |
| Registry of Open Data on AWS + Amazon Athena | Overture Maps places (Parquet in `s3://overturemaps-us-west-2`) queried in place: 2,002 candidate buildings, filtered to 691 credibly staffed around the clock (fire and EMS stations, NYPD precincts, hospitals; clinics, doctors' offices and mislocated places dropped, see `pipeline/src/hosts.ts`) |
| Apache Iceberg on Amazon S3 + AWS Glue | Nightly snapshot of the AED registry; every version kept for diffs |
| Amazon Bedrock (Claude Haiku 4.5) | Hours estimates for unpublished venues, graded blind on 742 known venues (85% hour agreement, 8.3% false-open, so excluded from headline numbers); grounded two-sided debate |
| Amazon API Gateway | Public API `/api/v1/*` with self-serve keys on a usage plan (5 req/s, 1,000/day) |
| AWS Lambda | API, MCP server (Streamable HTTP), nightly refresh |
| Amazon EventBridge Scheduler | Starts the refresh at 06:15 New York time |
| Amazon DynamoDB | Daily caps on key creation and debates |
| Amazon CloudFront + Amazon S3 | Site, data downloads, `/api` routing |
| AWS CDK | `infra/` deploys all of it |

## Reuse the pattern

**For your own list of places with hours** (AEDs, naloxone boxes, cooling centres): upload a CSV or GeoJSON at `/data.html`, or

```sh
curl -X POST https://dqcf6x4e7zbds.cloudfront.net/api/v1/analyze \
  -H "x-api-key: YOUR_KEY" -H "content-type: application/json" \
  -d '{"timeZone":"America/Chicago","sites":[{"name":"Library","lat":41.876,"lon":-87.628,"hours":"Mo-Th 09:00-20:00"}]}'
```

Hours use [OpenStreetMap `opening_hours`](https://wiki.openstreetmap.org/wiki/Key:opening_hours) syntax. Unreadable hours are treated as unknown, never as open.

**To run the whole thing:**

```sh
npm install
npm test                         # engine + API tests
npm run fetch -w pipeline        # NYC Open Data
npm run paris -w pipeline        # Géo'DAE
npm run hours -w pipeline
npm run places -w pipeline       # Amazon Location Places (paid, cached)
npm run isolines -w pipeline     # Amazon Location Routes (paid, cached)
npm run infer -w pipeline        # Amazon Bedrock estimates + blind grade
npx tsx pipeline/src/overture.ts # Athena over Overture (needs the deployed workgroup)
npm run build -w pipeline        # presets, CSVs
npx tsx pipeline/src/build-samples.ts
(cd api && LOCAL_DATA_DIR=../web/public/data npx tsx src/precompute-debates.ts 10)  # saved debates
npm run council -w pipeline      # City Council districts + members, for each brief
npm run briefs -w pipeline       # school briefs + Amazon Location static maps
npm run sample-maps -w pipeline  # sample previews (static maps)
npm run api-figure -w pipeline -- https://YOUR-SITE  # one /nearest answer, drawn
python scripts/briefs-webp.py    # PNG → WebP
npm run deploy -w infra          # CDK
sh scripts/deploy-web.sh         # build with the map key, sync to S3, invalidate
```

## Limits

- FDNY publishes calls by ZIP code only, so each ZIP's calls are spread evenly over its streets.
- School hours are an assumption (7 AM–6 PM, school days); the map lets you try 3 PM and 9 PM.
- 1,278 venues have AI-estimated hours and 87 have none; both are excluded from headline numbers.
- An open building is not always an open AED. Real access is lower than shown.
- A planning tool, never an emergency service. In an emergency, call 911.

## Data and credits

NYC AED Inventory, FDNY EMS Incident Dispatch Data and MODZCTA from NYC Open Data; Géo'DAE (Licence Ouverte 2.0); Overture Maps (ODbL/CDLA, via the Registry of Open Data on AWS); Paris arrondissements (ODbL). Photographs from Wikimedia Commons, credited in `web/public/photos/credits.json`. Research cited on `/method.html`.

Code: Apache-2.0. The `opening_hours` library is LGPL-3.0.
