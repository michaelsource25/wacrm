-- ============================================================
-- 043_orders.sql — Orders taken over WhatsApp
--
-- Completes the selling half of the products module (041). The bot
-- could already look products up and send photos, but a customer
-- saying "quiero 2" left no trace: the owner had to read the thread
-- and total it by hand.
--
-- Lifecycle
--   pending    the open cart the bot is building mid-conversation
--   confirmed  the customer said yes (the bot sets this itself, same
--              call as appointments — no owner approval step)
--   delivered  handed over / shipped, set by a human in the CRM
--   cancelled  called off by either side
--
-- Design notes
--   - Operational data, so RLS mirrors `appointments` (038): read
--     viewer+, write agent+. The catalog itself stays admin-only
--     (041) because it is settings-class.
--   - Line items snapshot `product_name` and `unit_price` at the time
--     they are added, like `appointments.service_name`. A later price
--     change or a deleted product must never rewrite what a customer
--     already agreed to pay.
--   - `orders.total` is maintained by trigger rather than by whoever
--     happens to be writing. The bot, the Orders page, and the public
--     API can all touch items; one authority means the total can't
--     drift from the lines.
--   - `currency` is snapshotted from the account (021) so a later
--     currency switch doesn't silently reinterpret old orders.
--   - No stock and no delivery address in v1 — a deliberate scope
--     call; both are additive later without reshaping this.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  /** NULL when the contact was deleted — the order stays as history. */
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','delivered','cancelled')),
  /** Maintained by trigger from order_items; never write it directly. */
  total       numeric(12,2) NOT NULL DEFAULT 0,
  /** Snapshot of accounts.default_currency when the order was opened. */
  currency    text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The Orders page lists newest-first per account; the bot looks up a
-- contact's open cart.
CREATE INDEX IF NOT EXISTS orders_account_created_idx
  ON orders (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_contact_idx
  ON orders (contact_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  /** NULL if the catalog entry was later deleted; the name and price
   *  below preserve what was actually ordered. */
  product_id   uuid REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  unit_price   numeric(12,2) NOT NULL DEFAULT 0,
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- One product appears at most once per order; adding it again updates
-- the quantity instead of creating a second line. This is also what
-- the bot's add_to_order upsert infers its ON CONFLICT from.
--
-- Deliberately NOT a partial index (`WHERE product_id IS NOT NULL`):
-- Postgres can only infer a partial index for ON CONFLICT when the
-- statement repeats its predicate, which PostgREST's upsert does not
-- do — the insert would fail at runtime with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". A plain unique
-- index behaves identically here anyway, since NULLs never collide
-- with each other, so a line whose product was deleted stays valid.
CREATE UNIQUE INDEX IF NOT EXISTS order_items_order_product_idx
  ON order_items (order_id, product_id);

-- ============================================================
-- Keep orders.total in sync with its lines.
--
-- SECURITY DEFINER so it runs regardless of which role touched the
-- items, and a pinned search_path so the function can't be captured
-- by a caller-controlled schema.
-- ============================================================
CREATE OR REPLACE FUNCTION recalc_order_total()
RETURNS TRIGGER AS $$
DECLARE
  target uuid;
BEGIN
  -- Branch on TG_OP rather than COALESCE(NEW.order_id, OLD.order_id):
  -- on DELETE, PL/pgSQL leaves NEW unassigned, and reading a field off
  -- it raises "record new is not assigned yet" — which would make
  -- removing a line from an order fail outright.
  IF TG_OP = 'DELETE' THEN
    target := OLD.order_id;
  ELSE
    target := NEW.order_id;
  END IF;

  UPDATE orders
  SET total = COALESCE(
        (SELECT SUM(unit_price * quantity) FROM order_items WHERE order_id = target),
        0
      ),
      updated_at = now()
  WHERE id = target;

  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS order_items_recalc_total ON order_items;
CREATE TRIGGER order_items_recalc_total
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION recalc_order_total();

-- ============================================================
-- RLS — operational data, mirroring appointments (038).
-- ============================================================
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS orders_delete ON orders;
CREATE POLICY orders_delete ON orders FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- order_items inherit their tenancy from the parent order: a member
-- may touch a line exactly when they may see its order.
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_items_select ON order_items;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id AND is_account_member(o.account_id)
  ));

DROP POLICY IF EXISTS order_items_insert ON order_items;
CREATE POLICY order_items_insert ON order_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id AND is_account_member(o.account_id, 'agent')
  ));

DROP POLICY IF EXISTS order_items_update ON order_items;
CREATE POLICY order_items_update ON order_items FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id AND is_account_member(o.account_id, 'agent')
  ));

DROP POLICY IF EXISTS order_items_delete ON order_items;
CREATE POLICY order_items_delete ON order_items FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = order_items.order_id AND is_account_member(o.account_id, 'agent')
  ));
