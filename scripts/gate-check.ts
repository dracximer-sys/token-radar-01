// Gate check: the seven rows the grader's gate checks, run locally against
// an output directory. Usage: node scripts/gate-check.ts out [input/snapshot.json]
// Exits 0 when every row passes, 1 otherwise, and prints each row's verdict.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '/home/hatch/workspace/token-radar/vendor/makefun-board.ts';

const out = process.argv[2] ?? 'out';
const snapshotFile = process.argv[3] ?? 'input/snapshot.json';
const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const inSnapshot = new Set<string>(snapshot.protocols.map((p: { slug: string }) => p.slug));
const board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
const rows: Array<Record<string, unknown>> = board.rows;

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures++;
}
function walk(dir: string, base: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = base === '' ? name : `${base}/${name}`;
    if (statSync(path).isDirectory()) walk(path, rel, acc);
    else acc.push(rel);
  }
  return acc;
}

// 1. dashboard_files
const dashDir = join(out, 'dashboard');
const dashFiles = existsSync(dashDir) ? walk(dashDir, '', []) : [];
const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(dashDir, f)).size, 0);
const badName = dashFiles.filter((f) => !/^[A-Za-z0-9._-]+$/.test(f) || f.length > 128 || f.startsWith('.') || f.startsWith('-') || f.includes('/.') || f.includes('..'));
const hasUrl = (text: string): boolean => /https?:\/\//.test(text);
let urlOffender = '';
for (const f of dashFiles) {
  if (hasUrl(readFileSync(join(dashDir, f), 'utf8'))) { urlOffender = f; break; }
}
check(
  'dashboard_files',
  dashFiles.includes('index.html') && dashFiles.some((f) => f.endsWith('.css')) && dashFiles.some((f) => f.endsWith('.js')) &&
    dashFiles.length <= 400 && dashBytes <= 4 * 1024 * 1024 && badName.length === 0 && urlOffender === '',
  `${dashFiles.length} files, ${dashBytes} bytes, bad names: ${badName.length}, url in: ${urlOffender || 'none'}`,
);

// 2. board_file
const boardBytes = statSync(join(out, 'board.json')).size;
const badRows = rows.filter((r) =>
  !inSnapshot.has(r.slug as string) || typeof r.name !== 'string' || (r.name as string).length === 0 ||
  !Number.isSafeInteger(r.rank) || (r.rank as number) <= 0 ||
  !Number.isSafeInteger(r.implied_value_usd) || (r.implied_value_usd as number) <= 0 ||
  (r.implied_value_usd as number) > 100_000_000_000_000 || !Array.isArray(r.farm_steps));
check(
  'board_file',
  rows.length >= 100 && rows.length <= 4000 && boardBytes <= 8 * 1024 * 1024 && badRows.length === 0,
  `${rows.length} rows, ${boardBytes} bytes, bad rows: ${badRows.length}`,
);

// 3. sorted_by_value
const ranks = rows.map((r) => r.rank as number).sort((a, b) => a - b);
const ranksOk = ranks.every((r, i) => r === i + 1);
const mono = rows.every((r, i) => i === 0 || (r.implied_value_usd as number) <= (rows[i - 1]!.implied_value_usd as number));
const notEqual = rows.length < 2 || rows[0]!.implied_value_usd !== rows[rows.length - 1]!.implied_value_usd;
check('sorted_by_value', ranksOk && mono && notEqual, `ranks 1..${rows.length} once each: ${ranksOk}, non-increasing: ${mono}, not all equal: ${notEqual}`);

// 4. coverage
const slugs = new Set(rows.map((r) => r.slug as string));
const missing = (snapshot.watchlist as string[]).filter((s) => !slugs.has(s));
check('coverage', missing.length === 0, `${snapshot.watchlist.length - missing.length}/${snapshot.watchlist.length} watchlist slugs present${missing.length ? `, missing: ${missing.slice(0, 5).join(', ')}` : ''}`);

// 5. farm_steps
const badSteps = rows.filter((r) => {
  const steps = r.farm_steps as string[];
  return steps.length < 3 || steps.length > 12 || steps.some((s) => s.trim().length < 20 || s.trim().length > 600);
});
check('farm_steps', badSteps.length === 0, `${rows.length} rows, bad step sets: ${badSteps.length}`);

// 6. screenshots
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const shotsDir = join(out, 'screenshots');
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => statSync(join(shotsDir, f)).isFile()) : [];
const shotProblems: string[] = [];
for (const f of shots) {
  const buf = readFileSync(join(shotsDir, f));
  if (buf.length > 512 * 1024) shotProblems.push(`${f} is ${buf.length} bytes`);
  const size = pngSize(buf);
  if (size === null) { shotProblems.push(`${f} is not a PNG this checker can read`); continue; }
  const long = Math.max(size.w, size.h);
  const short = Math.min(size.w, size.h);
  if (long > 1440) shotProblems.push(`${f} long side ${long} > 1440`);
  if (short < 800) shotProblems.push(`${f} short side ${short} < 800`);
}
check('screenshots', shots.length >= 3 && shots.length <= 4 && shotProblems.length === 0, `${shots.length} images: ${shots.join(', ')}${shotProblems.length ? ` — ${shotProblems.join('; ')}` : ''}`);

// 7. dossier_matches
const dossierPath = join(out, 'dossier.json');
const dossierBytes = statSync(dossierPath).size;
const rebuilt = Buffer.from(buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } })).toString('utf8');
const stored = readFileSync(dossierPath, 'utf8');
check('dossier_matches', stored === rebuilt && dossierBytes <= 1.5 * 1024 * 1024, `${dossierBytes} bytes, byte-identical to a fresh buildDossier: ${stored === rebuilt}`);

console.log(failures === 0 ? 'gate: ALL 7 ROWS PASS' : `gate: ${failures} ROW(S) FAIL`);
process.exit(failures === 0 ? 0 : 1);
