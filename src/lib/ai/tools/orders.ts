import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutableTool } from '../types'

// ============================================================
// Order-taking tools for the AI auto-reply bot (migration 043).
//
// The selling half of the products capability: search_products /
// send_product_photo (tools/products.ts) let the bot show the catalog;
// these let a "quiero 2" actually become a record the owner can work
// from, with a total the bot cannot get wrong because every price is
// read from the catalog.
//
// Cart model — the contact's most recent `pending` order is the open
// cart. It is resumed only while it is fresh (CART_TTL_HOURS): a
// customer coming back next week starts a new order rather than
// silently adding to a basket they have forgotten.
//
// Safety model — executors run on the service-role client:
//   - every query is scoped to the account AND the conversation's
//     contact; the model chooses WHAT, never WHOSE
//   - prices and names come from `products`, never from the model
//   - only `is_active` products can be ordered
//   - quantities and line counts are bounded, so a confused or
//     prompt-injected model cannot write a 10,000-unit order
// ============================================================

/** How long an untouched cart stays resumable. */
const CART_TTL_HOURS = 24

/** Per-line quantity ceiling. */
const MAX_QUANTITY = 99

/** Distinct products per order. */
const MAX_LINES = 20

interface ProductRow {
  id: string
  name: string
  price: number | null
}

interface CartLine {
  product_id: string | null
  product_name: string
  unit_price: number
  quantity: number
}

export interface OrderToolsResult {
  tools: ExecutableTool[]
  prompt: string
}

interface BuildArgs {
  accountId: string
  contactId: string
  /** Account currency (021), snapshotted onto new orders. */
  currency: string
}

/**
 * Build the order tools, or null when the account has no active
 * products (nothing to sell → the capability stays invisible).
 */
export async function buildOrderTools(
  db: SupabaseClient,
  { accountId, contactId, currency }: BuildArgs,
): Promise<OrderToolsResult | null> {
  const { data } = await db
    .from('products')
    .select('id, name, price')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .limit(200)

  const catalog = (data ?? []) as ProductRow[]
  if (catalog.length === 0) return null

  const findProduct = (raw: unknown): ProductRow | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null
    const q = raw.trim().toLowerCase()
    return (
      catalog.find((p) => p.id === raw.trim()) ??
      catalog.find((p) => p.name.toLowerCase() === q) ??
      catalog.find((p) => p.name.toLowerCase().includes(q)) ??
      null
    )
  }

  const money = (n: number) => `${currency} ${n.toFixed(2)}`

  /** The open cart, if one is fresh enough to resume. */
  async function openCart(): Promise<{ id: string } | null> {
    const since = new Date(
      Date.now() - CART_TTL_HOURS * 60 * 60_000,
    ).toISOString()
    const { data: row } = await db
      .from('orders')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'pending')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return row ? { id: row.id as string } : null
  }

  async function lines(orderId: string): Promise<CartLine[]> {
    const { data: rows } = await db
      .from('order_items')
      .select('product_id, product_name, unit_price, quantity')
      .eq('order_id', orderId)
      .order('created_at')
    return (rows ?? []) as CartLine[]
  }

  /** Render a cart for the model: itemised, with the authoritative
   *  total recomputed from the lines it is about to read out. */
  function render(items: CartLine[]): string {
    if (items.length === 0) return 'The order is empty.'
    const total = items.reduce((s, l) => s + l.unit_price * l.quantity, 0)
    const body = items
      .map(
        (l) =>
          `- ${l.quantity}x ${l.product_name} — ${money(
            l.unit_price * l.quantity,
          )}`,
      )
      .join('\n')
    return `${body}\nTOTAL: ${money(total)}`
  }

  const tools: ExecutableTool[] = [
    {
      def: {
        name: 'add_to_order',
        description:
          "Add a product to this customer's current order (creating the order if there isn't one). Adding a product that is already on the order sets its quantity to the new value. Call this as soon as the customer says they want something.",
        parameters: {
          type: 'object',
          properties: {
            product: {
              type: 'string',
              description: 'Product name or id from search_products',
            },
            quantity: {
              type: 'integer',
              description: `How many, 1-${MAX_QUANTITY}. Defaults to 1.`,
            },
          },
          required: ['product'],
        },
      },
      async run(args) {
        const product = findProduct(args.product)
        if (!product) {
          return 'Error: no such product in the catalog. Call search_products first and use a name it returned.'
        }
        if (product.price == null) {
          return `Error: "${product.name}" has no price set, so it can't be added to an order. Tell the customer you'll confirm the price shortly.`
        }

        const rawQty = args.quantity
        const quantity =
          typeof rawQty === 'number' && Number.isFinite(rawQty)
            ? Math.floor(rawQty)
            : 1
        if (quantity < 1 || quantity > MAX_QUANTITY) {
          return `Error: quantity must be between 1 and ${MAX_QUANTITY}.`
        }

        let cart = await openCart()
        if (!cart) {
          const { data: created, error } = await db
            .from('orders')
            .insert({
              account_id: accountId,
              contact_id: contactId,
              status: 'pending',
              currency,
            })
            .select('id')
            .single()
          if (error || !created) {
            console.error('[ai tools] order create failed:', error)
            return 'Error: the order could not be started. Tell the customer a human will take it from here.'
          }
          cart = { id: created.id as string }
        }

        const existing = await lines(cart.id)
        const already = existing.some((l) => l.product_id === product.id)
        if (!already && existing.length >= MAX_LINES) {
          return `Error: this order already has ${MAX_LINES} different products. Ask the customer to confirm it before adding more.`
        }

        // Snapshot name + price: a later catalog edit must not rewrite
        // what the customer agreed to.
        const { error: upsertErr } = await db.from('order_items').upsert(
          {
            order_id: cart.id,
            product_id: product.id,
            product_name: product.name,
            unit_price: product.price,
            quantity,
          },
          { onConflict: 'order_id,product_id' },
        )
        if (upsertErr) {
          console.error('[ai tools] add_to_order failed:', upsertErr)
          return 'Error: the item could not be added.'
        }

        return `Added ${quantity}x ${product.name}. Current order:\n${render(
          await lines(cart.id),
        )}\nRead the order back to the customer and ask them to confirm.`
      },
    },
    {
      def: {
        name: 'remove_from_order',
        description:
          "Remove a product from this customer's current order, e.g. when they change their mind.",
        parameters: {
          type: 'object',
          properties: {
            product: { type: 'string', description: 'Product name or id' },
          },
          required: ['product'],
        },
      },
      async run(args) {
        const cart = await openCart()
        if (!cart) return 'There is no open order for this customer.'
        const product = findProduct(args.product)
        if (!product) return 'Error: no such product in the catalog.'

        const { error } = await db
          .from('order_items')
          .delete()
          .eq('order_id', cart.id)
          .eq('product_id', product.id)
        if (error) {
          console.error('[ai tools] remove_from_order failed:', error)
          return 'Error: the item could not be removed.'
        }
        return `Removed ${product.name}. Current order:\n${render(
          await lines(cart.id),
        )}`
      },
    },
    {
      def: {
        name: 'view_order',
        description:
          "Show this customer's current (not yet confirmed) order with its total. Use it when they ask what they've ordered or how much it comes to.",
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const cart = await openCart()
        if (!cart) return 'There is no open order for this customer.'
        return render(await lines(cart.id))
      },
    },
    {
      def: {
        name: 'confirm_order',
        description:
          "Confirm this customer's current order. Call ONLY after they have explicitly agreed to the items and total you read back to them.",
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const cart = await openCart()
        if (!cart) return 'There is no open order to confirm.'
        const items = await lines(cart.id)
        if (items.length === 0) {
          return 'Error: the order is empty — add what the customer wants before confirming.'
        }

        const { error } = await db
          .from('orders')
          .update({ status: 'confirmed' })
          .eq('id', cart.id)
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .eq('status', 'pending')
        if (error) {
          console.error('[ai tools] confirm_order failed:', error)
          return 'Error: the order could not be confirmed. Do not tell the customer it was.'
        }
        return `Order confirmed:\n${render(
          items,
        )}\nTell the customer it's confirmed and that you'll let them know when it's ready.`
      },
    },
    {
      def: {
        name: 'cancel_order',
        description:
          "Cancel this customer's current or most recently confirmed order. Call ONLY when they clearly ask to cancel it.",
        parameters: { type: 'object', properties: {} },
      },
      async run() {
        const { data: row } = await db
          .from('orders')
          .select('id')
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
          .in('status', ['pending', 'confirmed'])
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!row) return 'There is no active order to cancel for this customer.'

        const { error } = await db
          .from('orders')
          .update({ status: 'cancelled' })
          .eq('id', row.id)
          .eq('account_id', accountId)
          .eq('contact_id', contactId)
        if (error) {
          console.error('[ai tools] cancel_order failed:', error)
          return 'Error: the order could not be cancelled.'
        }
        return 'The order was cancelled. Confirm that to the customer.'
      },
    },
  ]

  const prompt = [
    'Background capability — orders. You can take an order for THIS customer from the product catalog. Like every background capability it is NOT the topic of the conversation: never push products or bring up ordering on your own; engage only when the customer says they want to buy something, asks about their order, or asks to change or cancel it.',
    `Prices and totals are in ${currency} and come from the catalog — never calculate, estimate, or invent a price or a total yourself, and never quote one the tools did not return.`,
    'Flow: when the customer says they want something, call add_to_order, then read the items and total back and ask them to confirm. Call confirm_order only after they explicitly agree. Use remove_from_order or cancel_order when they change their mind, and view_order when they ask what they ordered. If a tool returns an error, say so honestly — never tell a customer an order was placed when it was not.',
    'Invoke tools ONLY through the native tool-calling mechanism. NEVER write tool names, function-call syntax, or code in your reply text — the customer sees your text verbatim.',
  ].join('\n')

  return { tools, prompt }
}
