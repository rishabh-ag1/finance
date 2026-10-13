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
