import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import {
  getDb,
  inventoryMovementsTable,
  productsTable,
  stockoutItemsTable,
  stockoutsTable,
} from "@workspace/db";
import {
  CreateStockoutBody,
  CreateStockoutResponse,
  DeleteStockoutParams,
  ListStockoutsResponse,
  UpdateStockoutItemBody,
  UpdateStockoutItemParams,
  UpdateStockoutItemResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";

const router: IRouter = Router();
router.use(requireAuth, requireCompany);

type StockoutRow = typeof stockoutsTable.$inferSelect;
type StockoutItemRow = typeof stockoutItemsTable.$inferSelect;
type ProductRow = typeof productsTable.$inferSelect;

function stockoutItemResponse(item: StockoutItemRow) {
  return {
    id: item.id,
    productId: item.productId,
    productName: item.productName,
    productCode: item.productCode ?? null,
    quantity: item.quantity,
    unitCost: item.unitCost,
    reason: item.reason ?? null,
    note: item.note ?? null,
  };
}

function stockoutResponse(stockout: StockoutRow, items: StockoutItemRow[]) {
  const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalValue = items.reduce((sum, i) => sum + i.quantity * i.unitCost, 0);
  return { id: stockout.id, date: stockout.stockoutDate, totalUnits, totalValue, items: items.map(stockoutItemResponse) };
}

async function recordMovement(tx: any, companyId: number, userId: string, product: ProductRow, delta: number, note?: string, createdAt?: Date) {
  await tx.insert(inventoryMovementsTable).values({
    companyId,
    userId,
    productId: product.id,
    type: "salida",
    quantity: -delta,
    stockBefore: product.stock,
    stockAfter: product.stock - delta,
    ...(createdAt ? { createdAt } : {}),
    note: note ?? null,
  });
}

router.get("/stockouts", async (req, res): Promise<void> => {
  const month = typeof req.query.month === "string" ? req.query.month : "";
  let where: SQL | undefined = eq(stockoutsTable.companyId, req.companyId!);
  if (/^\d{4}-\d{2}$/.test(month)) {
    const start = new Date(`${month}-01T00:00:00-05:00`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    where = and(where, gte(stockoutsTable.stockoutDate, start), lt(stockoutsTable.stockoutDate, end));
  }
  const stockouts = await getDb().select().from(stockoutsTable)
    .where(where)
    .orderBy(desc(stockoutsTable.stockoutDate), desc(stockoutsTable.id));
  if (stockouts.length === 0) {
    res.json(ListStockoutsResponse.parse([]));
    return;
  }
  const ids = stockouts.map((s) => s.id);
  const items = await getDb().select().from(stockoutItemsTable)
    .where(inArray(stockoutItemsTable.stockoutId, ids))
    .orderBy(asc(stockoutItemsTable.id));
  const itemsByStockout = new Map<number, StockoutItemRow[]>();
  for (const item of items) {
    const list = itemsByStockout.get(item.stockoutId) ?? [];
    list.push(item);
    itemsByStockout.set(item.stockoutId, list);
  }
  res.json(ListStockoutsResponse.parse(
    stockouts.map((s) => stockoutResponse(s, itemsByStockout.get(s.id) ?? [])),
  ));
});

router.post("/stockouts", async (req, res): Promise<void> => {
  const parsed = CreateStockoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Revisa los datos de la baja e inténtalo nuevamente." });
    return;
  }
  const date = parsed.data.date ?? new Date();
  const result = await getDb().transaction(async (tx) => {
    const [stockout] = await tx.insert(stockoutsTable).values({
      companyId: req.companyId!,
      userId: req.userId!,
      stockoutDate: date,
    }).returning();
    const createdItems: StockoutItemRow[] = [];
    for (const item of parsed.data.items) {
      const [product] = await tx.select().from(productsTable)
        .where(and(eq(productsTable.id, item.productId), eq(productsTable.companyId, req.companyId!)));
      if (!product) throw new Error("PRODUCT_NOT_FOUND");
      if (item.quantity > product.stock) throw new Error("INSUFFICIENT_STOCK");
      const unitCost = item.unitCost !== undefined ? item.unitCost : (product.cost || 0);
      if (unitCost <= 0) throw new Error("MISSING_COST");
      await tx.update(productsTable)
        .set({ stock: product.stock - item.quantity, updatedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      await recordMovement(tx, req.companyId!, product.userId, product, item.quantity, item.note?.trim() || undefined, stockout.stockoutDate);
      const [row] = await tx.insert(stockoutItemsTable).values({
        stockoutId: stockout.id,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        quantity: item.quantity,
        unitCost,
        reason: item.reason?.trim() || null,
        note: item.note?.trim() || null,
      }).returning();
      createdItems.push(row);
    }
    return { stockout, items: createdItems };
  }).catch((e: any) => {
    if (e?.message === "PRODUCT_NOT_FOUND") return { error: 404, message: "No encontramos un producto de la lista." };
    if (e?.message === "INSUFFICIENT_STOCK") return { error: 400, message: "La cantidad supera el stock disponible de un producto." };
    if (e?.message === "MISSING_COST") return { error: 400, message: "Un producto no tiene costo registrado; indícalo manualmente." };
    throw e;
  });
  if ("error" in result) {
    res.status(result.error as number).json({ error: result.message });
    return;
  }
  res.status(201).json(CreateStockoutResponse.parse(stockoutResponse(result.stockout, result.items)));
});

router.patch("/stockouts/:id/items/:itemId", async (req, res): Promise<void> => {
  const params = UpdateStockoutItemParams.safeParse(req.params);
  const parsed = UpdateStockoutItemBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Revisa los datos e inténtalo nuevamente." });
    return;
  }
  const result = await getDb().transaction(async (tx) => {
    const [stockout] = await tx.select().from(stockoutsTable)
      .where(and(eq(stockoutsTable.id, params.data.id), eq(stockoutsTable.companyId, req.companyId!)));
    if (!stockout) return { error: 404, message: "No encontramos esa baja." };
    const [item] = await tx.select().from(stockoutItemsTable)
      .where(and(eq(stockoutItemsTable.id, params.data.itemId), eq(stockoutItemsTable.stockoutId, stockout.id)));
    if (!item) return { error: 404, message: "No encontramos ese item de la baja." };
    const [product] = await tx.select().from(productsTable)
      .where(and(eq(productsTable.id, item.productId), eq(productsTable.companyId, req.companyId!)));
    if (!product) return { error: 404, message: "No encontramos el producto del item." };
    const restoredStock = product.stock + item.quantity;
    if (parsed.data.quantity > restoredStock) return { error: 400, message: "La cantidad supera el stock disponible." };
    const unitCost = parsed.data.unitCost !== undefined ? parsed.data.unitCost : (product.cost || item.unitCost);
    if (unitCost <= 0) return { error: 400, message: "El costo debe ser mayor a 0." };
    await tx.update(productsTable)
      .set({ stock: restoredStock - parsed.data.quantity, updatedAt: new Date() })
      .where(eq(productsTable.id, product.id));
    await recordMovement(tx, req.companyId!, product.userId, product, parsed.data.quantity, item.note?.trim() || undefined);
    const [row] = await tx.update(stockoutItemsTable)
      .set({
        quantity: parsed.data.quantity,
        unitCost,
        reason: parsed.data.reason !== undefined ? (parsed.data.reason.trim() || null) : item.reason,
        note: parsed.data.note !== undefined ? (parsed.data.note.trim() || null) : item.note,
      })
      .where(eq(stockoutItemsTable.id, item.id))
      .returning();
    return { row };
  });
  if ("error" in result) {
    res.status(result.error as number).json({ error: result.message });
    return;
  }
  res.json(UpdateStockoutItemResponse.parse(stockoutItemResponse(result.row)));
});

router.delete("/stockouts/:id/items/:itemId", async (req, res): Promise<void> => {
  const params = UpdateStockoutItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "ID inválido." });
    return;
  }
  const ok = await getDb().transaction(async (tx) => {
    const [stockout] = await tx.select().from(stockoutsTable)
      .where(and(eq(stockoutsTable.id, params.data.id), eq(stockoutsTable.companyId, req.companyId!)));
    if (!stockout) return false;
    const [item] = await tx.select().from(stockoutItemsTable)
      .where(and(eq(stockoutItemsTable.id, params.data.itemId), eq(stockoutItemsTable.stockoutId, stockout.id)));
    if (!item) return false;
    const [product] = await tx.select().from(productsTable)
      .where(and(eq(productsTable.id, item.productId), eq(productsTable.companyId, req.companyId!)));
    if (!product) return false;
    await tx.update(productsTable)
      .set({ stock: product.stock + item.quantity, updatedAt: new Date() })
      .where(eq(productsTable.id, product.id));
    await tx.delete(stockoutItemsTable).where(eq(stockoutItemsTable.id, item.id));
    return true;
  });
  if (!ok) {
    res.status(404).json({ error: "No encontramos ese item de la baja." });
    return;
  }
  res.sendStatus(204);
});

router.delete("/stockouts/:id", async (req, res): Promise<void> => {
  const params = DeleteStockoutParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "ID inválido." });
    return;
  }
  const ok = await getDb().transaction(async (tx) => {
    const [stockout] = await tx.select().from(stockoutsTable)
      .where(and(eq(stockoutsTable.id, params.data.id), eq(stockoutsTable.companyId, req.companyId!)));
    if (!stockout) return false;
    const items = await tx.select().from(stockoutItemsTable).where(eq(stockoutItemsTable.stockoutId, stockout.id));
    for (const item of items) {
      const [product] = await tx.select().from(productsTable)
        .where(and(eq(productsTable.id, item.productId), eq(productsTable.companyId, req.companyId!)));
      if (product) {
        await tx.update(productsTable)
          .set({ stock: product.stock + item.quantity, updatedAt: new Date() })
          .where(eq(productsTable.id, product.id));
      }
    }
    await tx.delete(stockoutItemsTable).where(eq(stockoutItemsTable.stockoutId, stockout.id));
    await tx.delete(stockoutsTable).where(eq(stockoutsTable.id, stockout.id));
    return true;
  });
  if (!ok) {
    res.status(404).json({ error: "No encontramos esa baja." });
    return;
  }
  res.sendStatus(204);
});

export default router;