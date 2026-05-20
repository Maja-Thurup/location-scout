-- Curated places imported from external sources (NRHP, NHL, UNESCO,
-- NPS, RIDB, NYC Scenes, SF Films, ...). Free-tier-fast retrieval layer
-- that doesn't depend on third-party APIs at query time.
--
-- See prisma/schema.prisma for full field documentation.

CREATE TABLE "Place" (
  "id"               TEXT      NOT NULL,
  "source"           TEXT      NOT NULL,
  "name"             TEXT      NOT NULL,
  "description"      TEXT,
  "lat"              DOUBLE PRECISION NOT NULL,
  "lng"              DOUBLE PRECISION NOT NULL,
  "tags"             JSONB     NOT NULL,
  "imageUrl"         TEXT,
  "sourceUrl"        TEXT,
  "popularityScore"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  "importedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Place_pkey" PRIMARY KEY ("id")
);

-- Compound (lat, lng) index — Postgres optimizes
-- `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?` against this.
CREATE INDEX "Place_lat_lng_idx" ON "Place"("lat", "lng");

-- Used by per-source refresh / delete-by-source operations during cron imports.
CREATE INDEX "Place_source_idx" ON "Place"("source");
