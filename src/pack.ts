/**
 * Things in collection order, broken into shelves the way a paragraph is broken into lines: as few
 * shelves as greedy filling needs, then the breaks that leave the shelves most evenly filled, so a
 * case ends on a shelf about as full as the others instead of one thing standing alone (a lamp left
 * over after a wide bookshelf). A lone thing is only left when nothing else can share its shelf.
 */
export function pack<T extends { slot: number }>(placed: T[], width: number): T[][] {
  const n = placed.length;
  if (n === 0) return [];
  let greedy = 1;
  for (let i = 0, used = 0; i < n; i++) {
    if (used > 0 && used + placed[i].slot > width) {
      greedy++;
      used = 0;
    }
    used += placed[i].slot;
  }
  return breakInto(placed, width, greedy) ?? [placed];
}

/** The breaks into exactly `rows` shelves with the least squared slack, or null if they can't fit. */
function breakInto<T extends { slot: number }>(placed: T[], width: number, rows: number): T[][] | null {
  const n = placed.length;
  const lone = n > 1 ? 4 : 0; // a lone thing costs more than any shelf's slack
  const sum = [0];
  for (const p of placed) sum.push(sum[sum.length - 1] + p.slot);
  const rowCost = (i: number, j: number) => {
    const used = sum[j] - sum[i];
    if (used > width && j - i > 1) return Infinity; // one thing wider than the shelf still gets a shelf
    const slack = Math.max(0, width - used) / width;
    return slack * slack + (j - i === 1 ? lone : 0);
  };
  // cost[r][j]: best way to put the first j things on r shelves.
  const cost = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: rows + 1 }, () => new Array<number>(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let r = 1; r <= rows; r++) {
    for (let j = r; j <= n; j++) {
      for (let i = r - 1; i < j; i++) {
        const c = cost[r - 1][i] + rowCost(i, j);
        if (c <= cost[r][j]) { // on a tie, the fuller earlier shelf
          cost[r][j] = c;
          from[r][j] = i;
        }
      }
    }
  }
  if (!Number.isFinite(cost[rows][n])) return null;
  const out: T[][] = [];
  for (let r = rows, j = n; r > 0; r--) {
    const i = from[r][j];
    out.unshift(placed.slice(i, j));
    j = i;
  }
  return out;
}
