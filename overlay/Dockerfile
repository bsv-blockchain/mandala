FROM node:24-bookworm
WORKDIR /app
# Lockfile + npm ci: a lockfile-less `npm install` floats ^1.6.0 overlay-topics
# to the newest 1.x, not the 1.6.0 the tests pin.
COPY package.json package-lock.json ./
RUN npm ci
# No SQLite migration patch: @bsv/overlay >= 2.6 emits ON CONFLICT DO NOTHING
# off MySQL in 2024-07-17-001-transactions.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
