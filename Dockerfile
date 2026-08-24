# Typewright — local-first typing trainer.
#
# Two stages so the runtime image carries no compilers: the builder compiles the
# native SQLite binding and bundles the app, then prunes dev dependencies. Both
# stages share the same base image, so the compiled binding stays compatible.

FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js components.json ./
COPY script ./script
COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    TYPEWRIGHT_DATA=/data \
    TYPEWRIGHT_LIBRARY=/books

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Books and figures live on a mounted volume, never in the image.
RUN mkdir -p /data /books \
  && chown -R node:node /app /data
USER node

VOLUME ["/data"]
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/settings').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
