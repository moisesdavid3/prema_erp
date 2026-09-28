import type { EInvoicingProvider } from "./provider";
import { factusProvider } from "./factus";

const providers: Record<string, EInvoicingProvider> = {
  factus: factusProvider,
};

export function getProvider(name: string | null | undefined): EInvoicingProvider {
  const provider = providers[name ?? "factus"];
  if (!provider) {
    throw new Error(`Proveedor de facturación electrónica desconocido: ${name}`);
  }
  return provider;
}

export * from "./provider";
export * from "./credentials";
export * from "./mapper";
