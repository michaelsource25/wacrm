import { ImageResponse } from "next/og";
import { BrandMark } from "@/lib/brand-mark";

// Replaces the default Next.js favicon with the brand mark — violet
// rounded square + white chat glyph — matching the sidebar logo in
// `src/components/layout/sidebar.tsx`. Next.js renders this at build
// time and auto-injects <link rel="icon"> into <head>.
//
// The mark itself lives in lib/brand-mark so the favicon, the iOS
// home-screen icon, and the PWA manifest icons can't drift apart.
// Rounded here because nothing masks a browser tab: the icon has to
// carry its own shape.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <BrandMark size={size.width} radius={6} glyphScale={0.62} />,
    { ...size },
  );
}
