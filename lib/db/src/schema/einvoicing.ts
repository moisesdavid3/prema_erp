import { createInsertSchema } from "drizzle-zod";
import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const einvoicingNumberingRangesTable = pgTable(
  "einvoicing_numbering_ranges",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    resolutionNumber: text("resolution_number").notNull(),
    prefix: text("prefix").notNull(),
    rangeFrom: integer("range_from").notNull(),
    rangeTo: integer("range_to").notNull(),
    nextNumber: integer("next_number").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("einvoicing_numbering_company_idx").on(t.companyId, t.isActive),
  ],
).enableRLS();

export const einvoicingDocumentsTable = pgTable(
  "einvoicing_documents",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull(),
    saleId: integer("sale_id").notNull(),
    numberingRangeId: integer("numbering_range_id").notNull(),
    invoiceNumber: integer("invoice_number").notNull(),
    fullInvoiceNumber: text("full_invoice_number").notNull(),
    documentType: text("document_type").notNull().default("factura_venta"),
    status: text("status").notNull().default("pending"),
    cufe: text("cufe"),
    providerDocumentId: text("provider_document_id"),
    pdfUrl: text("pdf_url"),
    xmlUrl: text("xml_url"),
    publicQueryUrl: text("public_query_url"),
    providerResponse: text("provider_response"),
    errorMessage: text("error_message"),
    relatedDocumentId: integer("related_document_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("einvoicing_documents_sale_idx").on(t.saleId),
    index("einvoicing_documents_company_status_idx").on(t.companyId, t.status),
  ],
).enableRLS();

export const insertEinvoicingNumberingRangeSchema = createInsertSchema(einvoicingNumberingRangesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEinvoicingDocumentSchema = createInsertSchema(einvoicingDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEinvoicingNumberingRange = z.infer<typeof insertEinvoicingNumberingRangeSchema>;
export type InsertEinvoicingDocument = z.infer<typeof insertEinvoicingDocumentSchema>;
export type EinvoicingNumberingRange = typeof einvoicingNumberingRangesTable.$inferSelect;
export type EinvoicingDocument = typeof einvoicingDocumentsTable.$inferSelect;
