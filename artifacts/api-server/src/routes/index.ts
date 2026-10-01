import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import productsRouter from "./products";
import salesRouter from "./sales";
import purchasesRouter from "./purchases";
import reportsRouter from "./reports";
import suppliersRouter from "./suppliers";
import manualCreditsRouter from "./manual-credits";
import clientsRouter from "./clients";
import stockoutsRouter from "./stockouts";
import creditPaymentsRouter from "./credit-payments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(companiesRouter);
router.use(productsRouter);
router.use(salesRouter);
router.use(purchasesRouter);
router.use(reportsRouter);
router.use(suppliersRouter);
router.use(manualCreditsRouter);
router.use(clientsRouter);
router.use(stockoutsRouter);
router.use(creditPaymentsRouter);

export default router;
