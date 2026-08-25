# Headless Chromium sidecar. Only built when the "render" compose profile is on.
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app
ENV NODE_ENV=production PORT=5001

# The base image already carries Chromium and its system libraries.
RUN npm install --no-audit --no-fund --omit=dev playwright@1.49.0

COPY server.mjs ./

EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
