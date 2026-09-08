import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const suppliersTable = pgTable(
  "inventory_suppliers",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().default(1),
    code: text("code").notNull().default(""),
    name: text("name").notNull(),
    contact: text("contact"),
    phone: text("phone"),
    city: text("city"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("inventory_suppliers_code_idx").on(t.code),
    uniqueIndex("inventory_suppliers_company_name_idx").on(t.companyId, t.name),
  ],
).enableRLS();

export type Supplier = typeof suppliersTable.$inferSelect;
