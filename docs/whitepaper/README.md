# Mandala whitepaper

Clarified protocol document and a first-principles explainer for engineers.

| File | What |
|---|---|
| `Mandala-Stablecoin-Whitepaper.docx` | Typeset whitepaper (Palatino, US Letter). About five pages of protocol plus a references page. |
| `index.html` | Single-page explainer: elliptic curves, ECDH, BRC-42 child keys, linkage, sender blinding, overlay gates, offline settlement. Open in a browser. |
| `generate_doc.mjs` | Regenerates the `.docx` from source. `node generate_doc.mjs` |
| `figures/` | Architecture drawings used in the paper. |

The paper is the protocol, including work specified here and not yet in the demo (`P2MKH` issuance, the registration chain, key rotation, additive sender blinding `A′ = A + rG`, acceptance signatures `σ_I`, offline settlement). The repository at the workspace root is a working instance of the token, overlay, freeze/reissue, and specific linkage.

Copies also land in `~/Downloads/Mandala-Stablecoin-Whitepaper-clarified.docx` and `~/Downloads/Mandala-explainer.html`.
