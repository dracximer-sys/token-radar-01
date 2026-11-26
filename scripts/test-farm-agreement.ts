// Farm-step agreement test: the page's farm-step renderer (dashboard/app.js)
// must produce byte-identical steps to board.json's, for every row. The
// renderer runs in a vm with a minimal DOM stub, because the page's own
// scripts and the test harness live in different realms in headless Firefox.
// Usage: node scripts/test-farm-agreement.ts out
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const out = process.argv[2] ?? 'out';
const board = JSON.parse(readFileSync(`${out}/board.json`, 'utf8'));
const dataSrc = readFileSync(`${out}/data.js`, 'utf8');
const appSrc = readFileSync('dashboard/app.js', 'utf8');

class FakeEl {
  children: unknown[] = [];
  textContent = '';
  className = '';
  style: Record<string, string> = {};
  value = '';
  checked = false;
  open = false;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: unknown): unknown { (this.children as unknown[]).push(c); return c; }
  removeChild(c: unknown): unknown {
    const i = (this.children as unknown[]).indexOf(c);
    if (i >= 0) (this.children as unknown[]).splice(i, 1);
    return c;
  }
  addEventListener(): void {}
  setAttribute(): void {}
  get firstChild(): unknown { return (this.children as unknown[])[0] ?? null; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  click(): void {}
}

const boardEl = new FakeEl('main');
const dialogEl = new FakeEl('dialog');
const sandbox: Record<string, unknown> = {
  window: undefined as unknown,
  document: {
    getElementById: (id: string) => (id === 'board' ? boardEl : id === 'detail' ? dialogEl : new FakeEl('div')),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => ({ textContent: t }),
  },
  URLSearchParams,
  Blob: class {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
};
sandbox.window = {
  location: { hash: '', pathname: '/dashboard/index.html', search: '' },
  history: { replaceState: () => {} },
  addEventListener: () => {},
};
const context = vm.createContext(sandbox);
vm.runInContext(dataSrc, context);
vm.runInContext(appSrc, context);
const farmSteps = (sandbox.window as Record<string, unknown>).__farmSteps as ((row: unknown) => string[]) | undefined;
if (typeof farmSteps !== 'function') {
  console.log('FAIL: app.js did not expose __farmSteps');
  process.exit(1);
}
const radar = (sandbox.window as Record<string, unknown>).RADAR as { rows: Array<Record<string, unknown>> };
const bySlug = new Map<string, { farm_steps: string[] }>(board.rows.map((r: { slug: string; farm_steps: string[] }) => [r.slug, r]));
let mismatches = 0;
for (const row of radar.rows) {
  const expected = bySlug.get(row.s as string);
  if (!expected) { console.log(`FAIL: ${row.s} has no board row`); mismatches++; continue; }
  const got = farmSteps(row);
  if (JSON.stringify(got) !== JSON.stringify(expected.farm_steps)) {
    mismatches++;
    if (mismatches <= 2) {
      console.log(`FAIL: ${row.s} steps differ`);
      console.log('  page :', JSON.stringify(got[1]).slice(0, 200));
      console.log('  board:', JSON.stringify(expected.farm_steps[1]).slice(0, 200));
    }
  }
}
console.log(mismatches === 0
  ? `PASS: page farm steps match board.json for all ${radar.rows.length} rows`
  : `FAIL: ${mismatches} of ${radar.rows.length} rows differ`);
process.exit(mismatches === 0 ? 0 : 1);
