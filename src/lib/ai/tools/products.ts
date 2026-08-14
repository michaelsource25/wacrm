import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutableTool } from '../types'
import { engineSendMedia } from '@/lib/flows/meta-send'

// ============================================================
// Product catalog tools for the AI auto-reply bot (migration 041).
//
// The second pluggable capability, after appointments. The knowledge
// base can only carry text and can't send anything; this gives the
// bot the account's real catalog plus the ability to actually PUT A
// PHOTO in the customer's chat.
//
// Only built when the account has at least one active product, so a
// business that sells nothing never hears about products (see the
// generalist-CRM design note in tools/appointments.ts).
//
// Safety model — executors run on the service-role client:
//   - every query is account-scoped, and only `is_active` rows are
//     visible, so a deactivated product can never be quoted or sent
//   - photo sends are bound to THIS conversation/contact; the model
//     picks WHICH product, never WHO receives it
//   - MAX_PHOTOS_PER_REPLY caps how many images one reply can push,
//     so a confused (or prompt-injected) model can't spam the chat
// ============================================================

/** Hard cap on photos sent within a single reply. */
const MAX_PHOTOS_PER_REPLY = 3

/** Catalog size sent to the model in one lookup. */
const MAX_RESULTS = 12

/** Meta rejects captions past 1024 chars on media messages. */
const MAX_CAPTION = 900

interface ProductRow {
  id: string
  name: string
  description: string | null
  price: number | null
  image_url: string | null
}

export interface ProductToolsResult {
  tools: ExecutableTool[]
  /** Capability fragment appended to the system prompt. */
  prompt: string
}

interface BuildArgs {
  accountId: string
  /** Conversation + contact the photos are sent into. */
  conversationId: string
  contactId: string
  /** WhatsApp config owner, for the send's audit columns. */
  configOwnerUserId: string
  /** Account currency (021), so quoted prices carry their unit. */
  currency: string
}

/** One catalog line as the model sees it. */
function describe(p: ProductRow, currency: string): string {
  const parts = [`${p.name}`]
  if (p.price != null) parts.push(`${currency} ${p.price}`)
  if (p.description) parts.push(p.description.slice(0, 200))
  parts.push(p.image_url ? 'has photo' : 'no photo')
  return `[${p.id}] ${parts.join(' — ')}`
}

/**
 * Build the catalog tools for one reply, or null when the account has
 * no active products (capability stays invisible to the model).
 */
export async function buildProductTools(
  db: SupabaseClient,
  args: BuildArgs,
): Promise<ProductToolsResult | null> {
  const { accountId, conversationId, contactId, configOwnerUserId, currency } = args

  const { data } = await db
    .from('products')
    .select('id, name, description, price, image_url')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(200)

  const catalog = (data ?? []) as ProductRow[]
  if (catalog.length === 0) return null

  // Counter shared by every call in this reply's tool loop.
  let photosSent = 0

  const find = (raw: unknown): ProductRow | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null
    const q = raw.trim().toLowerCase()
    return (
      catalog.find((p) => p.id === raw.trim()) ??
      catalog.find((p) => p.name.toLowerCase() === q) ??
      catalog.find((p) => p.name.toLowerCase().includes(q)) ??
      null
    )
  }

  const tools: ExecutableTool[] = [
    {
      def: {
        name: 'search_products',
        description:
          "Look up products in the business's real catalog by keyword (name or description). Call this before quoting any product, price, or availability — never answer from memory. Omit the query to list what's available.",
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Keywords from the customer\'s question, e.g. "camisa azul". Omit to list everything.',
            },
          },
        },
      },
      async run(toolArgs) {
        const q =
          typeof toolArgs.query === 'string' ? toolArgs.query.trim().toLowerCase() : ''
        // Match on whole words the customer used; a bare substring
        // scan over short queries returns noise.
        const terms = q.split(/\s+/).filter((w) => w.length >= 3)
        const matches =
          terms.length === 0
            ? catalog
            : catalog.filter((p) => {
                const hay = `${p.name} ${p.description ?? ''}`.toLowerCase()
                return terms.some((w) => hay.includes(w))
              })

        if (matches.length === 0) {
          return `No products match "${q}". The catalog has ${catalog.length} item(s); call search_products with no query to see them, and tell the customer honestly if we don't carry it.`
        }
        const shown = matches.slice(0, MAX_RESULTS)
        const more =
          matches.length > shown.length
            ? `\n(and ${matches.length - shown.length} more — ask the customer to narrow it down)`
            : ''
        return `Matching products (id in brackets — pass it to send_product_photo):\n${shown
          .map((p) => describe(p, currency))
          .join('\n')}${more}`
      },
    },
    {
      def: {
        name: 'send_product_photo',
        description:
          "Send a product's photo to this customer over WhatsApp, with a short caption. Use it whenever the customer asks to see a product. Get the id from search_products.",
        parameters: {
          type: 'object',
          properties: {
            product_id: {
              type: 'string',
              description: 'Product id from search_products',
            },
            caption: {
              type: 'string',
              description:
                "Short caption in the customer's language, e.g. name and price. Keep it under one line.",
            },
          },
          required: ['product_id'],
        },
      },
      async run(toolArgs) {
        if (photosSent >= MAX_PHOTOS_PER_REPLY) {
          return `Error: photo limit reached for this reply (${MAX_PHOTOS_PER_REPLY}). Describe the rest in text and offer to send more if the customer asks.`
        }
        const product = find(toolArgs.product_id)
        if (!product) {
          return 'Error: no such product. Call search_products to get a valid id.'
        }
        if (!product.image_url) {
          return `Error: "${product.name}" has no photo on file. Describe it in text instead — do not claim you sent a photo.`
        }

        const caption =
          typeof toolArgs.caption === 'string' && toolArgs.caption.trim()
            ? toolArgs.caption.trim().slice(0, MAX_CAPTION)
            : [product.name, product.price != null ? `${currency} ${product.price}` : '']
                .filter(Boolean)
                .join(' — ')

        // Claim the slot before sending: a failed send must not free
        // the budget for a retry loop.
        photosSent++
        try {
          await engineSendMedia({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            kind: 'image',
            link: product.image_url,
            caption,
          })
        } catch (err) {
          console.error('[ai tools] send_product_photo failed:', err)
          return `Error: the photo of "${product.name}" could not be sent. Tell the customer you'll share it shortly — do not claim it was sent.`
        }
        return `Photo of "${product.name}" was sent to the customer with caption: "${caption}". Do not repeat the caption verbatim in your reply; add anything else useful, or keep your reply very short.`
      },
    },
  ]

  const prompt = [
    'Background capability — product catalog. This business sells products and you have tools to look them up and send their photos to THIS customer. Like every background capability, it is NOT the topic of the conversation: never bring up products on your own; engage only when the customer\'s latest message asks about what you sell, a specific product, a price, or to see a photo.',
    `Prices are in ${currency}.`,
    'Rules: always call search_products before naming a product, quoting a price, or saying whether you carry something — never answer from memory and never invent products, prices, colours, or sizes. When the customer asks to see something (or a photo would obviously help), call send_product_photo. The photo is delivered as its own WhatsApp message, so your text reply should NOT say "here is the photo" as if pasting it — just add context. If a product has no photo on file, describe it honestly instead.',
    'Invoke tools ONLY through the native tool-calling mechanism. NEVER write tool names, function-call syntax, or code in your reply text — the customer sees your text verbatim.',
  ].join('\n')

  return { tools, prompt }
}
