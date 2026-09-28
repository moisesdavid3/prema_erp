import type {
  CreditNotePayload,
  EInvoiceItem,
  EInvoicePayload,
  EInvoiceResult,
  EInvoicingProvider,
  ProviderCredentials,
} from "./provider";

// Implementado contra la documentación pública de Factus
// (https://developers.factus.com.co/). No se ha probado todavía contra
// una cuenta real de sandbox — verificar y ajustar en cuanto se tengan
// credenciales, en particular: el código exacto de
// `correction_concept_code` para anulación total, y si existe un
// endpoint separado de descarga de PDF/XML (aquí solo se usa el link
// público que devuelve la validación).
const BASE_URLS = {
  sandbox: "https://api-sandbox.factus.com.co",
  production: "https://api.factus.com.co",
};

async function authenticate(credentials: ProviderCredentials, sandbox: boolean): Promise<string> {
  const base = sandbox ? BASE_URLS.sandbox : BASE_URLS.production;
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    username: credentials.username,
    password: credentials.password,
  });
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`No se pudo autenticar con Factus (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function mapItems(items: EInvoiceItem[]) {
  return items.map((item) => ({
    code_reference: item.code || "SIN-CODIGO",
    name: item.name,
    quantity: item.quantity.toFixed(2),
    price: item.unitPrice.toFixed(2),
    discount_rate: "0.00",
    unit_measure_code: "94",
    standard_code: "1",
    taxes: item.taxRate > 0 ? [{ code: "01", rate: item.taxRate.toFixed(2) }] : [],
  }));
}

function parseResult(json: any): EInvoiceResult {
  const data = json?.data;
  const validationErrors = data?.errors && Object.keys(data.errors).length > 0 ? data.errors : null;
  if (validationErrors || !data?.cufe) {
    return {
      status: "rejected",
      errorMessage: validationErrors ? JSON.stringify(validationErrors) : (json?.message ?? "La DIAN rechazó el documento."),
      raw: json,
    };
  }
  return {
    status: "accepted",
    cufe: data.cufe,
    providerDocumentId: data.number,
    publicQueryUrl: data.links?.public_url ?? undefined,
    raw: json,
  };
}

async function submitInvoice(payload: EInvoicePayload, credentials: ProviderCredentials, sandbox: boolean): Promise<EInvoiceResult> {
  try {
    const token = await authenticate(credentials, sandbox);
    const base = sandbox ? BASE_URLS.sandbox : BASE_URLS.production;
    const res = await fetch(`${base}/v2/bills/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: JSON.stringify({
        reference_code: payload.referenceCode,
        document: "01",
        numbering_range_id: credentials.numberingRangeId ? Number(credentials.numberingRangeId) : undefined,
        operation_type: "10",
        send_email: true,
        customer: {
          identification_document_code: payload.customer.identificationDocumentCode,
          identification: payload.customer.identification,
          names: payload.customer.name,
          email: payload.customer.email,
          phone: payload.customer.phone,
          address: payload.customer.address,
          legal_organization_code: "2",
          tribute_code: "ZZ",
          country_code: "CO",
        },
        items: mapItems(payload.items),
        payment_details: [{ payment_form: "1", payment_method_code: "42", amount: payload.total.toFixed(2) }],
      }),
    });
    const json: any = await res.json();
    if (!res.ok) {
      return { status: "error", errorMessage: json?.message ?? `Factus respondió HTTP ${res.status}.`, raw: json };
    }
    return parseResult(json);
  } catch (err) {
    return { status: "error", errorMessage: err instanceof Error ? err.message : "Error de red al contactar a Factus.", raw: null };
  }
}

async function submitCreditNote(payload: CreditNotePayload, credentials: ProviderCredentials, sandbox: boolean): Promise<EInvoiceResult> {
  try {
    const token = await authenticate(credentials, sandbox);
    const base = sandbox ? BASE_URLS.sandbox : BASE_URLS.production;
    const res = await fetch(`${base}/v2/credit-notes/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "application/json" },
      body: JSON.stringify({
        reference_code: payload.referenceCode,
        bill_number: payload.originalDocumentNumber,
        correction_concept_code: "2",
        customization_id: 20,
        items: mapItems(payload.items),
        payment_details: [{ payment_form: "1", payment_method_code: "42", amount: payload.total.toFixed(2) }],
      }),
    });
    const json: any = await res.json();
    if (!res.ok) {
      return { status: "error", errorMessage: json?.message ?? `Factus respondió HTTP ${res.status}.`, raw: json };
    }
    return parseResult(json);
  } catch (err) {
    return { status: "error", errorMessage: err instanceof Error ? err.message : "Error de red al contactar a Factus.", raw: null };
  }
}

export const factusProvider: EInvoicingProvider = { submitInvoice, submitCreditNote };
