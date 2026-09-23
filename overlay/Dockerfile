FROM node:20.18-bullseye
WORKDIR /app
COPY package.json ./
RUN npm install
# Patch @bsv/overlay migration that uses MySQL-only syntax so it works with SQLite.
# The migration moves data from outputs→transactions; on a fresh DB (no prior rows) both
# INSERT IGNORE and INSERT OR IGNORE are equivalent — the table is always empty at this point.
RUN node -e "\
const fs = require('fs'); \
const files = [ \
  'node_modules/@bsv/overlay/dist/cjs/src/storage/knex/migrations/2024-07-17-001-transactions.js', \
  'node_modules/@bsv/overlay/dist/esm/src/storage/knex/migrations/2024-07-17-001-transactions.js' \
]; \
files.forEach(f => { \
  let c = fs.readFileSync(f, 'utf8'); \
  c = c.replace(/INSERT IGNORE INTO/g, 'INSERT OR IGNORE INTO'); \
  fs.writeFileSync(f, c); \
}); \
console.log('migration patched'); \
"
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
