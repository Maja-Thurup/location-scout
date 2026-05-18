"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";

import { clientEnv } from "@/lib/env-client";

if (typeof window !== "undefined" && !posthog.__loaded) {
  posthog.init(clientEnv.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: clientEnv.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_exceptions: true,
    person_profiles: "identified_only",
    persistence: "localStorage+cookie",
    autocapture: true,
    defaults: "2025-05-24",
  });
}

function ClerkIdentifier() {
  const { isSignedIn, user } = useUser();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isSignedIn && user) {
      posthog.identify(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
        name: user.fullName ?? undefined,
      });
    } else if (isSignedIn === false) {
      posthog.reset();
    }
  }, [isSignedIn, user]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <PHProvider client={posthog}>
      <ClerkIdentifier />
      {children}
    </PHProvider>
  );
}
