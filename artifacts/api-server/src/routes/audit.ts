import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { getDb, saleItemsTable, salesTable } from "@workspace/db";
import { GetAuditSalesByMonthResponse, GetAuditTopProductsResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { endOfDayBogota, saleWhere, startOfDayBogota } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/audit", requireAuth, requireCompany);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      unitsSold: sql<number>`coalesce(sum(${saleItemsTable.quantity}), 0)::bigint`,
      revenue: sql<number>`coalesce(sum(${saleItemsTable.subtotal}), 0)::bigint`,
      cost: sql<number>`coalesce(sum(${saleItemsTable.unitCost} * ${saleItemsTable.quantity}), 0)::bigint`,
      unitsWithCost: sql<number>`coalesce(sum(${saleItemsTable.quantity}) filter (where ${saleItemsTable.unitCost} > 0), 0)::bigint`,
      revenueWithCost: sql<number>`coalesce(sum(${saleItemsTable.subtotal}) filter (where ${saleItemsTable.unitCost} > 0), 0)::bigint`,
    })
    .from(saleItemsTable)
    .innerJoin(salesTable, sql`${saleItemsTable.saleId} = ${salesTable.id}`)
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
      code: r.code || null,
      name: r.name,
      content: r.content || null,
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

export default router;
