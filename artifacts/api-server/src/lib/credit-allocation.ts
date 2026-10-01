export type FifoDebtKind = "sale" | "manual";

export type FifoDebt = {
  id: number;
  kind: FifoDebtKind;
  label: string;
  /** ISO date used to order debts oldest-first. */
  date: string;
  pending: number;
};

export type FifoAllocation = FifoDebt & {
  amount: number;
  remainingAfter: number;
};

export type FifoResult = {
  allocations: FifoAllocation[];
  /** Amount that could not be assigned to any debt. */
  leftover: number;
  /** Sum of the pending of every debt still open after applying. */
  stillPending: number;
};

/**
 * Distributes `amount` across `debts` oldest-first (FIFO), the way a shop
 * settles a customer tab: the longest-standing debt is cleared first and the
 * rest flows into the next one, splitting the payment when needed.
 *
 * `debts` is sorted internally by date so callers can pass them in any order.
 */
export function allocateFifo(debts: FifoDebt[], amount: number): FifoResult {
  const ordered = [...debts]
    .filter((debt) => debt.pending > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.id - b.id);

  let left = Math.max(0, Math.round(amount));
  const allocations: FifoAllocation[] = [];

  for (const debt of ordered) {
    if (left <= 0) break;
    const applied = Math.min(debt.pending, left);
    if (applied <= 0) continue;
    allocations.push({ ...debt, amount: applied, remainingAfter: debt.pending - applied });
    left -= applied;
  }

  const cleared = new Set(allocations.filter((a) => a.remainingAfter <= 0).map((a) => `${a.kind}:${a.id}`));
  const stillPending = ordered
    .filter((debt) => !cleared.has(`${debt.kind}:${debt.id}`))
    .reduce((sum, debt) => {
      const applied = allocations.find((a) => a.kind === debt.kind && a.id === debt.id)?.amount ?? 0;
      return sum + (debt.pending - applied);
    }, 0);

  return { allocations, leftover: left, stillPending };
}