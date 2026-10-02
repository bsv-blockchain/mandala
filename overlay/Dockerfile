FROM node:24-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
# BRC-162 P2: overlay-topics/templates 2.0.0 are vendored tarballs until published (vendor/README.md).
COPY vendor ./vendor
RUN npm ci
# No SQLite migration patch: @bsv/overlay >= 2.6 emits ON CONFLICT DO NOTHING
# off MySQL in 2024-07-17-001-transactions.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
