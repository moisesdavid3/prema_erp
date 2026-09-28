import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  companiesTable,
  einvoicingDocumentsTable,
  einvoicingNumberingRangesTable,
  getDb,
  inventoryMovementsTable,
  productsTable,
  saleItemsTable,
  salesTable,
} from "@workspace/db";
import {
  CreateNotaCreditoBody,
  CreateNotaCreditoParams,
  CreateNotaCreditoResponse,
  EmitEinvoiceParams,
  EmitEinvoiceResponse,
  GetEinvoiceParams,
  GetEinvoiceResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { decryptCredentials, getProvider, saleToCreditNotePayload, saleToEInvoicePayload, type ProviderCredentials } from "../lib/einvoicing";

const router: IRouter = Router();
router.use("/sales", requireAuth, requireCompany);

function einvoicingDocumentResponse(doc: typeof einvoicingDocumentsTable.$inferSelect) {
  return {
    id: doc.id,
    saleId: doc.saleId,
    invoiceNumber: doc.invoiceNumber,
    fullInvoiceNumber: doc.fullInvoiceNumber,
    documentType: doc.documentType,
    status: doc.status,
    cufe: doc.cufe,
    pdfUrl: doc.pdfUrl,
    xmlUrl: doc.xmlUrl,
    publicQueryUrl: doc.publicQueryUrl,
    errorMessage: doc.errorMessage,
    relatedDocumentId: doc.relatedDocumentId,
    submittedAt: doc.submittedAt,
    acceptedAt: doc.acceptedAt,
  };
}

async function claimNumber(companyId: number, documentType: string) {
  return getDb().transaction(async (tx) => {
    const [range] = await tx.select().from(einvoicingNumberingRangesTable)
      .where(and(eq(einvoicingNumberingRangesTable.companyId, companyId), eq(einvoicingNumberingRangesTable.isActive, true)))
      .for("update");
    if (!range) return { error: "No hay un rango de numeración DIAN activo para esta empresa." as const };
    if (range.nextNumber > range.rangeTo) {
      return { error: "Se agotó el rango de numeración autorizado. Solicita una nueva resolución a la DIAN." as const };
    }
    const assigned = range.nextNumber;
    await tx.update(einvoicingNumberingRangesTable).set({ nextNumber: assigned + 1 }).where(eq(einvoicingNumberingRangesTable.id, range.id));
    return { rangeId: range.id, invoiceNumber: assigned, fullInvoiceNumber: `${range.prefix}${assigned}` };
  });
}

router.post("/sales/:id/einvoice", async (req, res): Promise<void> => {
  const params = EmitEinvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "ID de venta inválido." });
    return;
  }
  const [company] = await getDb().select().from(companiesTable).where(eq(companiesTable.id, req.companyId!));
  if (!company?.einvoicingEnabled) {
    res.status(400).json({ error: "La facturación electrónica no está activada para esta empresa." });
    return;
  }
  const [sale] = await getDb().select().from(salesTable)
    .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)));
  if (!sale) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }

  const [existing] = await getDb().select().from(einvoicingDocumentsTable).where(eq(einvoicingDocumentsTable.saleId, sale.id));
  let document = existing;
  if (!document) {
    const claim = await claimNumber(req.companyId!, "factura_venta");
    if ("error" in claim) {
      res.status(400).json({ error: claim.error });
      return;
    }
    const [inserted] = await getDb().insert(einvoicingDocumentsTable).values({
      companyId: req.companyId!,
      saleId: sale.id,
      numberingRangeId: claim.rangeId,
      invoiceNumber: claim.invoiceNumber,
      fullInvoiceNumber: claim.fullInvoiceNumber,
      documentType: "factura_venta",
      status: "pending",
    }).returning();
    document = inserted;
  }

  if (document.status === "accepted") {
    res.json(EmitEinvoiceResponse.parse(einvoicingDocumentResponse(document)));
    return;
  }
  if (!company.einvoicingCredentialsEncrypted) {
    res.status(400).json({ error: "Configura las credenciales del proveedor de facturación en los ajustes de la empresa." });
    return;
  }

  const items = await getDb().select().from(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
  const credentials = (await decryptCredentials(company.einvoicingCredentialsEncrypted)) as unknown as ProviderCredentials;
  const provider = getProvider(company.einvoicingProvider);
  const payload = saleToEInvoicePayload(sale, items, document.fullInvoiceNumber);
  const result = await provider.submitInvoice(payload, credentials, company.einvoicingSandbox);

  const [updated] = await getDb().update(einvoicingDocumentsTable).set({
    status: result.status,
    cufe: result.cufe ?? null,
    providerDocumentId: result.providerDocumentId ?? null,
    pdfUrl: result.pdfUrl ?? null,
    xmlUrl: result.xmlUrl ?? null,
    publicQueryUrl: result.publicQueryUrl ?? null,
    providerResponse: JSON.stringify(result.raw ?? null),
    errorMessage: result.errorMessage ?? null,
    submittedAt: new Date(),
    acceptedAt: result.status === "accepted" ? new Date() : null,
  }).where(eq(einvoicingDocumentsTable.id, document.id)).returning();

  res.json(EmitEinvoiceResponse.parse(einvoicingDocumentResponse(updated)));
});

router.get("/sales/:id/einvoice", async (req, res): Promise<void> => {
  const params = GetEinvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "ID de venta inválido." });
    return;
  }
  const [document] = await getDb().select().from(einvoicingDocumentsTable)
    .where(and(eq(einvoicingDocumentsTable.saleId, params.data.id), eq(einvoicingDocumentsTable.companyId, req.companyId!), eq(einvoicingDocumentsTable.documentType, "factura_venta")));
  if (!document) {
    res.status(404).json({ error: "Esta venta no tiene factura electrónica." });
    return;
  }
  res.json(GetEinvoiceResponse.parse(einvoicingDocumentResponse(document)));
});

router.post("/sales/:id/nota-credito", async (req, res): Promise<void> => {
  const params = CreateNotaCreditoParams.safeParse(req.params);
  const parsed = CreateNotaCreditoBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Indica el motivo de la nota crédito." });
    return;
  }
  const [company] = await getDb().select().from(companiesTable).where(eq(companiesTable.id, req.companyId!));
  const [sale] = await getDb().select().from(salesTable)
    .where(and(eq(salesTable.id, params.data.id), eq(salesTable.companyId, req.companyId!)));
  if (!sale) {
    res.status(404).json({ error: "No encontramos esa venta." });
    return;
  }
  const [original] = await getDb().select().from(einvoicingDocumentsTable)
    .where(and(eq(einvoicingDocumentsTable.saleId, sale.id), eq(einvoicingDocumentsTable.documentType, "factura_venta")));
  if (!original || original.status !== "accepted") {
    res.status(400).json({ error: "Esta venta no tiene una factura electrónica aceptada por la DIAN para anular." });
    return;
  }
  const [existingNote] = await getDb().select().from(einvoicingDocumentsTable)
    .where(and(eq(einvoicingDocumentsTable.relatedDocumentId, original.id), eq(einvoicingDocumentsTable.documentType, "nota_credito")));
  if (existingNote) {
    res.status(200).json(CreateNotaCreditoResponse.parse(einvoicingDocumentResponse(existingNote)));
    return;
  }
  if (!company?.einvoicingCredentialsEncrypted) {
    res.status(400).json({ error: "Configura las credenciales del proveedor de facturación en los ajustes de la empresa." });
    return;
  }

  const claim = await claimNumber(req.companyId!, "nota_credito");
  if ("error" in claim) {
    res.status(400).json({ error: claim.error });
    return;
  }
  const [document] = await getDb().insert(einvoicingDocumentsTable).values({
    companyId: req.companyId!,
    saleId: sale.id,
    numberingRangeId: claim.rangeId,
    invoiceNumber: claim.invoiceNumber,
    fullInvoiceNumber: claim.fullInvoiceNumber,
    documentType: "nota_credito",
    relatedDocumentId: original.id,
    status: "pending",
  }).returning();

  const items = await getDb().select().from(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
  const credentials = (await decryptCredentials(company.einvoicingCredentialsEncrypted)) as unknown as ProviderCredentials;
  const provider = getProvider(company.einvoicingProvider);
  const payload = saleToCreditNotePayload(sale, items, document.fullInvoiceNumber, original.fullInvoiceNumber, parsed.data.reason);
  const result = await provider.submitCreditNote(payload, credentials, company.einvoicingSandbox);

  const [updated] = await getDb().update(einvoicingDocumentsTable).set({
    status: result.status,
    cufe: result.cufe ?? null,
    providerDocumentId: result.providerDocumentId ?? null,
    pdfUrl: result.pdfUrl ?? null,
    xmlUrl: result.xmlUrl ?? null,
    publicQueryUrl: result.publicQueryUrl ?? null,
    providerResponse: JSON.stringify(result.raw ?? null),
    errorMessage: result.errorMessage ?? null,
    submittedAt: new Date(),
    acceptedAt: result.status === "accepted" ? new Date() : null,
  }).where(eq(einvoicingDocumentsTable.id, document.id)).returning();

  if (result.status === "accepted") {
    await getDb().transaction(async (tx) => {
      const saleItems = await tx.select().from(saleItemsTable).where(eq(saleItemsTable.saleId, sale.id));
      for (const item of saleItems) {
        const [product] = await tx.select().from(productsTable).where(eq(productsTable.id, item.productId));
        if (!product) continue;
        const stockAfter = product.stock + item.quantity;
        await tx.update(productsTable).set({ stock: stockAfter, updatedAt: new Date() }).where(eq(productsTable.id, product.id));
        await tx.insert(inventoryMovementsTable).values({
          companyId: req.companyId!,
          userId: req.userId!,
          productId: product.id,
          type: "nota_credito",
          quantity: item.quantity,
          stockBefore: product.stock,
          stockAfter,
          note: `Nota crédito venta #${sale.saleNumber}`,
        });
      }
    });
  }

  res.status(201).json(CreateNotaCreditoResponse.parse(einvoicingDocumentResponse(updated)));
});

export default router;
