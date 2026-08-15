import type { ReactElement } from "react";

// ============================================================
// The brand mark, as JSX for `next/og` ImageResponse.
//
// Shared by every generated icon (favicon, apple-touch icon, PWA
// manifest icons) so the CRM looks like one product wherever the OS
// shows it. Matches the sidebar logo in components/layout/sidebar.tsx.
//
// Each platform masks icons differently, so callers pick the two knobs
// rather than getting a one-size preset:
//
//   favicon      radius ~20%, glyph ~62%  — nothing masks a browser
//                tab, so the icon has to be its own shape.
//   apple-touch  radius 0,    glyph ~55%  — iOS rounds the corners
//                itself; shipping pre-rounded corners leaves dark
//                wedges behind its mask.
//   manifest     radius 0,    glyph ~45%  — Android crops maskable
//                icons into the launcher's shape (circle, squircle,
//                teardrop), taking up to 20% off every edge, so the
//                plate must bleed and the glyph must stay well inside
//                the safe zone.
// ============================================================

/** Hostinger-aligned violet used by the sidebar logo and the favicon. */
export const BRAND_COLOR = "#7c3aed";

export function BrandMark({
  size,
  radius = 0,
  glyphScale = 0.55,
}: {
  /** Canvas edge in px (square). */
  size: number;
  /** Corner radius in px. 0 = full bleed, for OS-masked slots. */
  radius?: number;
  /** Glyph edge as a fraction of the canvas. */
  glyphScale?: number;
}): ReactElement {
  const glyph = Math.round(size * glyphScale);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: BRAND_COLOR,
        borderRadius: radius,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  );
}
