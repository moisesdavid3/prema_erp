import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { companiesTable, companyMembersTable, einvoicingNumberingRangesTable, getDb } from "@workspace/db";
import {
  GetNumberingRangeParams,
  ListCompaniesResponse,
  SetNumberingRangeBody,
  SetNumberingRangeParams,
  SetNumberingRangeResponse,
  UpdateCompanyBody,
  UpdateCompanyParams,
  UpdateCompanyResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { encryptCredentials } from "../lib/einvoicing";

function numberingRangeResponse(range: typeof einvoicingNumberingRangesTable.$inferSelect) {
  return {
    id: range.id,
    resolutionNumber: range.resolutionNumber,
    prefix: range.prefix,
    rangeFrom: range.rangeFrom,
    rangeTo: range.rangeTo,
    nextNumber: range.nextNumber,
    validFrom: range.validFrom,
    validUntil: range.validUntil,
    isActive: range.isActive,
  };
}

function companyResponse(company: typeof companiesTable.$inferSelect) {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    nit: company.nit,
    address: company.address,
    phone: company.phone,
    allowNegativeStock: company.allowNegativeStock,
    fiscalRegime: company.fiscalRegime,
    taxpayerType: company.taxpayerType,
    ciiuCode: company.ciiuCode,
    divipolaCode: company.divipolaCode,
    fiscalEmail: company.fiscalEmail,
    einvoicingEnabled: company.einvoicingEnabled,
    einvoicingProvider: company.einvoicingProvider,
    einvoicingSandbox: company.einvoicingSandbox,
  };
}

const router: IRouter = Router();
router.use("/companies", requireAuth);

router.get("/companies", async (req, res): Promise<void> => {
  const rows = await getDb()
    .select({ company: companiesTable })
    .from(companyMembersTable)
    .innerJoin(companiesTable, eq(companiesTable.id, companyMembersTable.companyId))
    .where(eq(companyMembersTable.userId, req.userId!))
    .orderBy(asc(companiesTable.id));
  res.json(ListCompaniesResponse.parse(rows.map((r) => companyResponse(r.company))));
});

router.patch("/companies/:id", requireCompany, async (req, res): Promise<void> => {
  const params = UpdateCompanyParams.safeParse(req.params);
  const parsed = UpdateCompanyBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Revisa los datos e inténtalo nuevamente." });
    return;
  }
  if (params.data.id !== req.companyId) {
    res.status(403).json({ error: "No tienes acceso a esa empresa." });
    return;
  }
  const { einvoicingCredentials, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (einvoicingCredentials) {
    updates.einvoicingCredentialsEncrypted = await encryptCredentials(einvoicingCredentials);
  }
  const [updated] = await getDb().update(companiesTable).set(updates)
    .where(eq(companiesTable.id, params.data.id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "No encontramos esa empresa." });
    return;
  }
  res.json(UpdateCompanyResponse.parse(companyResponse(updated)));
});

router.get("/companies/:id/numbering-range", requireCompany, async (req, res): Promise<void> => {
  const params = GetNumberingRangeParams.safeParse(req.params);
  if (!params.success || params.data.id !== req.companyId) {
    res.status(403).json({ error: "No tienes acceso a esa empresa." });
    return;
  }
  const [range] = await getDb().select().from(einvoicingNumberingRangesTable)
    .where(and(eq(einvoicingNumberingRangesTable.companyId, params.data.id), eq(einvoicingNumberingRangesTable.isActive, true)));
  if (!range) {
    res.status(404).json({ error: "Esta empresa no tiene un rango de numeración activo." });
    return;
  }
  res.json(numberingRangeResponse(range));
});

router.post("/companies/:id/numbering-range", requireCompany, async (req, res): Promise<void> => {
  const params = SetNumberingRangeParams.safeParse(req.params);
  const parsed = SetNumberingRangeBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Revisa los datos del rango de numeración." });
    return;
  }
  if (params.data.id !== req.companyId) {
    res.status(403).json({ error: "No tienes acceso a esa empresa." });
    return;
  }
  if (parsed.data.rangeFrom > parsed.data.rangeTo) {
    res.status(400).json({ error: "El rango inicial no puede ser mayor que el final." });
    return;
  }
  const range = await getDb().transaction(async (tx) => {
    await tx.update(einvoicingNumberingRangesTable).set({ isActive: false })
      .where(and(eq(einvoicingNumberingRangesTable.companyId, params.data.id), eq(einvoicingNumberingRangesTable.isActive, true)));
    const [inserted] = await tx.insert(einvoicingNumberingRangesTable).values({
      companyId: params.data.id,
      resolutionNumber: parsed.data.resolutionNumber,
      prefix: parsed.data.prefix,
      rangeFrom: parsed.data.rangeFrom,
      rangeTo: parsed.data.rangeTo,
      nextNumber: parsed.data.rangeFrom,
      validFrom: new Date(parsed.data.validFrom),
      validUntil: parsed.data.validUntil ? new Date(parsed.data.validUntil) : null,
      isActive: true,
    }).returning();
    return inserted;
  });
  res.status(201).json(SetNumberingRangeResponse.parse(numberingRangeResponse(range)));
});

export default router;
