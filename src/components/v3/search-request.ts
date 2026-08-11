export type SearchRequestToken = {
  generation: number;
  queryToken: number;
  signal: AbortSignal;
};

/**
 * Search requests are account-scoped. A response may arrive after an account
 * switch, so it must prove both that it belongs to the current account
 * generation and that it is still the latest query.
 */
export class SearchRequestGuard {
  private generation = 0;
  private queryToken = 0;
  private controller: AbortController | null = null;

  start(): SearchRequestToken {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    return {
      generation: this.generation,
      queryToken: ++this.queryToken,
      signal: controller.signal,
    };
  }

  invalidateForAccountChange(): void {
    this.generation++;
    this.queryToken++;
    this.controller?.abort();
    this.controller = null;
  }

  cancel(): void {
    this.queryToken++;
    this.controller?.abort();
    this.controller = null;
  }

  isCurrent(token: SearchRequestToken): boolean {
    return (
      token.generation === this.generation &&
      token.queryToken === this.queryToken &&
      !token.signal.aborted
    );
  }
}
