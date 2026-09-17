import { createInsertSchema } from "drizzle-zod";
import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const clientsTable = pgTable("inventory_clients", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().default(1),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  code: text("code").notNull().default(""),
  phone: text("phone"),
  address: text("address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_clients_company_idx").on(t.companyId),
  uniqueIndex("inventory_clients_code_idx").on(t.code),
]).enableRLS();

export const salesTable = pgTable("inventory_sales", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().default(1),
  userId: text("user_id").notNull(),
  saleNumber: integer("sale_number").notNull(),
  total: integer("total").notNull(),
  totalItems: integer("total_items").notNull(),
  estimatedProfit: integer("estimated_profit").notNull(),
  paymentMethod: text("payment_method"),
  notes: text("notes"),
  clientName: text("client_name"),
  clientPhone: text("client_phone"),
  clientId: integer("client_id"),
  clientCode: text("client_code"),
  isDelivery: boolean("is_delivery").notNull().default(false),
  deliveryCost: integer("delivery_cost").notNull().default(0),
  deliveryPaid: boolean("delivery_paid").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_sales_company_created_idx").on(t.companyId, t.createdAt),
]).enableRLS();

export const creditPaymentsTable = pgTable("inventory_credit_payments", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().default(1),
  saleId: integer("sale_id"),
  manualCreditId: integer("manual_credit_id"),
  userId: text("user_id").notNull(),
  amount: integer("amount").notNull(),
  paymentMethod: text("payment_method"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_credit_payments_sale_id_idx").on(t.saleId),
  index("inventory_credit_payments_manual_credit_id_idx").on(t.manualCreditId),
]).enableRLS();

export const manualCreditsTable = pgTable("inventory_manual_credits", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().default(1),
  userId: text("user_id").notNull(),
  clientName: text("client_name"),
  clientPhone: text("client_phone"),
  clientId: integer("client_id"),
  clientCode: text("client_code"),
  total: integer("total").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_manual_credits_company_idx").on(t.companyId),
]).enableRLS();

export const saleItemsTable = pgTable("inventory_sale_items", {
  id: serial("id").primaryKey(),
  saleId: integer("sale_id").notNull(),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull(),
  productCode: text("product_code"),
  productContent: text("product_content"),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  unitCost: integer("unit_cost").notNull(),
  subtotal: integer("subtotal").notNull(),
}, (t) => [
  index("inventory_sale_items_sale_id_idx").on(t.saleId),
]).enableRLS();

export const insertSaleSchema = createInsertSchema(salesTable).omit({
  id: true,
  createdAt: true,
});
export const insertCreditPaymentSchema = createInsertSchema(creditPaymentsTable).omit({
  id: true,
  createdAt: true,
});
export const insertManualCreditSchema = createInsertSchema(manualCreditsTable).omit({
  id: true,
  createdAt: true,
});
export const insertClientSchema = createInsertSchema(clientsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSale = z.infer<typeof insertSaleSchema>;
export type InsertCreditPayment = z.infer<typeof insertCreditPaymentSchema>;
export type InsertManualCredit = z.infer<typeof insertManualCreditSchema>;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Sale = typeof salesTable.$inferSelect;
export type SaleItem = typeof saleItemsTable.$inferSelect;
export type CreditPayment = typeof creditPaymentsTable.$inferSelect;
export type ManualCredit = typeof manualCreditsTable.$inferSelect;
export type Client = typeof clientsTable.$inferSelect;