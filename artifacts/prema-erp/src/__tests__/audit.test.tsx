import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom de este entorno no trae localStorage; el menú lateral guarda ahí si está colapsado.
const memoryStorage = (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() }; })();
Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true });

vi.mock('wouter', () => ({
  Link: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a>,
  Redirect: () => null,
  Route: () => null,
  Switch: ({ children }: any) => <div>{children}</div>,
  Router: ({ children }: any) => <div>{children}</div>,
  useLocation: () => ['/app/auditoria/ventas-mensuales', vi.fn()],
  useRoute: () => [false, {}],
}));
vi.mock('@/lib/auth', () => ({
  AuthProvider: ({ children }: any) => <div>{children}</div>,
  useAuth: () => ({ user: { email: 'test@test.com' }, isSignedIn: true, isLoaded: true, signOut: vi.fn() }),
}));
vi.mock('@/lib/company', () => ({
  CompanyProvider: ({ children }: any) => <div>{children}</div>,
  useCompany: () => ({ companies: [{ id: 2, name: 'Prema' }], activeCompany: { id: 2, name: 'Prema' }, selectCompany: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signOut: vi.fn() } } }));

// Recharts necesita medidas reales de pantalla; en jsdom se sustituye por un contenedor simple.
vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: any) => <div data-testid="chart">{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));
vi.mock('recharts', () => ({
  Bar: () => null, BarChart: ({ children }: any) => <div>{children}</div>, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null,
}));

const salesState: { data?: any; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const productsState: { data?: any; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const turnoverState: { data?: any; isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const turnoverHook = vi.fn();
const salesHook = vi.fn();
const productsHook = vi.fn();

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useGetAuditSalesByMonth: (...args: any[]) => { salesHook(...args); return { ...salesState, refetch: vi.fn() }; },
    useGetAuditTopProducts: (...args: any[]) => { productsHook(...args); return { ...productsState, refetch: vi.fn() }; },
    useGetAuditProductTurnover: (...args: any[]) => { turnoverHook(...args); return { ...turnoverState, refetch: vi.fn() }; },
  };
});

import { AuditSalesByMonthPage, AuditTopProductsPage, AuditTurnoverPage } from '@/App';

const month = (m: string, over: Partial<Record<string, number>> = {}) => ({ month: m, saleCount: 10, itemCount: 40, totalSold: 1000000, estimatedProfit: 400000, averageTicket: 100000, revenueWithoutCost: 0, ...over });
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => {
  salesHook.mockClear(); productsHook.mockClear();
  salesState.isLoading = false; salesState.isError = false;
  productsState.isLoading = false; productsState.isError = false;
  turnoverHook.mockClear(); turnoverState.isLoading = false; turnoverState.isError = false;
});

describe('Auditoría · ventas por mes', () => {
  beforeEach(() => {
    salesState.data = {
      months: [month('2026-08', { totalSold: 1000000, revenueWithoutCost: 600000 }), month('2026-09', { totalSold: 2000000, saleCount: 20, revenueWithoutCost: 100000 }), month('2026-10', { totalSold: 1500000, revenueWithoutCost: 0 })],
      totalSold: 4500000, estimatedProfit: 1200000, saleCount: 40, itemCount: 120, revenueWithoutCost: 700000,
    };
  });

  it('muestra las ventas de cada mes, del más reciente al más antiguo', () => {
    wrap(<AuditSalesByMonthPage />);
    const table = screen.getByTestId('table-audit-sales-by-month');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/oct/i);
    expect(rows[2]).toHaveTextContent(/ago/i);
  });

  it('calcula la variación contra el mes anterior', () => {
    wrap(<AuditSalesByMonthPage />);
    expect(screen.getByTestId('row-audit-month-2026-09')).toHaveTextContent('100%');   // 1.000.000 → 2.000.000
    expect(screen.getByTestId('row-audit-month-2026-10')).toHaveTextContent('25%');    // 2.000.000 → 1.500.000
    expect(screen.getByTestId('row-audit-month-2026-08')).toHaveTextContent('—');      // el primer mes no tiene anterior
  });

  it('avisa que hay ventas con costo 0 y marca el margen de los meses afectados', () => {
    wrap(<AuditSalesByMonthPage />);
    expect(screen.getByTestId('notice-audit-no-cost')).toHaveTextContent('15,6%');
    expect(within(screen.getByTestId('row-audit-month-2026-08')).getByLabelText(/sobreestimado/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('row-audit-month-2026-10')).queryByLabelText(/sobreestimado/i)).toBeNull();
  });

  it('pide los últimos 12 meses por defecto', () => {
    wrap(<AuditSalesByMonthPage />);
    const params = salesHook.mock.calls[0][0];
    expect(params.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('muestra un mensaje cuando no hay ventas y cuando falla la carga', () => {
    salesState.data = { months: [], totalSold: 0, estimatedProfit: 0, saleCount: 0, itemCount: 0, revenueWithoutCost: 0 };
    const { unmount } = wrap(<AuditSalesByMonthPage />);
    expect(screen.getByText(/No hay ventas en ese rango/i)).toBeInTheDocument();
    unmount();
    salesState.data = undefined; salesState.isError = true;
    wrap(<AuditSalesByMonthPage />);
    expect(screen.getByText(/No pudimos cargar el reporte de ventas por mes/i)).toBeInTheDocument();
  });
});

describe('Auditoría · productos más rentables', () => {
  beforeEach(() => {
    productsState.data = {
      products: [
        { productId: 1, code: 'P-001', name: 'Torta Integral', content: '100gr', unitsSold: 100, revenue: 500000, cost: 200000, profit: 300000, marginPercent: 60, revenueWithoutCost: 0 },
        { productId: 2, code: 'P-002', name: 'Helado Vegano', content: null, unitsSold: 50, revenue: 300000, cost: 150000, profit: 150000, marginPercent: 50, revenueWithoutCost: 0 },
      ],
      productCount: 2, totalRevenue: 800000, totalProfit: 450000, revenueWithoutCost: 100000,
    };
  });

  it('lista los productos con su utilidad, margen y participación', () => {
    wrap(<AuditTopProductsPage />);
    const rows = within(screen.getByTestId('table-audit-top-products')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Torta Integral x 100gr');
    expect(rows[0]).toHaveTextContent('60%');
    expect(rows[0]).toHaveTextContent('66,7%');   // 300.000 de 450.000
    expect(rows[1]).toHaveTextContent('Helado Vegano');
  });

  it('por defecto calcula solo con ventas con costo y avisa de lo que dejó fuera', () => {
    wrap(<AuditTopProductsPage />);
    const params = productsHook.mock.calls[0][0];
    expect(params.excludeNoCost).toBe(true);
    expect(params.limit).toBe(200);
    expect(screen.getByTestId('notice-audit-no-cost')).toHaveTextContent(/se dejaron fuera/i);
  });

  it('muestra un mensaje cuando no hay productos con costo registrado', () => {
    productsState.data = { products: [], productCount: 0, totalRevenue: 0, totalProfit: 0, revenueWithoutCost: 0 };
    wrap(<AuditTopProductsPage />);
    expect(screen.getByText(/No hay ventas con costo registrado/i)).toBeInTheDocument();
  });
});

describe('Auditoría · rotación de productos', () => {
  const item = (over: Record<string, unknown>) => ({ productId: 1, code: 'P-001', name: 'Pan de Coco', content: null, unitsSold: 56, stock: 3, averageStock: 3.1, rotation: 18.01, unitsPerDay: 0.62, daysOfInventory: 5, inventoryCost: 10500, lastSaleDate: '2026-11-07', ...over });
  beforeEach(() => {
    turnoverState.data = {
      from: '2026-08-11', to: '2026-11-09', days: 91,
      highest: [item({}), item({ productId: 2, code: 'P-002', name: 'Torta Integral', content: '100gr', unitsSold: 30, rotation: 6, stock: -1, daysOfInventory: null })],
      lowest: [item({ productId: 3, code: 'P-003', name: 'Alogen', content: '1LT', unitsSold: 0, stock: 6, rotation: 0, daysOfInventory: null, inventoryCost: 272160, lastSaleDate: null })],
      productsWithSales: 237, productsWithoutSales: 50, withoutSalesInventoryCost: 2970101,
    };
  });

  it('muestra las dos listas: mayor y menor rotación', () => {
    wrap(<AuditTurnoverPage />);
    const high = within(screen.getByTestId('table-audit-turnover-highest')).getAllByRole('row').slice(1);
    const low = within(screen.getByTestId('table-audit-turnover-lowest')).getAllByRole('row').slice(1);
    expect(high).toHaveLength(2);
    expect(high[0]).toHaveTextContent('Pan de Coco');
    expect(high[0]).toHaveTextContent('18x');
    expect(high[1]).toHaveTextContent('Torta Integral x 100gr');
    expect(low).toHaveLength(1);
    expect(low[0]).toHaveTextContent('Alogen x 1LT');
    expect(low[0]).toHaveTextContent('Sin ventas');
  });

  it('resume cuántos productos con existencia no se vendieron y su valor al costo', () => {
    wrap(<AuditTurnoverPage />);
    expect(screen.getByTestId('text-audit-turnover-nosales')).toHaveTextContent('50 productos con existencia no tuvieron ventas');
    expect(screen.getByText(/2\.970\.101/)).toBeInTheDocument();
  });

  it('pide los últimos 90 días y 15 productos por lista', () => {
    wrap(<AuditTurnoverPage />);
    const params = turnoverHook.mock.calls[0][0];
    expect(params.limit).toBe(15);
    expect(params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('muestra un mensaje cuando falla la carga', () => {
    turnoverState.data = undefined; turnoverState.isError = true;
    wrap(<AuditTurnoverPage />);
    expect(screen.getByText(/No pudimos cargar el reporte de rotación/i)).toBeInTheDocument();
  });
});
