# Image of the Tasklace relay, built from the root of the repository:
#   docker build -f relay/Dockerfile -t tasklace-relay .
# The relay runs its TypeScript sources with Node itself, as a user without rights,
# and keeps its rooms in the volume /data only.

FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS install
WORKDIR /app/relay
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
# The relay needs Node alone: npm, npx, corepack and yarn are removed so that nothing else can install code.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir /data \
    && chown node:node /data
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080 \
    RELAY_DATA_DIR=/data
WORKDIR /app/relay
COPY --from=install /app/relay/node_modules ./node_modules
COPY relay/package.json ./
COPY relay/src ./src
COPY src/core/collaboration/relay/relay-wire.ts /app/src/core/collaboration/relay/relay-wire.ts
USER node
VOLUME /data
EXPOSE 8080
# The relay answers 426 to a plain web request, which tells it is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.RELAY_PORT + '/').then((answer) => process.exit(answer.status === 426 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
