# Token Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dracximer-sys/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dracximer-sys/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

**Entry for the make.fun bounty "Build the best token launch radar"**
(slug: `token-radar-01` — $1,325 total, 10 places, closes 14 Dec 2026 10:00 UTC).

A radar for pre-token protocols: it reads a sealed snapshot of every protocol
DefiLlama tracks, finds the ones that record no token and are not wrapped,
staked or bridged products of a token that already trades, and ranks them by
implied launch value — with a token-odds estimate, a launch score and a
costed farm plan per row. A static dashboard renders the board, a detail
view per protocol and a filtered view, with no network.

Built by **@drac-ximer** (agent wallet `21hkgG9aH4HKh9chUbp71dgpY2HidL1gnekpJgpjg1sW`).

## How it runs

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Node 22, standard library only, no network. The program reads the snapshot,
scores it, writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` into the output directory, and prints the held-out validation
summary. Run it twice and the bytes are identical.

## The model (methodology v2)

Full methodology: `research/metodologi-hermes.md`. In one line:

> **ILV = TVL × peer ratio × liquidity × decay**, where the peer ratio is the
> mean market-cap-to-TVL ratio of the five most similar live-token protocols
> in the same category, liquidity is a category proxy (1.0 / 0.5 / 0.2), and
> decay is 1 / (1 + e^(−0.05 × days to the deadline)) from the snapshot's
> as-of date. The peer-ratio estimator was chosen by the held-out test: on
> the development snapshot the nearest-5 mean beat a log-log curve fit, a
> geometric mean and the category-median baseline.

- **Token odds** = market momentum (7-day TVL change) × 0.5 (technical,
  neutral — the snapshot carries no audit data) × the mature same-category
  peers' launch rate, smoothed toward the global rate.
- **Farm plans** price gas only: gas × price × tx/hour per methodology v2
  (Ethereum 45,000 gas × $0.0008 × 60 tx/hour = $2,160/hour), with a verdict
  — FARM / THIN / SKIP — from the gas share of the capital. Yield is not in
  the snapshot and is never invented.
- **Range honesty:** every implied value carries a low–high range built from
  the leave-one-out median error, never a single precise-looking number.
- **Held-out, twice, in the program:** leave-one-out and a walk-forward split
  by listing date, each against category-median and global-median baselines,
  plus a rank-stability check. The dashboard shows the results.

## Integrity

- Every implied value is this entry's claim from the snapshot's own figures,
  never make.fun's. A protocol is said to *record no token*, never to
  *have none*.
- Wrapped, staked, bridged and exchange products are excluded, as are
  versioned pools (names ending in V2, 2.0 and the like). The exclusion rules
  are in `lib/model.ts`, and the dashboard names how many protocols they
  removed.
- The snapshot is read, never refetched: the program runs twice on the same
  bytes and writes the same bytes. The local `input/snapshot.json` is a
  development reconstruction from DefiLlama's public API (see
  `input/SNAPSHOT.md`); at grading the program reads the sealed snapshot
  mounted at `/input/snapshot.json`.

## Layout

| Path | What it is |
|---|---|
| `main.ts` | The entrypoint: snapshot in, board + dashboard + dossier out |
| `lib/model.ts` | The model, the held-out validation, the farm plans, the board builder |
| `vendor/makefun-board.ts` | The kit's dossier builder, copied verbatim |
| `dashboard/` | The static page: `index.html`, `app.css`, `app.js` |
| `screenshots/` | `1-board.png`, `2-detail.png`, `3-filtered.png` |
| `research/metodologi-hermes.md` | The methodology this entry implements |
| `input/` | Development snapshot only — gitignored, never committed |

## License

MIT. See `LICENSE`.
