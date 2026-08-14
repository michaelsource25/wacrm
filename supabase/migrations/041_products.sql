-- ============================================================
-- 041_products.sql — Product catalog
--
-- What the business sells, with a photo. Two audiences:
--
--   1. Humans: a Products page to keep the catalog current.
--   2. The AI bot: the second pluggable capability (after
--      appointments, 038). When an account has active products, the
--      assistant gains tools to look them up and SEND the photo over
--      WhatsApp — the knowledge base can only carry text, and can't
--      send anything at all.
--
-- Design notes
--   - Account-scoped, post-017 tenancy. RLS mirrors `services`
--     (038): read viewer+, write admin+ — a catalog is settings-class
--     data, not per-conversation operational data.
--   - `image_url` is a public URL in the `product-media` bucket (see
--     below). Meta fetches it directly at send time, so it MUST stay
--     publicly readable — the same contract as flow-media/chat-media.
--   - `price` is numeric(12,2) like services.price; the account's
--     `default_currency` (021) formats it. NULL = "ask us".
--   - No stock/categories/multi-image in v1 (deliberate: keeps the
--     page simple; all three are additive later).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  price       numeric(12,2),
  /** Public URL in the product-media bucket; NULL = no photo yet. */
  image_url   text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);

-- The catalog list and the bot's lookup both scan by account.
CREATE INDEX IF NOT EXISTS products_account_idx ON products (account_id);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS products_insert ON products;
CREATE POLICY products_insert ON products FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS products_update ON products;
CREATE POLICY products_update ON products FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS products_delete ON products;
CREATE POLICY products_delete ON products FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- product-media storage bucket
--
-- Separate bucket from chat-media (023) / flow-media (016) so
-- catalog photos have their own lifecycle: they're long-lived
-- reference images, not per-message attachments, and a future
-- retention or size policy should be able to diverge.
--
-- Images only — a product photo is what Meta sends as an `image`
-- message. 5 MB is generous for a photo and well under Meta's
-- image cap, keeping catalog uploads snappy on mobile data.
--
-- Path convention (same as the other buckets, post-020):
--   product-media/account-<account_id>/<timestamp>-<basename>.<ext>
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-media',
  'product-media',
  TRUE,
  5242880, -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Product media is publicly readable" ON storage.objects;
CREATE POLICY "Product media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-media');

DROP POLICY IF EXISTS "Members can upload product media" ON storage.objects;
CREATE POLICY "Members can upload product media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update product media" ON storage.objects;
CREATE POLICY "Members can update product media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete product media" ON storage.objects;
CREATE POLICY "Members can delete product media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'product-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
