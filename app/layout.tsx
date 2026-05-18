import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { PostHogProvider } from "@/components/posthog-provider";
import { QueryProvider } from "@/components/query-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LocationScout — AI-powered location scouting for video production",
    template: "%s · LocationScout",
  },
  description:
    "Describe a scene. Get real-world filming locations with photos, coordinates, Street View, and driving distance. Powered by Claude, OpenStreetMap, Mapillary, and Google Maps.",
  applicationName: "LocationScout",
  authors: [{ name: "Igor Kirko" }],
  creator: "Igor Kirko",
  publisher: "Igor Kirko",
  keywords: [
    "location scouting",
    "filmmaking",
    "video production",
    "Google Maps",
    "OpenStreetMap",
    "Mapillary",
    "Claude AI",
  ],
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "LocationScout — AI-powered location scouting",
    description:
      "Describe a scene. Get real filming locations with photos, Street View, and driving distance.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LocationScout — AI-powered location scouting",
    description:
      "Describe a scene. Get real filming locations with photos, Street View, and driving distance.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      afterSignOutUrl="/"
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "oklch(0.696 0.17 162.48)",
        },
      }}
    >
      <html lang="en" suppressHydrationWarning>
        <body className="min-h-screen antialiased">
          <PostHogProvider>
            <QueryProvider>{children}</QueryProvider>
          </PostHogProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
