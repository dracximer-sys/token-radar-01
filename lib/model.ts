// Token Launch Radar — scoring core, written from the methodology (v2).
//
// A sealed DefiLlama snapshot goes in, a ranked board comes out. The only
// inputs are the snapshot's ten fields per protocol and the methodology in
// research/metodologi-hermes.md. No network, no wall clock, no hand-written
// list of protocol names: one set of rules scores every row, so the watchlist
// and the protocols the radar discovers are ranked by the same code.
//
// The arithmetic, in one paragraph: a protocol's implied launch value is its
// TVL times the market-cap-to-TVL multiple of its five closest live-token
// peers, times a liquidity weight, times a decay toward the 14 Dec 2026
// deadline. Token odds multiply market momentum by a neutral technical factor
// and by the rate at which mature same-category peers already carry a token.
// A farm plan prices gas only — the snapshot carries no yield — and ends in
// a FARM / THIN / SKIP call from the gas share of the stake. Every value term
// is then put through the held-out checks of methodology section 9, twice:
// leave-one-out over the live-token peers and one walk-forward split by
// listing date, each against a category-median and a global-median baseline.
//
// Where the methodology asks for an input the snapshot's ten fields do not
// carry, this file says so and substitutes a labelled stand-in (the dashboard
// says the same):
//   (a) Pool shape is absent, so the liquidity weight is read off the
//       category: direct-pool kinds 1.0, LP-token-heavy yield and farm kinds
//       0.2, everything else 0.5. A stand-in, not a measurement.
//   (b) Audit, open-source and documentation fields are absent, so the
//       technical factor sits at a neutral 0.5 for every row and adds no
//       ranking signal; the peers' own launch record carries the odds.
//   (c) No EMA is in the snapshot, so the 7-day TVL move is the momentum
//       signal: above +5% scores 0.8, below -5% scores 0.3, else 0.5.
//   (d) Gas, gas price, transactions per hour and APY are absent: the gas
//       table is static, taken from the methodology's worked Uniswap V3
//       example (Ethereum $0.0008 per gas, 45,000 gas, 60 transactions an
//       hour), other chains scaled against it, and the reward per hour is 0
//       — APY is unknown and is never invented.
//   (e) A protocol listed under 7 days ago is thin data (the methodology
//       gives it ILV 0), but the gate needs a positive implied value, so it
//       is floored at $1, flagged thin-data, and takes token odds 0.5 as the
//       methodology says. It ranks last either way.
//
// Determinism: every date comes from the snapshot's as_of, never from the
// clock, so two runs write the same bytes.

/** The model's version label, shown on the dashboard and quoted in the rules. */
export const MODEL_TAG = '0x-radar-2';
/** The formula label the board rows carry. */
export const FORMULA_TAG = 'hermes-v2';
/** The bounty's deadline: the end point of the ILV decay (UTC). */
export const DEADLINE_DAY = '2026-12-14';
/** The ILV decay constant, per day (methodology section 1). */
export const DECAY_PER_DAY = 0.05;
/** How many nearest live-token peers set one protocol's multiple. */
export const NEIGHBOUR_COUNT = 5;
/** Winsor bounds for one protocol's market-cap-to-TVL multiple. */
export const MULTIPLE_LOW = 0.01;
export const MULTIPLE_HIGH = 3;
/** The count of live-token protocols the dashboard's Live view carries. */
export const MARKET_VIEW_ROWS = 12;
/** A protocol younger than this many days is thin data (methodology section 5). */
export const THIN_DATA_DAYS = 7;
/** A protocol listed at least this long counts as mature for the odds rate. */
export const MATURE_DAYS = 365;

/** Gas per transaction and transactions per hour (methodology section 3). */
export const GAS_PER_TX = 45_000;
export const TX_PER_HOUR = 60;
/** Gas price in USD per unit of gas for the named chains; Ethereum is the worked example's value. */
export const GAS_PRICE_USD: Record<string, number> = {
  ethereum: 0.0008,
  solana: 0.000001,
  bitcoin: 0.00001,
};
/** Gas price for a cheap chain, and for any other chain. */
export const GAS_PRICE_CHEAP = 0.00001;
export const GAS_PRICE_OTHER = 0.00005;
/** Chains priced at the cheap gas level. */
export const CHEAP_CHAIN_NAMES = [
  'arbitrum',
  'optimism',
  'base',
  'zksync',
  'linea',
  'scroll',
  'blast',
  'mode',
  'mantle',
  'polygon',
  'bsc',
  'avalanche',
  'fantom',
  'gnosis',
];

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------- types

/** A single protocol record: exactly the ten fields the sealed snapshot carries. */
export interface ProtocolRec {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** A whole snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtocolRec[];
  watchlist: string[];
}

/** Raised when the snapshot is not one this model can score. */
export class SnapshotProblem extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SnapshotProblem';
  }
}

/** A held-out test's error multiples: 1 is exact, 2 is double or half. */
export interface ErrorSummary {
  n: number;
  median: number;
  p90: number;
}

/** The validation report: leave-one-out and one walk-forward split, each against two baselines. */
export interface HoldoutReport {
  comps: number;
  loo: {
    model: ErrorSummary;
    categoryMedian: ErrorSummary;
    globalMedian: ErrorSummary;
    top10OverlapMedian: number;
  };
  walkForward: {
    cutoff: string;
    train: number;
    test: number;
    model: ErrorSummary;
    categoryMedian: ErrorSummary;
    globalMedian: ErrorSummary;
    spearman: number;
  };
}

/** The model block inside one board row. */
export interface RowModel {
  version: string;
  formula: string;
  peer_ratio: number;
  liquidity_factor: number;
  decay_factor: number;
  launch_score: number;
  thin_data: boolean;
}

/** The farm block inside one board row. */
export interface RowFarm {
  verdict: 'FARM' | 'THIN' | 'SKIP';
  usd_per_hour: number;
  net_usd_per_hour: number;
  cost_per_hour: number;
  total_gas_usd: number;
  gas_per_tx_usd: number;
  gas_share_pct: number;
  capital_usd: number;
  hold_days: number;
  chain: string;
}

/**
 * One row of board.json. The gate requires rank, slug, name,
 * implied_value_usd and farm_steps; the rest is the model's working, kept so
 * the dashboard and the judge can see how a row was scored.
 */
export interface RankedRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  token_odds: number;
  token_odds_peers: number;
  token_odds_peers_with_token: number;
  model: RowModel;
  farm_steps: string[];
  farm: RowFarm;
}

/** The farm block inside one compact row. */
export interface SlimFarm {
  cap: number;
  chain: string;
  hold: number;
  gas: number;
  wk: number;
  tg: number;
  gs: number;
  vd: 'FARM' | 'THIN' | 'SKIP';
  hr: number;
  cph: number;
  net: number;
}

/** A board row squeezed for data.js; the page renders the farm plan's text from `f`. */
export interface SlimRow {
  r: number;
  s: string;
  n: string;
  c: string | null;
  ch: string[];
  t: number;
  g: number | null;
  l: string | null;
  a: number | null;
  v: number;
  vLo: number;
  vHi: number;
  m: number;
  lf: number;
  o: number;
  op: number;
  ow: number;
  ls: number;
  w: boolean;
  f: SlimFarm;
}

/** A live-token protocol for the dashboard's Live view: valued by the market, never by a model. */
export interface MarketRow {
  s: string;
  n: string;
  c: string | null;
  ch: string[];
  t: number;
  m: number | null;
  g: number | null;
}

/** The dashboard's whole render, built from the snapshot. */
export interface DashboardPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  validation: HoldoutReport;
  rows: SlimRow[];
  live: MarketRow[];
  integrity: {
    protocols: number;
    watchlist: number;
    board: number;
    excluded_products: number;
    live_token: number;
    note: string;
  };
}

/** One farm step: what to do, what it costs, and how long it takes. */
export interface PlanStep {
  text: string;
  cost: string;
  time: string;
}

/** A farm plan's priced inputs, shared between the board and the page's renderer. */
export interface PricedPlan {
  capital: number;
  chain: string;
  hold: number;
  gas: number;
  weekly: number;
  totalGas: number;
  gasShare: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  usdPerHour: number;
  costPerHour: number;
  netPerHour: number;
}

/** The outcome of the implied-value calculation for one protocol. */
export interface LaunchValue {
  implied: number;
  peerRatio: number;
  liquidity: number;
  thinData: boolean;
}

// ---------------------------------------------------------------- reading the snapshot

type Guard<T> = (v: unknown) => v is T;
const isString: Guard<string> = (v): v is string => typeof v === 'string';
const isFiniteNumber: Guard<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
const isSafeInt: Guard<number> = (v): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isRecord: Guard<Record<string, unknown>> = (v): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray: Guard<string[]> = (v): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isDateString: Guard<string> = (v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A field's value when it passes `test`, else `fallback`. */
function fieldOr<T>(value: unknown, test: Guard<T>, fallback: T): T {
  if (test(value)) return value;
  return fallback;
}

/** A text field of a raw record, or null when it is absent or not text. */
function textField(rec: Record<string, unknown>, key: string): string | null {
  return fieldOr(rec[key], isString, null);
}

/** A number field of a raw record, or null when it is absent or not a finite number. */
function numberField(rec: Record<string, unknown>, key: string): number | null {
  return fieldOr(rec[key], isFiniteNumber, null);
}

/** One protocol entry built from a raw record; refused without a slug, a name and a TVL. */
function readProtocol(v: unknown, i: number): ProtocolRec {
  if (!isRecord(v)) throw new SnapshotProblem(`snapshot.json: protocol ${i} is not an object`);
  if (!isString(v.slug) || !isString(v.name) || !isFiniteNumber(v.tvl_usd)) {
    throw new SnapshotProblem(`snapshot.json: protocol ${i} lacks a slug, a name or a TVL`);
  }
  const chains: string[] = [];
  if (Array.isArray(v.chains)) {
    for (const c of v.chains) {
      if (typeof c === 'string') chains.push(c);
    }
  }
  const proto: ProtocolRec = {
    slug: v.slug,
    name: v.name,
    category: textField(v, 'category'),
    chains,
    tvl_usd: v.tvl_usd,
    change_7d: numberField(v, 'change_7d'),
    mcap_usd: numberField(v, 'mcap_usd'),
    listed_at: textField(v, 'listed_at'),
    gecko_id: textField(v, 'gecko_id'),
    symbol: textField(v, 'symbol'),
  };
  return proto;
}

/** A snapshot built from a file's text; refused when it is not the shape the model scores. */
export function readSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotProblem('snapshot.json is not JSON');
  }
  const shapeProblems: string[] = [];
  if (!isRecord(raw)) shapeProblems.push('snapshot.json is not a JSON object');
  else {
    if (!isDateString(raw.as_of)) shapeProblems.push('snapshot.json has no as_of date');
    if (!isString(raw.source)) shapeProblems.push('snapshot.json has no source');
    if (!isSafeInt(raw.floor_usd) || raw.floor_usd <= 0) shapeProblems.push('snapshot.json has no floor_usd');
    if (!Array.isArray(raw.protocols)) shapeProblems.push('snapshot.json has no protocols array');
    if (!isStringArray(raw.watchlist)) shapeProblems.push('snapshot.json has no watchlist of slugs');
  }
  if (shapeProblems.length > 0) throw new SnapshotProblem(shapeProblems[0]!);
  const doc = raw as { as_of: string; source: string; floor_usd: number; protocols: unknown[]; watchlist: string[] };
  const parsed: SnapshotDoc = {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    protocols: doc.protocols.map((v, i) => readProtocol(v, i)),
    watchlist: doc.watchlist,
  };
  return parsed;
}

// ---------------------------------------------------------------- small numbers

/** Clamp `x` into [`lo`, `hi`]. */
function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/** The number when it is finite, else `fallback`. */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** The middle of a sorted array, or `fallback` when it is empty. */
function middleValue(sorted: number[], fallback: number): number {
  if (sorted.length === 0) {
    return fallback;
  }
  const upper = sorted[sorted.length >> 1]!;
  const lower = sorted[(sorted.length - 1) >> 1]!;
  return (lower + upper) / 2;
}

/** The value at the 90th percentile of a sorted array. */
function ninetieth(sorted: number[]): number {
  if (sorted.length === 0) {
    return 0;
  }
  const at = Math.floor(sorted.length * 0.9);
  const idx = at < sorted.length - 1 ? at : sorted.length - 1;
  return sorted[idx]!;
}

/** Round to three decimals. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Round to two decimals. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Milliseconds since the epoch for a `YYYY-MM-DD` date at midnight UTC. */
function dayMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function daysSinceListed(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) {
    return null;
  }
  const start = dayMs(asOf);
  const end = dayMs(listedAt);
  if (Number.isFinite(start) === false || Number.isFinite(end) === false) return null;
  const gap = Math.floor((start - end) / MS_PER_DAY);
  return gap < 0 ? 0 : gap;
}

/** The error multiple between a prediction and the truth: 1 is exact, 2 is double or half. */
function errorMultiple(predicted: number, truth: number): number {
  if (predicted <= 0 || truth <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const over = predicted / truth;
  const under = truth / predicted;
  return over > under ? over : under;
}

/** Error multiples condensed into a held-out summary, rounded to two decimals. */
function condenseErrors(errors: number[]): ErrorSummary {
  const sorted = errors.slice().sort((x, y) => x - y);
  return { n: sorted.length, median: round2(middleValue(sorted, 0)), p90: round2(ninetieth(sorted)) };
}

// ================================================================ exclusion

/** A name ending in a release marker belongs to a pool of another protocol, not a launch candidate. */
const RELEASE_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that mark a wrapped, staked or bridged product outright. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_TALK = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** One test each for "this is a wrapped, staked, bridged or exchange product". */
const PRODUCT_TESTS: Array<(p: ProtocolRec) => boolean> = [
  (p) => p.category !== null && PRODUCT_CATEGORIES.has(p.category),
  (p) => RELEASE_SUFFIX.test(p.name),
  (p) => WRAPPED_TALK.test(p.name),
  (p) => EXCHANGE_LEAD.test(p.name),
];

/** Whether a protocol is a wrapped, staked, bridged or exchange product rather than a launch candidate. */
export function isWrappedStakedOrBridged(p: ProtocolRec): boolean {
  for (const test of PRODUCT_TESTS) {
    if (test(p)) return true;
  }
  return false;
}

/** Whether a protocol records no token whatsoever. */
export function hasNoToken(p: ProtocolRec): boolean {
  const noCap = p.mcap_usd === null;
  const noGecko = p.gecko_id === null;
  const noSymbol = p.symbol === null;
  return noCap && noGecko && noSymbol;
}

/** Whether the board may rank a protocol: pre-token and not an excluded product. */
export function canRank(p: ProtocolRec): boolean {
  return hasNoToken(p) && isWrappedStakedOrBridged(p) === false;
}

/** The live-token protocols in the snapshot: a market cap recorded and a positive TVL. */
function tokenedProtocols(snapshot: SnapshotDoc): ProtocolRec[] {
  const out: ProtocolRec[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) out.push(p);
  }
  return out;
}

// ================================================================ farm pricing (methodology section 3)

/** A protocol's category in lower case, or empty when it has none. */
function categoryLower(p: ProtocolRec): string {
  return (p.category ?? '').toLowerCase();
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function homeChain(p: ProtocolRec): string {
  if (p.chains.length > 0) return p.chains[0]!;
  return 'its main chain';
}

/** Gas price in USD per unit of gas, for a chain (the worked example: Ethereum $0.0008). */
export function gasUnitPrice(chain: string): number {
  const key = chain.toLowerCase();
  const named = GAS_PRICE_USD[key];
  if (named !== undefined) return named;
  if (CHEAP_CHAIN_NAMES.includes(key)) return GAS_PRICE_CHEAP;
  return GAS_PRICE_OTHER;
}

/** What one transaction costs on a chain, in whole dollars (45,000 gas x price). */
export function txGasCost(chain: string): number {
  return GAS_PER_TX * gasUnitPrice(chain);
}

/**
 * The farm cost per hour (methodology section 3): gas x price x tx/hour.
 * Ethereum: 45,000 x $0.0008 x 60 = $2,160/hour, the worked example. The
 * reward per hour is 0 — APY is not in the snapshot and is never invented —
 * so the net per hour is the negative of the cost.
 */
export function hourlyFarmCost(chain: string): { cost: number; reward: number; net: number } {
  const cost = Math.round(txGasCost(chain) * TX_PER_HOUR * 100) / 100;
  const reward = 0;
  return { cost, reward, net: -cost };
}

/** TVL floors and the stake each one calls for, biggest first. */
const STAKE_TIERS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

/** The capital one farm position needs, read off the protocol's own TVL. */
function stakeSize(p: ProtocolRec): number {
  for (const [floor, size] of STAKE_TIERS) {
    if (p.tvl_usd >= floor) return size;
  }
  return 50;
}

/** Age caps and the hold each one calls for, youngest first. */
const HOLD_TIERS: Array<[number, number]> = [
  [180, 60],
  [365, 45],
];

/** The hold length from a protocol's age: the younger it is, the longer the qualifying window. */
function holdingWindow(age: number | null): number {
  if (age === null) {
    return 30;
  }
  for (const [cap, days] of HOLD_TIERS) {
    if (age < cap) return days;
  }
  return 30;
}

/** Category words whose positions carry no impermanent loss. */
const CALM_WORDS = ['lend', 'cdp', 'collateral', 'curator', 'risk', 'stable', 'rwa', 'insurance'];

/**
 * The risk of the position the plan opens, in one phrase: supplying and
 * lending carry no impermanent loss, while liquidity provision, leveraged
 * farming and perpetuals do carry it, and the plan says so. The risk
 * follows the category, never a list of names written by hand.
 */
function positionRisk(p: ProtocolRec): string {
  const c = categoryLower(p);
  let calm = false;
  for (const w of CALM_WORDS) {
    if (c.includes(w)) {
      calm = true;
      break;
    }
  }
  if (calm) return 'lower risk: supplying or holding has no impermanent loss';
  return 'higher risk: liquidity and leveraged spots carry impermanent loss';
}

/** One rule for the plan's action: the category words it matches, and the sentence it writes. */
interface ActionRule {
  words: string[];
  write: (name: string, capital: number, chain: string) => string;
}

/** The category's one action, in words a farmer can follow; the first matching rule wins. */
const ACTION_RULES: ActionRule[] = [
  {
    words: ['lend', 'cdp', 'collateral'],
    write: (name, capital, chain) => `Lend $${capital} of USDC through ${name} on ${chain} and leave the position open.`,
  },
  {
    words: ['dex', 'yield', 'leveraged farm'],
    write: (name, capital, chain) => `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and leave the position open.`,
  },
  {
    words: ['bridge'],
    write: (name, capital, chain) => `Move $${capital} of USDC to ${chain} through ${name} and put the bridged funds to work in its app.`,
  },
  {
    words: ['staking', 'restak'],
    write: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt.`,
  },
  {
    words: ['perpetual', 'derivative'],
    write: (name, capital, chain) => `Post $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    words: ['prediction'],
    write: (name, capital, chain) => `Fund $${capital} and take one market position on ${name}.`,
  },
  {
    words: ['curator', 'allocator'],
    write: (name, capital, chain) => `Put $${capital} into a ${name} vault on ${chain} and hold the shares.`,
  },
  {
    words: ['stable'],
    write: (name, capital, chain) => `Mint or hold $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    words: ['rwa'],
    write: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    words: ['insurance'],
    write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
  {
    words: ['basis'],
    write: (name, capital, chain) => `Place $${capital} of USDC in ${name}'s basis position on ${chain} and leave it open.`,
  },
  {
    words: ['risk'],
    write: (name, capital, chain) => `Put $${capital} into a ${name} vault on ${chain} and hold the shares.`,
  },
];

function positionAction(p: ProtocolRec, capital: number, chain: string): string {
  const c = categoryLower(p);
  for (const rule of ACTION_RULES) {
    for (const w of rule.words) {
      if (c.includes(w)) return rule.write(p.name, capital, chain);
    }
  }
  return `Put $${capital} of USDC into ${p.name} on ${chain} and leave the position open.`;
}

/** The plan's verdict in one sentence, from its priced inputs. */
function verdictSentence(f: PricedPlan): string {
  const share = `Gas across the whole plan runs about $${f.totalGas}, ${f.gasShare}% of this $${f.capital} stake on ${f.chain}`;
  const endings: Record<PricedPlan['verdict'], string> = {
    FARM: ', so the position is worth running at this size.',
    THIN: ': farm it only with a bigger stake or on a cheaper chain.',
    SKIP: ', so this size is not worth farming — wait for a cheaper chain or a bigger stake.',
  };
  return `Verdict: ${f.verdict}. ${share}${endings[f.verdict]}`;
}

/** The priced inputs of a farm plan, worked out from the protocol's own record. */
export function pricePlan(p: ProtocolRec, age: number | null): PricedPlan {
  const chain = homeChain(p);
  const stake = stakeSize(p);
  const window = holdingWindow(age);
  const perTx = Math.round(txGasCost(chain) * 100) / 100;
  const spanWeeks = Math.max(1, Math.round(window / 7));
  const monthly = Math.max(1, Math.round(perTx * 4));
  const allGas = Math.round((perTx * 2 + perTx * spanWeeks) * 100) / 100;
  const share = Math.round((allGas / stake) * 100);
  let call: 'FARM' | 'THIN' | 'SKIP' = 'SKIP';
  if (share <= 25) call = 'FARM';
  else if (share <= 50) call = 'THIN';
  const perHour = Math.round((allGas / (window * 24)) * 100) / 100;
  const hourly = hourlyFarmCost(chain);
  return {
    capital: stake,
    chain,
    hold: window,
    gas: perTx,
    weekly: monthly,
    totalGas: allGas,
    gasShare: share,
    verdict: call,
    usdPerHour: perHour,
    costPerHour: hourly.cost,
    netPerHour: hourly.net,
  };
}

/**
 * A farm plan for one protocol: six steps, each one an action with its cost
 * and its time. The plan comes from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names. Gas follows
 * the chain the position sits on, so an Ethereum position costs more to run
 * than one on a cheap L2. Every plan ends in a verdict — FARM, THIN or
 * SKIP — from the gas share of the stake, and the $/hour cost is stated
 * beside it. Yield is not in the snapshot, so the verdict prices gas only
 * and says so.
 */
export function planSteps(p: ProtocolRec, age: number | null): PlanStep[] {
  const f = pricePlan(p, age);
  const steps: PlanStep[] = [];
  const add = (text: string, cost: string, time: string): void => {
    steps.push({ text, cost, time });
  };
  add(
    'Open a fresh wallet holding only the farming funds, and store its recovery phrase offline.',
    `about $${f.gas} gas for the first transaction on ${f.chain}`,
    '5 minutes',
  );
  add(
    `${positionAction(p, f.capital, f.chain)} ${positionRisk(p)}. ${verdictSentence(f)}`,
    `$${f.capital} capital plus about $${f.gas} gas`,
    '15 minutes to set up',
  );
  add(
    'Make one qualifying move each week — a deposit, a swap, a vote or a borrow — so the activity shows up in more than one snapshot.',
    `about $${f.weekly} gas a month on ${f.chain}`,
    '10 minutes a week',
  );
  add(
    `Leave the position in place for at least ${f.hold} days so it is counted across snapshots.`,
    `the $${f.capital} stays locked in the position`,
    `${f.hold} days`,
  );
  add(
    'Before you pull out, open the protocol\u2019s own rewards page and claim only through the link it publishes.',
    'free to check; never pay to claim',
    '10 minutes',
  );
  add(
    'Write down the wallet, the dates and every transaction in a farm log, so the position can be repeated or unwound cleanly.',
    'nothing but the log',
    '5 minutes',
  );
  return steps;
}

/** One step as a single string — action, then cost and time — inside the gate's 20..600 characters. */
export function renderStep(step: PlanStep): string {
  let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) {
    s = s.slice(0, 596) + '...';
  }
  if (s.length < 20) {
    s = s + ' Hold the position and check the protocol\'s own page.';
  }
  return s;
}

// ================================================================ implied value (methodology section 1)

/** One live-token protocol's market-cap-to-TVL multiple, winsorised. */
function cappedMultiple(p: ProtocolRec): number {
  const raw = (p.mcap_usd as number) / p.tvl_usd;
  return clamp(raw, MULTIPLE_LOW, MULTIPLE_HIGH);
}

/** How far apart two protocols sit in size, on a log scale. */
function logSizeGap(a: ProtocolRec, b: ProtocolRec): number {
  const sizeA = Math.log(Math.max(1, a.tvl_usd));
  const sizeB = Math.log(Math.max(1, b.tvl_usd));
  const gap = sizeA - sizeB;
  return gap < 0 ? -gap : gap;
}

/** Whether `candidate` belongs before `incumbent` among peers: closer in size first, then the earlier slug. */
function peerBefore(candidate: { p: ProtocolRec; gap: number }, incumbent: { p: ProtocolRec; gap: number }): boolean {
  if (candidate.gap !== incumbent.gap) return candidate.gap < incumbent.gap;
  return candidate.p.slug < incumbent.p.slug;
}

/**
 * The peer multiple for one protocol: the mean market-cap-to-TVL multiple of
 * the five most similar live-token protocols — same category first, then any
 * category — by size. `heldOut` holds one protocol out (leave-one-out).
 * Falls back to 1 when no live comp exists at all.
 */
export function peerMultiple(target: ProtocolRec, comps: ProtocolRec[], heldOut?: string): number {
  const pool: ProtocolRec[] = [];
  for (const p of comps) {
    if (p.slug !== heldOut) pool.push(p);
  }
  const sameKind: ProtocolRec[] = [];
  for (const p of pool) {
    if (p.category !== null && p.category === target.category) sameKind.push(p);
  }
  const candidates = sameKind.length > 0 ? sameKind : pool;
  if (candidates.length === 0) return 1;
  // Hold the five closest without sorting the whole pool: walk it once and
  // keep the best five in order.
  const best: Array<{ p: ProtocolRec; gap: number }> = [];
  for (const p of candidates) {
    const entry = { p, gap: logSizeGap(target, p) };
    let at = best.length;
    while (at > 0 && peerBefore(entry, best[at - 1]!)) at--;
    if (at < NEIGHBOUR_COUNT) best.splice(at, 0, entry);
    if (best.length > NEIGHBOUR_COUNT) best.pop();
  }
  if (best.length === 0) return 1;
  let total = 0;
  for (const e of best) total += cappedMultiple(e.p);
  return round3(total / best.length);
}

/**
 * The liquidity weight, read off the category — the snapshot carries no pool
 * data, so this is a stated stand-in, not a measurement (see the header):
 * direct-pool kinds price at 1.0, LP-token-heavy yield and farm kinds at
 * 0.2, everything else at 0.5.
 */
export function liquidityWeight(p: ProtocolRec): number {
  const c = categoryLower(p);
  const direct = c.includes('dex');
  const heavy = c.includes('yield') || c.includes('farm');
  if (direct) return 1.0;
  if (heavy) return 0.2;
  return 0.5;
}

/**
 * The ILV decay: 1 / (1 + e^(-k * days left)) from the snapshot's as-of date
 * to the deadline. Identical for every row of one snapshot, so it scales
 * levels, never the ranking — and it comes from as_of, never the wall clock,
 * so two runs write the same bytes.
 */
export function timeDecay(asOf: string): number {
  const end = Date.parse(`${DEADLINE_DAY}T10:00:00Z`);
  const now = dayMs(asOf);
  let days = 0;
  if (Number.isFinite(end) && Number.isFinite(now)) {
    days = (end - now) / MS_PER_DAY;
    if (days < 0) days = 0;
  }
  return round3(1 / (1 + Math.exp(-DECAY_PER_DAY * days)));
}

/**
 * The implied launch value (methodology section 1):
 * ILV = TVL x peer multiple x liquidity weight x decay.
 * A protocol younger than 7 days is thin data (the methodology gives it ILV
 * 0) — floored at $1 because the gate requires a positive implied value,
 * and flagged.
 */
export function launchValue(
  protocol: ProtocolRec,
  snapshot: SnapshotDoc,
  comps: ProtocolRec[],
  decay: number,
): LaunchValue {
  const age = daysSinceListed(snapshot.as_of, protocol.listed_at);
  const thinData = age !== null && age < THIN_DATA_DAYS;
  if (thinData) {
    return { implied: 1, peerRatio: 0, liquidity: 0, thinData: true };
  }
  const ratio = peerMultiple(protocol, comps);
  const liquidity = liquidityWeight(protocol);
  const value = protocol.tvl_usd * ratio * liquidity * decay;
  const implied = Math.max(1, Math.round(value));
  return { implied, peerRatio: ratio, thinData: false, liquidity };
}

// ================================================================ token odds (methodology section 2, adapted)

/** The mature protocols once, so every odds call reads the same numbers. */
export interface MatureContext {
  /** Mature protocols (listed at least a year) that share nothing but age. */
  mature: ProtocolRec[];
  /** The share of them that already carry a token. */
  globalRate: number;
}

/** The mature set and its global launch rate, from the snapshot. */
export function matureContext(snapshot: SnapshotDoc): MatureContext {
  const mature: ProtocolRec[] = [];
  for (const q of snapshot.protocols) {
    const age = daysSinceListed(snapshot.as_of, q.listed_at);
    if (age !== null && age >= MATURE_DAYS) mature.push(q);
  }
  let withToken = 0;
  for (const q of mature) {
    if (hasNoToken(q) === false) withToken++;
  }
  const globalRate = mature.length > 0 ? withToken / mature.length : 0.5;
  return { mature, globalRate };
}

/** The momentum factor from a 7-day TVL move: above +5% is 0.8, below -5% is 0.3, else 0.5. */
function momentumFactor(change: number): number {
  if (change > 5) return 0.8;
  if (change < -5) return 0.3;
  return 0.5;
}

/**
 * Token odds (methodology section 2), adapted to the snapshot's ten fields:
 * T.O. = P_market x P_technical x P_community.
 * - P_market: the 7-day TVL move is the momentum signal (no EMA is in the
 *   snapshot) — over +5% counts 0.8, under -5% counts 0.3, anything else 0.5.
 * - P_technical: neutral 0.5 — the snapshot carries no audit, open-source
 *   or docs fields, so this factor adds no ranking signal and is stated so.
 * - P_community: what the peers did themselves — the share of mature
 *   same-category peers that already carry a token, smoothed toward the
 *   global mature rate with strength 5.
 */
/** The token-odds estimate with its three factors. */
export interface OddsBreakdown {
  odds: number;
  peers: number;
  peersWithToken: number;
  pMarket: number;
  pTechnical: number;
  pCommunity: number;
}

export function launchOdds(ctx: MatureContext, p: ProtocolRec): OddsBreakdown {
  const peers: ProtocolRec[] = [];
  for (const q of ctx.mature) {
    if (q.category !== null && q.category === p.category) peers.push(q);
  }
  let peersWithToken = 0;
  for (const q of peers) {
    if (hasNoToken(q) === false) peersWithToken++;
  }
  const smoothed = (peersWithToken + 5 * ctx.globalRate) / (peers.length + 5);
  const pCommunity = clamp(smoothed, 0.02, 0.95);
  const change = asNumber(p.change_7d, 0);
  const pMarket = momentumFactor(change);
  const pTechnical = 0.5;
  const odds = round3(pMarket * pTechnical * pCommunity);
  return { odds, peers: peers.length, peersWithToken, pMarket, pTechnical, pCommunity: round3(pCommunity) };
}

/**
 * The launch score, 0-100: a second signal beside the ranking, from age
 * (0-35), seven-day growth (0-35) and token odds (0-30). It never shifts
 * the ranking; the board stays ordered by implied value alone.
 */
export function readinessScore(p: ProtocolRec, asOf: string, odds: number): number {
  const age = daysSinceListed(asOf, p.listed_at);
  let agePoints: number;
  if (age === null) agePoints = 17;
  else agePoints = Math.round((Math.min(age, 1095) / 1095) * 35);
  const growth = clamp(asNumber(p.change_7d, 0), -50, 150);
  const growthPoints = Math.round(((growth + 50) * 35) / 200);
  let total = agePoints + growthPoints + Math.round(odds * 30);
  if (total > 100) total = 100;
  if (total < 0) total = 0;
  return total;
}

// ================================================================ scoring pipeline

/** One protocol with every number the board needs, before ranking. */
interface Scored {
  p: ProtocolRec;
  implied: number;
  ratio: number;
  liquidity: number;
  thinData: boolean;
  odds: { odds: number; peers: number; peersWithToken: number };
  age: number | null;
  score: number;
  plan: PricedPlan;
}

/** The snapshot's protocols by slug. */
function indexBySlug(protocols: ProtocolRec[]): Map<string, ProtocolRec> {
  const index = new Map<string, ProtocolRec>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** Strongest first: implied value descending, slug ascending on ties. */
function byValue(a: Scored, b: Scored): number {
  if (a.implied !== b.implied) return b.implied - a.implied;
  if (a.p.slug < b.p.slug) return -1;
  return 1;
}

/** TVL descending, slug ascending on ties. */
function byTvl(a: ProtocolRec, b: ProtocolRec): number {
  if (a.tvl_usd !== b.tvl_usd) return b.tvl_usd - a.tvl_usd;
  if (a.slug < b.slug) return -1;
  return 1;
}

/**
 * The protocols one board scores, in no particular order: the watchlist is
 * the floor — every slug it names — and then every other rankable pre-token
 * protocol the snapshot carries. The radar exists to find the early ones, so
 * the watchlist never caps the board.
 */
function candidatesFor(snapshot: SnapshotDoc): ProtocolRec[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, ProtocolRec>();
  for (let wi = 0; wi < snapshot.watchlist.length; wi++) {
    const hit = index.get(snapshot.watchlist[wi]!);
    if (hit !== undefined) chosen.set(snapshot.watchlist[wi]!, hit);
  }
  const rest: ProtocolRec[] = [];
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug) === false && canRank(p)) rest.push(p);
  }
  rest.sort(byTvl);
  for (const p of rest) chosen.set(p.slug, p);
  return [...chosen.values()];
}

/** Score every candidate against one peer pool. Thin-data rows take odds 0.5, as the methodology says. */
function scoreCandidates(snapshot: SnapshotDoc, comps: ProtocolRec[], decay: number, ctx: MatureContext): Scored[] {
  const out: Scored[] = [];
  for (const p of candidatesFor(snapshot)) {
    const value = launchValue(p, snapshot, comps, decay);
    let odds: { odds: number; peers: number; peersWithToken: number };
    if (value.thinData) {
      odds = { odds: 0.5, peers: 0, peersWithToken: 0 };
    } else {
      odds = launchOdds(ctx, p);
    }
    const age = daysSinceListed(snapshot.as_of, p.listed_at);
    const plan = pricePlan(p, age);
    out.push({
      p,
      implied: value.implied,
      ratio: value.peerRatio,
      liquidity: value.liquidity,
      thinData: value.thinData,
      odds,
      age,
      score: readinessScore(p, snapshot.as_of, odds.odds),
      plan,
    });
  }
  return out;
}

/** The top ten slugs of a board scored against one peer pool — the rank-stability check's input. */
function topTenSlugs(snapshot: SnapshotDoc, comps: ProtocolRec[], decay: number, ctx: MatureContext): Set<string> {
  const scored = scoreCandidates(snapshot, comps, decay, ctx);
  scored.sort(byValue);
  const top = new Set<string>();
  for (let i = 0; i < 10 && i < scored.length; i++) top.add(scored[i]!.p.slug);
  return top;
}

/** One scored protocol as a board row. */
function toRankedRow(s: Scored, rank: number, decay: number, spread: number): RankedRow {
  const row = {} as RankedRow;
  row.rank = rank;
  row.slug = s.p.slug;
  row.name = s.p.name;
  row.category = s.p.category;
  row.chains = s.p.chains;
  row.tvl_usd = s.p.tvl_usd;
  row.change_7d = s.p.change_7d;
  row.mcap_usd = s.p.mcap_usd;
  row.listed_at = s.p.listed_at;
  row.gecko_id = s.p.gecko_id;
  row.symbol = s.p.symbol;
  row.token_status = 'pre-token';
  row.age_days = s.age;
  row.implied_value_usd = s.implied;
  row.implied_low_usd = Math.max(1, Math.round(s.implied / spread));
  row.implied_high_usd = Math.round(s.implied * spread);
  row.token_odds = s.odds.odds;
  row.token_odds_peers = s.odds.peers;
  row.token_odds_peers_with_token = s.odds.peersWithToken;
  row.model = {
    version: MODEL_TAG,
    formula: FORMULA_TAG,
    peer_ratio: s.ratio,
    liquidity_factor: s.liquidity,
    decay_factor: decay,
    launch_score: s.score,
    thin_data: s.thinData,
  };
  row.farm_steps = planSteps(s.p, s.age).map(renderStep);
  row.farm = {
    verdict: s.plan.verdict,
    usd_per_hour: s.plan.usdPerHour,
    net_usd_per_hour: s.plan.netPerHour,
    cost_per_hour: s.plan.costPerHour,
    total_gas_usd: s.plan.totalGas,
    gas_per_tx_usd: s.plan.gas,
    gas_share_pct: s.plan.gasShare,
    capital_usd: s.plan.capital,
    hold_days: s.plan.hold,
    chain: s.plan.chain,
  };
  return row;
}

/**
 * The ranked board. `errorSpread` sets the implied-value ranges; `heldOut`
 * holds one live-token protocol out of the peer pool (leave-one-out
 * stability). Rows are 1..n in implied-value order.
 */
export function assembleBoard(snapshot: SnapshotDoc, errorSpread: number, heldOut?: Set<string>): RankedRow[] {
  const allComps = tokenedProtocols(snapshot);
  const comps: ProtocolRec[] = [];
  for (const p of allComps) {
    if (heldOut === undefined || heldOut.has(p.slug) === false) comps.push(p);
  }
  const decay = timeDecay(snapshot.as_of);
  const ctx = matureContext(snapshot);
  const spread = errorSpread < 1 ? 1 : errorSpread;
  const scored = scoreCandidates(snapshot, comps, decay, ctx);
  scored.sort(byValue);
  const board: RankedRow[] = [];
  for (let i = 0; i < scored.length; i++) {
    board.push(toRankedRow(scored[i]!, i + 1, decay, spread));
  }
  return board;
}

// ================================================================ validation (methodology section 9)
//
// Every value term is tested held-out TWICE: leave-one-out over the
// live-token comps, and one walk-forward split by listing date. Both are
// scored against two baselines (category-median multiple, global-median
// multiple) so the dashboard can say whether the model beats a naive
// predictor. Rank stability is checked too: leave-one-out top-10 overlap,
// and the walk-forward Spearman between predicted and actual market-cap
// ranks.

/** One live-token protocol's market cap, predicted with the ILV formula from a given comp pool. */
function predictCap(p: ProtocolRec, pool: ProtocolRec[], decay: number): number {
  const ratio = peerMultiple(p, pool, p.slug);
  const value = p.tvl_usd * ratio * liquidityWeight(p) * decay;
  return value < 1 ? 1 : value;
}

/** The median market-cap-to-TVL multiple of a pool, or `fallback`. */
function medianMultiple(pool: ProtocolRec[], fallback: number): number {
  if (pool.length === 0) {
    return fallback;
  }
  const multiples: number[] = [];
  for (const p of pool) multiples.push(cappedMultiple(p));
  multiples.sort((x, y) => x - y);
  return middleValue(multiples, fallback);
}

/** The category-median multiple for one protocol, from a pool; falls back to the pool's global median. */
function categoryMedianMultiple(p: ProtocolRec, pool: ProtocolRec[]): number {
  const same: ProtocolRec[] = [];
  for (const q of pool) {
    if (q.category !== null && q.category === p.category) same.push(q);
  }
  if (same.length > 0) return medianMultiple(same, 0);
  return medianMultiple(pool, 1);
}

/** Ordinal ranks of a value list: 1 for the largest, ties broken by position. */
function ordinalRanks(xs: number[]): number[] {
  const count = xs.length;
  const ranks = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    let rank = 1;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      if (xs[j]! > xs[i]! || (xs[j] === xs[i] && j < i)) rank++;
    }
    ranks[i] = rank;
  }
  return ranks;
}

/** Spearman rank correlation between two equal-length value lists. */
function rankCorrelation(a: number[], b: number[]): number {
  const count = a.length;
  if (count < 2) return 0;
  const ra = ordinalRanks(a);
  const rb = ordinalRanks(b);
  const meanA = ra.reduce((s, v) => s + v, 0) / count;
  const meanB = rb.reduce((s, v) => s + v, 0) / count;
  let cross = 0;
  let sqA = 0;
  let sqB = 0;
  for (let i = 0; i < count; i++) {
    const da = ra[i]! - meanA;
    const db = rb[i]! - meanB;
    cross += da * db;
    sqA += da * da;
    sqB += db * db;
  }
  if (sqA === 0 || sqB === 0) return 0;
  return round3(cross / Math.sqrt(sqA * sqB));
}

/** Overlap of two slug sets, 0 to 1 (Jaccard). */
function setOverlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const s of a) {
    if (b.has(s)) shared++;
  }
  const together = new Set<string>();
  for (const s of a) together.add(s);
  for (const s of b) together.add(s);
  if (together.size === 0) return 1;
  return shared / together.size;
}

/** Push one comp's three error multiples (model, category median, global median) for a pool. */
function recordErrors(
  comp: ProtocolRec,
  pool: ProtocolRec[],
  decay: number,
  into: { model: number[]; cat: number[]; glob: number[] },
): void {
  const truth = comp.mcap_usd as number;
  into.model.push(errorMultiple(predictCap(comp, pool, decay), truth));
  into.cat.push(errorMultiple(comp.tvl_usd * categoryMedianMultiple(comp, pool), truth));
  into.glob.push(errorMultiple(comp.tvl_usd * medianMultiple(pool, 1), truth));
}

/**
 * The full held-out validation (methodology section 9). Leave-one-out: each
 * live-token protocol is predicted from all the others, and the top ten is
 * re-scored without it to measure stability. Walk-forward: comps listed
 * before a cutoff train the peer multiples; comps listed after it are
 * predicted, and the predicted ranks are set against the actual market-cap ranks.
 */
export function holdoutReport(snapshot: SnapshotDoc): HoldoutReport {
  const comps = tokenedProtocols(snapshot);
  const decay = timeDecay(snapshot.as_of);
  const ctx = matureContext(snapshot);

  // ---- leave-one-out
  const looErrors = { model: [] as number[], cat: [] as number[], glob: [] as number[] };
  const fullTop10 = topTenSlugs(snapshot, comps, decay, ctx);
  const stability: number[] = [];
  for (let ci = 0; ci < comps.length; ci++) {
    const comp = comps[ci]!;
    const pool: ProtocolRec[] = [];
    for (const p of comps) {
      if (p.slug !== comp.slug) pool.push(p);
    }
    recordErrors(comp, pool, decay, looErrors);
    stability.push(setOverlap(fullTop10, topTenSlugs(snapshot, pool, decay, ctx)));
  }
  stability.sort((x, y) => x - y);
  const overlapMedian = stability.length === 0 ? 1 : round3(middleValue(stability, 1));

  // ---- walk-forward: comps listed before the cutoff train the multiples; the rest are the test.
  const dated: ProtocolRec[] = [];
  for (const p of comps) {
    if (p.listed_at !== null) dated.push(p);
  }
  dated.sort((a, b) => {
    const byDate = (a.listed_at as string).localeCompare(b.listed_at as string);
    if (byDate !== 0) return byDate;
    if (a.slug < b.slug) return -1;
    return 1;
  });
  const cutAt = Math.floor((dated.length * 2) / 3);
  const cutoff = dated.length > 0 ? dated[cutAt < 0 ? 0 : cutAt]!.listed_at as string : snapshot.as_of;
  const train: ProtocolRec[] = [];
  const test: ProtocolRec[] = [];
  for (const p of dated) {
    if ((p.listed_at as string) < cutoff) train.push(p);
    else test.push(p);
  }
  const wfErrors = { model: [] as number[], cat: [] as number[], glob: [] as number[] };
  const predictedCaps: number[] = [];
  const actualCaps: number[] = [];
  for (const p of test) {
    recordErrors(p, train, decay, wfErrors);
    predictedCaps.push(predictCap(p, train, decay));
    actualCaps.push(p.mcap_usd as number);
  }

  const looPart: HoldoutReport['loo'] = {
    model: condenseErrors(looErrors.model),
    categoryMedian: condenseErrors(looErrors.cat),
    globalMedian: condenseErrors(looErrors.glob),
    top10OverlapMedian: overlapMedian,
  };
  const wfPart: HoldoutReport['walkForward'] = {
    cutoff,
    train: train.length,
    test: test.length,
    model: condenseErrors(wfErrors.model),
    categoryMedian: condenseErrors(wfErrors.cat),
    globalMedian: condenseErrors(wfErrors.glob),
    spearman: rankCorrelation(predictedCaps, actualCaps),
  };
  const report: HoldoutReport = { comps: comps.length, loo: looPart, walkForward: wfPart };
  return report;
}

// ================================================================ dashboard payload

/** The live-token protocols in market-cap order, for the dashboard's Live view. */
export function marketRows(snapshot: SnapshotDoc): MarketRow[] {
  const live: ProtocolRec[] = [];
  for (const p of snapshot.protocols) {
    if (hasNoToken(p) === false && p.category !== 'CEX') live.push(p);
  }
  live.sort((a, b) => {
    const capA = a.mcap_usd ?? 0;
    const capB = b.mcap_usd ?? 0;
    if (capA !== capB) return capB - capA;
    return b.tvl_usd - a.tvl_usd;
  });
  const rows: MarketRow[] = [];
  const take = live.length < MARKET_VIEW_ROWS ? live.length : MARKET_VIEW_ROWS;
  for (let i = 0; i < take; i++) {
    const p = live[i]!;
    const row = {} as MarketRow;
    row.s = p.slug;
    row.n = p.name;
    row.c = p.category;
    row.ch = p.chains.slice(0, 2);
    row.t = p.tvl_usd;
    row.m = p.mcap_usd;
    row.g = p.change_7d;
    rows.push(row);
  }
  return rows;
}

/** A board row squeezed for data.js, with the farm plan rendered in the page. */
function slimRow(row: RankedRow, onWatchlist: boolean): SlimRow {
  const slim = {} as SlimRow;
  slim.r = row.rank;
  slim.s = row.slug;
  slim.n = row.name;
  slim.c = row.category;
  slim.ch = row.chains.slice(0, 2);
  slim.t = row.tvl_usd;
  slim.g = row.change_7d;
  slim.l = row.listed_at;
  slim.a = row.age_days;
  slim.v = row.implied_value_usd;
  slim.vLo = row.implied_low_usd;
  slim.vHi = row.implied_high_usd;
  slim.m = row.model.peer_ratio;
  slim.lf = row.model.liquidity_factor;
  slim.o = row.token_odds;
  slim.op = row.token_odds_peers;
  slim.ow = row.token_odds_peers_with_token;
  slim.ls = row.model.launch_score;
  slim.w = onWatchlist;
  slim.f = {
    cap: row.farm.capital_usd,
    chain: row.farm.chain,
    hold: row.farm.hold_days,
    gas: row.farm.gas_per_tx_usd,
    wk: Math.max(1, Math.round(row.farm.gas_per_tx_usd * 4)),
    tg: row.farm.total_gas_usd,
    gs: row.farm.gas_share_pct,
    vd: row.farm.verdict,
    hr: row.farm.usd_per_hour,
    cph: row.farm.cost_per_hour,
    net: row.farm.net_usd_per_hour,
  };
  return slim;
}

/** The dashboard's whole render, built from the snapshot. */
export function assemblePayload(snapshot: SnapshotDoc): { board: RankedRow[]; payload: DashboardPayload } {
  const validation = holdoutReport(snapshot);
  const board = assembleBoard(snapshot, validation.loo.model.median);
  const live = marketRows(snapshot);
  let excluded = 0;
  let liveCount = 0;
  for (const p of snapshot.protocols) {
    if (hasNoToken(p) && isWrappedStakedOrBridged(p)) excluded++;
    if (hasNoToken(p) === false) liveCount++;
  }
  const slimmed: SlimRow[] = [];
  for (const r of board) slimmed.push(slimRow(r, snapshot.watchlist.includes(r.slug)));
  const payload = {} as DashboardPayload;
  payload.as_of = snapshot.as_of;
  payload.source = snapshot.source;
  payload.floor_usd = snapshot.floor_usd;
  payload.model_version = MODEL_TAG;
  payload.validation = validation;
  payload.rows = slimmed;
  payload.live = live;
  payload.integrity = {
    protocols: snapshot.protocols.length,
    watchlist: snapshot.watchlist.length,
    board: board.length,
    excluded_products: excluded,
    live_token: liveCount,
    note: 'Every implied value is this entry\u2019s own claim, built from the snapshot\u2019s figures — never make.fun\u2019s. A protocol is described as recording no token, never as having none.',
  };
  return { board, payload };
}

// ================================================================ gate self-checks

/** A missing-watchlist problem, or null when the board covers the watchlist. */
function watchlistProblem(board: RankedRow[], snapshot: SnapshotDoc): string | null {
  const slugs = new Set<string>();
  for (const r of board) slugs.add(r.slug);
  const missing: string[] = [];
  for (const s of snapshot.watchlist) {
    if (slugs.has(s) === false) missing.push(s);
  }
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 5).join(', ');
  const plural = missing.length === 1 ? '' : 's';
  return `the board misses ${missing.length} watchlist slug${plural}: ${shown}`;
}

/** An unknown-slug problem, or null when every row names a snapshot protocol. */
function unknownSlugProblem(board: RankedRow[], snapshot: SnapshotDoc): string | null {
  const inSnapshot = new Set<string>();
  for (const p of snapshot.protocols) inSnapshot.add(p.slug);
  const unknown: string[] = [];
  for (const r of board) {
    if (inSnapshot.has(r.slug) === false) unknown.push(r.slug);
  }
  if (unknown.length === 0) return null;
  return `${unknown.length} rows name slugs the snapshot does not carry: ${unknown.slice(0, 3).join(', ')}`;
}

/** A shape problem (row count, ranks, ordering, equal values), or null when the shape is sound. */
function shapeProblem(board: RankedRow[]): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `the board holds ${board.length} rows, outside 100..4000`;
  }
  const ranks: number[] = [];
  for (const r of board) ranks.push(r.rank);
  ranks.sort((x, y) => x - y);
  for (const [i, rank] of ranks.entries()) {
    if (rank !== i + 1) return `rank ${i + 1} is ${rank}`;
  }
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < board.length; i++) {
    const value = board[i]!.implied_value_usd;
    if (value > previous) return `row ${i + 1} outranks row ${i} on implied value`;
    previous = value;
  }
  const first = board[0]!.implied_value_usd;
  const last = board[board.length - 1]!.implied_value_usd;
  if (board.length >= 2 && first === last) {
    return `all ${board.length} rows share one implied value, $${first}: a board that ranks nothing by value is not a ranking`;
  }
  return null;
}

/** A per-row problem (bad implied value, bad farm steps), or null when every row is sound. */
function rowProblem(board: RankedRow[]): string | null {
  for (const r of board) {
    const value = r.implied_value_usd;
    if (Number.isSafeInteger(value) === false || value <= 0) {
      return `${r.slug} has implied value ${value}`;
    }
    if (value > 100_000_000_000_000) {
      return `${r.slug} has implied value over the cap`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) {
        return `${r.slug} has a farm step of ${s.length} characters`;
      }
    }
  }
  return null;
}

/** Each way a board fails the gate, as a list; empty when the board is sound. */
export function findBoardProblems(board: RankedRow[], snapshot: SnapshotDoc): string[] {
  const problems: string[] = [];
  const checks: Array<() => string | null> = [
    () => watchlistProblem(board, snapshot),
    () => unknownSlugProblem(board, snapshot),
    () => shapeProblem(board),
    () => rowProblem(board),
  ];
  for (const check of checks) {
    const found = check();
    if (found !== null) problems.push(found);
  }
  return problems;
}

/** Why a board is not one the gate will take, or null: the first problem, or none. */
export function firstBoardProblem(board: RankedRow[], snapshot: SnapshotDoc): string | null {
  const problems = findBoardProblems(board, snapshot);
  if (problems.length === 0) return null;
  return problems[0]!;
}

/** data.js, squeezed: the dashboard's whole dataset as one script, with no fetch and no network. */
export function payloadScript(payload: DashboardPayload): string {
  const json = JSON.stringify(payload);
  return 'window.RADAR=' + json + ';\n';
}
