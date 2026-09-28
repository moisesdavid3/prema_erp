import type { Sale, SaleItem } from "@workspace/db";
import type { CreditNotePayload, EInvoiceItem, EInvoicePayload } from "./provider";

// DIAN permite identificar al comprador anónimo con este NIT genérico
// (Resolución 000227 de 2025) cuando no se captura su documento real.
// Hoy la app no guarda un número de identificación real del cliente
// (solo nombre/teléfono), así que usamos siempre "consumidor final" —
// inventar un número de cédula falso sería peor que no reportarlo.
// TODO: si en el futuro se necesita factura deducible a nombre de un
// cliente específico, hay que agregar un campo de tipo/número de
// documento al cliente y usarlo aquí en vez del genérico.
const GENERIC_CONSUMER = {
  identificationDocumentCode: "43",
  identification: "222222222222",
  name: "Consumidor final",
};

function mapItems(items: SaleItem[]): EInvoiceItem[] {
  return items.map((item) => ({
    code: item.productCode || String(item.productId),
    name: item.productName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxRate: item.taxRate,
  }));
}

export function saleToEInvoicePayload(sale: Sale, items: SaleItem[], referenceCode: string): EInvoicePayload {
  return {
    referenceCode,
    customer: GENERIC_CONSUMER,
    items: mapItems(items),
    paymentMethod: sale.paymentMethod ?? "Efectivo",
    total: sale.total,
  };
}

export function saleToCreditNotePayload(
  sale: Sale,
  items: SaleItem[],
  referenceCode: string,
  originalDocumentNumber: string,
  reason: string,
): CreditNotePayload {
  return {
    referenceCode,
    originalDocumentNumber,
    correctionReason: reason,
    items: mapItems(items),
    total: sale.total,
  };
}
