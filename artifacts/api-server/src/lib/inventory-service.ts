import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  appSettingsTable,
  clientsTable,
  creditPaymentsTable,
  getDb,
  inventoryMovementsTable,
  inventoryUserSettingsTable,
  manualCreditsTable,
  productsTable,
  purchaseItemsTable,
  purchasesTable,
  saleItemsTable,
  salesTable,
  suppliersTable,
} from "@workspace/db";

export type DateRange = { from?: Date; to?: Date };

export const OWNER_EMAIL = "moisesdavid3@gmail.com";
export const DEBT_OWNER_EMAIL = OWNER_EMAIL;
export const TERE_EMAIL = "teregaloza@gmail.com";
const DEBT_SETTING_KEY = "deuda_moises_david";

export function isOwner(userEmail?: string): boolean {
  return userEmail === OWNER_EMAIL;
}

const userIdByEmailCache = new Map<string, string>();

export async function resolveUserIdByEmail(email: string): Promise<string | undefined> {
  const cached = userIdByEmailCache.get(email);
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return undefined;
  try {
    const res = await fetch(`${url}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { users?: { id: string; email?: string }[] };
    const found = data.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    const id = found?.id;
    if (id) userIdByEmailCache.set(email, id);
    return id;
  } catch {
    return undefined;
  }
}

export async function nextSupplierCode(): Promise<string> {
  const rows = await getDb()
    .select({ code: suppliersTable.code })
    .from(suppliersTable);
  let max = 0;
  for (const { code } of rows) {
    const match = /^PRV-(\d+)$/.exec(code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PRV-${String(max + 1).padStart(3, "0")}`;
}

export function productCodePrefix(companyId: number): string {
  return companyId === 1 ? 'T' : 'P';
}

export async function maxProductCodeNumber(companyId: number): Promise<number> {
  const prefix = productCodePrefix(companyId);
  const rows = await getDb()
    .select({ code: productsTable.code })
    .from(productsTable)
    .where(eq(productsTable.companyId, companyId));
  let max = 0;
  for (const { code } of rows) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export async function nextProductCode(companyId: number): Promise<string> {
  const prefix = productCodePrefix(companyId);
  return `${prefix}-${String((await maxProductCodeNumber(companyId)) + 1).padStart(3, "0")}`;
}

export async function nextClientCode(): Promise<string> {
  const rows = await getDb()
    .select({ code: clientsTable.code })
    .from(clientsTable);
  let max = 0;
  for (const { code } of rows) {
    const match = /^CL-(\d+)$/.exec(code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `CL-${String(max + 1).padStart(3, "0")}`;
}

export async function resolveClient(companyId: number, name: string, userId: string, phone?: string | null): Promise<typeof clientsTable.$inferSelect | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const [existing] = await getDb()
    .select()
    .from(clientsTable)
    .where(and(eq(clientsTable.companyId, companyId), eq(clientsTable.name, trimmed)));
  if (existing) return existing;
  const code = await nextClientCode();
  const [created] = await getDb()
    .insert(clientsTable)
    .values({ companyId, userId, name: trimmed, code, phone: phone?.trim() || null })
    .returning();
  return created ?? null;
}

export async function resolveSupplier(companyId: number, name?: string | null): Promise<number | null> {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const [existing] = await getDb()
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, companyId), eq(suppliersTable.name, trimmed)));
  if (existing) return existing.id;
  const code = await nextSupplierCode();
  const [created] = await getDb()
    .insert(suppliersTable)
    .values({ companyId, name: trimmed, code })
    .returning({ id: suppliersTable.id });
  return created?.id ?? null;
}

export async function listAllProducts(companyId: number) {
  return getDb().select().from(productsTable)
    .where(eq(productsTable.companyId, companyId));
}

export async function getDeudaMoises(companyId: number): Promise<number> {
  const [row] = await getDb().select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(
      eq(appSettingsTable.companyId, companyId),
      eq(appSettingsTable.key, DEBT_SETTING_KEY),
    ));
  return row?.value ?? 0;
}

export async function setDeudaMoises(companyId: number, value: number, updatedBy: string): Promise<void> {
  await getDb().insert(appSettingsTable)
    .values({ companyId, key: DEBT_SETTING_KEY, value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appSettingsTable.companyId, appSettingsTable.key],
      set: { value, updatedBy, updatedAt: new Date() },
    });
}

export function productResponse(product: typeof productsTable.$inferSelect) {
  return {
    id: product.id,
    name: product.name,
    code: product.code || undefined,
    supplier: product.supplier ?? undefined,
    supplierId: product.supplierId ?? null,
    category: product.category ?? undefined,
    content: product.content ?? undefined,
    description: product.description ?? undefined,
    cost: product.cost,
    salePrice: product.salePrice,
    stock: product.stock,
    minimumStock: product.minimumStock,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export async function deleteProduct(productId: number, companyId: number): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [product] = await tx.select({ id: productsTable.id, userId: productsTable.userId }).from(productsTable)
      .where(and(eq(productsTable.id, productId), eq(productsTable.companyId, companyId)));
    if (!product) return false;
    await tx.delete(inventoryMovementsTable).where(and(
      eq(inventoryMovementsTable.companyId, companyId),
      eq(inventoryMovementsTable.productId, productId),
    ));
    await tx.delete(productsTable).where(and(
      eq(productsTable.id, productId),
      eq(productsTable.companyId, companyId),
    ));
    const [remaining] = await tx
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(and(
        eq(productsTable.userId, product.userId),
        eq(productsTable.companyId, companyId),
      ))
      .limit(1);
    if (!remaining) {
      await tx
        .insert(inventoryUserSettingsTable)
        .values({ userId: product.userId, demoProductsCleared: true, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: inventoryUserSettingsTable.userId,
          set: { demoProductsCleared: true, updatedAt: new Date() },
        });
    }
    return true;
  });
}

export async function ensureSeeded(_userId: string): Promise<void> {
  return;
}

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

function bogotaParts(date: Date) {
  const shifted = new Date(date.getTime() - BOGOTA_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

function bogotaDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms) + BOGOTA_OFFSET_MS);
}

export function startOfDayBogota(date: Date): Date {
  const { year, month, day } = bogotaParts(date);
  return bogotaDate(year, month, day);
}

export function endOfDayBogota(date: Date): Date {
  const { year, month, day } = bogotaParts(date);
  return bogotaDate(year, month, day, 23, 59, 59, 999);
}

export function dateRangeForPeriod(period: string, from?: Date, to?: Date): DateRange {
  const now = new Date();
  if (from || to) return { from, to };
  if (period === "today") return { from: startOfDayBogota(now), to: endOfDayBogota(now) };
  if (period === "last7") {
    const start = new Date(startOfDayBogota(now).getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: start, to: endOfDayBogota(now) };
  }
  if (period === "thisMonth") {
    const { year, month } = bogotaParts(now);
    return { from: bogotaDate(year, month, 1), to: endOfDayBogota(now) };
  }
  if (period === "previousMonth") {
    const { year, month } = bogotaParts(now);
    return {
      from: bogotaDate(year, month - 1, 1),
      to: endOfDayBogota(bogotaDate(year, month, 0)),
    };
  }
  return {};
}

export function saleWhere(companyId: number, range: DateRange) {
  const conditions = [eq(salesTable.companyId, companyId)];
  if (range.from) conditions.push(gte(salesTable.createdAt, range.from));
  if (range.to) conditions.push(lte(salesTable.createdAt, range.to));
  return and(...conditions);
}

export function purchaseWhere(companyId: number, range: DateRange) {
  const conditions = [eq(purchasesTable.companyId, companyId)];
  if (range.from) conditions.push(gte(purchasesTable.purchaseDate, range.from));
  if (range.to) conditions.push(lte(purchasesTable.purchaseDate, range.to));
  return and(...conditions);
}

export function paymentWhere(companyId: number, range: DateRange) {
  const conditions = [eq(creditPaymentsTable.companyId, companyId)];
  if (range.from) conditions.push(gte(creditPaymentsTable.createdAt, range.from));
  if (range.to) conditions.push(lte(creditPaymentsTable.createdAt, range.to));
  return and(...conditions);
}

export function toPurchaseResponse(purchase: typeof purchasesTable.$inferSelect, items: typeof purchaseItemsTable.$inferSelect[]) {
  return {
    id: purchase.id,
    date: purchase.purchaseDate,
    supplier: purchase.supplier ?? null,
    supplierId: purchase.supplierId ?? null,
    invoiceNumber: purchase.invoiceNumber ?? null,
    total: purchase.total,
    totalItems: purchase.totalItems,
    items: items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      productCode: item.productCode ?? null,
      quantity: item.quantity,
      unitCost: item.unitCost,
      subtotal: item.subtotal,
    })),
  };
}

export async function purchaseResponse(purchase: typeof purchasesTable.$inferSelect) {
  const items = await getDb()
    .select()
    .from(purchaseItemsTable)
    .where(eq(purchaseItemsTable.purchaseId, purchase.id));
  return toPurchaseResponse(purchase, items);
}

async function creditPaidForSale(saleId: number): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${creditPaymentsTable.amount}), 0)` })
    .from(creditPaymentsTable)
    .where(eq(creditPaymentsTable.saleId, saleId));
  return Number(row?.total ?? 0);
}

export function toSaleResponse(sale: typeof salesTable.$inferSelect, items: typeof saleItemsTable.$inferSelect[], creditPaid: number) {
  return {
    id: sale.id,
    saleNumber: sale.saleNumber,
    date: sale.createdAt,
    total: sale.total,
    totalItems: sale.totalItems,
    estimatedProfit: sale.estimatedProfit,
    paymentMethod: sale.paymentMethod ?? undefined,
    notes: sale.notes ?? undefined,
    clientName: sale.clientName,
    clientPhone: sale.clientPhone,
    clientId: sale.clientId ?? null,
    clientCode: sale.clientCode ?? null,
    creditPaid,
    companyId: sale.companyId,
    isDelivery: sale.isDelivery,
    deliveryCost: sale.deliveryCost,
    deliveryPaid: sale.deliveryPaid,
    items: items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      productCode: item.productCode ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      unitCost: item.unitCost,
      subtotal: item.subtotal,
    })),
  };
}

export async function saleResponse(sale: typeof salesTable.$inferSelect) {
  const items = await getDb()
    .select()
    .from(saleItemsTable)
    .where(eq(saleItemsTable.saleId, sale.id));
  const creditPaid = sale.paymentMethod === "Crédito" ? await creditPaidForSale(sale.id) : 0;
  return toSaleResponse(sale, items, creditPaid);
}

export async function dashboardData(userId: string, companyId: number, userEmail?: string) {
  await ensureSeeded(userId);
  const products = await listAllProducts(companyId);
  const todayRange = dateRangeForPeriod("today");
  const todaySales = await getDb().select().from(salesTable).where(saleWhere(companyId, todayRange));

  const topRange: DateRange = { from: new Date(Date.now() - 15 * 86400000) };
  const topSales = await getDb().select().from(salesTable).where(saleWhere(companyId, topRange));
  const topSaleIds = topSales.map((s) => s.id);
  const topItems = topSaleIds.length
    ? await getDb().select({ productName: saleItemsTable.productName, quantity: saleItemsTable.quantity }).from(saleItemsTable).where(inArray(saleItemsTable.saleId, topSaleIds))
    : [];
  const topCounts = new Map<string, number>();
  topItems.forEach((item) => topCounts.set(item.productName, (topCounts.get(item.productName) ?? 0) + item.quantity));
  const topProducts = [...topCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));

  return {
    productCount: products.length,
    totalUnits: products.reduce((sum, product) => sum + product.stock, 0),
    inventoryCostValue: products.reduce((sum, product) => sum + product.cost * product.stock, 0),
    inventorySaleValue: products.reduce((sum, product) => sum + product.salePrice * product.stock, 0),
    potentialProfit: products.reduce((sum, product) => sum + (product.salePrice - product.cost) * product.stock, 0),
    todaySalesCount: todaySales.length,
    todaySalesTotal: todaySales.reduce((sum, sale) => sum + sale.total - (sale.isDelivery ? sale.deliveryCost : 0), 0),
    deudaMoisesDavid: await getDeudaMoises(companyId),
    canEditDeudaMoises: userEmail === DEBT_OWNER_EMAIL,
    lowStockProducts: products
      .filter((product) => product.stock <= product.minimumStock)
      .map((product) => ({ id: product.id, name: product.name, stock: product.stock, minimumStock: product.minimumStock })),
    topProducts,
  };
}

export async function salesReportData(userId: string, companyId: number, userEmail: string | undefined, range: DateRange) {
  await ensureSeeded(userId);
  const sales = await getDb().select().from(salesTable).where(saleWhere(companyId, range)).orderBy(sql`${salesTable.createdAt} desc`);
  const saleIds = sales.map((s) => s.id);
  const items = saleIds.length
    ? await getDb().select().from(saleItemsTable).where(inArray(saleItemsTable.saleId, saleIds))
    : [];
  const itemsBySale = new Map<number, typeof items>();
  for (const item of items) {
    const list = itemsBySale.get(item.saleId) ?? [];
    list.push(item);
    itemsBySale.set(item.saleId, list);
  }
  const creditIds = sales.filter((s) => s.paymentMethod === "Crédito").map((s) => s.id);
  const creditRows = creditIds.length
    ? await getDb()
        .select({ saleId: creditPaymentsTable.saleId, total: sql<number>`coalesce(sum(${creditPaymentsTable.amount}), 0)` })
        .from(creditPaymentsTable)
        .where(inArray(creditPaymentsTable.saleId, creditIds))
        .groupBy(creditPaymentsTable.saleId)
    : [];
  const creditBySale = new Map(creditRows.map((r) => [r.saleId, Number(r.total)]));
  const completeSales = sales.map((sale) =>
    toSaleResponse(sale, itemsBySale.get(sale.id) ?? [], sale.paymentMethod === "Crédito" ? creditBySale.get(sale.id) ?? 0 : 0),
  );
  const paymentRows = await getDb().select().from(creditPaymentsTable)
    .where(paymentWhere(companyId, range))
    .orderBy(sql`${creditPaymentsTable.createdAt} desc`);
  const paymentSaleIds = [...new Set(paymentRows.map((p) => p.saleId).filter((v): v is number => v != null))];
  const paymentManualCreditIds = [...new Set(paymentRows.map((p) => p.manualCreditId).filter((v): v is number => v != null))];
  const paymentSaleRows = paymentSaleIds.length
    ? await getDb().select({ id: salesTable.id, clientName: salesTable.clientName }).from(salesTable).where(inArray(salesTable.id, paymentSaleIds))
    : [];
  const paymentCreditRows = paymentManualCreditIds.length
    ? await getDb().select({ id: manualCreditsTable.id, clientName: manualCreditsTable.clientName }).from(manualCreditsTable).where(inArray(manualCreditsTable.id, paymentManualCreditIds))
    : [];
  const clientNameBySale = new Map(paymentSaleRows.map((r) => [r.id, r.clientName]));
  const clientNameByManualCredit = new Map(paymentCreditRows.map((r) => [r.id, r.clientName]));
  const payments = paymentRows.map((p) => ({
    id: p.id,
    saleId: p.saleId,
    manualCreditId: p.manualCreditId,
    amount: p.amount,
    paymentMethod: p.paymentMethod,
    note: p.note,
    date: p.createdAt,
    clientName: p.saleId != null ? (clientNameBySale.get(p.saleId) ?? null) : p.manualCreditId != null ? (clientNameByManualCredit.get(p.manualCreditId) ?? null) : null,
  }));
  const counts = new Map<string, number>();
  completeSales.forEach((sale) => sale.items.forEach((item) => counts.set(item.productName, (counts.get(item.productName) ?? 0) + item.quantity)));
  const bestSellingProduct = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const products = await listAllProducts(companyId);
  return {
    sales: completeSales,
    payments,
    totalSold: completeSales.reduce((sum, sale) => sum + sale.total - (sale.isDelivery ? sale.deliveryCost : 0), 0),
    saleCount: completeSales.length,
    itemCount: completeSales.reduce((sum, sale) => sum + sale.totalItems, 0),
    estimatedProfit: completeSales.reduce((sum, sale) => sum + sale.estimatedProfit, 0),
    bestSellingProduct: bestSellingProduct[0] ?? null,
    bestSellingProductCount: bestSellingProduct[1] || null,
    lowStockProducts: products
      .filter((product) => product.stock <= product.minimumStock)
      .map((product) => ({ id: product.id, name: product.name, stock: product.stock, minimumStock: product.minimumStock })),
  };
}
