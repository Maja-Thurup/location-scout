"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <main className="flex min-h-screen items-center justify-center px-6 py-12">
          <div className="max-w-md text-center">
            <p className="font-mono text-xs tracking-wide text-red-400 uppercase">
              Something went wrong
            </p>
            <h1 className="mt-2 text-2xl font-semibold">Unexpected error</h1>
            <p className="mt-3 text-sm text-zinc-400">
              The error has been reported. Please try refreshing the page.
            </p>
          </div>
        </main>
      </body>
    </html>
  );
}
