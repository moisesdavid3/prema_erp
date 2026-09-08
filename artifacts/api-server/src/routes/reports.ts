import { Router, type IRouter } from "express";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb, inventoryMovementsTable, productsTable } from "@workspace/db";
import {
  GetInventoryReportQueryParams,
  GetInventoryReportResponse,
  GetSalesReportQueryParams,
  GetSalesReportResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { dateRangeForPeriod, ensureSeeded, productResponse, salesReportData, endOfDayBogota } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/reports", requireAuth, requireCompany);

router.get("/reports/inventory", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSeeded(userId);
  const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
  const asOfStr = typeof req.query.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf) ? req.query.asOf : undefined;
  const asOf = asOfStr ? new Date(`${asOfStr}T12:00:00-05:00`) : undefined;
  const parsed = GetInventoryReportQueryParams.safeParse({ filter, asOf });
  if (!parsed.success) {
    res.status(400).json({ error: "El filtro no es válido." });
    return;
  }
  const rows = await getDb().select().from(productsTable)
    .where(eq(productsTable.companyId, req.companyId!));

  let stockOverrides = new Map<number, number>();
  if (asOf) {
    const cutoff = endOfDayBogota(asOf);
    const productIds = rows.map((p) => p.id);
    const after = productIds.length
      ? await getDb()
          .select({ productId: inventoryMovementsTable.productId, total: sql<number>`coalesce(sum(${inventoryMovementsTable.quantity}), 0)` })
          .from(inventoryMovementsTable)
          .where(and(
            eq(inventoryMovementsTable.companyId, req.companyId!),
            inArray(inventoryMovementsTable.productId, productIds),
            gt(inventoryMovementsTable.createdAt, cutoff),
          ))
          .groupBy(inventoryMovementsTable.productId)
      : [];
    stockOverrides = new Map(after.map((r) => [r.productId, r.productId != null ? (rows.find((p) => p.id === r.productId)?.stock ?? 0) - r.total : 0]));
  }

  const products = rows.map((product) => {
    const stock = asOf ? (stockOverrides.get(product.id) ?? product.stock) : product.stock;
    return { product, stock };
  }).filter(({ product, stock }) => {
    if (parsed.data.filter === "low") return stock <= product.minimumStock;
    if (parsed.data.filter === "empty") return stock === 0;
    return true;
  });

  const response = {
    products: products.map(({ product, stock }) => ({ ...productResponse(product), stock })),
    totalCostValue: products.reduce((sum, { product, stock }) => sum + product.cost * stock, 0),
    totalSaleValue: products.reduce((sum, { product, stock }) => sum + product.salePrice * stock, 0),
    potentialProfit: products.reduce((sum, { product, stock }) => sum + (product.salePrice - product.cost) * stock, 0),
  };
  res.json(GetInventoryReportResponse.parse(response));
});

router.get("/reports/sales", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const period = typeof req.query.period === "string" ? req.query.period : "all";
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
  const parsed = GetSalesReportQueryParams.safeParse({ period, from, to });
  if (!parsed.success || (from && Number.isNaN(from.valueOf())) || (to && Number.isNaN(to.valueOf()))) {
    res.status(400).json({ error: "El período no es válido." });
    return;
  }
  const range = dateRangeForPeriod(parsed.data.period, from, to);
  res.json(GetSalesReportResponse.parse(await salesReportData(userId, req.companyId!, req.userEmail, range)));
});

export default router;
