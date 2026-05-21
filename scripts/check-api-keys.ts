/**
 * Probe optional and required API keys. Reads `.env.local` when present,
 * then falls back to `keys/**` files in the repo.
 *
 * Usage: npm run check:keys
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Status = "ok" | "missing" | "fail" | "skip";

type Row = {
  name: string;
  envVar: string;
  status: Status;
  detail: string;
};

const ROOT = resolve(import.meta.dirname, "..");

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readKeyFile(rel: string): string | null {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) return null;
  const t = readFileSync(p, "utf8").trim();
  return t.length > 0 ? t : null;
}

function pick(env: Record<string, string>, key: string, filePath?: string): string | null {
  if (env[key]?.trim()) return env[key]!.trim();
  if (filePath) return readKeyFile(filePath);
  return null;
}

async function probeNps(key: string): Promise<{ ok: boolean; detail: string }> {
  const url = new URL("https://developer.nps.gov/api/v1/parks");
  url.searchParams.set("limit", "1");
  url.searchParams.set("api_key", key);
  const res = await fetch(url, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 200) {
    const j = (await res.json()) as { total?: number };
    return { ok: true, detail: `HTTP 200 · total≈${j.total ?? "?"}` };
  }
  if (res.status === 403 || res.status === 401) {
    return { ok: false, detail: `HTTP ${res.status} — invalid or inactive key` };
  }
  return { ok: false, detail: `HTTP ${res.status}` };
}

async function probeRidb(key: string): Promise<{ ok: boolean; detail: string }> {
  const url = new URL("https://ridb.recreation.gov/api/v1/facilities");
  url.searchParams.set("limit", "1");
  url.searchParams.set("apikey", key);
  const res = await fetch(url, {
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 200) {
    const j = (await res.json()) as { RECDATA?: unknown[] };
    const n = Array.isArray(j.RECDATA) ? j.RECDATA.length : 0;
    return { ok: true, detail: `HTTP 200 · sample rows=${n}` };
  }
  if (res.status === 403 || res.status === 401) {
    return { ok: false, detail: `HTTP ${res.status} — invalid key` };
  }
  return { ok: false, detail: `HTTP ${res.status}` };
}

async function probeSocrata(
  token: string,
  secret: string | null,
): Promise<{ ok: boolean; detail: string }> {
  const url = new URL(
    "https://data.cityofnewyork.us/resource/fhrw-4uyv.json",
  );
  url.searchParams.set("$limit", "1");
  url.searchParams.set("$$app_token", token);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "LocationScout/check-api-keys",
  };
  if (secret) {
    const basic = Buffer.from(`${token}:${secret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  } else {
    headers["X-App-Token"] = token;
  }
  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 200) {
    const rows = (await res.json()) as unknown[];
    return { ok: true, detail: `HTTP 200 · NYC public art rows=${rows.length}` };
  }
  if (res.status === 403) {
    return {
      ok: false,
      detail: "HTTP 403 — token missing, wrong, or needs App Token Secret",
    };
  }
  return { ok: false, detail: `HTTP ${res.status}` };
}

async function probeMapillary(token: string): Promise<{ ok: boolean; detail: string }> {
  const url = new URL("https://graph.mapillary.com/images");
  url.searchParams.set("access_token", token);
  url.searchParams.set("fields", "id");
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (res.status === 200) {
    const j = (await res.json()) as { data?: unknown[] };
    return { ok: true, detail: `HTTP 200 · images=${j.data?.length ?? 0}` };
  }
  if (res.status === 401) {
    return { ok: false, detail: "HTTP 401 — invalid Mapillary token" };
  }
  return { ok: false, detail: `HTTP ${res.status}` };
}

async function main(): Promise<void> {
  const env = {
    ...loadEnvFile(resolve(ROOT, ".env")),
    ...loadEnvFile(resolve(ROOT, ".env.local")),
  };

  const rows: Row[] = [];

  const nps = pick(env, "NPS_API_KEY", "keys/nps.gov/nps_key.txt");
  if (!nps) {
    rows.push({
      name: "NPS",
      envVar: "NPS_API_KEY",
      status: "missing",
      detail: "No key in env or keys/nps.gov/nps_key.txt — provider skips",
    });
  } else {
    const r = await probeNps(nps);
    rows.push({
      name: "NPS",
      envVar: "NPS_API_KEY",
      status: r.ok ? "ok" : "fail",
      detail: r.detail,
    });
  }

  const ridb = pick(env, "RIDB_API_KEY", "keys/ridb/ridb_key.txt");
  if (!ridb) {
    rows.push({
      name: "RIDB",
      envVar: "RIDB_API_KEY",
      status: "missing",
      detail: "No key — provider skips",
    });
  } else {
    const r = await probeRidb(ridb);
    rows.push({
      name: "RIDB",
      envVar: "RIDB_API_KEY",
      status: r.ok ? "ok" : "fail",
      detail: r.detail,
    });
  }

  const socrata = pick(env, "SOCRATA_APP_TOKEN", "keys/socrata/key_id.txt");
  const socrataSecret = pick(env, "SOCRATA_APP_TOKEN_SECRET", "keys/socrata/key_secret.txt");
  if (!socrata) {
    rows.push({
      name: "Socrata (NYC)",
      envVar: "SOCRATA_APP_TOKEN",
      status: "missing",
      detail: "No App Token — municipal datasets return 403",
    });
  } else {
    const r = await probeSocrata(socrata, socrataSecret);
    rows.push({
      name: "Socrata (NYC)",
      envVar: "SOCRATA_APP_TOKEN",
      status: r.ok ? "ok" : "fail",
      detail: r.detail + (socrataSecret ? " · using secret" : " · token only"),
    });
  }

  const mly = pick(env, "MAPILLARY_TOKEN", "keys/Mapillary/Access_MAPILLARY_TOKEN.txt");
  if (!mly) {
    rows.push({
      name: "Mapillary",
      envVar: "MAPILLARY_TOKEN",
      status: "missing",
      detail: "Required for photo enrichment",
    });
  } else {
    const r = await probeMapillary(mly);
    rows.push({
      name: "Mapillary",
      envVar: "MAPILLARY_TOKEN",
      status: r.ok ? "ok" : "fail",
      detail: r.detail,
    });
  }

  const required = ["ANTHROPIC_API_KEY", "GOOGLE_MAPS_API_KEY", "DATABASE_URL"] as const;
  for (const k of required) {
    rows.push({
      name: k,
      envVar: k,
      status: env[k]?.trim() ? "ok" : "missing",
      detail: env[k]?.trim() ? "set in .env" : "not set (app won't start)",
    });
  }

  console.log("\nAPI key health check\n");
  for (const row of rows) {
    const icon =
      row.status === "ok"
        ? "✓"
        : row.status === "missing"
          ? "○"
          : row.status === "fail"
            ? "✗"
            : "·";
    console.log(`  ${icon} ${row.name.padEnd(18)} ${row.detail}`);
  }
  console.log("");

  const failed = rows.some((r) => r.status === "fail" || r.status === "missing");
  if (failed && rows.some((r) => r.status === "fail")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
