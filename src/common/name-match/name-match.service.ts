import { Injectable } from '@nestjs/common';

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const match_dist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1_matches = new Array<boolean>(len1).fill(false);
  const s2_matches = new Array<boolean>(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - match_dist);
    const end = Math.min(i + match_dist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2_matches[j] || s1[i] !== s2[j]) continue;
      s1_matches[i] = true;
      s2_matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1_matches[i]) continue;
    while (!s2_matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

function jaro_winkler(s1: string, s2: string): number {
  const jaro_score = jaro(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro_score + prefix * 0.1 * (1 - jaro_score);
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

@Injectable()
export class NameMatchService {
  /**
   * Token-overlap Jaro-Winkler: each token in the smaller set is matched against
   * its best candidate in the larger set. This tolerates:
   *   - different name orderings (surname-first vs first-surname)
   *   - providers returning fewer tokens than were submitted (middle name absent)
   *   - providers returning extra tokens (e.g. title, suffix)
   */
  compare(a: string, b: string): number {
    const tokens_a = tokenize(a);
    const tokens_b = tokenize(b);

    if (tokens_a.length === 0 || tokens_b.length === 0) return 0;

    const [source, target] = tokens_a.length <= tokens_b.length
      ? [tokens_a, tokens_b]
      : [tokens_b, tokens_a];

    const scores = source.map(token =>
      Math.max(...target.map(t => jaro_winkler(token, t))),
    );

    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }
}
