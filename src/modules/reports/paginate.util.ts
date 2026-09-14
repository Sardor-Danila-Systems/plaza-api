/**
 * Simple offset-paginated async generator — the "bounded batches" half of
 * docs/backend-architecture.md §11's streaming requirement (the other half,
 * piping straight to the HTTP response without buffering the whole
 * workbook, lives in `xlsx-writer.util.ts`). Reports intentionally do NOT
 * wrap this in a single long-lived transaction: an export can take a while
 * to stream over HTTP, and holding a snapshot transaction open for that
 * entire duration would risk exactly the resource pressure §11 also warns
 * against ("do not hold a project write lock while generating reports") —
 * this is a read-only, best-effort-consistent export, not the dashboard's
 * single-request multi-metric snapshot.
 */
export async function* paginate<T>(
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  batchSize = 500,
): AsyncGenerator<T> {
  let skip = 0;
  for (;;) {
    const page = await fetchPage(skip, batchSize);
    for (const row of page) {
      yield row;
    }
    if (page.length < batchSize) {
      return;
    }
    skip += batchSize;
  }
}
