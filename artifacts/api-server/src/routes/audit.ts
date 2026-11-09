import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { getDb, inventoryMovementsTable, productsTable, saleItemsTable, salesTable } from "@workspace/db";
import { GetAuditProductTurnoverResponse, GetAuditSalesByMonthResponse, GetAuditTopProductsResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { endOfDayBogota, saleWhere, startOfDayBogota } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/audit", requireAuth, requireCompany);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Las ventas viejas guardaron el nombre ya con el contenido («Pan x 400gr»); se quita para no mostrarlo dos veces. */
function stripContentSuffix(name: string, content: string | null): string {
  if (!content) return name;
  const suffix = ` x ${content}`.toLowerCase();
  return name.toLowerCase().endsWith(suffix) ? name.slice(0, name.length - suffix.length) : name;
}

/** Lee ?from y ?to (YYYY-MM-DD, hora de Colombia) y devuelve el rango o un mensaje de error. */
function parseRange(query: Record<string, unknown>): { from?: Date; to?: Date } | { error: string } {
  const fromStr = typeof query.from === "string" && query.from ? query.from : undefined;
  const toStr = typeof query.to === "string" && query.to ? query.to : undefined;
  if ((fromStr && !DATE_RE.test(fromStr)) || (toStr && !DATE_RE.test(toStr))) {
    return { error: "Revisa las fechas (formato AAAA-MM-DD)." };
  }
  const from = fromStr ? startOfDayBogota(new Date(`${fromStr}T12:00:00-05:00`)) : undefined;
  const to = toStr ? endOfDayBogota(new Date(`${toStr}T12:00:00-05:00`)) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) {
    return { error: "El rango de fechas no es válido." };
  }
  return { from, to };
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// Ventas totales por mes. Mismas definiciones que el reporte de ventas:
// total vendido = ventas de productos (sin el domicilio) y utilidad = (precio − costo) × cantidad.
router.get("/audit/sales-by-month", async (req, res): Promise<void> => {
  const range = parseRange(req.query);
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return;
  }
  const monthExpr = sql<string>`to_char(${salesTable.createdAt} at time zone 'America/Bogota', 'YYYY-MM')`;
  const rows = await getDb()
    .select({
      month: monthExpr,
      saleCount: sql<number>`count(*)::int`,
      itemCount: sql<number>`coalesce(sum(${salesTable.totalItems}), 0)::int`,
      totalSold: sql<number>`coalesce(sum(${salesTable.total} - case when ${salesTable.isDelivery} then ${salesTable.deliveryCost} else 0 end), 0)::bigint`,
      estimatedProfit: sql<number>`coalesce(sum(${salesTable.estimatedProfit}), 0)::bigint`,
    })
    .from(salesTable)
    .where(saleWhere(req.companyId!, range))
    .groupBy(monthExpr)
    .orderBy(monthExpr);

  // Ventas registradas con costo 0: la utilidad de esos meses queda sobreestimada.
  const noCostRows = await getDb()
    .select({
      month: monthExpr,
      revenueWithoutCost: sql<number>`coalesce(sum(${saleItemsTable.subtotal}), 0)::bigint`,
    })
    .from(saleItemsTable)
    .innerJoin(salesTable, sql`${saleItemsTable.saleId} = ${salesTable.id}`)
    .where(and(saleWhere(req.companyId!, range), eq(saleItemsTable.unitCost, 0)))
    .groupBy(monthExpr);
  const noCostByMonth = new Map(noCostRows.map((r) => [r.month, Number(r.revenueWithoutCost)]));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const months: { month: string; saleCount: number; itemCount: number; totalSold: number; estimatedProfit: number; averageTicket: number; revenueWithoutCost: number }[] = [];
  if (rows.length > 0) {
    // Rellena los meses sin ventas para que la serie sea continua.
    const last = rows[rows.length - 1].month;
    for (let m = rows[0].month; m <= last; m = nextMonth(m)) {
      const r = byMonth.get(m);
      const saleCount = Number(r?.saleCount ?? 0);
      const totalSold = Number(r?.totalSold ?? 0);
      months.push({
        month: m,
        saleCount,
        itemCount: Number(r?.itemCount ?? 0),
        totalSold,
        estimatedProfit: Number(r?.estimatedProfit ?? 0),
        averageTicket: saleCount > 0 ? Math.round(totalSold / saleCount) : 0,
        revenueWithoutCost: noCostByMonth.get(m) ?? 0,
      });
    }
  }
  res.json(GetAuditSalesByMonthResponse.parse({
    months,
    totalSold: months.reduce((s, m) => s + m.totalSold, 0),
    estimatedProfit: months.reduce((s, m) => s + m.estimatedProfit, 0),
    saleCount: months.reduce((s, m) => s + m.saleCount, 0),
    itemCount: months.reduce((s, m) => s + m.itemCount, 0),
    revenueWithoutCost: months.reduce((s, m) => s + m.revenueWithoutCost, 0),
  }));
});

// Productos más rentables: utilidad estimada = Σ (precio − costo) × cantidad, con el costo vigente al momento de cada venta.
router.get("/audit/top-products", async (req, res): Promise<void> => {
  const range = parseRange(req.query);
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return;
  }
  const excludeNoCost = req.query.excludeNoCost === "true";
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 25;
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200 ? rawLimit : 25;

  const rows = await getDb()
    .select({
      productId: saleItemsTable.productId,
      name: sql<string>`max(${saleItemsTable.productName})`,
      code: sql<string | null>`max(${saleItemsTable.productCode})`,
      content: sql<string | null>`max(${saleItemsTable.productContent})`,
      currentName: sql<string | null>`max(${productsTable.name})`,
      currentCode: sql<string | null>`max(${productsTable.code})`,
      currentContent: sql<string | null>`max(${productsTable.content})`,
      unitsSold: sql<number>`coalesce(sum(${saleItemsTable.quantity}), 0)::bigint`,
      revenue: sql<number>`coalesce(sum(${saleItemsTable.subtotal}), 0)::bigint`,
      cost: sql<number>`coalesce(sum(${saleItemsTable.unitCost} * ${saleItemsTable.quantity}), 0)::bigint`,
      unitsWithCost: sql<number>`coalesce(sum(${saleItemsTable.quantity}) filter (where ${saleItemsTable.unitCost} > 0), 0)::bigint`,
      revenueWithCost: sql<number>`coalesce(sum(${saleItemsTable.subtotal}) filter (where ${saleItemsTable.unitCost} > 0), 0)::bigint`,
    })
    .from(saleItemsTable)
    .innerJoin(salesTable, sql`${saleItemsTable.saleId} = ${salesTable.id}`)
    .leftJoin(productsTable, sql`${saleItemsTable.productId} = ${productsTable.id}`)
    .where(saleWhere(req.companyId!, range))
    .groupBy(saleItemsTable.productId);

  const all = rows.map((r) => {
    const revenueAll = Number(r.revenue);
    const revenueWithCost = Number(r.revenueWithCost);
    const cost = Number(r.cost); // los ítems sin costo aportan 0 al costo
    // Con excludeNoCost solo cuentan las ventas con costo registrado.
    const revenue = excludeNoCost ? revenueWithCost : revenueAll;
    const units = excludeNoCost ? Number(r.unitsWithCost) : Number(r.unitsSold);
    const profit = revenue - cost;
    return {
      productId: r.productId,
      // Se usa el nombre vigente del producto; si ya no existe, el que quedó guardado en la venta.
      code: r.currentCode || r.code || null,
      name: r.currentName ?? stripContentSuffix(r.name, r.content),
      content: (r.currentName != null ? r.currentContent : r.content) || null,
      unitsSold: units,
      revenue,
      cost,
      profit,
      marginPercent: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      revenueWithoutCost: revenueAll - revenueWithCost,
    };
  });
  const products = (excludeNoCost ? all.filter((p) => p.revenue > 0) : all)
    .sort((a, b) => b.profit - a.profit || b.revenue - a.revenue);

  res.json(GetAuditTopProductsResponse.parse({
    products: products.slice(0, limit),
    productCount: products.length,
    totalRevenue: products.reduce((s, p) => s + p.revenue, 0),
    totalProfit: products.reduce((s, p) => s + p.profit, 0),
    revenueWithoutCost: all.reduce((s, p) => s + p.revenueWithoutCost, 0),
  }));
});

const bogotaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" });
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rotación de productos.
 *  - rotación = unidades vendidas ÷ existencia promedio del período, ponderada por el tiempo que estuvo cada nivel
 *    (las existencias negativas cuentan como 0 y el promedio no baja de 1 unidad, para que un producto casi siempre
 *    agotado no dispare el indicador);
 *  - la existencia al inicio se reconstruye desde la existencia actual restando los movimientos desde esa fecha,
 *    así no depende de huecos antiguos en el historial;
 *  - días de inventario = existencia actual ÷ unidades vendidas por día.
 * Mayor rotación: productos activos con al menos 3 unidades vendidas en el período. Menor rotación: productos activos con
 * existencia hoy, empezando por los que no vendieron nada (primero los de más capital inmovilizado).
 */
router.get("/audit/product-turnover", async (req, res): Promise<void> => {
  const parsed = parseRange(req.query);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const now = new Date();
  const to = parsed.to ?? endOfDayBogota(now);
  const from = parsed.from ?? startOfDayBogota(new Date(to.getTime() - 89 * DAY_MS));
  if (from > to) {
    res.status(400).json({ error: "El rango de fechas no es válido." });
    return;
  }
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 15;
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 15;
  const companyId = req.companyId!;
  const db = getDb();

  const [products, soldRows, lastSaleRows, moveRows] = await Promise.all([
    db.select().from(productsTable).where(and(eq(productsTable.companyId, companyId), eq(productsTable.active, true))),
    db.select({ productId: saleItemsTable.productId, units: sql<number>`coalesce(sum(${saleItemsTable.quantity}), 0)::bigint` })
      .from(saleItemsTable)
      .innerJoin(salesTable, sql`${saleItemsTable.saleId} = ${salesTable.id}`)
      .where(saleWhere(companyId, { from, to }))
      .groupBy(saleItemsTable.productId),
    db.select({ productId: saleItemsTable.productId, last: sql<Date>`max(${salesTable.createdAt})` })
      .from(saleItemsTable)
      .innerJoin(salesTable, sql`${saleItemsTable.saleId} = ${salesTable.id}`)
      .where(eq(salesTable.companyId, companyId))
      .groupBy(saleItemsTable.productId),
    db.select({
      productId: inventoryMovementsTable.productId,
      quantity: inventoryMovementsTable.quantity,
      createdAt: inventoryMovementsTable.createdAt,
    })
      .from(inventoryMovementsTable)
      .where(and(eq(inventoryMovementsTable.companyId, companyId), sql`${inventoryMovementsTable.createdAt} >= ${from.toISOString()}::timestamptz`))
      .orderBy(inventoryMovementsTable.createdAt, inventoryMovementsTable.id),
  ]);
  const sold = new Map(soldRows.map((r) => [r.productId, Number(r.units)]));
  const lastSale = new Map(lastSaleRows.map((r) => [r.productId, r.last ? bogotaDay.format(new Date(r.last)) : null]));
  // Movimientos desde el inicio, por producto: los del período sirven para promediar la existencia en el tiempo
  // y todos juntos (incluso los posteriores al fin) para reconstruir la existencia al inicio.
  const movesByProduct = new Map<number, { sinceFrom: number; inRange: { t: number; q: number }[] }>();
  for (const r of moveRows) {
    const entry = movesByProduct.get(r.productId) ?? { sinceFrom: 0, inRange: [] };
    entry.sinceFrom += r.quantity;
    const t = new Date(r.createdAt).getTime();
    if (t <= to.getTime()) entry.inRange.push({ t, q: r.quantity });
    movesByProduct.set(r.productId, entry);
  }
  const span = Math.max(1, to.getTime() - from.getTime());

  const rows = products.map((p) => {
    const m = movesByProduct.get(p.id) ?? { sinceFrom: 0, inRange: [] };
    let level = p.stock - m.sinceFrom;
    let cursor = from.getTime();
    let weighted = 0;
    for (const mv of m.inRange) {
      weighted += Math.max(level, 0) * Math.max(0, mv.t - cursor);
      level += mv.q;
      cursor = Math.max(cursor, mv.t);
    }
    weighted += Math.max(level, 0) * Math.max(0, to.getTime() - cursor);
    const averageStock = weighted / span;
    const unitsSold = sold.get(p.id) ?? 0;
    const unitsPerDay = unitsSold / days;
    return {
      productId: p.id,
      code: p.code || null,
      name: p.name,
      content: p.content || null,
      unitsSold,
      stock: p.stock,
      averageStock: Math.round(averageStock * 10) / 10,
      rotation: Math.round((unitsSold / Math.max(averageStock, 1)) * 100) / 100,
      unitsPerDay: Math.round(unitsPerDay * 100) / 100,
      daysOfInventory: unitsSold > 0 && p.stock > 0 ? Math.round(p.stock / unitsPerDay) : null,
      inventoryCost: Math.max(p.stock, 0) * p.cost,
      lastSaleDate: lastSale.get(p.id) ?? null,
    };
  });

  const highest = rows
    .filter((r) => r.unitsSold >= 3)
    .sort((a, b) => b.rotation - a.rotation || b.unitsSold - a.unitsSold)
    .slice(0, limit);
  const withStock = rows.filter((r) => r.stock > 0);
  const lowest = withStock
    .sort((a, b) => a.rotation - b.rotation || b.inventoryCost - a.inventoryCost)
    .slice(0, limit);
  const withoutSales = withStock.filter((r) => r.unitsSold === 0);

  res.json(GetAuditProductTurnoverResponse.parse({
    from: bogotaDay.format(from),
    to: bogotaDay.format(to),
    days,
    highest,
    lowest,
    productsWithSales: rows.filter((r) => r.unitsSold > 0).length,
    productsWithoutSales: withoutSales.length,
    withoutSalesInventoryCost: withoutSales.reduce((sum, r) => sum + r.inventoryCost, 0),
  }));
});

export default router;
