// ============================================================
// GET /api/v1/media/{mediaId} — download a WhatsApp media
// attachment's binary (scope: messages:read).
//
// Mirrors the dashboard's session-gated `/api/whatsapp/media/[mediaId]`
// route, but authenticates via API key instead of a browser session —
// so external automations (n8n, etc.) can fetch attachments (voice
// notes, images, documents) that `message_text` / `media_url` alone
// don't expose.
//
// Trust model: unchanged from the dashboard route. `mediaId` is a
// Meta-assigned opaque id; Meta's Graph API only serves it back to the
// access token of the WABA it belongs to, so a caller can't pull
// another account's media by guessing ids even without an extra
// DB-side ownership check.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { mediaId } = await params;
    if (!mediaId) return fail('bad_request', 'Media ID is required', 400);

    const { data: config, error: configError } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', ctx.accountId)
      .single();
    if (configError || !config) {
      return fail('bad_request', 'WhatsApp not configured', 400);
    }

    const accessToken = decrypt(config.access_token);
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (err) {
    console.error('[api/v1/media] fetch failed:', err);
    return toApiErrorResponse(err);
  }
}
