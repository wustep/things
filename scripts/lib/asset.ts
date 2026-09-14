import type { ProceduralAsset, ProceduralShape } from '../../shared/types.ts';

const CYLINDER_WORDS = /\b(bottle|perfume|fragrance|cologne|eau de|candle|wash|lotion|serum|spray|shampoo|conditioner|tumbler|can|jar|vase|mug|cup|flask|thermos|wine|whisk(e)?y|gin|vodka|sake|oil)\b/i;
const BOX_WORDS = /\b(book|hardcover|paperback|box|boxed|puzzle|board game|console|speaker|camera|lens|keyboard|monitor|laptop|notebook|tablet|ipad|macbook|tv|cube|case|carton|kit|set)\b/i;

/** Decide how to represent an item in the void from its title and cut-out shape. */
export function chooseShape(title: string, aspect: number, removedFraction: number): ProceduralShape {
  const tall = aspect < 0.62;
  if (CYLINDER_WORDS.test(title) && tall) return 'cylinder';
  if (BOX_WORDS.test(title) && aspect > 0.7 && aspect < 1.8) return 'box';
  // If we could not separate the subject from its background, a box with the photo as
  // its face looks better than a rectangular "cut-out" card floating in space.
  if (removedFraction < 0.05 && aspect > 0.6 && aspect < 1.7) return 'box';
  return 'card';
}

export function buildProceduralAsset(opts: {
  title: string;
  texture: string;
  aspect: number;
  palette: string[];
  removedFraction: number;
}): ProceduralAsset {
  return {
    kind: 'procedural',
    shape: chooseShape(opts.title, opts.aspect, opts.removedFraction),
    texture: opts.texture,
    aspect: Number(opts.aspect.toFixed(4)),
    palette: opts.palette,
  };
}
