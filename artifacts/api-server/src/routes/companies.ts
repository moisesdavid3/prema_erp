import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { companiesTable, companyMembersTable, getDb } from "@workspace/db";
import { ListCompaniesResponse, UpdateCompanyBody, UpdateCompanyParams, UpdateCompanyResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { encryptCredentials } from "../lib/einvoicing";

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

export default router;
