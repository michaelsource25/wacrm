import { ImageResponse } from "next/og";
import { BrandMark } from "@/lib/brand-mark";

// PNG icons referenced by the web manifest (/pwa-icon/192, /pwa-icon/512).
//
// A route handler rather than `app/icon.tsx`: Next fingerprints the
// file-convention icons into hashed URLs, which the manifest can't
// reference stably. These paths are fixed, so the manifest keeps
// working across deploys and Android doesn't re-prompt to install.
//
// Deliberately NOT under /api/* — that path is served `Cache-Control:
// no-store` by next.config, and an icon re-fetched on every launch is
// pure waste on mobile data.
//
// Rendered maskable (full bleed, glyph inside the safe zone) so one
// image serves both `any` and `maskable` purposes — see lib/brand-mark.

// Node runtime, not edge: every edge route using ImageResponse copies
// the same font asset into .next/standalone, and concurrent copies of
// one file collide during the build. Nothing here needs edge.

/** Only the sizes the manifest actually asks for: an open size param
 *  would let anyone spend our CPU rendering arbitrary bitmaps. */
const ALLOWED = new Set([192, 512]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size: raw } = await params;
  const size = Number(raw);
  if (!Number.isInteger(size) || !ALLOWED.has(size)) {
    return new Response("Not found", { status: 404 });
  }

  return new ImageResponse(<BrandMark size={size} glyphScale={0.45} />, {
    width: size,
    height: size,
  });
}
