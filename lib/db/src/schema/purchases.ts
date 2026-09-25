import { createInsertSchema } from "drizzle-zod";
import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const purchasesTable = pgTable("inventory_purchases", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().default(1),
  userId: text("user_id").notNull(),
  supplier: text("supplier"),
  supplierId: integer("supplier_id"),
  invoiceNumber: text("invoice_number"),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }).notNull().defaultNow(),
  total: integer("total").notNull(),
  totalItems: integer("total_items").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const purchaseItemsTable = pgTable("inventory_purchase_items", {
  id: serial("id").primaryKey(),
  purchaseId: integer("purchase_id").notNull(),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull(),
  productCode: text("product_code"),
  productContent: text("product_content"),
  quantity: integer("quantity").notNull(),
  unitCost: integer("unit_cost").notNull(),
  subtotal: integer("subtotal").notNull(),
}).enableRLS();

export const insertPurchaseSchema = createInsertSchema(purchasesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPurchase = z.infer<typeof insertPurchaseSchema>;
export type Purchase = typeof purchasesTable.$inferSelect;
export type PurchaseItem = typeof purchaseItemsTable.$inferSelect;
