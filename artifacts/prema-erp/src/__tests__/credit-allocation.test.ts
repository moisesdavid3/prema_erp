import { describe, it, expect } from 'vitest';
// The FIFO allocator lives in the API server (it is the authoritative place
// that splits a payment). It is a pure module with no imports, so it can be
// exercised directly from the frontend's vitest project without adding a
// second test runner to the workspace.
import { allocateFifo, type FifoDebt } from '../../../api-server/src/lib/credit-allocation';

const debt = (over: Partial<FifoDebt> & Pick<FifoDebt, 'id' | 'kind' | 'date' | 'pending'>): FifoDebt => ({
  label: over.kind === 'manual' ? 'Crédito manual' : `Venta #${over.id}`,
  ...over,
});

describe('allocateFifo', () => {
  it('aplica el abono a la deuda más antigua primero', () => {
    const result = allocateFifo([
      debt({ id: 3, kind: 'sale', date: '2026-09-24T00:00:00.000Z', pending: 60000 }),
      debt({ id: 1, kind: 'manual', date: '2026-07-08T00:00:00.000Z', pending: 88500 }),
      debt({ id: 2, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 160000 }),
    ], 100000);

    expect(result.allocations).toEqual([
      expect.objectContaining({ id: 1, kind: 'manual', amount: 88500, remainingAfter: 0 }),
      expect.objectContaining({ id: 2, kind: 'sale', amount: 11500, remainingAfter: 148500 }),
    ]);
    expect(result.leftover).toBe(0);
  });

  it('salda por completo la deuda más antigua antes de tocar la siguiente', () => {
    const result = allocateFifo([
      debt({ id: 1, kind: 'manual', date: '2026-07-08T00:00:00.000Z', pending: 88500 }),
      debt({ id: 2, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 160000 }),
    ], 88500);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ id: 1, amount: 88500, remainingAfter: 0 });
    expect(result.stillPending).toBe(160000);
  });

  it('parte el abono entre varias deudas cuando no alcanza para la primera', () => {
    const result = allocateFifo([
      debt({ id: 1, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 160000 }),
      debt({ id: 2, kind: 'sale', date: '2026-09-24T00:00:00.000Z', pending: 126000 }),
      debt({ id: 3, kind: 'sale', date: '2026-09-30T00:00:00.000Z', pending: 174000 }),
    ], 240000);

    expect(result.allocations.map((a) => [a.id, a.amount])).toEqual([[1, 160000], [2, 80000]]);
    expect(result.stillPending).toBe(126000 - 80000 + 174000);
    expect(result.leftover).toBe(0);
  });

  it('reporta el sobrante cuando el abono supera toda la deuda', () => {
    const result = allocateFifo([
      debt({ id: 1, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 160000 }),
    ], 226000);

    expect(result.allocations).toHaveLength(1);
    expect(result.leftover).toBe(66000);
    expect(result.stillPending).toBe(0);
  });

  it('ordena por fecha aunque las deudas lleguen desordenadas', () => {
    const result = allocateFifo([
      debt({ id: 9, kind: 'sale', date: '2026-09-30T00:00:00.000Z', pending: 1000 }),
      debt({ id: 4, kind: 'manual', date: '2026-07-08T00:00:00.000Z', pending: 1000 }),
      debt({ id: 7, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 1000 }),
    ], 2500);

    expect(result.allocations.map((a) => a.id)).toEqual([4, 7, 9]);
  });

  it('ignora deudas ya saldadas', () => {
    const result = allocateFifo([
      debt({ id: 1, kind: 'sale', date: '2026-08-14T00:00:00.000Z', pending: 0 }),
      debt({ id: 2, kind: 'sale', date: '2026-09-24T00:00:00.000Z', pending: 50000 }),
    ], 20000);

    expect(result.allocations.map((a) => a.id)).toEqual([2]);
  });

  it('no asigna nada cuando no hay deuda pendiente', () => {
    const result = allocateFifo([], 50000);

    expect(result.allocations).toEqual([]);
    expect(result.leftover).toBe(50000);
    expect(result.stillPending).toBe(0);
  });
});