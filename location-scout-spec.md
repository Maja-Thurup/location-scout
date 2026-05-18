# LocationScout — AI Location Scouting App
## Project Specification for Cursor

---

## 1. Project Overview

LocationScout is a web app that helps video production crews (films, music videos, commercials, web series, YouTube content) find real-world filming locations in the US based on natural language scene descriptions or full script uploads.

**Core flow:** User describes a scene → Claude AI extracts location requirements → Google Maps API finds matching real places → User sees results with photos, coordinates, and (premium) permit/pricing info.

**Business model:** Freemium. Free tier = basic location discovery. Premium tier = permit costs, contact info, pricing data, project saving, and export.

---

## 2. Target Users

- Independent filmmakers
- Music video directors
- Commercial production companies
- Web series creators
- YouTube content creators
- Production assistants and location scouts
- Film school students

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| UI Components | shadcn/ui |
| State (server) | TanStack Query |
| State (client) | Zustand (only if needed) |
| Forms | React Hook Form + Zod |
| Auth | Clerk (easier than NextAuth for MVP) |
| Database | PostgreSQL via Supabase (free tier to start) |
| ORM | Prisma |
| AI | Anthropic Claude API (claude-sonnet-4 for analysis) |
| Maps | Google Maps Platform (Places API, Geocoding API, Maps JavaScript API) |
| Payments | Stripe (subscriptions) |
| Hosting | Vercel |
| File parsing | pdf-parse, mammoth (for .docx scripts) |

---

## 4. Architecture & Data Flow

```
[User UI]
    ↓ scene description / script upload
[Next.js API Route: /api/analyze-scene]
    ↓ sends to Claude API with structured prompt
[Claude returns JSON]
    ↓ location_types, mood, time_of_day, interior/exterior, etc.
[Next.js API Route: /api/search-locations]
    ↓ takes Claude output + user city
[Google Places API]
    ↓ returns matching real places
[Results displayed on map + list view]
    ↓ user clicks a result
[Premium gate]
    ↓ if subscribed → show permit info, pricing, contacts
    ↓ if not → show upsell
```

---

## 5. Core Features (MVP)

### Free Tier
- Sign up / log in
- Input scene description (text) OR upload script (PDF, .docx, .fountain, .txt)
- Specify city or region (US only at launch)
- AI extracts location requirements from scene
- Display top 10–15 matching real locations from Google Maps
- Map view + list view with photos, name, address, rating
- Save up to 3 projects

### Premium Tier ($19/month or $15/month annual)
- Unlimited project saves
- Permit cost estimates (from manually built database)
- Film commission contact info per city
- Nearby equipment rental and crew resources
- Export results as PDF or CSV
- Multi-location comparison
- Project sharing with team

---

## 6. Claude Prompt Design (the core IP)

The system prompt to Claude when analyzing a scene:

```
You are a location scouting assistant for video production.
Given a scene description or script excerpt, extract structured filming requirements.

Return ONLY valid JSON in this schema:
{
  "location_types": ["string"],     // e.g., "abandoned warehouse", "diner", "rooftop"
  "google_place_types": ["string"], // matching Google Places API types
  "mood": "string",                  // "gritty", "romantic", "noir", etc.
  "time_of_day": "string",           // "day", "night", "dusk", "dawn"
  "interior_exterior": "string",     // "interior", "exterior", "both"
  "size": "string",                  // "small", "medium", "large"
  "special_requirements": ["string"],// e.g., "high ceilings", "natural light", "soundproof"
  "estimated_crew_size": "string",   // "small (<10)", "medium (10–30)", "large (30+)"
  "search_keywords": ["string"]      // 3–5 keywords for Google search
}

Do not include explanations. Only the JSON.
```

---

## 7. Database Schema (Prisma)

```prisma
model User {
  id            String   @id @default(cuid())
  clerkId       String   @unique
  email         String   @unique
  subscription  Subscription?
  projects      Project[]
  createdAt     DateTime @default(now())
}

model Subscription {
  id            String   @id @default(cuid())
  userId        String   @unique
  user          User     @relation(fields: [userId], references: [id])
  stripeId      String   @unique
  tier          String   // "free" | "premium"
  status        String   // "active" | "canceled" | "past_due"
  currentPeriodEnd DateTime
}

model Project {
  id            String   @id @default(cuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  title         String
  sceneText     String   @db.Text
  city          String
  analysis      Json     // Claude's structured output
  locations     SavedLocation[]
  createdAt     DateTime @default(now())
}

model SavedLocation {
  id            String   @id @default(cuid())
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id])
  googlePlaceId String
  name          String
  address       String
  lat           Float
  lng           Float
  photoUrl      String?
  notes         String?  @db.Text
}

model PermitData {
  id            String   @id @default(cuid())
  city          String   @unique
  state         String
  baseFee       Float
  applicationFee Float
  filmCommissionUrl String?
  filmCommissionPhone String?
  filmCommissionEmail String?
  notes         String?  @db.Text
  updatedAt     DateTime @updatedAt
}
```

---

## 8. Project Structure

```
location-scout/
├── app/
│   ├── (auth)/
│   │   ├── sign-in/
│   │   └── sign-up/
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # dashboard home
│   │   ├── new/                  # new project wizard
│   │   ├── projects/[id]/        # project detail with map
│   │   └── settings/
│   ├── api/
│   │   ├── analyze-scene/route.ts
│   │   ├── search-locations/route.ts
│   │   ├── projects/route.ts
│   │   ├── stripe/webhook/route.ts
│   │   └── upload-script/route.ts
│   ├── layout.tsx
│   └── page.tsx                  # marketing landing page
├── components/
│   ├── ui/                       # shadcn components
│   ├── scene-input.tsx
│   ├── location-map.tsx
│   ├── location-card.tsx
│   ├── project-card.tsx
│   └── upgrade-modal.tsx
├── lib/
│   ├── claude.ts                 # Anthropic client + prompt
│   ├── google-maps.ts            # Places API helpers
│   ├── stripe.ts
│   ├── prisma.ts
│   └── permits.ts                # query permit DB
├── prisma/
│   └── schema.prisma
├── public/
├── .env.local
└── package.json
```

---

## 9. Environment Variables

```
# Anthropic
ANTHROPIC_API_KEY=

# Google Maps
GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=  # for client-side map display

# Clerk Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Database
DATABASE_URL=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_PRICE_ID_PREMIUM=
```

---

## 10. Build Milestones

### Milestone 1: Foundation (Week 1)
- Set up Next.js + TypeScript + Tailwind + shadcn/ui
- Configure Clerk auth (sign in/up flows)
- Set up Supabase + Prisma
- Build marketing landing page
- Build basic dashboard shell

### Milestone 2: Claude Scene Analysis (Week 2)
- Build scene input UI (textarea + city selector)
- Build /api/analyze-scene endpoint
- Wire up Claude API with the prompt from section 6
- Display structured analysis output on screen
- Test with 10+ different scene descriptions to refine the prompt

### Milestone 3: Google Maps Integration (Week 3)
- Get Google Maps API key, enable Places API + Maps JavaScript API
- Build /api/search-locations endpoint
- Map Claude's output → Google Places search parameters
- Display results on an interactive map + scrollable list
- Make location cards with photo, name, address, rating
- Click a marker → highlight in list and vice versa

### Milestone 4: Projects & Saving (Week 4)
- Build project model + CRUD endpoints
- Allow users to save a session as a named project
- Project detail page with saved locations
- Add notes per location

### Milestone 5: Script Upload (Week 5)
- Build file upload UI (PDF, .docx, .fountain, .txt)
- Parse uploaded scripts server-side
- Auto-detect scenes (look for INT./EXT. headers in screenplay format)
- Let user pick which scene to scout

### Milestone 6: Permit Database + Premium (Week 6)
- Manually populate PermitData for top 10 US filming cities (LA, NYC, Atlanta, Austin, Chicago, Miami, New Orleans, Albuquerque, Vancouver-area substitutes, Savannah)
- Build premium gate on permit info display
- Integrate Stripe subscription checkout
- Stripe webhook to sync subscription state to DB
- Upgrade modal UI

### Milestone 7: Polish & Launch (Week 7)
- PDF / CSV export
- Email notifications (Resend)
- Onboarding tour
- Marketing site copy + screenshots
- Soft launch on Product Hunt, r/Filmmakers, r/VideoEditing, Twitter

---

## 11. Key Implementation Notes

### Claude API call (TypeScript)
```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function analyzeScene(sceneText: string) {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT, // from section 6
    messages: [{ role: "user", content: sceneText }],
  });

  const textBlock = message.content.find(b => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response");

  // Strip any code fences and parse JSON
  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}
```

### Google Places search
- Use the new **Places API (New)** — Text Search endpoint — not the legacy version.
- Endpoint: `POST https://places.googleapis.com/v1/places:searchText`
- Pass `textQuery` (built from Claude's keywords + city) and `locationBias` (city coords).
- Request fields: `places.displayName,places.formattedAddress,places.location,places.photos,places.rating,places.id,places.types`.
- Photos: call `/v1/{photo_resource}/media` with `maxWidthPx=800` to get the actual image URL.

### Cost guardrails
- Cache Claude responses for identical scene descriptions (hash → DB).
- Cache Google Places results per (city + search_keywords) for 7 days.
- Rate-limit free users: 5 scene analyses per day.

---

## 12. Pricing Validation Targets

- Free tier converts to paid at 3–5%
- Target $19/month premium price
- Initial goal: 100 paying users in first 90 days = ~$1,900 MRR

---

## 13. What to NOT Build in MVP

Save these for v2 to stay focused:
- Storyboard generation (separate product later)
- Script breakdown beyond location extraction
- International cities
- Mobile native apps (web responsive is fine)
- Team collaboration features
- AI-generated location images
- Calendar/scheduling

---

## 14. First Cursor Task

When you open this project in Cursor, start with this prompt:

> "Read this entire spec. Then scaffold the Next.js 15 project per section 8, install all dependencies, set up Tailwind + shadcn/ui, configure Prisma with the schema in section 7, and create the marketing landing page. Use the existing color palette: slate-900 background, slate-50 text, emerald-500 accent. Stop and confirm before touching Milestone 2."

---
