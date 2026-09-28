export interface EInvoiceItem {
  code: string;
  name: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

export interface EInvoiceCustomer {
  identificationDocumentCode: string;
  identification: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export interface EInvoicePayload {
  referenceCode: string;
  customer: EInvoiceCustomer;
  items: EInvoiceItem[];
  paymentMethod: string;
  total: number;
}

export interface CreditNotePayload {
  referenceCode: string;
  originalDocumentNumber: string;
  correctionReason: string;
  items: EInvoiceItem[];
  total: number;
}

export interface EInvoiceResult {
  status: "accepted" | "rejected" | "error";
  cufe?: string;
  providerDocumentId?: string;
  pdfUrl?: string;
  xmlUrl?: string;
  publicQueryUrl?: string;
  errorMessage?: string;
  raw: unknown;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  numberingRangeId?: string;
}

export interface EInvoicingProvider {
  submitInvoice(payload: EInvoicePayload, credentials: ProviderCredentials, sandbox: boolean): Promise<EInvoiceResult>;
  submitCreditNote(payload: CreditNotePayload, credentials: ProviderCredentials, sandbox: boolean): Promise<EInvoiceResult>;
}
