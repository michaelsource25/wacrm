import { ImageResponse } from "next/og";
import { BrandMark } from "@/lib/brand-mark";

// Home-screen icon for iOS. Next renders this at build time and injects
// <link rel="apple-touch-icon">, which is what iOS uses for "Add to
// Home Screen" — Safari ignores the web manifest's icons for that, so
// this file is what makes the installed CRM look like an app rather
// than a screenshot of the page.
//
// 180x180 is what current iPhones ask for; iOS downscales for smaller
// slots. Full bleed and opaque on purpose: iOS applies its own rounded
// mask, so our own rounding (or transparency) would show as dark
// corners behind it.

// Node runtime, not edge: every edge route using ImageResponse copies
// the same font asset into .next/standalone, and concurrent copies of
// one file collide during the build. Nothing here needs edge.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <BrandMark size={size.width} glyphScale={0.55} />,
    { ...size },
  );
}
