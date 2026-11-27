// Token Launch Radar — the entrypoint. Node 22, standard library only.
//
// The run, end to end: the sealed snapshot is read from /input/snapshot.json
// (or --input <file|dir>), every pre-token protocol is scored by the model
// in lib/model.ts — implied value from the methodology v2 formula, token odds
// from the peers' launch record, a costed farm plan per row — the model is
// validated held-out twice (leave-one-out and walk-forward), the ranked board
// is written to /output/board.json, and this repository's dashboard/ and
// screenshots/ are copied to /output. Last, /output/dossier.json is written,
// the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page with no framework and no network. Its
// three files — index.html, app.css, app.js — read the data this program
// writes beside the page (/output/data.js), which holds the same board the
// page renders. The farm plan's text is rendered in the
// page from the row's priced inputs, with the same words lib/model.ts writes
// into board.json, so the page and the board always agree.
//
// When not running inside the grader's container, MAKEFUN_OUTPUT_DIR stands
// in for /output:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json

import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { fileURLToPath as urlToPath } from 'node:url';
import { assemblePayload, findBoardProblems, payloadScript, readSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = urlToPath(new URL('.', import.meta.url));

/** The dossier's caps: the text cap shapes the bytes, the rest only refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const DASH_LIMITS = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read a `--name value` or `--name=value` argument, or `fallback`. */
function option(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === `--${name}` && i + 1 < args.length) return args[i + 1]!;
    const prefix = `--${name}=`;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    i++;
  }
  return fallback;
}

/** Print a failure to stderr and exit with the given code. */
function fail(message: string, code: number): never {
  const line = `token radar: ${message}\n`;
  process.stderr.write(line);
  process.exit(code);
}

const inputArg = option('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : joinPath(inputArg, 'snapshot.json');
if (existsSync(snapshotPath) === false) {
  fail(
    `no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`,
    2,
  );
}
const outputDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = readSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, payload } = assemblePayload(snapshot);
const problems = findBoardProblems(board, snapshot);
if (problems.length > 0) {
  const lines = problems.map((p) => `  - ${p}`).join('\n');
  fail(`the model wrote a board the gate refuses:\n${lines}`, 1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(joinPath(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(joinPath(outputDir, 'data.js'), payloadScript(payload));

/**
 * Copy one directory's regular files into `to`, skipping dot-names, and
 * return the names copied. Subdirectories are not copied: the dashboard and
 * the screenshots are flat.
 */
function copyFlat(from: string, to: string): string[] {
  if (existsSync(from) === false) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile() === false) continue;
    const src = joinPath(from, entry.name);
    copyFileSync(src, joinPath(to, entry.name));
    names.push(entry.name);
  }
  return names;
}

const dashCopied = copyFlat(joinPath(repoRoot, 'dashboard'), joinPath(outputDir, 'dashboard'));
const shotCopied = copyFlat(joinPath(repoRoot, 'screenshots'), joinPath(outputDir, 'screenshots'));
if (shotCopied.length < 3) {
  const count = shotCopied.length;
  const word = count === 1 ? 'image' : 'images';
  fail(`screenshots/ holds ${count} ${word}: hand in 3, the board, a detail view and a filtered view`, 1);
}
for (const name of shotCopied) {
  if (SHOT_NAME.test(name) === false) {
    fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }
}

// The dossier is written last: it is built from this /output, so it always
// describes exactly what was handed in.
const dossier = buildDossier(outputDir, { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SHOT_LIMITS, dashboard: DASH_LIMITS });
writeFileSync(joinPath(outputDir, 'dossier.json'), dossier);

const v = payload.validation;
const summary = [
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored`,
  `token radar: leave-one-out held-out median error ${v.loo.model.median}x (p90 ${v.loo.model.p90}x) across ${v.loo.model.n} comps; category median ${v.loo.categoryMedian.median}x, global median ${v.loo.globalMedian.median}x; top-10 overlap ${v.loo.top10OverlapMedian}`,
  `token radar: walk-forward held-out median error ${v.walkForward.model.median}x (p90 ${v.walkForward.model.p90}x) across ${v.walkForward.test} tested, cutoff ${v.walkForward.cutoff}, Spearman ${v.walkForward.spearman}`,
  `token radar: wrote ${joinPath(outputDir, 'board.json')}, ${joinPath(outputDir, 'data.js')}, ${joinPath(outputDir, 'dashboard')} (${dashCopied.length} files), ${joinPath(outputDir, 'screenshots')} (${shotCopied.length} images) and ${joinPath(outputDir, 'dossier.json')}`,
];
process.stdout.write(summary.join('\n') + '\n');
