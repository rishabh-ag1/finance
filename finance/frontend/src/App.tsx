import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { AuditPage } from './pages/AuditPage';
import { AccountPage } from './pages/AccountPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ImportPage } from './pages/bank/ImportPage';
import { BatchPage } from './pages/bank/BatchPage';
import { LedgerPage } from './pages/bank/LedgerPage';
import { ReviewPage } from './pages/bank/ReviewPage';
import { RulesPage } from './pages/bank/RulesPage';
import { VendorsPage } from './pages/vendors/VendorsPage';
import { VendorPage } from './pages/vendors/VendorPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { PurchaseOrdersPage } from './pages/purchases/PurchaseOrdersPage';
import { PoFormPage } from './pages/purchases/PoFormPage';
import { PoPage } from './pages/purchases/PoPage';
import { BillsPage } from './pages/bills/BillsPage';
import { BillFormPage } from './pages/bills/BillFormPage';
import { BillPage } from './pages/bills/BillPage';
import { PayablesPage } from './pages/payments/PayablesPage';
import { PaymentFormPage } from './pages/payments/PaymentFormPage';
import { PaymentPage } from './pages/payments/PaymentPage';
import { TdsPage } from './pages/tds/TdsPage';
import { ClaimsPage } from './pages/claims/ClaimsPage';
import { ClaimFormPage } from './pages/claims/ClaimFormPage';
import { ClaimPage } from './pages/claims/ClaimPage';
import { ReimbursementPage } from './pages/claims/ReimbursementPage';
import { ForecastPage } from './pages/ForecastPage';
import { OrderToBankPage } from './pages/orders/OrderToBankPage';
import { OrderPage } from './pages/orders/OrderPage';
import { SettlementPage } from './pages/orders/SettlementPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route index element={<HomePage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route element={<ProtectedRoute requiredModule="financePurchases" requiredAction="view" />}>
                  <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
                  <Route path="/purchase-orders/new" element={<PoFormPage mode="new" />} />
                  <Route path="/purchase-orders/:id" element={<PoPage />} />
                  <Route path="/purchase-orders/:id/edit" element={<PoFormPage mode="edit" />} />
                  <Route path="/purchase-orders/:id/amend" element={<PoFormPage mode="amend" />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeBills" requiredAction="view" />}>
                  <Route path="/bills" element={<BillsPage />} />
                  <Route path="/bills/new" element={<BillFormPage mode="new" />} />
                  <Route path="/bills/:id" element={<BillPage />} />
                  <Route path="/bills/:id/edit" element={<BillFormPage mode="edit" />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financePayments" requiredAction="view" />}>
                  <Route path="/payables" element={<PayablesPage />} />
                  <Route path="/payments/new" element={<PaymentFormPage mode="new" />} />
                  <Route path="/payments/:id" element={<PaymentPage />} />
                  <Route path="/payments/:id/edit" element={<PaymentFormPage mode="edit" />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeTds" requiredAction="view" />}>
                  <Route path="/tds" element={<TdsPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeOrders" requiredAction="view" />}>
                  <Route path="/order-to-bank" element={<OrderToBankPage />} />
                  <Route path="/order-to-bank/orders/:id" element={<OrderPage />} />
                  <Route path="/order-to-bank/settlements/:id" element={<SettlementPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeClaims" requiredAction="view" />}>
                  <Route path="/claims" element={<ClaimsPage />} />
                  <Route path="/claims/new" element={<ClaimFormPage mode="new" />} />
                  <Route path="/claims/reimbursements/:id" element={<ReimbursementPage />} />
                  <Route path="/claims/:id" element={<ClaimPage />} />
                  <Route path="/claims/:id/edit" element={<ClaimFormPage mode="edit" />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeHome" requiredAction="view" />}>
                  <Route path="/analytics" element={<AnalyticsPage />} />
                  <Route path="/forecast" element={<ForecastPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeAudit" requiredAction="view" />}>
                  <Route path="/audit" element={<AuditPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeBank" requiredAction="view" />}>
                  <Route path="/import" element={<ImportPage />} />
                  <Route path="/imports/:id" element={<BatchPage />} />
                  <Route path="/ledger" element={<LedgerPage />} />
                  <Route path="/review" element={<ReviewPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeVendors" requiredAction="view" />}>
                  <Route path="/vendors" element={<VendorsPage />} />
                  <Route path="/vendors/:id" element={<VendorPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeDocuments" requiredAction="view" />}>
                  <Route path="/documents" element={<DocumentsPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeRules" requiredAction="view" />}>
                  <Route path="/rules" element={<RulesPage />} />
                </Route>
                <Route element={<ProtectedRoute requiredModule="financeSettings" requiredAction="view" />}>
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/categories" element={<CategoriesPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
