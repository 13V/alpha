/**
 * How long to wait before asking Dune about a running execution again.
 *
 * A flat interval has to be tuned for the slowest case and then wastes that
 * much on the fastest. The same trace, same token, same window, has finished in
 * 9s and in 174s -- Dune's engine time is set by its cluster, not by anything
 * here -- so a single number is wrong at one end or the other.
 *
 * This ramps instead: quick checks while a short run could still land, backing
 * off once it is clearly a long one. Status calls are metadata rather than
 * result reads, so the extra early checks cost no datapoints; only the fast
 * case gets shorter.
 */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 800;
  if (elapsedMs < 30_000) return 2_000;
  return 3_000;
}
