import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, inventoryMovementsTable, productsTable, purchaseItemsTable, purchasesTable } from "@workspace/db";
import {
  CreatePurchaseBody,
  CreatePurchaseResponse,
  GetPurchaseParams,
  GetPurchaseResponse,
  UpdatePurchaseBody,
  UpdatePurchaseParams,
  UpdatePurchaseResponse,
  ImportPurchasesBody,
  ImportPurchasesResponse,
  ListPurchasesResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { dateRangeForPeriod, maxProductCodeNumber, productCodePrefix, purchaseResponse, purchaseWhere, resolveSupplier, toPurchaseResponse } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/purchases", requireAuth, requireCompany);

function queryDates(query: Record<string, unknown>) {
  const period = typeof query.period === "string" ? query.period : "all";
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  return { period, from, to };
}

router.get("/purchases", async (req, res): Promise<void> => {
  const { period, from, to } = queryDates(req.query as Record<string, unknown>);
  const range = dateRangeForPeriod(period, from, to);
  const rows = await getDb().select().from(purchasesTable)
    .where(purchaseWhere(req.companyId!, range))
    .orderBy(desc(purchasesTable.purchaseDate));
  const allItems = rows.length
    ? await getDb().select().from(purchaseItemsTable).where(inArray(purchaseItemsTable.purchaseId, rows.map((r) => r.id)))
    : [];
  const itemsByPurchase = new Map<number, typeof allItems>();
  for (const item of allItems) {
    let list = itemsByPurchase.get(item.purchaseId);
    if (!list) { list = []; itemsByPurchase.set(item.purchaseId, list); }
    list.push(item);
  }
  res.json(ListPurchasesResponse.parse(rows.map((purchase) => toPurchaseResponse(purchase, itemsByPurchase.get(purchase.id) ?? []))));
});

router.post("/purchases", async (req, res): Promise<void> => {
  const parsed = CreatePurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Agrega al menos un producto a la compra." });
    return;
  }
  const userId = req.userId!;
  const supplierName = parsed.data.supplier?.trim() || null;
  const supplierId = await resolveSupplier(req.companyId!, supplierName);
  const result = await getDb().transaction(async (tx) => {
    const products = [];
    for (const item of parsed.data.items) {
      const [product] = await tx.select().from(productsTable)
        .where(and(eq(productsTable.id, item.productId), eq(productsTable.companyId, req.companyId!)));
      if (!product) return { error: "No encontramos uno de los productos." as const };
      products.push({ product, quantity: item.quantity, unitCost: item.unitCost });
    }

    const items = products.map(({ product, quantity, unitCost }) => ({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      productContent: product.content,
      quantity,
      unitCost,
      subtotal: unitCost * quantity,
    }));
    const total = items.reduce((sum, item) => sum + item.subtotal, 0);
    const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
    const [purchase] = await tx.insert(purchasesTable).values({
      companyId: req.companyId!,
      userId,
      supplier: supplierName,
      supplierId,
      invoiceNumber: parsed.data.invoiceNumber?.trim() || null,
      purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : new Date(),
      total,
      totalItems,
    }).returning();
    await tx.insert(purchaseItemsTable).values(items.map((item) => ({ purchaseId: purchase.id, ...item })));
    for (const { product, quantity, unitCost } of products) {
      const nextStock = product.stock + quantity;
      await tx.update(productsTable)
        .set({ stock: nextStock, cost: unitCost, updatedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId,
        productId: product.id,
        type: "compra",
        quantity,
        stockBefore: product.stock,
        stockAfter: nextStock,
        note: `Compra #${purchase.id}${parsed.data.invoiceNumber ? ` · Factura ${parsed.data.invoiceNumber}` : ""}`,
      });
    }
    return { purchase };
  });

  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(CreatePurchaseResponse.parse(await purchaseResponse(result.purchase)));
});

router.post("/purchases/import", async (req, res): Promise<void> => {
  const parsed = ImportPurchasesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "El archivo no tiene filas válidas para importar." });
    return;
  }
  const userId = req.userId!;
  const companyId = req.companyId!;
  const supplierName = parsed.data.supplier?.trim() || null;
  const supplierId = await resolveSupplier(companyId, supplierName);

  const existing = await getDb().select().from(productsTable).where(eq(productsTable.companyId, companyId));
  const byName = new Map<string, typeof productsTable.$inferSelect>();
  for (const product of existing) byName.set(product.name.trim().toLowerCase(), product);
  let maxCodeNumber = await maxProductCodeNumber(companyId);

  const result = await getDb().transaction(async (tx) => {
    const items: { product: typeof productsTable.$inferSelect; quantity: number; unitCost: number }[] = [];
    let created = 0;
    let skipped = 0;
    for (const row of parsed.data.rows) {
      const name = row.product.trim();
      if (!name || row.quantity < 1) {
        skipped += 1;
        continue;
      }
      let product = byName.get(name.toLowerCase());
      if (!product) {
        maxCodeNumber += 1;
        const [inserted] = await tx.insert(productsTable).values({
          companyId,
          userId,
          name,
          code: `${productCodePrefix(companyId)}-${String(maxCodeNumber).padStart(3, "0")}`,
          cost: row.unitCost,
          salePrice: 0,
          stock: 0,
          minimumStock: 5,
          isDemo: false,
        }).returning();
        product = inserted;
        byName.set(name.toLowerCase(), product);
        created += 1;
      }
      items.push({ product, quantity: row.quantity, unitCost: row.unitCost });
    }
    if (items.length === 0) return { empty: true as const };

    const purchaseItems = items.map(({ product, quantity, unitCost }) => ({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      productContent: product.content,
      quantity,
      unitCost,
      subtotal: unitCost * quantity,
    }));
    const total = purchaseItems.reduce((sum, item) => sum + item.subtotal, 0);
    const totalItems = purchaseItems.reduce((sum, item) => sum + item.quantity, 0);
    const [purchase] = await tx.insert(purchasesTable).values({
      companyId,
      userId,
      supplier: supplierName,
      supplierId,
      invoiceNumber: parsed.data.invoiceNumber?.trim() || null,
      purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : new Date(),
      total,
      totalItems,
    }).returning();
    await tx.insert(purchaseItemsTable).values(purchaseItems.map((item) => ({ purchaseId: purchase.id, ...item })));
    for (const { product, quantity, unitCost } of items) {
      const nextStock = product.stock + quantity;
      await tx.update(productsTable)
        .set({ stock: nextStock, cost: unitCost, updatedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId,
        userId,
        productId: product.id,
        type: "compra",
        quantity,
        stockBefore: product.stock,
        stockAfter: nextStock,
        note: `Compra #${purchase.id}${parsed.data.invoiceNumber ? ` · Factura ${parsed.data.invoiceNumber}` : ""}`,
      });
    }
    return { created, matched: items.length - created, skipped, purchase };
  });

  if ("empty" in result) {
    res.status(400).json({ error: "Ninguna fila tiene datos válidos para importar." });
    return;
  }
  res.status(201).json(ImportPurchasesResponse.parse({
    created: result.created,
    matched: result.matched,
    skipped: result.skipped,
    purchase: await purchaseResponse(result.purchase),
  }));
});

router.get("/purchases/:id", async (req, res): Promise<void> => {
  const params = GetPurchaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "No encontramos esa compra." });
    return;
  }
  const [purchase] = await getDb().select().from(purchasesTable)
    .where(and(eq(purchasesTable.id, params.data.id), eq(purchasesTable.companyId, req.companyId!)));
  if (!purchase) {
    res.status(404).json({ error: "No encontramos esa compra." });
    return;
  }
  res.json(GetPurchaseResponse.parse(await purchaseResponse(purchase)));
});

router.delete("/purchases/:id", async (req, res): Promise<void> => {
  const params = GetPurchaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "No encontramos esa compra." });
    return;
  }
  const deleted = await getDb().transaction(async (tx) => {
    const [purchase] = await tx.select().from(purchasesTable)
      .where(and(eq(purchasesTable.id, params.data.id), eq(purchasesTable.companyId, req.companyId!)));
    if (!purchase) return false;
    const items = await tx.select().from(purchaseItemsTable).where(eq(purchaseItemsTable.purchaseId, purchase.id));
    for (const item of items) {
      const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, item.productId));
      if (!product) continue;
      const stockAfter = product.stock - item.quantity;
      await tx.update(productsTable)
        .set({ stock: Math.max(0, stockAfter), updatedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId: product.userId,
        productId: product.id,
        type: "compra_anulada",
        quantity: -item.quantity,
        stockBefore: product.stock,
        stockAfter: Math.max(0, stockAfter),
        note: `Compra #${purchase.id} anulada`,
      });
    }
    await tx.delete(purchaseItemsTable).where(eq(purchaseItemsTable.purchaseId, purchase.id));
    await tx.delete(purchasesTable).where(eq(purchasesTable.id, purchase.id));
    return true;
  });
  if (!deleted) {
    res.status(404).json({ error: "No encontramos esa compra." });
    return;
  }
  res.sendStatus(204);
});

router.patch("/purchases/:id", async (req, res): Promise<void> => {
  const params = UpdatePurchaseParams.safeParse(req.params);
  const parsed = UpdatePurchaseBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Revisa los datos de la compra." });
    return;
  }

  const updated = await getDb().transaction(async (tx) => {
    const [purchase] = await tx.select().from(purchasesTable)
      .where(and(eq(purchasesTable.id, params.data.id), eq(purchasesTable.companyId, req.companyId!)));
    if (!purchase) return { error: "No encontramos esa compra." as const, status: 404 as const };

    // Se pide la lista completa: lo que no venga se quita de la compra.
    const requested = new Map<number, { quantity: number; unitCost: number }>();
    for (const line of parsed.data.items) {
      const found = requested.get(line.productId);
      if (found) {
        found.quantity += line.quantity;
        found.unitCost = Math.round((found.unitCost + line.unitCost) / 2);
        continue;
      }
      requested.set(line.productId, { quantity: line.quantity, unitCost: line.unitCost });
    }

    const currentItems = await tx.select().from(purchaseItemsTable).where(eq(purchaseItemsTable.purchaseId, purchase.id));

    // Producto + diferencia de unidades: lo que sale de la compra resta stock.
    const delta = new Map<number, number>();
    for (const item of currentItems) delta.set(item.productId, (delta.get(item.productId) ?? 0) - item.quantity);
    for (const [productId, line] of requested) delta.set(productId, (delta.get(productId) ?? 0) + line.quantity);

    for (const [productId, change] of delta) {
      if (change === 0) continue;
      const [product] = await tx.select().from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.companyId, req.companyId!)));
      if (!product) return { error: "No encontramos uno de los productos." as const, status: 400 as const };
      const stockAfter = product.stock + change;
      const line = requested.get(productId);
      await tx.update(productsTable).set({
        stock: stockAfter,
        // El costo nuevo solo aplica si el producto sigue en la compra.
        ...(line ? { cost: Math.round(line.unitCost) } : {}),
        updatedAt: new Date(),
      }).where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId: req.userId!,
        productId: product.id,
        type: "compra",
        quantity: change,
        stockBefore: product.stock,
        stockAfter,
        note: `Compra #${purchase.id} corregida${purchase.invoiceNumber ? ` · Factura ${purchase.invoiceNumber}` : ""}`,
      });
    }

    await tx.delete(purchaseItemsTable).where(eq(purchaseItemsTable.purchaseId, purchase.id));
    const products = await tx.select().from(productsTable).where(eq(productsTable.companyId, req.companyId!));
    const byId = new Map(products.map((p) => [p.id, p]));
    await tx.insert(purchaseItemsTable).values([...requested.entries()].map(([productId, line]) => {
      const product = byId.get(productId)!;
      return {
        purchaseId: purchase.id,
        productId,
        productName: product.name,
        productCode: product.code,
        productContent: product.content,
        quantity: line.quantity,
        unitCost: Math.round(line.unitCost),
        subtotal: Math.round(line.unitCost) * line.quantity,
      };
    }));

    const items = [...requested.values()];
    const [saved] = await tx.update(purchasesTable).set({
      supplier: parsed.data.supplier?.trim() || purchase.supplier,
      invoiceNumber: parsed.data.invoiceNumber?.trim() || purchase.invoiceNumber,
      purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : purchase.purchaseDate,
      total: items.reduce((sum, i) => sum + Math.round(i.unitCost) * i.quantity, 0),
      totalItems: items.reduce((sum, i) => sum + i.quantity, 0),
    }).where(eq(purchasesTable.id, purchase.id)).returning();
    return { purchase: saved };
  });

  if ("error" in updated) {
    res.status(updated.status ?? 400).json({ error: updated.error });
    return;
  }
  if (!updated.purchase) {
    res.status(500).json({ error: "No pudimos guardar los cambios de la compra." });
    return;
  }
  res.json(UpdatePurchaseResponse.parse(await purchaseResponse(updated.purchase)));
});

export default router;
