# Location Scouting App — Consolidated Research & Architecture

*Single source of truth for the location-scouting app. The build spec references this doc.*

---

## 1. The Big Picture

We're building a location-scouting app for video production. The user gives us a scene description (text, script excerpt, or sketch) and a city, and we return real-world filming locations with photos, coordinates, contact info, and permit/cost data.

The technical core sits on **four data sources working together**:

| Source | What it provides | Cost |
|---|---|---|
| **Google Places API (New)** | Real-world places, photos, business info | Pay-per-call, generous free tier |
| **OpenStreetMap + Overpass API** | Structural attributes (stories, color, material, era) | **Free** |
| **Mapillary API** | 2B+ crowdsourced street-level photos | **Free** (CC BY-SA) |
| **Claude API** | Scene parsing + vision scoring | Pay-per-call |

Plus a manually-curated **permit database** as the long-term moat.

The key insight: **Google Places can't search by visual attributes** like "three-story green building." OSM can pre-filter for those before we ever hit a paid API. That's the architectural unlock.

---

## 2. Full Architecture (The Pipeline)

```
┌──────────────────────────────────────────────────────┐
│  INPUT                                               │
│  • Scene text: "abandoned brick warehouse, large     │
│    windows, Brooklyn"                                │
│  • OR uploaded script (auto-detect scenes)           │
│  • OR sketch drawing (premium feature)               │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 1: Claude scene parsing                       │
│  Output structured JSON:                             │
│  {                                                   │
│    osm_tags: {                                       │
│      building: "warehouse",                          │
│      building:material: "brick",                     │
│      abandoned: "yes"                                │
│    },                                                │
│    google_query: "warehouse Brooklyn industrial",    │
│    google_types: ["storage", "warehouse"],           │
│    city: "Brooklyn, NY",                             │
│    bbox: [40.5707, -74.04, 40.74, -73.83],           │
│    visual: "exposed brick, large industrial windows" │
│  }                                                   │
│  Cost: ~$0.01 per call                               │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 2: Overpass pre-filter (FREE)                 │
│  Query OSM for ways/nodes matching structural tags   │
│  within the bbox. Returns 20–100 candidates with     │
│  coordinates and OSM tags.                           │
│  Cost: $0                                            │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 3: Google Places enrichment (PAID, precise)   │
│  • For each Overpass result: Place Details by        │
│    coordinate to get name, photos, business info     │
│  • Parallel: Google Places Text Search for places    │
│    without good OSM tagging (cafés, named landmarks) │
│  Cost: ~$0.035 + $0.017 per detail lookup            │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 4: Photo aggregation                          │
│  Priority order for each candidate:                  │
│    1. Mapillary photos at coordinate (FREE)          │
│    2. Google Place Photo (paid, ~$0.007 each)        │
│    3. Wikimedia Commons (FREE, for landmarks)        │
│  Cache photos 7 days in Supabase storage.            │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 5: Claude Vision re-ranking (PREMIUM only)    │
│  Send each candidate photo + scene description to    │
│  Claude. Returns 0–100 visual match score.           │
│  Cost: ~$0.005 per image                             │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  STAGE 6: Permit & cost lookup                       │
│  Match city → manually-curated permit DB             │
│  Returns: permit fee, film commission contacts,      │
│  application URLs, nearby equipment rentals.         │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  OUTPUT                                              │
│  Ranked list + map view. Free users see 5 results    │
│  with basic info. Premium sees 20 with permit data,  │
│  vision scoring, export options.                     │
└──────────────────────────────────────────────────────┘
```

**Realistic cost per premium search:** $0.20–$0.30
**Realistic cost per free search:** $0.05
**With Google for Startups credits applied: ~$0** for the first 12 months on Maps.

---

## 3. Data Sources Reference

### 3a. Google Places API (New)

The workhorse for named places, business info, ratings, and reliable photos.

**Key endpoints:**
- `POST /v1/places:searchText` — Text Search (e.g., "warehouses in Brooklyn")
- `POST /v1/places:searchNearby` — Find places near a coordinate
- `GET /v1/places/{place_id}` — Place Details (use this when you already have an ID from the OSM-driven workflow)
- `GET /v1/{photo_resource}/media` — Place Photo media URLs

**The field mask rule:** Every request must specify which fields you want. The request is billed at the **highest tier** any requested field belongs to.

### 3b. OpenStreetMap + Overpass API

The free pre-filter. Knows things Google doesn't expose about physical structures.

**Endpoint:** `POST https://overpass-api.de/api/interpreter`
**No auth, no API key.** Rate limit ~10K queries/day on the public instance. Self-host (~$30/mo VPS) for production scale.

**The highest-value tags for filming locations:**

| Tag | Example values | Use case |
|---|---|---|
| `building:levels` | 1, 2, 3, 4+ | "three-story building" |
| `building:colour` | green, red, white, brown | "green building" |
| `building:material` | brick, concrete, glass, wood, stone | "exposed brick warehouse" |
| `building:architecture` | art_deco, victorian, brutalist, modernist | Period films |
| `height` | "12.5" (meters) | Tall buildings |
| `roof:shape` | flat, gabled, dome, pyramidal | Rooftop scenes |
| `roof:material` | tile, slate, metal, thatch | Visual specificity |
| `start_date` / `year_of_construction` | "1923" | Period accuracy |
| `historic` | yes, monument, ruins | Heritage locations |
| `abandoned` / `ruins` | yes | Abandoned warehouses, decay aesthetics |
| `natural` | wood, peak, cliff, beach, cave, water | Outdoor scenes |
| `landuse` | industrial, farmland, brownfield, military, cemetery | Setting type |
| `surface` | cobblestone, gravel, dirt, asphalt | Road/path surfaces |
| `amenity` | theatre, library, fountain, parking | Specific facilities |

**Example query — three-story green building in Brooklyn:**

```overpassql
[out:json][timeout:25];
(
  way["building"]
     ["building:levels"="3"]
     ["building:colour"~"green",i]
     (40.5707,-74.0431,40.7395,-73.8334);
);
out center tags;
```

**Example query — forest near mountain peak:**

```overpassql
[out:json][timeout:25];
(
  way["natural"="wood"](around:5000, 40.7128, -74.0060);
  node["natural"="peak"](around:5000, 40.7128, -74.0060);
);
out center;
```

**Node libraries:**
- `query-overpass` (npm) — simple HTTP wrapper
- `osmtogeojson` (npm) — convert OSM responses to GeoJSON for mapping

**Caveat:** Tag completeness varies. NYC, LA, London, Berlin are excellent. Rural areas are patchy. Always fall back to Google Places + visual scoring.

### 3c. Mapillary API

Crowdsourced street-level photography, owned by Meta. **2 billion+ geotagged photos in 190 countries**, free for commercial use under CC BY-SA 4.0.

**Why it matters for us:** Captures the gritty everyday places Google Street View doesn't bother with — alleys, industrial zones, abandoned lots, rural roads. Exactly the stuff filmmakers scout.

**Endpoint:** `https://graph.mapillary.com/images`
**Auth:** Free client token from `mapillary.com/dashboard/developers`

**Useful query — fetch images near a coordinate:**

```
GET https://graph.mapillary.com/images
  ?access_token={token}
  &bbox={minLng},{minLat},{maxLng},{maxLat}
  &fields=id,thumb_2048_url,captured_at,compass_angle,geometry
  &limit=10
```

**Attribution requirement:** Display "© Mapillary contributors, CC BY-SA" near photos. Easy to satisfy.

### 3d. Other free sources

- **Wikimedia Commons API** — Free, attribution-only. Best for landmarks, monuments, historic buildings. Query via `https://commons.wikimedia.org/w/api.php`.
- **Flickr API** — Geotagged user photos with license filter. Free tier, requires API key.
- **Unsplash API** — Free, high-quality scenic photos. Good for inspiration/mood-board features but not real-location matches.
- **NYC OpenData** — `data.cityofnewyork.us` has a free dataset of all film permits issued in NYC. Goldmine for verifying which streets/buildings have hosted shoots before.
- **State film commission sites** — Most US states publish location libraries and permit guides. Scrape once, integrate into the permit DB.

### 3e. Existing competitors (also potential data sources)

- **Giggster, Peerspace, LocationsHub, LocoScout** — Marketplaces where locations are listed for rent. Could scrape (carefully) for inspiration, or partner long-term.

---

## 4. Pricing & Cost Strategy

### 4a. Google Maps pricing (March 2025 onward)

Old $200 universal credit is gone. Replaced by per-SKU free caps + optional subscription plans.

**Free per-SKU caps per month:**
- Essentials SKUs: 10,000 events
- Pro SKUs: 5,000 events
- Enterprise SKUs: 1,000 events

**Subscription plans** (if you exceed the free tier):

| Plan | Monthly | Combined calls |
|---|---|---|
| Pay-as-you-go | $0 | Free caps only |
| Starter | $100 | 50,000 |
| Essentials | $275 | 100,000 |
| Pro | $1,200 | 250,000 |

**Per-1,000-call SKU pricing (approximate, verify before launch):**

| SKU | Cost / 1K | Notes |
|---|---|---|
| Text Search Essentials (IDs Only) | $0 | Just IDs |
| Text Search Essentials | $5 | IDs + basic geo |
| Text Search Pro | $35 | Photos, ratings, hours |
| Place Details Essentials | $5 | Address, coords, types |
| Place Details Pro | $17 | Photos, hours, contact |
| Place Details Enterprise | $20 | Reviews, accessibility |
| Place Photos | $7 | Per photo fetched |
| Geocoding | $5 | Address ↔ coords |
| Dynamic Maps (JS) | $7 | Per map load |

### 4b. Google for Startups Cloud Program — THE BIG UNLOCK

If we qualify, this basically zeroes out costs for 12–24 months.

**Three tiers:**

| Tier | Eligibility | Cloud credits | Maps benefit |
|---|---|---|---|
| **Start** | Bootstrapped, unfunded, <5yr old company | Up to $2,000 | $3,250 total Maps credit |
| **Scale** | Pre-seed to Series A, institutional funding | Up to $200,000 | **$600/month** Maps credit for 12 months |
| **AI Track** | AI-first startup, Seed–Series A | Up to $350,000 | Same Maps benefit + extras |

**$600/month dedicated Maps credit on the Scale tier covers ~17,000 Pro Text Searches or ~85,000 Photos per month.** Likely zeros our Maps bill entirely through MVP and early traction.

**Application:** `cloud.google.com/startups`. Requires website, business email, brief product description. The Start tier needs no funding at all.

### 4c. Realistic cost per search

**Free user (Stages 1–4 only):**
- Claude parsing: $0.01
- Overpass: $0
- Google Place Details for ~10 candidates: $0.17
- Mapillary photos (primary): $0
- Fallback Place Photos for ~3 missing: $0.021
- Map render: $0.007
- **Total: ~$0.21** → after free caps + startup credits, effectively **$0**

**Premium user (all stages):**
- All of the above
- Claude Vision re-ranking on 15 photos: $0.075
- **Total: ~$0.29** → after credits, **~$0.08**

At $19/month premium with avg 50 searches/user: **$15 revenue, $4 cost, ~$11 net** before infrastructure overhead.

---

## 5. Visual Search Solutions

The fundamental problem: Google Places searches by name and type, not visual attributes. Three approaches to solve it.

### 5a. Approach A — Claude-as-translator (MVP, ship in days)

Use Claude to translate visual descriptions into:
1. OSM tag filters (for Overpass pre-filter)
2. Google Places search terms
3. A natural-language visual descriptor for later scoring

User does the final visual filter by scanning result photos. This is the **default MVP flow**.

### 5b. Approach B — Claude Vision scoring (premium feature, v1.1)

After Stage 4 (photo aggregation), send each candidate's primary photo to Claude Vision with the scene description. Ask for a 0–100 match score. Sort and return top 5–10.

**Prompt template:**
```
You are scoring filming locations.

Scene description: "{user_description}"

On a scale of 0–100, how well does the attached photo
match this scene? Consider building type, mood, lighting,
era, materials, and overall vibe.

Return ONLY JSON: { "score": <number>, "reason": "<one sentence>" }
```

**Cost:** ~$0.005 per image with Sonnet. Use as a premium gate.

### 5c. Approach C — Self-hosted CLIP (scale-only)

Only worth it if vision API spend crosses ~$1,000/month. At that point, rent a small GPU on Runpod/Vast.ai (~$0.30/hr for L4) and run CLIP via vLLM. Save ~70% on inference cost but adds DevOps overhead.

**Don't build this for MVP.** It's a v2 optimization.

### 5d. Sketch-based search (premium differentiator)

User uploads a hand-drawn sketch of a scene. Two paths:

**Path 1 (MVP-friendly):** Send sketch to Claude Vision with prompt:
```
Describe this sketch as a real-world filming location.
Be specific about building type, surroundings, mood,
architectural details, scale, and time of day.

Return JSON with the same schema as our scene parser.
```
Claude converts sketch → structured description → feeds into the normal pipeline.

**Path 2 (v2):** Use a sketch-specialized model like **Dr. CLIP** or **DP-CLIP** for direct sketch-to-photo embedding matching. Better fine-grained matching but requires hosting infrastructure.

**Recommendation:** Ship Path 1 immediately. It's 90% as effective for ~1% of the build cost. This feature alone is a strong marketing differentiator — none of Giggster, Peerspace, or LocoScout has anything like it.

---

## 6. Field Mask Cheat Sheets

Copy-paste-ready for the Google Places API integration.

**Discovery (cheapest, Essentials tier):**
```
places.id,places.displayName,places.formattedAddress,places.location,places.types
```

**Standard result card (Pro tier — default):**
```
places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.photos,places.rating,places.userRatingCount,places.businessStatus,places.editorialSummary,places.websiteUri,places.googleMapsUri
```

**Premium detail view (Pro + selective Enterprise):**
```
places.id,places.displayName,places.formattedAddress,places.location,places.types,places.photos,places.rating,places.reviews,places.regularOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.editorialSummary,places.accessibilityOptions,places.parkingOptions
```

**Avoid in production:** Wildcard `*` field mask. Always list fields explicitly.

---

## 7. Implementation Notes

### 7a. Overpass query patterns

**Always include `[out:json][timeout:25]` at the top.** Always end with `out center tags;` for ways (returns centroid coordinate + all tags).

**Bounding box** (rough city coords): `(south,west,north,east)`
**Radius from point:** `(around:RADIUS_METERS, lat, lng)`

**Tag matching operators:**
- `["key"="value"]` — exact match
- `["key"~"pattern",i]` — regex, case-insensitive
- `["key"]` — key exists, any value
- `[!"key"]` — key does not exist

**Common reusable filters:**

```overpassql
# Abandoned industrial
way["building"~"warehouse|industrial",i]["abandoned"="yes"](bbox);

# Pre-1950 buildings (period films)
way["building"]["start_date"~"^(18[0-9]{2}|19[0-4][0-9])"](bbox);

# Forests with water nearby
way["natural"="wood"](bbox);
way["natural"="water"](bbox);

# Cobblestone streets
way["highway"]["surface"="cobblestone"](bbox);
```

### 7b. Caching strategy

To stay inside Google's free tier and respect Overpass rate limits:

- **Hash scene description** → cache Claude parsing result for 30 days
- **Hash (city + osm_tags)** → cache Overpass result for 14 days (OSM data changes slowly)
- **Hash (place_id + photo_index)** → cache Google Photo URL + actual image bytes for 30 days in Supabase Storage
- **Hash (image_url + description)** → cache Claude Vision score for 7 days

Store all caches in a single Supabase `cache` table keyed by hash → JSON value → TTL. Cheap and fast.

### 7c. Rate limit handling

- **Google Maps:** No hard rate limits on Places API (just per-minute quotas). Set budget alerts at $10/$25/$50 in Google Cloud Console.
- **Overpass public:** Soft 10K queries/day, 180s timeout. Queue requests, cache aggressively. If we hit limits, fall back to mirror instances (`overpass.kumi.systems`, `overpass.openstreetmap.fr`) or self-host.
- **Mapillary:** 50K requests/day on free tier. Cache photo URLs (they're permanent).
- **Anthropic API:** Per-minute token limits. Batch vision calls in parallel up to 5 concurrent.

### 7d. Recommended dependencies (Node/Next.js)

```json
{
  "@anthropic-ai/sdk": "^0.x",
  "@googlemaps/google-maps-services-js": "^3.x",
  "query-overpass": "^1.x",
  "osmtogeojson": "^3.x",
  "@supabase/supabase-js": "^2.x",
  "node-cache": "^5.x"
}
```

---

## 8. Unique UI Features (Differentiators)

These are buildable because OSM data exists. Competitors can't do these.

**Structured filters panel:**
- Stories: any / 1 / 2 / 3 / 4+
- Material: brick / concrete / glass / wood / stone
- Era: pre-1900 / 1900–1950 / 1950–2000 / post-2000
- Style: victorian / art deco / brutalist / modern
- Condition: well-maintained / abandoned / ruins
- Surroundings: forest / mountain / beach / urban / industrial / waterfront
- Surface (for streets): asphalt / cobblestone / gravel / dirt

**Sketch input:** Canvas drawing pad → Claude Vision parses → standard pipeline.

**Scene-to-shotlist:** From the scene description, also generate a suggested shot list (wide, medium, close-up framings) keyed to the location's features. Bonus feature, easy to add.

**Permit pre-flight:** Show estimated permit cost and timeline before the user commits to a location. Pulls from the manual permit DB.

---

## 9. What to Build First (Revised Milestones)

### Milestone 1: Foundation (Week 1)
- Next.js 15 + TypeScript + Tailwind + shadcn/ui
- Clerk auth
- Supabase + Prisma with cache table
- Marketing landing page

### Milestone 2: Scene parsing + Overpass (Week 2)
- Scene input UI + city selector
- `/api/parse-scene` endpoint → Claude
- `/api/overpass-search` endpoint → Overpass QL builder + query
- Display OSM candidates on a map (no photos yet)

### Milestone 3: Google Places enrichment (Week 3)
- Place Details lookup at each OSM coordinate
- Parallel Text Search for unmatched cases
- Result cards with name, address, type, rating

### Milestone 4: Photo pipeline (Week 4)
- Mapillary fetch per coordinate (primary)
- Google Place Photo fallback
- Wikimedia Commons fallback for landmarks
- Photo caching in Supabase Storage

### Milestone 5: Premium features (Week 5)
- Claude Vision re-ranking (gated)
- Sketch input canvas → Claude Vision parsing
- Stripe subscription integration

### Milestone 6: Permit database (Week 6)
- Manually seed top 10 US filming cities (LA, NYC, Atlanta, Austin, Chicago, Miami, New Orleans, Albuquerque, Savannah, Detroit)
- Premium gate on permit info

### Milestone 7: Polish & launch (Week 7)
- PDF/CSV export
- Project saving with named workspaces
- Marketing site
- Launch on Product Hunt, r/Filmmakers, r/cinematography, ProductionHUB

---

## 10. Apply for These Day 1

- [ ] **Google for Startups Cloud Program** (Start tier if unfunded, Scale if funded) — `cloud.google.com/startups`
- [ ] **Mapillary developer token** — `mapillary.com/dashboard/developers`
- [ ] **Google Cloud free trial** ($300 / 90 days) — stack on top of Startups credits
- [ ] **Anthropic API account** with billing — for Claude + Claude Vision
- [ ] **Supabase project** (free tier)
- [ ] **Stripe account** (test mode for now)
- [ ] **Clerk account** (free tier covers MVP)
- [ ] **Vercel account** (free tier)

Total infrastructure cost to ship MVP: **$0–$20/month** with credits applied. Realistic.
