import type { MetadataRoute } from "next";
import { BRAND_COLOR } from "@/lib/brand-mark";

// Web app manifest — what turns the CRM into an installable app.
//
// `display: standalone` is the point of the file: launched from the
// home screen the CRM opens without the browser's address bar and
// back/forward chrome, which is what makes it feel native on a phone.
//
// `start_url: /inbox` rather than `/`: the home screen icon is a
// working tool, and the inbox is where an agent actually starts. `/`
// only ever redirects onward anyway.
//
// Icons are served by app/pwa-icon/[size] and declared `any maskable` —
// the artwork is drawn full-bleed with the glyph inside Android's safe
// zone, so one image works both unmasked and cropped into a launcher
// shape. iOS ignores these entirely and uses app/apple-icon.tsx.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "wacrm — WhatsApp CRM",
    short_name: "wacrm",
    description:
      "Inbox, contacts, appointments, and the AI assistant for your WhatsApp business.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches the app's dark chrome, so the splash screen doesn't flash
    // white before the first paint.
    background_color: "#020617",
    theme_color: BRAND_COLOR,
    icons: [
      {
        src: "/pwa-icon/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
