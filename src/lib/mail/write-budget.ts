/**
 * Most mailbox writes (trash / archive / mark-read) one request may issue,
 * and the most rows a bulk route accepts. Same batch /api/delete and
 * /api/archive slice to. Client-safe: the UI batches big selections by it.
 */
export const MAX_MAILBOX_WRITES = 25;

/**
 * Write allowance shared by every provider call one request makes. An
 * Outlook conversation fans out into one write per message, so the row cap
 * alone does not bound the writes — each write reserves from this first.
 */
export class MailWriteBudget {
  readonly limit: number;
  private left: number;

  constructor(limit = MAX_MAILBOX_WRITES) {
    this.limit = limit;
    this.left = limit;
  }

  get remaining(): number {
    return this.left;
  }

  /** All-or-nothing: true and deducted, or false and untouched. */
  reserve(count: number): boolean {
    if (count > this.left) return false;
    this.left -= count;
    return true;
  }
}

/**
 * The row was not touched because this request's write budget could not
 * cover it. Safe to send again in a later request.
 */
export class MailWriteDeferred extends Error {
  constructor() {
    super("Mailbox write budget for this request is spent");
    this.name = "MailWriteDeferred";
  }
}

export function reserveWrite(budget: MailWriteBudget | undefined): void {
  if (budget && !budget.reserve(1)) throw new MailWriteDeferred();
}
