# Vendored packages (BRC-162 P2)

Packed from bsv-blockchain/ts-stack `origin/main` at 729ad70e0cf5d507319ded3583691184f47ba488
(contains #738, merge commit 0211fd965) with `pnpm --filter <pkg> pack`.

- bsv-templates-2.0.0.tgz       — @bsv/templates 2.0.0 (Bsv21Binary, strict CBOR)
- bsv-overlay-topics-2.0.0.tgz  — @bsv/overlay-topics 2.0.0 (Mandala on BRC-162)

Neither is on npm yet. When the maintainer publishes them, replace the `file:` specs in
package.json with `^2.0.0`, drop the `@bsv/templates` override, delete this directory, and
re-lock. The `@bsv/overlay` override stays until 2.6.3 is published: topics asks for ^2.6.3,
which only widens the @bsv/sdk peer range over 2.6.2 (ts-stack 20c761568).
