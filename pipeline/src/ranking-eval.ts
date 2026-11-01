/**
 * Is the "Make it 24/7" ranking any better than what a planner could do without it, and does it
 * survive a change of assumptions? Everything here is scored with one function, F(S): the expected
 * 2025 cardiac-arrest calls a year that fall inside the two-minute walk of at least one school in S
 * at hours when no AED in reach was open. A street square reached by two chosen schools counts once.
 *
 * Methods compared, for 10, 25, 50 and 100 cabinets:
 *  - After Hours: each square credited to its nearest school; schools ranked by what they're credited.
 *  - Greedy: each pick maximises what it adds to the schools already picked (the textbook method for
 *    this kind of coverage problem); a check on how much the simpler ranking leaves on the table.
 *  - Busiest walk: the schools with the most calls inside their walk at any hour (time-blind).
 *  - Fewest AEDs: schools in the ZIP codes with the most calls per AED location.
 *  - Random: the average of 500 random draws of schools.
 * Sensitivity: the same ranking re-run with schools locking at 3 PM or 9 PM, with every venue of
 * unknown hours treated as open around the clock, and with Bedrock's estimated hours counted.
 */

export interface EvalCell {
  region: number;
  hits: number[];
}

export interface Scenario {
  key: string;
  label: string;
  states: Uint8Array[];
  unknownOpen: boolean;
}

const SIZES = [10, 25, 50, 100];

/** Calls a year in each square at hours when nothing in reach is open (the square's share of its ZIP's calls). */
function lockedWeights(cells: EvalCell[], calls: number[][], cellCount: number[], states: Uint8Array[], unknownOpen: boolean) {
  return Float64Array.from(cells, (c) => {
    const byState = calls[c.region];
    const per = 1 / cellCount[c.region];
    let w = 0;
    for (let st = 0; st < byState.length; st++) {
      if (!byState[st]) continue;
      if (c.hits.some((i) => states[i][st] === 1 || (unknownOpen && states[i][st] === 2))) continue;
      w += byState[st] * per;
    }
    return w;
  });
}

/** Calls a year in each square that already had an open AED in reach: the "before" of every scenario. */
function coveredWeights(cells: EvalCell[], calls: number[][], cellCount: number[], states: Uint8Array[], unknownOpen: boolean) {
  let total = 0;
  for (const c of cells) {
    const byState = calls[c.region];
    const per = 1 / cellCount[c.region];
    for (let st = 0; st < byState.length; st++)
      if (byState[st] && c.hits.some((i) => states[i][st] === 1 || (unknownOpen && states[i][st] === 2))) total += byState[st] * per;
  }
  return total;
}

export function rankingEval(cells: EvalCell[], calls: number[][], cellCount: number[], isSchool: (i: number) => boolean, zipOf: (i: number) => number, aedLocationsInZip: number[], scenarios: Scenario[]) {
  const schools = new Set<number>();
  const cellsOf = new Map<number, number[]>();
  cells.forEach((c, k) => {
    for (const i of c.hits)
      if (isSchool(i)) {
        schools.add(i);
        (cellsOf.get(i) ?? cellsOf.set(i, []).get(i)!).push(k);
      }
  });
  const allSchools = [...schools];

  const F = (w: Float64Array, S: number[]) => {
    const seen = new Uint8Array(cells.length);
    let f = 0;
    for (const s of S) for (const k of cellsOf.get(s) ?? []) if (!seen[k]) (seen[k] = 1), (f += w[k]);
    return f;
  };
  const credited = (w: Float64Array) => {
    const gain = new Map<number, number>();
    cells.forEach((c, k) => {
      const s = c.hits.find(isSchool); // hits are sorted by distance: the nearest school
      if (s !== undefined && w[k] > 0) gain.set(s, (gain.get(s) ?? 0) + w[k]);
    });
    return [...gain.entries()].sort((a, b) => b[1] - a[1]);
  };
  const greedy = (w: Float64Array, n: number) => {
    const covered = new Uint8Array(cells.length);
    const out: number[] = [];
    for (let step = 0; step < n; step++) {
      let best = -1, bestGain = 0;
      for (const s of allSchools) {
        let g = 0;
        for (const k of cellsOf.get(s)!) if (!covered[k]) g += w[k];
        if (g > bestGain) (bestGain = g), (best = s);
      }
      if (best < 0) break;
      out.push(best);
      for (const k of cellsOf.get(best)!) covered[k] = 1;
    }
    return out;
  };

  const base = scenarios[0];
  const w = lockedWeights(cells, calls, cellCount, base.states, base.unknownOpen);
  const before = coveredWeights(cells, calls, cellCount, base.states, base.unknownOpen);
  const ours = credited(w);
  const ourOrder = ours.map(([s]) => s);

  // Time-blind: calls in the walk at every hour, as a map that ignores opening hours would see them.
  const blind = new Map<number, number>();
  for (const s of allSchools) {
    let b = 0;
    for (const k of cellsOf.get(s)!) {
      const c = cells[k];
      b += calls[c.region].reduce((a, n) => a + n, 0) / cellCount[c.region];
    }
    blind.set(s, b);
  }
  const busiest = [...allSchools].sort((a, b) => blind.get(b)! - blind.get(a)!);
  const zipCallsPerAed = (s: number) => {
    const z = zipOf(s);
    return calls[z].reduce((a, n) => a + n, 0) / Math.max(1, aedLocationsInZip[z]);
  };
  const fewest = [...allSchools].sort((a, b) => zipCallsPerAed(b) - zipCallsPerAed(a) || blind.get(b)! - blind.get(a)!);
  const greedyOrder = greedy(w, Math.max(...SIZES));

  // Deterministic random draws, so the published figure can be reproduced exactly.
  let seed = 20251101;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const randomMean = (n: number) => {
    let sum = 0;
    for (let d = 0; d < 500; d++) {
      const pool = [...allSchools];
      for (let i = 0; i < n; i++) {
        const j = i + Math.floor(rand() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      sum += F(w, pool.slice(0, n));
    }
    return sum / 500;
  };

  const r1 = (x: number) => Math.round(x * 10) / 10;
  const methods = SIZES.map((n) => ({
    cabinets: n,
    afterHours: r1(F(w, ourOrder.slice(0, n))),
    afterHoursCredited: r1(ours.slice(0, n).reduce((a, [, g]) => a + g, 0)),
    greedy: r1(F(w, greedyOrder.slice(0, n))),
    busiestWalk: r1(F(w, busiest.slice(0, n))),
    fewestAeds: r1(F(w, fewest.slice(0, n))),
    random: r1(randomMean(n)),
  }));

  const top25 = new Set(ourOrder.slice(0, 25));
  const top100 = ourOrder.slice(0, 100);
  const sensitivity = scenarios.map((sc) => {
    const ws = sc === base ? w : lockedWeights(cells, calls, cellCount, sc.states, sc.unknownOpen);
    const bef = sc === base ? before : coveredWeights(cells, calls, cellCount, sc.states, sc.unknownOpen);
    const own = credited(ws).map(([s]) => s);
    const gain = F(ws, top100);
    return {
      key: sc.key,
      label: sc.label,
      before: Math.round(bef),
      gainTop100: r1(gain),
      gainPct: Math.round((100 * gain) / bef),
      top25Kept: own.slice(0, 25).filter((s) => top25.has(s)).length,
      top100Kept: own.slice(0, 100).filter((s) => top100.includes(s)).length,
      sameFirst: own[0] === ourOrder[0],
    };
  });

  return {
    method:
      "F(S): expected 2025 cardiac-arrest calls a year inside the two-minute walk of at least one chosen school, at hours when no AED in reach was open. Calls are spread evenly over each ZIP's 50 m squares; a square reached by two chosen schools counts once.",
    schoolsConsidered: allSchools.length,
    before: Math.round(before),
    methods,
    sensitivity,
  };
}
