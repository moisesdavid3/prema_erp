import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { requireCompany } from "../middlewares/requireCompany";
import { createFifoCreditPayment } from "../lib/inventory-service";
import {
  CreateClientCreditPaymentBody,
  CreateClientCreditPaymentResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth, requireCompany);

router.post("/credit-payments", async (req, res): Promise<void> => {
  const parsed = CreateClientCreditPaymentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Revisa el monto del abono." });
    return;
  }
  const clientName = parsed.data.clientName?.trim();
  if (!clientName) {
    res.status(400).json({ error: "No sabemos a qué cliente pertenece el abono." });
    return;
  }
  try {
    const result = await createFifoCreditPayment({
      companyId: req.companyId!,
      userId: req.userId!,
      clientId: parsed.data.clientId ?? null,
      clientName,
      amount: Math.round(parsed.data.amount),
      paymentMethod: parsed.data.paymentMethod?.trim() || null,
      note: parsed.data.note?.trim() || null,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
    });
    res.status(201).json(CreateClientCreditPaymentResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "No se pudo registrar el abono." });
  }
});

export default router;