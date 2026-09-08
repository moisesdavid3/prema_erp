import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { getDb, inventoryMovementsTable, inventoryUserSettingsTable, productsTable } from "@workspace/db";
import {
  AddInventoryBody,
  AddInventoryParams,
  AddInventoryResponse,
  CreateProductBody,
  CreateProductResponse,
  ListProductsResponse,
  UpdateDeudaMoisesBody,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import {
  ensureSeeded,
  deleteProduct,
  isOwner,
  listAllProducts,
  nextProductCode,
  productResponse,
  resolveSupplier,
  resolveUserIdByEmail,
  TERE_EMAIL,
} from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/products", requireAuth, requireCompany);

router.get("/products", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await ensureSeeded(userId);
  const rows = await listAllProducts(req.companyId!);
  res.json(ListProductsResponse.parse(rows.map(productResponse)));
});

router.post("/products", async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Revisa los datos del producto e inténtalo nuevamente." });
    return;
  }
  const userId = isOwner(req.userEmail)
    ? ((await resolveUserIdByEmail(TERE_EMAIL)) ?? req.userId!)
    : req.userId!;
  const supplierName = parsed.data.supplier?.trim() || null;
  const supplierId = await resolveSupplier(req.companyId!, supplierName);
  const code = await nextProductCode(req.companyId!);
  const initialStockDate = parsed.data.initialStockDate ?? new Date();
  const [product] = await getDb().transaction(async (tx) => {
    const [created] = await tx.insert(productsTable).values({
      companyId: req.companyId!,
      userId,
      name: parsed.data.name.trim(),
      code,
      supplier: supplierName,
      supplierId,
      category: parsed.data.category?.trim() || null,
      content: parsed.data.content?.trim() || null,
      description: parsed.data.description?.trim() || null,
      cost: parsed.data.cost,
      salePrice: parsed.data.salePrice,
      stock: parsed.data.initialStock,
      minimumStock: parsed.data.minimumStock ?? 5,
    }).returning();
    await tx.insert(inventoryMovementsTable).values({
      companyId: req.companyId!,
      userId,
      productId: created.id,
      type: "entrada",
      quantity: created.stock,
      stockBefore: 0,
      stockAfter: created.stock,
      note: "Inventario inicial",
      createdAt: initialStockDate,
    });
    return [created];
  });
  res.status(201).json(CreateProductResponse.parse(productResponse(product)));
});

router.patch("/products/:id", async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  const parsed = UpdateProductBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Revisa los datos e inténtalo nuevamente." });
    return;
  }
  const { stock: nextStock, ...rest } = parsed.data;
  const [current] = await getDb().select().from(productsTable)
    .where(and(eq(productsTable.id, params.data.id), eq(productsTable.companyId, req.companyId!)));
  if (!current) {
    res.status(404).json({ error: "No encontramos ese producto." });
    return;
  }
  const supplierName = rest.supplier !== undefined
    ? rest.supplier?.trim() || null
    : current.supplier ?? null;
  const supplierId = rest.supplier !== undefined
    ? await resolveSupplier(req.companyId!, supplierName)
    : current.supplierId;
  const updated = await getDb().transaction(async (tx) => {
    const [row] = await tx.update(productsTable)
      .set({
        ...rest,
        ...(nextStock !== undefined ? { stock: nextStock } : {}),
        name: rest.name?.trim(),
        supplier: supplierName,
        supplierId,
        category: rest.category?.trim() || null,
        content: rest.content?.trim() || null,
        description: rest.description?.trim() || null,
        updatedAt: new Date(),
      })
      .where(and(eq(productsTable.id, current.id), eq(productsTable.companyId, req.companyId!)))
      .returning();
    if (nextStock !== undefined && nextStock !== current.stock) {
      await tx.insert(inventoryMovementsTable).values({
        companyId: req.companyId!,
        userId: current.userId,
        productId: current.id,
        type: "ajuste",
        quantity: nextStock - current.stock,
        stockBefore: current.stock,
        stockAfter: nextStock,
        note: "Ajuste manual de existencia",
        createdAt: parsed.data.stockDate ?? new Date(),
      });
    }
    return row;
  });
  if (!updated) {
    res.status(404).json({ error: "No encontramos ese producto." });
    return;
  }
  res.json(UpdateProductResponse.parse(productResponse(updated)));
});

router.post("/products/:id/inventory", async (req, res): Promise<void> => {
  const params = AddInventoryParams.safeParse(req.params);
  const parsed = AddInventoryBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Indica una cantidad válida para agregar." });
    return;
  }
  const result = await getDb().transaction(async (tx) => {
    const [product] = await tx.select().from(productsTable)
      .where(and(eq(productsTable.id, params.data.id), eq(productsTable.companyId, req.companyId!)));
    if (!product) return null;
    const [updated] = await tx.update(productsTable)
      .set({ stock: product.stock + parsed.data.quantity, updatedAt: new Date() })
      .where(eq(productsTable.id, product.id))
      .returning();
    await tx.insert(inventoryMovementsTable).values({
      companyId: req.companyId!,
      userId: product.userId,
      productId: product.id,
      type: "entrada",
      quantity: parsed.data.quantity,
      stockBefore: product.stock,
      stockAfter: updated.stock,
      note: parsed.data.note?.trim() || null,
      createdAt: parsed.data.date ?? new Date(),
    });
    return updated;
  });
  if (!result) {
    res.status(404).json({ error: "No encontramos ese producto." });
    return;
  }
  res.json(AddInventoryResponse.parse(productResponse(result)));
});

router.delete("/products/demo", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await getDb().transaction(async (tx) => {
    const demoProducts = await tx.select({ id: productsTable.id })
      .from(productsTable)
      .where(and(
        eq(productsTable.userId, userId),
        eq(productsTable.companyId, req.companyId!),
        eq(productsTable.isDemo, true),
      ));
    if (demoProducts.length > 0) {
      const ids = demoProducts.map(({ id }) => id);
      for (const id of ids) {
        await tx.delete(inventoryMovementsTable).where(and(
          eq(inventoryMovementsTable.companyId, req.companyId!),
          eq(inventoryMovementsTable.productId, id),
        ));
        await tx.delete(productsTable).where(and(
          eq(productsTable.userId, userId),
          eq(productsTable.companyId, req.companyId!),
          eq(productsTable.id, id),
        ));
      }
    }
    await tx
      .insert(inventoryUserSettingsTable)
      .values({ userId, demoProductsCleared: true, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: inventoryUserSettingsTable.userId,
        set: { demoProductsCleared: true, updatedAt: new Date() },
      });
  });
  res.sendStatus(204);
});

router.delete("/products/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Indica un id de producto válido." });
    return;
  }
  const deleted = await deleteProduct(id, req.companyId!);
  if (!deleted) {
    res.status(404).json({ error: "No encontramos ese producto." });
    return;
  }
  res.sendStatus(204);
});

router.get("/dashboard", requireAuth, requireCompany, async (req, res): Promise<void> => {
  const { dashboardData } = await import("../lib/inventory-service");
  res.json(await dashboardData(req.userId!, req.companyId!, req.userEmail));
});

router.patch("/dashboard", requireAuth, requireCompany, async (req, res): Promise<void> => {
  const { DEBT_OWNER_EMAIL, setDeudaMoises } = await import("../lib/inventory-service");
  if (req.userEmail !== DEBT_OWNER_EMAIL) {
    res.status(403).json({ error: "Solo el dueño puede actualizar la deuda." });
    return;
  }
  const parsed = UpdateDeudaMoisesBody.safeParse(req.body);
  if (!parsed.success || !Number.isFinite(parsed.data.value) || parsed.data.value < 0) {
    res.status(400).json({ error: "Escribe un valor de deuda válido." });
    return;
  }
  await setDeudaMoises(req.companyId!, Math.round(parsed.data.value), req.userEmail);
  res.sendStatus(204);
});

export default router;
