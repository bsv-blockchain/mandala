#!/usr/bin/env node
/**
 * Mandala whitepaper — typeset Word document.
 * Palatino, gold rules, US Letter. Target: 5 pages of content + references.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Header, Footer,
  AlignmentType, HeadingLevel, BorderStyle, PageNumber, ShadingType,
  TabStopType, TabStopPosition, InternalHyperlink, Bookmark,
  ExternalHyperlink, VerticalAlign, WidthType, Table, TableRow, TableCell,
  LevelFormat,
} from "docx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIG = path.join(__dirname, "figures");

const INK = "1C140C";
const GOLD = "8A6A2A";
const GOLD_LINE = "C4A35A";
const MUTED = "5C4E3E";
const CREAM = "F7F1E3";
const FONT = "Palatino";

const PAGE_W = 12240;
const PAGE_H = 15840;
const M_LEFT = 1152;  // 0.80"
const M_RIGHT = 1152;
const M_TOP = 1080;   // 0.75"
const M_BOTTOM = 1008;
const CONTENT_W = PAGE_W - M_LEFT - M_RIGHT; // 9936

const thinGold = { style: BorderStyle.SINGLE, size: 8, color: GOLD_LINE, space: 1 };
const hairGold = { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 4 };
const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const cellBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

const t = (text, extra = {}) =>
  new TextRun({ text, font: FONT, size: 22, color: INK, ...extra });
const ti = (text, extra = {}) => t(text, { italics: true, ...extra });
const tb = (text, extra = {}) => t(text, { bold: true, ...extra });
const sm = (text, extra = {}) => t(text, { size: 18, color: MUTED, ...extra });

function cite(...nums) {
  const out = [];
  nums.forEach((n, i) => {
    if (i) out.push(new TextRun({ text: "\u2009", font: FONT, size: 16 }));
    out.push(new InternalHyperlink({
      anchor: `ref${n}`,
      children: [new TextRun({ text: `[${n}]`, superScript: true, font: FONT, size: 15, color: GOLD })],
    }));
  });
  return nums.length === 1 ? out[0] : out;
}

function p(children, extra = {}) {
  const ch = Array.isArray(children) ? children : [t(children)];
  return new Paragraph({
    spacing: { after: 160, line: 276 },
    ...extra,
    children: ch,
  });
}

function h1(text, bookmark) {
  const run = new TextRun({ text, font: FONT, size: 28, bold: true, color: GOLD });
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    pageBreakBefore: bookmark === "refs",
    spacing: { before: 280, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 4 } },
    children: bookmark
      ? [new Bookmark({ id: bookmark, children: [run] })]
      : [run],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, font: FONT, size: 24, bold: true, italics: true, color: INK })],
  });
}

function eq(children) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120, line: 300 },
    shading: { type: ShadingType.CLEAR, fill: CREAM },
    border: {
      top: { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 8 },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 8 },
    },
    children: Array.isArray(children) ? children : [ti(children, { size: 22 })],
  });
}

function caption(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 60, after: 180 },
    children: [ti(text, { size: 16, color: MUTED })],
  });
}

function figure(file, wPx, hPx, alt) {
  const data = fs.readFileSync(path.join(FIG, file));
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 140, after: 40 },
    keepNext: true,
    children: [
      new ImageRun({
        type: "png",
        data,
        transformation: { width: wPx, height: hPx },
        altText: { name: alt, description: alt, title: alt },
      }),
    ],
  });
}

function refItem(n, body, url) {
  const kids = [
    new Bookmark({
      id: `ref${n}`,
      children: [tb(`[${n}]  `, { size: 20 })],
    }),
    t(body, { size: 20 }),
  ];
  if (url) {
    kids.push(t("  ", { size: 20 }));
    kids.push(new ExternalHyperlink({
      link: url,
      children: [new TextRun({ text: url, font: FONT, size: 18, color: GOLD, underline: {} })],
    }));
  }
  return new Paragraph({
    spacing: { after: 100, line: 260 },
    indent: { left: 360, hanging: 360 },
    children: kids,
  });
}

const emblem = fs.readFileSync(path.join(FIG, "emblem-white.png"));

const header = new Header({
  children: [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      border: { bottom: hairGold },
      spacing: { after: 80 },
      children: [
        new ImageRun({
          type: "png",
          data: emblem,
          transformation: { width: 16, height: 16 },
          altText: { name: "Mandala mark", description: "Concentric mandala emblem", title: "Mandala" },
        }),
        new TextRun({ text: "   MANDALA", font: FONT, size: 16, bold: true, color: GOLD }),
        new TextRun({ text: "  ·  Auditable fiat-backed tokens on Bitcoin SV", font: FONT, size: 16, color: MUTED }),
        new TextRun({ text: "\tSeptember 2026", font: FONT, size: 16, color: GOLD }),
      ],
    }),
  ],
});

const footer = new Footer({
  children: [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      border: { top: hairGold },
      spacing: { before: 60 },
      children: [
        new TextRun({ text: "github.com/bsv-blockchain/mandala", font: FONT, size: 16, color: MUTED }),
        new TextRun({ text: "\t", font: FONT, size: 16 }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: INK }),
      ],
    }),
  ],
});

const children = [];

// ── Title block ──────────────────────────────────────────────
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 80, after: 40 },
  children: [
    new ImageRun({
      type: "png",
      data: emblem,
      transformation: { width: 44, height: 44 },
      altText: { name: "Mandala", description: "Mandala emblem", title: "Mandala" },
    }),
  ],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 80, after: 40 },
  children: [new TextRun({ text: "MANDALA", font: FONT, size: 20, bold: true, color: GOLD, characterSpacing: 400 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 80 },
  children: [new TextRun({
    text: "Auditable Fiat-Backed Tokens on Bitcoin SV",
    font: FONT, size: 36, bold: true, color: INK,
  })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 40 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: GOLD, space: 6 } },
  children: [ti("Issuance, overlay admission, transfer, and offline settlement", { size: 22, color: MUTED })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 120, after: 220 },
  children: [
    t("Darren Kellenschwiler", { size: 20 }),
    t("  ·  ", { size: 20, color: GOLD }),
    ti("September 2026", { size: 20, color: MUTED }),
  ],
}));

// ── Abstract ─────────────────────────────────────────────────
children.push(h1("Abstract"));
children.push(p([
  t("Bitcoin SV consensus checks scripts and prevents satoshi double-spends. It does not check token conservation, membership, or administrative authorization. Those predicates live in an "),
  ti("overlay"),
  t(" that implements a published protocol. Anyone may run a replica. A licensed issuer is the trust anchor for administrative spends and for the identity graph."),
]));
children.push(p([
  t("Two hash-linked administrative chains carry that authority. The "),
  ti("issuance chain"),
  t(" is the public function of supply: genesis defines the asset, and every mint, redeem, freeze, or reissue extends a threshold-locked authorization outpoint. The "),
  ti("registration chain"),
  t(" is the public function of membership: admit and revoke events bind to identity keys without naming them on-chain. Keys on both chains are commitments to a specific administrative task and can be opened when a jurisdiction requires it."),
]));
children.push(p([
  t("Transfers lock one satoshi to a one-time child key derived under the BSV key-derivation scheme"),
  cite(3),
  t(". The overlay learns ownership by a specific linkage — the per-output offset — encrypted to itself"),
  ...cite(5, 6),
  t(". The recipient sees a blinded sender key and cannot join successive payments. The sender can later prove association. Offline, a payment carries native Merkle proofs plus an issuer signature on each input transaction identifier. Double-spend risk is the same window native satoshis have when the network cannot be queried, with the added property that the issuer already knows who those inputs belong to."),
]));
children.push(p([
  ti("Legal structure, licensing, and reserve composition are out of scope."),
]));

// ── 1. Design ────────────────────────────────────────────────
children.push(h1("1.  Design"));
children.push(p([
  t("Separate what the ledger already does from what a token protocol must add."),
]));
children.push(p([
  t("Miners validate unlocking scripts and ensure each satoshi output is spent at most once"),
  cite(10),
  t(". A Mandala token is one satoshi plus a locking script that carries an asset identifier and an amount, then a standard pay-to-public-key-hash"),
  cite(2),
  t(". Consensus does not read the asset identifier. It will mine a transaction that inflates token supply, pays a person who was never admitted, or spends a frozen coin, provided the scripts unlock and the satoshis are not double-spent."),
]));
children.push(p([
  t("The overlay is the decider of whether a transaction is a valid token movement"),
  cite(12),
  t(". It implements a published protocol. A licensed issuer operates the authoritative overlay for administrative spends and for the identity graph that registration produces. Exchanges and holders may run listen-only replicas that recompute the same rules and do not mint. Trust is concentrated where a fiat reserve already requires it, and split across keys so that no single officer can mint. Everywhere else the checks are local."),
]));
children.push(p([
  t("Addresses are single-use. The object that is KYC\u2019d is a long-lived identity key"),
  cite(15),
  t(". Compliance is a predicate on that key, not on an address."),
]));

// Figure: split
children.push(figure("fig-split.png", 520, Math.round(520 * 720 / 1800),
  "Split of labour: Bitcoin SV consensus versus the Mandala overlay"));
children.push(caption("Figure 1. Consensus admits T if scripts unlock and satoshis are unspent. The overlay admits T as a token movement only if conservation, linkage, membership, and administrative authorization all hold."));

// ── 2. Two chains ────────────────────────────────────────────
children.push(h1("2.  Two administrative chains"));
children.push(p([
  t("Both chains are hash-linked sequences of threshold spends. Each spend consumes authorized outpoint "),
  ti("n"),
  t(" and produces "),
  ti("n"),
  t(" + 1. Forging a step requires a live signing threshold. Rewriting history after broadcast requires a deep reorg."),
]));

children.push(h2("2.1  Issuance"));
children.push(p([
  t("The issuance chain is the public function of supply. Genesis defines"),
]));
children.push(eq([
  ti("assetId  =  txid  ||  vout"),
]));
children.push(p([
  t("and authorized outpoint 0"),
  cite(2),
  t(". On-chain those 36 bytes are the genesis outpoint in internal byte order: the 32-byte transaction hash as it appears in the transaction, followed by the four-byte little-endian output index. A contract can therefore compare an embedded "),
  ti("assetId"),
  t(" directly against an outpoint it is looking at."),
]));
children.push(p([
  t("A deposit in a traditional account is followed by an issuance spend that creates token outputs summing to the deposited face value and commits a hash of the deposit record. Redeem, freeze, and reissue are the same chain with a different authorized supply delta "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t("."),
]));
children.push(p([
  t("Let "),
  ti("D"),
  t("t", { subScript: true }),
  t(" and "),
  ti("W"),
  t("t", { subScript: true }),
  t(" be cumulative attested deposits and withdrawals. Circulating supply is "),
  ti("S"),
  t("t", { subScript: true }),
  t(" = "),
  ti("D"),
  t("t", { subScript: true }),
  t(" − "),
  ti("W"),
  t("t", { subScript: true }),
  t(". The overlay admits a transfer only when, per asset,"),
]));
children.push(eq([
  ti("Σ a"),
  ti("out", { subScript: true, size: 16 }),
  ti("   =   Σ a"),
  ti("in", { subScript: true, size: 16 }),
  ti("   +   Δ"),
  t("auth", { italics: true, subScript: true, size: 16 }),
  ti("."),
]));
children.push(p([
  t("For a peer transfer, "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t(" = 0, so outputs exactly equal inputs. An "),
  ti("issue"),
  t(" sets "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t(" = +amount. A "),
  ti("redeem"),
  t(" sets "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t(" = −amount, so a partial burn still conserves. A "),
  ti("freeze"),
  t(" spends the live authorization outpoint, writes the frozen outpoint into overlay state, and sets "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t(" = 0: the coin remains on-chain, but any later spend of it is refused. A "),
  ti("reissue"),
  t(" targets an already-frozen outpoint, evicts it from the overlay’s balance view, and mints replacement units to a named recipient with "),
  ti("Δ"),
  t("auth", { subScript: true }),
  t(" = +amount and zero fungible inputs of that asset."),
]));
children.push(p([
  t("Issuance outputs lock under a pay-to-multi-key-hash template"),
  cite(18),
  t(". The minimum policy is two-of-two. Two-of-three or two-of-four is used when an off-site recovery key is kept for lost-device cases. That key does not sign day to day. Each authorization key is derived as a commitment to the canonical action object (kind, asset, amount, prior outpoint, and any bank reference), so a given outpoint is cryptographically tied to one administrative task and can be opened by revealing that object."),
]));

children.push(h2("2.2  Registration"));
children.push(p([
  t("The registration chain is issuer-level, not per asset. One admission covers every stablecoin that issuer operates. Identity keys are not pushed on-chain."),
]));
children.push(p([
  t("Each spend is an "),
  ti("admit"),
  t(" or "),
  ti("revoke"),
  t(" event. The payload is a bound key whose invoice number follows the standard three-part form"),
  cite(19),
]));
children.push(eq([
  ti("ι  =  ℓ-protocolID-keyID"),
]));
children.push(p([
  t("The key identifier is the hash of the event object. Derivation is Section 3 against "),
  ti("self"),
  t(" or "),
  ti("anyone"),
  t(" as counterparty. The public chain shows that a threshold signed an admission or a revocation at a given height. It does not name the person. A regulator given the event object recomputes "),
  ti("ι"),
  t(" and the bound key and opens the event."),
]));
children.push(p([
  t("The current allow-list is the replay of that chain into a database. The database is a cache. It is not process memory and it is not the source of truth."),
]));

children.push(h2("2.3  Rotation"));
children.push(p([
  t("Key rotation is procedure. The live set rotates on a regular cadence. A dedicated rotation spend on the relevant chain publishes the new key set, the threshold, and the block height "),
  ti("h"),
  t(" at which it becomes authoritative for fresh attestation signatures."),
]));
children.push(p([
  t("Clients cache the current set, every previous set, and the height of each rotation. New attestation signatures are accepted only under a key that was live at the height of the signed transaction. A phone that has not seen the latest rotation rejects signatures from the new key until it syncs."),
]));

children.push(figure("fig-chains.png", 520, Math.round(520 * 780 / 1800),
  "Issuance chain and registration chain as hash-linked threshold spends"));
children.push(caption("Figure 2. Two spines of control. Issuance is per asset and is the public function of supply. Registration is per issuer and is the public function of membership. Both are threshold-locked; neither names a person on-chain."));

// ── 3. Payment keys ──────────────────────────────────────────
children.push(h1("3.  Payment keys"));
children.push(p([
  t("This section is the only cryptography a transfer needs. secp256k1 is an elliptic-curve group: a set of points with an addition law, a distinguished generator "),
  ti("G"),
  t(", and a prime order "),
  ti("n"),
  cite(13),
  t(". A private key is a scalar "),
  ti("a"),
  t(" chosen uniformly from 1 … "),
  ti("n"),
  t(" − 1. The corresponding public key is the point "),
  ti("A = aG"),
  t(", meaning "),
  ti("G"),
  t(" added to itself "),
  ti("a"),
  t(" times. Given "),
  ti("A"),
  t(", computing "),
  ti("a"),
  t(" is the elliptic-curve discrete logarithm; it is assumed hard."),
]));
children.push(p([
  t("Sender "),
  ti("A"),
  t(" holds "),
  ti("(a, A = aG)"),
  t(". Recipient "),
  ti("B"),
  t(" holds "),
  ti("(b, B = bG)"),
  t(". They agree on an invoice "),
  ti("ι"),
  t(". When "),
  ti("ι"),
  t(" is a structured object it is the three-part form of Section 2.2 and the key identifier is the hash of that object"),
  ...cite(3, 19),
  t(". Both compute the same shared point by elliptic-curve Diffie–Hellman,"),
]));
children.push(eq([
  ti("S  =  aB  =  bA  =  (ab)G."),
]));
children.push(p([
  t("Neither learns the other’s private key. They then turn "),
  ti("S"),
  t(" into a per-invoice scalar with HMAC-SHA256, a keyed hash that behaves as a pseudorandom function when the key is secret"),
  cite(9),
  t(":"),
]));
children.push(eq([
  ti("k  =  int( HMAC-SHA256( compress(S), UTF-8(ι) ) )   mod n,     H  =  kG."),
]));
children.push(p([
  t("The output key is the recipient’s identity plus that offset:"),
]));
children.push(eq([
  ti("P"),
  ti("out", { subScript: true, size: 16 }),
  ti("  =  B + H  =  (b + k)G."),
]));
children.push(p([
  t("The recipient’s private key is "),
  ti("b"),
  t("out", { subScript: true }),
  t(" = ("),
  ti("b"),
  t(" + "),
  ti("k"),
  t(") mod "),
  ti("n"),
  t(". Anyone who knows "),
  ti("(a, B, ι)"),
  t(" or "),
  ti("(b, A, ι)"),
  t(" can compute "),
  ti("P"),
  t("out", { subScript: true }),
  t(". Only "),
  ti("B"),
  t(" can compute "),
  ti("b"),
  t("out", { subScript: true }),
  t("."),
]));
children.push(p([
  t("The mined output reveals HASH160("),
  ti("P"),
  t("out", { subScript: true }),
  t(") and the amount. HASH160 is RIPEMD-160(SHA-256(·)), Bitcoin’s standard public-key fingerprint. The output does not reveal "),
  ti("A"),
  t(", "),
  ti("B"),
  t(", "),
  ti("S"),
  t(", "),
  ti("k"),
  t(", or "),
  ti("ι"),
  t("."),
]));
children.push(p([
  t("A token output is one satoshi locked as"),
  cite(2),
]));
children.push(eq([
  t("<assetId> <a> OP_2DROP  OP_DUP OP_HASH160 <h> OP_EQUALVERIFY OP_CHECKSIG", { size: 18, italics: true }),
]));
children.push(p([
  t("with "),
  ti("h"),
  t(" = HASH160("),
  ti("P"),
  t("out", { subScript: true }),
  t("). There is no protocol-identifier push. It is redundant: the overlay already knows the rule set, and consensus does not read the prefix."),
]));

// ── 4. Linkage ───────────────────────────────────────────────
children.push(h1("4.  Linkage and blinding"));
children.push(p([
  t("The overlay must know which identity owns each accepted output. The association is the offset "),
  ti("k"),
  t(": "),
  ti("P"),
  t("out", { subScript: true }),
  t(" = "),
  ti("B"),
  t(" + "),
  ti("kG"),
  t(". Revealing "),
  ti("S"),
  t(" would let anyone with "),
  ti("S"),
  t(" recompute every past and future child between the two parties, because "),
  ti("k′ = HMAC(S, ι′)"),
  t(" for every other invoice. Revealing "),
  ti("k"),
  t(" links one output"),
  cite(5),
  t(". That revelation is encrypted to the overlay under the specific-linkage protocol"),
  cite(6),
  t(". The overlay decrypts "),
  ti("k"),
  t(", checks"),
]));
children.push(eq([
  ti("HASH160( compress(B + kG) )  =  h"),
]));
children.push(p([
  t("and refuses the output if the check fails. The same revelation is attached to every fungible input, so a spend can be named from the identity bound when that coin was first accepted."),
]));
children.push(p([
  t("If the remittance carried "),
  ti("A"),
  t(", the recipient could derive every future child against "),
  ti("A"),
  t(" and join later payments"),
  cite(4),
  t(". The sender never presents "),
  ti("A"),
  t(". The sender samples "),
  ti("r"),
  t(" uniformly from 1 … "),
  ti("n"),
  t(" − 1 and presents the blinded key "),
  ti("A′ = A + rG"),
  t(". The recipient derives against "),
  ti("A′"),
  t(". Consecutive payments use independent "),
  ti("r"),
  t(" and are unlinkable for the recipient. This is the same remittance shape as authenticated P2PKH payments"),
  cite(4),
  t(" and the same privacy goal as unlinkable payments"),
  cite(17),
  t(", with one difference that matters for later proof: "),
  ti("A′"),
  t(" is an additive blinding of the long-term identity, not an independent ephemeral. The overlay does not need "),
  ti("A′"),
  t(". It already bound the inputs."),
]));
children.push(p([
  t("The sender later proves association by revealing "),
  ti("r"),
  t(" and checking "),
  ti("A′ − rG = A"),
  t(", or by a Schnorr proof of knowledge of "),
  ti("r"),
  t(" — a discrete-log proof that "),
  ti("A′ − A = rG"),
  t(", without revealing "),
  ti("r"),
  ...cite(1, 7, 8),
  t(". A recipient may request that revelation. Change outputs locked back to the sender still use "),
  ti("A"),
  t(" as counterparty; they never leave the sender’s wallet."),
]));

// ── 5. Compliance ────────────────────────────────────────────
children.push(h1("5.  Compliance"));
children.push(p([
  t("The overlay evaluates transfers against the reconstructed registration view. A new output whose linkage names a "),
  ti("B"),
  t(" that is not admitted is refused. A spend whose input was bound to a "),
  ti("B"),
  t(" that has since been revoked is refused. Pause rejects peer transfers and still permits issuer actions that carry a verified administrative output."),
]));

// ── 6. Overlay acceptance ────────────────────────────────────
children.push(h1("6.  Overlay acceptance"));
children.push(p([
  t("A transaction may be mined and still be rejected by the overlay. A transaction the overlay accepts is a valid token movement. The transfer pipeline signs with broadcast withheld, attaches the linkage payload, submits, and broadcasts only on admission."),
]));
children.push(p([
  t("On acceptance of "),
  ti("T"),
  t(" the overlay returns a signature "),
  ti("σ"),
  t("I", { subScript: true }),
  t(" under the live issuer key on "),
  ti("m"),
  t("acc", { subScript: true }),
  t(" = txid("),
  ti("T"),
  t("). It does not enumerate output indices. If any output in "),
  ti("T"),
  t(" were not a genuine token, "),
  ti("T"),
  t(" would not have been signed. Acceptance of the identifier is acceptance of every spendable token output in that transaction. The signature attests to validity at acceptance time, not to the absence of a later spend."),
]));

// ── 7. Offline ───────────────────────────────────────────────
children.push(h1("7.  Offline settlement"));
children.push(p([
  t("Offline mode is a convenience path for short disconnects. Sender blinding still applies."),
]));
children.push(p([
  t("A receiver with cached headers verifies that an offered native input is a mined output by checking a Merkle path"),
  ...cite(10, 14),
  t(". What cannot be known offline is whether that output has already been spent. The signed transaction is handed across. On reconnect, Arcade reports whether the inputs are unspent"),
  cite(11),
  t(". Arcade is a relay. The fraud window is the offline interval. The signature already held is evidence."),
]));
children.push(p([
  t("Token transfers need one extra object: "),
  ti("σ"),
  t("I", { subScript: true }),
  t(" on each unique input txid, verified against the issuer key that was live at the height of the corresponding Merkle path, or the current key for unconfirmed inputs. The recipient then has the same existence proof a native transfer has, plus assurance that the issuer accepted those inputs as tokens and already knows who they belong to. Double-spend protection is the same window. On reconnect the overlay performs the live spend check, conservation, and identity predicates."),
]));
children.push(p([
  t("If a fraudulent offline double-spend is alleged, an appropriate authority (court order or police inquiry) asks the issuer to open the identity already bound to those inputs."),
]));

// ── 8. Security ──────────────────────────────────────────────
children.push(h1("8.  Security"));
children.push(p([
  t("Threshold scripts fail closed if a required key is lost; that is why a recovery key exists and stays off-site. A lying overlay can refuse valid transfers. It cannot create tokens without an issuance-chain spend. Holders mitigate by running a replica and by demanding "),
  ti("σ"),
  t("I", { subScript: true }),
  t(" at receipt. Compromise of the overlay private key discloses the identity graph. It does not disclose long-term ECDH secrets between users: those secrets are "),
  ti("aB"),
  t(", and the overlay was given "),
  ti("k"),
  t(", not "),
  ti("S"),
  t(". "),
  ti("A′"),
  t(" is uniform when "),
  ti("r"),
  t(" is. Two offline receivers can both accept spends of the same input; exactly one spend survives contact with the network."),
]));

// ── 9. Conclusion ────────────────────────────────────────────
children.push(h1("9.  Conclusion"));
children.push(p([
  t("Supply is a public function of the issuance chain. Membership is a public function of the registration chain, opened only when required. Movement conserves amount, pays a single-use key, and carries a linkage the overlay alone can open. The sender is blinded from the recipient in every mode. Offline, a token payment carries native existence proofs plus an issuer signature over each input transaction identifier. The remaining risk is the double-spend window Bitcoin has always had when the network cannot be queried."),
]));

// ── References ───────────────────────────────────────────────
children.push(h1("References", "refs")); // starts a new page via heading spacing; keep with list

const refs = [
  [1, "C. P. Schnorr, “Efficient identification and signatures for smart cards,” in Advances in Cryptology — CRYPTO ’89. See also Schnorr signature, Grokipedia.", "https://grokipedia.com/page/Schnorr_signature"],
  [2, "Deggen, “Mandala Token Protocol,” Bitcoin Request for Comments, tokens/0092.", "https://bsv.brc.dev/tokens/0092"],
  [3, "T. Everett, “BSV Key Derivation Scheme (BKDS),” Bitcoin Request for Comments, key-derivation/0042.", "https://bsv.brc.dev/key-derivation/0042"],
  [4, "T. Everett, “Simple Authenticated BSV P2PKH Payment Protocol,” Bitcoin Request for Comments, payments/0029.", "https://bsv.brc.dev/payments/0029"],
  [5, "T. Everett, “Revealing Key Linkages,” Bitcoin Request for Comments, key-derivation/0069.", "https://bsv.brc.dev/key-derivation/0069"],
  [6, "T. Everett, “Protecting BRC-69 Key Linkage Information in Transit,” Bitcoin Request for Comments, key-derivation/0072.", "https://bsv.brc.dev/key-derivation/0072"],
  [7, "T. Everett, “Verifiable Revelation of Shared Secrets Using Schnorr Protocol,” Bitcoin Request for Comments, key-derivation/0094.", "https://bsv.brc.dev/key-derivation/0094"],
  [8, "F. Hao, “Schnorr Non-interactive Zero-Knowledge Proof,” RFC 8235, IETF, Sep. 2017.", "https://datatracker.ietf.org/doc/rfc8235/"],
  [9, "H. Krawczyk, M. Bellare, and R. Canetti, “HMAC: Keyed-Hashing for Message Authentication,” RFC 2104, IETF, Feb. 1997.", "https://datatracker.ietf.org/doc/rfc2104/"],
  [10, "S. Nakamoto, “Bitcoin: A Peer-to-Peer Electronic Cash System,” 2008.", "https://bitcoin.org/bitcoin.pdf"],
  [11, "BSV Association, “Arcade.”", "https://github.com/bsv-blockchain/arcade"],
  [12, "T. Everett, “Thoughts on the Mandala Network,” Bitcoin Request for Comments, opinions/0090.", "https://bsv.brc.dev/opinions/0090"],
  [13, "Certicom Research, “SEC 2: Recommended Elliptic Curve Domain Parameters,” secp256k1.", "https://www.secg.org/sec2-v2.pdf"],
  [14, "Bitcoin SV BRCs, Simplified Payment Verification and unified Merkle path formats, transactions/0067 and transactions/0074.", "https://bsv.brc.dev/transactions/0067"],
  [15, "T. Everett, “Identity Certificates,” Bitcoin Request for Comments, peer-to-peer/0052.", "https://bsv.brc.dev/peer-to-peer/0052"],
  [16, "BSV Association, “Mandala.”", "https://github.com/bsv-blockchain/mandala"],
  [17, "Bitcoin SV BRCs, “Unlinkable Payments under the Identity Paradigm,” payments/0228.", "https://bsv.brc.dev/payments/0228"],
  [18, "BSV Association, “ts-templates,” including P2MKH.", "https://github.com/bsv-blockchain/ts-templates"],
  [19, "T. Everett, “Security Levels, Protocol IDs, Key IDs and Counterparties,” Bitcoin Request for Comments, key-derivation/0043.", "https://bsv.brc.dev/key-derivation/0043"],
];
for (const [n, body, url] of refs) children.push(refItem(n, body, url));

const doc = new Document({
  creator: "Darren Kellenschwiler",
  title: "Mandala: Auditable Fiat-Backed Tokens on Bitcoin SV",
  description: "A protocol for issuance, overlay admission, transfer, and offline settlement on Bitcoin SV.",
  styles: {
    default: {
      document: { run: { font: FONT, size: 22, color: INK } },
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: FONT, color: GOLD },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 },
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, italics: true, font: FONT, color: INK },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 },
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: M_TOP, right: M_RIGHT, bottom: M_BOTTOM, left: M_LEFT, header: 576, footer: 576 },
      },
    },
    headers: { default: header },
    footers: { default: footer },
    children,
  }],
});

const out = path.join(__dirname, "Mandala-Stablecoin-Whitepaper.docx");
const buf = await Packer.toBuffer(doc);
fs.writeFileSync(out, buf);
console.log("wrote", out, buf.length, "bytes");
