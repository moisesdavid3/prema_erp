import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { clientsTable, companiesTable, creditPaymentsTable, getDb, inventoryMovementsTable, productsTable, saleItemsTable, salesTable } from "@workspace/db";
import {
  CreateCreditPaymentBody,
  CreateCreditPaymentParams,
  CreateCreditPaymentResponse,
  CreateSaleBody,
  CreateSaleResponse,
  GetSaleParams,
  GetSaleResponse,
  ListCreditPaymentsParams,
  ListCreditPaymentsResponse,
  ListSalesQueryParams,
  ListSalesResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { dateRangeForPeriod, ensureSeeded, endOfDayBogota, resolveClient, saleResponse, saleWhere, startOfDayBogota, toSaleResponse } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/sales", requireAuth, requireCompany);

function queryDates(query: Record<string, unknown>) {
  const period = typeof query.period === "string" ? query.period : "all";
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  return { period, from, to };
}

router.get("/sales", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSeeded(userId);
  const { period, from, to } = queryDates(req.query as Record<string, unknown>);
  const scope = typeof req.query.scope === "string" ? req.query.scope : "company";
  const range = dateRangeForPeriod(period, from, to);
  const conditions: ReturnType<typeof eq>[] = [];
  if (scope !== "all") conditions.push(eq(salesTable.companyId, req.companyId!));
  if (range.from) conditions.push(gte(salesTable.createdAt, range.from));
  if (range.to) conditions.push(lte(salesTable.createdAt, range.to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await getDb().select().from(salesTable)
    .where(where)
    .orderBy(desc(salesTable.createdAt));
  const saleIds = rows.map((s) => s.id);
  const allItems = saleIds.length
    ? await getDb().select().from(saleItemsTable).where(inArray(saleItemsTable.saleId, saleIds))
    : [];
  const itemsBySale = new Map<number, typeof allItems>();
  for (const item of allItems) {
    const list = itemsBySale.get(item.saleId) ?? [];
    list.push(item);
    itemsBySale.set(item.saleId, list);
  }
  const creditSaleIds = rows.filter((s) => s.paymentMethod === "Crédito").map((s) => s.id);
  const creditRows = creditSaleIds.length
    ? await getDb().select({ saleId: creditPaymentsTable.saleId, total: sql<number>`coalesce(sum(${creditPaymentsTable.amount}), 0)` }).from(creditPaymentsTable).where(inArray(creditPaymentsTable.saleId, creditSaleIds)).groupBy(creditPaymentsTable.saleId)
    : [];
  const creditBySale = new Map(creditRows.map((r) => [r.saleId, Number(r.total)]));
  res.json(ListSalesResponse.parse(rows.map((sale) => toSaleResponse(sale, itemsBySale.get(sale.id) ?? [], sale.paymentMethod === "Crédito" ? creditBySale.get(sale.id) ?? 0 : 0))));
});

router.post("/sales", async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Agrega al menos un producto a la venta." });
    return;
  }
  const userId = req.userId!;
  const saleDate = parsed.data.date ?? new Date();
  if (saleDate.getTime() > Date.now() + 60_000) {
    res.status(400).json({ error: "La fecha de la venta no puede ser futura." });
    return;
  }
  const requested = new Map<number, { quantity: number; unitPrice?: number }>();
  for (const item of parsed.data.items) {
    const existing = requested.get(item.productId);
    requested.set(item.productId, {
      quantity: (existing?.quantity ?? 0) + item.quantity,
      unitPrice: item.unitPrice ?? existing?.unitPrice,
    });
  }

  const [company] = await getDb().select().from(companiesTable).where(eq(companiesTable.id, req.companyId!));
  const allowNegative = !!company?.allowNegativeStock;

  const clientName = parsed.data.clientName?.trim() || null;
  const clientPhone = parsed.data.clientPhone?.trim() || null;
  let clientId = parsed.data.clientId ?? null;
  let clientCode: string | null = null;
  if (clientName) {
    const client = clientId
      ? (await getDb().select().from(clientsTable).where(eq(clientsTable.id, clientId)))[0] ?? null
      : await resolveClient(req.companyId!, clientName, userId, clientPhone);
    clientId = client?.id ?? clientId;
    clientCode = client?.code ?? null;
  }

  const result = await getDb().transaction(async (tx) => {
    const products = [];
    for (const [productId, lineReq] of requested.entries()) {
      const [product] = await tx.select().from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.companyId, req.companyId!)));
      if (!product) return { error: "No encontramos uno de los productos." as const };
      if (!allowNegative && product.stock < lineReq.quantity) {
        return { error: `Solo hay ${product.stock} unidades disponibles de ${product.name}.` as const, conflict: true as const };
      }
      products.push({ product, quantity: lineReq.quantity, unitPrice: lineReq.unitPrice });
    }

    const items = products.map(({ product, quantity, unitPrice }) => {
      const price = unitPrice ?? product.salePrice;
      return {
        productId: product.id,
        productName: product.name,
        productCode: product.code,
        productContent: product.content,
        quantity,
        unitPrice: price,
        unitCost: product.cost,
        subtotal: price * quantity,
      };
    });
    const total = items.reduce((sum, item) => sum + item.subtotal, 0);
    const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
    const estimatedProfit = items.reduce((sum, item) => sum + (item.unitPrice - item.unitCost) * item.quantity, 0);
    const isDelivery = parsed.data.isDelivery === true;
    const deliveryCost = isDelivery ? (parsed.data.deliveryCost ?? 0) : 0;
    const finalTotal = total + deliveryCost;
    const dayStart = startOfDayBogota(saleDate);
    const dayEnd = endOfDayBogota(saleDate);
    const [row] = await tx.select({ count: sql<number>`count(*)` }).from(salesTable)
      .where(and(eq(salesTable.companyId, req.companyId!), gte(salesTable.createdAt, dayStart), lt(salesTable.createdAt, dayEnd)));
    const [sale] = await tx.insert(salesTable).values({
      companyId: req.companyId!,
      userId,
      saleNumber: Number(row?.count ?? 0) + 1,
      createdAt: saleDate,
      total: finalTotal,
      totalItems,
      estimatedProfit,
      paymentMethod: parsed.data.paymentMethod?.trim() || null,
      notes: parsed.data.notes?.trim() || null,
      clientName,
      clientPhone,
      clientId,
      clientCode,
      isDelivery,
      deliveryCost,
      deliveryPaid: isDelivery ? (parsed.data.deliveryPaid === true) : false,
    }).returning();
    await tx.insert(saleItemsTable).values(items.map((item) => ({ saleId: sale.id, ...item })));
    for (const { product, quantity } of products) {
      const nextStock = product.stock - quantity;
      await tx.update(productsTable).set({ stock: nextStock, updatedAt: new Date() }).where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId,
        productId: product.id,
        type: "venta",
        quantity: -quantity,
        stockBefore: product.stock,
        stockAfter: nextStock,
        note: `Venta #${sale.saleNumber}`,
      });
    }
    return { sale };
  });

  if ("error" in result) {
    res.status("conflict" in result && result.conflict ? 409 : 400).json({ error: result.error });
    return;
  }
  res.status(201).json(CreateSaleResponse.parse(await saleResponse(result.sale)));
});

router.get("/sales/:id", async (req, res): Promise<void> => {
  const params = GetSaleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "No encontramos esa venta." });
    return;
  }
  const [sale] = await getDb().select().from(salesTable)
    .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)));
  if (!sale) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }
  res.json(GetSaleResponse.parse(await saleResponse(sale)));
});

router.patch("/sales/:id", async (req, res): Promise<void> => {
  const params = GetSaleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "No encontramos esa venta." });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if ("paymentMethod" in body) {
    updates.paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() || null : body.paymentMethod === null ? null : undefined;
  }
  if ("notes" in body) {
    updates.notes = typeof body.notes === "string" ? body.notes.trim() || null : body.notes === null ? null : undefined;
  }
  if ("deliveryPaid" in body) {
    if (typeof body.deliveryPaid === "boolean") updates.deliveryPaid = body.deliveryPaid;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nada que actualizar." });
    return;
  }
  const [updated] = await getDb().update(salesTable).set(updates)
    .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }
  res.json({ id: updated.id, paymentMethod: updated.paymentMethod, notes: updated.notes, isDelivery: updated.isDelivery, deliveryCost: updated.deliveryCost, deliveryPaid: updated.deliveryPaid });
});

router.delete("/sales/:id", async (req, res): Promise<void> => {
  const params = GetSaleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "No encontramos esa venta." });
    return;
  }
  const deleted = await getDb().transaction(async (tx) => {
    const [sale] = await tx.select().from(salesTable)
      .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)));
    if (!sale) return false;
    const items = await tx.select().from(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
    for (const item of items) {
      const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, item.productId));
      if (!product) continue;
      const stockAfter = product.stock + item.quantity;
      await tx.update(productsTable)
        .set({ stock: stockAfter, updatedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId: product.userId,
        productId: product.id,
        type: "venta_anulada",
        quantity: item.quantity,
        stockBefore: product.stock,
        stockAfter,
        note: `Venta #${sale.saleNumber} anulada`,
      });
    }
    await tx.delete(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
    await tx.delete(salesTable).where(eq(salesTable.id, sale.id));
    return true;
  });
  if (!deleted) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }
  res.sendStatus(204);
});

function creditPaymentResponse(payment: typeof creditPaymentsTable.$inferSelect) {
  return {
    id: payment.id,
    saleId: payment.saleId,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod,
    note: payment.note,
    date: payment.createdAt,
  };
}

router.post("/sales/:id/credit-payment", async (req, res): Promise<void> => {
  const params = CreateCreditPaymentParams.safeParse(req.params);
  const parsed = CreateCreditPaymentBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Datos inválidos para el abono." });
    return;
  }
  const [sale] = await getDb().select().from(salesTable)
    .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)));
  if (!sale) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }
  const [payment] = await getDb().insert(creditPaymentsTable).values({
    companyId: req.companyId!,
    saleId: sale.id,
    userId: req.userId!,
    amount: parsed.data.amount,
    paymentMethod: parsed.data.paymentMethod?.trim() || null,
    note: parsed.data.note?.trim() || null,
    createdAt: parsed.data.date ? new Date(parsed.data.date) : undefined,
  }).returning();
  res.status(201).json(CreateCreditPaymentResponse.parse(creditPaymentResponse(payment)));
});

router.get("/sales/:id/credit-payments", async (req, res): Promise<void> => {
  const params = ListCreditPaymentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "ID de venta inválido." });
    return;
  }
  const payments = await getDb().select().from(creditPaymentsTable)
    .where(and(eq(creditPaymentsTable.saleId, params.data.id), eq(creditPaymentsTable.companyId, req.companyId!)))
    .orderBy(desc(creditPaymentsTable.createdAt));
  res.json(ListCreditPaymentsResponse.parse(payments.map(creditPaymentResponse)));
});

export default router;
