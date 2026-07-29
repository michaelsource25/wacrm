# syntax=docker/dockerfile:1

# ============================================================
# 1. deps — install dependencies only (cached separately from source
#    so editing app code doesn't invalidate the npm install layer).
# ============================================================
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat: some transitive deps ship prebuilt binaries linked
# against glibc; alpine uses musl.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

# ============================================================
# 2. builder — compile the Next.js app.
# ============================================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they must be supplied as build args, not runtime env vars.
# Pass them via `docker build --build-arg` (Dokploy: Build Args).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE

# Server-only vars aren't needed at build time — `next build` doesn't
# read them — so they're intentionally not declared as ARGs here.
# Supply them as runtime env vars in Dokploy instead.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ============================================================
# 3. runner — minimal production image. Only the standalone server,
#    static assets, and public files ship; no node_modules, no
#    source, no build cache.
# ============================================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# .next/standalone contains a copy of node_modules pruned to what's
# actually traced as reachable, plus server.js. Static assets and
# public/ are deliberately excluded from it (see Next.js `output`
# docs) and copied in separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
