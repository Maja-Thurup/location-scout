import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),

  ANTHROPIC_API_KEY: z.string().min(1, "Missing ANTHROPIC_API_KEY"),

  GOOGLE_MAPS_API_KEY: z.string().min(1, "Missing GOOGLE_MAPS_API_KEY"),

  MAPILLARY_TOKEN: z.string().min(1, "Missing MAPILLARY_TOKEN"),

  DATABASE_URL: z.string().min(1, "Missing DATABASE_URL"),
  DIRECT_URL: z.string().min(1, "Missing DIRECT_URL"),

  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "Missing SUPABASE_SERVICE_ROLE_KEY"),

  CLERK_SECRET_KEY: z.string().min(1, "Missing CLERK_SECRET_KEY"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),

  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),

  NEXT_PUBLIC_POSTHOG_KEY: z.string().min(1),
  NEXT_PUBLIC_POSTHOG_HOST: z.url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

function parseServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    const message =
      "\n\nInvalid environment variables:\n" +
      issues +
      "\n\nCopy `.env.example` to `.env.local` and fill in the missing values.\n";

    if (process.env.NODE_ENV === "production") {
      throw new Error(message);
    }
    console.error(message);
    return process.env as unknown as ServerEnv;
  }

  return parsed.data;
}

export const env: ServerEnv = parseServerEnv();
