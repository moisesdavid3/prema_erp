import { Router, type IRouter } from "express";
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb, suppliersTable, productsTable } from "@workspace/db";
import {
  CreateSupplierBody,
  CreateSupplierResponse,
  ListSuppliersResponse,
  UpdateSupplierBody,
  UpdateSupplierResponse,
  DeleteSupplierBody,
  DeleteSupplierResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { nextSupplierCode } from "../lib/inventory-service";

const router: IRouter = Router();
router.use("/suppliers", requireAuth, requireCompany);

function normalize(name: string): string {
  return name.trim();
}

router.get("/suppliers", async (req, res): Promise<void> => {
  const companyId = req.companyId!;
  const db = getDb();
  const [tableRows, productRows] = await Promise.all([
    db
      .select({ id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name, contact: suppliersTable.contact, phone: suppliersTable.phone, city: suppliersTable.city })
      .from(suppliersTable)
      .where(eq(suppliersTable.companyId, companyId))
      .orderBy(asc(suppliersTable.name)),
    db
      .selectDistinct({ name: productsTable.supplier })
      .from(productsTable)
      .where(and(eq(productsTable.companyId, companyId), ne(productsTable.supplier, ""))),
  ]);
  const productMap = new Map<string, { id: number | null; code: string | null; contact: string | null; phone: string | null; city: string | null }>();
  for (const r of productRows) {
    const name = r.name ? normalize(r.name) : "";
    if (name) productMap.set(name, { id: null, code: null, contact: null, phone: null, city: null });
  }
  for (const r of tableRows) {
    const name = normalize(r.name);
    if (name) productMap.set(name, { id: r.id, code: r.code, contact: r.contact, phone: r.phone, city: r.city });
  }
  const result = [...productMap.entries()]
    .map(([name, v]) => ({ id: v.id, code: v.code, name, contact: v.contact, phone: v.phone, city: v.city }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(ListSuppliersResponse.parse(result));
});

router.post("/suppliers", async (req, res): Promise<void> => {
  const parsed = CreateSupplierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Escribe el nombre del proveedor." });
    return;
  }
  const name = normalize(parsed.data.name);
  const contact = parsed.data.contact ? normalize(parsed.data.contact) : null;
  const phone = parsed.data.phone ? normalize(parsed.data.phone) : null;
  const city = parsed.data.city ? normalize(parsed.data.city) : null;
  const db = getDb();
  const [existing] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, req.companyId!), eq(suppliersTable.name, name)));
  if (existing) {
    res.status(400).json({ error: "Ese proveedor ya existe." });
    return;
  }
  const code = await nextSupplierCode();
  const [created] = await db
    .insert(suppliersTable)
    .values({ companyId: req.companyId!, name, code, contact, phone, city })
    .returning();
  res.status(201).json(CreateSupplierResponse.parse({ id: created.id, code: created.code, name: created.name, contact: created.contact, phone: created.phone, city: created.city }));
});

router.patch("/suppliers", async (req, res): Promise<void> => {
  const parsed = UpdateSupplierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Indica el proveedor a actualizar." });
    return;
  }
  const name = normalize(parsed.data.name);
  const newName = parsed.data.newName ? normalize(parsed.data.newName) : null;
  const contact = typeof parsed.data.contact === "string" ? (parsed.data.contact.trim() || null) : null;
  const phone = typeof parsed.data.phone === "string" ? (parsed.data.phone.trim() || null) : null;
  const city = typeof parsed.data.city === "string" ? (parsed.data.city.trim() || null) : null;
  const companyId = req.companyId!;
  const db = getDb();
  const targetName = newName && newName !== name ? newName : name;

  const [sourceRow] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, companyId), eq(suppliersTable.name, name)));

  if (newName && newName !== name) {
    const [conflict] = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(and(eq(suppliersTable.companyId, companyId), eq(suppliersTable.name, newName), sourceRow ? ne(suppliersTable.id, sourceRow.id) : undefined));
    if (conflict) {
      res.status(400).json({ error: "Ya existe un proveedor con ese nombre." });
      return;
    }
  }

  const rename = newName && newName !== name;
  const hasDetails = contact !== null || phone !== null || city !== null;

  if (rename) {
    await db
      .update(productsTable)
      .set({ supplier: targetName, supplierId: sourceRow?.id ?? null })
      .where(and(eq(productsTable.companyId, companyId), eq(productsTable.supplier, name)));
  }

  let row = sourceRow;
  if (row) {
    await db
      .update(suppliersTable)
      .set({ name: targetName, contact, phone, city })
      .where(and(eq(suppliersTable.id, row.id), eq(suppliersTable.companyId, companyId)));
  } else if (hasDetails || rename) {
    const [created] = await db
      .insert(suppliersTable)
      .values({ companyId, name: targetName, contact, phone, city })
      .onConflictDoNothing({ target: [suppliersTable.companyId, suppliersTable.name] })
      .returning({ id: suppliersTable.id, code: suppliersTable.code, name: suppliersTable.name, contact: suppliersTable.contact, phone: suppliersTable.phone, city: suppliersTable.city });
    if (created) row = { id: created.id };
  }

  const [finalRow] = await db
    .select({ id: suppliersTable.id, code: suppliersTable.code, contact: suppliersTable.contact, phone: suppliersTable.phone, city: suppliersTable.city })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, companyId), eq(suppliersTable.name, targetName)));
  res.json(UpdateSupplierResponse.parse({ id: finalRow?.id ?? null, code: finalRow?.code ?? null, name: targetName, contact: finalRow?.contact ?? null, phone: finalRow?.phone ?? null, city: finalRow?.city ?? null }));
});

router.delete("/suppliers", async (req, res): Promise<void> => {
  const parsed = DeleteSupplierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Indica el proveedor a borrar." });
    return;
  }
  const name = normalize(parsed.data.name);
  const companyId = req.companyId!;
  const db = getDb();

  const [sourceSup] = await db
    .select({ id: suppliersTable.id })
    .from(suppliersTable)
    .where(and(eq(suppliersTable.companyId, companyId), eq(suppliersTable.name, name)));
  if (sourceSup) {
    await db
      .delete(suppliersTable)
      .where(and(eq(suppliersTable.id, sourceSup.id), eq(suppliersTable.companyId, companyId)));
  }

  const updated = await db
    .update(productsTable)
    .set({ supplier: "", supplierId: null })
    .where(and(eq(productsTable.companyId, companyId), eq(productsTable.supplier, name)))
    .returning({ id: productsTable.id });

  res.json(DeleteSupplierResponse.parse({ updatedProducts: updated.length }));
});

export default router;